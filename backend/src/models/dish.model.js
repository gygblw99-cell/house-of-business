const db = require('../utils/db');
const { convertQty } = require('../utils/unitConversion');

// כל המנות עם עלות מחושבת (מתכונים + מרכיבים ישירים + ליווי)
async function findAllByBusiness(businessId) {
  // Try full query with dish_ingredients; fall back to simple query if table doesn't exist yet
  try {
    const { rows } = await db.query(
      `WITH recipe_cost AS (
         SELECT r.id, COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0)), 0)::float AS cost
         FROM recipes r
         LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
         LEFT JOIN inventory_items ii    ON ii.id = ri.item_id
         GROUP BY r.id
       )
       SELECT d.id, d.name, d.selling_price, d.notes, COALESCE(d.dish_type,'both') AS dish_type, d.category,
              (COALESCE(recipe_sum.cost,0) + COALESCE(ing_sum.cost,0) + COALESCE(acc_sum.cost,0))::float AS cost,
              (d.selling_price - COALESCE(recipe_sum.cost,0) - COALESCE(ing_sum.cost,0) - COALESCE(acc_sum.cost,0))::float AS profit,
              CASE WHEN d.selling_price > 0
                   THEN ROUND(((d.selling_price - COALESCE(recipe_sum.cost,0) - COALESCE(ing_sum.cost,0) - COALESCE(acc_sum.cost,0))
                                / d.selling_price * 100)::numeric, 1)::float
                   ELSE 0 END AS margin,
              COUNT(DISTINCT dr.recipe_id)::int AS recipe_count,
              COALESCE(recipe_list.recipes, '[]'::jsonb) AS recipes
       FROM dishes d
       LEFT JOIN dish_recipes dr ON dr.dish_id = d.id
       LEFT JOIN (
         SELECT dr2.dish_id,
                SUM(recipe_cost.cost * dr2.qty) AS cost
         FROM dish_recipes dr2
         LEFT JOIN recipe_cost ON recipe_cost.id = dr2.recipe_id
         GROUP BY dr2.dish_id
       ) recipe_sum ON recipe_sum.dish_id = d.id
       LEFT JOIN (
         SELECT di.dish_id,
                SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)) AS cost
         FROM dish_ingredients di
         LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id
         GROUP BY di.dish_id
       ) ing_sum ON ing_sum.dish_id = d.id
       LEFT JOIN (
         SELECT da.dish_id,
                SUM(da.qty * COALESCE(ii.cost_per_unit, da.manual_cost, 0)) AS cost
         FROM dish_accompaniments da
         LEFT JOIN inventory_items ii ON ii.id = da.inventory_item_id
         GROUP BY da.dish_id
       ) acc_sum ON acc_sum.dish_id = d.id
       LEFT JOIN (
         SELECT dr3.dish_id,
                jsonb_agg(jsonb_build_object(
                  'recipe_id',   r3.id,
                  'recipe_name', r3.name,
                  'qty',         dr3.qty,
                  'recipe_cost', COALESCE(recipe_cost.cost, 0)
                ) ORDER BY r3.name) AS recipes
         FROM dish_recipes dr3
         INNER JOIN recipes r3 ON r3.id = dr3.recipe_id
         LEFT JOIN recipe_cost ON recipe_cost.id = r3.id
         GROUP BY dr3.dish_id
       ) recipe_list ON recipe_list.dish_id = d.id
       WHERE d.business_id = $1 AND (d.is_active IS NULL OR d.is_active = TRUE)
       GROUP BY d.id, d.name, d.selling_price, d.notes, d.dish_type, d.category, recipe_sum.cost, ing_sum.cost, acc_sum.cost, recipe_list.recipes
       ORDER BY d.name`,
      [businessId]
    );
    return rows;
  } catch (_) {
    // dish_ingredients table may not exist yet — return dishes without ingredient cost
    const { rows } = await db.query(
      `SELECT d.id, d.name, d.selling_price, d.notes,
              0::float AS cost, d.selling_price::float AS profit,
              0::float AS margin, 0::int AS recipe_count, '[]'::jsonb AS recipes
       FROM dishes d WHERE d.business_id = $1 AND (d.is_active IS NULL OR d.is_active = TRUE) ORDER BY d.name`,
      [businessId]
    );
    return rows;
  }
}

// מנה בודדת עם רשימת מתכונים
async function findById(dishId, businessId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.selling_price, d.notes, COALESCE(d.dish_type,'both') AS dish_type, d.category, d.recipe_text FROM dishes d
     WHERE d.id = $1 AND d.business_id = $2`,
    [dishId, businessId]
  );
  if (!rows.length) return null;

  const { rows: recipes } = await db.query(
    `SELECT dr.id, dr.qty, r.id AS recipe_id, r.name AS recipe_name,
            r.selling_price AS recipe_price,
            COALESCE(SUM(ri.qty * COALESCE(ii.cost_per_unit, ri.manual_cost, 0)), 0)::float AS recipe_cost
     FROM dish_recipes dr
     INNER JOIN recipes r ON r.id = dr.recipe_id
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN inventory_items ii    ON ii.id = ri.item_id
     WHERE dr.dish_id = $1
     GROUP BY dr.id, dr.qty, r.id, r.name, r.selling_price
     ORDER BY r.name`,
    [dishId]
  );

  let ingredients = [];
  try {
    const { rows: ingRows } = await db.query(
      `SELECT di.id, di.qty, di.unit, di.name AS ingredient_name,
              di.inventory_item_id,
              COALESCE(ii.cost_per_unit, di.manual_cost)::float AS unit_cost,
              (di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0))::float AS line_cost
       FROM dish_ingredients di
       LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id
       WHERE di.dish_id = $1
       ORDER BY di.name`,
      [dishId]
    );
    ingredients = ingRows;
  } catch (_) { /* dish_ingredients table may not exist yet */ }

  let packaging = [];
  try {
    const { rows: pkgRows } = await db.query(
      `SELECT dp.id, dp.order_type, dp.item_name, dp.qty, dp.unit, dp.inventory_item_id
       FROM dish_packaging dp
       WHERE dp.dish_id = $1
       ORDER BY dp.order_type, dp.item_name`,
      [dishId]
    );
    packaging = pkgRows;
  } catch (_) { /* dish_packaging table may not exist yet */ }

  let accompaniments = [];
  try {
    const { rows: accRows } = await db.query(
      `SELECT da.id, da.order_type, da.item_name, da.qty, da.unit, da.inventory_item_id,
              da.manual_cost,
              COALESCE(ii.cost_per_unit, da.manual_cost)::float AS unit_cost,
              (da.qty * COALESCE(ii.cost_per_unit, da.manual_cost, 0))::float AS line_cost
       FROM dish_accompaniments da
       LEFT JOIN inventory_items ii ON ii.id = da.inventory_item_id
       WHERE da.dish_id = $1
       ORDER BY da.order_type, da.item_name`,
      [dishId]
    );
    accompaniments = accRows;
  } catch (_) { /* dish_accompaniments table may not exist yet */ }

  return { ...rows[0], recipes, ingredients, packaging, accompaniments };
}

async function create(businessId, { name, sellingPrice, notes, dishType, recipeText, category }) {
  const { rows } = await db.query(
    `INSERT INTO dishes (business_id, name, selling_price, notes, dish_type, recipe_text, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [businessId, name, parseFloat(sellingPrice || 0), notes || null, dishType || 'both', recipeText || null, category || null]
  );
  return rows[0];
}

async function update(dishId, businessId, { name, sellingPrice, notes, dishType, recipeText, category }) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (name         !== undefined) { sets.push(`name=$${i++}`);          vals.push(name); }
  if (sellingPrice !== undefined) { sets.push(`selling_price=$${i++}`); vals.push(parseFloat(sellingPrice)); }
  if (notes        !== undefined) { sets.push(`notes=$${i++}`);         vals.push(notes); }
  if (dishType     !== undefined) { sets.push(`dish_type=$${i++}`);     vals.push(dishType); }
  if (recipeText   !== undefined) { sets.push(`recipe_text=$${i++}`);   vals.push(recipeText || null); }
  if (category     !== undefined) { sets.push(`category=$${i++}`);      vals.push(category || null); }
  if (!sets.length) return findById(dishId, businessId);
  vals.push(dishId, businessId);

  // Need the pre-update name so a rename can re-target the shadow recipes row below
  let oldName = null;
  if (name !== undefined) {
    const { rows: cur } = await db.query('SELECT name FROM dishes WHERE id=$1 AND business_id=$2', [dishId, businessId]);
    oldName = cur[0]?.name || null;
  }

  const { rows } = await db.query(
    `UPDATE dishes SET ${sets.join(',')}, updated_at=NOW()
     WHERE id=$${i} AND business_id=$${i+1} RETURNING *`,
    vals
  );

  // remove()/bulkRemove() below link a dish to its same-named `recipes` row
  // (created for sale_items.recipe_id) by LOWER(name) match. Renaming the
  // dish without renaming its shadow recipe row breaks that link silently —
  // a later delete would look for the *new* name and never find/deactivate
  // the stale recipe row, which then keeps showing up in every report/insight
  // that reads sale_items.recipe_id as if the dish were still live.
  if (rows[0] && name !== undefined && oldName && oldName.toLowerCase() !== name.toLowerCase()) {
    await db.query(
      `UPDATE recipes SET name = $1, updated_at = NOW()
       WHERE business_id = $2 AND LOWER(name) = LOWER($3) AND (is_active IS NULL OR is_active = TRUE)`,
      [name, businessId, oldName]
    );
  }

  return rows[0];
}

async function remove(dishId, businessId) {
  const { rows } = await db.query(
    `UPDATE dishes SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
     WHERE id=$1 AND business_id=$2
     RETURNING name`,
    [dishId, businessId]
  );
  // A dish and a same-named `recipes` row are two independent tables (the
  // recipe exists only so sale_items can carry a cost-linkable recipe_id) —
  // deleting the dish must also deactivate its recipe counterpart, or every
  // report/insight that reads sale_items.recipe_id keeps treating the
  // "deleted" dish as still live forever.
  if (rows[0]?.name) {
    await db.query(
      `UPDATE recipes SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
       WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND (is_active IS NULL OR is_active = TRUE)`,
      [businessId, rows[0].name]
    );
  }
}

// ── מנות מחוקות (ארכיון) ──────────────────────────────────────────────
// remove()/bulkRemove() הן מחיקה רכה, אבל עד עכשיו לא היה שום מסלול חזרה:
// המנה נעלמת מעמוד המנות, והשאיבה מדוחות Z מכבדת את המחיקה ולא יוצרת אותה
// מחדש (zreport.import.service.js — "רק אם אין מנה פעילה או ארכיבית"). מנה
// שממשיכה להימכר בקופה נשארה לכן בלתי-נראית לנצח: אי אפשר להגדיר לה מרכיבים,
// היא לא מנכה מלאי, ובכל דוח Z נוצרה עליה התראת "מרכיבים חסרים" שאין לה פתרון.
//
// כמות המכירות ב-90 יום מוחזרת יחד עם כל מנה כדי שבעל העסק יראה מיד *אילו*
// מנות מחוקות עדיין נמכרות בפועל — אלו היחידות שכדאי לשחזר.
async function findArchivedByBusiness(businessId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.selling_price::float AS selling_price, d.category,
            d.archived_at,
            COALESCE(sold.units,   0)::float AS units_90d,
            COALESCE(sold.revenue, 0)::float AS revenue_90d,
            COALESCE(sold.reports, 0)::int   AS reports_90d,
            (SELECT COUNT(*)::int FROM dish_ingredients di
              WHERE di.dish_id = d.id AND di.inventory_item_id IS NOT NULL) AS linked_ingredients
     FROM dishes d
     LEFT JOIN (
       SELECT regexp_replace(trim(lower(si.name)), '\\s+', ' ', 'g') AS lname,
              SUM(si.qty)                    AS units,
              SUM(si.total_price)            AS revenue,
              COUNT(DISTINCT si.sale_id)     AS reports
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id AND s.business_id = $1
       WHERE s.sold_at >= NOW() - INTERVAL '90 days'
       GROUP BY 1
     ) sold ON sold.lname = regexp_replace(trim(lower(d.name)), '\\s+', ' ', 'g')
     WHERE d.business_id = $1 AND d.is_active = FALSE
     ORDER BY COALESCE(sold.revenue, 0) DESC, d.name`,
    [businessId]
  );
  return rows;
}

// ביטול המחיקה. תמונת-מראה של remove(): גם ה-recipe הצל בעל אותו שם חוזר
// לחיים, אחרת sale_items.recipe_id ימשיך להצביע על recipe מבוטל והמנה
// המשוחזרת תיראה פעילה בעמוד המנות אבל לא תיקשר לשום מכירה.
async function restore(dishId, businessId) {
  const { rows } = await db.query(
    `UPDATE dishes SET is_active = TRUE, archived_at = NULL, updated_at = NOW()
     WHERE id = $1 AND business_id = $2 AND is_active = FALSE
     RETURNING id, name`,
    [dishId, businessId]
  );
  if (!rows[0]) return null;
  await db.query(
    `UPDATE recipes SET is_active = TRUE, archived_at = NULL, updated_at = NOW()
     WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND is_active = FALSE`,
    [businessId, rows[0].name]
  );
  return rows[0];
}

// עדכון מתכונים במנה (מחיקה ובנייה מחדש) — bulk INSERT, wrapped in transaction
// businessId מאומת כאן (לא רק ב-route הקורא) — הפונקציה בטוחה בפני עצמה
// גם אם קורא עתידי ישכח לבדוק בעלות לפני הקריאה
async function setRecipes(dishId, businessId, recipes) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT 1 FROM dishes WHERE id=$1 AND business_id=$2', [dishId, businessId]);
    if (!owns.rows.length) { await client.query('ROLLBACK'); return; }
    await client.query('DELETE FROM dish_recipes WHERE dish_id=$1', [dishId]);
    if (Array.isArray(recipes) && recipes.length) {
      const vals = [], params = [];
      recipes.forEach((r, i) => {
        const b = i * 3;
        vals.push(`($${b+1},$${b+2},$${b+3})`);
        params.push(dishId, r.recipeId, parseFloat(r.qty) || 1);
      });
      await client.query(
        `INSERT INTO dish_recipes (dish_id, recipe_id, qty) VALUES ${vals.join(',')}
         ON CONFLICT (dish_id, recipe_id) DO UPDATE SET qty=EXCLUDED.qty`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Returns a Set of the given ids that actually belong to this business —
// used to drop (not trust) a cross-tenant inventoryItemId instead of letting
// it silently pull another business's cost_per_unit into this dish's cost.
async function _ownedInventoryIds(client, businessId, ids) {
  const distinct = [...new Set(ids.filter(Boolean))];
  if (!distinct.length) return new Set();
  const { rows } = await client.query(
    'SELECT id FROM inventory_items WHERE business_id = $1 AND id = ANY($2::uuid[])',
    [businessId, distinct]
  );
  return new Set(rows.map(r => r.id));
}

async function setIngredients(dishId, businessId, ingredients) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT 1 FROM dishes WHERE id=$1 AND business_id=$2', [dishId, businessId]);
    if (!owns.rows.length) { await client.query('ROLLBACK'); return; }
    await client.query('DELETE FROM dish_ingredients WHERE dish_id=$1', [dishId]);
    if (Array.isArray(ingredients) && ingredients.length) {
      const candidateIds = [...new Set(ingredients.map(i => i.inventoryItemId).filter(Boolean))];
      let ownedUnits = new Map(); // id -> inventory_items.unit
      if (candidateIds.length) {
        const { rows } = await client.query(
          'SELECT id, unit FROM inventory_items WHERE business_id = $1 AND id = ANY($2::uuid[])',
          [businessId, candidateIds]
        );
        ownedUnits = new Map(rows.map(r => [r.id, r.unit]));
      }
      const vals = [], params = [];
      ingredients.forEach((ing, i) => {
        let itemId = ing.inventoryItemId && ownedUnits.has(ing.inventoryItemId) ? ing.inventoryItemId : null;
        let qty  = parseFloat(ing.qty) || 1;
        let unit = ing.unit || null;

        // findAllByBusiness/findById compute qty * ii.cost_per_unit with no
        // unit conversion, but the editor lets the user pick any unit in the
        // same family for display (e.g. grams for an item stocked in kg) — so
        // qty must be converted into the inventory item's own unit here, at
        // write time, or a 1000x-scale cost error is stored silently.
        if (itemId) {
          const invUnit = ownedUnits.get(itemId);
          const converted = convertQty(qty, unit, invUnit);
          if (converted !== null) {
            qty  = converted;
            unit = invUnit;
          } else {
            itemId = null;
          }
        }

        const b = i * 6;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`);
        params.push(
          dishId, itemId, ing.name || null,
          qty, unit,
          ing.manualCost != null ? parseFloat(ing.manualCost) : null
        );
      });
      await client.query(
        `INSERT INTO dish_ingredients (dish_id, inventory_item_id, name, qty, unit, manual_cost)
         VALUES ${vals.join(',')}`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setPackaging(dishId, businessId, packagingItems) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT 1 FROM dishes WHERE id=$1 AND business_id=$2', [dishId, businessId]);
    if (!owns.rows.length) { await client.query('ROLLBACK'); return; }
    await client.query('DELETE FROM dish_packaging WHERE dish_id=$1', [dishId]);
    if (Array.isArray(packagingItems) && packagingItems.length) {
      const ownedIds = await _ownedInventoryIds(client, businessId, packagingItems.map(p => p.inventoryItemId));
      const vals   = [];
      const params = [];
      packagingItems.forEach((p, i) => {
        const base = i * 6;
        vals.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`);
        params.push(
          dishId,
          p.order_type || 'both',
          ownedIds.has(p.inventoryItemId) ? p.inventoryItemId : null,
          p.item_name || null,
          parseFloat(p.qty) || 1,
          p.unit || null
        );
      });
      await client.query(
        `INSERT INTO dish_packaging (dish_id, order_type, inventory_item_id, item_name, qty, unit) VALUES ${vals.join(',')}`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setAccompaniments(dishId, businessId, accompanimentItems) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const owns = await client.query('SELECT 1 FROM dishes WHERE id=$1 AND business_id=$2', [dishId, businessId]);
    if (!owns.rows.length) { await client.query('ROLLBACK'); return; }
    await client.query('DELETE FROM dish_accompaniments WHERE dish_id=$1', [dishId]);
    if (Array.isArray(accompanimentItems) && accompanimentItems.length) {
      const candidateIds = [...new Set(accompanimentItems.map(a => a.inventoryItemId).filter(Boolean))];
      let ownedUnits = new Map(); // id -> inventory_items.unit
      if (candidateIds.length) {
        const { rows } = await client.query(
          'SELECT id, unit FROM inventory_items WHERE business_id = $1 AND id = ANY($2::uuid[])',
          [businessId, candidateIds]
        );
        ownedUnits = new Map(rows.map(r => [r.id, r.unit]));
      }
      const vals   = [];
      const params = [];
      accompanimentItems.forEach((a, i) => {
        let itemId = a.inventoryItemId && ownedUnits.has(a.inventoryItemId) ? a.inventoryItemId : null;
        let qty  = parseFloat(a.qty) || 1;
        let unit = a.unit || null;

        // qty must be converted into the inventory item's own unit at write time —
        // same guard as setIngredients — otherwise a 1000x-scale cost/deduction
        // error is stored silently when the recipe unit differs from the stock unit.
        if (itemId) {
          const invUnit = ownedUnits.get(itemId);
          const converted = convertQty(qty, unit, invUnit);
          if (converted !== null) {
            qty  = converted;
            unit = invUnit;
          } else {
            // Incompatible unit families (e.g. grams vs units) — drop the inventory
            // link; the item is saved as manual-cost-only without deduction.
            itemId = null;
          }
        }

        const base = i * 7;
        vals.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`);
        params.push(
          dishId,
          a.order_type || 'both',
          itemId,
          a.item_name || null,
          qty,
          unit,
          a.manualCost != null ? parseFloat(a.manualCost) : null
        );
      });
      await client.query(
        `INSERT INTO dish_accompaniments (dish_id, order_type, inventory_item_id, item_name, qty, unit, manual_cost)
         VALUES ${vals.join(',')}`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function bulkRemove(dishIds, businessId) {
  if (!dishIds.length) return [];
  const { rows: deleted } = await db.query(
    `UPDATE dishes SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
     WHERE id = ANY($1::uuid[]) AND business_id = $2
     RETURNING name`,
    [dishIds, businessId]
  );
  if (deleted.length) {
    await db.query(
      `UPDATE recipes SET is_active = FALSE, archived_at = NOW(), updated_at = NOW()
       WHERE business_id = $1 AND LOWER(name) = ANY($2::text[]) AND (is_active IS NULL OR is_active = TRUE)`,
      [businessId, deleted.map(r => r.name.toLowerCase())]
    );
  }
  return deleted;
}

module.exports = { findAllByBusiness, findArchivedByBusiness, findById, create, update, remove, bulkRemove, restore, setRecipes, setIngredients, setPackaging, setAccompaniments };
