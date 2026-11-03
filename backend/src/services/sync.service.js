/**
 * Sync Service — Central cross-module synchronization orchestrator
 * Called after sales, invoice approvals, and inventory changes
 * to keep all modules consistent and push real-time events.
 */

const db       = require('../utils/db');
const logger   = require('../utils/logger');
const eventBus = require('../utils/eventBus');
const cache    = require('../utils/cache');
const { todayIL } = require('../utils/dateIL');

// ── Every cache key that depends on sales/finance/inventory-cost data ─────────
// Single source of truth — used by fullCacheBust AND by the two most-frequent
// real-time triggers (onSaleCreated, onInvoiceApproved), which previously each
// hand-maintained their own smaller, divergent subset and left finance/AI/
// weekly-report caches stale for up to their full TTL after every normal sale.
function _allCacheKeys(businessId) {
  return [
    `dashboard:${businessId}`,
    `dashboard-chart:${businessId}:*`,
    `dashboard-orders:${businessId}:*`,
    `daily-summary:${businessId}:${todayIL()}`,
    `menu-engineering:${businessId}:*`,
    `menu-elasticity:${businessId}`,
    `profit-leaks:${businessId}`,
    `fraud-alerts:${businessId}:*`,
    `ingredient-cost:${businessId}:*`,
    `ingredient-leakage:${businessId}:*`,
    `survival-mode:${businessId}:*`,
    `finance-cashflow:${businessId}:*`,
    `finance-forecast:${businessId}`,
    `finance-forecast90:${businessId}`,
    `audit:latest:${businessId}`,
    `insights:${businessId}:*`,
    `weekly-report:${businessId}:*`,
    `ai-context:${businessId}`,
    `ai-context:v2:${businessId}`,
    `forecast:${businessId}:*`,
    `zreport:missing:${businessId}`,
    `ai_advisor_resp:${businessId}:*`,
    `ai_advisor_generic:${businessId}:*`,
  ];
}

// ── Helper: save low-inventory notification to DB ─────────────────────────────
// Uses outbox pattern: notification INSERT and event publish are decoupled;
// if the INSERT succeeds the event is guaranteed to fire (non-critical path).
async function saveLowInventoryNotification(businessId, item) {
  try {
    const { rows: userRows } = await db.query(
      `SELECT id FROM users
       WHERE business_id = $1 AND role IN ('owner','partner') AND is_active = TRUE
       LIMIT 1`,
      [businessId]
    );
    const userId = userRows[0]?.id || null;
    const body = `${item.name} — נותרו ${parseFloat(item.current_qty)} ${item.unit || ''}`.trim();

    // Atomic INSERT WHERE NOT EXISTS — prevents duplicate notifications when multiple
    // items hit the threshold concurrently (concurrent calls see the same SELECT result
    // with the old SELECT-then-INSERT pattern, both insert; this single statement is atomic).
    const { rowCount } = await db.query(
      `INSERT INTO notifications (business_id, user_id, type, title, body, expires_at)
       SELECT $1, $2, 'low_inventory', 'מלאי נמוך', $3, NOW() + INTERVAL '7 days'
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications
         WHERE business_id = $1 AND type = 'low_inventory' AND is_read = FALSE
           AND body LIKE $4 AND created_at > NOW() - INTERVAL '6 hours'
       )`,
      [businessId, userId, body, `%${item.name.replace(/[%_\\]/g, '\\$&')}%`]
    );
    if (rowCount === 0) return; // duplicate suppressed

    // Event publish is fire-and-forget — notification is already persisted in DB.
    // If this fails, the notification remains in DB and SSE clients will see it on next poll.
    setImmediate(() => {
      try {
        eventBus.publish(businessId, 'low_inventory', {
          itemId:   item.id,
          itemName: item.name,
          qty:      parseFloat(item.current_qty),
          unit:     item.unit,
        });
      } catch {}
    });
  } catch (err) {
    logger.warn('[SyncService] Failed to save low_inventory notification', { err: err.message });
  }
}

// ── Helper: notify when dish has no ingredients defined ──────────────────────
async function _saveMissingIngredientsAlert(businessId, dishName) {
  try {
    // Avoid duplicate alerts for same dish within 24 hours
    const { rows: existing } = await db.query(
      `SELECT id FROM notifications
       WHERE business_id = $1 AND type = 'missing_ingredients'
         AND body LIKE $2 AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [businessId, `%${dishName.replace(/[%_\\]/g, '\\$&')}%`]
    );
    if (existing.length > 0) return;

    // Target the owner/partner, but fall back to ANY active user if the business
    // has none — the notifications API filters strictly by user_id, so a
    // user_id = NULL alert is invisible to everyone. Without this fallback, a
    // business whose owner account isn't role-tagged 'owner'/'partner' (e.g. the
    // owner logs in as a manager/employee) would silently never see these
    // missing-ingredients alerts even though they were being created.
    const { rows: userRows } = await db.query(
      `SELECT id FROM users
       WHERE business_id = $1 AND is_active = TRUE
       ORDER BY (role IN ('owner','partner')) DESC, created_at ASC
       LIMIT 1`,
      [businessId]
    );
    const userId = userRows[0]?.id || null;

    // מנה מחוקה היא המקרה הנפוץ, והנוסח הגנרי היה בלתי-פתיר עבורה: המנה לא
    // מופיעה בדף המנות (כל השאילתות מסננות is_active), השאיבה מדוחות Z מכבדת
    // את המחיקה ולא יוצרת אותה מחדש — כלומר ההתראה ביקשה מבעל העסק להגדיר
    // מרכיבים למנה שהמערכת עצמה מסתירה ממנו, וחזרה על עצמה בכל דוח Z לנצח.
    // כאן מזהים את המצב ומכוונים לפעולה שכן פותרת אותו — שחזור.
    const { rows: arch } = await db.query(
      `SELECT id, archived_at FROM dishes
       WHERE business_id = $1
         AND regexp_replace(trim(lower(name)), '\\s+', ' ', 'g')
           = regexp_replace(trim(lower($2)), '\\s+', ' ', 'g')
         AND is_active = FALSE
       ORDER BY archived_at DESC NULLS LAST
       LIMIT 1`,
      [businessId, dishName]
    ).catch(() => ({ rows: [] }));
    const archivedDish = arch[0] || null;

    const title = archivedDish
      ? '⚠️ מנה מחוקה ממשיכה להימכר'
      : '⚠️ מרכיבים חסרים במנה';
    const body = archivedDish
      ? `המנה "${dishName}" נמכרת בקופה אך היא מחוקה מדף המנות${
          archivedDish.archived_at
            ? ` (נמחקה ב-${new Date(archivedDish.archived_at).toLocaleDateString('he-IL')})`
            : ''
        } — לכן היא לא מנכה מלאי ולא נכנסת לעלות הסחורה. שחזר אותה מ״מנות מחוקות״ בדף המנות והגדר לה מרכיבים, או התעלם אם היא באמת לא נמכרת יותר`
      : `המנה "${dishName}" נמכרת בקופה אך אין לה מרכיבים מוגדרים — כדי שהמערכת תנכה מלאי אוטומטית, יש להגדיר את המרכיבים וכמויות מדויקות בדף המנות`;

    await db.query(
      `INSERT INTO notifications (business_id, user_id, type, title, body, expires_at)
       VALUES ($1, $2, 'missing_ingredients', $3, $4, NOW() + INTERVAL '30 days')`,
      [businessId, userId, title, body]
    );

    eventBus.publish(businessId, 'notification', {
      type:  'missing_ingredients',
      title: archivedDish
        ? `⚠️ מנה מחוקה נמכרת: "${dishName}"`
        : `⚠️ מרכיבים חסרים: "${dishName}"`,
      body:  archivedDish
        ? 'שחזר אותה מ״מנות מחוקות״ בדף המנות כדי שתנכה מלאי'
        : 'יש להגדיר מרכיבים וכמויות מדויקות כדי שהמערכת תנכה מלאי אוטומטית',
      dishId:     archivedDish?.id || null,
      isArchived: !!archivedDish,
      critical: true,
    });
  } catch (err) {
    logger.warn('[SyncService] Failed to save missing_ingredients notification', { err: err.message });
  }
}

// ── Helper: log deduction to inventory_transactions ───────────────────────────
async function _logTransaction(businessId, itemId, deduction, qtyAfter, dishOrRecipeName) {
  try {
    await db.query(
      `INSERT INTO inventory_transactions
         (business_id, item_id, type, qty_change, qty_after, reason)
       VALUES ($1, $2, 'sale', $3, $4, $5)`,
      [businessId, itemId, -Math.abs(deduction), qtyAfter, `מכירת "${dishOrRecipeName}"`]
    );
  } catch { /* table might not exist yet — non-critical */ }
}

// ── Helper: get deductible ingredients ───────────────────────────────────────
// matchType: 'recipe' | 'dish'
async function _getIngredients(matchType, matchId) {
  if (matchType === 'recipe') {
    const { rows } = await db.query(
      `SELECT item_id, qty FROM recipe_ingredients
       WHERE recipe_id = $1 AND item_id IS NOT NULL`,
      [matchId]
    );
    return rows;
  }

  // dish: direct dish_ingredients + via dish_recipes → recipe_ingredients
  const { rows: direct } = await db.query(
    `SELECT inventory_item_id AS item_id, qty
     FROM dish_ingredients
     WHERE dish_id = $1 AND inventory_item_id IS NOT NULL`,
    [matchId]
  );

  const { rows: viaRecipes } = await db.query(
    `SELECT ri.item_id, (ri.qty * dr.qty) AS qty
     FROM dish_recipes dr
     JOIN recipe_ingredients ri ON ri.recipe_id = dr.recipe_id
     WHERE dr.dish_id = $1 AND ri.item_id IS NOT NULL`,
    [matchId]
  );

  // Merge — sum duplicates
  const merged = {};
  for (const ing of [...direct, ...viaRecipes]) {
    const key = ing.item_id;
    merged[key] = (merged[key] || 0) + parseFloat(ing.qty);
  }
  return Object.entries(merged).map(([item_id, qty]) => ({ item_id, qty }));
}

// ── Helper: deduct ingredients from inventory (batched — single transaction) ──
async function _deductIngredients(businessId, ingredients, saleQty, sourceName) {
  // Build deduction map: item_id → total deduction amount
  const deductMap = {};
  for (const ing of ingredients) {
    const deduction = parseFloat(ing.qty) * saleQty;
    if (deduction <= 0) continue;
    deductMap[ing.item_id] = (deductMap[ing.item_id] || 0) + deduction;
  }
  const itemIds = Object.keys(deductMap);
  if (!itemIds.length) return;

  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    // Lock all rows at once — prevents double-deduction on concurrent sales
    const { rows: locked } = await client.query(
      `SELECT id, name, current_qty, min_qty, unit
       FROM inventory_items
       WHERE id = ANY($1) AND business_id = $2
       ORDER BY id
       FOR UPDATE`,
      [itemIds, businessId]
    );

    const updatedItems = [];
    for (const inv of locked) {
      const deduction  = deductMap[inv.id];
      const currentQty = parseFloat(inv.current_qty) || 0;
      if (currentQty < deduction) {
        logger.warn('[SyncService] מלאי לא מספיק', { item: inv.name, required: deduction, current: currentQty, dish: sourceName });
      }
      updatedItems.push({ inv, deduction });
    }

    if (!updatedItems.length) {
      logger.warn('[SyncService] _deductIngredients: none of the requested item_ids exist in inventory — zero deductions applied', { itemIds, businessId, source: sourceName });
      await client.query('ROLLBACK');
      return;
    }

    // Single UPDATE for all items using unnest
    const ids        = updatedItems.map(u => u.inv.id);
    const deductions = updatedItems.map(u => u.deduction);

    const { rows: results } = await client.query(
      `UPDATE inventory_items ii
       SET current_qty = GREATEST(0, ii.current_qty - d.deduction),
           updated_at  = NOW()
       FROM unnest($1::uuid[], $2::float[]) AS d(id, deduction)
       WHERE ii.id = d.id AND ii.business_id = $3
       RETURNING ii.id, ii.current_qty`,
      [ids, deductions, businessId]
    );

    await client.query('COMMIT');

    // Post-commit: log transactions + check low-inventory thresholds
    const qtyAfterMap = Object.fromEntries(results.map(r => [r.id, parseFloat(r.current_qty)]));
    await Promise.allSettled(updatedItems.map(async ({ inv, deduction }) => {
      if (!(inv.id in qtyAfterMap)) return; // row deleted between lock and update
      const qtyAfter = qtyAfterMap[inv.id];
      // Log the ACTUAL amount deducted (GREATEST(0,...) may have floored it).
      // Skip when actualDeduction=0 (item was already at 0) — a zero-change
      // 'sale' row is ledger noise and inflates per-item transaction counts.
      const actualDeduction = Math.max(0, parseFloat(inv.current_qty) - qtyAfter);
      if (actualDeduction > 0) {
        await _logTransaction(businessId, inv.id, actualDeduction, qtyAfter, sourceName);
      }
      if (inv.min_qty > 0 && qtyAfter <= parseFloat(inv.min_qty)) {
        await saveLowInventoryNotification(businessId, { ...inv, current_qty: qtyAfter });
      }
    }));
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

// ── Helper: deduct packaging items from inventory (cups, covers, etc.) ────────
async function _deductPackaging(businessId, dishId, saleType, saleQty, dishName) {
  const orderType = saleType === 'table' ? 'dine_in' : saleType === 'takeaway' ? 'takeaway' : null;
  if (!orderType) return; // only deduct for known order types

  let packagingItems = [];
  try {
    const { rows } = await db.query(
      `SELECT dp.inventory_item_id, dp.qty
       FROM dish_packaging dp
       WHERE dp.dish_id = $1
         AND (dp.order_type = $2 OR dp.order_type = 'both')
         AND dp.inventory_item_id IS NOT NULL`,
      [dishId, orderType]
    );
    packagingItems = rows;
  } catch { return; } // table may not exist yet

  if (!packagingItems.length) return;

  const formattedItems = packagingItems.map(p => ({ item_id: p.inventory_item_id, qty: p.qty }));
  logger.info(`[SyncService] ניכוי אריזה: "${dishName}" ×${saleQty} — ${formattedItems.length} פריטי אריזה (${orderType})`);
  await _deductIngredients(businessId, formattedItems, saleQty, `אריזה — ${dishName}`);
}

// ── Helper: deduct accompaniments from inventory ───────────────────────────────
// Accompaniments differ per order_type (dine_in/takeaway/both). Only items with
// inventory_item_id are deducted; manual_cost-only rows have nothing to deduct.
//
// When saleType is null (unknown order type), only 'both' accompaniments are
// deducted — same conservative policy as packaging. Deducting dine_in-only
// items for unknown-type sales would be wrong because the sale could be takeaway.
async function _deductAccompaniments(businessId, dishId, saleType, saleQty, dishName) {
  const orderType = saleType === 'table' ? 'dine_in' : saleType === 'takeaway' ? 'takeaway' : null;

  let accItems = [];
  try {
    // When orderType is known: deduct matching type + 'both'.
    // When orderType is null (unknown sale type): deduct 'both' only — items
    // that apply to every order type regardless of channel.
    const { rows } = orderType
      ? await db.query(
          `SELECT da.inventory_item_id, da.qty
           FROM dish_accompaniments da
           WHERE da.dish_id = $1
             AND (da.order_type = $2 OR da.order_type = 'both')
             AND da.inventory_item_id IS NOT NULL`,
          [dishId, orderType]
        )
      : await db.query(
          `SELECT da.inventory_item_id, da.qty
           FROM dish_accompaniments da
           WHERE da.dish_id = $1
             AND da.order_type = 'both'
             AND da.inventory_item_id IS NOT NULL`,
          [dishId]
        );
    accItems = rows;
  } catch { return; } // table may not exist yet

  if (!accItems.length) return;

  const label = orderType || 'unknown-type';
  const formattedItems = accItems.map(a => ({ item_id: a.inventory_item_id, qty: a.qty }));
  logger.info(`[SyncService] ניכוי ליווי: "${dishName}" ×${saleQty} — ${formattedItems.length} פריטי ליווי (${label})`);
  await _deductIngredients(businessId, formattedItems, saleQty, `ליווי — ${dishName}`);
}

// ── onSaleCreated ─────────────────────────────────────────────────────────────
// Called after any sale is created (POS sync or manual CSV import)
async function onSaleCreated(businessId, saleId) {
  try {
    // Fetch sale_type for packaging deduction (scoped to business to prevent cross-tenant read)
    const { rows: saleRows } = await db.query(
      `SELECT sale_type FROM sales WHERE id = $1 AND business_id = $2`,
      [saleId, businessId]
    );
    const saleType = saleRows[0]?.sale_type || null;

    // Include recipe_id — already set by _saveSales via pos_item_id
    const { rows: saleItems } = await db.query(
      `SELECT si.id, si.name, si.qty, si.recipe_id
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE si.sale_id = $1 AND s.business_id = $2`,
      [saleId, businessId]
    );

    // ── Pre-fetch all needed recipes + dishes in bulk ─────────────────────────
    const linkedRecipeIds = [...new Set(saleItems.map(s => s.recipe_id).filter(Boolean))];
    const itemNames       = [...new Set(saleItems.filter(s => !s.recipe_id).map(s => s.name))];

    const [recipeByIdRows, recipeByNameRows, dishByNameRows] = await Promise.all([
      linkedRecipeIds.length
        ? db.query(`SELECT id, name FROM recipes WHERE id = ANY($1) AND business_id = $2`, [linkedRecipeIds, businessId])
        : Promise.resolve({ rows: [] }),
      itemNames.length
        ? db.query(`SELECT id, name FROM recipes WHERE business_id=$1 AND LOWER(name) = ANY($2::text[])`,
            [businessId, itemNames.map(n => n.toLowerCase())])
        : Promise.resolve({ rows: [] }),
      itemNames.length
        ? db.query(`SELECT id, name FROM dishes WHERE business_id=$1 AND LOWER(name) = ANY($2::text[])`,
            [businessId, itemNames.map(n => n.toLowerCase())]).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
    ]);

    const recipeById   = Object.fromEntries(recipeByIdRows.rows.map(r => [r.id, r.name]));
    const recipeByName = Object.fromEntries(recipeByNameRows.rows.map(r => [r.name.toLowerCase(), r]));
    const dishByName   = Object.fromEntries(dishByNameRows.rows.map(d => [d.name.toLowerCase(), d]));

    // ── Pass 1: resolve all matches synchronously (no DB calls needed) ─────────
    const matches = [];
    for (const saleItem of saleItems) {
      let matchType = null;
      let matchId   = null;
      let matchName = saleItem.name;

      // 1. Use recipe_id already linked from POS (most reliable)
      if (saleItem.recipe_id) {
        matchType = 'recipe';
        matchId   = saleItem.recipe_id;
        matchName = recipeById[matchId] || saleItem.name;
      }

      // 2. Fallback: match by exact name → recipes
      if (!matchId) {
        const found = recipeByName[saleItem.name.toLowerCase()];
        if (found) {
          matchType = 'recipe';
          matchId   = found.id;
          matchName = found.name;
          // Link for future lookups (fire-and-forget)
          db.query(
            `UPDATE sale_items SET recipe_id = $1 WHERE id = $2 AND recipe_id IS NULL`,
            [matchId, saleItem.id]
          ).catch(() => {});
        }
      }

      // 3. Fallback: match by exact name → dishes
      if (!matchId) {
        const found = dishByName[saleItem.name.toLowerCase()];
        if (found) {
          matchType = 'dish';
          matchId   = found.id;
          matchName = found.name;
        }
      }

      if (!matchId) {
        logger.info(`[SyncService] לא נמצאה התאמה למוצר: "${saleItem.name}" — דילוג`);
        continue;
      }

      matches.push({ saleItem, matchType, matchId, matchName });
    }

    // ── Pass 2: batch-fetch all ingredients in 3 parallel queries ────────────
    const allRecipeIds = [...new Set(matches.filter(m => m.matchType === 'recipe').map(m => m.matchId))];
    const allDishIds   = [...new Set(matches.filter(m => m.matchType === 'dish').map(m => m.matchId))];

    const [recipeIngRows, dishIngDirectRows, dishIngViaRows] = await Promise.all([
      allRecipeIds.length
        ? db.query(
            `SELECT recipe_id AS id, item_id, qty FROM recipe_ingredients
             WHERE recipe_id = ANY($1) AND item_id IS NOT NULL`,
            [allRecipeIds])
        : Promise.resolve({ rows: [] }),
      allDishIds.length
        ? db.query(
            `SELECT dish_id AS id, inventory_item_id AS item_id, qty FROM dish_ingredients
             WHERE dish_id = ANY($1) AND inventory_item_id IS NOT NULL`,
            [allDishIds]).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
      allDishIds.length
        ? db.query(
            `SELECT dr.dish_id AS id, ri.item_id, (ri.qty * dr.qty) AS qty
             FROM dish_recipes dr
             JOIN recipe_ingredients ri ON ri.recipe_id = dr.recipe_id
             WHERE dr.dish_id = ANY($1) AND ri.item_id IS NOT NULL`,
            [allDishIds])
        : Promise.resolve({ rows: [] }),
    ]);

    // Build ingredient map: "recipe:id" | "dish:id" → [{item_id, qty}]
    const ingredientsMap = {};
    for (const row of recipeIngRows.rows) {
      const key = `recipe:${row.id}`;
      (ingredientsMap[key] = ingredientsMap[key] || []).push({ item_id: row.item_id, qty: row.qty });
    }
    const dishMerged = {};
    for (const row of [...dishIngDirectRows.rows, ...dishIngViaRows.rows]) {
      if (!dishMerged[row.id]) dishMerged[row.id] = {};
      dishMerged[row.id][row.item_id] = (dishMerged[row.id][row.item_id] || 0) + parseFloat(row.qty);
    }
    for (const [dishId, items] of Object.entries(dishMerged)) {
      ingredientsMap[`dish:${dishId}`] = Object.entries(items).map(([item_id, qty]) => ({ item_id, qty }));
    }

    // Fallback: recipe_id is linked but has zero linked recipe_ingredients → try dish_ingredients by name.
    // Mirrors INGREDIENT_SOURCE_CTE logic: prefer dish when it has more linked rows than the recipe.
    const recipesWithNoIng = matches.filter(m =>
      m.matchType === 'recipe' && !ingredientsMap[`recipe:${m.matchId}`]?.length
    );
    if (recipesWithNoIng.length > 0) {
      const fbNames = [...new Set(recipesWithNoIng.map(m => m.matchName.toLowerCase()))];
      const { rows: fbRows } = await db.query(
        `SELECT LOWER(d.name) AS dname, di.inventory_item_id AS item_id, di.qty::float AS qty
         FROM dishes d
         JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
         WHERE d.business_id = $1 AND LOWER(d.name) = ANY($2::text[])
           AND (d.is_active IS NULL OR d.is_active = TRUE)`,
        [businessId, fbNames]
      ).catch(() => ({ rows: [] }));
      const fbByName = {};
      for (const r of fbRows) {
        (fbByName[r.dname] = fbByName[r.dname] || []).push({ item_id: r.item_id, qty: r.qty });
      }
      for (const m of recipesWithNoIng) {
        const ings = fbByName[m.matchName.toLowerCase()];
        if (ings?.length) ingredientsMap[`recipe:${m.matchId}`] = ings;
      }
    }

    // Pre-fetch dishes for recipe-matched items — needed for both packaging and
    // accompaniments. Previously gated on saleType, but accompaniments must be
    // deducted even for unknown-type sales (for 'both' items), so always fetch.
    const recipeMatchNames = [...new Set(
      matches.filter(m => m.matchType === 'recipe').map(m => m.matchName.toLowerCase())
    )];
    const dishByRecipeName = {};
    if (recipeMatchNames.length) {
      const { rows: rdRows } = await db.query(
        `SELECT id, LOWER(name) AS lname FROM dishes WHERE business_id=$1 AND LOWER(name) = ANY($2)`,
        [businessId, recipeMatchNames]
      ).catch(() => ({ rows: [] }));
      rdRows.forEach(r => { dishByRecipeName[r.lname] = r.id; });
    }

    // ── Pass 3: deduct inventory using pre-fetched ingredients ───────────────
    for (const { saleItem, matchType, matchId, matchName } of matches) {
      try {
        const ingredients = ingredientsMap[`${matchType}:${matchId}`] || [];
        const saleQty = parseFloat(saleItem.qty) || 1;

        if (ingredients.length === 0) {
          logger.info(`[SyncService] "${matchName}" ללא מרכיבים מוגדרים — שולח התראה`);
          await _saveMissingIngredientsAlert(businessId, matchName);
        } else {
          logger.info(`[SyncService] מנכה מלאי: "${matchName}" ×${saleQty} — ${ingredients.length} מרכיבים`);
          await _deductIngredients(businessId, ingredients, saleQty, matchName);
        }

        // ── Deduct packaging + accompaniments (order-type-aware) ─────────────
        // Runs even when the dish has no recipe ingredients — a dish may have
        // accompaniments or packaging without any ingredient list defined.
        {
          let dishIdForExtras = matchType === 'dish' ? matchId : null;
          if (!dishIdForExtras) {
            dishIdForExtras = dishByRecipeName[matchName.toLowerCase()] || null;
          }
          if (dishIdForExtras) {
            if (saleType) {
              await _deductPackaging(businessId, dishIdForExtras, saleType, saleQty, matchName);
            }
            await _deductAccompaniments(businessId, dishIdForExtras, saleType, saleQty, matchName);
          }
        }
      } catch (ingErr) {
        logger.warn('[SyncService] שגיאה בניכוי מלאי', { err: ingErr.message });
      }
    }

    eventBus.publish(businessId, 'dashboard.refresh', { reason: 'sale' });
    eventBus.publish(businessId, 'inventory.updated', { source: 'sale' });

    // Invalidate every cache that depends on sales data — a sale affects
    // revenue, so it affects finance/forecast/AI-context/insights too, not
    // just the dashboard tiles.
    await Promise.allSettled(_allCacheKeys(businessId).map(k => cache.del(k)));

  } catch (err) {
    logger.error('[SyncService] onSaleCreated error', { businessId, saleId, err: err.message });
    try { eventBus.publish(businessId, 'sync.error', { source: 'onSaleCreated', error: err.message }); } catch {}
  }
}

// ── onInvoiceApproved ─────────────────────────────────────────────────────────
async function onInvoiceApproved(businessId, invoiceId) {
  try {
    const { rows: items } = await db.query(
      `SELECT inventory_item_id, name, unit_price
         FROM invoice_items
        WHERE invoice_id = $1 AND unit_price > 0`,
      [invoiceId]
    );

    for (const item of items) {
      if (item.inventory_item_id) {
        await db.query(
          `UPDATE inventory_items
              SET cost_per_unit = $1, updated_at = NOW()
            WHERE id = $2 AND business_id = $3`,
          [item.unit_price, item.inventory_item_id, businessId]
        );
      } else if (item.name) {
        await db.query(
          `UPDATE inventory_items
              SET cost_per_unit = $1, updated_at = NOW()
            WHERE business_id = $2 AND LOWER(name) = LOWER($3)`,
          [item.unit_price, businessId, item.name]
        );
      }
    }

    eventBus.publish(businessId, 'inventory.updated', { source: 'invoice', invoiceId });
    eventBus.publish(businessId, 'finance.updated',   { source: 'invoice', invoiceId });
    eventBus.publish(businessId, 'dashboard.refresh', { reason: 'invoice' });

    // Invalidate every cache affected by invoice approval — changes cost
    // data, which feeds finance/forecast/AI-context, not just dashboard alerts.
    await Promise.allSettled(_allCacheKeys(businessId).map(k => cache.del(k)));
  } catch (err) {
    logger.error('[SyncService] onInvoiceApproved error', { businessId, invoiceId, err: err.message });
  }
}

// ── onShiftChanged ─────────────────────────────────────────────────────────────
// משמרת שנפתחה/נסגרה/נערכה — עלות שכר יומית (cashflow/forecast) תלויה ישירות
// בשעות משמרת בפועל, אבל האירועים הקיימים (shift_opened/shift_closed) לא מנקים
// את מטמון הפיננסים — התוצאה נשארת מיושנת עד תום ה-TTL
async function onShiftChanged(businessId) {
  try {
    await Promise.allSettled([
      cache.del(`finance-cashflow:${businessId}:*`),
      cache.del(`finance-forecast:${businessId}`),
      cache.del(`finance-forecast90:${businessId}`),
      cache.del(`finance-breakdown:${businessId}:*`),
      cache.del(`dashboard:${businessId}`),
      cache.del(`employee-perf:${businessId}:*`),
    ]);
  } catch (err) {
    logger.warn('[SyncService] onShiftChanged error', { businessId, err: err.message });
  }
}

// ── onInventoryChanged ────────────────────────────────────────────────────────
async function onInventoryChanged(businessId) {
  try {
    // Bust menu-engineering + profit-leaks + smart-reorder caches — cost_per_unit/
    // qty changes affect food cost %, below-cost-sale detection, and reorder suggestions
    await Promise.allSettled([
      cache.del(`menu-engineering:${businessId}:*`),
      cache.del(`profit-leaks:${businessId}`),
      cache.del(`reorder-suggestions:${businessId}`),
      cache.del(`ingredient-leakage:${businessId}:*`),
    ]);
    eventBus.publish(businessId, 'inventory.updated', { source: 'manual' });
    eventBus.publish(businessId, 'dashboard.refresh', { reason: 'inventory' });
  } catch (err) {
    logger.warn('[SyncService] onInventoryChanged error', { businessId, err: err.message });
  }
}

// ── onRecipeChanged ───────────────────────────────────────────────────────────
async function onRecipeChanged(businessId, recipeId) {
  try {
    await Promise.allSettled([
      cache.del(`menu-engineering:${businessId}:*`),
      cache.del(`menu-elasticity:${businessId}`),
      cache.del(`profit-leaks:${businessId}`),
      cache.del(`ingredient-leakage:${businessId}:*`),
    ]);
    eventBus.publish(businessId, 'recipe.updated', { recipeId });
    eventBus.publish(businessId, 'menu.changed',   { source: 'recipe' });
  } catch (err) {
    logger.warn('[SyncService] onRecipeChanged error', { businessId, err: err.message });
  }
}

// ── onSupplierChanged ─────────────────────────────────────────────────────────
async function onSupplierChanged(businessId, supplierId) {
  try {
    await Promise.allSettled([
      cache.del(`profit-leaks:${businessId}`),
      cache.del(`supplier-trends:${businessId}`),
      cache.del(`ingredient-leakage:${businessId}:*`),
    ]);
    eventBus.publish(businessId, 'supplier.updated', { supplierId });
  } catch (err) {
    logger.warn('[SyncService] onSupplierChanged error', { businessId, err: err.message });
  }
}

// ── fullCacheBust ─────────────────────────────────────────────────────────────
// Invalidates every known cache key for a business.
// Call after bulk imports or when onboarding a new account.
async function fullCacheBust(businessId) {
  const keys = _allCacheKeys(businessId);
  await Promise.allSettled(keys.map(k => cache.del(k)));

  // Emit refresh events so any open SSE connections get updated
  try {
    eventBus.publish(businessId, 'dashboard.refresh', { reason: 'full_sync' });
    eventBus.publish(businessId, 'inventory.updated', { source: 'full_sync' });
    eventBus.publish(businessId, 'finance.updated',   { source: 'full_sync' });
  } catch {}

  logger.info('[SyncService] fullCacheBust done', { businessId, keys: keys.length });
  return { ok: true, clearedKeys: keys.length };
}

// ── dismissNotifications — סימון התראות כנפתרות כשפעולה מבטלת אותן ──────────
// type        = ערך עמודת type ב-notifications
// titleFilter = (אופציונלי) LIKE pattern לעמודת body, לסינון לפי פריט ספציפי
async function dismissNotifications(businessId, type, titleFilter = null) {
  try {
    let query = `UPDATE notifications SET is_read = TRUE
                 WHERE business_id = $1 AND type = $2 AND is_read = FALSE`;
    const params = [businessId, type];
    if (titleFilter) {
      query += ` AND body LIKE $3`;
      params.push(`%${titleFilter.replace(/[%_\\]/g, '\\$&')}%`);
    }
    const { rowCount } = await db.query(query, params);
    if (rowCount > 0) {
      eventBus.publish(businessId, 'notification', { dismissed: type, count: rowCount });
    }
    return rowCount;
  } catch (err) {
    logger.warn('[SyncService] dismissNotifications failed', { err: err.message, type });
    return 0;
  }
}

module.exports = { onSaleCreated, onInvoiceApproved, onInventoryChanged, onRecipeChanged, onSupplierChanged, onShiftChanged, saveLowInventoryNotification, saveMissingIngredientsAlert: _saveMissingIngredientsAlert, dismissNotifications, fullCacheBust, allCacheKeys: _allCacheKeys };
