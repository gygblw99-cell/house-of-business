/**
 * services/supabase/supabaseData.service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Data Access Layer — ALL Supabase queries go through here.
 *
 * SECURITY PRINCIPLES:
 *  - Every public method receives (userId, businessId) and enforces ownership
 *    in the WHERE clause before returning any data.
 *  - We use supabaseAdmin (service role) but manually enforce RLS-equivalent
 *    constraints in every query — this gives us predictable, auditable access.
 *  - No raw SQL strings from user input — all values are parameterized.
 *  - Sensitive columns (e.g. password_hash, raw banking details) are explicitly
 *    excluded from SELECT lists and never returned to callers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { supabaseAdmin } = require('../../utils/supabase');
const db = require('../../utils/db'); // Keep existing pg pool for complex queries

// ── Internal helper ──────────────────────────────────────────────────────────
// Throws a standardized, non-leaking error if the Supabase response has an error.
function assertNoError(error, context) {
  if (error) {
    // SECURITY: Log internally with full details, but the calling layer will
    // return a generic message to the user. Never propagate Supabase error
    // messages (they may contain schema details) to the client.
    const wrapped = new Error(`[supabaseData] ${context}: ${error.message}`);
    wrapped.isSupabaseError = true;
    wrapped.code = error.code;
    throw wrapped;
  }
}

// ── Ownership check ──────────────────────────────────────────────────────────
// Verifies that a userId is a member of a business before we fetch any data.
// Called at the start of every data-fetching method.
async function verifyUserOwnership(userId, businessId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, role, is_active')
    .eq('id', userId)
    .eq('business_id', businessId)
    .eq('is_active', true)
    .maybeSingle();

  assertNoError(error, 'verifyUserOwnership');

  if (!data) {
    const err = new Error('Access denied: user does not belong to this business');
    err.statusCode = 403;
    throw err;
  }

  return data; // { id, role, is_active }
}

// ── Business summary ─────────────────────────────────────────────────────────
// Returns non-sensitive business metadata (no payment info, no secrets).
async function getBusinessSummary(businessId) {
  const { data, error } = await supabaseAdmin
    .from('businesses')
    .select(`
      id,
      name,
      business_type,
      created_at
    `)
    // SECURITY: Explicitly exclude email, phone, address, bank details
    .eq('id', businessId)
    .maybeSingle();

  assertNoError(error, 'getBusinessSummary');
  return data;
}

// ── Revenue summary (30 days) ────────────────────────────────────────────────
// Aggregated totals only — never returns individual transaction records.
async function getRevenueSummary(businessId) {
  // Using existing pg pool for complex aggregation (Supabase JS SDK doesn't
  // support GROUP BY + conditional aggregation natively)
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                                          AS total_transactions,
      COALESCE(SUM(total_amount), 0)                                   AS total_revenue_30d,
      COALESCE(AVG(total_amount), 0)                                   AS avg_transaction,
      COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days'
                        THEN total_amount END), 0)                     AS revenue_7d,
      COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '14 days'
                        AND created_at < NOW() - INTERVAL '7 days'
                        THEN total_amount END), 0)                     AS revenue_prev_7d
    FROM sales
    WHERE business_id = $1
      AND created_at >= NOW() - INTERVAL '30 days'
  `, [businessId]);

  return rows[0] || {};
}

// ── Top items (30 days) ──────────────────────────────────────────────────────
// Returns aggregated item performance — no customer PII.
async function getTopItems(businessId, limit = 10) {
  const { rows } = await db.query(`
    SELECT
      si.item_name,
      COUNT(*)                    AS qty_sold,
      COALESCE(SUM(si.price), 0) AS total_revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.business_id = $1
      AND s.created_at >= NOW() - INTERVAL '30 days'
      AND si.item_name IS NOT NULL
    GROUP BY si.item_name
    ORDER BY qty_sold DESC
    LIMIT $2
  `, [businessId, limit]);

  return rows;
}

// ── Expense summary (30 days) ────────────────────────────────────────────────
// Aggregated invoice + fixed expenses — no raw supplier banking info.
async function getExpenseSummary(businessId) {
  const { rows } = await db.query(`
    SELECT
      COALESCE(SUM(inv.total_amount), 0)    AS supplier_invoices_30d,
      COUNT(inv.id)                          AS invoice_count,
      COALESCE(SUM(fe.amount), 0)           AS fixed_expenses_monthly,
      COUNT(fe.id)                           AS fixed_expense_count
    FROM businesses b
    LEFT JOIN invoices inv
      ON inv.business_id = b.id
      AND inv.invoice_date >= NOW() - INTERVAL '30 days'
    LEFT JOIN fixed_expenses fe
      ON fe.business_id = b.id
      AND fe.is_active = TRUE
    WHERE b.id = $1
    GROUP BY b.id
  `, [businessId]);

  return rows[0] || {};
}

// ── Inventory alerts ─────────────────────────────────────────────────────────
// Items at or below minimum stock level — operational data, no pricing secrets.
async function getInventoryAlerts(businessId) {
  const { rows } = await db.query(`
    SELECT
      name,
      current_qty AS quantity,
      min_qty AS min_quantity,
      unit,
      CASE
        WHEN current_qty = 0 THEN 'out_of_stock'
        WHEN current_qty <= min_qty THEN 'low_stock'
        ELSE 'ok'
      END AS status
    FROM inventory_items
    WHERE business_id = $1
      AND min_qty > 0
      AND current_qty <= min_qty
    ORDER BY current_qty ASC
    LIMIT 20
  `, [businessId]);

  return rows;
}

// ── Employee summary ─────────────────────────────────────────────────────────
// Counts only — no names, wages, personal data sent to AI.
async function getEmployeeSummary(businessId) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                                    AS total_employees,
      COUNT(*) FILTER (WHERE role = 'employee')                  AS employees,
      COUNT(*) FILTER (WHERE role IN ('manager', 'partner'))     AS managers,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS new_this_month
    FROM users
    WHERE business_id = $1
      AND is_active = TRUE
      AND role != 'owner'
  `, [businessId]);

  return rows[0] || {};
}

// ── AI usage today (rate limiting data) ──────────────────────────────────────
// Returns how many AI requests this user made today. Used by rateLimitAI.
async function getAIUsageToday(userId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) AS count
    FROM ai_logs
    WHERE user_id = $1
      AND created_at >= date_trunc('day', NOW())
  `, [userId]);

  return parseInt(rows[0]?.count || 0, 10);
}

// ── Log AI usage ─────────────────────────────────────────────────────────────
// Persists every AI request for audit trail, billing, and abuse detection.
// SECURITY: We log tokens_used and request_type but NOT the raw prompt
// (which may contain sanitized business data).
async function logAIUsage({ userId, businessId, tokensUsed, requestType, responseSnippet }) {
  await db.query(`
    INSERT INTO ai_logs (user_id, business_id, tokens_used, request_type, response, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
  `, [
    userId,
    businessId,
    tokensUsed      || 0,
    requestType     || 'analyze',
    // Store only the first 500 chars of the response — enough for audit,
    // not enough to reconstruct sensitive business data
    (responseSnippet || '').substring(0, 500),
  ]);
}

// ── Aggregate business intelligence payload ──────────────────────────────────
// Main entry point used by aiAnalyze.service.js.
// Fetches all business context in parallel, verifies ownership first.
async function getBusinessIntelligencePayload(userId, businessId) {
  // AUTHORIZATION: Verify ownership before ANY data fetch
  const user = await verifyUserOwnership(userId, businessId);

  // Parallel fetch — all queries are scoped to businessId
  const [business, revenue, topItems, expenses, inventoryAlerts, employees] =
    await Promise.all([
      getBusinessSummary(businessId),
      getRevenueSummary(businessId),
      getTopItems(businessId),
      getExpenseSummary(businessId),
      getInventoryAlerts(businessId),
      getEmployeeSummary(businessId),
    ]);

  return {
    user: { id: user.id, role: user.role },
    business,
    revenue,
    topItems,
    expenses,
    inventoryAlerts,
    employees,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  verifyUserOwnership,
  getBusinessIntelligencePayload,
  getAIUsageToday,
  logAIUsage,
};
