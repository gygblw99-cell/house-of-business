/**
 * Inventory Model
 * ניהול מלאי — פריטים, קטגוריות, תנועות, בזבוז
 */

const db = require('../utils/db');

// ── פריטי מלאי ────────────────────────────────────────────────

async function findAllByBusiness(businessId, { categoryId, lowStock, limit, offset = 0 } = {}) {
  const conditions = ['ii.business_id = $1'];
  const values     = [businessId];
  let   idx        = 2;

  if (categoryId) {
    conditions.push(`ii.category_id = $${idx++}`);
    values.push(categoryId);
  }
  if (lowStock) {
    conditions.push(`ii.current_qty <= ii.min_qty AND ii.min_qty > 0`);
  }

  let limitClause = '';
  if (limit != null) {
    values.push(limit, offset);
    limitClause = ` LIMIT $${idx++} OFFSET $${idx++}`;
  }

  const { rows } = await db.query(
    `SELECT ii.id, ii.name, ii.unit, ii.current_qty::float AS current_qty, ii.min_qty::float AS min_qty,
            COALESCE(ii.max_qty, 0)::float AS max_qty,
            ii.cost_per_unit::float AS cost_per_unit, ii.expiry_date,
            COALESCE(ii.item_type, 'מזון') AS item_type,
            ii.purchase_unit,
            COALESCE(ii.units_per_purchase, 1)::float AS units_per_purchase,
            ic.name AS category,
            CASE WHEN ii.min_qty > 0 AND ii.current_qty <= ii.min_qty
                 THEN TRUE ELSE FALSE END AS is_low,
            CASE WHEN ii.expiry_date IS NOT NULL AND ii.expiry_date <= CURRENT_DATE + 3
                 THEN TRUE ELSE FALSE END AS is_expiring_soon,
            CASE WHEN ii.expiry_date IS NOT NULL AND ii.expiry_date < CURRENT_DATE
                 THEN TRUE ELSE FALSE END AS is_expired
     FROM inventory_items ii
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ic.name, ii.name${limitClause}`,
    values
  );
  return rows;
}

async function findById(itemId, businessId) {
  const { rows } = await db.query(
    `SELECT ii.id, ii.name, ii.unit, ii.current_qty::float AS current_qty, ii.min_qty::float AS min_qty,
            COALESCE(ii.max_qty, 0)::float AS max_qty,
            ii.cost_per_unit::float AS cost_per_unit, ii.expiry_date,
            COALESCE(ii.item_type, 'מזון') AS item_type,
            ii.purchase_unit,
            COALESCE(ii.units_per_purchase, 1)::float AS units_per_purchase,
            ic.name AS category, ic.id AS category_id
     FROM inventory_items ii
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ii.id = $1 AND ii.business_id = $2`,
    [itemId, businessId]
  );
  return rows[0] || null;
}

async function create(businessId, { name, unit, currentQty, minQty, costPerUnit, categoryId, expiryDate, userId, itemType, purchaseUnit, unitsPerPurchase }) {
  const qty  = parseFloat(currentQty  || 0);
  const cost = parseFloat(costPerUnit || 0);

  const { rows } = await db.query(
    `INSERT INTO inventory_items
       (business_id, name, unit, current_qty, min_qty, cost_per_unit, category_id, expiry_date, item_type, purchase_unit, units_per_purchase)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [businessId, name, unit || 'יח׳',
     qty, parseFloat(minQty || 0),
     cost, categoryId || null,
     expiryDate || null,
     itemType || 'מזון',
     purchaseUnit || null,
     parseFloat(unitsPerPurchase || 1) || 1]
  );

  // כמות פתיחה עם עלות ידועה = כסף שכבר יצא מהעסק, גם בלי חשבונית ספק (למשל מלאי
  // פתיחה בהקמת חשבון). נרשמת כתנועת 'purchase' כדי שתסתנכרן עם עלות הסחורה
  // בדוחות הפיננסיים באותה דרך שחשבוניות ספק כבר מסתנכרנות.
  if (qty > 0 && cost > 0) {
    await db.query(
      `INSERT INTO inventory_transactions (business_id, item_id, type, qty_change, qty_after, reason, reported_by)
       VALUES ($1,$2,'purchase',$3,$3,'מלאי פתיחה',$4)`,
      [businessId, rows[0].id, qty, userId || null]
    );
  }

  return rows[0];
}

async function update(itemId, businessId, fields) {
  const mapping = {
    name:             'name',
    unit:             'unit',
    currentQty:       'current_qty',
    minQty:           'min_qty',
    maxQty:           'max_qty',
    costPerUnit:      'cost_per_unit',
    categoryId:       'category_id',
    expiryDate:       'expiry_date',
    itemType:         'item_type',
    purchaseUnit:     'purchase_unit',
    unitsPerPurchase: 'units_per_purchase',
  };

  const sets   = [];
  const values = [];
  let   idx    = 1;

  for (const [key, col] of Object.entries(mapping)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${idx++}`);
      const numericFields = ['currentQty','minQty','maxQty','costPerUnit','unitsPerPurchase'];
      values.push(numericFields.includes(key) ? parseFloat(fields[key]) : fields[key]);
    }
  }

  if (!sets.length) return findById(itemId, businessId);

  values.push(itemId, businessId);
  const { rows } = await db.query(
    `UPDATE inventory_items SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${idx} AND business_id = $${idx + 1} RETURNING *`,
    values
  );
  return rows[0];
}

async function remove(itemId, businessId) {
  const { rows } = await db.query(
    'DELETE FROM inventory_items WHERE id = $1 AND business_id = $2 RETURNING id',
    [itemId, businessId]
  );
  return rows[0] || null; // null אם לא נמצא/נמחק
}

// ── תנועות מלאי ───────────────────────────────────────────────

async function recordTransaction(businessId, { itemId, type, qtyChange, note, userId, date }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // עדכון כמות קודם — מניעת כמות שלילית ברמת DB (אטומי, עמיד לפני race condition).
    // מריצים לפני ה-INSERT כדי לקבל את qty_after (עמודת NOT NULL בטבלת התנועות).
    const delta = parseFloat(qtyChange);
    const { rows: updated, rowCount } = await client.query(
      `UPDATE inventory_items
       SET current_qty = current_qty + $1, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
         AND (current_qty + $1 >= 0)
       RETURNING current_qty`,
      [delta, itemId, businessId]
    );
    if (rowCount === 0) {
      const err = new Error('כמות במלאי אינה מספיקה לביצוע הפחתה');
      err.statusCode = 409;
      throw err;
    }

    // תאריך מדווח אופציונלי (למשל דיווח בזבוז מרוכז על טווח של עד שבוע
    // אחורה) — מוגבל בין היום ועד 7 ימים אחורה כדי שלא ישפיע על דוחות של
    // תקופות אחרות/עתידיות. ללא ערך — כרגיל, ברירת המחדל של העמודה (NOW()).
    let createdAt = null;
    if (date) {
      const parsed = new Date(date);
      const now = new Date();
      const minDate = new Date(now.getTime() - 7 * 86400000);
      if (!isNaN(parsed.getTime()) && parsed <= now && parsed >= minDate) {
        createdAt = parsed;
      }
    }

    // שמירת תנועה
    const { rows } = await client.query(
      `INSERT INTO inventory_transactions
         (business_id, item_id, type, qty_change, qty_after, reason, reported_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, NOW())) RETURNING *`,
      [businessId, itemId, type, delta, updated[0].current_qty, note || null, userId || null, createdAt]
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── ספירת מלאי פיזית ──────────────────────────────────────────
/**
 * Records a physical stock count: the user states what is actually on the
 * shelf, and each item gets ONE transaction carrying the delta needed to reach
 * that number, with type='stocktake'.
 *
 * Why this exists: every other quantity in the system is derived. Purchases
 * come from invoices, and the per-sale deductions are computed from the recipes
 * — which is the same input the leakage agent uses to predict consumption. So
 * "expected vs actual" was comparing the recipe math against itself and could
 * never surface a gap. A counted shelf is the one measurement that is
 * independent of the recipes, and it's what turns leak detection from a
 * tautology into an actual measurement.
 *
 * The whole count is one transaction (BEGIN/COMMIT): a half-applied count would
 * leave the leakage window straddling two different physical realities, which is
 * worse than no count at all.
 *
 * Note the deliberate absence of the `current_qty + delta >= 0` guard that
 * recordTransaction enforces — a count is an assertion about reality, not a
 * withdrawal. Counted quantities are validated as >= 0 by the caller; the
 * resulting delta is negative whenever the shelf holds less than the books say,
 * which is precisely the case this feature exists to record.
 */
async function recordStocktake(businessId, { items, userId, note }) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('לא נשלחו פריטים לספירה');
    err.statusCode = 400;
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock + read the current quantities of exactly the items being counted, so
    // a concurrent sale deduction can't land between the read and the write and
    // make qty_after disagree with inventory_items.current_qty.
    const ids = items.map(i => i.itemId);
    const { rows: current } = await client.query(
      `SELECT id, name, current_qty, cost_per_unit, unit
       FROM inventory_items
       WHERE business_id = $1 AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [businessId, ids]
    );
    const byId = new Map(current.map(r => [r.id, r]));

    const results = [];
    for (const { itemId, countedQty } of items) {
      const item = byId.get(itemId);
      // Silently skipping an unknown id would report a "successful" count that
      // quietly omitted items — and the leakage window would then treat those
      // items as counted when they weren't.
      if (!item) {
        const err = new Error(`פריט מלאי לא נמצא: ${itemId}`);
        err.statusCode = 404;
        throw err;
      }
      const counted = parseFloat(countedQty);
      if (!isFinite(counted) || counted < 0) {
        const err = new Error(`כמות ספירה לא תקינה עבור ${item.name}`);
        err.statusCode = 400;
        throw err;
      }

      const delta = counted - parseFloat(item.current_qty);

      await client.query(
        `UPDATE inventory_items SET current_qty = $1, updated_at = NOW()
         WHERE id = $2 AND business_id = $3`,
        [counted, itemId, businessId]
      );

      await client.query(
        `INSERT INTO inventory_transactions
           (business_id, item_id, type, qty_change, qty_after, reason, reported_by)
         VALUES ($1, $2, 'stocktake', $3, $4, $5, $6)`,
        [businessId, itemId, delta, counted, note || 'ספירת מלאי', userId || null]
      );

      results.push({
        itemId,
        name:        item.name,
        unit:        item.unit,
        previousQty: Math.round(parseFloat(item.current_qty) * 1000) / 1000,
        countedQty:  Math.round(counted * 1000) / 1000,
        delta:       Math.round(delta * 1000) / 1000,
        deltaValue:  Math.round(delta * (parseFloat(item.cost_per_unit) || 0) * 100) / 100,
      });
    }

    await client.query('COMMIT');
    return {
      countedAt:  new Date().toISOString(),
      itemsCount: results.length,
      // Negative total = the shelf holds less than the books said, i.e. the
      // value of stock that left without any recorded sale/waste.
      totalDeltaValue: Math.round(results.reduce((s, r) => s + r.deltaValue, 0) * 100) / 100,
      items: results,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The two most recent stock-count timestamps, which bound the window the
 * leakage agent can actually verify. Counts entered within the same few minutes
 * are one count session, not two, so they're collapsed by rounding to the hour.
 */
async function getStocktakeDates(businessId, limit = 12) {
  const { rows } = await db.query(
    `SELECT DATE_TRUNC('hour', created_at) AS counted_at,
            COUNT(*)::int                  AS items_counted
     FROM inventory_transactions
     WHERE business_id = $1 AND type = 'stocktake'
     GROUP BY DATE_TRUNC('hour', created_at)
     ORDER BY counted_at DESC
     LIMIT $2`,
    [businessId, limit]
  );
  return rows;
}

async function getTransactions(businessId, { itemId, type, fromDate, toDate, limit = 50, offset = 0 } = {}) {
  const conditions = ['it.business_id = $1'];
  const values     = [businessId];
  let   idx        = 2;

  if (itemId)   { conditions.push(`it.item_id = $${idx++}`);     values.push(itemId); }
  if (type)     { conditions.push(`it.type = $${idx++}`);        values.push(type); }
  if (fromDate) { conditions.push(`it.created_at >= $${idx++}`); values.push(fromDate); }
  if (toDate)   { conditions.push(`it.created_at <= $${idx++}`); values.push(toDate); }

  values.push(parseInt(limit));
  values.push(parseInt(offset) || 0);

  const { rows } = await db.query(
    `SELECT it.id, it.type, it.qty_change, it.reason AS note, it.created_at,
            ii.name AS item_name, ii.unit,
            u.full_name AS created_by
     FROM inventory_transactions it
     INNER JOIN inventory_items ii ON ii.id = it.item_id
     LEFT  JOIN users u ON u.id = it.reported_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY it.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values
  );
  return rows;
}

// ── קטגוריות ──────────────────────────────────────────────────

async function getCategories(businessId) {
  const { rows } = await db.query(
    `SELECT ic.id, ic.name,
            COUNT(ii.id)::int AS item_count
     FROM inventory_categories ic
     LEFT JOIN inventory_items ii ON ii.category_id = ic.id
     WHERE ic.business_id = $1
     GROUP BY ic.id, ic.name
     ORDER BY ic.name`,
    [businessId]
  );
  return rows;
}

async function createCategory(businessId, name) {
  const { rows } = await db.query(
    `INSERT INTO inventory_categories (business_id, name)
     VALUES ($1,$2) ON CONFLICT (business_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [businessId, name]
  );
  return rows[0];
}

async function deleteCategory(categoryId, businessId) {
  // Both steps must succeed or both must roll back — use a transaction to ensure atomicity.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE inventory_items SET category_id = NULL WHERE category_id = $1 AND business_id = $2',
      [categoryId, businessId]
    );
    await client.query(
      'DELETE FROM inventory_categories WHERE id = $1 AND business_id = $2',
      [categoryId, businessId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── סיכום בזבוז ───────────────────────────────────────────────

async function getWasteSummary(businessId, days = 30) {
  const { rows } = await db.query(
    `SELECT ii.name, ii.unit,
            ABS(SUM(it.qty_change))::float          AS total_qty_wasted,
            (ABS(SUM(it.qty_change)) * ii.cost_per_unit)::float AS estimated_loss,
            COUNT(*)::int                           AS incidents
     FROM inventory_transactions it
     INNER JOIN inventory_items ii ON ii.id = it.item_id
     WHERE it.business_id = $1 AND it.type = 'waste'
       AND it.created_at >= NOW() - INTERVAL '1 day' * $2
     GROUP BY ii.id, ii.name, ii.unit, ii.cost_per_unit
     ORDER BY estimated_loss DESC NULLS LAST`,
    [businessId, days]
  );
  return rows;
}

// ── שווי מלאי ─────────────────────────────────────────────────

async function getInventoryValue(businessId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int                                          AS total_items,
       SUM(current_qty * cost_per_unit)::float               AS total_value,
       COUNT(*) FILTER (WHERE current_qty <= min_qty AND min_qty > 0)::int AS low_stock_count
     FROM inventory_items WHERE business_id = $1`,
    [businessId]
  );
  return rows[0];
}

// ── ניתוח צריכת מלאי היסטורי ─────────────────────────────────
// מחשב, לכל טווח תאריכים (כולל תקופות שהוזנו רטרואקטיבית), כמה
// מכל פריט מלאי נצרך ובאיזה שווי — לפי דוחות זד/מכירות ופירוט
// המנות שקיים בהן, ועלויות המתכון/מנה העדכניות (COALESCE עם
// inventory_items.cost_per_unit → manual_cost כמו בשאר המערכת).
// מחושב "חי" בכל קריאה כדי לשקף אוטומטית עלויות שהתעדכנו אחרי
// שהדוחות כבר הועלו — אין שמירה של תוצאה קפואה.
async function getConsumptionAnalysis(businessId, dateFrom, dateTo) {
  const { rows } = await db.query(
    `WITH
     smart_sales AS (
       SELECT s.id, s.total_amount,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales s
       WHERE s.business_id = $1
         AND DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') BETWEEN $2::date AND $3::date
     ),
     ind_days AS (
       SELECT DISTINCT sale_day FROM smart_sales WHERE is_ind
     ),
     valid_sales AS (
       SELECT ss.id, ss.total_amount FROM smart_sales ss
       WHERE ss.is_ind OR ss.sale_day NOT IN (SELECT sale_day FROM ind_days)
     ),
     -- "revenue_with_items" counts only sales whose sale_items match an actual dish
     -- or have a recipe_id linkage. Z-report payment items (cash/credit/wolt/ten_bis)
     -- have sale_items but those names don't match dishes — exclude them so
     -- itemDataCoveragePct isn't inflated to 100% when we have no real dish data.
     dish_names AS (
       SELECT LOWER(name) AS dname FROM dishes WHERE business_id = $1
     ),
     sales_with_dish_items AS (
       SELECT DISTINCT si.sale_id
       FROM sale_items si
       WHERE si.sale_id IN (SELECT id FROM valid_sales)
         AND (si.recipe_id IS NOT NULL OR LOWER(si.name) IN (SELECT dname FROM dish_names))
     ),
     coverage AS (
       SELECT
         COALESCE(SUM(vs.total_amount), 0)::float AS total_revenue,
         COALESCE(SUM(vs.total_amount) FILTER (
           WHERE vs.id IN (SELECT sale_id FROM sales_with_dish_items)
         ), 0)::float AS revenue_with_items
       FROM valid_sales vs
     ),
     -- dish_qty excludes sale_items that already have recipe_id (those are counted in
     -- recipe_qty below), preventing the same ingredient from being double-counted.
     dish_qty AS (
       SELECT d.id AS dish_id, COALESCE(SUM(si.qty), 0)::float AS qty_sold
       FROM dishes d
       LEFT JOIN sale_items si ON LOWER(si.name) = LOWER(d.name)
         AND si.sale_id IN (SELECT id FROM valid_sales)
         AND si.recipe_id IS NULL
       WHERE d.business_id = $1
       GROUP BY d.id
     ),
     recipe_qty AS (
       SELECT r.id AS recipe_id, COALESCE(SUM(si.qty), 0)::float AS qty_sold
       FROM recipes r
       LEFT JOIN sale_items si ON si.recipe_id = r.id
         AND si.sale_id IN (SELECT id FROM valid_sales)
       WHERE r.business_id = $1
       GROUP BY r.id
     ),
     dish_consumption AS (
       SELECT di.inventory_item_id AS item_id,
              SUM(di.qty * dq.qty_sold)::float AS consumed_qty,
              SUM(di.qty * dq.qty_sold * COALESCE(ii.cost_per_unit, di.manual_cost, 0))::float AS consumed_value
       FROM dish_ingredients di
       JOIN dish_qty dq ON dq.dish_id = di.dish_id
       LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id
       WHERE dq.qty_sold > 0 AND di.inventory_item_id IS NOT NULL
       GROUP BY di.inventory_item_id
     ),
     recipe_consumption AS (
       SELECT ri.item_id,
              SUM(ri.qty * rq.qty_sold)::float AS consumed_qty,
              SUM(ri.qty * rq.qty_sold * COALESCE(ii.cost_per_unit, ri.manual_cost, 0))::float AS consumed_value
       FROM recipe_ingredients ri
       JOIN recipe_qty rq ON rq.recipe_id = ri.recipe_id
       LEFT JOIN inventory_items ii ON ii.id = ri.item_id
       WHERE rq.qty_sold > 0 AND ri.item_id IS NOT NULL
       GROUP BY ri.item_id
     ),
     -- When a recipe has no recipe_ingredients yet, fall back to the matching dish's
     -- dish_ingredients (matched by name). This handles the common case where a business
     -- has configured dish ingredients but the recipe_ingredients table is still empty.
     recipe_consumption_fallback AS (
       SELECT di.inventory_item_id AS item_id,
              SUM(di.qty * rq.qty_sold)::float AS consumed_qty,
              SUM(di.qty * rq.qty_sold * COALESCE(ii.cost_per_unit, di.manual_cost, 0))::float AS consumed_value
       FROM recipe_qty rq
       JOIN recipes r ON r.id = rq.recipe_id AND r.business_id = $1
       JOIN dishes d ON LOWER(d.name) = LOWER(r.name) AND d.business_id = $1
       JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
       LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id AND ii.business_id = $1
       WHERE rq.qty_sold > 0
         AND NOT EXISTS (
           SELECT 1 FROM recipe_ingredients ri
           WHERE ri.recipe_id = rq.recipe_id AND ri.item_id IS NOT NULL
         )
       GROUP BY di.inventory_item_id
     ),
     combined AS (
       SELECT item_id, consumed_qty, consumed_value FROM dish_consumption
       UNION ALL
       SELECT item_id, consumed_qty, consumed_value FROM recipe_consumption
       UNION ALL
       SELECT item_id, consumed_qty, consumed_value FROM recipe_consumption_fallback
     )
     SELECT
       (SELECT total_revenue FROM coverage)         AS total_revenue,
       (SELECT revenue_with_items FROM coverage)     AS revenue_with_items,
       COALESCE(json_agg(
         json_build_object(
           'itemId', ii.id,
           'name', ii.name,
           'unit', ii.unit,
           'consumedQty', ROUND(c.consumed_qty::numeric, 3),
           'consumedValue', ROUND(c.consumed_value::numeric, 2),
           'notInRecipe', c.not_in_recipe,
           'noSalesData', c.no_sales_data
         ) ORDER BY c.not_in_recipe, c.no_sales_data, c.consumed_value DESC
       ) FILTER (WHERE ii.id IS NOT NULL), '[]') AS items
     FROM (
       -- Recipe-based consumption (main path) — items that had sales matched to recipes/dishes
       SELECT item_id, SUM(consumed_qty)::float AS consumed_qty, SUM(consumed_value)::float AS consumed_value,
              FALSE AS not_in_recipe, FALSE AS no_sales_data
       FROM combined
       GROUP BY item_id
       UNION ALL
       -- Items that were purchased from a supplier in the period (inventory_transactions) but
       -- did NOT appear in recipe-based consumption. Two sub-cases:
       --   a) "no_sales_data":   item IS linked to a dish/recipe — it was purchased and likely
       --      sold, but the Z-report lacked item-level detail so no sale_items matched the
       --      dish name. Consumption is 0 in this system, but the item IS tracked.
       --   b) "not_in_recipe":   item is NOT linked to any dish/recipe — truly untracked.
       SELECT pip.item_id, 0::float, 0::float,
              NOT (EXISTS (SELECT 1 FROM dish_ingredients  di WHERE di.inventory_item_id = pip.item_id)
                OR EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.item_id          = pip.item_id)
              ) AS not_in_recipe,
              (EXISTS (SELECT 1 FROM dish_ingredients  di WHERE di.inventory_item_id = pip.item_id)
            OR EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.item_id          = pip.item_id)
              ) AS no_sales_data
       FROM (
         SELECT DISTINCT it.item_id
         FROM inventory_transactions it
         WHERE it.business_id = $1
           AND it.type = 'purchase'
           AND DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem') BETWEEN $2::date AND $3::date
       ) pip
       WHERE pip.item_id NOT IN (SELECT item_id FROM combined)
     ) c
     JOIN inventory_items ii ON ii.id = c.item_id AND ii.business_id = $1`,
    [businessId, dateFrom, dateTo]
  );

  const row = rows[0] || { total_revenue: 0, revenue_with_items: 0, items: [] };
  const items = row.items || [];
  const totalRevenue = Number(row.total_revenue) || 0;
  const revenueWithItems = Number(row.revenue_with_items) || 0;
  const itemDataCoveragePct = totalRevenue > 0 ? Math.round((revenueWithItems / totalRevenue) * 100) : 100;
  const totalConsumedValue = items.reduce((sum, it) => sum + Number(it.consumedValue || 0), 0);

  return {
    dateFrom,
    dateTo,
    itemDataCoveragePct,
    totalConsumedValue: Math.round(totalConsumedValue * 100) / 100,
    revenueWithItems: Math.round(revenueWithItems * 100) / 100,
    items,
  };
}

module.exports = {
  findAllByBusiness, findById, create, update, remove,
  recordTransaction, getTransactions,
  recordStocktake, getStocktakeDates,
  getCategories, createCategory, deleteCategory,
  getWasteSummary, getInventoryValue, getConsumptionAnalysis,
};
