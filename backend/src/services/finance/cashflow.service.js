/**
 * Cashflow Service
 * רווח יומי, תזרים מזומנים, תחזית 30 יום
 */

const db = require('../../utils/db');
const { todayIL: _todayIL } = require('../../utils/dateIL');
const inventoryModel = require('../../models/inventory.model');

// Whether this business's Z-report already folds Wolt/Ten Bis revenue into
// its own totals — if so, the separately Gmail-imported delivery rows for
// those platforms double-count that money and must be excluded. See
// finance.routes.js (pl-streams / daily-breakdown) for the original fix.
async function _getZIncludesDeliveryFlag(businessId) {
  const { rows: [row] } = await db.query(
    `SELECT z_report_includes_delivery_platforms AS flag FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [{ flag: false }] }));
  return !!row?.flag;
}

// ── רווח יומי ─────────────────────────────────────────────────
async function getDailyProfit(businessId, date) {
  const d = date || _todayIL();
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);

  const [revenue, expenses, waste, salaries] = await Promise.all([
    _getDayRevenue(businessId, d, zIncludesDelivery),
    _getDayExpenses(businessId, d),
    _getDayWaste(businessId, d),
    _getDaySalaryCost(businessId, d),
  ]);

  const cost_of_goods = parseFloat(expenses.ingredients_cost || 0);
  const salary        = parseFloat(salaries.daily_cost       || 0);
  const fixed_daily   = parseFloat(expenses.fixed_daily      || 0);
  const waste_loss    = parseFloat(waste.loss                || 0);
  const profit        = parseFloat(revenue.total || 0) - cost_of_goods - fixed_daily - waste_loss - salary;

  return {
    date:          d,
    revenue:       parseFloat(revenue.total || 0),
    transactions:  revenue.count,
    cost_of_goods,
    expenses:      fixed_daily,
    salary,
    waste:         waste_loss,
    profit:        parseFloat(profit.toFixed(2)),
    grossProfit:   parseFloat((parseFloat(revenue.total || 0) - cost_of_goods).toFixed(2)),
    margin:        parseFloat(revenue.total || 0) > 0
      ? parseFloat(((profit / parseFloat(revenue.total)) * 100).toFixed(1))
      : 0,
  };
}

// ── תזרים מזומנים — 30 יום אחורה ──────────────────────────────
async function getCashflow(businessId, days = 30) {
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '1 day' * $2
         AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         -- 'cancelled' is only ever set on delivery rows (deliveries.routes.js
         -- PATCH /:id/status) — same fix already applied in dashboard.data.js/
         -- vat.service.js; this file's revenue queries never got it, so a
         -- cancelled delivery inflated both the in-app P&L preview
         -- (finance.routes.js's /monthly, which calls getMonthlySummary) and
         -- every export built from these same functions.
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT
       sale_day                 AS date,
       SUM(total_amount)::float AS revenue,
       -- שורת POS בודדת = עסקה אחת; שורת Z-report = orders_count עסקאות
       COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS transactions
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     GROUP BY sale_day
     ORDER BY sale_day ASC`,
    [businessId, days, zIncludesDelivery]
  );

  // עלות קבועה יומית — מחולקת לפי מספר ימי עבודה בחודש (מ-open_days)
  const [fixedMonthly, openDaysCount] = await Promise.all([
    _getMonthlyFixedExpenses(businessId),
    _getMonthlyOpenDaysCount(businessId),
  ]);
  const dailyFixed = fixedMonthly / Math.max(openDaysCount, 1);

  return rows.map(r => ({
    date:         r.date,
    revenue:      r.revenue,
    transactions: r.transactions,
    fixedCost:    parseFloat(dailyFixed.toFixed(2)),
    estimatedProfit: parseFloat((r.revenue - dailyFixed).toFixed(2)),
  }));
}

// ── תחזית 30 יום קדימה ─────────────────────────────────────────
async function getForecast(businessId) {
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);
  // ממוצע 4 שבועות אחרונים לכל יום בשבוע
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '28 days'
         AND NOT ($2 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
     SELECT
       EXTRACT(DOW FROM sale_day)::int AS dow,
       AVG(daily_total)::float         AS avg_revenue
     FROM (
       SELECT sale_day, EXTRACT(DOW FROM sale_day) AS dow, SUM(total_amount) AS daily_total
       FROM filtered
       GROUP BY sale_day
     ) sub
     GROUP BY EXTRACT(DOW FROM sale_day)`,
    [businessId, zIncludesDelivery]
  );

  const dowMap = {};
  rows.forEach(r => { dowMap[r.dow] = r.avg_revenue; });

  const fixedMonthly = await _getMonthlyFixedExpenses(businessId);
  const dailyFixed = fixedMonthly / 30;

  const forecast = [];
  // parse today in Jerusalem timezone so DOW matches the DB (which uses AT TIME ZONE 'Asia/Jerusalem')
  const todayILStr = _todayIL();
  const [ty, tm, td] = todayILStr.split('-').map(Number);

  for (let i = 1; i <= 30; i++) {
    const d       = new Date(ty, tm - 1, td + i); // local date built from Jerusalem YYYY-MM-DD
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dow     = d.getDay();
    const revenue = dowMap[dow] || 0;

    forecast.push({
      date:              dateStr,
      dow,
      forecastRevenue:   parseFloat(revenue.toFixed(2)),
      forecastProfit:    parseFloat((revenue - dailyFixed).toFixed(2)),
    });
  }

  const totalForecast = forecast.reduce((s, f) => s + f.forecastRevenue, 0);
  return {
    forecast,
    summary: {
      forecastMonthRevenue: parseFloat(totalForecast.toFixed(2)),
      forecastMonthProfit:  parseFloat((totalForecast - fixedMonthly).toFixed(2)),
      fixedExpenses:        parseFloat(fixedMonthly.toFixed(2)),
    },
  };
}

// ── סיכום חודשי ───────────────────────────────────────────────
async function getMonthlySummary(businessId, year, month) {
  const [_ily, _ilm] = _todayIL().split('-').map(Number);
  const y = year  || _ily;
  const m = month || _ilm;
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);

  const [revenue, invoices, expenses, salaries, purchases] = await Promise.all([
    db.query(
      `WITH smart AS (
         SELECT *,
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sales
         WHERE business_id = $1
           AND EXTRACT(YEAR  FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $2
           AND EXTRACT(MONTH FROM sold_at AT TIME ZONE 'Asia/Jerusalem') = $3
           AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
           AND status IS DISTINCT FROM 'cancelled'
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
       SELECT COALESCE(SUM(total_amount),0)::float AS total, COUNT(*)::int AS count
       FROM smart
       WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)`,
      [businessId, y, m, zIncludesDelivery]
    ),
    db.query(
      `SELECT COALESCE(SUM(food_cogs), 0)::float AS total, COUNT(DISTINCT inv_id)::int AS count
       FROM (
         SELECT i.id AS inv_id, ii.total_price AS food_cogs
         FROM invoices i
         JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE i.business_id = $1
           AND EXTRACT(YEAR  FROM i.invoice_date) = $2
           AND EXTRACT(MONTH FROM i.invoice_date) = $3
           AND COALESCE(i.invoice_category, 'food') = 'food'
           AND COALESCE(ii.item_type, 'מזון') = 'מזון'
         UNION ALL
         SELECT i.id AS inv_id, i.total_amount AS food_cogs
         FROM invoices i
         WHERE i.business_id = $1
           AND EXTRACT(YEAR  FROM i.invoice_date) = $2
           AND EXTRACT(MONTH FROM i.invoice_date) = $3
           AND i.total_amount IS NOT NULL
           AND COALESCE(i.invoice_category, 'food') = 'food'
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
       ) t`,
      [businessId, y, m]
    ),
    db.query(
      `SELECT COALESCE(SUM(
         CASE WHEN frequency='monthly'   THEN amount
              WHEN frequency='weekly'    THEN amount*(52.0/12)
              WHEN frequency='yearly'    THEN amount/12
              WHEN frequency='bimonthly' THEN amount/2
              -- הוצאה חד-פעמית נספרת רק בחודש שבו נרשמה (created_at) — לא בכל
              -- חודש לנצח, ולא אף פעם (כפי שקרה כשהיא נפלה בשקט ל-ELSE 0)
              WHEN frequency='one_time'
                   AND EXTRACT(YEAR  FROM created_at AT TIME ZONE 'Asia/Jerusalem') = $2
                   AND EXTRACT(MONTH FROM created_at AT TIME ZONE 'Asia/Jerusalem') = $3 THEN amount
              ELSE 0 END),0)::float AS total
       FROM fixed_expenses
       WHERE business_id = $1 AND is_active = TRUE
         -- An expense only costs money inside its own start/end window. These
         -- columns became settable from the UI in this branch; before that they
         -- were permanently NULL, so nothing checked them and only vat.service
         -- looked at end_date. Left unfixed, cancelling a contract by giving it
         -- an end date would drop it from the VAT estimate while it kept
         -- inflating this month's P&L, the daily view, the forecast and every
         -- export — an inconsistency with no symptom the owner could see.
         AND (start_date IS NULL OR start_date <  MAKE_DATE($2::int, $3::int, 1) + INTERVAL '1 month')
         AND (end_date   IS NULL OR end_date   >= MAKE_DATE($2::int, $3::int, 1))`,
      [businessId, y, m]
    ),
    db.query(
      `SELECT (
         SELECT COALESCE(SUM(
           EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0 * u.salary_amount
         ), 0)::float
         FROM shifts sh JOIN users u ON u.id = sh.employee_id
         WHERE sh.business_id = $1 AND sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
           AND u.salary_type = 'hourly'
           AND EXTRACT(YEAR  FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2
           AND EXTRACT(MONTH FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $3
       ) + (
         -- A global/monthly employee still counts toward THIS month's cost if
         -- they were active for any part of it — deactivating them later must
         -- not erase their salary cost from past months. is_active=TRUE alone
         -- used to do exactly that (retroactively zeroing historical P&L).
         SELECT COALESCE(SUM(salary_amount), 0)::float
         FROM users WHERE business_id = $1 AND salary_type IN ('global', 'monthly')
           AND created_at < MAKE_DATE($2::int, $3::int, 1) + INTERVAL '1 month'
           AND (deactivated_at IS NULL OR deactivated_at >= MAKE_DATE($2::int, $3::int, 1))
       ) AS total`,
      [businessId, y, m]
    ),
    // רכישות מלאי שנרשמו ידנית (למשל מלאי פתיחה) — אין להן חשבונית ספק,
    // אז הן לא נכללות ב-invoices, אבל זה עדיין כסף שיצא מהעסק
    db.query(
      `SELECT COALESCE(SUM(it.qty_change * ii.cost_per_unit),0)::float AS total, COUNT(*)::int AS count
       FROM inventory_transactions it
       INNER JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.business_id = $1 AND it.type = 'purchase'
         AND COALESCE(ii.item_type, 'מזון') = 'מזון'
         AND EXTRACT(YEAR  FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $2
         AND EXTRACT(MONTH FROM it.created_at AT TIME ZONE 'Asia/Jerusalem') = $3`,
      [businessId, y, m]
    ),
  ]);

  const rev          = parseFloat(revenue.rows[0].total   || 0);
  const realCogs      = parseFloat(invoices.rows[0].total || 0) + parseFloat(purchases.rows[0].total || 0);
  const hasRealCogs   = (invoices.rows[0].count || 0) > 0 || (purchases.rows[0].count || 0) > 0;
  const fixed         = parseFloat(expenses.rows[0].total  || 0);
  const sal           = parseFloat(salaries.rows[0].total  || 0);

  // אין חשבוניות ספק/רכישות רשומות לחודש הזה כלל — עלות סחורה אמיתית של 0
  // הייתה מציגה רווח של 100% (שגוי לחלוטין), לא "אין הוצאות". נופלים חזרה
  // להערכה תיאורטית לפי עלות המתכונים של מה שנמכר בפועל, מוקרנת לפי כיסוי
  // פירוט-המנות — אותו עיקרון שכבר יושם בדוח השבועי ובריבוע עלות המזון
  // בדשבורד. כשיש ולו רכישה/חשבונית אחת אמיתית לחודש, אנחנו סומכים על
  // הכסף האמיתי שיצא ולא מערבבים אותו עם הערכה.
  let cogs = realCogs;
  let isEstimated = false;
  if (!hasRealCogs) {
    isEstimated = true;
    const daysInMonth = new Date(y, m, 0).getDate();
    const pad = (n) => String(n).padStart(2, '0');
    const fromDateStr = `${y}-${pad(m)}-01`;
    const toDateStr   = `${y}-${pad(m)}-${pad(daysInMonth)}`;
    const theo = await inventoryModel.getConsumptionAnalysis(businessId, fromDateStr, toDateStr)
      .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] }));
    const coveragePct = theo.itemDataCoveragePct || 0;
    if (coveragePct > 0 && rev > 0) {
      const coveredRevenue = rev * (coveragePct / 100);
      const ratio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : 0;
      cogs = ratio * rev;
    } else {
      cogs = theo.totalConsumedValue || 0;
    }
  }

  const net = rev - cogs - fixed - sal;

  return {
    year: y, month: m,
    revenue:       rev,
    transactions:  revenue.rows[0].count,
    cogs:          parseFloat(cogs.toFixed(2)),
    isEstimated,
    grossProfit:   parseFloat((rev - cogs).toFixed(2)),
    fixedExpenses: parseFloat(fixed.toFixed(2)),
    salaryCost:    parseFloat(sal.toFixed(2)),
    netProfit:     parseFloat(net.toFixed(2)),
    margin:        rev > 0 ? parseFloat(((net / rev) * 100).toFixed(1)) : 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────

async function _getDayRevenue(businessId, date, zIncludesDelivery = false) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = $2
         AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_count AS (SELECT COUNT(*) AS c FROM smart WHERE is_ind)
     -- שורת POS בודדת = עסקה אחת; שורת Z-report = orders_count עסקאות
     -- (לא COUNT(*), אחרת יום עם דוח Z אחד נספר כ"עסקה אחת")
     SELECT COALESCE(SUM(total_amount),0)::float AS total,
            COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS count
     FROM smart, ind_count
     WHERE (ind_count.c > 0 AND is_ind) OR ind_count.c = 0`,
    [businessId, date, zIncludesDelivery]
  );
  return rows[0];
}

async function _getDayExpenses(businessId, date) {
  // עלות רכיבים — מחשבוניות ספק + רכישות מלאי שנרשמו ידנית (למשל מלאי פתיחה, שאין
  // לו חשבונית) — אותו יום
  const [inv, purchases] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(food_cost), 0)::float AS ingredients_cost
       FROM (
         SELECT SUM(ii.total_price) AS food_cost
         FROM invoices i
         JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE i.business_id = $1 AND i.invoice_date = $2
           AND COALESCE(ii.item_type, 'מזון') = 'מזון'
         UNION ALL
         SELECT total_amount AS food_cost
         FROM invoices i
         WHERE i.business_id = $1 AND i.invoice_date = $2
           AND total_amount IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
       ) t`,
      [businessId, date]
    ),
    db.query(
      `SELECT COALESCE(SUM(it.qty_change * ii.cost_per_unit),0)::float AS purchases_cost
       FROM inventory_transactions it
       INNER JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.business_id = $1 AND it.type = 'purchase'
         AND COALESCE(ii.item_type, 'מזון') = 'מזון'
         AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') = $2`,
      [businessId, date]
    ),
  ]);

  const fixedMonthly = await _getMonthlyFixedExpenses(businessId, date);

  // Use the queried date's month (not today's) for the correct days-in-month divisor
  const [ilY, ilM] = date.split('-').map(Number);
  const daysInMonth = new Date(ilY, ilM, 0).getDate(); // day 0 of next month = last day of current month

  return {
    ingredients_cost: parseFloat(inv.rows[0]?.ingredients_cost || 0) + parseFloat(purchases.rows[0]?.purchases_cost || 0),
    fixed_daily:      parseFloat((fixedMonthly / Math.max(daysInMonth, 1)).toFixed(2)),
  };
}

async function _getDayWaste(businessId, date) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(ABS(it.qty_change) * ii.cost_per_unit),0)::float AS loss
     FROM inventory_transactions it
     INNER JOIN inventory_items ii ON ii.id = it.item_id
     WHERE it.business_id = $1 AND it.type = 'waste'
       AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') = $2`,
    [businessId, date]
  );
  return rows[0];
}

// Hourly staff are charged for the hours they actually worked that day.
// Salaried staff (global/monthly) are a fixed monthly cost, so their share is
// the month's salary spread over the days of THAT month — the same treatment
// _getDayExpenses already gives fixed expenses.
//
// It used to charge `salary_amount / 30` per salaried employee for every day
// they happened to clock a shift. Two errors compounding: /30 regardless of the
// real month length, and only on shift days. On a month with 16 trading days
// the daily figures summed to ₪18,631 against getMonthlySummary's ₪13,298 for
// the same business and month — a 40% disagreement between the daily P&L screen
// and the monthly one, with no way for the owner to tell which was right.
async function _getDaySalaryCost(businessId, date) {
  const [ilY, ilM] = date.split('-').map(Number);
  const daysInMonth = new Date(ilY, ilM, 0).getDate();

  const { rows } = await db.query(
    `SELECT (
       SELECT COALESCE(SUM(
         EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start))/3600 * u.salary_amount
       ),0)::float
       FROM shifts sh INNER JOIN users u ON u.id = sh.employee_id
       WHERE sh.business_id = $1
         AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2
         AND sh.status = 'completed'
         AND u.salary_type = 'hourly'
         AND sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
     ) + (
       -- Same active-window test as getMonthlySummary: an employee counts
       -- toward a month they worked any part of, so deactivating them later
       -- doesn't retroactively erase their cost from past months.
       SELECT COALESCE(SUM(u.salary_amount), 0)::float / $5
       FROM users u
       WHERE u.business_id = $1 AND u.salary_type IN ('global', 'monthly')
         AND u.created_at < MAKE_DATE($3::int, $4::int, 1) + INTERVAL '1 month'
         AND (u.deactivated_at IS NULL OR u.deactivated_at >= MAKE_DATE($3::int, $4::int, 1))
     ) AS daily_cost`,
    [businessId, date, ilY, ilM, daysInMonth]
  );
  return rows[0];
}

// open_days is stored either as a plain array of DOW ints ([0,1,2,3,4,5,6])
// or as a per-day config object ({ sun: { open: true }, mon: {...}, ... }) —
// same two shapes handled defensively in finance.routes.js's /daily-breakdown
const _OPEN_DAYS_DOW_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function _normalizeOpenDays(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).filter(([, v]) => v?.open).map(([k]) => _OPEN_DAYS_DOW_MAP[k]).filter(d => d !== undefined);
  }
  return [0, 1, 2, 3, 4, 5, 6];
}

async function _getMonthlyOpenDaysCount(businessId) {
  const { rows } = await db.query(
    `SELECT open_days FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  const openDows = new Set(_normalizeOpenDays(rows[0]?.open_days));
  // Count working days in the current month
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (openDows.has(new Date(year, month, d).getDay())) count++;
  }
  return count || 26; // fallback: ~26 working days if unknown
}

// refDate scopes the one-time-expense match to ITS month — defaults to today
// for getCashflow/getForecast90 (which have no specific date, "current month"
// is the right proxy for a rolling/forward-looking view), but _getDayExpenses
// passes the actual queried date: without this, a historical GET /finance/daily
// used today's one-time expenses (invisible for a past month) and today's
// recurring-expense config (wrong amount for a past month if it changed since).
async function _getMonthlyFixedExpenses(businessId, refDate = null) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(
       CASE WHEN frequency='monthly'   THEN amount
            WHEN frequency='weekly'    THEN amount*(52.0/12)
            WHEN frequency='yearly'    THEN amount/12
            WHEN frequency='bimonthly' THEN amount/2
            WHEN frequency='one_time'
                 AND date_trunc('month', created_at) = date_trunc('month', $2::date) THEN amount
            ELSE 0 END),0)::float AS total
     FROM fixed_expenses
     WHERE business_id = $1 AND is_active = TRUE
       -- Same start/end window as getMonthlySummary, scoped to refDate's month.
       -- This function feeds getDailyProfit, getCashflow and getForecast, so
       -- without it a cancelled contract kept showing up in the daily P&L.
       AND (start_date IS NULL OR start_date <  date_trunc('month', $2::date) + INTERVAL '1 month')
       AND (end_date   IS NULL OR end_date   >= date_trunc('month', $2::date))`,
    [businessId, refDate || _todayIL()]
  );
  return rows[0]?.total ?? 0;
}

// ── תחזית 90 יום חכמה ─────────────────────────────────────────
// מבוססת על:
//   • ממוצע הכנסות לפי יום בשבוע (8 שבועות אחרונים)
//   • הוצאות קבועות עם due_day
//   • עלות משכורות חודשית
//   • דפוסי חשבוניות מ-3 חודשים אחרונים
//   • מאזן צובר (running balance)
async function getForecast90(businessId) {
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);
  // Single CTE replaces 4 separate round-trips
  const { rows: [meta] } = await db.query(
    `WITH
       smart AS (
         SELECT *,
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '56 days'
           AND NOT ($2 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
           AND status IS DISTINCT FROM 'cancelled'
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
       filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)),
       dow_revenue AS (
         SELECT EXTRACT(DOW FROM sale_day)::int AS dow,
                AVG(daily_total)::float         AS avg_revenue
         FROM (
           SELECT sale_day, SUM(total_amount) AS daily_total
           FROM filtered GROUP BY sale_day
         ) sub
         GROUP BY EXTRACT(DOW FROM sale_day)
       ),
       fixed_exp AS (
         -- start_date carries the month a yearly charge falls in; without it a
         -- yearly expense with due_day = 15 was emitted as a payment event on
         -- the 15th of EVERY month in the forecast.
         SELECT name, amount::float AS amount, frequency, due_day,
                EXTRACT(MONTH FROM start_date)::int AS due_month
         FROM fixed_expenses
         WHERE business_id = $1 AND is_active = TRUE
           -- Forward-looking window: drop anything already ended, and anything
           -- that only starts after the 90 days this forecast covers.
           AND (end_date   IS NULL OR end_date   >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date)
           AND (start_date IS NULL OR start_date <= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date + 90)
       ),
       salary_cost AS (
         -- תחזית שכר: ממוצע שעתי אמיתי מ-3 חודשים אחרונים + סכום קבוע גלובלי/חודשי
         SELECT (
           SELECT COALESCE(AVG(monthly_hourly), 0)::float
           FROM (
             SELECT DATE_TRUNC('month', sh.actual_start AT TIME ZONE 'Asia/Jerusalem') AS mon,
                    SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0 * u.salary_amount) AS monthly_hourly
             FROM shifts sh JOIN users u ON u.id = sh.employee_id
             WHERE sh.business_id = $1 AND sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
               AND u.salary_type = 'hourly'
               AND sh.actual_start >= DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Jerusalem') - INTERVAL '3 months'
               AND sh.actual_start <  DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Jerusalem')
             GROUP BY DATE_TRUNC('month', sh.actual_start AT TIME ZONE 'Asia/Jerusalem')
           ) hourly_months
         ) + (
           SELECT COALESCE(SUM(salary_amount), 0)::float
           FROM users WHERE business_id = $1 AND is_active = TRUE AND salary_type IN ('global', 'monthly')
         ) AS total
       ),
       invoice_pattern AS (
         SELECT COALESCE(AVG(monthly_total), 0)::float AS avg_monthly
         FROM (
           SELECT DATE_TRUNC('month', invoice_date) AS m,
                  SUM(total_amount)                 AS monthly_total
           FROM invoices
           WHERE business_id = $1
             AND invoice_date >= NOW() - INTERVAL '90 days'
           GROUP BY DATE_TRUNC('month', invoice_date)
         ) sub
       )
     SELECT
       COALESCE((SELECT json_agg(row_to_json(dr)) FROM dow_revenue dr), '[]'::json) AS dow_rows,
       COALESCE((SELECT json_agg(row_to_json(fe)) FROM fixed_exp fe), '[]'::json)   AS fixed_rows,
       (SELECT total       FROM salary_cost)                                         AS monthly_salary,
       (SELECT avg_monthly FROM invoice_pattern)                                     AS monthly_invoices`,
    [businessId, zIncludesDelivery]
  );

  const dowMap       = {};
  (meta.dow_rows || []).forEach(r => { dowMap[r.dow] = r.avg_revenue; });
  const fixedExpenses  = meta.fixed_rows  || [];
  const monthlySalary  = parseFloat(meta.monthly_salary)  || 0;
  const invoicePattern = parseFloat(meta.monthly_invoices) || 0;

  const monthlyFixed = fixedExpenses.reduce((sum, e) => {
    if (e.frequency === 'monthly')   return sum + e.amount;
    if (e.frequency === 'weekly')    return sum + e.amount * (52 / 12);
    if (e.frequency === 'yearly')    return sum + e.amount / 12;
    if (e.frequency === 'bimonthly') return sum + e.amount / 2;
    return sum;
  }, 0);

  // Divide by 30 (calendar days) for consistency with salary and invoice spreading.
  // Using open-days count here would inflate expenses: dailyFixed is applied to all
  // 90 calendar days in the loop (including closed days), so the total would equal
  // monthlyFixed/openDays*90 instead of the correct monthlyFixed*3.
  const dailyFixed = monthlyFixed / 30;
  // parse today in Jerusalem timezone so DOW and dayOfMonth match the DB (AT TIME ZONE 'Asia/Jerusalem')
  const todayILStr90 = _todayIL();
  const [ty90, tm90, td90] = todayILStr90.split('-').map(Number);

  const days    = [];
  let cumRevenue  = 0;
  let cumExpenses = 0;

  for (let i = 1; i <= 90; i++) {
    const d          = new Date(ty90, tm90 - 1, td90 + i);
    const date       = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dow        = d.getDay();
    const dayOfMonth = d.getDate();

    const forecastRevenue = dowMap[dow] || 0;

    // הוצאות: קבועות יומיות
    let dayExpenses = dailyFixed;

    // הוצאות: משכורות (מחולקות יומית)
    dayExpenses += monthlySalary / 30;

    // הוצאות: חשבוניות — פיזור לפי דפוס חודשי
    dayExpenses += invoicePattern / 30;

    // הוצאות ספציפיות: כשיש due_day מוגדר
    const dueToday = fixedExpenses.filter(e =>
      e.due_day === dayOfMonth && (
        e.frequency === 'monthly' ||
        // A yearly charge lands once a year, in its own month. Without the
        // month test it was announced in all three forecast months.
        (e.frequency === 'yearly' && e.due_month === d.getMonth() + 1)
      )
    );

    // milestone events: רשימת הוצאות שמגיעות לתשלום ביום זה
    const events = dueToday.map(e => ({
      label:  e.name,
      amount: e.amount,
      type:   'expense',
    }));

    // תוספת לריצה: כאשר due_day מוגדר, כבר הוצגה ההוצאה דרך dailyFixed;
    // אם הוצאה עם due_day — ביום הספציפי מציגים spike, ובשאר הימים מחסירים
    // פשוט: נשתמש בחלוקה אחידה (dailyFixed), ונסמן events בלבד
    cumRevenue  += forecastRevenue;
    cumExpenses += dayExpenses;

    days.push({
      date,
      dow,
      forecastRevenue:  parseFloat(forecastRevenue.toFixed(2)),
      forecastExpenses: parseFloat(dayExpenses.toFixed(2)),
      forecastProfit:   parseFloat((forecastRevenue - dayExpenses).toFixed(2)),
      cumRevenue:       parseFloat(cumRevenue.toFixed(2)),
      cumProfit:        parseFloat((cumRevenue - cumExpenses).toFixed(2)),
      events,
    });
  }

  // קיבוץ לחודשים לסיכום
  const byMonth = {};
  for (const d of days) {
    const key = d.date.slice(0, 7); // YYYY-MM
    if (!byMonth[key]) byMonth[key] = { revenue: 0, expenses: 0, profit: 0, days: 0 };
    byMonth[key].revenue  += d.forecastRevenue;
    byMonth[key].expenses += d.forecastExpenses;
    byMonth[key].profit   += d.forecastProfit;
    byMonth[key].days++;
  }

  const months = Object.entries(byMonth).map(([month, v]) => ({
    month,
    forecastRevenue:  parseFloat(v.revenue.toFixed(2)),
    forecastExpenses: parseFloat(v.expenses.toFixed(2)),
    forecastProfit:   parseFloat(v.profit.toFixed(2)),
  }));

  const total90Revenue  = days.reduce((s, d) => s + d.forecastRevenue, 0);
  const total90Expenses = days.reduce((s, d) => s + d.forecastExpenses, 0);

  return {
    days,
    months,
    summary: {
      days:              90,
      forecastRevenue:   parseFloat(total90Revenue.toFixed(2)),
      forecastExpenses:  parseFloat(total90Expenses.toFixed(2)),
      forecastProfit:    parseFloat((total90Revenue - total90Expenses).toFixed(2)),
      monthlyFixed:      parseFloat(monthlyFixed.toFixed(2)),
      monthlySalary:     parseFloat(monthlySalary.toFixed(2)),
      monthlyInvoices:   parseFloat(invoicePattern.toFixed(2)),
    },
  };
}

module.exports = { getDailyProfit, getCashflow, getForecast, getForecast90, getMonthlySummary };
