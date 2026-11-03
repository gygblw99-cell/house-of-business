/**
 * Shared resolution of "which ingredient list is authoritative for a recipe".
 *
 * A dish can be defined in TWO parallel places, and most businesses end up with
 * rows in both:
 *   • recipe_ingredients — the older "recipes" feature
 *   • dish_ingredients   — the "dishes" feature (has an inventory_item_id FK)
 *
 * Every agent used to resolve this the same wrong way: prefer recipe_ingredients,
 * and fall back to dish_ingredients only when the recipe had NO rows at all
 * (`COALESCE(recipe_cost, dish_cost)` / `NOT EXISTS (SELECT 1 FROM recipe_ingredients)`).
 * That is exactly backwards whenever the recipe rows are a stale partial copy:
 * a recipe with three ingredient rows that are all `item_id IS NULL` beat a fully
 * linked dish, so the cost came from year-old `manual_cost` numbers and the
 * ingredient quantities contributed ZERO to expected usage / stock deduction.
 *
 * Observed damage before this fix (real data): "כריך אסאדו" costed at ₪4.78
 * instead of ₪18.03 (8.7% food cost instead of 33%), "RICEBOWL בקר" at ₪4.95
 * instead of ₪19, and neither deducted a gram of inventory when sold.
 *
 * The rule here: **prefer whichever source has more lines actually linked to an
 * inventory item.** A linked line has a live cost and can be verified against
 * stock; an unlinked line is an unverifiable manual number. Ties go to the
 * recipe, so businesses that genuinely maintain recipe_ingredients are untouched.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 * Both fragments are CTE bodies meant to be spliced into a WITH clause, and both
 * REQUIRE `$1` to be the businessId in the host query:
 *
 *   `WITH ${INGREDIENT_SOURCE_CTE},
 *     my_thing AS (SELECT ... FROM ingredients ing ...)
 *    SELECT ...`
 *
 * INGREDIENT_SOURCE_CTE defines `ingredient_source` + `ingredients`
 *   (recipe_id, item_id, qty) — linked lines only, for usage/deduction math.
 * INGREDIENT_COST_CTE additionally defines `recipe_cost_source`
 *   (recipe_id, dish_id, cost_price) — full cost incl. unlinked manual_cost lines.
 */

// Name normalisation must match zreport.import.service.js's deduction paths, or
// a dish would be picked as the cost source here while the deduction silently
// used a different (or no) list — producing a permanent phantom variance.
const NORM_NAME = `regexp_replace(trim(lower(%s)), '\\s+', ' ', 'g')`;

const _SOURCE_BODY = `
  ingredient_source AS (
    SELECT
      r.id AS recipe_id,
      (SELECT COUNT(*) FROM recipe_ingredients ri
        WHERE ri.recipe_id = r.id AND ri.item_id IS NOT NULL)::int AS recipe_linked,
      d.dish_id,
      COALESCE(d.linked, 0)::int                                   AS dish_linked
    FROM recipes r
    LEFT JOIN LATERAL (
      SELECT dd.id AS dish_id,
             COUNT(*) FILTER (WHERE di.inventory_item_id IS NOT NULL)::int AS linked
      FROM dishes dd
      LEFT JOIN dish_ingredients di ON di.dish_id = dd.id
      WHERE dd.business_id = r.business_id
        AND ${NORM_NAME.replace('%s', 'dd.name')} = ${NORM_NAME.replace('%s', 'r.name')}
        AND (dd.is_active IS NULL OR dd.is_active = TRUE)
      GROUP BY dd.id
      ORDER BY linked DESC, dd.id
      LIMIT 1
    ) d ON TRUE
    WHERE r.business_id = $1
  )`;

/**
 * `ingredient_source` + `ingredients(recipe_id, item_id, qty)`.
 * Only inventory-linked lines — an unlinked line has no measurable quantity, so
 * including it would inflate nothing and mislead everything.
 */
const INGREDIENT_SOURCE_CTE = `${_SOURCE_BODY},
  ingredients AS (
    SELECT s.recipe_id, ri.item_id, ri.qty::float AS qty
    FROM ingredient_source s
    JOIN recipe_ingredients ri ON ri.recipe_id = s.recipe_id
    WHERE ri.item_id IS NOT NULL
      AND s.recipe_linked >= s.dish_linked
    UNION ALL
    SELECT s.recipe_id, di.inventory_item_id AS item_id, di.qty::float AS qty
    FROM ingredient_source s
    JOIN dish_ingredients di ON di.dish_id = s.dish_id
    WHERE di.inventory_item_id IS NOT NULL
      AND s.dish_linked > s.recipe_linked
  )`;

/**
 * `ingredient_source` + `recipe_cost_source(recipe_id, dish_id, cost_price)`.
 * Cost DOES include unlinked lines (via manual_cost) — for a recipe with no dish
 * counterpart at all, a stale manual number still beats reporting ₪0 cost and
 * declaring the dish infinitely profitable.
 */
const INGREDIENT_COST_CTE = `${_SOURCE_BODY},
  recipe_cost_source AS (
    SELECT
      s.recipe_id,
      s.dish_id,
      CASE WHEN s.dish_linked > s.recipe_linked THEN (
        SELECT COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0)
        FROM dish_ingredients di
        LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id AND ii.business_id = $1
        WHERE di.dish_id = s.dish_id
      ) ELSE (
        SELECT COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0)), 0)
        FROM recipe_ingredients ri
        LEFT JOIN inventory_items ii ON ii.id = ri.item_id AND ii.business_id = $1
        WHERE ri.recipe_id = s.recipe_id
      ) END::float AS cost_price
    FROM ingredient_source s
  )`;

/**
 * Standalone cost lookup by DISH id (for sale_items with no recipe_id at all).
 * One row per normalised dish name so two dishes sharing a name can't duplicate
 * the sales they join against.
 */
const DISH_COST_BY_NAME_CTE = `
  dish_cost_by_name AS (
    SELECT dname, MAX(cost_price) AS cost_price, MAX(selling_price) AS selling_price,
           MAX(display_name) AS name
    FROM (
      SELECT ${NORM_NAME.replace('%s', 'd.name')} AS dname,
             d.name                               AS display_name,
             d.selling_price::float               AS selling_price,
             COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0)::float AS cost_price
      FROM dishes d
      LEFT JOIN dish_ingredients di ON di.dish_id = d.id
      LEFT JOIN inventory_items ii  ON ii.id = di.inventory_item_id AND ii.business_id = $1
      WHERE d.business_id = $1
      GROUP BY d.id, d.name, d.selling_price
    ) per_dish
    GROUP BY dname
  )`;

/** Normalised-name expression, for host queries that need to join on it. */
function normName(col) {
  return NORM_NAME.replace('%s', col);
}

module.exports = {
  INGREDIENT_SOURCE_CTE,
  INGREDIENT_COST_CTE,
  DISH_COST_BY_NAME_CTE,
  normName,
};
