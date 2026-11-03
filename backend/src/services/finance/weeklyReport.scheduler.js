/**
 * Weekly Report Scheduler
 * כל יום ראשון ב-08:00 — מריץ AI Crew ושולח סיכום שבועי לבעל העסק
 */

const db           = require('../../utils/db');
const logger       = require('../../utils/logger');
const { sendEmail } = require('../notifications/email.service');
const { runWeeklyReportCrew } = require('../../agents/weeklyReportCrew.agent');
const inventoryModel = require('../../models/inventory.model');
const { expenseActiveBetween } = require('../../utils/expenseWindow');
const { locked } = require('../../utils/jobLock');
const { withTimeout } = require('../../utils/withTimeout');

// Returns the ISO date string (YYYY-MM-DD) of the most recent Sunday in Israel time.
// This is the canonical "week_start" for the current weekly report run.
// Uses Date.UTC throughout to avoid local-timezone contamination: ilDateStr gives
// us the Israel calendar date, and all arithmetic stays in UTC so toISOString()
// returns the correct date regardless of the server's local timezone.
function _currentWeekStartIso() {
  const ilDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const [y, m, d] = ilDateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, UTC avoids local-tz shift
  return new Date(Date.UTC(y, m - 1, d - dow)).toISOString().split('T')[0];
}

// In-process mutex — prevents a recovery run at startup from overlapping with
// a scheduled run triggered shortly after, causing duplicate emails within the
// same Node.js process. Cross-process duplicates (two dynos) are handled by the
// alreadySentIds DB check below.
let _sendInProgress = false;

async function sendWeeklyReports() {
  if (_sendInProgress) {
    logger.info('[WeeklyReport] Already in progress — skipping concurrent call');
    return;
  }
  _sendInProgress = true;
  logger.info('[WeeklyReport] Starting AI-powered weekly reports...');

  try {
    const weekStartIso = _currentWeekStartIso();
    const weekEndIso   = new Date(new Date(weekStartIso).getTime() + 6 * 24 * 3600_000).toISOString().split('T')[0];

    // Per-business dedup: collect which businesses already got a report this week
    // so each is skipped individually. A global early-exit would block new businesses
    // added mid-week from receiving their first report.
    let alreadySentIds = new Set();
    try {
      const { rows: sentRows } = await db.query(
        `SELECT business_id FROM weekly_reports WHERE week_start = $1 AND email_sent_at IS NOT NULL`,
        [weekStartIso]
      );
      alreadySentIds = new Set(sentRows.map(r => r.business_id));
      if (alreadySentIds.size > 0) {
        logger.info('[WeeklyReport] Some businesses already sent this week — skipping them', { count: alreadySentIds.size, weekStart: weekStartIso });
      }
    } catch { /* column may not exist yet on first boot — non-fatal, proceed */ }

    // Only active businesses with active owner users receive the report.
    // b.is_active = TRUE excludes demo/disabled businesses.
    const { rows: owners } = await db.query(
      `SELECT u.email, u.full_name, u.business_id, b.name AS business_name
         FROM users u
         INNER JOIN businesses b ON b.id = u.business_id
        WHERE u.role = 'owner' AND u.email IS NOT NULL AND u.is_active = TRUE AND b.is_active = TRUE`
    );

    // Group by business — a business with 2+ owner-role users must only get
    // ONE crew run: the report is per-business, not per-owner. Running it once
    // per owner used to waste AI spend AND race the weekly_reports table's
    // unique (business_id, week_start) constraint (both owners' calls would
    // SELECT-see-nothing then both INSERT). Every owner in the group still
    // gets their own email, built from the one shared crew result.
    const byBusiness = new Map();
    for (const o of owners) {
      if (!byBusiness.has(o.business_id)) byBusiness.set(o.business_id, []);
      byBusiness.get(o.business_id).push(o);
    }
    const businesses = [...byBusiness.values()];

    const CONCURRENCY = 3;
    let sent = 0, failed = 0;

    for (let i = 0; i < businesses.length; i += CONCURRENCY) {
      const batch = businesses.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (ownerGroup) => {
          const [firstOwner] = ownerGroup;
          if (alreadySentIds.has(firstOwner.business_id)) {
            logger.info('[WeeklyReport] Skipping already-sent business', { businessId: firstOwner.business_id });
            return;
          }
          let crewResult = null;
          try {
            crewResult = await withTimeout(
    runWeeklyReportCrew(firstOwner.business_id),
    90_000, "crew");
          } catch (crewErr) {
            logger.warn('[WeeklyReport] Crew failed', { business: firstOwner.business_name, err: crewErr.message });
          }
          await Promise.all(ownerGroup.map(owner => _sendReportToOwner(owner, crewResult)));
          // Mark email as sent so a subsequent restart doesn't re-send this business
          await db.query(
            `INSERT INTO weekly_reports (business_id, week_start, week_end, email_sent_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (business_id, week_start) DO UPDATE SET email_sent_at = NOW()`,
            [firstOwner.business_id, weekStartIso, weekEndIso]
          ).catch(() => {});
          return 'sent'; // sentinel — distinguishes a real send from a skip (which returns undefined)
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value === 'sent') sent++;
        else if (r.status === 'rejected') { failed++; logger.error('[WeeklyReport] batch error', { err: r.reason?.message }); }
        // r.value === undefined → business was skipped (alreadySentIds) — not counted
      });
    }

    logger.info(`[WeeklyReport] Done — ${sent} עסקים נשלחו, ${failed} נכשלו`);
  } catch (err) {
    logger.error('[WeeklyReport] Fatal error', { err: err.message });
  } finally {
    _sendInProgress = false;
  }
}

// Normalize the crew's already-computed data (data.sales/cogs/inventory/labor)
// into the flat shape the email template below reads. Reusing this — instead
// of re-querying independently — is what keeps the email's numbers identical
// to the in-app weekly report (e.g. the delivery-platform double-count
// exclusion in weeklyReportCrew.agent.js's gatherWeekData now automatically
// applies here too, instead of needing to be re-applied in a second place).
function _kpisFromCrewData(data) {
  const da = data.dataAvailability || {};
  return {
    revenue:      data.sales.revenue,
    transactions: data.sales.transactions || 0,
    avgTicket:    data.sales.avgTicket || 0,
    hasCostData:  !!da.hasCostData,
    hasInvoices:  !!da.hasInvoices,
    cogs:         data.cogs.total,
    grossProfit:  data.cogs.grossProfit,
    grossMargin:  data.cogs.grossMargin ?? '0',
    hasNet:       !!(da.hasCostData && da.hasFixedExpenses && da.hasLaborTracking),
    netProfit:    data.cogs.netProfit,
    netMargin:    data.cogs.netMargin ?? '0',
    lowStock:     data.inventory.low_stock,
    expiringSoon: data.inventory.expiring_soon,
    activeEmp:    data.labor.active_employees,
    totalHours:   Math.round(data.labor.total_hours || 0),
    totalLaborCost: Math.round(data.cogs.laborCost || 0),
  };
}

// Fallback only — used when the AI crew failed/timed out and there's no
// crewResult.data to reuse. Mirrors gatherWeekData's "smart" sales dedup,
// delivery-platform double-count exclusion, and fixed-expenses/waste terms
// so a business that only ever hits this fallback still gets numbers
// consistent with the in-app report.
async function _freshKpis(businessId) {
  const today      = new Date();
  const weekAgo     = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const todayIso    = today.toISOString().split('T')[0];
  const weekAgoIso  = weekAgo.toISOString().split('T')[0];

  const { rows: [zFlagRow] } = await db.query(
    `SELECT z_report_includes_delivery_platforms AS flag FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [{ flag: false }] }));
  const zIncludesDelivery = !!zFlagRow?.flag;

  const [salesRes, invoicesRes, inventoryRes, shiftsRes, fixedSalaryRes, fixedExpRes, wasteRes, theoConsumption] = await Promise.all([
    db.query(
      `WITH smart AS (
         SELECT *,
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sales
         WHERE business_id = $1
           AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
           AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') <= $3
           AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
       filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)),
       counted AS (SELECT total_amount, CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END AS order_units FROM filtered)
       SELECT
         COALESCE(SUM(total_amount), 0)::float AS revenue,
         COALESCE(SUM(order_units), 0)::int    AS transactions,
         CASE WHEN COALESCE(SUM(order_units),0) > 0
              THEN (SUM(total_amount) / SUM(order_units))::float ELSE 0 END AS avg_ticket
       FROM counted`,
      [businessId, weekAgoIso, todayIso, zIncludesDelivery]
    ),
    db.query(
      `SELECT COALESCE(SUM(food_cogs), 0)::float AS cogs, COUNT(DISTINCT inv_id)::int AS invoice_count
       FROM (
         SELECT i.id AS inv_id, ii.total_price AS food_cogs
         FROM invoices i
         JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE i.business_id = $1 AND i.invoice_date >= $2 AND i.invoice_date <= $3
           AND COALESCE(i.invoice_category, 'food') = 'food'
           AND COALESCE(ii.item_type, 'מזון') = 'מזון'
         UNION ALL
         SELECT i.id AS inv_id, i.total_amount AS food_cogs
         FROM invoices i
         WHERE i.business_id = $1 AND i.invoice_date >= $2 AND i.invoice_date <= $3
           AND COALESCE(i.invoice_category, 'food') = 'food'
           AND i.total_amount IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
       ) t`,
      [businessId, weekAgoIso, todayIso]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE current_qty <= min_qty AND min_qty > 0)::int AS low_count,
         COUNT(*) FILTER (WHERE expiry_date <= NOW() + INTERVAL '3 days' AND expiry_date IS NOT NULL)::int AS expiring_soon
       FROM inventory_items
       WHERE business_id = $1 AND is_active = TRUE`,
      [businessId]
    ),
    db.query(
      `SELECT COUNT(DISTINCT employee_id)::int AS active_employees,
              COALESCE(SUM(
                EXTRACT(EPOCH FROM (COALESCE(actual_end, NOW()) - actual_start)) / 3600
              ), 0)::float AS total_hours,
              COALESCE(SUM(
                CASE WHEN u.salary_type='hourly'
                     THEN EXTRACT(EPOCH FROM (COALESCE(sh.actual_end, NOW()) - sh.actual_start)) / 3600
                          * COALESCE(u.salary_amount, 0)
                     ELSE 0 END
              ), 0)::float AS hourly_labor_cost
       FROM shifts sh
       LEFT JOIN users u ON u.id = sh.employee_id
       WHERE sh.business_id = $1
         AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') >= $2
         AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') <= $3`,
      [businessId, weekAgoIso, todayIso]
    ),
    // Global/fixed salary employees — prorated for 7 days (monthly ÷ 4)
    db.query(
      `SELECT COALESCE(SUM(salary_amount), 0)::float AS total_monthly_fixed
       FROM users
       WHERE business_id = $1 AND is_active = TRUE AND role != 'owner'
         AND salary_type NOT IN ('hourly', 'unknown', 'none')
         AND salary_amount IS NOT NULL AND salary_amount > 0`,
      [businessId]
    ).catch(() => ({ rows: [{ total_monthly_fixed: 0 }] })),
    // Fixed expenses (rent, utilities...) prorated ÷4 — needed for net profit,
    // matches weeklyReportCrew.agent.js's ≤8-day convention.
    db.query(
      `SELECT COALESCE(SUM(
        CASE WHEN frequency='monthly'   THEN amount
             WHEN frequency='weekly'    THEN amount*(52.0/12)
             WHEN frequency='yearly'    THEN amount/12
             WHEN frequency='bimonthly' THEN amount/2
             WHEN frequency='one_time'
                  AND created_at::date BETWEEN $2 AND $3 THEN amount
             ELSE 0 END
      ),0)::float AS monthly_total
      FROM fixed_expenses
      WHERE business_id=$1 AND is_active=TRUE${expenseActiveBetween('$2', '$3')}`,
      [businessId, weekAgoIso, todayIso]
    ).catch(() => ({ rows: [{ monthly_total: 0 }] })),
    db.query(
      `SELECT COALESCE(SUM(ABS(it.qty_change) * COALESCE(ii.cost_per_unit,0)),0)::float AS waste_loss
       FROM inventory_transactions it
       JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.business_id=$1
         AND it.type='waste'
         AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') >= $2
         AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') <= $3`,
      [businessId, weekAgoIso, todayIso]
    ).catch(() => ({ rows: [{ waste_loss: 0 }] })),
    // Theoretical food cost from recipes — used when no invoices exist
    inventoryModel.getConsumptionAnalysis(businessId, weekAgoIso, todayIso)
      .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] })),
  ]);

  const revenue      = salesRes.rows[0].revenue;
  const transactions = salesRes.rows[0].transactions;
  const avgTicket     = salesRes.rows[0].avg_ticket;
  const invoiceCogs  = invoicesRes.rows[0].cogs;
  const hasInvoices  = invoicesRes.rows[0].invoice_count > 0;
  const hourlyLaborCost  = shiftsRes.rows[0].hourly_labor_cost || 0;
  const totalMonthlyFixed = fixedSalaryRes.rows[0]?.total_monthly_fixed || 0;
  const fixedLaborWeekly  = Math.round(totalMonthlyFixed / 4);
  const totalLaborCost    = Math.round(hourlyLaborCost + fixedLaborWeekly);
  const hasLaborTracking  = shiftsRes.rows[0].active_employees > 0 || shiftsRes.rows[0].total_hours > 0 || fixedLaborWeekly > 0;
  const fixedExpMonthly   = fixedExpRes.rows[0]?.monthly_total || 0;
  const fixedExpWeekly    = Math.round(fixedExpMonthly / 4);
  const hasFixedExpenses  = fixedExpMonthly > 0;
  const wasteLossAmt      = wasteRes.rows[0]?.waste_loss || 0;

  const theo = theoConsumption || { itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] };
  const coveredRevenue        = revenue > 0 ? revenue * (theo.itemDataCoveragePct / 100) : 0;
  const observedFoodCostRatio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : null;
  const theoValueForCalc      = observedFoodCostRatio !== null ? observedFoodCostRatio * revenue : theo.totalConsumedValue;
  const theoPct         = revenue > 0 ? (theoValueForCalc / revenue) : 0;
  const hasReliableTheo = theo.itemDataCoveragePct >= 15 && theo.items.length > 0 && theoPct <= 2.0;
  const hasCostData     = hasInvoices || hasReliableTheo;
  const cogs            = hasInvoices ? invoiceCogs : (hasReliableTheo ? theoValueForCalc : 0);
  const grossProfit  = revenue - cogs;
  const grossMargin  = revenue > 0 ? ((grossProfit / revenue) * 100).toFixed(1) : '0';
  const hasNet    = hasCostData && hasFixedExpenses && hasLaborTracking;
  const netProfit = grossProfit - fixedExpWeekly - totalLaborCost - wasteLossAmt;
  const netMargin = revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : '0';

  return {
    revenue, transactions, avgTicket,
    hasCostData, hasInvoices, cogs, grossProfit, grossMargin,
    hasNet, netProfit, netMargin,
    lowStock:     inventoryRes.rows[0].low_count,
    expiringSoon: inventoryRes.rows[0].expiring_soon,
    activeEmp:    shiftsRes.rows[0].active_employees,
    totalHours:   Math.round(shiftsRes.rows[0].total_hours),
    totalLaborCost,
  };
}

async function _sendReportToOwner({ email, business_id, business_name }, crewResult = null) {
  const today     = new Date();
  const weekAgo   = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const todayStr  = today.toLocaleDateString('he-IL');
  const weekStr   = weekAgo.toLocaleDateString('he-IL');

  const k = crewResult?.data ? _kpisFromCrewData(crewResult.data) : await _freshKpis(business_id);

  const fmt = (n) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
  const profitColor = k.grossProfit >= 0 ? '#16a34a' : '#dc2626';
  const netColor     = (k.netProfit ?? 0) >= 0 ? '#16a34a' : '#dc2626';

  const html = `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:24px;border-radius:12px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a5c2a,#2d8a45);border-radius:10px;padding:24px;text-align:center;margin-bottom:24px">
      <h1 style="color:white;margin:0;font-size:22px">📊 סיכום שבועי</h1>
      <p style="color:rgba(255,255,255,0.8);margin:6px 0 0">${_esc(business_name)} · ${weekStr} – ${todayStr}</p>
    </div>

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      ${_kpiCard('💰 הכנסות', fmt(k.revenue), '#1a5c2a')}
      ${k.hasCostData ? _kpiCard('🛒 עלות סחורה', fmt(k.cogs) + (!k.hasInvoices ? '*' : ''), '#dc2626') : _kpiCard('🛒 עלות סחורה', 'לא הוזן', '#9ca3af')}
      ${k.hasCostData ? _kpiCard('📈 רווח גולמי', fmt(k.grossProfit), profitColor) : _kpiCard('📈 רווח גולמי', 'לא ניתן לחשב', '#9ca3af')}
      ${k.hasNet ? _kpiCard('✅ רווח נקי', fmt(k.netProfit), netColor) : _kpiCard('✅ רווח נקי', 'לא ניתן לחשב', '#9ca3af')}
    </div>

    <!-- Details -->
    <div style="background:white;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e8f0">
      <h3 style="margin:0 0 12px;color:#374151;font-size:15px">פרטי השבוע</h3>
      ${k.transactions > 0 ? _row('עסקאות', k.transactions + ' מכירות') + _row('ממוצע לעסקה', fmt(k.avgTicket)) : ''}
      ${k.hasCostData ? _row('📊 מרווח גולמי', k.grossMargin + '%') : ''}
      ${k.hasNet ? _row('📊 מרווח נקי', k.netMargin + '%') : ''}
      ${k.totalLaborCost > 0 ? _row('💼 עלות שכר (שבועי)', fmt(k.totalLaborCost)) : ''}
      ${k.totalHours > 0 ? _row('שעות עבודה', k.totalHours + ' שעות') : ''}
      ${k.activeEmp > 0 ? _row('עובדים פעילים', k.activeEmp + ' עובדים') : ''}
    </div>

    <!-- Alerts -->
    ${k.lowStock > 0 ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:16px">
      <p style="margin:0;color:#dc2626;font-weight:bold">⚠️ ${k.lowStock} פריטי מלאי מתחת למינימום — בדוק עכשיו</p>
    </div>` : `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-bottom:16px">
      <p style="margin:0;color:#16a34a">✅ כל המלאי תקין</p>
    </div>`}
    ${k.expiringSoon > 0 ? `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;margin-bottom:16px">
      <p style="margin:0;color:#c2410c;font-weight:bold">⏰ ${k.expiringSoon} פריטים בסכנת תפוגה תוך 3 ימים — יש לטפל מיד</p>
    </div>` : ''}

    <!-- AI Crew Report Body -->
    ${crewResult?.reportBody ? `
    <div style="background:white;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #e2e8f0">
      <h3 style="margin:0 0 10px;color:#374151;font-size:15px">📝 ניתוח AI</h3>
      <p style="margin:0;color:#374151;font-size:14px;line-height:1.7;white-space:pre-line">${_esc(crewResult.reportBody)}</p>
    </div>` : ''}

    <!-- AI Actions -->
    ${crewResult?.advice?.actions?.length > 0 ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:16px">
      <h3 style="margin:0 0 12px;color:#166534;font-size:15px">🎯 3 פעולות לשבוע הבא</h3>
      ${crewResult.advice.actions.map((a, i) => `
      <div style="margin-bottom:10px;padding:10px;background:white;border-radius:6px;border-right:3px solid ${a.priority==='high'?'#dc2626':'#c9a227'}">
        <p style="margin:0 0 4px;font-weight:bold;color:#111827;font-size:14px">${i+1}. ${_esc(a.title)}</p>
        <p style="margin:0 0 4px;color:#374151;font-size:13px">${_esc(a.action)}</p>
        <p style="margin:0;color:#6b7280;font-size:12px">📈 ${_esc(a.expectedImpact)}</p>
      </div>`).join('')}
    </div>` : ''}

    <!-- Footer -->
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0">
      House of Business · דוח שבועי AI · ${todayStr}
    </p>
  </div>`;

  await sendEmail({
    to:      email,
    subject: `📊 סיכום שבועי — ${business_name} · ${weekStr}`,
    html,
  });
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _kpiCard(label, value, color) {
  return `<div style="background:white;border-radius:8px;padding:14px;border:1px solid #e2e8f0;text-align:center">
    <p style="margin:0;font-size:12px;color:#6b7280">${label}</p>
    <p style="margin:4px 0 0;font-size:20px;font-weight:900;color:${color}">${value}</p>
  </div>`;
}

function _row(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9">
    <span style="color:#6b7280;font-size:14px">${label}</span>
    <span style="font-weight:bold;font-size:14px;color:#111827">${value}</span>
  </div>`;
}

function startWeeklyReportScheduler() {
  // Returns ms until next Sunday 08:00 **Asia/Jerusalem** (DST-aware).
  // setHours(8,0,0,0) would fire at 08:00 server-local time (UTC on most cloud
  // hosts), which is 10:00 or 11:00 Israel time — wrong. We compute the exact
  // UTC timestamp where Intl reports 08:00 in Asia/Jerusalem instead.
  // Returns a negative value when Sunday 08:00 was missed in the past 4 hours
  // (e.g. due to a server restart) so scheduleNext() can fire a recovery run.
  function msUntilSunday8am() {
    const nowMs = Date.now();

    // Current day-of-week and hour in Israel timezone
    const ilParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(nowMs));
    const get    = (t) => ilParts.find(p => p.type === t)?.value;
    const DOW    = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const ilDow  = DOW[get('weekday')] ?? 1;
    const ilHour = parseInt(get('hour')   ?? '0', 10);
    const ilMin  = parseInt(get('minute') ?? '0', 10);

    let daysToAdd = (7 - ilDow) % 7;
    if (daysToAdd === 0) {
      if (ilHour < 8) {
        // Today is Sunday and 08:00 hasn't arrived yet — target today (daysToAdd=0)
      } else if ((ilHour - 8) * 60 + ilMin <= 240) {
        // Sunday 08:00–12:00 Israel: we're in the 4-hour recovery window.
        // Return negative so scheduleNext() fires a missed-run immediately.
        return -1;
      } else {
        // Sunday afternoon/evening — wait for next Sunday
        daysToAdd = 7;
      }
    }

    // Israel current date as "YYYY-MM-DD" (en-CA locale format)
    const ilDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
    }).format(new Date(nowMs));
    const [iy, im, id] = ilDateStr.split('-').map(Number);

    // Midnight UTC on the target Israel calendar date
    const targetMidnightUtc = Date.UTC(iy, im - 1, id + daysToAdd);

    // Find exact UTC ms where the Israel clock = 08:00 (Israel is UTC+2 or UTC+3)
    const ilHourAt = (ms) => parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false })
        .formatToParts(new Date(ms)).find(p => p.type === 'hour')?.value ?? '0', 10
    );
    for (const offsetH of [2, 3]) {
      const candidate = targetMidnightUtc + (8 - offsetH) * 3600_000;
      if (ilHourAt(candidate) === 8) return candidate - nowMs;
    }
    return targetMidnightUtc + 6 * 3600_000 - nowMs; // UTC+2 fallback
  }

  function scheduleNext() {
    const delay = msUntilSunday8am();
    if (delay <= 0) {
      // Sunday 08:00 Israel was missed (server restart / deploy) — run now
      logger.info('[WeeklyReport] Missed Sunday 08:00 Israel — running recovery report now');
      _sendWeeklyReportsLocked().finally(scheduleNext);
      return;
    }
    const nextRun = new Date(Date.now() + delay);
    logger.info(`[WeeklyReport] Next report: ${nextRun.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
    setTimeout(() => {
      _sendWeeklyReportsLocked();
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _sendWeeklyReportsLocked = locked('weekly-report', sendWeeklyReports);
module.exports = { startWeeklyReportScheduler, sendWeeklyReports };
