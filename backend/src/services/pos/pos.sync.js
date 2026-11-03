/**
 * POS Sync Service
 * אחראי על:
 * 1. חיבור קופה ראשון — שאיבת כל ההיסטוריה
 * 2. סנכרון שוטף — מכירות / מוצרים / קטגוריות
 * 3. זיהוי ניתוק + התראה לאחר 1 דקה
 */

const db         = require('../../utils/db');
const posModel   = require('../../models/pos.model');
const cache      = require('../../utils/cache');
const bikoum     = require('./bikoum.adapter');
const aviv       = require('./aviv.adapter');
const { onSaleCreated, allCacheKeys } = require('../sync.service');
const logger     = require('../../utils/logger');

const ADAPTERS = { bikoum, aviv };

// ── Cache invalidation after sync ─────────────────────────────
// משתמש ברשימת המפתחות המשותפת מ-sync.service.js (מקור אמת יחיד) —
// כך שהיא לא יכולה לסטות מהרשימה ששאר נקודות הסנכרון משתמשות בה
async function _bustCacheForBusiness(businessId) {
  await Promise.all(allCacheKeys(businessId).map(k => cache.del(k)))
    .catch(err => logger.warn('cache bust failed', { businessId, err: err.message }));
}

// ── getAdapter ───────────────────────────────────────────────
function getAdapter(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    const err = new Error(`ספק קופה לא נתמך: ${provider}`);
    err.status = 400;
    throw err;
  }
  return adapter;
}

// ── connect ───────────────────────────────────────────────────
// חיבור ראשון — בדיקה + שמירה + שאיבת כל ההיסטוריה
async function connect(businessId, { provider, apiKey, apiUrl }) {
  const adapter = getAdapter(provider);

  // בדיקת חיבור
  await adapter.testConnection(apiKey);

  // שמירה ב-DB
  await posModel.upsert(businessId, { provider, apiKey, apiUrl });

  // שאיבת היסטוריה מלאה ברקע (לא חוסם את התגובה)
  syncFullHistory(businessId, provider, apiKey).catch((err) =>
    logger.error('[POS] Full history sync failed', { businessId, err: err.message })
  );

  return { connected: true, provider };
}

// ── syncFullHistory ───────────────────────────────────────────
// רץ פעם אחת בחיבור ראשון — שואב הכל מההתחלה
async function syncFullHistory(businessId, provider, apiKey) {
  // Ensure the is_syncing column exists (idempotent — safe to run every time)
  await db.query(
    'ALTER TABLE pos_connections ADD COLUMN IF NOT EXISTS is_syncing BOOLEAN DEFAULT FALSE'
  );

  // Mutex: skip if a sync is already in progress for this business.
  // pos_connections has no is_active column (only is_connected — see
  // pos.model.js/schema.sql) — this query used the wrong name and threw
  // "column is_active does not exist" on every single call, which meant
  // syncFullHistory (this function), syncIncremental, and the 15-minute
  // scheduler all crashed before ever reaching the actual sync logic. No
  // business could ever get API-based POS sync working.
  const { rows: conn } = await db.query(
    'SELECT is_syncing FROM pos_connections WHERE business_id=$1 AND is_connected=true',
    [businessId]
  );
  if (conn[0]?.is_syncing) {
    logger.info('[POS] Sync already in progress, skipping', { businessId });
    return;
  }
  await db.query(
    'UPDATE pos_connections SET is_syncing=true WHERE business_id=$1',
    [businessId]
  );

  try {
    logger.info(`[POS] Starting full history sync for business ${businessId}`);
    const adapter = getAdapter(provider);

    const [sales, products, categories] = await Promise.all([
      adapter.fetchSales(apiKey, null),
      adapter.fetchProducts(apiKey),
      adapter.fetchCategories(apiKey),
    ]);

    await _saveCategories(businessId, categories);
    await _saveProducts(businessId, products);
    await _saveSales(businessId, sales);
    await posModel.updateLastSync(businessId);
    await _bustCacheForBusiness(businessId);

    logger.info(`[POS] Full history done: ${sales.length} sales, ${products.length} products`);
  } finally {
    await db.query(
      'UPDATE pos_connections SET is_syncing=false WHERE business_id=$1',
      [businessId]
    );
  }
}

// ── syncIncremental ───────────────────────────────────────────
// רץ בכל סנכרון שוטף — רק נתונים חדשים מאז הסנכרון האחרון
async function syncIncremental(businessId) {
  const connection = await posModel.findByBusiness(businessId);
  if (!connection || !connection.is_connected) return;

  // Mutex: skip if a full or incremental sync is already in progress
  const { rows: conn } = await db.query(
    'SELECT is_syncing FROM pos_connections WHERE business_id=$1 AND is_connected=true',
    [businessId]
  );
  if (conn[0]?.is_syncing) {
    logger.info('[POS] Incremental sync already in progress, skipping', { businessId });
    return;
  }
  await db.query('UPDATE pos_connections SET is_syncing=true WHERE business_id=$1', [businessId]);

  try {
    const adapter  = getAdapter(connection.provider);
    const fromDate = connection.last_sync_at || new Date(0);

    const [sales, products] = await Promise.all([
      adapter.fetchSales(connection.api_key, fromDate),
      adapter.fetchProducts(connection.api_key),
    ]);

    await _saveProducts(businessId, products);
    await _saveSales(businessId, sales);
    await posModel.updateLastSync(businessId);
    // Only invalidate cache when new sales actually arrived — avoids expensive
    // dashboard recalculations on every 15-min tick when nothing changed
    if (sales.length > 0) await _bustCacheForBusiness(businessId);
  } finally {
    await db.query('UPDATE pos_connections SET is_syncing=false WHERE business_id=$1', [businessId]);
  }
}

// ── _saveCategories ───────────────────────────────────────────
async function _saveCategories(businessId, categories) {
  if (!categories.length) return;
  const vals   = categories.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(',');
  const params = [businessId, ...categories.flatMap(c => [c.name, c.posId])];
  await db.query(
    `INSERT INTO recipe_categories (business_id, name, pos_category_id) VALUES ${vals}
     ON CONFLICT (business_id, pos_category_id) DO UPDATE SET name = EXCLUDED.name`,
    params
  );
}

// ── _saveProducts ─────────────────────────────────────────────
async function _saveProducts(businessId, products) {
  if (!products.length) return;
  const vals   = products.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(',');
  const params = [businessId, ...products.flatMap(p => [p.name, p.posItemId, p.price])];
  await db.query(
    `INSERT INTO recipes (business_id, name, pos_item_id, selling_price) VALUES ${vals}
     ON CONFLICT (business_id, pos_item_id)
     DO UPDATE SET name = EXCLUDED.name, selling_price = EXCLUDED.selling_price, updated_at = NOW()`,
    params
  );
}

// ── _saveSales ────────────────────────────────────────────────
async function _saveSales(businessId, sales) {
  if (!sales.length) return;
  const client = await db.getClient();
  const newSaleIds = [];
  try {
    await client.query('BEGIN');

    // ① מציאת מכירות קיימות בשאילתה אחת (במקום שאילתה לכל מכירה)
    const incomingPosIds = sales.map(s => s.posId).filter(Boolean);
    let existingSet = new Set();
    if (incomingPosIds.length) {
      const { rows: existing } = await client.query(
        `SELECT pos_sale_id FROM sales WHERE business_id = $1 AND pos_sale_id = ANY($2)`,
        [businessId, incomingPosIds]
      );
      existingSet = new Set(existing.map(r => r.pos_sale_id));
    }

    const newSales = sales.filter(s => !existingSet.has(s.posId));
    if (!newSales.length) { await client.query('COMMIT'); return; }

    // ② טעינת כל ה-recipes של העסק בשאילתה אחת — לפי pos_item_id ולפי שם
    const allItems = newSales.flatMap(s => s.items || []);
    const allPosItemIds = [...new Set(allItems.map(i => i.posItemId).filter(Boolean))];
    const allNames      = [...new Set(allItems.map(i => i.name).filter(Boolean))];

    const byPosId  = {};
    const byName   = {};

    if (allPosItemIds.length) {
      const { rows } = await client.query(
        `SELECT id, pos_item_id FROM recipes WHERE business_id = $1 AND pos_item_id = ANY($2)`,
        [businessId, allPosItemIds]
      );
      rows.forEach(r => { byPosId[r.pos_item_id] = r.id; });
    }

    if (allNames.length) {
      const { rows } = await client.query(
        `SELECT id, LOWER(name) AS lname FROM recipes
         WHERE business_id = $1 AND LOWER(name) = ANY($2)`,
        [businessId, allNames.map(n => n.toLowerCase())]
      );
      rows.forEach(r => { byName[r.lname] = r.id; });
    }

    // ③ Batch INSERT all new sales (chunked to stay within PG's 65535-param limit)
    const SALE_CHUNK = 500; // 500 × 5 params = 2500 per batch, well within limit
    const itemsByPosId = {};
    for (const s of newSales) {
      if (s.posId && (s.items || []).length > 0) itemsByPosId[s.posId] = s.items;
    }

    for (let ci = 0; ci < newSales.length; ci += SALE_CHUNK) {
      const chunk = newSales.slice(ci, ci + SALE_CHUNK);
      const saleVals = chunk.map((_, i) => {
        const b = i * 5 + 2;
        return `($1,$${b},$${b+1},$${b+2},$${b+3},$${b+4})`;
      }).join(',');
      const saleParams = chunk.flatMap(s => [s.posId, s.type, s.tableNumber, s.totalAmount, s.soldAt]);

      const { rows: insertedSales } = await client.query(
        `INSERT INTO sales (business_id, pos_sale_id, sale_type, table_number, total_amount, sold_at)
         VALUES ${saleVals}
         ON CONFLICT DO NOTHING
         RETURNING id, pos_sale_id`,
        [businessId, ...saleParams]
      );

      // Collect items for this chunk using the returned pos_sale_id → id mapping
      const allItems = [];
      for (const row of insertedSales) {
        newSaleIds.push(row.id);
        const items = row.pos_sale_id ? (itemsByPosId[row.pos_sale_id] || []) : [];
        for (const item of items) {
          const recipeId = byPosId[item.posItemId] ?? byName[item.name?.toLowerCase()] ?? null;
          allItems.push([row.id, recipeId, item.posItemId, item.name, item.qty, item.unitPrice, item.totalPrice]);
        }
      }

      // Batch INSERT items in sub-chunks (7 params each → 1000 items = 7000 params)
      const ITEM_CHUNK = 1000;
      for (let ii = 0; ii < allItems.length; ii += ITEM_CHUNK) {
        const iChunk  = allItems.slice(ii, ii + ITEM_CHUNK);
        const itemVals = iChunk.map((_, j) => {
          const b = j * 7 + 1;
          return `($${b},$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
        }).join(',');
        await client.query(
          `INSERT INTO sale_items (sale_id, recipe_id, pos_item_id, name, qty, unit_price, total_price) VALUES ${itemVals}`,
          iChunk.flat()
        );
      }
    }

    await client.query('COMMIT');

    for (const saleId of newSaleIds) {
      onSaleCreated(businessId, saleId).catch(err =>
        logger.warn('onSaleCreated failed', { saleId, err: err.message })
      );
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { connect, syncFullHistory, syncIncremental };
