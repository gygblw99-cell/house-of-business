/**
 * Audit Data Collector
 * אוסף את כל הנתונים הדרושים לביקורת עסקית מה-DB
 */

const db = require('../../utils/db');
const inventoryModel = require('../../models/inventory.model');
const { EXPENSE_ACTIVE_TODAY } = require('../../utils/expenseWindow');

// Ensure sold_at column exists (older DB schemas may not have it)
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);
db.migrate(`UPDATE sales SET sold_at = created_at WHERE sold_at IS NULL AND created_at IS NOT NULL`);

async function collectAuditData(businessId, { fromDate, toDate } = {}) {
  const fromDateStr = fromDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toDateStr   = toDate   || new Date().toISOString().slice(0, 10);
  // גבולות התאריך מחושבים לפי חצות שעון ישראל (לא UTC) — כדי שהתקופה
  // המבוקשת (לפי לוח שנה ישראלי) תכלול את כל 24 השעות שלה בשני הקצוות.
  // new Date('YYYY-MM-DD').toISOString() הישן פירש את המחרוזת כחצות UTC,
  // שזה בפועל 02:00-03:00 בבוקר בישראל — מפספס מכירות מתחילת היום ובולע
  // כמעט את כל היום האחרון של הטווח (עד השעה 03:00 בלבד במקום עד חצות)
  const { rows: [{ from_ts, to_ts }] } = await db.query(
    `SELECT
       ($1::timestamp AT TIME ZONE 'Asia/Jerusalem')              AS from_ts,
       (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')  AS to_ts`,
    [fromDateStr, toDateStr]
  );
  const from = from_ts.toISOString();
  const to   = to_ts.toISOString();

  // Inclusive day count for the audit window — computed here (not after the
  // Promise.all below) since _getLaborCost needs it to prorate the monthly
  // fixed/global salary total against whatever period was actually requested.
  const periodDays = Math.max(1, Math.round((new Date(toDateStr) - new Date(fromDateStr)) / 86400000) + 1);

  const [
    salesStats,
    topItems,
    weakItems,
    weakHours,
    inventoryWaste,
    lowInventory,
    deadStock,
    inventoryStats,
    shiftStats,
    expenseStats,
    avgOrderValue,
    bizMeta,
    theoreticalConsumption,
    invoiceCogs,
    laborCostData,
  ] = await Promise.all([
    _getSalesStats(businessId, from, to),
    _getTopItems(businessId, from, to),
    _getWeakItems(businessId, from, to),
    _getWeakHours(businessId, from, to),
    _getInventoryWaste(businessId, from, to),
    _getLowInventory(businessId),
    _getDeadStock(businessId),
    _getInventoryStats(businessId, from, to),
    _getShiftStats(businessId, from, to),
    _getExpenseStats(businessId),
    _getAvgOrderValue(businessId, from, to),
    _getBusinessMeta(businessId),
    // עלות מזון תיאורטית — מחושבת ממה שבאמת נמכר בטווח (dish/recipe
    // ingredients ועלויות עדכניות), במקום קירוב גס לפי שם פריט מכירה
    // מול שם פריט מלאי. מחושב חי כדי לשקף גם דוחות שהוזנו רטרואקטיבית.
    // משתמש ב-fromDateStr/toDateStr (תאריכי לוח-שנה ישראלי נקיים) ולא ב-
    // from/to (שהם כעת מופעים UTC אמיתיים לגבול היום בישראל, ולכן ה"תאריך"
    // הגולמי בהם עלול להיות יום אחד קודם ב-UTC ולהזיז את הטווח בטעות)
    inventoryModel.getConsumptionAnalysis(businessId, fromDateStr, toDateStr)
      .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] })),
    // עלות סחורה בפועל (מה שנרכש בפועל, לפי חשבוניות) — לחישוב הפער מול
    // מה שהיה אמור להיצרך תיאורטית לפי המנות שנמכרו
    _getInvoiceCogs(businessId, fromDateStr, toDateStr),
    // עלות שכר לתקופה — שעתי (משמרות בפועל) + גלובלי/קבוע (פרו-רטה) —
    // בעבר לא היה מחושב בכלל, וטבלת ההשוואה לענף הציגה "לפי נתונים" קבוע
    // במקום אחוז אמיתי מההכנסות.
    _getLaborCost(businessId, from, to, periodDays),
  ]);

  const salesRevenue = salesStats.reduce((sum, r) => sum + (Number(r.total_revenue) || 0), 0);
  // מציגים עלות מזון תיאורטית רק כשיש כיסוי סביר של פירוט מנות בתקופה —
  // אותו סף שקיפות ⟨itemDataCoveragePct⟩ שנקבע בדשבורד/ניתוח תפריט
  const hasReliableFoodCost = theoreticalConsumption.itemDataCoveragePct >= 50 && salesRevenue > 0;
  // מכנה = הכנסה ממכירות עם פירוט מנות בלבד (כמו הנדסת תפריט) — לא כלל ההכנסה.
  // אם נחלק ב-salesRevenue הכולל, רק חלק מהמכירות תורמות למונה (מנות עם מתכון)
  // וכל ההכנסה תורמת למכנה → אחוז מוטה כלפי מטה באופן חמור (2.1% במקום 19.4%).
  const foodCostDenominator = theoreticalConsumption.revenueWithItems > 0
    ? theoreticalConsumption.revenueWithItems
    : salesRevenue;
  const theoreticalFoodCostPct = hasReliableFoodCost
    ? Math.round((theoreticalConsumption.totalConsumedValue / foodCostDenominator) * 1000) / 10
    : null;
  // פער בין מה שנקנה בפועל (חשבוניות) למה שהיה אמור להיצרך תיאורטית לפי
  // המנות שנמכרו — פער חיובי גדול עשוי להצביע על בזבוז/גניבה/מתכונים
  // לא מדויקים. מוצג רק כששני הצדדים אמינים (יש חשבוניות וגם כיסוי מנות).
  const hasCogsGap = hasReliableFoodCost && invoiceCogs.invoiceCount > 0;
  const cogsGapVsTheoretical = hasCogsGap
    ? Math.round((invoiceCogs.total - theoreticalConsumption.totalConsumedValue) * 100) / 100
    : null;

  const laborCostPct = (salesRevenue > 0 && laborCostData.hasData)
    ? Math.round((laborCostData.laborCost / salesRevenue) * 1000) / 10
    : null;

  return {
    salesStats,
    topItems,
    weakItems,
    weakHours,
    inventoryWaste,
    lowInventory,
    deadStock,
    inventoryStats,
    shiftStats,
    expenseStats,
    avgOrderValue,
    fromDateStr,
    toDateStr,
    periodDays,
    businessType:     bizMeta.business_type,
    menuFoodCostPct:  theoreticalFoodCostPct,
    itemDataCoveragePct: theoreticalConsumption.itemDataCoveragePct,
    totalZDays:       bizMeta.total_z_days,
    theoreticalFoodCostValue: hasReliableFoodCost ? theoreticalConsumption.totalConsumedValue : null,
    invoiceCogs:      invoiceCogs.total,
    hasInvoiceCogs:   invoiceCogs.invoiceCount > 0,
    cogsGapVsTheoretical, // חיובי = נרכש יותר משנצרך תיאורטית; שלילי = ההפך
    laborCostPct,     // % מההכנסות, null כשאין נתוני שכר בתקופה
  };
}

// ── עלות סחורה בפועל מחשבוניות ספק, בטווח התאריכים ─────────────
async function _getInvoiceCogs(businessId, fromDateStr, toDateStr) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float AS total, COUNT(*)::int AS invoice_count
     FROM invoices
     WHERE business_id = $1 AND invoice_date >= $2 AND invoice_date <= $3`,
    [businessId, fromDateStr, toDateStr]
  );
  return { total: rows[0].total, invoiceCount: rows[0].invoice_count };
}

// ── עלות שכר לתקופה — שעתי (משמרות בפועל) + גלובלי/קבוע (פרו-רטה) ────
// אותו דפוס בדיוק כמו weeklyReportCrew.agent.js/weeklyReport.scheduler.js.
async function _getLaborCost(businessId, from, to, periodDays) {
  const [hourlyRes, fixedRes] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS shift_count,
         COALESCE(SUM(
           CASE WHEN u.salary_type = 'hourly'
                THEN EXTRACT(EPOCH FROM (COALESCE(sh.actual_end, NOW()) - sh.actual_start))/3600
                     * COALESCE(u.salary_amount, 0)
                ELSE 0 END
         ), 0)::float AS hourly_labor_cost
       FROM shifts sh
       LEFT JOIN users u ON u.id = sh.employee_id
       WHERE sh.business_id = $1 AND sh.actual_start >= $2 AND sh.actual_start <= $3`,
      [businessId, from, to]
    ),
    db.query(
      `SELECT COALESCE(SUM(salary_amount), 0)::float AS total_monthly_fixed, COUNT(*)::int AS fixed_emp_count
       FROM users
       WHERE business_id = $1 AND is_active = TRUE AND role != 'owner'
         AND salary_type NOT IN ('hourly', 'unknown', 'none')
         AND salary_amount IS NOT NULL AND salary_amount > 0`,
      [businessId]
    ).catch(() => ({ rows: [{ total_monthly_fixed: 0, fixed_emp_count: 0 }] })),
  ]);

  const shiftCount    = hourlyRes.rows[0]?.shift_count || 0;
  const hourlyCost    = hourlyRes.rows[0]?.hourly_labor_cost || 0;
  const fixedEmpCount = fixedRes.rows[0]?.fixed_emp_count || 0;
  const fixedMonthly  = fixedRes.rows[0]?.total_monthly_fixed || 0;
  const fixedProrated = fixedMonthly * (periodDays / 30);

  return {
    laborCost: hourlyCost + fixedProrated,
    hasData:   shiftCount > 0 || fixedEmpCount > 0,
  };
}

// ── מכירות — טווח תאריכים (smart: Z-report counts on Z-only days) ───────
async function _getSalesStats(businessId, from, to) {
  const { rows: [zFlagRow] } = await db.query(
    `SELECT z_report_includes_delivery_platforms AS flag FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [{ flag: false }] }));
  const zIncludesDelivery = !!zFlagRow?.flag;

  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1 AND sold_at >= $2 AND sold_at <= $3
         AND NOT ($4 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered AS (
       SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       COUNT(*)::int                               AS total_sales,
       COALESCE(SUM(total_amount), 0)::float       AS total_revenue,
       COALESCE(AVG(total_amount), 0)::float       AS avg_sale_value,
       sale_day                                    AS sale_date,
       SUM(total_amount) OVER (PARTITION BY sale_day)::float AS daily_revenue
     FROM filtered
     GROUP BY sale_day, total_amount, sold_at
     ORDER BY sale_day DESC`,
    [businessId, from, to, zIncludesDelivery]
  );
  return rows;
}

// ── 10 מנות הכי נמכרות ───────────────────────────────────────
async function _getTopItems(businessId, from, to) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT s.id,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1 AND s.sold_at >= $2 AND s.sold_at <= $3
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     valid_ids AS (
       SELECT id FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       si.name,
       SUM(si.qty)::float         AS total_qty,
       SUM(si.total_price)::float AS total_revenue,
       r.selling_price
     FROM sale_items si
     LEFT JOIN recipes r ON r.id = si.recipe_id
     WHERE si.sale_id IN (SELECT id FROM valid_ids)
     GROUP BY si.name, r.selling_price
     ORDER BY total_qty DESC
     LIMIT 10`,
    [businessId, from, to]
  );
  return rows;
}

// ── 10 מנות הכי חלשות בטווח — לא נמכרו 7+ ימים ────────────────
// last_sold_at חייב לבוא מ-sales.sold_at (לא רק "כמות נמוכה בטווח כולו") —
// אחרת מנה שנמכרה אתמול אבל מעט פעמים נספרת כ"חלשה" באותה מידה כמו מנה
// שלא נמכרה כלל מזה חודש, ואין דרך להציג "כמה ימים בלי מכירה" כמו שהפרומפט
// ב-businessAudit.agent.js תמיד התיימר לעשות (בעבר: undefined).
async function _getWeakItems(businessId, from, to) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT s.id,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1 AND s.sold_at >= $2 AND s.sold_at <= $3
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     valid_ids AS (
       SELECT id FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       COALESCE(r.name, si.name) AS name,
       COUNT(si.id)::int AS times_sold,
       COALESCE(SUM(si.qty), 0)::float AS total_qty,
       MAX(s.sold_at) AS last_sold_at
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     LEFT JOIN recipes r ON r.id = si.recipe_id
     WHERE si.sale_id IN (SELECT id FROM valid_ids)
       -- רק פריטים שעדיין קיימים בתפריט בפועל — היסטוריית מכירות של מנה
       -- שנמחקה עדיין נספרת בדוחות אחרים, אבל "שקול להסיר" חייב להתייחס
       -- למה שקיים היום, אחרת ההמלצה תמיד תצביע על מנה שכבר לא בתפריט.
       -- כשיש מנה תואמת בשם, הסטטוס שלה קובע; אם אין מנה תואמת בכלל
       -- (recipe עצמאי), הסטטוס של ה-recipe עצמו קובע.
       AND (
         EXISTS (
           SELECT 1 FROM dishes d2 WHERE d2.business_id = $1
             AND LOWER(d2.name) = LOWER(COALESCE(r.name, si.name))
             AND COALESCE(d2.is_active, TRUE)
         )
         OR (
           NOT EXISTS (
             SELECT 1 FROM dishes d2 WHERE d2.business_id = $1
               AND LOWER(d2.name) = LOWER(COALESCE(r.name, si.name))
           )
           AND COALESCE(r.is_active, TRUE)
         )
       )
     GROUP BY COALESCE(r.name, si.name)
     HAVING MAX(s.sold_at) <= NOW() - INTERVAL '7 days'
     ORDER BY MAX(s.sold_at) ASC
     LIMIT 10`,
    [businessId, from, to]
  );
  return rows;
}

// ── שעות חלשות ─────────────────────────────────────────────
async function _getWeakHours(businessId, from, to) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= $2 AND sold_at <= $3
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)),
     hourly AS (
       SELECT
         EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
         AVG(total_amount)::float AS avg_revenue
       FROM filtered
       GROUP BY hour
     ),
     overall AS (SELECT AVG(avg_revenue) AS overall_avg FROM hourly)
     SELECT h.hour, h.avg_revenue,
            ROUND(((o.overall_avg - h.avg_revenue) / NULLIF(o.overall_avg,0)) * 100)::int AS drop_pct
     FROM hourly h, overall o
     WHERE h.avg_revenue < o.overall_avg * 0.5
     ORDER BY h.avg_revenue ASC`,
    [businessId, from, to]
  );
  return rows;
}

// ── מלאי שדווח כנזרק ───────────────────────────────────────
async function _getInventoryWaste(businessId, from, to) {
  const { rows } = await db.query(
    `SELECT
       ii.name,
       ABS(SUM(it.qty_change))::float AS wasted_qty,
       ii.unit,
       (ABS(SUM(it.qty_change)) * COALESCE(ii.cost_per_unit, 0))::float AS estimated_loss
     FROM inventory_transactions it
     INNER JOIN inventory_items ii ON ii.id = it.item_id
     WHERE it.business_id = $1
       AND it.type = 'waste'
       AND it.created_at >= $2 AND it.created_at <= $3
     GROUP BY ii.id, ii.name, ii.unit, ii.cost_per_unit
     ORDER BY estimated_loss DESC NULLS LAST`,
    [businessId, from, to]
  );
  return rows;
}

// ── פריטי מלאי מתחת לסף ─────────────────────────────────────
async function _getLowInventory(businessId) {
  const { rows } = await db.query(
    `SELECT name, current_qty, min_qty, unit
     FROM inventory_items
     WHERE business_id = $1
       AND min_qty > 0
       AND current_qty <= min_qty
     ORDER BY (current_qty / NULLIF(min_qty, 0)) ASC`,
    [businessId]
  );
  return rows;
}

// ── מלאי מת — פריטים עם כמות > 0 ללא שום תנועה ב-30 יום ───────
async function _getDeadStock(businessId) {
  const { rows } = await db.query(
    `SELECT
       ii.name,
       ii.current_qty::float,
       ii.unit,
       COALESCE(ii.cost_per_unit, 0)::float              AS cost_per_unit,
       (ii.current_qty * COALESCE(ii.cost_per_unit, 0))::float AS estimated_value,
       MAX(it.created_at)                                AS last_movement
     FROM inventory_items ii
     LEFT JOIN inventory_transactions it ON it.item_id = ii.id
     WHERE ii.business_id = $1
       AND ii.current_qty > 0
     GROUP BY ii.id, ii.name, ii.current_qty, ii.unit, ii.cost_per_unit
     HAVING MAX(it.created_at) IS NULL
         OR MAX(it.created_at) < NOW() - INTERVAL '30 days'
     ORDER BY estimated_value DESC
     LIMIT 15`,
    [businessId]
  );
  return rows;
}

// ── סטטיסטיקות מלאי כוללות — ערך, פעילות, מעקב בזבוז ──────────
async function _getInventoryStats(businessId, from, to) {
  const { rows } = await db.query(
    `SELECT
       COUNT(ii.id)::int                                              AS total_items,
       COUNT(CASE WHEN ii.current_qty > 0 THEN 1 END)::int           AS items_with_stock,
       COALESCE(SUM(ii.current_qty * COALESCE(ii.cost_per_unit, 0)), 0)::float AS total_stock_value,
       COUNT(DISTINCT act.item_id)::int                              AS active_items_30d,
       COUNT(wst.id)::int                                            AS waste_entries_30d
     FROM inventory_items ii
     LEFT JOIN inventory_transactions act
            ON act.item_id = ii.id
           AND act.business_id = $1
           AND act.created_at >= $2 AND act.created_at <= $3
     LEFT JOIN inventory_transactions wst
            ON wst.item_id = ii.id
           AND wst.business_id = $1
           AND wst.type = 'waste'
           AND wst.created_at >= $2 AND wst.created_at <= $3
     WHERE ii.business_id = $1`,
    [businessId, from, to]
  );
  return rows[0] ?? {
    total_items: 0, items_with_stock: 0, total_stock_value: 0,
    active_items_30d: 0, waste_entries_30d: 0,
  };
}

// ── ממוצע שעות משמרת + חריגות + פרמטרי ניקוד עובדים ────────
async function _getShiftStats(businessId, from, to) {
  const [{ rows: [basic] }, { rows: [peak] }] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS total_shifts,
         ROUND(AVG(EXTRACT(EPOCH FROM (actual_end - actual_start))/3600)::numeric, 2)::float AS avg_shift_hours,
         COUNT(*) FILTER (WHERE status = 'absent')::int AS absent_count,
         COUNT(*) FILTER (WHERE absence_reason = 'sick')::int AS sick_count,
         COUNT(*) FILTER (WHERE status != 'absent' AND actual_end IS NOT NULL)::int AS completed_shifts,
         COUNT(*) FILTER (WHERE status != 'absent')::int AS non_absent_shifts
       FROM shifts
       WHERE business_id = $1
         AND actual_start >= $2 AND actual_start <= $3`,
      [businessId, from, to]
    ),
    // נוכחות בימי שיא — ימים שהכנסתם ב-75th percentile ומעלה
    db.query(
      `WITH daily_rev AS (
         SELECT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS day,
                SUM(total_amount) AS revenue
         FROM sales
         WHERE business_id = $1 AND sold_at >= $2 AND sold_at <= $3
         GROUP BY DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')
       ),
       threshold AS (
         SELECT PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY revenue) AS p75
         FROM daily_rev
       ),
       peak_days AS (
         SELECT day FROM daily_rev, threshold WHERE revenue >= p75
       )
       SELECT
         COUNT(s.id)::int AS peak_total_shifts,
         COUNT(s.id) FILTER (WHERE s.status = 'absent')::int AS peak_absent_shifts
       FROM peak_days pd
       JOIN shifts s ON DATE(s.actual_start AT TIME ZONE 'Asia/Jerusalem') = pd.day
         AND s.business_id = $1
         AND s.actual_start >= $2 AND s.actual_start <= $3`,
      [businessId, from, to]
    ).catch(() => ({ rows: [{ peak_total_shifts: 0, peak_absent_shifts: 0 }] })),
  ]);
  return { ...basic, ...peak };
}

// ── הוצאות קבועות חודשיות ────────────────────────────────────
async function _getExpenseStats(businessId) {
  const { rows } = await db.query(
    `SELECT
       SUM(CASE WHEN frequency = 'monthly'   THEN amount
                WHEN frequency = 'weekly'    THEN amount * (52.0/12)
                WHEN frequency = 'yearly'    THEN amount / 12
                WHEN frequency = 'bimonthly' THEN amount / 2
                ELSE 0 END)::float AS monthly_fixed_expenses,
       COUNT(*)::int AS expense_count
     FROM fixed_expenses
     WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}`,
    [businessId]
  );
  return rows[0];
}

// ── ממוצע הזמנה + ממוצע היסטורי (כל הזמן) ──────────────────────────────
// current_avg  = ממוצע התקופה הנבחרת
// baseline_avg = ממוצע היסטורי מכל הדוחות (כל הזמן) — הבסיס האמיתי להשוואה
// הציון מורכב מהתקרבות/התרחקות מהממוצע ההיסטורי האמיתי, לא מ-p75 של אותה תקופה.
async function _getAvgOrderValue(businessId, from, to) {
  const { rows } = await db.query(
    `WITH period_ind AS (
       SELECT total_amount AS order_value
       FROM sales
       WHERE business_id = $1
         AND sold_at >= $2 AND sold_at <= $3
         AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
         AND total_amount > 0
     ),
     period_z AS (
       SELECT avg_per_order AS order_value
       FROM sales
       WHERE business_id = $1
         AND sold_at >= $2 AND sold_at <= $3
         AND pos_sale_id LIKE 'Z-%'
         AND avg_per_order > 0
         AND NOT EXISTS (SELECT 1 FROM period_ind)
     ),
     period_combined AS (
       SELECT order_value FROM period_ind
       UNION ALL
       SELECT order_value FROM period_z
     ),
     -- ממוצע היסטורי מכל הזמן — הבסיס האמיתי
     hist_z AS (
       SELECT avg_per_order AS order_value
       FROM sales
       WHERE business_id = $1
         AND pos_sale_id LIKE 'Z-%'
         AND avg_per_order > 0
     ),
     hist_ind AS (
       SELECT total_amount AS order_value
       FROM sales
       WHERE business_id = $1
         AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
         AND total_amount > 0
     ),
     hist_combined AS (
       SELECT order_value FROM hist_ind
       UNION ALL
       SELECT order_value FROM hist_z WHERE NOT EXISTS (SELECT 1 FROM hist_ind)
     )
     SELECT
       COALESCE((SELECT AVG(order_value) FROM period_combined), 0)::float AS current_avg,
       COALESCE((SELECT AVG(order_value) FROM hist_combined),   0)::float AS baseline_avg
    `,
    [businessId, from, to]
  );
  return rows[0];
}

// ── בדיקה: האם יש מספיק נתונים (שבוע אחד מינימום) ───────────
async function hasEnoughData(businessId) {
  try {
    const { rows } = await db.query(
      `SELECT MIN(sold_at) AS first_sale FROM sales WHERE business_id = $1`,
      [businessId]
    );
    if (!rows[0]?.first_sale) return false;
    const daysSinceFirst = (Date.now() - new Date(rows[0].first_sale)) / (1000 * 60 * 60 * 24);
    return daysSinceFirst >= 7;
  } catch {
    return false;
  }
}

// ── מטא-נתוני עסק + Z-report data quality ──
// עלות המזון עצמה מחושבת בנפרד (getConsumptionAnalysis) לפי מנות/מתכונים
// שנמכרו בפועל — מדויק יותר מקירוב לפי שם פריט מכירה מול שם פריט מלאי.
async function _getBusinessMeta(businessId) {
  const [metaRows, zDaysRows] = await Promise.all([
    db.query(`SELECT business_type FROM businesses WHERE id = $1`, [businessId]),
    db.query(
      `SELECT COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))::int AS total_z_days
       FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
      [businessId]
    ),
  ]);
  return {
    ...(metaRows.rows[0] || { business_type: null }),
    total_z_days: zDaysRows.rows[0]?.total_z_days || 0,
  };
}

module.exports = { collectAuditData, hasEnoughData };
