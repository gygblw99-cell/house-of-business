/**
 * Dashboard Data Service
 * מספק את כל הנתונים למסך הדשבורד הראשי
 */

const db = require('../../utils/db');

// Indexes for the hottest dashboard queries — run once on startup
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inventory_biz_qty_ratio
  ON inventory_items (business_id, current_qty)
  WHERE min_qty > 0`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_biz_sold_at
  ON sales (business_id, sold_at DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_biz_status
  ON sales (business_id, status) WHERE status = 'open'`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id
  ON sale_items (sale_id)`);

// ── Z-report sync performance indexes ─────────────────────────
// pos_sale_id lookup — used in every duplicate check + Smart CTE
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_biz_pos_sale_id
  ON sales (business_id, pos_sale_id)`);
// Z-report shifts — employee sync + unmatched queries
db.migrate(`CREATE INDEX IF NOT EXISTS idx_zreport_shifts_biz_employee_id
  ON z_report_shifts (business_id, employee_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_zreport_shifts_biz_name_date
  ON z_report_shifts (business_id, report_date, employee_name)`);
// inventory by name — used in recipe→ingredient decrement
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inventory_items_biz_name_lower
  ON inventory_items (business_id, lower(name))`);
// users by name — employee matching on import
db.migrate(`CREATE INDEX IF NOT EXISTS idx_users_biz_fullname_lower
  ON users (business_id, lower(full_name))`);
// recipe_ingredients join — used in menu engineering + inventory decrement
db.migrate(`CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe_id
  ON recipe_ingredients (recipe_id)`);
// sales pos_sale_id LIKE 'Z-%' partial index — used in Smart CTE + Z intelligence
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_z_reports
  ON sales (business_id, sold_at DESC) WHERE pos_sale_id LIKE 'Z-%'`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_users_last_login
  ON users (last_login DESC) WHERE last_login IS NOT NULL`);

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

// ── ראשי — כל הדשבורד בקריאה אחת ───────────────────────────
async function getDashboardData(businessId) {
  const zIncludesDelivery = await _getZIncludesDeliveryFlag(businessId);
  const [
    todayRevenue,
    comparisonRevenue,
    ordersToday,
    sellers,
    lastOrders,
    weeklyChart,
    openTables,
    emergencyAlerts,
  ] = await Promise.all([
    getTodayRevenue(businessId, zIncludesDelivery),
    getComparisonRevenue(businessId, zIncludesDelivery),
    getOrdersToday(businessId),
    getTopAndWeakSellers(businessId),   // single query instead of two
    getLastOrders(businessId, 5),
    getWeeklyChart(businessId, 7, zIncludesDelivery),
    getOpenTables(businessId),
    getEmergencyAlerts(businessId),
  ]);

  const { topSellers, weakSellers } = sellers;

  // חישוב % שינוי
  const revenueChange  = _calcChange(todayRevenue.revenue,  comparisonRevenue.revenue);
  const profitChange   = _calcChange(todayRevenue.netProfit, comparisonRevenue.netProfit);

  return {
    todayRevenue:  { ...todayRevenue, revenueChange, profitChange },
    comparisonDate: comparisonRevenue.date,
    ordersToday,
    openTables,
    topSellers,
    weakSellers,
    lastOrders,
    weeklyChart,
    emergencyAlerts,
  };
}

// ── הכנסות היום ──────────────────────────────────────────────
async function getTodayRevenue(businessId, zIncludesDelivery = false) {
  // (NOW() AT TIME ZONE 'Asia/Jerusalem')::date, NOT CURRENT_DATE — CURRENT_DATE
  // uses the DB session's own timezone (UTC on this cluster), which is 2-3
  // hours behind Israel's calendar date. Between Israel midnight and the
  // matching UTC midnight, sold_at's Israel-date is already "today" but
  // CURRENT_DATE still reports "yesterday" — every late-night sale in that
  // window silently failed this WHERE clause and showed as ₪0 on the dashboard.
  const { rows } = await db.query(
    `WITH day_smart AS (
       SELECT s.*,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1
         AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') = (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
         AND NOT ($2 AND s.sale_type = 'delivery' AND s.delivery_platform IN ('wolt', 'tenbis'))
         -- 'cancelled' is only ever set on delivery rows (deliveries.routes.js
         -- PATCH /:id/status) — a cancelled delivery kept counting as revenue
         -- here (and in every other revenue query in this file) with nothing
         -- ever reversing it, permanently overstating today's revenue/profit.
         AND s.status IS DISTINCT FROM 'cancelled'
     ),
     ind_count AS (SELECT COUNT(*) AS c FROM day_smart WHERE is_ind),
     filtered AS (
       SELECT ds.* FROM day_smart ds, ind_count
       WHERE (ind_count.c > 0 AND ds.is_ind) OR ind_count.c = 0
     ),
     today_cogs AS (
       -- LEFT JOIN + COALESCE to manual_cost: a manual (item_id IS NULL)
       -- ingredient must still count toward COGS, not silently drop out.
       SELECT COALESCE(SUM(COALESCE(ii.cost_per_unit, ri.manual_cost, 0) * si.qty), 0) AS total_cogs
       FROM filtered f
       JOIN sale_items si ON si.sale_id = f.id
       JOIN recipes r ON r.id = si.recipe_id
       JOIN recipe_ingredients ri ON ri.recipe_id = r.id
       LEFT JOIN inventory_items ii ON ii.id = ri.item_id
     )
     SELECT
       COALESCE(SUM(f.total_amount), 0)::float AS revenue,
       -- שורת POS בודדת = הזמנה אחת; שורת Z-report = orders_count הזמנות
       -- (לא COUNT(f.id), אחרת יום עם דוח Z אחד נספר כ"הזמנה אחת")
       COALESCE(SUM(CASE WHEN f.is_ind THEN 1 ELSE COALESCE(f.orders_count,0) END),0)::int AS orders_count,
       COALESCE(SUM(f.total_amount), 0) - (SELECT total_cogs FROM today_cogs) AS net_profit
     FROM filtered f`,
    [businessId, zIncludesDelivery]
  );

  return {
    revenue:    rows[0].revenue,
    netProfit:  Math.max(0, rows[0].net_profit ?? 0),
    ordersCount: rows[0].orders_count,
  };
}

// ── הכנסות להשוואה (אתמול / יום מקביל בשבוע שעבר) ──────────
async function getComparisonRevenue(businessId, zIncludesDelivery = false) {
  // קודם ננסה אתמול
  const yesterday = await _revenueForDate(businessId, "(NOW() AT TIME ZONE 'Asia/Jerusalem')::date - 1", zIncludesDelivery);
  if (yesterday.revenue > 0) {
    return { ...yesterday, date: 'yesterday' };
  }

  // אם אתמול היה יום סגור — נשתמש ביום המקביל בשבוע שעבר
  const sameWeekday = await _revenueForDate(businessId, "(NOW() AT TIME ZONE 'Asia/Jerusalem')::date - 7", zIncludesDelivery);
  return { ...sameWeekday, date: 'same_weekday_last_week' };
}

async function _revenueForDate(businessId, dateExpr, zIncludesDelivery = false) {
  const { rows } = await db.query(
    `WITH day_smart AS (
       SELECT *, (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1
         AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = ${dateExpr}
         AND NOT ($2 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_count AS (SELECT COUNT(*) AS c FROM day_smart WHERE is_ind),
     filtered AS (
       SELECT ds.* FROM day_smart ds, ind_count
       WHERE (ind_count.c > 0 AND ds.is_ind) OR ind_count.c = 0
     ),
     day_cogs AS (
       SELECT COALESCE(SUM(COALESCE(ii.cost_per_unit, ri.manual_cost, 0) * si.qty), 0) AS total_cogs
       FROM filtered f
       JOIN sale_items si ON si.sale_id = f.id
       JOIN recipes r ON r.id = si.recipe_id
       JOIN recipe_ingredients ri ON ri.recipe_id = r.id
       LEFT JOIN inventory_items ii ON ii.id = ri.item_id
     )
     -- net_profit מחושב זהה ל-getTodayRevenue (הכנסה פחות COGS יומי) כדי
     -- שההשוואה בין היום הנוכחי ליום ההשוואה תהיה תואמת-סמנטיקה
     SELECT
       COALESCE(SUM(f.total_amount), 0)::float AS revenue,
       (COALESCE(SUM(f.total_amount), 0) - (SELECT total_cogs FROM day_cogs))::float AS net_profit
     FROM filtered f`,
    [businessId, zIncludesDelivery]
  );
  const r = rows[0] || { revenue: 0, net_profit: 0 };
  return { revenue: r.revenue, netProfit: Math.max(0, r.net_profit ?? 0) };
}

// ── הזמנות היום (מהקופה) ─────────────────────────────────────
// Same "smart" individual-rows-else-Z-report-fallback as getTodayRevenue —
// a day whose POS sync only produced a Z-report summary row (no itemized
// sales) used to always show total=0 here even though todayRevenue's own
// ordersCount correctly fell back to the Z row's orders_count.
async function getOrdersToday(businessId) {
  const { rows } = await db.query(
    `WITH day_smart AS (
       SELECT sale_type, orders_count,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1
         AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_count AS (SELECT COUNT(*) AS c FROM day_smart WHERE is_ind),
     filtered AS (
       SELECT ds.* FROM day_smart ds, ind_count
       WHERE (ind_count.c > 0 AND ds.is_ind) OR ind_count.c = 0
     )
     SELECT
       COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS total,
       COUNT(*) FILTER (WHERE is_ind AND sale_type = 'delivery')::int AS deliveries,
       COUNT(*) FILTER (WHERE is_ind AND sale_type = 'table')::int    AS tables,
       COUNT(*) FILTER (WHERE is_ind AND sale_type = 'takeaway')::int AS takeaway
     FROM filtered`,
    [businessId]
  );
  return rows[0];
}

// ── שולחנות פתוחים ───────────────────────────────────────────
async function getOpenTables(businessId) {
  const { rows } = await db.query(
    `SELECT
       table_number,
       SUM(total_amount)::float AS amount,
       MIN(sold_at)             AS opened_at,
       COUNT(*)::int            AS orders
     FROM sales
     WHERE business_id = $1
       AND sale_type   = 'table'
       AND status      = 'open'
       AND table_number IS NOT NULL
     GROUP BY table_number
     ORDER BY table_number ASC`,
    [businessId]
  );
  return { count: rows.length, tables: rows };
}

// ── Top 3 + Weak 3 במכירות — שאילתה אחת עם window functions ──
async function getTopAndWeakSellers(businessId) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT
         si.name,
         SUM(si.qty)::float         AS total_qty,
         SUM(si.total_price)::float AS total_revenue,
         ROW_NUMBER() OVER (ORDER BY SUM(si.qty) DESC) AS rank_top,
         ROW_NUMBER() OVER (ORDER BY SUM(si.qty) ASC)  AS rank_weak
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.sale_id
       WHERE s.business_id = $1
         AND (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%')
         AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') = (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
         AND s.status IS DISTINCT FROM 'cancelled'
       GROUP BY si.name
     )
     SELECT name, total_qty, total_revenue, rank_top, rank_weak
     FROM ranked
     WHERE rank_top <= 3 OR rank_weak <= 3`,
    [businessId]
  );

  return {
    topSellers:  rows.filter(r => r.rank_top  <= 3).sort((a, b) => a.rank_top  - b.rank_top),
    weakSellers: rows.filter(r => r.rank_weak <= 3).sort((a, b) => a.rank_weak - b.rank_weak),
  };
}

// ── 5 הזמנות אחרונות ─────────────────────────────────────────
async function getLastOrders(businessId, limit = 5) {
  const { rows } = await db.query(
    `SELECT
       s.id,
       s.sale_type,
       s.table_number,
       s.total_amount,
       s.sold_at,
       JSON_AGG(JSON_BUILD_OBJECT('name', si.name, 'qty', si.qty)) AS items
     FROM sales s
     INNER JOIN sale_items si ON si.sale_id = s.id
     WHERE s.business_id = $1
       AND (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%')
     GROUP BY s.id
     ORDER BY s.sold_at DESC
     LIMIT $2`,
    [businessId, limit]
  );
  return rows;
}

// ── גרף 7 ימים (ניתן להרחיב ל-30) ───────────────────────────
async function getWeeklyChart(businessId, days = 7, zIncludesDelivery = false) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1 AND sold_at >= NOW() - ($2 || ' days')::INTERVAL
         AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
         AND status IS DISTINCT FROM 'cancelled'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT
       sale_day                 AS date,
       SUM(total_amount)::float AS revenue,
       -- שורת POS בודדת = הזמנה אחת; שורת Z-report = orders_count הזמנות
       -- (לא COUNT(*), אחרת יום עם דוח Z אחד נספר כ"הזמנה אחת" בגרף)
       COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END),0)::int AS orders_count
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     GROUP BY sale_day
     ORDER BY sale_day ASC`,
    [businessId, days, zIncludesDelivery]
  );

  // ממוצע שבועי
  const avgRevenue = rows.length > 0
    ? rows.reduce((s, r) => s + r.revenue, 0) / rows.length
    : 0;

  return { days: rows, weeklyAvg: avgRevenue };
}

// ── התראות חירום (מלאי שנגמר / קריטי) ───────────────────────
async function getEmergencyAlerts(businessId) {
  const { rows } = await db.query(
    `SELECT name, current_qty, min_qty, unit
     FROM inventory_items
     WHERE business_id = $1
       AND current_qty <= min_qty
       AND min_qty > 0
     ORDER BY (current_qty / NULLIF(min_qty, 0)) ASC
     LIMIT 5`,
    [businessId]
  );
  return rows;
}

// ── עזר — חישוב % שינוי ──────────────────────────────────────
function _calcChange(current, previous) {
  if (!previous || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

module.exports = {
  getDashboardData,
  getTodayRevenue,
  getWeeklyChart,
  getLastOrders,
};
