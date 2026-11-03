/**
 * Weekly Report Crew — 4-Agent Pipeline
 *
 * Agent 1 — Data Analyst    : structures raw DB data into insights
 * Agent 2 — Business Analyst: identifies trends, anomalies, wins/losses
 * Agent 3 — Report Writer   : writes executive Hebrew report
 * Agent 4 — Strategic Advisor: adds 3 concrete action items
 */

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../utils/db');
const logger    = require('../utils/logger');
const inventoryModel = require('../models/inventory.model');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { createWithRetry } = require('../utils/anthropicRetry');
const { logTokenUsage }   = require('../utils/logTokenUsage');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const { expenseActiveBetween } = require('../utils/expenseWindow');

// ── Ensure storage table ─────────────────────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS weekly_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    week_start  DATE NOT NULL,
    week_end    DATE NOT NULL,
    analysis    TEXT,
    report_body TEXT,
    advice      TEXT,
    raw_data    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`);
// Add unique index separately so it applies even when table already existed without it
db.migrate(`CREATE UNIQUE INDEX IF NOT EXISTS weekly_reports_biz_week_uq ON weekly_reports(business_id, week_start)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_weekly_reports_biz_week_desc ON weekly_reports(business_id, week_start DESC)`);

// ── DB: gather week data — aligned with finance/getMonthlySummary ────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Shared by gatherWeekData and runWeeklyReportCrew so a date that's invalid
// per one is invalid per the other — previously runWeeklyReportCrew accepted
// anything new Date() could parse (crashing on garbage, or silently
// mismatching the header/DB week_start against a stricter-parsed value
// gatherWeekData actually used) instead of sharing this exact check.
const isValidDateStr = (s) => typeof s === 'string' && ISO_DATE.test(s) && !isNaN(new Date(s).getTime());

async function gatherWeekData(businessId, dateFrom, dateTo) {
  const safeFrom = dateFrom && isValidDateStr(dateFrom) ? dateFrom : null;
  const safeTo   = dateTo   && isValidDateStr(dateTo)   ? dateTo   : null;

  // Use parameterized dates to avoid SQL injection; fall back to last 7 days
  const fromParam = safeFrom || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const toParam   = safeTo   || new Date().toISOString().split('T')[0];
  // +1 so Mon→Sun = 7 days; without it the diff is 6 and prevFrom misses a day
  const daysNum   = Math.max(1, Math.round(
    (new Date(toParam) - new Date(fromParam)) / 86400000
  ) + 1);

  // Previous period: same length, immediately before
  const prevFrom = new Date(new Date(fromParam) - daysNum * 86400000).toISOString().split('T')[0];
  const prevTo   = fromParam;

  // Whether this business's Z-report already folds Wolt/Ten Bis revenue into
  // its own totals — if so, the separately Gmail-imported delivery rows for
  // those platforms double-count that money and must be excluded. See
  // finance.routes.js (pl-streams / daily-breakdown) for the original fix.
  const { rows: [zFlagRow] } = await db.query(
    `SELECT z_report_includes_delivery_platforms AS flag FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [{ flag: false }] }));
  const zIncludesDelivery = !!zFlagRow?.flag;

  const [
    salesCur, salesPrev,
    topDishes, invoices,
    inventory, laborData, fixedSalaryData,
    reviews, fixedExp, wasteLoss,
    zReportData, theoreticalConsumption,
  ] = await Promise.all([

    // ── Current period revenue (smart: Z-report counts on Z-only days) ────────
    db.query(`
      WITH smart AS (
        SELECT *,
               DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
               (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
        FROM sales
        -- AT TIME ZONE כאן חייב להתאים בדיוק לאותו ביטוי שמחשב sale_day —
        -- אחרת גבול היום נקבע לפי UTC (session timezone) בזמן שהדה-דופ עצמו
        -- עובד לפי שעון ישראל, ומכירות בין חצות לשעה 2-3 לפנות בוקר (שעון
        -- ישראל) "בורחות" ליום הלא נכון — בדיוק התקופה שדוחות Z נרשמים בה
        WHERE business_id=$1
          AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
          AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') <= $3
          AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
      filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)),
      -- כל שורת POS בודדת = עסקה אחת; כל שורת Z-report = orders_count עסקאות
      -- (אחרת סופרים ימי-Z כאילו הם עסקאות בודדות, וה"ממוצע לעסקה" יוצא בפועל
      -- ממוצע הכנסה יומית — פי עשרות ממה שבאמת שילם כל סועד)
      counted AS (SELECT total_amount, CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END AS order_units FROM filtered)
      SELECT COALESCE(SUM(total_amount),0)::float AS revenue,
             COALESCE(SUM(order_units),0)::int    AS transactions,
             CASE WHEN COALESCE(SUM(order_units),0) > 0
                  THEN (SUM(total_amount) / SUM(order_units))::float ELSE 0 END AS avg_ticket
      FROM counted
    `, [businessId, fromParam, toParam, zIncludesDelivery]),

    // ── Previous period revenue ───────────────────────────────────────────────
    db.query(`
      WITH smart AS (
        SELECT *,
               DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
               (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
        FROM sales
        WHERE business_id=$1
          AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
          AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') < $3
          AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
      filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
      SELECT COALESCE(SUM(total_amount),0)::float AS revenue,
             COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS transactions
      FROM filtered
    `, [businessId, prevFrom, prevTo, zIncludesDelivery]),

    // ── Top 5 dishes (smart dedup: individual POS takes priority over Z on same day)
    db.query(`
      WITH smart AS (
        SELECT s.id,
               (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind,
               DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day
        FROM sales s
        WHERE s.business_id=$1
          AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
          AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') <= $3
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
      valid_sales AS (
        SELECT id FROM smart
        WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
      )
      SELECT si.name, SUM(si.qty)::int AS qty, SUM(si.total_price)::float AS revenue
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.id IN (SELECT id FROM valid_sales)
      GROUP BY si.name ORDER BY revenue DESC LIMIT 5
    `, [businessId, fromParam, toParam]),

    // ── COGS from invoices — identical to getMonthlySummary ──────────────────
    db.query(`
      SELECT COALESCE(SUM(total_amount),0)::float AS cogs,
             COUNT(*)::int                         AS invoice_count
      FROM invoices
      WHERE business_id=$1
        AND invoice_date >= $2 AND invoice_date <= $3
    `, [businessId, fromParam, toParam]),

    // ── Inventory alerts (current snapshot) ──────────────────────────────────
    db.query(`
      SELECT COUNT(*) FILTER (WHERE current_qty <= min_qty AND min_qty > 0)::int AS low_stock,
             COUNT(*) FILTER (WHERE expiry_date <= NOW()+INTERVAL '3 days' AND expiry_date IS NOT NULL)::int AS expiring_soon
      FROM inventory_items
      WHERE business_id=$1 AND is_active=TRUE
    `, [businessId]),

    // ── Labor: hourly workers from shifts ────────────────────────────────────
    db.query(`
      SELECT
        COUNT(DISTINCT sh.employee_id)::int AS active_employees,
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(sh.actual_end,NOW())-sh.actual_start))/3600),0)::float AS total_hours,
        COUNT(*) FILTER (WHERE sh.status='absent')::int AS missed_shifts,
        COALESCE(SUM(
          CASE WHEN u.salary_type='hourly'
               THEN EXTRACT(EPOCH FROM (COALESCE(sh.actual_end,NOW())-sh.actual_start))/3600
                    * COALESCE(u.salary_amount,0)
               ELSE 0 END
        ),0)::float AS hourly_labor_cost
      FROM shifts sh
      LEFT JOIN users u ON u.id = sh.employee_id
      WHERE sh.business_id=$1
        AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') >= $2
        AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') <= $3
    `, [businessId, fromParam, toParam]),

    // ── Labor: fixed/global salary employees (independent of shifts) ─────────
    db.query(`
      SELECT COALESCE(SUM(salary_amount), 0)::float AS total_monthly_fixed,
             COUNT(*)::int AS fixed_emp_count
      FROM users
      WHERE business_id=$1 AND is_active=TRUE AND role != 'owner'
        AND salary_type NOT IN ('hourly', 'unknown', 'none')
        AND salary_amount IS NOT NULL AND salary_amount > 0
    `, [businessId]),

    // ── Reviews ───────────────────────────────────────────────────────────────
    db.query(`
      SELECT COALESCE(AVG(rating),0)::float AS avg_rating,
             COUNT(*)::int AS review_count
      FROM reviews
      WHERE business_id=$1
        AND DATE(created_at AT TIME ZONE 'Asia/Jerusalem') >= $2
        AND DATE(created_at AT TIME ZONE 'Asia/Jerusalem') <= $3
    `, [businessId, fromParam, toParam]).catch(() => ({ rows: [{ avg_rating: 0, review_count: 0 }] })),

    // ── Fixed expenses prorated — identical to _getMonthlyFixedExpenses × days/30
    // one_time: match against the report period (fromParam→toParam), not CURRENT_DATE —
    // otherwise a historical report would incorrectly include/exclude one-time expenses
    // based on today's date rather than the period being reported on.
    db.query(`
      SELECT COALESCE(SUM(
        CASE WHEN frequency='monthly'   THEN amount
             WHEN frequency='weekly'    THEN amount*(52.0/12)
             WHEN frequency='yearly'    THEN amount/12
             WHEN frequency='bimonthly' THEN amount/2
             WHEN frequency='one_time'
                  AND created_at::date BETWEEN $2 AND $3 THEN amount
             ELSE 0 END
      ),0)::float AS monthly_total
      FROM fixed_expenses
      WHERE business_id=$1 AND is_active=TRUE${expenseActiveBetween('$2', '$3')}
    `, [businessId, fromParam, toParam]),

    // ── Waste loss — identical to _getDayWaste ────────────────────────────────
    db.query(`
      SELECT COALESCE(SUM(ABS(it.qty_change) * COALESCE(ii.cost_per_unit,0)),0)::float AS waste_loss
      FROM inventory_transactions it
      JOIN inventory_items ii ON ii.id = it.item_id
      WHERE it.business_id=$1
        AND it.type='waste'
        AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') >= $2
        AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') <= $3
    `, [businessId, fromParam, toParam]).catch(() => ({ rows: [{ waste_loss: 0 }] })),

    // ── Z-Report summary (orders, avg per order, payment breakdown) ──────────
    // Payment columns (cash_amount etc.) are stored on import from the parsed Z-report Excel.
    // Older records imported before this column existed will have DEFAULT 0; re-importing them updates the values.
    db.query(`
      SELECT
        COUNT(*)::int                                          AS z_count,
        COALESCE(SUM(orders_count), 0)::int                   AS total_orders,
        COALESCE(AVG(NULLIF(avg_per_order, 0)), 0)::float     AS avg_per_order,
        COALESCE(SUM(cash_amount),    0)::float               AS total_cash,
        COALESCE(SUM(credit_amount),  0)::float               AS total_credit,
        COALESCE(SUM(wolt_amount),    0)::float               AS total_wolt,
        COALESCE(SUM(ten_bis_amount), 0)::float               AS total_ten_bis
      FROM sales s
      WHERE s.business_id=$1
        AND s.pos_sale_id LIKE 'Z-%'
        AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
        AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') <= $3
    `, [businessId, fromParam, toParam]).catch(() => ({ rows: [{ z_count: 0, total_orders: 0, avg_per_order: 0, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0 }] })),

    // ── עלות מזון תיאורטית — מה שהיה אמור להיצרך לפי המנות שנמכרו בפועל
    // בתקופה הזו (עלויות מתכון/מנה עדכניות, גם אם הדוח מוגש רטרואקטיבית)
    inventoryModel.getConsumptionAnalysis(businessId, fromParam, toParam)
      .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] })),
  ]);

  const cur   = salesCur.rows[0];
  const prev  = salesPrev.rows[0];
  const inv   = invoices.rows[0];
  const labor = laborData.rows[0];
  const fixed = fixedExp.rows[0];
  const waste = wasteLoss.rows[0];
  const zRep  = zReportData.rows[0] || { z_count: 0, total_orders: 0, avg_per_order: 0, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0 };
  const theo  = theoreticalConsumption || { itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] };

  // Prorated fixed expenses for the period (same logic as finance daily × daysNum)
  const fixedPeriod  = parseFloat(((fixed.monthly_total / 30) * daysNum).toFixed(2));
  // Hourly labor from shifts + global/fixed salary prorated for the period.
  // For weekly report (≤8 days): monthly salary ÷ 4 (4 weeks per month).
  // For longer periods: prorated by days/30.
  const hourlyLaborCost  = parseFloat((labor.hourly_labor_cost || 0).toFixed(2));
  const totalMonthlyFixed = parseFloat(fixedSalaryData.rows[0]?.total_monthly_fixed || 0);
  const fixedLaborForPeriod = daysNum <= 8
    ? parseFloat((totalMonthlyFixed / 4).toFixed(2))
    : parseFloat((totalMonthlyFixed * daysNum / 30).toFixed(2));
  const laborCost = parseFloat((hourlyLaborCost + fixedLaborForPeriod).toFixed(2));
  const wasteLossAmt = parseFloat((waste.waste_loss || 0).toFixed(2));

  // theo.totalConsumedValue only covers the slice of revenue that actually had
  // item-level detail (theo.itemDataCoveragePct) — most real Z-report imports
  // only carry a daily total, so that coverage is often well under 50%. Instead
  // of discarding real, known consumption data because the sample is partial,
  // extrapolate the food-cost ratio observed in the covered slice across the
  // period's full revenue — the same "blended estimate" principle already used
  // by the dashboard's food-cost tile (menuEngineering.agent.js getMonthlyFoodCost)
  // for exactly this situation.
  const coveredRevenue        = cur.revenue * (theo.itemDataCoveragePct / 100);
  const observedFoodCostRatio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : null;
  const theoValueForCalc      = observedFoodCostRatio !== null ? observedFoodCostRatio * cur.revenue : theo.totalConsumedValue;
  const isTheoExtrapolated    = observedFoodCostRatio !== null && theo.itemDataCoveragePct < 100;

  // Determine reliability of theoretical food cost before using it in profit calc.
  // If theoretical cost > 200% of revenue it signals a recipe configuration error
  // (unit mismatch in ingredient qty vs cost_per_unit), not a real business metric.
  // Coverage floor lowered to 15% (matching hasTheoConfigErr's existing floor) —
  // now that low-coverage periods are extrapolated rather than used raw, a small
  // real sample is still meaningfully better than no cost data at all.
  const theoPct          = cur.revenue > 0 ? (theoValueForCalc / cur.revenue) : 0;
  const hasReliableTheo  = theo.itemDataCoveragePct >= 15 && theo.items.length > 0 && theoPct <= 2.0;
  const hasTheoConfigErr = theo.itemDataCoveragePct >= 15 && theo.items.length > 0 && theoPct > 2.0;

  // COGS: prefer actual invoices; fall back to theoretical when reliable.
  // This avoids treating a business as "no cost data" just because they haven't
  // entered supplier invoices — recipe-based theoretical cost IS cost data.
  const cogsForCalc  = inv.invoice_count > 0 ? inv.cogs :
                       (hasReliableTheo    ? theoValueForCalc : 0);
  const grossProfit  = cur.revenue - cogsForCalc;
  // Net profit = revenue − COGS − fixed expenses − labor − waste  (matches getMonthlySummary)
  const netProfit    = grossProfit - fixedPeriod - laborCost - wasteLossAmt;

  // Track which data is genuinely available vs not entered by the user
  const dataAvailability = {
    hasInvoices:               inv.invoice_count > 0,
    hasTheoreticalFoodCost:    hasReliableTheo,
    hasTheoreticalConfigError: hasTheoConfigErr,
    // hasCostData = true when we have ANY reliable cost signal (invoices OR recipe-based)
    hasCostData:               inv.invoice_count > 0 || hasReliableTheo,
    hasLaborTracking:          labor.active_employees > 0 || labor.total_hours > 0 || fixedLaborForPeriod > 0,
    hasFixedExpenses:          fixed.monthly_total > 0,
    hasWasteTracking:          wasteLossAmt > 0,
    hasZReports:               zRep.z_count > 0,
    hasTopDishes:              topDishes.rows.length > 0,
    hasReviews:                reviews.rows[0]?.review_count > 0,
    // רוב יבואי דוחות ה-Z לא כוללים מספר הזמנות אמיתי (orders_count=0)
    hasReliableTransactionCount: cur.transactions > 0,
  };

  return {
    period: {
      current:  safeFrom ? `${fromParam} — ${toParam}` : 'שבוע נוכחי (7 ימים אחרונים)',
      previous: 'תקופה מקבילה קודמת',
      days:     daysNum,
    },
    sales: {
      revenue:            cur.revenue,
      transactions:       dataAvailability.hasReliableTransactionCount ? cur.transactions : null,
      avgTicket:          dataAvailability.hasReliableTransactionCount ? cur.avg_ticket   : null,
      revenueChange:      prev.revenue > 0
        ? ((cur.revenue - prev.revenue) / prev.revenue * 100).toFixed(1) : null,
      transactionsChange: (cur.transactions > 0 && prev.transactions > 0)
        ? ((cur.transactions - prev.transactions) / prev.transactions * 100).toFixed(1) : null,
      prevRevenue:        prev.revenue,
    },
    cogs: {
      total:        cogsForCalc,
      invoices:     inv.invoice_count,
      invoicesCogs: inv.cogs,
      grossProfit,
      grossMargin:  (cur.revenue > 0 && isFinite(grossProfit) && dataAvailability.hasCostData) ? ((grossProfit / cur.revenue) * 100).toFixed(1) : null,
      fixedExpenses: fixedPeriod,
      laborCost,
      wasteLoss:    wasteLossAmt,
      netProfit,
      netMargin:    (cur.revenue > 0 && isFinite(netProfit) && dataAvailability.hasCostData) ? ((netProfit / cur.revenue) * 100).toFixed(1) : null,
      theoretical: {
        value:              theoValueForCalc,
        pctOfRevenue:       (cur.revenue > 0) ? (theoPct * 100).toFixed(1) : '0',
        itemDataCoveragePct: theo.itemDataCoveragePct,
        isReliable:         hasReliableTheo,
        isConfigError:      hasTheoConfigErr,
        isExtrapolated:     isTheoExtrapolated,
        gapVsInvoices:      inv.invoice_count > 0 ? (inv.cogs - theoValueForCalc) : null,
      },
    },
    topDishes: topDishes.rows,
    inventory: inventory.rows[0],
    labor: {
      active_employees: labor.active_employees,
      total_hours:      labor.total_hours,
      missed_shifts:    labor.missed_shifts,
      labor_cost:       laborCost,
      // עובדים בשכר גלובלי/קבוע (לא רשומים במשמרות שעתיות בכלל — זה תקין
      // ומכוון, לא פער נתונים) — חשוב לחשוף בנפרד כדי שהניתוח (Claude) לא
      // "יתפוס" 0 עובדים/שעות + עלות שכר שאינה 0 כסתירה שדורשת בדיקה.
      fixed_salary_employees: fixedSalaryData.rows[0]?.fixed_emp_count || 0,
      fixed_salary_cost:      fixedLaborForPeriod,
    },
    reviews: reviews.rows[0],
    zReport: {
      count:        zRep.z_count,
      totalOrders:  zRep.total_orders,
      avgPerOrder:  parseFloat((zRep.avg_per_order || 0).toFixed(2)),
      cash:         parseFloat((zRep.total_cash  || 0).toFixed(2)),
      credit:       parseFloat((zRep.total_credit || 0).toFixed(2)),
      wolt:         parseFloat((zRep.total_wolt   || 0).toFixed(2)),
      tenBis:       parseFloat((zRep.total_ten_bis || 0).toFixed(2)),
    },
    dataAvailability,
  };
}

// ── Agent 1: Data Analyst ────────────────────────────────────────────────────
async function runDataAnalyst(data) {
  const fmt = n => new Intl.NumberFormat('he-IL', { style:'currency', currency:'ILS', maximumFractionDigits:0 }).format(n);

  const da = data.dataAvailability || {};
  // "missing" = data that wasn't entered AND can't be substituted by another source.
  // Do NOT list invoices as missing when we already have reliable theoretical food cost.
  const missingNote = [
    !da.hasCostData                                          && 'חשבוניות ספקים או עלויות מתכון — לא ניתן לחשב עלות סחורה',
    !da.hasLaborTracking                                     && 'מעקב משמרות עובדים — עלות כוח אדם לא מחושבת',
    !da.hasFixedExpenses                                     && 'הוצאות קבועות (שכירות, חשמל, מים) — לא הוזנו',
    !da.hasWasteTracking                                     && 'רישום פסולת מלאי — לא נרשם',
  ].filter(Boolean);

  const prompt = `ניתח את הנתונים הבאים של התקופה **${data.period.current}** (${data.period.days} ימים):

${missingNote.length > 0 ? `⚠️ **נתונים חסרים (אל תנחש ואל תמציא מספרים עבורם):**
${missingNote.map(m => `- ${m}`).join('\n')}

` : ''}${da.hasTheoreticalConfigError ? `🚨 **שגיאת הגדרה בעלויות מתכון:**
עלות המזון התיאורטית (${fmt(data.cogs.theoretical.value)}) עומדת על ${data.cogs.theoretical.pctOfRevenue}% מההכנסות — מעל 200%, מה שמצביע על **שגיאת הגדרה** (למשל: כמות מרכיב במתכון הוזנה בגרמים אבל עלות היחידה היא לק"ג, או להיפך). **אל תנתח את הנתון הזה כנתון אמיתי** — יש להורות לבעל העסק לתקן את הכמויות במתכונים / עלויות הפריטים במלאי.

` : ''}**מכירות (נתונים ממשיים מדוחות Z ומקופה):**
- הכנסות: ${fmt(data.sales.revenue)} ${data.sales.revenueChange !== null ? `(${Number(data.sales.revenueChange) > 0 ? '+' : ''}${data.sales.revenueChange}% לעומת תקופה קודמת)` : '(אין השוואה לתקופה קודמת)'}
${data.sales.transactions !== null ? `- מספר עסקאות: ${data.sales.transactions}
- ממוצע לעסקה: ${fmt(data.sales.avgTicket)}` : '- מספר עסקאות / ממוצע לעסקה: לא זמין — דוחות ה-Z שהוזנו לתקופה זו לא כוללים מספר הזמנות (אל תמציא או תנחש מספר)'}
${da.hasZReports ? `- דוחות Z: ${data.zReport?.count || 0} ימים, ${data.zReport?.totalOrders || 0} הזמנות, ממוצע ${fmt(data.zReport?.avgPerOrder || 0)} להזמנה
- פירוק תשלומים: מזומן ${fmt(data.zReport?.cash || 0)}, אשראי ${fmt(data.zReport?.credit || 0)}, Wolt ${fmt(data.zReport?.wolt || 0)}, תן-ביס ${fmt(data.zReport?.tenBis || 0)}` : ''}

${da.hasCostData ? `**עלות סחורה:**
${da.hasInvoices ? `- מקור: ${data.cogs.invoices} חשבוניות ספק שהוזנו` : `- מקור: עלות מזון תיאורטית מחושבת ממתכונים (${data.cogs.theoretical.itemDataCoveragePct}% מהמכירות מגובות בפירוט מנות)`}
- עלות סחורה: ${fmt(data.cogs.total)}
- רווח גולמי: ${fmt(data.cogs.grossProfit)}${data.cogs.grossMargin !== null ? ` (${data.cogs.grossMargin}%)` : ''}
${!da.hasInvoices && da.hasTheoreticalFoodCost ? `- הערה: עלות תיאורטית מבוססת מתכון — אמינה לניתוח ונמוכה מ-200% הכנסות.${data.cogs.theoretical.isExtrapolated ? ` מבוסס על ${data.cogs.theoretical.itemDataCoveragePct}% מהמכירות שכללו פירוט מנות, והוקרן על שאר התקופה לפי אותו יחס.` : ''} להשוואה מדויקת עם רכישות בפועל, הזן חשבוניות ספק.` : ''}
${data.cogs.theoretical.gapVsInvoices !== null ? `- פער מול חשבוניות שנרכשו: ${fmt(data.cogs.theoretical.gapVsInvoices)} ${data.cogs.theoretical.gapVsInvoices > 0 ? '(נרכש יותר ממה שנצרך — ייתכן בזבוז/מלאי עודף)' : '(נצרך יותר ממה שנרכש — ייתכן שהמלאי נרכש בתקופה קודמת)'}` : ''}` : '**עלות סחורה: לא ניתן לחשב — אין חשבוניות ספק ואין עלויות מתכון**'}

${da.hasTheoreticalFoodCost && !da.hasInvoices ? '' : da.hasTheoreticalFoodCost ? `**עלות מזון תיאורטית לבקרה (${data.cogs.theoretical.itemDataCoveragePct}% כיסוי):**
- ערך: ${fmt(data.cogs.theoretical.value)} (${data.cogs.theoretical.pctOfRevenue}% מההכנסות)` : ''}

${da.hasLaborTracking ? `**כוח אדם:**
- עובדים בשעתי (רשומים במשמרות): ${data.labor.active_employees}, סה"כ ${Math.round(data.labor.total_hours)} שעות
- עובדים בשכר גלובלי/קבוע (לא רשומים במשמרות שעתיות — זה תקין, לא פער נתונים): ${data.labor.fixed_salary_employees}, עלות לתקופה ${fmt(data.labor.fixed_salary_cost)}
- עלות שכר כוללת: ${fmt(data.labor.labor_cost)}
- משמרות שהוחמצו: ${data.labor.missed_shifts}
חשוב: "0 עובדים שעתיים" ועלות שכר שאינה 0 יחד הם מצב תקין וצפוי כשכל הצוות בשכר גלובלי — אל תתאר את זה כ"סתירה" או "פער קריטי הדורש בדיקה".` : '**כוח אדם: לא הוזן מעקב משמרות**'}

${da.hasFixedExpenses ? `**הוצאות קבועות לתקופה: ${fmt(data.cogs.fixedExpenses)}**` : '**הוצאות קבועות: לא הוזנו**'}

${da.hasCostData && da.hasFixedExpenses && da.hasLaborTracking ? `**רווח נקי: ${fmt(data.cogs.netProfit)}${data.cogs.netMargin !== null ? ` (${data.cogs.netMargin}%)` : ''}**` : `**רווח נקי: לא ניתן לחשב במלואו — חסרים: ${[!da.hasCostData && 'עלות סחורה', !da.hasLaborTracking && 'שכר עובדים', !da.hasFixedExpenses && 'הוצאות קבועות'].filter(Boolean).join(', ')}**`}

${da.hasTopDishes ? `**מנות מובילות:**
${data.topDishes.map((d,i) => `${i+1}. ${d.name} — ${d.qty} מנות, ${fmt(d.revenue)}`).join('\n')}` : '**מנות מובילות: לא הוזנו מכירות פריטים**'}

**מלאי:**
- פריטים מתחת למינימום: ${data.inventory.low_stock}
- פריטים בסכנת תפוגה: ${data.inventory.expiring_soon}

${da.hasReviews ? `**ביקורות:**
- ממוצע דירוג: ${data.reviews.avg_rating.toFixed(1)}/5 (${data.reviews.review_count} ביקורות)` : ''}

**הוראות ניתוח — קריטי:**
- נתח רק נתונים שקיימים בפועל למעלה
- אל תנחש ואל תמציא מספרים לנתונים שסומנו כחסרים — גם לא בקירוב, גם לא "בערך"
- אם חסר נתון קריטי לניתוח, ציין זאת במפורש במקום להחליף אותו בהערכה
- זהה **עד** 3 ממצאים חיוביים ו**עד** 3 ממצאים שליליים/מדאיגים — רק כאלה שיש להם בסיס אמיתי וברור בנתונים למעלה
- אם התקופה שקטה/רגילה ואין מספיק ממצאים אמיתיים לצטט — ציין פחות מ-3 ממצאים. אל תמציא ממצא כדי להשלים למכסה
- בנוסף, ציין עד 2 המלצות לשיפור הזנת הנתונים החסרים (אם יש קטגוריות שסומנו כחסרות למעלה)`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    system: [{ type: 'text', text: 'אתה אנליסט עסקי לעסקי מסעדנות. זהה עד 3 ממצאים חיוביים ועד 3 ממצאים שליליים/מדאיגים — אך ורק אם יש להם תימוכין אמיתי בנתונים שסופקו. עדיף לדווח על פחות ממצאים אמיתיים מאשר להמציא ממצאים כדי להגיע למכסה. היה תמציתי וממוקד.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }, { retries: 2, context: { agent: 'weeklyReportCrew', step: 'dataAnalyst', period: data.period?.current } });
  logTokenUsage({ businessId: data.businessId, feature: 'weekly_report_analyst', model: 'claude-haiku-4-5', usage: msg.usage });
  return msg.content[0].text;
}

// ── Agent 2: Report Writer ───────────────────────────────────────────────────
async function runReportWriter(data, analysis) {
  const fmt = n => new Intl.NumberFormat('he-IL', { style:'currency', currency:'ILS', maximumFractionDigits:0 }).format(n);

  const da = data.dataAvailability || {};
  const prompt = `כתוב דוח מנהלים תמציתי בעברית (250-350 מילה) לבעל עסק מסעדנות.

**תקופת הדוח: ${data.period.current} (${data.period.days} ימים)**

**ניתוח שהתקבל:**
${analysis}

**נתוני מפתח (כתוב רק את מה שקיים):**
- הכנסות: ${fmt(data.sales.revenue)} ${data.sales.revenueChange !== null ? `(שינוי: ${Number(data.sales.revenueChange) > 0 ? '+' : ''}${data.sales.revenueChange}%)` : ''}
${da.hasZReports ? `- דוחות Z: ${data.zReport?.count} ימים, ${data.zReport?.totalOrders} הזמנות, ממוצע ${fmt(data.zReport?.avgPerOrder)} להזמנה` : ''}
${da.hasCostData && data.cogs.grossMargin !== null ? `- רווח גולמי: ${fmt(data.cogs.grossProfit)} (${data.cogs.grossMargin}%)${!da.hasInvoices ? ' [מחושב מעלויות מתכון]' : ''}` : ''}
${da.hasCostData && da.hasLaborTracking && da.hasFixedExpenses && data.cogs.netMargin !== null ? `- **רווח נקי: ${fmt(data.cogs.netProfit)} (${data.cogs.netMargin}%)**` : ''}
${da.hasTopDishes && data.topDishes[0] ? `- מנה מובילה: ${data.topDishes[0].name}` : ''}

**חשוב:**
- אל תציג נתוני רווחיות כשהם מבוססים על נתונים שלא הוזנו
- אם יש שגיאת הגדרה בעלויות מתכון (כפי שסומן בניתוח) — אל תציג את עלות המזון התיאורטית כנתון אמיתי, ציין שיש צורך לתקן את ההגדרות
- אם חסרים נתונים, ציין מה חסר ומה יאפשר ניתוח מלא יותר

הדוח יכלול: פסקת פתיחה עם תמצית התקופה (ציין את התאריכים המדויקים), המספרים האמיתיים, הישגים, ואתגרים. שפה עסקית, ברורה, בגוף שני לבעל העסק ("בתקופה זו עסקך...").`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    system: [{ type: 'text', text: 'אתה כותב דוחות מנהלים מקצועי למסעדות בישראל. שפה עסקית, ברורה, בגוף שני לבעל העסק ("בתקופה זו עסקך..."). כולל: פסקת פתיחה עם תמצית התקופה, מדדים מרכזיים כולל רווח נקי, הישגים, ואתגרים.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }, { retries: 2, context: { agent: 'weeklyReportCrew', step: 'reportWriter', period: data.period?.current } });
  logTokenUsage({ businessId: data.businessId, feature: 'weekly_report_writer', model: 'claude-haiku-4-5', usage: msg.usage });
  return msg.content[0].text;
}

// ── Agent 3: Strategic Advisor ───────────────────────────────────────────────
async function runStrategicAdvisor(data, analysis, report) {
  const da = data.dataAvailability || {};
  const hasNetProfit = da.hasCostData && da.hasFixedExpenses && da.hasLaborTracking;

  const prompt = `**דוח שנכתב:**
${report}

**ניתוח:**
${analysis}

**נתונים אמיתיים שקיימים במערכת (כל שורה שמסומנת "לא הוזן/לא ניתן לחשב" אינה מספר — אין לך שום ערך עבורה, גם לא בקירוב):**
- הכנסות: ₪${data.sales.revenue.toFixed(0)}
${da.hasCostData && data.cogs.grossMargin !== null ? `- רווח גולמי: ${data.cogs.grossMargin}% (יעד ישראלי: 65-70%)${!da.hasInvoices ? ' [מבוסס עלויות מתכון — לא חשבוניות ספק]' : ''}` : '- רווח גולמי: לא ניתן לחשב — אין עלויות סחורה זמינות'}
${da.hasFixedExpenses ? `- הוצאות קבועות לתקופה: ₪${data.cogs.fixedExpenses.toFixed(0)}` : '- הוצאות קבועות: לא הוזנו'}
${da.hasLaborTracking ? `- עלות שכר: ₪${data.cogs.laborCost.toFixed(0)}` : '- עלות שכר: לא הוזן מעקב משמרות'}
${da.hasWasteTracking ? `- בזבוז מלאי: ₪${data.cogs.wasteLoss.toFixed(0)}` : '- בזבוז מלאי: לא נרשם'}
${da.hasTheoreticalFoodCost ? `- עלות מזון תיאורטית (לפי מנות שנמכרו בפועל): ${data.cogs.theoretical.pctOfRevenue}% מההכנסות` : ''}
${da.hasTheoreticalConfigError ? `🚨 שגיאת הגדרה בעלויות מתכון — עלות תיאורטית ${data.cogs.theoretical.pctOfRevenue}% מההכנסות. אסור לנתח כנתון אמיתי. המלץ לבעל העסק לתקן כמויות/עלויות מרכיבים.` : ''}
${hasNetProfit && data.cogs.netMargin !== null ? `- **רווח נקי: ${data.cogs.netMargin}% (יעד ישראלי: 8-15%)**` : '- רווח נקי: לא ניתן לחשב — חסרים: ' + [!da.hasCostData && 'עלות סחורה', !da.hasLaborTracking && 'שכר', !da.hasFixedExpenses && 'הוצאות קבועות'].filter(Boolean).join(', ')}
- מלאי נמוך: ${data.inventory.low_stock} פריטים
- משמרות שהוחמצו: ${data.labor.missed_shifts}
${da.hasReviews ? `- דירוג ביקורות: ${data.reviews.avg_rating.toFixed(1)}/5` : ''}

**חשוב מאוד:** לכל שורה שמסומנת "לא הוזן"/"לא ניתן לחשב" — אסור לך להמליץ המלצה שמניחה ערך מספרי עבורה. אחת מ-3 ההמלצות חייבת להיות "הזן X כדי לאפשר ניתוח אמיתי" כשחסרים נתונים קריטיים.

החזר בדיוק בפורמט JSON:
{
  "actions": [
    { "priority": "high|medium", "title": "כותרת קצרה", "action": "פעולה קונקרטית מבוססת אך ורק על נתונים אמיתיים למעלה", "expectedImpact": "תוצאה צפויה" },
    { "priority": "...", "title": "...", "action": "...", "expectedImpact": "..." },
    { "priority": "...", "title": "...", "action": "...", "expectedImpact": "..." }
  ],
  "weekScore": 75,
  "weekScoreLabel": "טוב|בינוני|דורש שיפור|מעולה"
}`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    system: [{ type: 'text', text: 'אתה יועץ עסקי בכיר למסעדות בישראל — CFO + יועץ אסטרטגי + מנהל תפעול. תן בדיוק 3 המלצות אסטרטגיות לפעולה מיידית, מבוססות אך ורק על נתונים שסומנו בפרומפט כקיימים בפועל. אסור לך להניח, לנחש או להעריך ערך כספי לנתון שסומן כחסר — גם לא כקירוב סביר. אם רוב הנתונים הפיננסיים חסרים, לפחות אחת מ-3 ההמלצות חייבת להיות על השלמת הזנת הנתונים החסרים. כלל ריאליות: כל המלצה חייבת להיות ריאלית לעסק מסעדנות קטן-בינוני בישראל, מדויקת מתמטית, ניתנת ליישום תפעולי. בנצ\'מרק ישראלי (רלוונטי רק כשיש נתוני עלות סחורה אמיתיים): מרווח גולמי 65-70%, עלות מזון 28-35%, רווח נקי 8-15%. שדות action ו-expectedImpact חייבים להיות תמציתיים — משפט או שניים קצרים כל אחד, לא פסקה.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }, { retries: 2, context: { agent: 'weeklyReportCrew', step: 'strategicAdvisor', period: data.period?.current } });
  logTokenUsage({ businessId: data.businessId, feature: 'weekly_report_advisor', model: 'claude-haiku-4-5', usage: msg.usage });

  const parsed = parseClaudeJSON(msg, { agent: 'weeklyReportCrew', step: 'strategicAdvisor' });
  return parsed || { actions: [], weekScore: 50, weekScoreLabel: 'בינוני' };
}

// ── Main Crew Runner ─────────────────────────────────────────────────────────
async function runWeeklyReportCrew(businessId, dateFrom, dateTo) {
  // Validate with the exact same rule gatherWeekData uses below — otherwise a
  // value that's valid enough for `new Date()` but fails gatherWeekData's
  // stricter YYYY-MM-DD check would make this function label/save the report
  // under the caller's requested dates while the data underneath silently
  // came from gatherWeekData's own "last 7 days" fallback.
  const safeFrom = dateFrom && isValidDateStr(dateFrom) ? dateFrom : null;
  const safeTo   = dateTo   && isValidDateStr(dateTo)   ? dateTo   : null;

  const weekStart = safeFrom ? new Date(safeFrom) : (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();
  const weekEnd   = safeTo   ? new Date(safeTo)   : new Date();
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEndStr   = weekEnd.toISOString().split('T')[0];

  logger.info('[WeeklyReportCrew] Starting 4-agent pipeline', { businessId, dateFrom: safeFrom, dateTo: safeTo });

  // Step 1: gather data
  const data = await gatherWeekData(businessId, safeFrom, safeTo);
  data.businessId = businessId; // carried so each agent can log its AI token usage
  if (safeFrom && safeTo) {
    const _diff = (new Date(safeTo) - new Date(safeFrom)) / 86400000;
    // +1 matches gatherWeekData's daysNum so the AI prompt matches financial calculations
    const days = isNaN(_diff) ? 7 : Math.max(1, Math.round(_diff) + 1);
    data.period = {
      current:  `${safeFrom} — ${safeTo}`,
      previous: 'תקופה מקבילה קודמת',
      days,
    };
  }
  logger.info('[WeeklyReportCrew] Agent 1 (Data) done');

  // Step 2: analysis
  const analysis = await runDataAnalyst(data);
  logger.info('[WeeklyReportCrew] Agent 2 (Analyst) done');

  // Step 3: report
  const rawReport = await runReportWriter(data, analysis);
  logger.info('[WeeklyReportCrew] Agent 3 (Writer) done');

  const startFmt = weekStart.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const endFmt   = weekEnd.toLocaleDateString('he-IL',   { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateHeader = `📅 דוח זה מכסה את התקופה: ${startFmt} — ${endFmt} (${data.period.days} ימים)\n\n`;
  const reportBody = dateHeader + rawReport;

  // Step 4: advice
  const advice = await runStrategicAdvisor(data, analysis, reportBody);
  logger.info('[WeeklyReportCrew] Agent 4 (Advisor) done');

  logger.info('[WeeklyReportCrew] Saving to DB...', { weekStartStr, weekEndStr });
  // Atomic upsert (not SELECT-then-INSERT/UPDATE) — two concurrent runs for the
  // same (business_id, week_start) — e.g. a business with 2+ owner-role users,
  // or a double-click of "generate" — used to race the SELECT and both attempt
  // INSERT, so the loser threw an unhandled unique-constraint violation after
  // already paying for a full 4-agent AI run. ON CONFLICT lets Postgres
  // serialize the two writers instead.
  const { rows: [saved] } = await db.query(
    `INSERT INTO weekly_reports (business_id, week_start, week_end, analysis, report_body, advice, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, week_start) DO UPDATE
       SET week_end=$3, analysis=$4, report_body=$5, advice=$6, raw_data=$7, created_at=NOW()
     RETURNING id`,
    [businessId, weekStartStr, weekEndStr, analysis, reportBody, JSON.stringify(advice), JSON.stringify(data)]
  );
  const savedId = saved.id;

  logger.info('[WeeklyReportCrew] Saved to DB OK');
  return { id: savedId, data, analysis, reportBody, advice, weekStart: weekStartStr, weekEnd: weekEndStr };
}

// ── Get latest report ────────────────────────────────────────────────────────
async function getLatestReport(businessId) {
  // ORDER BY created_at (not week_start) — created_at is bumped on every save
  // (including UPDATEs to an existing week), so it reflects the report most
  // recently *generated*, regardless of which period it covers. Ordering by
  // week_start instead would surface whichever period happens to start
  // latest in the calendar, not the one the user just asked for — e.g. a
  // freshly generated "last month" report (earlier week_start) getting
  // masked by an older "this week" report (later week_start).
  const { rows } = await db.query(`
    SELECT * FROM weekly_reports
    WHERE business_id=$1
    ORDER BY created_at DESC LIMIT 1
  `, [businessId]);
  return rows[0] || null;
}

module.exports = { runWeeklyReportCrew, getLatestReport };
