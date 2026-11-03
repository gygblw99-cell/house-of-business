const express    = require('express');
const router     = express.Router();
const { requireAuth, requirePermission, requireManager } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const inventoryModel = require('../models/inventory.model');
const { log, ACTIONS } = require('../services/activityLog.service');
const { paginated }     = require('../utils/apiResponse');
const { parseIntRange } = require('../utils/parseQuery');
const eventBus   = require('../utils/eventBus');
const { onInventoryChanged, saveLowInventoryNotification, dismissNotifications } = require('../services/sync.service');
const logger     = require('../utils/logger');
const db         = require('../utils/db');
const Anthropic  = require('@anthropic-ai/sdk');
const cache      = require('../utils/cache');
const { wrapWithLock } = require('../utils/cache');
const { bustContextCache } = require('../services/ai/business.context');
const { withTimeout } = require('../utils/withTimeout');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Safety net — DB-level constraint prevents current_qty ever going negative (IF NOT EXISTS via DO block)
db.migrate(`DO $$ BEGIN ALTER TABLE inventory_items ADD CONSTRAINT chk_qty_nonneg CHECK (current_qty >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`).catch(() => {});

// Allow decimal quantities (e.g. 36.9 kg) — ALTER INTEGER → NUMERIC(12,3)
db.migrate(`
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'inventory_items' AND column_name = 'current_qty'
        AND data_type = 'integer'
    ) THEN
      ALTER TABLE inventory_items
        ALTER COLUMN current_qty TYPE NUMERIC(12,3),
        ALTER COLUMN min_qty     TYPE NUMERIC(12,3);
      ALTER TABLE inventory_transactions
        ALTER COLUMN qty_change TYPE NUMERIC(12,3),
        ALTER COLUMN qty_after  TYPE NUMERIC(12,3);
    END IF;
  END $$
`).catch(() => {});

// Add max_qty column for weekly order calculation
db.migrate(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS max_qty NUMERIC(12,3)`).catch(() => {});

// Item type — separates food/beverage from non-food (cleaning, equipment).
// Non-food items are excluded from dish builder catalog and COGS reports.
db.migrate(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'מזון'`).catch(() => {});

// Purchase unit support (Approach 2): track inventory in base units (e.g. grams)
// but allow entering stock additions in purchase units (e.g. "2 שקים של 25 ק"ג").
// purchase_unit  — display name for the package (e.g. "שק", "ארגז", "גלון")
// units_per_purchase — how many base units (ii.unit) are in one purchase unit
db.migrate(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_unit VARCHAR(50) DEFAULT NULL`).catch(() => {});
db.migrate(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS units_per_purchase NUMERIC(10,3) DEFAULT 1`).catch(() => {});

// GET /api/inventory — כל פריטי המלאי
router.get('/', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const { categoryId, lowStock } = req.query;
    const limit  = parseIntRange(req.query.limit,  1, 500, 200);
    const offset = parseIntRange(req.query.offset, 0, 1e9,   0);

    const catFilter  = categoryId ? ' AND ii.category_id = $2' : '';
    const lowFilter  = lowStock === 'true' ? ' AND ii.current_qty <= ii.min_qty AND ii.min_qty > 0' : '';
    const countParams = categoryId ? [req.user.businessId, categoryId] : [req.user.businessId];

    const [items, countRow] = await Promise.all([
      inventoryModel.findAllByBusiness(req.user.businessId, {
        categoryId: categoryId || null,
        lowStock:   lowStock === 'true',
        limit,
        offset,
      }),
      db.query(
        `SELECT COUNT(*)::int AS total FROM inventory_items ii WHERE ii.business_id = $1${catFilter}${lowFilter}`,
        countParams
      ),
    ]);

    paginated(res, { items, total: countRow.rows[0].total, limit, offset });
  } catch (err) { next(err); }
});

// GET /api/inventory/value — שווי מלאי כולל
router.get('/value', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const value = await inventoryModel.getInventoryValue(req.user.businessId);
    res.json(value);
  } catch (err) { next(err); }
});

// GET /api/inventory/waste?days=30 — סיכום בזבוז
router.get('/waste', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const days = parseIntRange(req.query.days, 1, 365, 30);
    const waste = await inventoryModel.getWasteSummary(req.user.businessId, days);
    res.json(waste);
  } catch (err) { next(err); }
});

// GET /api/inventory/categories — קטגוריות
router.get('/categories', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const cats = await inventoryModel.getCategories(req.user.businessId);
    res.json(cats);
  } catch (err) { next(err); }
});

// POST /api/inventory/categories — קטגוריה חדשה
router.post('/categories', requireAuth, requireManager, validate({ body: schemas.createInventoryCategorySchema }), async (req, res, next) => {
  try {
    const { name } = req.body;
    const cat = await inventoryModel.createCategory(req.user.businessId, name);
    eventBus.publish(req.user.businessId, 'inventory.updated', { action: 'category_created', categoryId: cat.id });
    res.status(201).json(cat);
  } catch (err) { next(err); }
});

// DELETE /api/inventory/categories/:id
router.delete('/categories/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    await inventoryModel.deleteCategory(req.params.id, req.user.businessId);
    eventBus.publish(req.user.businessId, 'inventory.updated', { action: 'category_deleted', categoryId: req.params.id });
    res.json({ message: 'קטגוריה נמחקה' });
  } catch (err) { next(err); }
});

// GET /api/inventory/transactions — היסטוריית תנועות
router.get('/transactions', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const { itemId, type, fromDate, toDate, limit, offset } = req.query;
    const transactions = await inventoryModel.getTransactions(req.user.businessId, {
      itemId: itemId || null,
      type:   type   || null,
      fromDate, toDate,
      limit:  parseIntRange(limit,  1, 100, 25),
      offset: parseIntRange(offset, 0, 1e9,  0),
    });
    res.json(transactions);
  } catch (err) { next(err); }
});

// GET /api/inventory/by-supplier — מלאי מקובץ לפי ספק
router.get('/by-supplier', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {

    const { rows } = await db.query(
      `SELECT
         ii.id, ii.name, ii.unit,
         ii.current_qty::float  AS current_qty,
         ii.min_qty::float      AS min_qty,
         ii.cost_per_unit::float AS cost_per_unit,
         CASE WHEN ii.min_qty > 0 AND ii.current_qty <= ii.min_qty THEN TRUE ELSE FALSE END AS is_low,
         ii.supplier_id,
         s.name AS supplier_name
       FROM inventory_items ii
       LEFT JOIN suppliers s ON s.id = ii.supplier_id
       WHERE ii.business_id = $1
       ORDER BY s.name NULLS LAST, ii.name ASC`,
      [req.user.businessId]
    );

    const map = {};
    for (const item of rows) {
      const key = item.supplier_id || '__none__';
      if (!map[key]) {
        map[key] = {
          supplier_id:   item.supplier_id,
          supplier_name: item.supplier_name || 'ללא ספק',
          items: [],
        };
      }
      map[key].items.push(item);
    }

    res.json({ suppliers: Object.values(map) });
  } catch (err) { next(err); }
});

// GET /api/inventory/for-recipes — כל פריטי המלאי בפורמט מרכיבים למנות
router.get('/for-recipes', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {

    const { rows } = await db.query(
      `SELECT
         ii.id::text                AS key,
         ii.name                    AS name,
         ii.unit                    AS unit,
         ii.unit                    AS latest_unit,
         ii.cost_per_unit::float    AS latest_price,
         ii.cost_per_unit::float    AS avg_price,
         ii.current_qty::float      AS current_qty,
         c.name                     AS category_name
       FROM inventory_items ii
       LEFT JOIN inventory_categories c ON c.id = ii.category_id
       WHERE ii.business_id = $1
       ORDER BY ii.name ASC`,
      [req.user.businessId]
    );
    res.json({ ingredients: rows });
  } catch (err) { next(err); }
});

// GET /api/inventory/expiring?days=3 — פריטים עם תאריך תפוגה קרוב
router.get('/expiring', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 3, 1), 30);

    const { rows } = await db.query(
      `SELECT id, name, unit, current_qty, expiry_date,
              expiry_date - CURRENT_DATE AS days_until_expiry
       FROM inventory_items
       WHERE business_id = $1
         AND expiry_date IS NOT NULL
         AND expiry_date <= CURRENT_DATE + ($2 * INTERVAL '1 day')
       ORDER BY expiry_date ASC`,
      [req.user.businessId, days]
    );
    res.json({ items: rows, days });
  } catch (err) { next(err); }
});

// GET /api/inventory/reorder-suggestions — Smart Reorder AI (must be before /:id)
router.get('/reorder-suggestions', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const cacheKey = `reorder-suggestions:${biz}`;

    // wrapWithLock prevents concurrent requests from all hitting Anthropic on a cache miss.
    // lockTtlSeconds=60 provides headroom above the 25s AI timeout (Promise.race) to ensure
    // the lock does not expire mid-call on a slow-Anthropic response.
    const result = await wrapWithLock(cacheKey, async () => {
    // Items at or below reorder threshold
    const { rows: lowItems } = await db.query(`
      SELECT ii.id, ii.name, ii.current_qty, ii.min_qty, ii.unit,
             ii.cost_per_unit, ii.supplier_id, s.name AS supplier_name
      FROM inventory_items ii
      LEFT JOIN suppliers s ON s.id = ii.supplier_id
      WHERE ii.business_id = $1
        AND ii.is_active = true
        AND ii.min_qty > 0
        AND ii.current_qty <= ii.min_qty * 1.5
      ORDER BY (ii.current_qty / NULLIF(ii.min_qty,0)) ASC
      LIMIT 20
    `, [biz]);

    if (!lowItems.length) {
      return { suggestions: [], generated_at: new Date().toISOString(), message: 'אין פריטים שדורשים הזמנה כרגע' };
    }

    // Real 30-day consumption via dish/recipe sales — the same engine used
    // everywhere else (audit, weekly report, finance). Previously this
    // endpoint summed 90 days of *purchase* volume from invoice_items and
    // labeled it "30-day consumption" in the AI prompt: two compounding
    // problems — purchases aren't consumption (a business that over-bought
    // in the past would get told to keep over-ordering at that inflated
    // rate), and the window was 3x what the prompt claimed.
    const toDateObj   = new Date();
    const fromDateObj = new Date(Date.now() - 30 * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    const fromDateStr = `${fromDateObj.getFullYear()}-${pad(fromDateObj.getMonth() + 1)}-${pad(fromDateObj.getDate())}`;
    const toDateStr   = `${toDateObj.getFullYear()}-${pad(toDateObj.getMonth() + 1)}-${pad(toDateObj.getDate())}`;
    const consumption = await inventoryModel.getConsumptionAnalysis(biz, fromDateStr, toDateStr)
      .catch(() => ({ items: [] }));
    const consumptionMap = Object.fromEntries(consumption.items.map(it => [it.itemId, it]));

    // Purchase price/history (90d) — legitimate use of invoice data: what
    // this item costs and where it's bought, not how fast it's used.
    const names = lowItems.map(i => i.name.toLowerCase());
    const { rows: priceRows } = await db.query(`
      SELECT LOWER(ii.name) AS name,
             COUNT(*)::int   AS purchase_count,
             COALESCE(AVG(ii.unit_price),0)::float AS avg_price,
             MAX(inv.invoice_date) AS last_purchase
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      WHERE inv.business_id = $1
        AND inv.invoice_date >= NOW() - INTERVAL '90 days'
        AND LOWER(ii.name) = ANY($2)
      GROUP BY LOWER(ii.name)
    `, [biz, names]);
    const priceMap = Object.fromEntries(priceRows.map(r => [r.name, r]));

    // Build context for AI
    const itemsContext = lowItems.map(item => {
      const price = priceMap[item.name.toLowerCase()];
      const cons  = consumptionMap[item.id];
      const hasConsumptionData = !!cons && !cons.noSalesData && !cons.notInRecipe;
      return {
        name: item.name,
        current_qty: parseFloat(item.current_qty) || 0,
        min_qty: parseFloat(item.min_qty) || 0,
        unit: item.unit,
        cost_per_unit: parseFloat(item.cost_per_unit) || 0,
        supplier: item.supplier_name || 'לא מוגדר',
        consumed_qty_30d: hasConsumptionData ? Number(cons.consumedQty) || 0 : null,
        has_consumption_data: hasConsumptionData,
        purchases_90d: price?.purchase_count || 0,
        avg_price_90d: parseFloat((price?.avg_price || 0).toFixed(2)),
        last_purchase: price?.last_purchase || null,
      };
    });

    const prompt = `You are a smart inventory reorder AI for a restaurant/food business in Israel.
Analyze these low-stock items and provide smart reorder recommendations.

Low Stock Items:
${JSON.stringify(itemsContext, null, 2)}

consumed_qty_30d = actual quantity consumed via dish/recipe sales over the last 30 days. When has_consumption_data is false, consumed_qty_30d is null — there is no reliable sales-based rate for that item, so do NOT invent one.

For each item, calculate:
1. Recommended order quantity — when has_consumption_data is true, base it on consumed_qty_30d × 1.5 buffer; when false, use minimum = min_qty × 3 instead (do not use purchases_90d as a consumption rate — it reflects how much was bought, not how much was used)
2. Priority (critical/high/medium) based on how far below minimum they are
3. Estimated cost for the order (use cost_per_unit; fall back to avg_price_90d only if cost_per_unit is 0)
4. Brief reasoning in Hebrew (1 sentence)

Return ONLY a valid JSON array (no markdown):
[{
  "name": "",
  "priority": "critical|high|medium",
  "current_qty": 0,
  "min_qty": 0,
  "unit": "",
  "recommended_order_qty": 0,
  "estimated_cost": 0,
  "supplier": "",
  "reasoning": ""
}]`;

    const message = await withTimeout(
    anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    25000, "AI request");

    if (message.stop_reason === 'max_tokens') {
      logger.warn('[inventory/order-suggestions] AI response truncated (max_tokens)');
      throw new Error('תשובת ה-AI נחתכה — נסה שנית');
    }

    const raw = message.content[0]?.text || '[]';
    let suggestions = [];
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      suggestions = JSON.parse(clean);
      if (!Array.isArray(suggestions)) suggestions = [];
    } catch { suggestions = itemsContext.map(i => ({ ...i, priority: 'high', recommended_order_qty: i.min_qty * 3, estimated_cost: i.min_qty * 3 * i.cost_per_unit, reasoning: 'מלאי מתחת לסף המינימום' })); }

    return { suggestions, generated_at: new Date().toISOString() };
    }, 300, 60); // TTL=300s (5 min), lockTtlSeconds=60 (> 25s AI timeout)

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/inventory/consumption-analysis?dateFrom=&dateTo= — ניתוח צריכת מלאי היסטורי
// מחושב חי בכל בקשה (לא נשמר בקאש קבוע) כדי לשקף עלויות מנה/מתכון
// שהתעדכנו אחרי שהדוחות כבר הועלו — כולל דוחות שהוזנו רטרואקטיבית.
router.get('/consumption-analysis', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo || !dateRe.test(dateFrom) || !dateRe.test(dateTo)) {
      return res.status(400).json({ error: 'יש לספק dateFrom ו-dateTo בפורמט YYYY-MM-DD' });
    }
    if (dateFrom > dateTo) {
      return res.status(400).json({ error: 'dateFrom חייב להיות לפני או שווה ל-dateTo' });
    }
    const result = await inventoryModel.getConsumptionAnalysis(req.user.businessId, dateFrom, dateTo);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/inventory/:id — פריט בודד
router.get('/:id', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const item = await inventoryModel.findById(req.params.id, req.user.businessId);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });
    res.json(item);
  } catch (err) { next(err); }
});

// POST /api/inventory — פריט חדש
router.post('/', requireAuth, requireManager, validate({ body: schemas.createInventoryItemSchema }), async (req, res, next) => {
  try {
    const { name, unit, currentQty, minQty, costPerUnit, categoryId, barcode, expiryDate, itemType } = req.body;

    const item = await inventoryModel.create(req.user.businessId, {
      name, unit, currentQty, minQty, costPerUnit, categoryId, barcode, expiryDate, itemType,
      userId: req.user.userId,
    });

    await log(req.user.businessId, req.user.userId, ACTIONS.INVENTORY_UPDATED, {
      action: 'created', itemName: name,
    });
    eventBus.publish(req.user.businessId, 'inventory.updated', { action: 'item_created', itemId: item.id });
    bustContextCache(req.user.businessId).catch(() => {});
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// PUT /api/inventory/:id — עדכון פריט
router.put('/:id', requireAuth, requireManager, validate({ body: schemas.updateInventoryItemSchema }), async (req, res, next) => {
  try {
    const item = await inventoryModel.findById(req.params.id, req.user.businessId);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });

    const updated = await inventoryModel.update(req.params.id, req.user.businessId, req.body);

    // Log manual qty change to inventory_transactions so Approach A COGS has a full ledger
    if (req.body.currentQty !== undefined) {
      const oldQty = parseFloat(item.current_qty) || 0;
      const newQty = parseFloat(req.body.currentQty) || 0;
      const delta  = newQty - oldQty;
      if (Math.abs(delta) > 0.0001) {
        db.query(
          `INSERT INTO inventory_transactions (business_id, item_id, type, qty_change, qty_after, reason)
           VALUES ($1, $2, 'manual_adjust', $3, $4, $5)`,
          [req.user.businessId, req.params.id, delta, newQty, 'עדכון ידני']
        ).catch(() => {});
      }
    }

    await log(req.user.businessId, req.user.userId, ACTIONS.INVENTORY_UPDATED, {
      action: 'updated', itemName: item.name,
    });

    onInventoryChanged(req.user.businessId).catch(err => logger.warn('onInventoryChanged failed', { err: err.message }));
    bustContextCache(req.user.businessId).catch(() => {});
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/inventory/by-supplier/:supplierId — מחיקת כל פריטי ספק
router.delete('/by-supplier/:supplierId', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { supplierId } = req.params;
    const businessId = req.user.businessId;
    // Fetch all item IDs for this supplier
    const { rows } = await db.query(
      `SELECT id FROM inventory_items WHERE business_id = $1 AND supplier_id = $2`,
      [businessId, supplierId]
    );
    if (!rows.length) return res.status(404).json({ error: 'לא נמצאו פריטים לספק זה' });

    // One statement for the whole set, with the per-row loop kept only as the
    // fallback. recipe_ingredients.item_id is ON DELETE RESTRICT, so a single
    // batched DELETE aborts entirely if even one item is used in a recipe —
    // which is why this was a query per item. Trying the batch first makes the
    // common case (no item in a recipe) 1 round trip instead of N, and the loop
    // still runs when something is actually referenced, so which items get
    // skipped is decided exactly as before.
    const ids = rows.map(r => r.id);
    let deleted = 0;
    const skipped = [];
    try {
      const r = await db.query(
        `DELETE FROM inventory_items WHERE business_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
        [businessId, ids]
      );
      deleted = r.rowCount;
    } catch (e) {
      if (e.code !== '23503') throw e;
      // At least one item is referenced — identify them one at a time.
      for (const id of ids) {
        try {
          const r = await db.query(
            `DELETE FROM inventory_items WHERE id = $1 AND business_id = $2 RETURNING id`,
            [id, businessId]
          );
          if (r.rowCount > 0) deleted++;
        } catch (inner) {
          if (inner.code === '23503') skipped.push(id); // used in recipe
          else throw inner;
        }
      }
    }

    eventBus.publish(businessId, 'inventory.updated', { action: 'supplier_deleted', supplierId, deleted });
    bustContextCache(businessId).catch(() => {});
    res.json({
      message: skipped.length
        ? `נמחקו ${deleted} פריטים. ${skipped.length} פריטים לא נמחקו כי הם משמשים במתכונים.`
        : `נמחקו ${deleted} פריטים`,
      deleted,
      skipped: skipped.length,
    });
  } catch (err) { next(err); }
});

// DELETE /api/inventory/:id — מחיקת פריט
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    // RETURNING id מוודא אטומיות — אין race condition בין SELECT ל-DELETE
    const deleted = await inventoryModel.remove(req.params.id, req.user.businessId);
    if (!deleted) return res.status(404).json({ error: 'פריט לא נמצא' });
    eventBus.publish(req.user.businessId, 'inventory.updated', { action: 'item_deleted', itemId: req.params.id });
    bustContextCache(req.user.businessId).catch(() => {});
    res.json({ message: 'פריט נמחק' });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'לא ניתן למחוק — הפריט משמש במתכונים. הסר אותו מהמתכונים תחילה.' });
    next(err);
  }
});

// POST /api/inventory/:id/transaction — רישום תנועה
router.post('/:id/transaction', requireAuth, requirePermission('inventory'), validate({ body: schemas.inventoryTransactionSchema }), async (req, res, next) => {
  try {
    // תומך בשני פורמטים: qtyChange ו-qty (alias)
    const rawQty  = req.body.qtyChange ?? req.body.qty;
    const rawType = req.body.type;
    const note    = req.body.note;

    // מיפוי שמות ידידותיים → שמות DB
    const TYPE_MAP = { add: 'purchase', remove: 'adjustment' };
    const type      = TYPE_MAP[rawType] || rawType;
    // 'remove'/'waste' הן פעולות הפחתה מבחינה סמנטית — הממשק (כולל הקלטה
    // קולית) תמיד שולח כמות חיובית ("בזבוז 3 קילו"), ואף קוד לא הפך את
    // הסימן לפני עכשיו. בלי זה, דיווח "בזבוז"/"הפחתה" הוסיף בפועל למלאי
    // במקום להוריד ממנו — התגלה תוך כדי בדיקה חיה של פיצ'ר "מלאי שנזרק".
    if (rawQty === undefined) {
      return res.status(400).json({ error: 'הכמות חייבת להיות מספר חיובי' });
    }
    // 'purchase' (בין אם הגיע כ-'add' מ-web/הקלטה קולית ובין אם ישירות כ-
    // 'purchase' ממובייל) הוא חד-משמעית תוספת — בלי קשר לאיזה alias (qty/
    // qtyChange) נשא את הערך. בלי הבדיקה הזו לפי type (ולא לפי שם השדה),
    // "הוסף" עם כמות שלילית (טעות הקלדה, או שליחה דרך qtyChange) היה מפחית
    // מהמלאי בשקט תחת type='purchase', בניגוד לתווית שהמשתמש רואה.
    // 'sale'/'adjustment' לא נבדקים כאן — אלה כבר מגיעים ממובייל כדלתא
    // מסומנת-סימן (יכולה להיות שלילית באופן לגיטימי).
    if (type === 'purchase' && !(rawQty > 0)) {
      return res.status(400).json({ error: 'הכמות חייבת להיות מספר חיובי' });
    }
    const isDecrease = rawType === 'remove' || rawType === 'waste';
    const qtyChange  = isDecrease ? -Math.abs(rawQty) : rawQty;

    if (!type || qtyChange === undefined) {
      return res.status(400).json({ error: 'type ו-qty הם שדות חובה' });
    }
    const validTypes = ['purchase','sale','waste','adjustment','transfer'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `סוג תנועה לא חוקי. חוקיים: add, remove, waste, purchase, adjustment, transfer` });
    }

    const item = await inventoryModel.findById(req.params.id, req.user.businessId);
    if (!item) return res.status(404).json({ error: 'פריט לא נמצא' });

    let tx;
    try {
      tx = await inventoryModel.recordTransaction(req.user.businessId, {
        itemId: req.params.id, type, qtyChange, note,
        userId: req.user.userId, date: req.body.date,
      });
    } catch (txErr) {
      if (txErr.statusCode === 409) return res.status(409).json({ error: txErr.message });
      throw txErr;
    }

    if (type === 'waste') {
      await log(req.user.businessId, req.user.userId, ACTIONS.WASTE_RECORDED, {
        itemName: item.name, qty: Math.abs(qtyChange), unit: item.unit,
      });
      eventBus.publish(req.user.businessId, 'waste_recorded', { itemName: item.name, qty: Math.abs(qtyChange), unit: item.unit });
    }

    // בדיקת מלאי נמוך אחרי עדכון — שמירה ב-DB
    const updated = await inventoryModel.findById(req.params.id, req.user.businessId);
    if (updated && updated.is_low) {
      saveLowInventoryNotification(req.user.businessId, updated).catch(err => logger.warn('saveLowInventoryNotification failed', { err: err.message }));
    } else if (updated && !updated.is_low && ['purchase', 'adjustment'].includes(type) && qtyChange > 0) {
      // פריט עלה מעל הסף — מבטל את התראת המלאי הנמוך שלו
      dismissNotifications(req.user.businessId, 'low_inventory', updated.name).catch(() => {});
    }

    onInventoryChanged(req.user.businessId).catch(err => logger.warn('onInventoryChanged failed', { err: err.message }));
    res.status(201).json(tx);
  } catch (err) { next(err); }
});

// ── ספירת מלאי פיזית ─────────────────────────────────────────────────────────
// POST /api/inventory/stocktake — { items: [{ itemId, countedQty }], note? }
//
// This is the input the whole leak-detection feature was missing. Everything
// else the system knows about consumption is derived from the recipes, so the
// leakage agent was comparing the recipe math against itself; a counted shelf
// is the only independent measurement, and only between two counts can the
// system state actual consumption rather than guess it.
router.post('/stocktake', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'יש לשלוח רשימת פריטים לספירה' });
    }
    if (items.length > 1000) {
      return res.status(400).json({ error: 'יותר מדי פריטים בספירה אחת' });
    }
    for (const it of items) {
      if (!it || typeof it.itemId !== 'string') {
        return res.status(400).json({ error: 'כל פריט חייב לכלול itemId' });
      }
      const q = parseFloat(it.countedQty);
      if (!isFinite(q) || q < 0) {
        return res.status(400).json({ error: 'כמות ספירה חייבת להיות מספר אי-שלילי' });
      }
    }

    let result;
    try {
      result = await inventoryModel.recordStocktake(req.user.businessId, {
        items:  items.map(i => ({ itemId: i.itemId, countedQty: i.countedQty })),
        userId: req.user.userId,
        note:   typeof req.body.note === 'string' ? req.body.note.slice(0, 500) : null,
      });
    } catch (stErr) {
      if (stErr.statusCode) return res.status(stErr.statusCode).json({ error: stErr.message });
      throw stErr;
    }

    await log(req.user.businessId, req.user.userId, ACTIONS.STOCKTAKE_RECORDED, {
      itemsCount: result.itemsCount, totalDeltaValue: result.totalDeltaValue,
    }).catch(() => {});
    eventBus.publish(req.user.businessId, 'inventory.updated', { reason: 'stocktake' });

    // A count redefines the verified window for every leakage/cost report, so
    // their cached answers are stale the moment it lands.
    onInventoryChanged(req.user.businessId).catch(err => logger.warn('onInventoryChanged failed', { err: err.message }));

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// GET /api/inventory/stocktake/dates — מתי בוצעו ספירות מלאי
router.get('/stocktake/dates', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const limit = parseIntRange(req.query.limit, 1, 50, 12);
    res.json(await inventoryModel.getStocktakeDates(req.user.businessId, limit));
  } catch (err) { next(err); }
});

module.exports = router;
