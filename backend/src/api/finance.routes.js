const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getDailyProfit, getCashflow, getForecast, getForecast90, getMonthlySummary } = require('../services/finance/cashflow.service');
const { validate, schemas } = require('../middleware/validateInput');
const inventoryModel = require('../models/inventory.model');
const db    = require('../utils/db');
const { todayIL } = require('../utils/dateIL');

// Migration: add delivery_fee_pct to businesses (configurable per-business, default 15%)
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS delivery_fee_pct NUMERIC(5,2) DEFAULT 15`);
// Per-platform commission rates — null means "use delivery_fee_pct instead" (no
// override configured yet). z_report_includes_delivery_platforms: whether the
// business's own POS/Z-report already folds Wolt/Ten Bis revenue into its
// totals — if so, the separately Gmail-imported delivery rows for those two
// platforms would double-count that money and must be excluded from revenue.
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS wolt_commission_pct NUMERIC(5,2)`);
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ten_bis_commission_pct NUMERIC(5,2)`);
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS z_report_includes_delivery_platforms BOOLEAN NOT NULL DEFAULT FALSE`);
// Whether this expense actually comes with a tax invoice (חשבונית מס) whose VAT
// may be deducted. Deliberately NULLABLE with no default: NULL means "nobody has
// said", which is NOT the same as "yes". The VAT report used to claim 18/118 of
// every active expense, including ארנונה (a municipal levy that never carries
// VAT) and rent from a private landlord — see vat.service.js.
db.migrate(`ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS has_tax_invoice BOOLEAN`);
const cache    = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { parseIntRange } = require('../utils/parseQuery');

function bustFinanceCache(bizId) {
  // Wildcard pattern busts all day-ranges in one SCAN pass (Redis) or prefix scan (mem-cache)
  cache.del(`finance-cashflow:${bizId}:*`);
  cache.del(`finance-forecast:${bizId}`);
  cache.del(`finance-forecast90:${bizId}`);
  cache.del(`finance-breakdown:${bizId}:*`);
  cache.del(`dashboard:${bizId}`);
}

// Expense bust — includes forecast90 and cashflow because getForecast90 and
// getCashflow both read fixed_expenses for forward-looking cost projections.
function bustExpenseCache(bizId) {
  cache.del(`finance-cashflow:${bizId}:*`);
  cache.del(`finance-forecast:${bizId}`);
  cache.del(`finance-forecast90:${bizId}`);
  cache.del(`finance-breakdown:${bizId}:*`);
  cache.del(`dashboard:${bizId}`);
}

// GET /api/finance/daily?date=YYYY-MM-DD — רווח יומי
router.get('/daily', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const result = await getDailyProfit(req.user.businessId, req.query.date || null);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/finance/cashflow?days=30 — תזרים (cache 10 דקות)
router.get('/cashflow', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const days = parseIntRange(req.query.days, 1, 365, 30);
    const key  = `finance-cashflow:${req.user.businessId}:${days}`;
    const result = await cache.wrap(key, () => getCashflow(req.user.businessId, days), 600);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/finance/forecast — תחזית 30 יום (cache 10 דקות)
router.get('/forecast', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const key  = `finance-forecast:${req.user.businessId}`;
    const result = await cache.wrap(key, () => getForecast(req.user.businessId), 600);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/finance/forecast90 — תחזית 90 יום (cache 15 דקות — חישוב כבד)
router.get('/forecast90', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const key  = `finance-forecast90:${req.user.businessId}`;
    const result = await cache.wrap(key, () => getForecast90(req.user.businessId), 300);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/finance/daily-breakdown?year=&month= — מחזור יומי vs הוצאות צפויות
router.get('/daily-breakdown', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    // todayIL(), not new Date() — this route already uses todayIL() further
    // down for its "don't show future days" cutoff; these defaults used the
    // server's UTC clock instead, inconsistent with that same logic.
    const [_ily, _ilm] = todayIL().split('-').map(Number);
    // Reject an impossible period instead of clamping it. parseIntRange caps
    // out-of-range values, so ?month=13 quietly became December and the caller
    // got a different month's revenue with nothing to indicate the substitution
    // — for a financial breakdown that is worse than an error. GET /vat in this
    // same file already validates this way; this route did not.
    for (const [key, lo, hi] of [['year', 2000, 2100], ['month', 1, 12]]) {
      const raw = req.query[key];
      if (raw === undefined || raw === '') continue;
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < lo || n > hi) {
        return res.status(400).json({ error: 'שנה או חודש לא תקינים' });
      }
    }
    const year  = parseIntRange(req.query.year,  2000, 2100, _ily);
    const month = parseIntRange(req.query.month, 1,    12,   _ilm);

    const cacheKey = `finance-breakdown:${req.user.businessId}:${year}:${month}`;
    const result = await cache.wrap(cacheKey, async () => {

    // Same commission/dedup settings as pl-streams — see the comment there
    // for why zIncludesDelivery excludes Gmail-imported delivery rows.
    const { rows: [bizSettings] } = await db.query(
      `SELECT COALESCE(delivery_fee_pct, 15)::float AS delivery_fee_pct,
              wolt_commission_pct::float             AS wolt_commission_pct,
              ten_bis_commission_pct::float          AS ten_bis_commission_pct,
              z_report_includes_delivery_platforms   AS z_includes_delivery
       FROM businesses WHERE id = $1`,
      [req.user.businessId]
    ).catch(() => ({ rows: [{ delivery_fee_pct: 15, wolt_commission_pct: null, ten_bis_commission_pct: null, z_includes_delivery: false }] }));
    const zIncludesDelivery = !!bizSettings?.z_includes_delivery;
    const woltFeePct   = (bizSettings?.wolt_commission_pct    ?? bizSettings?.delivery_fee_pct ?? 15) / 100;
    const tenBisFeePct = (bizSettings?.ten_bis_commission_pct ?? bizSettings?.delivery_fee_pct ?? 15) / 100;

    // Wolt/Ten Bis revenue for the month — same combined-source logic as
    // pl-streams (Z-report columns + Gmail-imported delivery rows).
    const { rows: [platformRev] } = await db.query(
      `WITH raw_sales AS (
         SELECT *,
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sales
         WHERE business_id = $1
           AND EXTRACT(YEAR  FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $2
           AND EXTRACT(MONTH FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $3
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM raw_sales WHERE is_ind),
       valid_sales AS (
         SELECT * FROM raw_sales
         WHERE (is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
           AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
       )
       SELECT
         COALESCE(SUM(wolt_amount), 0)::float AS wolt_from_zreport,
         COALESCE(SUM(ten_bis_amount), 0)::float AS tenbis_from_zreport,
         COALESCE(SUM(total_amount) FILTER (WHERE sale_type = 'delivery' AND delivery_platform = 'wolt'), 0)::float AS wolt_from_delivery,
         COALESCE(SUM(total_amount) FILTER (WHERE sale_type = 'delivery' AND delivery_platform = 'tenbis'), 0)::float AS tenbis_from_delivery
       FROM valid_sales`,
      [req.user.businessId, year, month, zIncludesDelivery]
    );
    const woltRevenue   = (platformRev?.wolt_from_zreport   || 0) + (platformRev?.wolt_from_delivery   || 0);
    const tenBisRevenue = (platformRev?.tenbis_from_zreport || 0) + (platformRev?.tenbis_from_delivery || 0);
    const deliveryFees  = woltRevenue * woltFeePct + tenBisRevenue * tenBisFeePct;

    // Single CTE: 4 queries → 1 round-trip
    const { rows: [meta] } = await db.query(
      `WITH
         raw_sales AS (
           SELECT *,
                  DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                  (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
           FROM sales
           WHERE business_id = $1
             AND EXTRACT(YEAR  FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $2
             AND EXTRACT(MONTH FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $3
             AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         ),
         ind_days AS (
           SELECT DISTINCT sale_day FROM raw_sales WHERE is_ind
         ),
         valid_sales AS (
           SELECT * FROM raw_sales
           WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
         ),
         sales_daily AS (
           SELECT sale_day AS date,
                  COALESCE(SUM(total_amount),0)::float AS revenue,
                  -- שורת POS בודדת = עסקה אחת; שורת Z-report = orders_count עסקאות
                  -- (לא COUNT(*), אחרת יום עם דוח Z אחד נספר כ"עסקה אחת")
                  COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS transactions
           FROM valid_sales
           GROUP BY sale_day
         ),
         fixed_cost AS (
           SELECT COALESCE(SUM(
             CASE WHEN frequency='monthly'   THEN amount
                  WHEN frequency='weekly'    THEN amount*(52.0/12)
                  WHEN frequency='yearly'    THEN amount/12
                  WHEN frequency='bimonthly' THEN amount/2
                  -- חד-פעמית נספרת רק בחודש שבו נרשמה (created_at) — אחרת
                  -- היא נעלמת מהתקציב החודשי הזה לגמרי (כפי שקרה עד עכשיו)
                  WHEN frequency='one_time'
                       AND EXTRACT(YEAR  FROM created_at AT TIME ZONE 'Asia/Jerusalem') = $2
                       AND EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Jerusalem') = $3 THEN amount
                  ELSE 0 END),0)::float AS monthly_fixed
           FROM fixed_expenses
           WHERE business_id = $1 AND is_active = TRUE
             -- Same start/end window as cashflow.service — this drives the
             -- breakeven day, so a cancelled contract left here would push the
             -- owner's breakeven later than it really is.
             AND (start_date IS NULL OR start_date <  MAKE_DATE($2::int, $3::int, 1) + INTERVAL '1 month')
             AND (end_date   IS NULL OR end_date   >= MAKE_DATE($2::int, $3::int, 1))
         ),
         invoice_cogs AS (
           -- עלות סחורה מזון בלבד: מפרטי חשבוניות (item_type='מזון' או ריק לתאימות לאחור)
           -- + רכישות מלאי ידניות. חשבוניות שסווגו במפורש כלא-מזון מוחרגות מכאן
           -- ונספרות בנפרד כהוצאות תפעוליות.
           SELECT date, SUM(cogs)::float AS cogs FROM (
             SELECT DATE(i.invoice_date) AS date,
                    COALESCE(SUM(ii.total_price), 0) AS cogs
             FROM invoices i
             JOIN invoice_items ii ON ii.invoice_id = i.id
             WHERE i.business_id = $1
               AND EXTRACT(YEAR  FROM i.invoice_date) = $2
               AND EXTRACT(MONTH FROM i.invoice_date) = $3
               AND COALESCE(i.invoice_category, 'food') = 'food'
               AND COALESCE(ii.item_type, 'מזון') = 'מזון'
             GROUP BY DATE(i.invoice_date)
             UNION ALL
             -- חשבוניות ללא שורות פרטים — נחשבות כמזון אם לא סווגו אחרת
             SELECT invoice_date AS date, total_amount AS cogs
             FROM invoices i
             WHERE i.business_id = $1
               AND EXTRACT(YEAR  FROM i.invoice_date) = $2
               AND EXTRACT(MONTH FROM i.invoice_date) = $3
               AND i.total_amount IS NOT NULL
               AND COALESCE(i.invoice_category, 'food') = 'food'
               AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
             UNION ALL
             SELECT DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') AS date,
                    it.qty_change * ii.cost_per_unit AS cogs
             FROM inventory_transactions it
             INNER JOIN inventory_items ii ON ii.id = it.item_id
             WHERE it.business_id = $1 AND it.type = 'purchase'
               AND COALESCE(ii.item_type, 'מזון') = 'מזון'
               AND EXTRACT(YEAR  FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $2
               AND EXTRACT(MONTH FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $3
           ) combined
           GROUP BY date
         )
       SELECT
         COALESCE((SELECT json_agg(row_to_json(sd) ORDER BY sd.date) FROM sales_daily sd), '[]'::json) AS sales_rows,
         (SELECT monthly_fixed   FROM fixed_cost)                                                       AS monthly_fixed,
         COALESCE((SELECT json_agg(row_to_json(ic) ORDER BY ic.date) FROM invoice_cogs ic), '[]'::json) AS cogs_rows`,
      [req.user.businessId, year, month, zIncludesDelivery]
    );

    const salesRows   = meta.sales_rows || [];
    const invRows     = meta.cogs_rows  || [];
    const daysInMonth = new Date(year, month, 0).getDate();

    // עלות שכר בפועל לחודש:
    //   • שעתי  → שעות בפועל מ-shifts × תעריף
    //   • גלובלי/חודשי → סכום קבוע (לא תלוי שעות)
    const { rows: [shiftPayroll] } = await db.query(`
      SELECT (
        SELECT COALESCE(SUM(
          EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0 * u.salary_amount
        ), 0)::float
        FROM shifts sh JOIN users u ON u.id = sh.employee_id
        WHERE sh.business_id = $1 AND sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
          AND u.salary_type = 'hourly'
          AND EXTRACT(YEAR  FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2
          AND EXTRACT(MONTH FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $3
      ) + (
        -- Still counts a global/monthly employee's cost for this month even
        -- if they were deactivated afterward — see cashflow.service.js's
        -- getMonthlySummary for the identical fix/reasoning.
        SELECT COALESCE(SUM(salary_amount), 0)::float
        FROM users
        WHERE business_id = $1 AND salary_type IN ('global', 'monthly')
          AND created_at < MAKE_DATE($2::int, $3::int, 1) + INTERVAL '1 month'
          AND (deactivated_at IS NULL OR deactivated_at >= MAKE_DATE($2::int, $3::int, 1))
      ) AS labor_cost
    `, [req.user.businessId, year, month]);
    const actualMonthlySalary = parseFloat(shiftPayroll?.labor_cost || 0);
    const monthlyFixed = parseFloat(meta.monthly_fixed || 0) + actualMonthlySalary;
    let totalMonthlyCogs      = invRows.reduce((s, r) => s + parseFloat(r.cogs || 0), 0);
    let cogsIsEstimated       = false;

    // Approach A — COGS from inventory ledger (type='sale'/'waste' transactions).
    // Runs in parallel with invoice-based COGS. When recipes are complete and all
    // POS deductions are logged, this should converge with totalMonthlyCogs.
    const { rows: txCogsRows } = await db.query(`
      SELECT COALESCE(SUM(ABS(it.qty_change) * ii.cost_per_unit), 0)::float AS tx_cogs
      FROM inventory_transactions it
      JOIN inventory_items ii ON ii.id = it.item_id AND ii.business_id = $1
      WHERE it.business_id = $1
        AND it.type IN ('sale', 'waste')
        AND COALESCE(ii.item_type, 'מזון') = 'מזון'
        AND EXTRACT(YEAR  FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $2
        AND EXTRACT(MONTH FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $3
    `, [req.user.businessId, year, month]).catch(() => ({ rows: [{ tx_cogs: 0 }] }));
    const transactionCogs = parseFloat(txCogsRows[0]?.tx_cogs || 0);

    // הוצאות תפעוליות מחשבוניות שסווגו במפורש כלא-מזון (ניקיון/ציוד/שונות)
    const { rows: opExpRows } = await db.query(`
      SELECT COALESCE(SUM(sub.amt), 0)::float AS op_exp FROM (
        SELECT COALESCE(SUM(ii.total_price), 0) AS amt
        FROM invoices i
        JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.business_id = $1
          AND EXTRACT(YEAR  FROM i.invoice_date) = $2
          AND EXTRACT(MONTH FROM i.invoice_date) = $3
          AND COALESCE(i.invoice_category, 'food') != 'food'
        UNION ALL
        SELECT COALESCE(SUM(i.total_amount), 0) AS amt
        FROM invoices i
        WHERE i.business_id = $1
          AND EXTRACT(YEAR  FROM i.invoice_date) = $2
          AND EXTRACT(MONTH FROM i.invoice_date) = $3
          AND i.total_amount IS NOT NULL
          AND COALESCE(i.invoice_category, 'food') != 'food'
          AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
      ) sub
    `, [req.user.businessId, year, month]).catch(() => ({ rows: [{ op_exp: 0 }] }));
    const invoiceOperatingExpenses = parseFloat(opExpRows[0]?.op_exp || 0);

    // אין חשבוניות/רכישות רשומות לחודש הזה כלל — 0 עלות סחורה כאן פירושו
    // "רווח 100%" שגוי, לא "אין הוצאות". נופלים חזרה להערכה תיאורטית
    // (עלות מתכונים למה שנמכר בפועל), מוקרנת לפי כיסוי פירוט-המנות —
    // אותו עיקרון שכבר יושם ב-getMonthlySummary/דוח שבועי/ריבוע עלות מזון.
    if (totalMonthlyCogs === 0) {
      const monthTotalRevenue = salesRows.reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
      const pad = (n) => String(n).padStart(2, '0');
      const fromDateStr = `${year}-${pad(month)}-01`;
      const toDateStr   = `${year}-${pad(month)}-${pad(daysInMonth)}`;
      const theo = await inventoryModel.getConsumptionAnalysis(req.user.businessId, fromDateStr, toDateStr)
        .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] }));
      const coveragePct = theo.itemDataCoveragePct || 0;
      if (coveragePct > 0 && monthTotalRevenue > 0) {
        const coveredRevenue = monthTotalRevenue * (coveragePct / 100);
        const ratio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : 0;
        totalMonthlyCogs = ratio * monthTotalRevenue;
      } else {
        totalMonthlyCogs = theo.totalConsumedValue || 0;
      }
      cogsIsEstimated = true;
    }

    // Divide fixed costs by actual working days in the month (based on open_days), not calendar days
    const { rows: [bizRow] } = await db.query(
      `SELECT COALESCE(open_days, '[0,1,2,3,4,5,6]'::jsonb) AS open_days FROM businesses WHERE id = $1`,
      [req.user.businessId]
    );
    const DOW_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const rawDays = bizRow?.open_days;
    const openDaysArr = Array.isArray(rawDays)
      ? rawDays
      : (rawDays && typeof rawDays === 'object')
        ? Object.entries(rawDays).filter(([, v]) => v?.open).map(([k]) => DOW_MAP[k]).filter(d => d !== undefined)
        : [0, 1, 2, 3, 4, 5, 6];
    const openDowSet = new Set(openDaysArr);
    let openDaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      if (openDowSet.has(dow)) openDaysInMonth++;
    }
    const workingDays = openDaysInMonth || daysInMonth;
    const dailyFixed  = monthlyFixed / workingDays;

    const cogsMap = {};
    invRows.forEach(r => { cogsMap[r.date] = parseFloat(r.cogs); });

    // בנה map לפי תאריך
    const revenueMap = {};
    salesRows.forEach(r => { revenueMap[String(r.date).slice(0,10)] = r; });

    const days = [];
    let cumRevenue = 0;
    let breakevenDay = null;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const today   = todayIL();
      if (dateStr > today) break; // לא מציג ימים עתידיים

      const dayData = revenueMap[dateStr] || { revenue: 0, transactions: 0 };
      const revenue  = parseFloat(dayData.revenue || 0);
      const cogs     = cogsMap[dateStr] || 0;
      const totalDailyExpense = dailyFixed + cogs;

      cumRevenue += revenue;

      if (!breakevenDay && cumRevenue >= monthlyFixed) {
        breakevenDay = d;
      }

      days.push({
        date:         dateStr,
        day:          d,
        revenue,
        transactions: dayData.transactions || 0,
        dailyExpense: parseFloat(totalDailyExpense.toFixed(2)),
        dailyFixed:   parseFloat(dailyFixed.toFixed(2)),
        cogs,
        profit:       parseFloat((revenue - totalDailyExpense).toFixed(2)),
        isProfitable: revenue >= totalDailyExpense,
        cumRevenue:   parseFloat(cumRevenue.toFixed(2)),
      });
    }

    const totalRevenue = days.reduce((s, d) => s + d.revenue, 0);
    const remaining    = Math.max(0, monthlyFixed - totalRevenue);

    return {
      days,
      summary: {
        monthlyFixed:   parseFloat(monthlyFixed.toFixed(2)),
        dailyFixed:     parseFloat(dailyFixed.toFixed(2)),
        totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
        breakevenDay,
        daysInMonth,
        workingDaysInMonth: workingDays,
        remaining:      parseFloat(remaining.toFixed(2)),
        breakevenReached:  breakevenDay !== null,
        monthlySalaryCost: parseFloat(actualMonthlySalary.toFixed(2)),
        totalMonthlyCogs:  parseFloat(totalMonthlyCogs.toFixed(2)),
        cogsIsEstimated,
        transactionCogs:   parseFloat(transactionCogs.toFixed(2)),
        // Positive = bought more than recipes say was consumed (potential waste/theft/unlinked items).
        // null when invoice COGS is 0 (no invoices → gap is meaningless), or when
        // cogsIsEstimated=true (totalMonthlyCogs is a recipe-consumption estimate, not
        // actual purchases — the gap would reflect coverage gaps, not missing inventory).
        cogsGap: (totalMonthlyCogs > 0 && !cogsIsEstimated)
          ? parseFloat((totalMonthlyCogs - transactionCogs).toFixed(2))
          : null,
        invoiceOperatingExpenses: parseFloat(invoiceOperatingExpenses.toFixed(2)),
        // Wolt/Ten Bis commission for the month — see pl-streams for the same
        // per-platform logic. Not yet broken into wolt/ten_bis separately here
        // since this endpoint only needs a single monthly total for netProfit.
        deliveryFees: parseFloat(deliveryFees.toFixed(2)),
      },
    };
    }, 180); // 3-minute cache — past months are immutable; current month is fresh enough
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/finance/monthly?year=&month= — סיכום חודשי
router.get('/monthly', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const result = await getMonthlySummary(
      req.user.businessId,
      parseInt(year) || null,
      parseInt(month) || null
    );
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/finance/send-report — שליחת דוח רווח והפסד לרו"ח (נתונים מחושבים בשרת, לא מהלקוח)
router.post('/send-report', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { to, year, month } = req.body;
    if (!to?.trim()) return res.status(400).json({ error: 'כתובת מייל חסרה' });

    const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const summary = await getMonthlySummary(req.user.businessId, parseInt(year) || null, parseInt(month) || null);
    const monthName = HE_MONTHS[summary.month - 1];
    const fmt = n => `₪${Math.round(n).toLocaleString('he-IL')}`;

    const { rows: bizRows } = await db.query('SELECT name FROM businesses WHERE id = $1', [req.user.businessId]);
    const businessName = bizRows[0]?.name || '';

    const { sendEmailFromBusiness } = require('../services/notifications/email.service');
    await sendEmailFromBusiness(req.user.businessId, {
      to: to.trim(),
      subject: `דוח רווח והפסד – ${monthName} ${summary.year}`,
      text:
        `שלום,\n\nדוח רווח והפסד לחודש ${monthName} ${summary.year}:\n\n` +
        `הכנסות:          ${fmt(summary.revenue)}\n` +
        `עלות סחורה:      (${fmt(summary.cogs)})\n` +
        `רווח גולמי:       ${fmt(summary.grossProfit)}\n` +
        `הוצאות קבועות:   (${fmt(summary.fixedExpenses)})\n` +
        `עלויות שכר:      (${fmt(summary.salaryCost)})\n` +
        `רווח נקי:         ${fmt(summary.netProfit)}\n\n` +
        `בברכה,\n${businessName}`,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── הוצאות קבועות ─────────────────────────────────────────────

// GET /api/finance/expenses — כל ההוצאות הקבועות
router.get('/expenses', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const limit  = parseIntRange(req.query.limit,  1, 500, 100);
    const offset = parseIntRange(req.query.offset, 0, 1e9,   0);
    const { rows } = await db.query(
      `SELECT * FROM fixed_expenses WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.businessId, limit, offset]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/finance/expenses — הוספת הוצאה קבועה
router.post('/expenses', requireAuth, requirePermission('finance'), validate({ body: schemas.fixedExpenseSchema }), async (req, res, next) => {
  try {
    const { name, amount, frequency, category, dueDay, startDate, endDate, hasTaxInvoice } = req.body;

    // due_day / start_date / end_date existed on the table and were read by
    // getForecast90 (payment events) and vat.service (expired expenses), but no
    // endpoint ever wrote them — so the forecast's payment-event feature could
    // never fire for anyone. has_tax_invoice decides whether this expense's VAT
    // is deductible at all; see vat.service.js.
    const dd = dueDay === undefined || dueDay === null || dueDay === '' ? null : parseInt(dueDay, 10);
    if (dd !== null && (isNaN(dd) || dd < 1 || dd > 31)) {
      return res.status(400).json({ error: 'יום חיוב חייב להיות בין 1 ל-31' });
    }
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    for (const [v, label] of [[startDate, 'תאריך התחלה'], [endDate, 'תאריך סיום']]) {
      if (v && !DATE_RE.test(v)) return res.status(400).json({ error: `${label} לא תקין` });
    }

    const { rows } = await db.query(
      `INSERT INTO fixed_expenses (business_id, name, amount, frequency, category, due_day, start_date, end_date, has_tax_invoice)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.businessId, name, parseFloat(amount), frequency, category || null,
       dd, startDate || null, endDate || null,
       typeof hasTaxInvoice === 'boolean' ? hasTaxInvoice : null]
    );
    bustExpenseCache(req.user.businessId);
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'expense_created' });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/finance/expenses/:id — עדכון הוצאה
router.put('/expenses/:id', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { name, amount, frequency, category, isActive, dueDay, startDate, endDate, hasTaxInvoice } = req.body;
    // POST enforces schemas.fixedExpenseSchema (.positive()) — this route
    // must reject the same invalid input, otherwise a negative/NaN amount
    // silently corrupts monthlyFixed/dailyFixed in breakeven and P&L calcs.
    if (amount !== undefined && amount !== null) {
      const parsed = parseFloat(amount);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'סכום לא חוקי — חייב להיות מספר חיובי' });
      }
    }
    const VALID_FREQUENCIES = ['monthly', 'weekly', 'yearly', 'bimonthly', 'one_time'];
    if (frequency !== undefined && frequency !== null && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: 'סוג תדירות לא חוקי' });
    }
    if (name !== undefined && name !== null && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'שם הוצאה לא יכול להיות ריק' });
    }
    const dd = dueDay === undefined || dueDay === null || dueDay === '' ? null : parseInt(dueDay, 10);
    if (dd !== null && (isNaN(dd) || dd < 1 || dd > 31)) {
      return res.status(400).json({ error: 'יום חיוב חייב להיות בין 1 ל-31' });
    }
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    for (const [v, label] of [[startDate, 'תאריך התחלה'], [endDate, 'תאריך סיום']]) {
      if (v && !DATE_RE.test(v)) return res.status(400).json({ error: `${label} לא תקין` });
    }

    const { rows } = await db.query(
      `UPDATE fixed_expenses
       SET name            = COALESCE($1, name),
           amount          = COALESCE($2, amount),
           frequency       = COALESCE($3, frequency),
           category        = COALESCE($4, category),
           is_active       = COALESCE($5, is_active),
           due_day         = COALESCE($8, due_day),
           start_date      = COALESCE($9, start_date),
           end_date        = COALESCE($10, end_date),
           has_tax_invoice = COALESCE($11, has_tax_invoice),
           updated_at = NOW()
       WHERE id = $6 AND business_id = $7
       RETURNING *`,
      [name||null, amount ? parseFloat(amount) : null, frequency||null,
       category||null, isActive !== undefined ? isActive : null,
       req.params.id, req.user.businessId,
       dd, startDate || null, endDate || null,
       typeof hasTaxInvoice === 'boolean' ? hasTaxInvoice : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'הוצאה לא נמצאה' });
    bustExpenseCache(req.user.businessId);
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'expense_updated' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/finance/expenses/:id — מחיקת הוצאה
router.delete('/expenses/:id', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM fixed_expenses WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'הוצאה לא נמצאה' });
    bustExpenseCache(req.user.businessId);
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'expense_deleted' });
    res.json({ message: 'הוצאה נמחקה' });
  } catch (err) { next(err); }
});

// ── הכנסות ידניות ─────────────────────────────────────────────

// GET /api/finance/income?year=&month= — הכנסות ידניות
router.get('/income', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year)  || null;
    const month = parseInt(req.query.month) || null;
    const params = [req.user.businessId];
    let dateFilter = '';
    if (year && month) {
      params.push(year, month);
      dateFilter = ` AND EXTRACT(YEAR FROM income_date) = $2 AND EXTRACT(MONTH FROM income_date) = $3`;
    } else if (year) {
      params.push(year);
      dateFilter = ` AND EXTRACT(YEAR FROM income_date) = $2`;
    }
    const { rows } = await db.query(
      `SELECT * FROM manual_income WHERE business_id = $1${dateFilter} ORDER BY income_date DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/finance/income — הוספת הכנסה ידנית
router.post('/income', requireAuth, requirePermission('finance'), validate({ body: schemas.createManualIncomeSchema }), async (req, res, next) => {
  try {
    const { amount, description, incomeDate } = req.body;
    const { rows } = await db.query(
      `INSERT INTO manual_income (business_id, amount, description, income_date)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.businessId, parseFloat(amount), description,
       incomeDate || todayIL()]
    );
    bustFinanceCache(req.user.businessId);
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'income_created' });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/finance/income/:id
router.delete('/income/:id', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM manual_income WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    bustFinanceCache(req.user.businessId);
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'income_deleted' });
    res.json({ message: 'הכנסה נמחקה' });
  } catch (err) { next(err); }
});

// GET /api/finance/pl-streams?months=3 — P&L לפי ערוץ מכירה
router.get('/pl-streams', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const months = parseIntRange(req.query.months, 1, 12, 3);
    const biz    = req.user.businessId;

    // Business commission/dedup settings — fetched once up front, used both to
    // decide whether Gmail-imported delivery rows should be excluded (below)
    // and later to compute per-platform commission fees.
    const { rows: [bizSettings] } = await db.query(
      `SELECT COALESCE(delivery_fee_pct, 15)::float AS delivery_fee_pct,
              wolt_commission_pct::float             AS wolt_commission_pct,
              ten_bis_commission_pct::float          AS ten_bis_commission_pct,
              z_report_includes_delivery_platforms   AS z_includes_delivery
       FROM businesses WHERE id = $1`,
      [biz]
    ).catch(() => ({ rows: [{ delivery_fee_pct: 15, wolt_commission_pct: null, ten_bis_commission_pct: null, z_includes_delivery: false }] }));
    const zIncludesDelivery = !!bizSettings?.z_includes_delivery;

    // Revenue per stream per month (Smart CTE: prefer individual POS over Z-report aggregates)
    const { rows: revenue } = await db.query(`
      WITH smart AS (
        SELECT *,
               DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
               (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
        FROM sales
        WHERE business_id = $1
          AND sold_at >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
      valid_sales AS (
        SELECT * FROM smart
        WHERE (is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
          -- When the business's own Z-report already folds Wolt/Ten Bis revenue
          -- into its totals, the separately Gmail-imported delivery rows for
          -- those two platforms would double-count that same money — drop them.
          AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
      )
      SELECT
        TO_CHAR(DATE_TRUNC('month', sold_at AT TIME ZONE 'Asia/Jerusalem'), 'YYYY-MM') AS month,
        sale_type,
        COUNT(*)::int                           AS tx_count,
        COALESCE(SUM(total_amount), 0)::float   AS revenue
      FROM valid_sales
      GROUP BY month, sale_type
      ORDER BY month, sale_type
    `, [biz, months, zIncludesDelivery]);

    // Wolt/Ten Bis revenue per month, combining both possible sources: the
    // Z-report's own wolt_amount/ten_bis_amount columns (populated when the
    // register itself tracks these platforms) and Gmail-imported delivery
    // rows tagged with that platform. When zIncludesDelivery is true the CTE
    // above already excludes the latter, so summing both here is always safe
    // — whichever source doesn't apply is already zero.
    const { rows: platformRevenue } = await db.query(`
      WITH smart AS (
        SELECT *,
               DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
               (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
        FROM sales
        WHERE business_id = $1
          AND sold_at >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
      valid_sales AS (
        SELECT * FROM smart
        WHERE (is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
          AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
      )
      SELECT
        TO_CHAR(DATE_TRUNC('month', sold_at AT TIME ZONE 'Asia/Jerusalem'), 'YYYY-MM') AS month,
        COALESCE(SUM(wolt_amount), 0)::float AS wolt_from_zreport,
        COALESCE(SUM(ten_bis_amount), 0)::float AS tenbis_from_zreport,
        COALESCE(SUM(total_amount) FILTER (WHERE sale_type = 'delivery' AND delivery_platform = 'wolt'), 0)::float AS wolt_from_delivery,
        COALESCE(SUM(total_amount) FILTER (WHERE sale_type = 'delivery' AND delivery_platform = 'tenbis'), 0)::float AS tenbis_from_delivery
      FROM valid_sales
      GROUP BY month
    `, [biz, months, zIncludesDelivery]);
    const platformRevenueByMonth = Object.fromEntries(platformRevenue.map(r => [r.month, {
      wolt:    r.wolt_from_zreport + r.wolt_from_delivery,
      tenbis:  r.tenbis_from_zreport + r.tenbis_from_delivery,
    }]));

    // Total expenses per month (invoices ספק + רכישות מלאי שנרשמו ידנית, למשל
    // מלאי פתיחה בלי חשבונית — אותו איחוד שכבר קיים ב-getMonthlySummary/
    // daily-breakdown; בלעדיו חודש עם רק רכישות ידניות (בלי חשבוניות) נחשב
    // בטעות "אין נתונים אמיתיים" ומקבל הערכה תיאורטית במקום המספר האמיתי)
    const { rows: expenses } = await db.query(`
      SELECT month, SUM(cogs)::float AS total_cogs FROM (
        SELECT TO_CHAR(DATE_TRUNC('month', i.invoice_date), 'YYYY-MM') AS month,
               COALESCE(SUM(ii.total_price), 0) AS cogs
        FROM invoices i
        JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.business_id = $1
          AND i.created_at >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
          AND COALESCE(ii.item_type, 'מזון') = 'מזון'
        GROUP BY TO_CHAR(DATE_TRUNC('month', i.invoice_date), 'YYYY-MM')
        UNION ALL
        SELECT TO_CHAR(DATE_TRUNC('month', invoice_date), 'YYYY-MM') AS month, total_amount AS cogs
        FROM invoices i
        WHERE i.business_id = $1
          AND i.created_at >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
          AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
        UNION ALL
        SELECT TO_CHAR(DATE_TRUNC('month', it.created_at AT TIME ZONE 'Asia/Jerusalem'), 'YYYY-MM') AS month,
               it.qty_change * ii.cost_per_unit AS cogs
        FROM inventory_transactions it
        INNER JOIN inventory_items ii ON ii.id = it.item_id
        WHERE it.business_id = $1 AND it.type = 'purchase'
          AND COALESCE(ii.item_type, 'מזון') = 'מזון'
          AND it.created_at >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
      ) combined
      GROUP BY month
      ORDER BY month
    `, [biz, months]);

    // Payroll cost per month — hourly employees: actual shift hours × rate.
    // 'global'/'monthly' employees are a FLAT salary_amount per month they
    // were active, completely independent of shifts logged — same rule as
    // salary.calculator.js/cashflow.service.js's getMonthlySummary (line
    // ~209-224 there). This used to divide salary_amount by days-in-month and
    // multiply by each shift row, which double/under-counted them: an
    // employee clocking two shifts a day (common in restaurants) had their
    // cost roughly doubled, while a salaried owner/manager who doesn't use
    // the time clock at all contributed $0 (the old query only ever produced
    // a row per shift, via an implicit JOIN to shifts).
    const { rows: payroll } = await db.query(`
      WITH months AS (
        SELECT TO_CHAR(DATE_TRUNC('month', NOW()) - (n || ' months')::interval, 'YYYY-MM') AS month,
               DATE_TRUNC('month', NOW()) - (n || ' months')::interval AS month_start
        FROM generate_series(0, $2::int - 1) AS n
      ),
      hourly_cost AS (
        SELECT TO_CHAR(DATE_TRUNC('month', sh.actual_start AT TIME ZONE 'Asia/Jerusalem'), 'YYYY-MM') AS month,
               SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0 * u.salary_amount) AS cost
        FROM shifts sh
        JOIN users u ON u.id = sh.employee_id
        WHERE sh.business_id = $1 AND sh.actual_end IS NOT NULL AND u.salary_type = 'hourly'
          AND sh.actual_start >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
        GROUP BY month
      ),
      salaried_cost AS (
        -- Still counts a global/monthly employee's cost for a given month if
        -- they were active for any part of it — deactivating them later must
        -- not erase their cost from that month's already-past P&L.
        SELECT m.month, COALESCE(SUM(u.salary_amount), 0) AS cost
        FROM months m
        LEFT JOIN users u ON u.business_id = $1
          AND u.salary_type IN ('global', 'monthly')
          AND u.created_at < m.month_start + INTERVAL '1 month'
          AND (u.deactivated_at IS NULL OR u.deactivated_at >= m.month_start)
        GROUP BY m.month
      )
      SELECT m.month, (COALESCE(hc.cost, 0) + COALESCE(sc.cost, 0))::float AS labor_cost
      FROM months m
      LEFT JOIN hourly_cost hc ON hc.month = m.month
      LEFT JOIN salaried_cost sc ON sc.month = m.month
      ORDER BY m.month
    `, [biz, months]).catch(() => ({ rows: [] }));

    // Per-platform commission rates — an unconfigured platform falls back to
    // the general delivery_fee_pct (the old flat "average" estimate), so
    // businesses that haven't set Wolt/Ten Bis specifically yet see the same
    // numbers as before this feature existed.
    const FALLBACK_FEE_PCT = (bizSettings?.delivery_fee_pct || 15) / 100;
    const WOLT_FEE_PCT    = (bizSettings?.wolt_commission_pct    ?? bizSettings?.delivery_fee_pct ?? 15) / 100;
    const TEN_BIS_FEE_PCT = (bizSettings?.ten_bis_commission_pct ?? bizSettings?.delivery_fee_pct ?? 15) / 100;
    const STREAM_LABELS = { table: 'ישיבה במקום', delivery: 'משלוחים', takeaway: 'איסוף עצמי' };

    // Build monthly summary
    const monthSet = new Set(revenue.map(r => r.month));
    const expByMonth = Object.fromEntries(expenses.map(e => [e.month, parseFloat(e.total_cogs)]));
    const payByMonth = Object.fromEntries(payroll.map(e => [e.month, parseFloat(e.labor_cost)]));

    const months_list = [...monthSet].sort();

    // חודשים בלי חשבוניות/רכישות בכלל — 0 עלות סחורה שם היה מציג "100% רווח"
    // שגוי, לא "אין הוצאות". מחשבים עבורם הערכה תיאורטית (עלות מתכונים למה
    // שנמכר בפועל, מוקרנת לפי כיסוי פירוט-המנות) — אותו עיקרון בדיוק כמו
    // ב-getMonthlySummary/דוח שבועי/ריבוע עלות מזון בדשבורד.
    const monthsNeedingEstimate = months_list.filter(m => !expByMonth[m]);
    const theoResults = await Promise.all(monthsNeedingEstimate.map(month => {
      const [yy, mm] = month.split('-').map(Number);
      const pad = (n) => String(n).padStart(2, '0');
      const daysInM = new Date(yy, mm, 0).getDate();
      return inventoryModel.getConsumptionAnalysis(biz, `${month}-01`, `${month}-${pad(daysInM)}`)
        .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] }));
    }));
    const theoByMonth = Object.fromEntries(monthsNeedingEstimate.map((m, i) => [m, theoResults[i]]));

    const byMonth = months_list.map(month => {
      const streams = {};
      let totalRev = 0;
      for (const r of revenue.filter(r => r.month === month)) {
        const label = STREAM_LABELS[r.sale_type] || r.sale_type;
        streams[r.sale_type] = { label, revenue: r.revenue, tx_count: r.tx_count };
        totalRev += r.revenue;
      }
      let cogs = expByMonth[month] || 0;
      let cogsIsEstimated = false;
      let cogsConfigError = false;
      const theo = theoByMonth[month];
      // Same reliability guard as weeklyReportCrew.agent.js's hasReliableTheo/
      // hasTheoConfigErr: require at least 15% dish-detail coverage before
      // trusting the extrapolated ratio at all, and treat an estimate that
      // comes out above 200% of revenue as a recipe/unit-cost config error
      // (e.g. ingredient qty entered in the wrong unit) rather than a real
      // number — showing "COGS > revenue" as fact would be actively misleading.
      if (cogs === 0 && theo) {
        const coveragePct = theo.itemDataCoveragePct || 0;
        if (coveragePct >= 15 && theo.items?.length > 0 && totalRev > 0) {
          const coveredRevenue = totalRev * (coveragePct / 100);
          const ratio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : 0;
          const estimate = ratio * totalRev;
          if (totalRev > 0 && estimate / totalRev > 2.0) {
            cogsConfigError = true;
          } else {
            cogs = estimate;
            cogsIsEstimated = true;
          }
        }
      }
      const labor    = payByMonth[month] || 0;

      // Wolt/Ten Bis get their own configured commission rate; any other
      // delivery revenue (unrecognized platform, or a platform not yet
      // broken out — Cibus/Mishloha are not tracked reliably enough today,
      // see the settings step for why) falls back to the general rate.
      const platformRev = platformRevenueByMonth[month] || { wolt: 0, tenbis: 0 };
      const woltFee   = platformRev.wolt   * WOLT_FEE_PCT;
      const tenBisFee = platformRev.tenbis * TEN_BIS_FEE_PCT;
      const otherDeliveryRevenue = Math.max(0, (streams.delivery?.revenue || 0) - platformRev.wolt - platformRev.tenbis);
      const otherFee = otherDeliveryRevenue * FALLBACK_FEE_PCT;
      const deliveryCost = woltFee + tenBisFee + otherFee;

      const totalCost = cogs + labor + deliveryCost;
      const grossProfit = totalRev - totalCost;

      return {
        month,
        month_label: new Date(month + '-01').toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
        streams,
        total_revenue:  parseFloat(totalRev.toFixed(0)),
        total_cogs:     parseFloat(cogs.toFixed(0)),
        cogs_is_estimated: cogsIsEstimated,
        cogs_config_error: cogsConfigError,
        total_labor:    parseFloat(labor.toFixed(0)),
        delivery_fees:  parseFloat(deliveryCost.toFixed(0)),
        platform_fees: {
          wolt:    { revenue: parseFloat(platformRev.wolt.toFixed(0)), fee: parseFloat(woltFee.toFixed(0)), pct: parseFloat((WOLT_FEE_PCT * 100).toFixed(2)) },
          ten_bis: { revenue: parseFloat(platformRev.tenbis.toFixed(0)), fee: parseFloat(tenBisFee.toFixed(0)), pct: parseFloat((TEN_BIS_FEE_PCT * 100).toFixed(2)) },
          other:   { revenue: parseFloat(otherDeliveryRevenue.toFixed(0)), fee: parseFloat(otherFee.toFixed(0)), pct: parseFloat((FALLBACK_FEE_PCT * 100).toFixed(2)) },
        },
        total_cost:     parseFloat(totalCost.toFixed(0)),
        gross_profit_before_fees: parseFloat((totalRev - cogs - labor).toFixed(0)),
        gross_profit:   parseFloat(grossProfit.toFixed(0)),
        margin_pct:     totalRev > 0 ? parseFloat(((grossProfit / totalRev) * 100).toFixed(1)) : 0,
      };
    });

    // Stream totals across all months
    const streamTotals = {};
    for (const m of byMonth) {
      for (const [key, s] of Object.entries(m.streams)) {
        if (!streamTotals[key]) streamTotals[key] = { label: s.label, revenue: 0, tx_count: 0 };
        streamTotals[key].revenue   += s.revenue;
        streamTotals[key].tx_count  += s.tx_count;
      }
    }
    const totalRevAll = Object.values(streamTotals).reduce((s, v) => s + v.revenue, 0);
    for (const key of Object.keys(streamTotals)) {
      streamTotals[key].share_pct = totalRevAll > 0
        ? parseFloat(((streamTotals[key].revenue / totalRevAll) * 100).toFixed(1))
        : 0;
    }

    res.json({
      byMonth, streamTotals, months,
      delivery_fee_pct: parseFloat((FALLBACK_FEE_PCT * 100).toFixed(2)),
      wolt_commission_pct: parseFloat((WOLT_FEE_PCT * 100).toFixed(2)),
      ten_bis_commission_pct: parseFloat((TEN_BIS_FEE_PCT * 100).toFixed(2)),
      z_report_includes_delivery_platforms: zIncludesDelivery,
    });
  } catch (err) { next(err); }
});

// GET /api/finance/vat?year=&month=&period=1|2
const { getVatReport } = require('../services/finance/vat.service');

router.get('/vat', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    // todayIL(), not new Date() — same UTC-vs-Israel fix already applied to
    // /daily-breakdown's defaults earlier in this file.
    const [_vily, _vilm] = todayIL().split('-').map(Number);
    const year   = parseInt(req.query.year)   || _vily;
    const month  = parseInt(req.query.month)  || _vilm;
    const period = parseInt(req.query.period) || 1; // 1=monthly, 2=bi-monthly
    if (year < 2000 || year > 2100 || month < 1 || month > 12) {
      return res.status(400).json({ error: 'שנה או חודש לא תקינים' });
    }
    res.json(await getVatReport(req.user.businessId, year, month, period));
  } catch (err) { next(err); }
});

module.exports = router;
