/**
 * Menu Engineering Agent
 *
 * Classifies every dish into one of 4 BCG quadrants based on:
 *   - Popularity  = qty sold vs. median sales across all dishes
 *   - Profitability = gross margin % vs. median margin across all dishes
 *
 * Quadrants:
 *   ⭐ STAR      — popular + profitable   → protect, maintain price
 *   🐴 PLOWHORSE — popular + low margin   → raise price or cut cost
 *   💎 PUZZLE    — high margin + low sales → promote, reposition
 *   🐶 DOG       — low margin + low sales  → improve or remove
 *
 * Also returns:
 *   - Per-dish pricing recommendation (optimal price for target margin)
 *   - Food Cost % summary
 *   - Top 3 actions ranked by financial impact
 */

const db    = require('../utils/db');
const cache = require('../utils/cache');
const { INGREDIENT_COST_CTE } = require('../utils/ingredientSource');

const TARGET_MARGIN     = 0.68; // 68% gross margin (food cost ~32%) — restaurant standard
const MAX_PRICE_RAISE   = 0.40; // never recommend raising price by more than 40% of current price

// ── Main Function ─────────────────────────────────────────────────────────────
// wrapWithLock, not get/set: the underlying analysis is the most expensive
// query set in the file (~2.7s cold), and a plain check-then-set let every
// concurrent miss run the whole thing — five simultaneous requests issued 15
// DB queries where three would do.
async function analyzeMenuEngineering(businessId, days = 30) {
  return cache.wrapWithLock(
    `menu-engineering:${businessId}:${days}`,
    () => _computeMenuEngineering(businessId, days),
    30 * 60,
  );
}

async function _computeMenuEngineering(businessId, days) {
  const [allDishes, totalRevenue, itemDataCoveragePct] = await Promise.all([
    _getDishMetrics(businessId, days),
    _getTotalRevenue(businessId, days),
    _getItemDataCoverage(businessId, days),
  ]);

  if (allDishes.length === 0) {
    return { dishes: [], quadrants: _emptyQuadrants(), summary: null, days, itemDataCoveragePct, noItemSales: false };
  }

  // Deleted dishes/recipes must never be classified, recommended for
  // promotion/removal, or shown in the menu list — but their real historical
  // sales still count toward this period's revenue/food-cost totals below
  // (deleting a dish must not erase what it actually cost/earned while it
  // was on the menu).
  const dishes = allDishes.filter(d => d.is_active !== false);
  if (dishes.length === 0) {
    return { dishes: [], quadrants: _emptyQuadrants(), summary: null, days, itemDataCoveragePct, noItemSales: false };
  }

  // Only dishes with actual sales participate in classification
  const withSales = dishes.filter(d => d.qty_sold > 0);

  // A dish with no configured ingredient cost computes to a perfect 100% margin.
  // That is not a measurement — it means nobody entered what the dish costs, and
  // it must not sit on the profitability axis at all:
  //   - it drags medianMargin up (one business in production has 17/17 dishes in
  //     this state, producing medianMargin = 100%), which then pushes genuinely
  //     profitable dishes BELOW the median and earns them "raise the price" or
  //     "remove from the menu";
  //   - and the dish itself came out ⭐ star — "your best dish, sells a lot AND
  //     profitable" — about a dish whose profitability is simply unknown.
  // Popularity is still measurable for these (they sold), profitability isn't,
  // so they're returned as unclassified with a distinct reason further down.
  const priced = withSales.filter(d => Number(d.cost_per_dish) > 0);

  // The two medians deliberately come from different sets: every dish that sold
  // can be ranked for popularity, only priced dishes can be ranked for margin.
  const medianSales  = _median([...withSales].map(d => d.qty_sold).sort((a, b) => a - b));
  const medianMargin = _median([...priced].map(d => d.margin_pct).sort((a, b) => a - b));

  // Classify + enrich each dish
  const enriched = dishes.map(dish => {
    const dataWarning = _detectDataWarning(dish);

    // No sales data → unclassified, skip quadrant logic
    if (dish.qty_sold === 0) {
      const { optimalPrice, priceDiff: pd } = _calcOptimalPrice(dish);
      return {
        ...dish,
        isPopular: false,
        isProfitable: false,
        quadrant: 'unclassified',
        unclassifiedReason: 'no_sales',
        optimalPrice,
        priceDiff: pd,
        dataWarning,
        recommendation: { action: 'אין נתוני מכירות', detail: `"${dish.name}" עדיין לא נמכרה — לאחר שתתחיל להימכר תסווג אוטומטית.`, priority: 'low', icon: '⏳' },
        revenueContribution: 0,
      };
    }

    // Sold, but no ingredient cost configured → popularity is known,
    // profitability is not. Anything that places this dish in a quadrant is
    // asserting a margin nobody entered (see the `priced` comment above).
    if (Number(dish.cost_per_dish) <= 0) {
      return {
        ...dish,
        isPopular: dish.qty_sold >= medianSales,
        isProfitable: null,
        quadrant: 'unclassified',
        unclassifiedReason: 'no_cost',
        optimalPrice: null,
        priceDiff: 0,
        dataWarning,
        recommendation: {
          action: 'חסרים נתוני עלות',
          detail: `"${dish.name}" נמכרה ${Math.round(dish.qty_sold)} פעמים — אבל לא הוגדרו לה חומרי גלם, ובלי עלות אי אפשר לדעת אם היא רווחית. הגדר את המרכיבים והיא תסווג אוטומטית.`,
          priority: 'medium',
          icon: '💸',
        },
        revenueContribution: totalRevenue > 0
          ? Math.round((dish.total_revenue / totalRevenue) * 1000) / 10
          : 0,
      };
    }

    const isPopular    = dish.qty_sold    >= medianSales;
    const isProfitable = dish.margin_pct  >= medianMargin;

    const quadrant = isPopular && isProfitable  ? 'star'
                   : isPopular && !isProfitable ? 'plowhorse'
                   : !isPopular && isProfitable ? 'puzzle'
                   : 'dog';

    const { optimalPrice, priceDiff } = _calcOptimalPrice(dish);

    const recommendation = _getRecommendation(quadrant, dish, priceDiff);

    return {
      ...dish,
      isPopular,
      isProfitable,
      quadrant,
      optimalPrice,
      priceDiff: Math.round(priceDiff * 100) / 100,
      dataWarning,
      recommendation,
      revenueContribution: totalRevenue > 0
        ? Math.round((dish.total_revenue / totalRevenue) * 1000) / 10
        : 0,
    };
  });

  // Group by quadrant
  const quadrants = {
    star:         enriched.filter(d => d.quadrant === 'star'),
    plowhorse:    enriched.filter(d => d.quadrant === 'plowhorse'),
    puzzle:       enriched.filter(d => d.quadrant === 'puzzle'),
    dog:          enriched.filter(d => d.quadrant === 'dog'),
    unclassified: enriched.filter(d => d.quadrant === 'unclassified'),
  };

  // Summary stats — computed from ALL dishes (active + deleted) so a dish's
  // real historical cost/revenue keeps counting toward this period's totals
  // even after it's removed from the menu; only the classification above is
  // active-only.
  const totalFoodCost  = allDishes.reduce((s, d) => s + d.qty_sold * d.cost_per_dish, 0);
  const totalRev       = allDishes.reduce((s, d) => s + d.total_revenue, 0);
  const avgFoodCostPct = totalRev > 0 ? Math.round((totalFoodCost / totalRev) * 1000) / 10 : 0;

  // Top 3 actions by financial impact
  const topActions = _getTopActions(enriched, days);

  const summary = {
    totalDishes:     enriched.length,
    avgFoodCostPct,
    totalRevenue:    Math.round(totalRev * 100) / 100,
    totalFoodCost:   Math.round(totalFoodCost * 100) / 100,
    medianSales:     Math.round(medianSales * 10) / 10,
    medianMargin:    Math.round(medianMargin * 10) / 10,
    topActions,
    starCount:            quadrants.star.length,
    plowhorseCount:       quadrants.plowhorse.length,
    puzzleCount:          quadrants.puzzle.length,
    dogCount:             quadrants.dog.length,
    unclassifiedCount:    quadrants.unclassified.length,
    // Split of the unclassified bucket, so the UI can tell "hasn't sold yet"
    // (nothing to do but wait) from "sold but has no cost data" (a fixable
    // config gap that is silently suppressing the whole profitability axis).
    noCostCount:  quadrants.unclassified.filter(d => d.unclassifiedReason === 'no_cost').length,
    noSalesCount: quadrants.unclassified.filter(d => d.unclassifiedReason === 'no_sales').length,
    // avgFoodCostPct is only meaningful when some dish actually has a cost.
    // Without this flag a business with zero cost data reports 0%, which the
    // UI's "green below 35%" rule renders as an excellent food cost.
    hasCostData: priced.length > 0,
    // % of period revenue that came from sales with item-level detail (sale_items).
    // Z-reports that only report a daily total (no per-dish breakdown) can't
    // contribute to food-cost/quadrant classification — this tells the UI when
    // avgFoodCostPct is based on too little real data to be trusted.
    itemDataCoveragePct,
  };

  const noItemSales = withSales.length === 0 && dishes.length > 0;
  return { dishes: enriched, quadrants, summary, days, medianSales, medianMargin, noItemSales, itemDataCoveragePct };
}

// ── Queries ───────────────────────────────────────────────────────────────────
async function _getDishMetrics(businessId, days) {
  const { rows } = await db.query(
    `WITH ${INGREDIENT_COST_CTE},
     -- smart dedup: on days with individual POS sales, skip Z-aggregate rows
     smart_sales AS (
       SELECT s.id, s.sold_at,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1
         AND s.sold_at >= NOW() - ($2::int * INTERVAL '1 day')
     ),
     ind_days AS (
       SELECT DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day
       FROM smart_sales WHERE is_ind
     ),
     valid_sales AS (
       SELECT ss.id FROM smart_sales ss
       WHERE ss.is_ind
          OR DATE(ss.sold_at AT TIME ZONE 'Asia/Jerusalem') NOT IN (SELECT sale_day FROM ind_days)
     ),
     -- ── מנות (dishes) ──
     -- לא מסננים לפי is_active כאן: מנה שנמחקה עדיין צריכה להיספר בהיסטוריה
     -- (מה שנמכר בפועל לפני המחיקה) — הסינון למנות פעילות-בלבד קורה בהמשך,
     -- ברמת הסיווג/ההמלצות בלבד (analyzeMenuEngineering), לא ברמת הסכומים.
     dish_sales AS (
       SELECT
         d.id                                              AS source_id,
         'dish'                                            AS source_type,
         d.name,
         d.selling_price::float,
         COALESCE(d.is_active, TRUE)                        AS is_active,
         COALESCE(SUM(si.qty), 0)::float                   AS qty_sold,
         COALESCE(SUM(si.qty * si.unit_price), 0)::float   AS total_revenue,
         MIN(s.sold_at)::date                               AS first_sold,
         MAX(s.sold_at)::date                               AS last_sold
       FROM dishes d
       LEFT JOIN sale_items si ON LOWER(si.name) = LOWER(d.name)
         AND si.sale_id IN (SELECT id FROM valid_sales)
         -- a sale_item carrying recipe_id belongs to recipe_sales below (matched
         -- by id there, not name) — without this guard, a sale_item whose name
         -- ALSO happens to match a same-named dish gets summed into both CTEs,
         -- double-counting qty_sold/total_revenue for that item
         AND si.recipe_id IS NULL
       LEFT JOIN sales s       ON s.id = si.sale_id
       WHERE d.business_id = $1
       GROUP BY d.id, d.name, d.selling_price, d.is_active
     ),
     dish_costs AS (
       SELECT
         d.id AS source_id,
         COALESCE(SUM(
           di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)
         ), 0)::float AS cost_per_dish
       FROM dishes d
       LEFT JOIN dish_ingredients di  ON di.dish_id = d.id
       LEFT JOIN inventory_items ii   ON ii.id = di.inventory_item_id AND ii.business_id = $1
       WHERE d.business_id = $1
       GROUP BY d.id
     ),
     -- ── מתכונים (recipes) ──
     recipe_sales AS (
       SELECT
         r.id                                              AS source_id,
         'recipe'                                          AS source_type,
         r.name,
         r.selling_price::float,
         COALESCE(r.is_active, TRUE)                        AS is_active,
         COALESCE(SUM(si.qty), 0)::float                   AS qty_sold,
         COALESCE(SUM(si.qty * si.unit_price), 0)::float   AS total_revenue,
         MIN(s.sold_at)::date                               AS first_sold,
         MAX(s.sold_at)::date                               AS last_sold
       FROM recipes r
       LEFT JOIN sale_items si ON si.recipe_id = r.id
         AND si.sale_id IN (SELECT id FROM valid_sales)
       LEFT JOIN sales s       ON s.id = si.sale_id
       WHERE r.business_id = $1
       GROUP BY r.id, r.name, r.selling_price, r.is_active
     ),
     -- Cost source resolution lives in utils/ingredientSource.js (see
     -- recipe_cost_source, spliced in above). The previous rule here was
     -- "recipe_ingredients wins, fall back to the same-name dish only if the
     -- recipe has no rows AT ALL" — which handed the decision to a stale
     -- partial recipe whose every line was unlinked, over a fully-linked dish.
     -- Measured effect on live data: "כריך אסאדו" reported a 8.7% food cost
     -- instead of its real 32.8%, and "RICEBOWL בקר" 8.5% instead of 32.8% —
     -- i.e. this screen was telling the owner their margins were roughly four
     -- times better than they are.
     recipe_costs AS (
       SELECT recipe_id AS source_id, cost_price AS cost_per_dish
       FROM recipe_cost_source
     ),
     -- Collapsed to one row per NAME, not per dish id. Grouping by d.id emitted
     -- two rows for two dishes sharing a name, and the LEFT JOIN below then
     -- duplicated the matching recipe row — doubling its qty_sold and revenue
     -- inside the SUM() OVER in deduped. MAX() keeps the variant that has
     -- cost data over one that has none.
     dish_cost_by_name AS (
       SELECT dname, MAX(cost_per_dish) AS cost_per_dish
       FROM (
         SELECT LOWER(d.name) AS dname,
           COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0)::float AS cost_per_dish
         FROM dishes d
         LEFT JOIN dish_ingredients di ON di.dish_id = d.id
         LEFT JOIN inventory_items ii  ON ii.id = di.inventory_item_id AND ii.business_id = $1
         WHERE d.business_id = $1
         GROUP BY d.id, d.name
       ) per_dish
       GROUP BY dname
     ),
     -- ── איחוד ──
     combined AS (
       SELECT ds.source_id, ds.source_type, ds.name, ds.selling_price, ds.is_active,
              ds.qty_sold, ds.total_revenue, ds.first_sold, ds.last_sold,
              COALESCE(dc.cost_per_dish, 0) AS cost_per_dish
       FROM dish_sales ds
       LEFT JOIN dish_costs dc ON dc.source_id = ds.source_id
       UNION ALL
       SELECT rs.source_id, rs.source_type, rs.name, rs.selling_price, rs.is_active,
              rs.qty_sold, rs.total_revenue, rs.first_sold, rs.last_sold,
              COALESCE(rc.cost_per_dish, dcbn.cost_per_dish, 0) AS cost_per_dish
       FROM recipe_sales rs
       LEFT JOIN recipe_costs rc      ON rc.source_id = rs.source_id
       LEFT JOIN dish_cost_by_name dcbn ON dcbn.dname = LOWER(rs.name)
     ),
     -- ── ריכוז כפילויות: אותו שם ב-dishes וב-recipes → שורה אחת ──
     -- is_active = TRUE אם קיימת ולו גרסה אחת פעילה בשם הזה (מנה או מתכון) —
     -- כלומר הפריט עדיין קיים בתפריט בצורה כלשהי.
     deduped AS (
       SELECT DISTINCT ON (LOWER(name))
         source_id,
         source_type,
         name,
         selling_price,
         BOOL_OR(is_active)  OVER (PARTITION BY LOWER(name)) AS is_active,
         SUM(qty_sold)      OVER (PARTITION BY LOWER(name)) AS qty_sold,
         SUM(total_revenue) OVER (PARTITION BY LOWER(name)) AS total_revenue,
         MIN(first_sold)    OVER (PARTITION BY LOWER(name)) AS first_sold,
         MAX(last_sold)     OVER (PARTITION BY LOWER(name)) AS last_sold,
         MAX(cost_per_dish) OVER (PARTITION BY LOWER(name)) AS cost_per_dish
       FROM combined
       ORDER BY LOWER(name),
                qty_sold DESC,      -- העדף את השורה עם הכי הרבה מכירות
                cost_per_dish DESC  -- אם שווה — העדף את זו עם נתוני עלות
     )
     SELECT
       source_id     AS recipe_id,
       source_type,
       name,
       selling_price,
       is_active,
       qty_sold,
       total_revenue,
       cost_per_dish,
       first_sold,
       last_sold,
       -- Real avg price per unit sold; for weight-based items this differs from catalog selling_price
       CASE
         WHEN qty_sold > 0 AND total_revenue > 0 THEN ROUND((total_revenue / qty_sold)::numeric, 2)::float
         ELSE selling_price
       END AS effective_price,
       -- Use actual avg revenue per unit sold when available — fixes weight-based items
       -- where catalog selling_price is per 100g but cost_per_dish is for a full portion.
       -- For normal dishes total_revenue/qty_sold ≈ selling_price so result is identical.
       CASE
         WHEN qty_sold > 0 AND total_revenue > 0
         THEN ROUND(((((total_revenue / qty_sold) - cost_per_dish) / (total_revenue / qty_sold)) * 100)::numeric, 1)::float
         WHEN selling_price > 0
         THEN ROUND((((selling_price - cost_per_dish) / selling_price) * 100)::numeric, 1)::float
         ELSE 0
       END AS margin_pct
     FROM deduped
     WHERE selling_price > 0 OR (qty_sold > 0 AND total_revenue > 0)
     ORDER BY total_revenue DESC`,
    [businessId, days]
  );
  return rows;
}

// % of period revenue that comes from sales carrying at least one sale_items
// row. Z-reports from POS systems/formats that only report a daily total
// (no per-dish breakdown) never populate sale_items, so their revenue is
// invisible to food-cost/quadrant classification even though it's counted
// correctly everywhere else (dashboard totals, cash flow, etc.).
async function _getItemDataCoverage(businessId, days) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT s.id, s.total_amount,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind,
              EXISTS(SELECT 1 FROM sale_items si WHERE si.sale_id = s.id) AS has_items
       FROM sales s
       WHERE s.business_id = $1
         AND s.sold_at >= NOW() - ($2::int * INTERVAL '1 day')
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     valid AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
     SELECT
       COALESCE(SUM(total_amount), 0)::float                          AS total,
       COALESCE(SUM(total_amount) FILTER (WHERE has_items), 0)::float AS with_items
     FROM valid`,
    [businessId, days]
  );
  const { total, with_items } = rows[0] || { total: 0, with_items: 0 };
  return total > 0 ? Math.round((with_items / total) * 100) : 0;
}

async function _getTotalRevenue(businessId, days) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT total_amount,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1
         AND sold_at >= NOW() - ($2::int * INTERVAL '1 day')
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT COALESCE(SUM(total_amount), 0)::float AS total
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)`,
    [businessId, days]
  );
  return rows[0]?.total || 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _median(arr) {
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Must carry the SAME keys as the populated path — a caller doing
// quadrants.unclassified.length threw on any business with no dishes, because
// this shape was missing that one key.
function _emptyQuadrants() {
  return { star: [], plowhorse: [], puzzle: [], dog: [], unclassified: [] };
}

// Detects suspicious cost data and returns a Hebrew warning string, or null if data looks fine.
// Thresholds:
//   food cost > 100% of selling price → almost certainly wrong data entry
//   food cost 85-100% of selling price → extremely high, likely wrong
//   margin < 0 → selling at a loss (same as above, belt-and-suspenders)
function _detectDataWarning(dish) {
  const price = dish.effective_price || dish.selling_price;
  if (price <= 0) return null;

  // Zero cost is the MOST suspicious case, not the safe default — it means
  // the dish/recipe has no ingredients configured at all, which produces a
  // fake 100% margin that must never be treated as a real "high-margin"
  // opportunity to promote.
  if (dish.cost_per_dish <= 0) {
    return `לא הוגדרו מרכיבים/עלות למנה "${dish.name}" — המרג'ין המוצג (100%) אינו אמיתי. הגדר את עלות המרכיבים כדי לקבל נתון תקין.`;
  }

  const costRatio = dish.cost_per_dish / price;

  if (costRatio >= 1) {
    return `עלות הגלם המחושבת (₪${dish.cost_per_dish.toFixed(2)}) גבוהה ממחיר המכירה (₪${price.toFixed(2)}) — שים לב: המספר לא ריאלי, יש לבדוק אם עלות הפריט אמיתית`;
  }
  if (costRatio >= 0.85) {
    return `עלות הגלם (₪${dish.cost_per_dish.toFixed(2)}) היא ${Math.round(costRatio * 100)}% ממחיר המכירה — שים לב: המספר לא ריאלי, יש לבדוק אם עלות הפריט אמיתית`;
  }
  return null;
}

// Returns { optimalPrice, priceDiff } with sanity guard:
//   - optimalPrice is only shown when the needed increase is ≤ MAX_PRICE_RAISE (40%)
//   - beyond that, raising price alone is unrealistic → null so UI shows cost-reduction advice
function _calcOptimalPrice(dish) {
  if (dish.cost_per_dish <= 0) return { optimalPrice: null, priceDiff: 0 };

  const price   = dish.effective_price || dish.selling_price;
  const raw     = Math.ceil(dish.cost_per_dish / (1 - TARGET_MARGIN));
  const rawDiff = raw - price;

  // Ignore negative diff (price already above target — margin calc elsewhere handles this)
  if (rawDiff <= 0) return { optimalPrice: null, priceDiff: 0 };

  // Increase is unrealistically large — cap and signal cost reduction instead
  if (price > 0 && rawDiff / price > MAX_PRICE_RAISE) {
    return { optimalPrice: null, priceDiff: 0 };
  }

  return { optimalPrice: raw, priceDiff: Math.round(rawDiff * 100) / 100 };
}

function _getRecommendation(quadrant, dish, priceDiff) {
  const name  = dish.name;
  const price = dish.effective_price || dish.selling_price;
  const targetCost = Math.round(price * (1 - TARGET_MARGIN));

  switch (quadrant) {
    case 'star':
      return {
        action: 'שמור ותחזק',
        detail: `"${name}" היא המנה הטובה ביותר שלך — נמכרת הרבה וגם רווחית. שמור על איכות עקבית ואל תשנה את המתכון.`,
        priority: 'low',
        icon: '⭐',
      };
    case 'plowhorse':
      if (priceDiff > 0) {
        return {
          action: `העלה מחיר ב-₪${priceDiff.toFixed(0)}`,
          detail: `"${name}" נמכרת טוב אבל המרג'ין נמוך (${dish.margin_pct.toFixed(1)}%). העלאת המחיר ל-₪${(price + priceDiff).toFixed(0)} תביא למרג'ין יעד של ${Math.round(TARGET_MARGIN * 100)}%.`,
          priority: 'high',
          icon: '🐴',
        };
      }
      return {
        action: 'הורד עלות חומרי גלם',
        detail: `"${name}" נמכרת טוב אבל עלות הגלם גבוהה (${dish.margin_pct.toFixed(1)}% מרג'ין). עלות יעד לפריט: ₪${targetCost} — בדוק ספקים אלטרנטיביים, כמויות, או ייעול מתכון.`,
        priority: 'high',
        icon: '🐴',
      };
    case 'puzzle':
      return {
        action: 'קדם את המנה',
        detail: `"${name}" מאוד רווחית (${dish.margin_pct.toFixed(1)}%) אבל לא נמכרת מספיק. שים אותה בראש התפריט, הדגש אותה בשלטים, והכשר את הצוות להמליץ עליה.`,
        priority: 'medium',
        icon: '💎',
      };
    case 'dog':
      return {
        action: 'שפר או הסר',
        detail: `"${name}" לא נמכרת ולא רווחית. שקול: לשפר את המתכון, להוריד מחיר כדי לעורר עניין, או להסיר מהתפריט לגמרי.`,
        priority: 'high',
        icon: '🐶',
      };
    default:
      return { action: '', detail: '', priority: 'low', icon: '' };
  }
}

function _getTopActions(dishes, days) {
  // Built as three separate buckets and merged round-robin at the end.
  // Appending them into one array and slicing to 3 made the promote action
  // structurally unreachable: the order was [plowhorse, plowhorse, dog, puzzle],
  // so any business with two plowhorses and one dog lost its "promote this
  // high-margin dish" advice every single time, silently.
  const priceActions = [];
  const removeActions = [];
  const promoteActions = [];

  // Plowhorses: prefer price-raise when realistic, else suggest cost reduction
  const plowhorses = dishes
    .filter(d => d.quadrant === 'plowhorse')
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, 2);

  for (const d of plowhorses) {
    if (d.priceDiff > 0 && d.optimalPrice && !d.dataWarning) {
      const monthlyGain = Math.round(d.qty_sold * d.priceDiff * (30 / days));
      const annualGain  = d.qty_sold * d.priceDiff * (365 / days);
      priceActions.push({
        type: 'raise_price',
        dish: d.name,
        impact: Math.round(annualGain),
        dataWarning: null,
        label: `העלה את מחיר "${d.name}" ב-₪${d.priceDiff.toFixed(0)} (ל-₪${d.optimalPrice}) → רווח נוסף של כ-₪${monthlyGain} בחודש`,
      });
    } else {
      const effPrice   = d.effective_price || d.selling_price;
      const targetCost = Math.round(effPrice * (1 - TARGET_MARGIN));
      priceActions.push({
        type: 'reduce_cost',
        dish: d.name,
        impact: 0,
        dataWarning: d.dataWarning || null,
        label: `הורד עלות גלם של "${d.name}" ל-₪${targetCost} לפריט — המרג'ין כרגע נמוך (${d.margin_pct.toFixed(0)}%)`,
      });
    }
  }

  // Dogs — remove
  const dogs = dishes
    .filter(d => d.quadrant === 'dog' && d.qty_sold < 3)
    .sort((a, b) => a.margin_pct - b.margin_pct)
    .slice(0, 1);

  for (const d of dogs) {
    removeActions.push({
      type: 'remove',
      dish: d.name,
      impact: 0,
      dataWarning: null,
      label: `שקול להסיר את "${d.name}" מהתפריט — לא נמכרת ולא רווחית`,
    });
  }

  // Puzzles — promote (never a dish whose "high margin" is really just
  // missing cost data — that's a config problem, not a promotion opportunity)
  const puzzles = dishes
    .filter(d => d.quadrant === 'puzzle' && !d.dataWarning)
    .sort((a, b) => b.margin_pct - a.margin_pct)
    .slice(0, 1);

  for (const d of puzzles) {
    promoteActions.push({
      type: 'promote',
      dish: d.name,
      impact: 0,
      dataWarning: null,
      label: `קדם את "${d.name}" — רווחיות גבוהה (${d.margin_pct.toFixed(0)}%) אבל חשיפה נמוכה`,
    });
  }

  // Round-robin across the three kinds of advice, then top up from whatever is
  // left. Guarantees each available kind gets a slot before any kind gets two.
  const buckets = [priceActions, removeActions, promoteActions];
  const actions = [];
  for (let i = 0; actions.length < 3 && buckets.some(b => b.length > i); i++) {
    for (const b of buckets) {
      if (b[i] && actions.length < 3) actions.push(b[i]);
    }
  }
  return actions;
}

// ── Monthly Food Cost (calendar month-to-date, updates daily) ──────────────
// Resets to 0 automatically every calendar month (query only looks at the
// current month, no stored counter to reset). For each day this month:
//   - if that day's sales carry real per-dish detail (sale_items matched to
//     a dish/recipe) → use the ACTUAL cost of what was sold that day.
//   - otherwise (Z-report gave only a daily total, no line items — the
//     common case for many POS exports) → ESTIMATE that day's cost as the
//     business's blended menu food-cost% × that day's real revenue. This is
//     standard "theoretical food cost" practice when full POS item-level
//     integration isn't available, and it's clearly flagged to the caller.
async function getMonthlyFoodCost(businessId) {
  return cache.wrapWithLock(
    `menu-engineering:${businessId}:mtd`,
    () => _computeMonthlyFoodCost(businessId),
    180,
  );
}

async function _computeMonthlyFoodCost(businessId) {
  const [dailyRows, blendedPct] = await Promise.all([
    _getDailyRevenueAndCost(businessId),
    _getBlendedFoodCostPct(businessId),
  ]);

  let actualCost = 0, estimatedCost = 0, totalRevenue = 0;
  let daysWithDetail = 0, daysEstimated = 0;

  for (const day of dailyRows) {
    totalRevenue += day.revenue;
    if (day.has_item_detail) {
      actualCost += day.actual_cost;
      daysWithDetail++;
    } else if (day.revenue > 0) {
      if (blendedPct !== null) estimatedCost += day.revenue * blendedPct;
      daysEstimated++;
    }
  }

  const totalCost   = actualCost + estimatedCost;
  const foodCostPct = totalRevenue > 0 ? Math.round((totalCost / totalRevenue) * 1000) / 10 : null;
  const hasAnyEstimate = daysEstimated > 0 && estimatedCost > 0;

  const now = new Date();
  return {
    foodCostPct,
    totalRevenue:  Math.round(totalRevenue * 100) / 100,
    totalCost:     Math.round(totalCost * 100) / 100,
    actualCost:    Math.round(actualCost * 100) / 100,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    daysWithDetail,
    daysEstimated,
    hasAnyEstimate,
    isFullyEstimated: daysWithDetail === 0 && daysEstimated > 0,
    blendedPctUsed: blendedPct !== null ? Math.round(blendedPct * 1000) / 10 : null,
    // true only when there's genuinely nothing to compute from at all —
    // no menu cost data AND no revenue this month
    hasData: totalRevenue > 0 || blendedPct !== null,
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  };
}

// Per-day revenue + actual dish-linked cost for the current calendar month
// (Asia/Jerusalem), plus whether that day's sales carried item-level detail.
async function _getDailyRevenueAndCost(businessId) {
  const { rows } = await db.query(
    `WITH ${INGREDIENT_COST_CTE},
     bounds AS (
       SELECT date_trunc('month', NOW() AT TIME ZONE 'Asia/Jerusalem')::date AS start_date,
              (NOW() AT TIME ZONE 'Asia/Jerusalem')::date                    AS end_date
     ),
     smart_sales AS (
       SELECT s.id, s.total_amount,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s, bounds b
       WHERE s.business_id = $1
         AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') BETWEEN b.start_date AND b.end_date
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart_sales WHERE is_ind),
     valid_sales AS (
       SELECT id, total_amount, sale_day FROM smart_sales
       WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     ),
     dish_unit_cost AS (
       SELECT d.id, LOWER(d.name) AS dname,
         COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0)::float AS cost_per_unit
       FROM dishes d
       LEFT JOIN dish_ingredients di ON di.dish_id = d.id
       LEFT JOIN inventory_items ii  ON ii.id = di.inventory_item_id AND ii.business_id = $1
       WHERE d.business_id = $1
       GROUP BY d.id
     ),
     -- Recipe cost now comes from recipe_cost_source (utils/ingredientSource.js),
     -- which picks whichever ingredient list is more completely linked to
     -- inventory. The previous rule preferred recipe_ingredients and fell
     -- through to the dish only when the recipe had NO rows at all, so a stale
     -- partial recipe (rows present, every item_id NULL) beat a fully-linked
     -- dish. Measured on live data, that made this widget report a **7.1%**
     -- monthly food cost against a real ~30% — the single most-read number on
     -- the dashboard, wrong by a factor of four, in the flattering direction.
     item_costs AS (
       SELECT si.sale_id, si.qty,
         COALESCE(ruc.cost_price, duc.cost_per_unit) AS unit_cost,
         (ruc.recipe_id IS NOT NULL OR duc.id IS NOT NULL) AS matched
       FROM sale_items si
       LEFT JOIN recipe_cost_source ruc ON ruc.recipe_id = si.recipe_id
       LEFT JOIN dish_unit_cost duc     ON duc.dname = LOWER(si.name)
       WHERE si.sale_id IN (SELECT id FROM valid_sales)
     ),
     per_sale AS (
       SELECT sale_id,
         SUM(qty * COALESCE(unit_cost, 0)) AS item_cost,
         BOOL_OR(matched)                  AS has_match
       FROM item_costs GROUP BY sale_id
     )
     SELECT
       vs.sale_day                                    AS day,
       SUM(vs.total_amount)::float                    AS revenue,
       COALESCE(BOOL_OR(ps.has_match), false)          AS has_item_detail,
       COALESCE(SUM(ps.item_cost), 0)::float           AS actual_cost
     FROM valid_sales vs
     LEFT JOIN per_sale ps ON ps.sale_id = vs.id
     GROUP BY vs.sale_day
     ORDER BY vs.sale_day`,
    [businessId]
  );
  return rows;
}

// Blended (menu-wide) food-cost ratio used to estimate days without item-level
// detail. Prefers weighting by the business's real historical sales mix
// (however far back it has to look); falls back to a plain average across
// active, priced dishes when there's no sales-mix data at all.
async function _getBlendedFoodCostPct(businessId) {
  const allTime = await _getDishMetrics(businessId, 365);
  if (!allTime.length) return null;

  const withSales = allTime.filter(d => d.qty_sold > 0 && d.total_revenue > 0);
  if (withSales.length > 0) {
    const cost = withSales.reduce((s, d) => s + d.qty_sold * d.cost_per_dish, 0);
    const rev  = withSales.reduce((s, d) => s + d.total_revenue, 0);
    if (rev > 0) return cost / rev;
  }

  const priced = allTime.filter(d => d.selling_price > 0 && d.cost_per_dish > 0);
  if (!priced.length) return null;
  return priced.reduce((s, d) => s + (d.cost_per_dish / d.selling_price), 0) / priced.length;
}

// ── Price Elasticity & Bundle Analysis ───────────────────────────────────────
// Finds dishes where unit_price varied over time (proxy for price changes),
// estimates demand sensitivity, and suggests bundle pairings.
async function analyzePriceElasticity(businessId) {
  return cache.wrapWithLock(
    `menu-elasticity:${businessId}`,
    () => _computePriceElasticity(businessId),
    30 * 60,
  );
}

// Minimum evidence before we're willing to put a number on demand sensitivity.
const ELASTICITY_MIN_DAYS      = 7;   // total days the item sold on
const ELASTICITY_MIN_BAND_DAYS = 3;   // days needed on EACH side of the price split
const ELASTICITY_MIN_GAP       = 0.02; // cheap and expensive bands must differ by >2%

function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((sortedAsc.length - 1) * p)));
  return sortedAsc[i];
}

async function _computePriceElasticity(businessId) {
  // One row per item per day: what it averaged that day and how much moved.
  //
  // Two things this query does that the previous one didn't:
  //   1. Restricts to items still on the menu. The old version read sale_items
  //      by name with no reference to the dishes table at all, so on a real
  //      business 9 of the 10 rows shown were dishes the owner had already
  //      taken off the menu (is_active = false) — including POS bookkeeping
  //      lines like "כללי מטבח" and "עיסקית Wolt" that were never dishes.
  //   2. Applies the same Z-report dedup as every other query in this file.
  //      This was the only one without it, so on a day carrying both a Z
  //      aggregate and individual sales the same units were counted twice.
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT s.id,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1 AND s.sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     valid_sales AS (
       SELECT id, sale_day FROM smart
       WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     ),
     active_names AS (
       SELECT LOWER(name) AS n FROM dishes  WHERE business_id = $1 AND COALESCE(is_active, TRUE)
       UNION
       SELECT LOWER(name) AS n FROM recipes WHERE business_id = $1 AND COALESCE(is_active, TRUE)
     ),
     active_recipes AS (
       SELECT id FROM recipes WHERE business_id = $1 AND COALESCE(is_active, TRUE)
     )
     SELECT si.name,
            vs.sale_day,
            SUM(si.qty)::float                                          AS qty,
            (SUM(si.qty * si.unit_price) / NULLIF(SUM(si.qty), 0))::float AS price,
            BOOL_OR(si.qty <> ROUND(si.qty))                            AS fractional
     FROM sale_items si
     JOIN valid_sales vs ON vs.id = si.sale_id
     WHERE si.unit_price > 0
       AND (LOWER(si.name) IN (SELECT n FROM active_names)
            OR si.recipe_id IN (SELECT id FROM active_recipes))
     GROUP BY si.name, vs.sale_day
     ORDER BY si.name, vs.sale_day`,
    [businessId]
  );

  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push({ qty: r.qty, price: r.price, fractional: r.fractional });
  }

  const elasticityData = [];
  for (const [name, obs] of byName) {
    if (obs.length < ELASTICITY_MIN_DAYS) continue;

    const prices  = obs.map(o => o.price).sort((a, b) => a - b);
    const minPrice = prices[0], maxPrice = prices[prices.length - 1];
    if (maxPrice <= minPrice * 1.05) continue;

    const totalQty      = obs.reduce((s, o) => s + o.qty, 0);
    const daysWithSales = obs.length;
    const base = {
      name,
      avgPrice: Math.round((obs.reduce((s, o) => s + o.price * o.qty, 0) / (totalQty || 1)) * 100) / 100,
      minPrice: Math.round(minPrice * 100) / 100,
      maxPrice: Math.round(maxPrice * 100) / 100,
      priceVariationPct: Math.round(((maxPrice - minPrice) / minPrice) * 100),
      totalQty: Math.round(totalQty),
      daysWithSales,
      elasticity: null,
      cheapPrice: null, dearPrice: null,
      cheapQtyPerDay: null, dearQtyPerDay: null,
    };

    // An item sold by weight has a "unit price" that moves with the portion, not
    // with any pricing decision — on this business "בריסקט במשקל" showed a 28%
    // swing purely from weights (qty values like 4.5, 11.5, 17). Calling that a
    // price change and then reading demand off it produces a confident number
    // about an experiment that never happened.
    if (obs.filter(o => o.fractional).length / obs.length >= 0.2) {
      elasticityData.push({ ...base, elasticitySignal: 'weight_based' });
      continue;
    }

    // Split the days into a cheap third and a dear third and compare how much
    // sold per day in each. This is the comparison the old code claimed to make
    // ("sales stayed stable despite the price change") but never did — it only
    // counted how many days the item sold on, so an item that sold on 30+ days
    // was labelled price-insensitive no matter what demand actually did.
    const cheapCut = _percentile(prices, 0.33);
    const dearCut  = _percentile(prices, 0.67);
    const cheapDays = obs.filter(o => o.price <= cheapCut);
    const dearDays  = obs.filter(o => o.price >= dearCut);

    if (cheapDays.length < ELASTICITY_MIN_BAND_DAYS || dearDays.length < ELASTICITY_MIN_BAND_DAYS) {
      elasticityData.push({ ...base, elasticitySignal: 'uncertain' });
      continue;
    }

    const avg = (a, f) => a.reduce((s, o) => s + f(o), 0) / a.length;
    const cheapPrice = avg(cheapDays, o => o.price);
    const dearPrice  = avg(dearDays,  o => o.price);
    const cheapQty   = avg(cheapDays, o => o.qty);
    const dearQty    = avg(dearDays,  o => o.qty);

    const pctPrice = (dearPrice - cheapPrice) / cheapPrice;
    if (pctPrice < ELASTICITY_MIN_GAP || cheapQty <= 0) {
      elasticityData.push({ ...base, elasticitySignal: 'uncertain' });
      continue;
    }

    const pctQty     = (dearQty - cheapQty) / cheapQty;
    const elasticity = pctQty / pctPrice;

    // |e| < 0.5 → demand barely reacted; e <= -1 → demand fell faster than the
    // price rose (raising further costs money). Positive e means volume went UP
    // with price, which is almost always a confound (seasonality, a promotion
    // running on the cheap days) rather than a real result — reported as
    // uncertain rather than dressed up as a licence to raise prices.
    const signal = elasticity > 0.3      ? 'uncertain'
                 : elasticity >= -0.5    ? 'inelastic'
                 : elasticity <= -1.0    ? 'elastic'
                 :                         'moderate';

    elasticityData.push({
      ...base,
      elasticity: Math.round(elasticity * 100) / 100,
      cheapPrice: Math.round(cheapPrice * 100) / 100,
      dearPrice:  Math.round(dearPrice * 100) / 100,
      cheapQtyPerDay: Math.round(cheapQty * 10) / 10,
      dearQtyPerDay:  Math.round(dearQty * 10) / 10,
      elasticitySignal: signal,
    });
  }

  elasticityData.sort((a, b) => b.totalQty - a.totalQty);
  elasticityData.splice(10);

  // Bundle analysis: pair high-margin low-volume dishes (puzzle) with popular dishes (star/plowhorse)
  const menuData = await analyzeMenuEngineering(businessId);
  const puzzles  = menuData.quadrants.puzzle.slice(0, 3);
  const anchors  = [...menuData.quadrants.star, ...menuData.quadrants.plowhorse]
    .sort((a, b) => b.qty_sold - a.qty_sold)
    .slice(0, 3);

  // Each puzzle gets its OWN anchor. This loop used to read anchors[0] every
  // iteration, so it collected three anchors and then used only the first —
  // producing three suggestion cards that were all "RICEBOWL בקר + something"
  // while the other two anchors sat unused.
  const bundles = [];
  const usedAnchors = new Set();
  for (const puzzle of puzzles) {
    const anchor = anchors.find(a => a.name !== puzzle.name && !usedAnchors.has(a.name));
    if (!anchor) continue;
    usedAnchors.add(anchor.name);
    // effective_price (real avg amount paid), not the catalog selling_price —
    // for weight-based items sold per 100g/unit, selling_price is a per-unit
    // catalog figure that can be far below what a diner actually pays, same
    // reason the rest of this file (optimal price, margin, recommendations)
    // already prefers effective_price over selling_price everywhere else.
    const puzzlePrice = puzzle.effective_price || puzzle.selling_price;
    const anchorPrice = anchor.effective_price || anchor.selling_price;
    const bundlePrice = Math.round((puzzlePrice + anchorPrice) * 0.92); // 8% bundle discount
    bundles.push({
      anchor:       anchor.name,
      add:          puzzle.name,
      bundlePrice,
      saving:       Math.round(puzzlePrice + anchorPrice - bundlePrice),
      reason:       `"${puzzle.name}" רווחית (${puzzle.margin_pct.toFixed(0)}%) אבל חשיפה נמוכה — שלב עם "${anchor.name}" כחבילה`,
    });
  }

  return { elasticityData, bundles, analyzedAt: new Date().toISOString() };
}

module.exports = { analyzeMenuEngineering, analyzePriceElasticity, getMonthlyFoodCost, detectDataWarning: _detectDataWarning };
