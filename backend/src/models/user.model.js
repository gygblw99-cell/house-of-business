const db    = require('../utils/db');
const cache = require('../utils/cache');

const findById = async (id, businessId = null) => {
  const params = businessId ? [id, businessId] : [id];
  const bizClause = businessId ? ' AND business_id = $2' : '';
  const { rows } = await db.query(
    `SELECT id, business_id, role, position, full_name, username, email, phone,
            salary_type, salary_amount, is_active, language, participates_in_tips,
            perm_suppliers, perm_inventory, perm_recipes,
            perm_finance, perm_ai, perm_employees, perm_export, perm_audit
     FROM users WHERE id = $1${bizClause}`,
    params
  );
  return rows[0] || null;
};

const findAllByBusiness = async (businessId, { limit, offset = 0 } = {}) => {
  const params = [businessId];
  let limitClause = '';
  if (limit != null) {
    params.push(limit, offset);
    limitClause = ` LIMIT $2 OFFSET $3`;
  }
  const { rows } = await db.query(
    `SELECT id, role, position, full_name, username, email, phone, is_active, pending_invite,
            salary_type, salary_amount, tax_credit_points, participates_in_tips,
            perm_suppliers, perm_inventory, perm_recipes,
            perm_finance, perm_ai, perm_employees, perm_export, perm_audit, created_at
     FROM users WHERE business_id = $1 ORDER BY created_at ASC${limitClause}`,
    params
  );
  return rows;
};

const USER_UPDATABLE = new Set([
  'full_name', 'email', 'phone', 'role', 'position', 'language', 'username',
  'salary_type', 'salary_amount', 'tax_credit_points', 'is_active', 'participates_in_tips',
  'perm_suppliers', 'perm_inventory', 'perm_recipes',
  'perm_finance', 'perm_ai', 'perm_employees', 'perm_export', 'perm_audit',
]);

const update = async (id, businessId, fields) => {
  const filtered = Object.fromEntries(
    Object.entries(fields).filter(([k]) => USER_UPDATABLE.has(k))
  );
  const keys   = Object.keys(filtered);
  const values = Object.values(filtered);
  if (!keys.length) throw new Error('No updatable fields provided');
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const idIdx  = keys.length + 1;
  const bizIdx = keys.length + 2;

  // Keep deactivated_at in sync whenever is_active changes through the
  // generic update() path (bulk-status route, PUT /:id) — not just the
  // dedicated deactivate() below. Historical financial queries (P&L,
  // pl-streams, daily-breakdown) key off this to still count a
  // global/monthly-salaried employee's cost for months before they were
  // deactivated, instead of erasing it retroactively.
  let deactivatedAtClause = '';
  if ('is_active' in filtered) {
    deactivatedAtClause = filtered.is_active
      ? ', deactivated_at = NULL'
      : ', deactivated_at = NOW()';
  }

  const { rows } = await db.query(
    `UPDATE users SET ${set}, updated_at = NOW()${deactivatedAtClause}
     WHERE id = $${idIdx} AND business_id = $${bizIdx}
     RETURNING id, business_id, role, position, full_name, username, email, phone,
               salary_type, salary_amount, tax_credit_points, is_active, language, participates_in_tips,
               perm_suppliers, perm_inventory, perm_recipes,
               perm_finance, perm_ai, perm_employees, perm_export, perm_audit, created_at`,
    [...values, id, businessId]
  );
  // requireAuth caches role/is_active/permissions for up to 60s (auth.js) —
  // bust it immediately on change so a role downgrade, reactivation, or
  // permission revocation takes effect on the user's very next request
  // instead of waiting out the cache TTL.
  const AUTH_CACHED_FIELDS = new Set([
    'role', 'is_active',
    'perm_suppliers', 'perm_inventory', 'perm_recipes',
    'perm_finance', 'perm_ai', 'perm_employees', 'perm_export', 'perm_audit',
  ]);
  if (keys.some(k => AUTH_CACHED_FIELDS.has(k))) {
    cache.del(`auth:status:${id}`).catch(() => {});
  }
  return rows[0];
};

const deactivate = async (id, businessId) => {
  await db.query(`UPDATE users SET is_active = FALSE, deactivated_at = NOW(), updated_at = NOW() WHERE id = $1 AND business_id = $2`, [id, businessId]);
  cache.del(`auth:status:${id}`).catch(() => {});
};

const hardDelete = async (id, businessId) => {
  await db.query('DELETE FROM users WHERE id = $1 AND business_id = $2', [id, businessId]);
  cache.del(`auth:status:${id}`).catch(() => {});
};

module.exports = { findById, findAllByBusiness, update, deactivate, hardDelete };
