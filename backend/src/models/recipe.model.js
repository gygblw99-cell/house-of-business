/**
 * Recipe Model
 * ניהול מתכונים + חישוב עלות ורווח
 */

const db = require('../utils/db');
const { convertQty } = require('../utils/unitConversion');

// כל המתכונים עם עלות ורווח מחושבים
async function findAllByBusiness(businessId) {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.selling_price, r.pos_item_id,
            rc.name AS category,
            COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0)::float AS cost,
            (r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0))::float AS profit,
            CASE WHEN r.selling_price > 0
                 THEN ROUND(((r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0))
                              / r.selling_price * 100)::numeric, 1)::float
                 ELSE 0 END AS margin
     FROM recipes r
     LEFT JOIN recipe_categories rc  ON rc.id = r.category_id
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN inventory_items ii    ON ii.id = ri.item_id
     WHERE r.business_id = $1 AND (r.is_active IS NULL OR r.is_active = TRUE)
     GROUP BY r.id, r.name, r.selling_price, r.pos_item_id, rc.name
     ORDER BY r.name`,
    [businessId]
  );
  return rows;
}

// מתכון בודד עם רשימת מרכיבים
async function findById(recipeId, businessId) {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.selling_price, r.pos_item_id,
            rc.name AS category,
            COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0)), 0)::float AS cost,
            (r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0)), 0))::float AS profit
     FROM recipes r
     LEFT JOIN recipe_categories rc  ON rc.id = r.category_id
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN inventory_items ii    ON ii.id = ri.item_id
     WHERE r.id = $1 AND r.business_id = $2
     GROUP BY r.id, r.name, r.selling_price, r.pos_item_id, rc.name`,
    [recipeId, businessId]
  );
  if (!rows.length) return null;

  // רשימת מרכיבים (כולל ידניים + manual_cost)
  const { rows: ingredients } = await db.query(
    `SELECT ri.id, ri.qty, ri.unit,
            ii.id AS item_id, COALESCE(ii.name, ri.manual_name) AS item_name,
            COALESCE(ii.cost_per_unit, ri.manual_cost) AS cost_per_unit,
            ri.manual_cost,
            (ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0))::float AS line_cost,
            ri.manual_name,
            (ri.item_id IS NULL) AS is_manual
     FROM recipe_ingredients ri
     LEFT JOIN inventory_items ii ON ii.id = ri.item_id
     WHERE ri.recipe_id = $1
     ORDER BY item_name`,
    [recipeId]
  );

  return { ...rows[0], ingredients };
}

// יצירת מתכון
async function create(businessId, { name, sellingPrice, categoryId, posItemId }) {
  const { rows } = await db.query(
    `INSERT INTO recipes (business_id, name, selling_price, category_id, pos_item_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [businessId, name, parseFloat(sellingPrice || 0),
     categoryId || null, posItemId || null]
  );
  return rows[0];
}

// עדכון מתכון
async function update(recipeId, businessId, fields) {
  const mapping = {
    name:        'name',
    sellingPrice:'selling_price',
    categoryId:  'category_id',
    posItemId:   'pos_item_id',
  };

  const sets   = [];
  const values = [];
  let   idx    = 1;

  for (const [key, col] of Object.entries(mapping)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${idx++}`);
      values.push(key === 'sellingPrice' ? parseFloat(fields[key]) : fields[key]);
    }
  }

  if (!sets.length) return findById(recipeId, businessId);

  values.push(recipeId, businessId);
  const { rows } = await db.query(
    `UPDATE recipes SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${idx} AND business_id = $${idx + 1} RETURNING *`,
    values
  );
  return rows[0];
}

// מחיקת מתכון — soft delete (שומר היסטוריה, מנתק מ-sale_items ע"י FK SET NULL)
async function remove(recipeId, businessId) {
  await db.query(
    `UPDATE recipes SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND business_id = $2`,
    [recipeId, businessId]
  );
}

// ── מרכיבים ───────────────────────────────────────────────────

// businessId מאומת כאן (לא רק ב-route הקורא) — הפונקציה בטוחה בפני עצמה
// גם אם קורא עתידי ישכח לבדוק בעלות לפני הקריאה
// Returns the number of ingredients actually persisted — the caller (route)
// uses this instead of ingredients.length to decide whether the recipe is
// still missing ingredients, since a cross-tenant/unowned itemId is dropped
// rather than inserted.
async function setIngredients(recipeId, businessId, ingredients) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT 1 FROM recipes WHERE id=$1 AND business_id=$2', [recipeId, businessId]);
    if (!owns.rows.length) { await client.query('ROLLBACK'); return 0; }
    await client.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1', [recipeId]);
    if (!ingredients?.length) { await client.query('COMMIT'); return 0; }

    // Verify every referenced inventory item actually belongs to this business
    // before linking it — otherwise a caller-supplied itemId from another
    // tenant passes the FK constraint (it just checks existence) and its
    // cost_per_unit silently leaks into this recipe's cost/margin analysis.
    // Also fetch its unit — see the conversion step below.
    const candidateIds = [...new Set(ingredients.map(ing => ing.inventoryItemId || ing.itemId).filter(Boolean))];
    let ownedUnits = new Map(); // id -> inventory_items.unit
    if (candidateIds.length) {
      const { rows } = await client.query(
        'SELECT id, unit FROM inventory_items WHERE business_id = $1 AND id = ANY($2::uuid[])',
        [businessId, candidateIds]
      );
      ownedUnits = new Map(rows.map(r => [r.id, r.unit]));
    }

    // Every row is kept, never dropped — an itemId that fails ownership
    // (e.g. it belongs to another business, or its inventory item was since
    // deleted) degrades to a manual entry (item_id=NULL) using the row's own
    // name/cost, the same way a genuinely-manual row (no itemId at all)
    // already does, instead of silently losing the ingredient entirely.
    const valid = ingredients;
    if (valid.length) {
      const vals   = valid.map((_, i) => { const b = i * 6; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`; }).join(',');
      const params = valid.flatMap(ing => {
        const rawItemId = ing.inventoryItemId || ing.itemId || null;
        let itemId = rawItemId && ownedUnits.has(rawItemId) ? rawItemId : null;
        let qty  = parseFloat(ing.qty) || 0;
        let unit = ing.unit || null;

        // The cost queries (recipe.model.js findAllByBusiness/findById,
        // getProfitAnalysis) compute qty * ii.cost_per_unit with no unit
        // conversion, but the recipe editor lets the user pick any unit in
        // the same family for display (e.g. grams for an item stocked in kg)
        // — so qty must be converted into the inventory item's own unit here,
        // at write time, or a 1000x-scale cost error is stored silently.
        if (itemId) {
          const invUnit = ownedUnits.get(itemId);
          const converted = convertQty(qty, unit, invUnit);
          if (converted !== null) {
            qty  = converted;
            unit = invUnit;
          } else {
            // Can't safely convert (unresolvable/incompatible unit) — degrade
            // to manual rather than storing a qty that would silently multiply
            // against a price denominated in a different unit.
            itemId = null;
          }
        }

        const manualName = (!itemId && ing.name) ? ing.name : (ing.manual_name || null);
        const manualCost = ing.manualCost != null ? parseFloat(ing.manualCost) : null;
        return [recipeId, itemId, qty, unit, manualName, manualCost];
      });
      await client.query(
        `INSERT INTO recipe_ingredients (recipe_id, item_id, qty, unit, manual_name, manual_cost) VALUES ${vals}`,
        params
      );
    }
    await client.query('COMMIT');
    return valid.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── קטגוריות ──────────────────────────────────────────────────

async function getCategories(businessId) {
  const { rows } = await db.query(
    `SELECT rc.id, rc.name, rc.pos_category_id,
            COUNT(r.id)::int AS recipe_count
     FROM recipe_categories rc
     LEFT JOIN recipes r ON r.category_id = rc.id
     WHERE rc.business_id = $1
     GROUP BY rc.id, rc.name, rc.pos_category_id
     ORDER BY rc.name`,
    [businessId]
  );
  return rows;
}

async function createCategory(businessId, { name, posCategoryId }) {
  const { rows } = await db.query(
    `INSERT INTO recipe_categories (business_id, name, pos_category_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (business_id, pos_category_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [businessId, name, posCategoryId || null]
  );
  return rows[0];
}

// ── ניתוח רווחיות ─────────────────────────────────────────────

async function getProfitAnalysis(businessId) {
  const { rows } = await db.query(
    `SELECT r.name, r.selling_price,
            COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0)::float AS cost,
            (r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0))::float AS profit,
            CASE WHEN r.selling_price > 0
                 THEN ROUND(((r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0))
                              / r.selling_price * 100)::numeric, 1)
                 ELSE 0 END AS margin,
            COALESCE(si.total_qty, 0) AS units_sold_30d,
            COALESCE(si.total_qty * (r.selling_price - COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost)), 0)),0)::float AS profit_contribution
     FROM recipes r
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN inventory_items ii    ON ii.id = ri.item_id
     LEFT JOIN (
       SELECT name, SUM(qty)::float AS total_qty
       FROM sale_items si2
       INNER JOIN sales s ON s.id = si2.sale_id
       WHERE s.business_id = $1 AND s.sold_at >= NOW() - INTERVAL '30 days'
       GROUP BY name
     ) si ON LOWER(si.name) = LOWER(r.name)
     WHERE r.business_id = $1
     GROUP BY r.id, r.name, r.selling_price, si.total_qty
     ORDER BY profit_contribution DESC`,
    [businessId]
  );
  return rows;
}

module.exports = {
  findAllByBusiness, findById, create, update, remove,
  setIngredients, getCategories, createCategory, getProfitAnalysis,
};
