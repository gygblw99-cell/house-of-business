/**
 * Profit Leak Detection Agent
 * בודק בזמן אמת איפה בעל העסק מפסיד כסף היום
 *
 * בודק 4 גורמים:
 * 1. ירידת מחיר מכירה למנה לעומת הבסיס ההיסטורי
 * 2. שעות חלשות (ירידה במכירות)
 * 3. מלאי שנזרק (דיווח ידני)
 * 4. מנות שנמכרות מתחת לעלות
 *
 * ── חשוב לגבי הסכומים ─────────────────────────────────────────
 * הפונקציה מחזירה שני סכומים נפרדים ולא סכום אחד מעורבב:
 *   totalLoss  — כסף שיצא מהעסק בפועל (סחורה שנזרקה, מרווח שלילי,
 *                ירידת מחיר על מה שנמכר)
 *   revenueGap — הכנסה שלא נכנסה (שעות חלשות). זו לא "הפסד" —
 *                לא שילמת עליה כלום, ולחבר אותה לעלות סחורה שנזרקה
 *                נותן מספר שלא מייצג שום גודל כלכלי אמיתי.
 */

const db = require('../utils/db');
const { INGREDIENT_COST_CTE, DISH_COST_BY_NAME_CTE, normName } = require('../utils/ingredientSource');

// Every "today" comparison below must use this, not bare CURRENT_DATE —
// CURRENT_DATE resolves in the DB session's own timezone (UTC on this
// cluster, per dashboard.data.js's fix for the identical bug), 2-3 hours
// behind Israel's calendar date. Between Israel midnight and the matching
// UTC midnight, sold_at's Israel-date is already "today" but CURRENT_DATE
// still reports "yesterday" — every late-night sale/waste entry in that
// window silently fell out of every leak check in this file.
const TODAY_IL_SQL = "(NOW() AT TIME ZONE 'Asia/Jerusalem')::date";

// Materiality floors. Without them a ₪0.01 rounding difference or a single
// quiet hour produced a "leak" card, and the list filled with noise that
// buried the one row that actually mattered.
const MIN_LEAK_ILS       = 5;    // ₪ — don't report a leak smaller than this
const MIN_PRICE_DROP_PCT = 3;    // % — below this, a price diff is rounding/promo noise
const MIN_HOUR_BASELINE  = 50;   // ₪ — an hour that never made real money isn't "weak"
const MAX_WEAK_HOURS     = 5;    // cap — a closed day used to emit ~15 rows

// Sales-scope dedup: on any day that has individual POS sales, the aggregated
// Z-report row for that same day is a DUPLICATE of them. profitLeak used to
// skip this dedup entirely (unlike ingredientLeakage, which always did it), so
// on a day where both existed every quantity and every ₪ figure was counted
// twice. $1 = businessId; the caller decides the day range.
function scopedSalesCTE(daysBack) {
  return `
    scoped_sales AS (
      SELECT s.id                                                   AS sale_id,
             DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem')          AS sale_day,
             (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
      FROM sales s
      WHERE s.business_id = $1
        AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') >= ${TODAY_IL_SQL} - ${daysBack}
    ),
    ind_days AS (SELECT DISTINCT sale_day FROM scoped_sales WHERE is_ind),
    deduped_sales AS (
      SELECT sale_id, sale_day
      FROM scoped_sales
      WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
    )`;
}

// תמיד מחשב בזמן אמת — שכבת ה-cache (וה-TTL) היא באחריות ה-route הקורא
// (dashboard.routes.js), כדי שלא יהיו שתי שכבות cache עצמאיות על אותו מפתח
async function detectProfitLeaks(businessId) {
  const [
    recipePriceDrops,
    weakHoursToday,
    wasteToday,
    belowCostSales,
  ] = await Promise.all([
    _getRecipePriceDrops(businessId),
    _getWeakHoursToday(businessId),
    _getWasteToday(businessId),
    _getBelowCostSales(businessId),
  ]);

  const leaks = [];

  // ── 1. ירידת מחיר מכירה למנה ────────────────────────────────
  // Compares the price actually charged today against the same weekday over the
  // previous 4 weeks. The old version compared against the single day exactly
  // 7 days ago: if that one day happened to be a promo (or the business was
  // closed) the "leak" was pure noise, and there was no minimum threshold at
  // all, so a ₪0.01 difference produced a card.
  for (const item of recipePriceDrops) {
    const loss = Math.abs(item.price_diff) * item.qty_today;
    if (loss < MIN_LEAK_ILS) continue;
    leaks.push({
      type:        'recipe_price_drop',
      bucket:      'loss',
      name:        item.name,
      description: `נמכר ב-₪${item.avg_price_today.toFixed(2)} — נמוך ב-₪${Math.abs(item.price_diff).toFixed(2)} `
                 + `(${Math.abs(item.drop_pct).toFixed(0)}%) מהממוצע ל${item.dow_label} ב-4 השבועות האחרונים`,
      loss,
    });
  }

  // ── 2. שעות חלשות ──────────────────────────────────────────
  // bucket = 'revenue_gap': this is revenue that didn't arrive, not money that
  // left. Folding it into totalLoss (as this agent used to) inflated the
  // headline number by the size of a slow afternoon.
  for (const hour of weakHoursToday) {
    leaks.push({
      type:        'weak_hour',
      bucket:      'revenue_gap',
      name:        hour.hour != null
        ? `שעות ${hour.hour}:00–${hour.hour + 1}:00`
        : 'יום חלש',
      description: hour.hour != null
        ? `ירידה של ${hour.drop_pct}% במכירות לעומת ממוצע (₪${Math.round(hour.actual_revenue)} מול ₪${Math.round(hour.expected_revenue)} צפוי)`
        : `מחזור יומי נמוך ב-${hour.drop_pct}% לעומת ממוצע לאותו יום בשבוע`,
      loss:        hour.expected_revenue - hour.actual_revenue,
    });
  }

  // ── 3. מלאי שנזרק היום ─────────────────────────────────────
  const totalWasteLoss = wasteToday.reduce((s, w) => s + (w.estimated_loss || 0), 0);
  if (totalWasteLoss > 0) {
    leaks.push({
      type:        'inventory_waste',
      bucket:      'loss',
      name:        'מלאי שנזרק',
      description: wasteToday.map(w => w.name).join(', '),
      loss:        totalWasteLoss,
    });
  }

  // ── 4. מכירה מתחת לעלות ────────────────────────────────────
  for (const item of belowCostSales) {
    if (item.loss < MIN_LEAK_ILS) continue;
    leaks.push({
      type:        'below_cost_sale',
      bucket:      'loss',
      name:        item.name,
      description: `נמכר ב-₪${item.selling_price.toFixed(2)} — עלות ₪${item.cost_price.toFixed(2)} (${item.qty_today} יח')`,
      loss:        item.loss,
    });
  }

  const round2 = n => Math.round(n * 100) / 100;
  const sumOf  = bucket => leaks.filter(l => l.bucket === bucket)
                                .reduce((s, l) => s + (l.loss || 0), 0);
  const sumOfType = type => leaks.filter(l => l.type === type)
                                 .reduce((s, l) => s + (l.loss || 0), 0);

  const totalLoss  = round2(sumOf('loss'));
  const revenueGap = round2(sumOf('revenue_gap'));

  return {
    totalLoss,
    revenueGap,
    breakdown: {
      waste:     round2(sumOfType('inventory_waste')),
      belowCost: round2(sumOfType('below_cost_sale')),
      priceDrop: round2(sumOfType('recipe_price_drop')),
    },
    leaks,
    hasLeaks: leaks.length > 0,
  };
}

// ── ירידת מחיר מכירה לעומת בסיס 4 שבועות לאותו יום בשבוע ────
async function _getRecipePriceDrops(businessId) {
  const { rows } = await db.query(
    `WITH ${scopedSalesCTE(28)},
     today_sales AS (
       SELECT si.recipe_id, si.name,
              SUM(si.qty)::float        AS qty_today,
              AVG(si.unit_price)::float AS avg_price_today
       FROM sale_items si
       JOIN deduped_sales d ON d.sale_id = si.sale_id
       WHERE d.sale_day = ${TODAY_IL_SQL}
         AND si.recipe_id IS NOT NULL
         AND si.unit_price > 0
       GROUP BY si.recipe_id, si.name
     ),
     -- Baseline: the same weekday across the previous 4 weeks, so a single
     -- promo day (or a closed day) can't define "normal". Requires at least
     -- 2 such days to exist before it's trusted as a baseline at all.
     baseline AS (
       SELECT si.recipe_id,
              AVG(si.unit_price)::float    AS avg_price_base,
              COUNT(DISTINCT d.sale_day)::int AS base_days
       FROM sale_items si
       JOIN deduped_sales d ON d.sale_id = si.sale_id
       WHERE d.sale_day < ${TODAY_IL_SQL}
         AND EXTRACT(DOW FROM d.sale_day) = EXTRACT(DOW FROM ${TODAY_IL_SQL})
         AND si.recipe_id IS NOT NULL
         AND si.unit_price > 0
       GROUP BY si.recipe_id
     )
     SELECT
       t.name,
       t.qty_today,
       t.avg_price_today,
       b.avg_price_base,
       (t.avg_price_today - b.avg_price_base)::float                       AS price_diff,
       ((t.avg_price_today - b.avg_price_base) / b.avg_price_base * 100)::float AS drop_pct
     FROM today_sales t
     JOIN baseline b ON b.recipe_id = t.recipe_id
     WHERE b.base_days >= 2
       AND b.avg_price_base > 0
       AND t.avg_price_today < b.avg_price_base
       AND ((b.avg_price_base - t.avg_price_today) / b.avg_price_base * 100) >= $2`,
    [businessId, MIN_PRICE_DROP_PCT]
  );
  return rows.map(r => ({ ...r, dow_label: _hebrewDow() }));
}

const DOW_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function _hebrewDow() {
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return `ימי ${DOW_HE[il.getDay()]}`;
}

// ── שעות חלשות היום לעומת ממוצע היסטורי ────────────────────
// Primary: hourly comparison from individual POS sales.
// Fallback: if no individual POS data exists (Z-report-only business), compare
// today's closed Z-report total against the historical DOW average.
async function _getWeakHoursToday(businessId) {
  // Closed-day guard. The hourly query below compares each historical hour
  // against today's takings for that hour, so on a day the business simply
  // isn't open (or before the first sale lands) EVERY hour reads as a 100%
  // drop and the agent emitted ~15 rows summing to a full day's turnover as
  // if it were a loss. If nothing at all sold today there is no weak *hour* —
  // there's a closed day, which is not this check's job to report.
  const { rows: [today] } = await db.query(
    `SELECT COALESCE(SUM(total_amount), 0)::float AS revenue
     FROM sales
     WHERE business_id = $1
       AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = ${TODAY_IL_SQL}`,
    [businessId]
  );
  if (!today || today.revenue <= 0) return [];

  const { rows } = await db.query(
    `WITH historical_avg AS (
       SELECT hour, AVG(daily_total)::float AS avg_revenue
       FROM (
         SELECT
           DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d,
           EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
           SUM(total_amount) AS daily_total
         FROM sales
         WHERE business_id = $1
           AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
           AND sold_at >= NOW() - INTERVAL '30 days'
           AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') != ${TODAY_IL_SQL}
         GROUP BY d, hour
       ) sub
       GROUP BY hour
     ),
     today_by_hour AS (
       SELECT
         EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
         SUM(total_amount)::float AS actual_revenue
       FROM sales
       WHERE business_id = $1
         AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
         AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = ${TODAY_IL_SQL}
       GROUP BY hour
     )
     SELECT
       h.hour,
       h.avg_revenue                                        AS expected_revenue,
       COALESCE(t.actual_revenue, 0)                       AS actual_revenue,
       ROUND(((h.avg_revenue - COALESCE(t.actual_revenue, 0))
         / NULLIF(h.avg_revenue, 0)) * 100)::int           AS drop_pct
     FROM historical_avg h
     LEFT JOIN today_by_hour t ON t.hour = h.hour
     WHERE COALESCE(t.actual_revenue, 0) < h.avg_revenue * 0.7
       AND h.avg_revenue >= $2
       AND (h.avg_revenue - COALESCE(t.actual_revenue, 0)) >= $3
       AND h.hour < EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Jerusalem')
     ORDER BY (h.avg_revenue - COALESCE(t.actual_revenue, 0)) DESC
     LIMIT ${MAX_WEAK_HOURS}`,
    [businessId, MIN_HOUR_BASELINE, MIN_LEAK_ILS]
  );

  if (rows.length > 0) return rows;

  // Z-report fallback: day-of-week comparison when no individual POS data available.
  // Only fires when today's Z-report has already been imported (today_revenue IS NOT NULL).
  const { rows: zRows } = await db.query(
    `WITH today_z AS (
       SELECT SUM(total_amount)::float AS today_revenue
       FROM sales
       WHERE business_id = $1
         AND pos_sale_id LIKE 'Z-%'
         AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = ${TODAY_IL_SQL}
     ),
     historical_z AS (
       SELECT AVG(daily_rev)::float AS avg_revenue
       FROM (
         SELECT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d,
                SUM(total_amount)::float                    AS daily_rev
         FROM sales
         WHERE business_id = $1
           AND pos_sale_id LIKE 'Z-%'
           AND sold_at >= NOW() - INTERVAL '90 days'
           AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') < ${TODAY_IL_SQL}
           AND EXTRACT(DOW FROM sold_at AT TIME ZONE 'Asia/Jerusalem') =
               EXTRACT(DOW FROM NOW() AT TIME ZONE 'Asia/Jerusalem')
         GROUP BY d
       ) q
     )
     SELECT
       NULL::int                                                    AS hour,
       h.avg_revenue                                                AS expected_revenue,
       COALESCE(t.today_revenue, 0)                                 AS actual_revenue,
       ROUND(((h.avg_revenue - COALESCE(t.today_revenue, 0))
         / NULLIF(h.avg_revenue, 0)) * 100)::int                   AS drop_pct
     FROM historical_z h, today_z t
     WHERE h.avg_revenue > 0
       AND t.today_revenue IS NOT NULL
       AND COALESCE(t.today_revenue, 0) < h.avg_revenue * 0.7
       AND (h.avg_revenue - COALESCE(t.today_revenue, 0)) >= $2`,
    [businessId, MIN_LEAK_ILS]
  );
  return zRows;
}

// ── בזבוז מלאי שדווח היום ───────────────────────────────────
async function _getWasteToday(businessId) {
  const { rows } = await db.query(
    `SELECT
       ii.name,
       ABS(SUM(it.qty_change))::float                     AS wasted_qty,
       ii.unit,
       (ABS(SUM(it.qty_change)) * ii.cost_per_unit)::float AS estimated_loss
     FROM inventory_transactions it
     INNER JOIN inventory_items ii ON ii.id = it.item_id
     WHERE it.business_id = $1
       AND it.type = 'waste'
       AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') = ${TODAY_IL_SQL}
     GROUP BY ii.id, ii.name, ii.unit, ii.cost_per_unit`,
    [businessId]
  );
  return rows;
}

// ── מכירות מתחת לעלות היום ───────────────────────────────────
// Two fixes over the previous version:
//
// 1. Cost source. This used to prefer recipe_ingredients and fall back to a
//    same-name dish only when the recipe had NO ingredient rows. A recipe whose
//    rows are a stale partial copy (all item_id IS NULL) therefore won over a
//    fully-linked dish — "כריך אסאדו" was costed at ₪4.78 instead of its real
//    ₪18.03. Cost resolution now lives in utils/ingredientSource.js, which picks
//    whichever list is more completely linked to inventory.
//
// 2. Price. This used to compare against recipes.selling_price — the MENU price,
//    not what was actually charged. A discount or a mis-keyed price that sold
//    below cost was invisible, while a permanently mispriced menu item
//    re-reported its full "loss" every single day as if it were a fresh event.
//    It now uses si.unit_price, the price the customer actually paid.
async function _getBelowCostSales(businessId) {
  const { rows } = await db.query(
    `WITH ${INGREDIENT_COST_CTE},
     ${DISH_COST_BY_NAME_CTE},
     ${scopedSalesCTE(0)},
     sold_today AS (
       SELECT si.recipe_id, si.name, si.qty::float AS qty, si.unit_price::float AS unit_price
       FROM sale_items si
       JOIN deduped_sales d ON d.sale_id = si.sale_id
       WHERE d.sale_day = ${TODAY_IL_SQL}
         AND si.unit_price > 0
     ),
     priced AS (
       SELECT
         st.name,
         st.qty,
         st.unit_price,
         COALESCE(rcs.cost_price, dcbn.cost_price, 0)::float AS cost_price
       FROM sold_today st
       LEFT JOIN recipe_cost_source rcs ON rcs.recipe_id = st.recipe_id
       LEFT JOIN dish_cost_by_name dcbn ON dcbn.dname    = ${normName('st.name')}
     )
     SELECT
       name,
       cost_price,
       AVG(unit_price)::float                        AS selling_price,
       SUM(qty)::float                               AS qty_today,
       SUM((cost_price - unit_price) * qty)::float   AS loss
     FROM priced
     WHERE cost_price > 0
       AND unit_price < cost_price
     GROUP BY name, cost_price
     ORDER BY loss DESC`,
    [businessId]
  );
  return rows;
}

module.exports = { detectProfitLeaks };
