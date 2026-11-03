const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const logger  = require('../utils/logger');
const { requireAuth, requirePermission, requireActiveBusiness } = require('../middleware/auth');
const { upload, UPLOAD_DIR, validateMagicBytes, buildUploadUrl } = require('../utils/upload');
const { processInvoice }     = require('../agents/invoiceOCR.agent');
const invoiceModel           = require('../models/invoice.model');
const cache                  = require('../utils/cache');

const rateLimit  = require('express-rate-limit');
const eventBus   = require('../utils/eventBus');
const db         = require('../utils/db');
const Anthropic  = require('@anthropic-ai/sdk');
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { addManyToGallery } = require('../services/gallery/gallery.service');
const { onInvoiceApproved } = require('../services/sync.service');
const { withTransaction }   = require('../utils/transaction');
const { checkPriceChanges, syncInventoryFromInvoice, detectInventoryDuplicates, storeDuplicateAlerts, storePriceAlerts, notifyPriceChanges, checkInventoryCostSanity, strSimilarity } = require('../services/invoice.service');
const { rateLimitAI }    = require('../middleware/rateLimitAI');
const { parseIntRange }  = require('../utils/parseQuery');
const { bustContextCache } = require('../services/ai/business.context');
const { withTimeout } = require('../utils/withTimeout');

// item_type on invoice_items — allows COGS to exclude non-food lines (cleaning, equipment)
db.migrate(`ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(50) DEFAULT 'מזון'`).catch(() => {});

// Indexes for invoice price-change detection — run once on startup
const db2 = db; // alias to avoid shadowing in migration block
db2.migrate(`CREATE INDEX IF NOT EXISTS idx_invoice_items_biz_date
  ON invoice_items (invoice_id)`);
db2.migrate(`CREATE INDEX IF NOT EXISTS idx_invoices_biz_date
  ON invoices (business_id, invoice_date DESC)`);
db2.migrate(`CREATE INDEX IF NOT EXISTS idx_invoice_items_name_lower
  ON invoice_items (LOWER(name))`);
db2.migrate(`CREATE INDEX IF NOT EXISTS idx_inventory_biz_expiry
  ON inventory_items (business_id, expiry_date) WHERE expiry_date IS NOT NULL`);

// OCR upload: max 30 per user per hour (each call = Claude Vision API cost)
const ocrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.userId || 'anon',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'חרגת ממכסת העלאות חשבוניות לשעה, נסה שוב מאוחר יותר' },
});

// Invoice business logic lives in services/invoice.service.js
// (checkPriceChanges, syncInventoryFromInvoice, storePriceAlerts)
const canView    = [requireAuth];
const canManage  = [requireAuth, requirePermission('suppliers')];
// OCR and AI routes cost money per call — block them when admin has deactivated the business
const canUpload  = [requireAuth, requireActiveBusiness, requirePermission('suppliers')];

// ── GET /api/invoices/inventory-duplicates ────────────────────
// מחזיר זוגות פריטי מלאי כפולים לפי דמיון שמות
router.get('/inventory-duplicates', ...canView, async (req, res, next) => {
  try {
    const pairs = await detectInventoryDuplicates(req.user.businessId);
    res.json({ duplicates: pairs, count: pairs.length });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/ai-search ──────────────────────────────
router.post('/ai-search', ...canView, rateLimitAI(), async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'שאילתה חסרה' });

    const today = new Date().toISOString().slice(0, 10);
    const year  = new Date().getFullYear();
    const result = await withTimeout(
    anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        system: `היום: ${today}\nחלץ פרמטרי חיפוש לחשבוניות לפי קלט המשתמש והחזר JSON בלבד:\n{"supplierName":"שם ספק חלקי או null","dateFrom":"YYYY-MM-DD או null","dateTo":"YYYY-MM-DD או null","invoiceNumber":"מספר חשבונית חלקי או null","minAmount":number_or_null,"maxAmount":number_or_null,"isPaid":true/false/null,"keyword":"מילת חיפוש כללית או null"}\nדוגמאות: "שוק תל אביב"→supplierName:"שוק תל אביב" | "מינואר"→dateFrom:"${year}-01-01",dateTo:"${year}-01-31" | "לא שולמו"→isPaid:false | "מעל 1000 שקל"→minAmount:1000\nהחזר JSON בלבד ללא הסברים.`,
        messages: [{ role: 'user', content: query.trim() }],
      }),
    15_000, "AI");
    if (result.stop_reason === 'max_tokens') {
      logger.warn('[invoices/ai-search] AI response truncated (max_tokens)');
      return res.status(502).json({ error: 'תשובת ה-AI נחתכה — נסה שנית' });
    }
    const text = result.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      return res.status(400).json({ error: 'לא הצלחתי לפענח את תשובת ה-AI, נסה שוב' });
    }

    res.json({ filters: parsed, query });
  } catch (err) { next(err); }
});

// ── GET /api/invoices/supplier-trends ────────────────────────
router.get('/supplier-trends', ...canView, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const rows = await cache.wrap(`supplier-trends:${biz}`, async () => {
      const { rows: r } = await db.query(
        `WITH ranked AS (
           SELECT
             i.supplier_id,
             i.total_amount,
             COALESCE(i.invoice_date, i.created_at::date) AS eff_date,
             ROW_NUMBER() OVER (
               PARTITION BY i.supplier_id
               ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC
             ) AS rn
           FROM invoices i
           WHERE i.business_id = $1 AND i.total_amount IS NOT NULL
         ),
         agg AS (
           SELECT
             supplier_id,
             json_agg(
               json_build_object('amount', total_amount, 'date', eff_date)
               ORDER BY eff_date ASC
             ) AS invoices,
             COUNT(*)::int AS invoice_count
           FROM ranked
           WHERE rn <= 24
           GROUP BY supplier_id
           HAVING COUNT(*) >= 2
         )
         SELECT s.id AS supplier_id, s.name AS supplier_name, a.invoices, a.invoice_count
         FROM agg a
         JOIN suppliers s ON s.id = a.supplier_id
         WHERE s.business_id = $1
         ORDER BY s.name
         LIMIT 20`,
        [biz]
      );
      return r;
    }, 600); // 10 minutes — invoice trends don't change frequently

    const trends = rows.map(row => {
      const amounts = row.invoices.map(inv => parseFloat(inv.amount));
      const dates   = row.invoices.map(inv => inv.date);
      const last    = amounts[amounts.length - 1];
      const prev    = amounts[amounts.length - 2];
      const pct     = prev > 0 ? ((last - prev) / prev) * 100 : 0;
      const trend   = pct > 2 ? 'up' : pct < -2 ? 'down' : 'stable';
      return {
        supplierId:   row.supplier_id,
        supplierName: row.supplier_name,
        amounts,
        dates,
        lastAmount:   last,
        prevAmount:   prev,
        pctChange:    Math.round(pct * 10) / 10,
        trend,
      };
    });

    res.json({ trends });
  } catch (err) { next(err); }
});

// ── GET /api/invoices/stats ───────────────────────────────────
router.get('/stats', ...canView, async (req, res, next) => {
  try {
    const stats = await invoiceModel.getStats(req.user.businessId);
    res.json(stats);
  } catch (err) { next(err); }
});

// ── GET /api/invoices ─────────────────────────────────────────
router.get('/', ...canView, async (req, res, next) => {
  try {
    const { supplierId, paid, search } = req.query;
    const isPaid  = paid === 'true' ? true : paid === 'false' ? false : undefined;
    const limit   = parseIntRange(req.query.limit,  1, 200, 50);
    const offset  = parseIntRange(req.query.offset, 0, 1e9,  0);
    const year    = req.query.year  ? parseIntRange(req.query.year,  2000, 2100) : undefined;
    const month   = req.query.month ? parseIntRange(req.query.month, 1,    12)   : undefined;

    const [invoices, total] = await Promise.all([
      invoiceModel.findAllByBusiness(req.user.businessId, { supplierId, isPaid, search, year, month, limit, offset }),
      invoiceModel.count(req.user.businessId, { supplierId, isPaid, search, year, month }),
    ]);

    res.json({ invoices, total, limit, offset, hasMore: offset + invoices.length < total });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/upload ─────────────────────────────────
// Web App שולח field בשם 'invoices', Mobile שולח 'images'
router.post('/upload', ...canUpload, ocrLimiter,
  upload.fields([
    { name: 'invoices', maxCount: 10 },
    { name: 'images',   maxCount: 10 },
  ]),
  async (req, res, next) => {
    try {
      const files = [
        ...(req.files?.invoices || []),
        ...(req.files?.images   || []),
      ];

      if (!files.length) {
        return res.status(400).json({ error: 'לא הועלו קבצים' });
      }

      const filePaths = files.map(f => f.path);

      // Magic byte validation — reject files whose content doesn't match declared type
      const magicResults = await Promise.all(filePaths.map(validateMagicBytes));
      if (magicResults.some(valid => !valid)) {
        await Promise.allSettled(filePaths.map(p => fs.promises.unlink(p).catch(() => {})));
        return res.status(400).json({ error: 'סוג קובץ לא תקין — הועלה קובץ שאינו תמונה או PDF' });
      }

      // חשבונית מרובת עמודים — שאלת אישור (רק בראשונה, ללא mergePages)
      if (filePaths.length > 1 && req.body.mergePages === undefined) {
        const basenames = filePaths.map(p => path.basename(p));
        // Record business ownership so confirm-merge can reject cross-tenant reuse.
        const TTL_SEC = 2 * 60 * 60;
        const cacheResults = await Promise.allSettled(basenames.map(n =>
          cache.set(`upload:owner:${n}`, String(req.user.businessId), TTL_SEC)
        ));
        if (cacheResults.some(r => r.status === 'rejected')) {
          logger.warn('[Invoices] Failed to record temp-file ownership — confirm-merge cross-tenant guard degraded', {
            businessId: req.user.businessId,
          });
        }
        return res.status(200).json({
          status:      'multipage_confirm_required',
          pagesCount:  filePaths.length,
          tempFiles:   basenames,
          message:     `זוהו ${filePaths.length} עמודים — האם לאחד לחשבונית אחת?`,
        });
      }

      const mergePages = req.body.mergePages !== 'false';
      const result = await processInvoice(
        req.user.businessId,
        filePaths,
        { mergePages, uploadedBy: req.user.userId }
      );

      const SUCCESS_STATUSES = ['matched', 'unmatched', 'supplier_created'];
      if (SUCCESS_STATUSES.includes(result.status)) {
        eventBus.publish(req.user.businessId, 'invoice_uploaded', { count: result.invoices?.length || 1 });
      }
      const httpStatus = result.status === 'duplicate' ? 200
        : SUCCESS_STATUSES.includes(result.status) ? 201
        : 200; // manual_required and other non-success statuses
      res.status(httpStatus).json(result);
    } catch (err) { next(err); }
  }
);

// ── POST /api/invoices/upload/confirm-merge ───────────────────
router.post('/upload/confirm-merge', ...canUpload, ocrLimiter, async (req, res, next) => {
  try {
    const { tempFiles, merge } = req.body;
    if (!tempFiles?.length) return res.status(400).json({ error: 'קבצים חסרים' });

    // Validate filenames — only bare alphanumeric/dash/dot/underscore names allowed
    const SAFE_FILENAME = /^[\w\-. ]+$/;
    const safeFiles = (tempFiles || []).filter(f =>
      typeof f === 'string' && f.length > 0 && f.length <= 255 &&
      !f.includes('\0') && !f.includes('..') &&
      path.basename(f) === f && SAFE_FILENAME.test(f)
    );
    if (!safeFiles.length) return res.status(400).json({ error: 'שמות קבצים לא תקינים' });
    const filePaths = safeFiles.map(f => path.join(UPLOAD_DIR, f));

    // Verify cross-tenant ownership — each file must have been uploaded by this business.
    for (const f of safeFiles) {
      const owner = await cache.get(`upload:owner:${f}`);
      if (owner != null && owner !== String(req.user.businessId)) {
        return res.status(403).json({ error: 'אין הרשאה לקובץ זה' });
      }
    }

    // Verify each file exists and was uploaded recently (prevents cross-tenant reuse of old temp files)
    const MAX_TEMP_AGE_MS = 2 * 60 * 60 * 1000;
    for (const fp of filePaths) {
      let stat;
      try { stat = fs.statSync(fp); } catch {
        return res.status(400).json({ error: 'קובץ זמני לא נמצא — נא להעלות מחדש' });
      }
      if (Date.now() - stat.mtimeMs > MAX_TEMP_AGE_MS) {
        return res.status(400).json({ error: 'קובץ זמני פג תוקף — נא להעלות מחדש' });
      }
    }

    // Re-validate magic bytes — temp files may have been swapped between upload and confirm-merge.
    // validateMagicBytes returns a plain boolean (same as in the /upload route above).
    const magicResults = await Promise.all(filePaths.map(validateMagicBytes));
    if (magicResults.some(valid => !valid)) {
      await Promise.allSettled(filePaths.map(p => fs.promises.unlink(p).catch(() => {})));
      return res.status(400).json({ error: 'סוג קובץ לא נתמך — magic bytes לא תקינים' });
    }

    const result = await processInvoice(
      req.user.businessId,
      filePaths,
      { mergePages: merge !== false, uploadedBy: req.user.userId }
    );
    if (result.status !== 'duplicate') {
      eventBus.publish(req.user.businessId, 'invoice_uploaded', { count: result.invoices?.length || 1 });
    }

    // Save images to gallery (fire-and-forget)
    const galleryItems = (result.invoices || []).flatMap(inv =>
      (inv.image_urls || []).map(filename => ({
        businessId:  req.user.businessId,
        imageUrl:    buildUploadUrl(filename),
        category:    'invoices',
        title:       (inv.supplier_name || 'חשבונית') + (inv.invoice_number ? ` #${inv.invoice_number}` : ''),
        description: inv.invoice_date ? `חשבונית מ-${inv.invoice_date}` : null,
        entityId:    inv.id,
        entityType:  'invoice',
      }))
    );
    if (galleryItems.length) addManyToGallery(galleryItems).catch(() => {});

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── GET /api/invoices/:id ─────────────────────────────────────
router.get('/:id', ...canView, async (req, res, next) => {
  try {
    const invoice = await invoiceModel.findById(req.params.id, req.user.businessId);
    if (!invoice) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
    res.json({ invoice });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/sync-inventory/preview ─────────────────
// מנתח התאמות בין פריטי חשבוניות לבין מלאי קיים — ללא שמירה
router.post('/sync-inventory/preview', ...canManage, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [{ rows: invoiceItems }, { rows: inventory }] = await Promise.all([
      db.query(
        `SELECT LOWER(TRIM(it.name)) AS name_key, TRIM(it.name) AS name, it.unit, i.supplier_id,
                SUM(it.qty::numeric) AS total_qty,
                (ARRAY_AGG(it.unit_price::numeric ORDER BY i.invoice_date DESC NULLS LAST)
                 FILTER (WHERE it.unit_price IS NOT NULL AND it.unit_price > 0))[1] AS latest_price
         FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
         WHERE i.business_id = $1 AND TRIM(it.name) != ''
         GROUP BY LOWER(TRIM(it.name)), TRIM(it.name), it.unit, i.supplier_id`,
        [businessId]
      ),
      db.query(
        `SELECT id, name, LOWER(name) AS name_lower FROM inventory_items WHERE business_id = $1 ORDER BY name`,
        [businessId]
      ),
    ]);

    const exact = [], fuzzy = [], newItems = [];
    const inventoryList = inventory.map(r => ({ id: r.id, name: r.name }));

    for (const item of invoiceItems) {
      const exactMatch = inventory.find(r => r.name_lower === item.name_key);
      if (exactMatch) {
        exact.push({
          invoiceName: item.name,
          inventoryId: exactMatch.id,
          inventoryName: exactMatch.name,
          price: parseFloat(item.latest_price) || 0,
        });
        continue;
      }

      let bestScore = 0, bestRow = null;
      for (const row of inventory) {
        const s = strSimilarity(item.name_key, row.name_lower);
        if (s > bestScore) { bestScore = s; bestRow = row; }
      }

      if (bestScore >= 0.60) {
        fuzzy.push({
          invoiceName: item.name,
          invoiceNameKey: item.name_key,
          suggestedId: bestRow.id,
          suggestedName: bestRow.name,
          score: Math.round(bestScore * 100),
          price: parseFloat(item.latest_price) || 0,
          qty: parseFloat(item.total_qty) || 0,
          unit: item.unit || "יח'",
        });
      } else {
        newItems.push({
          invoiceName: item.name,
          invoiceNameKey: item.name_key,
          qty: parseFloat(item.total_qty) || 0,
          price: parseFloat(item.latest_price) || 0,
          unit: item.unit || "יח'",
          supplierId: item.supplier_id || null,
        });
      }
    }

    res.json({ exact, fuzzy, new: newItems, inventory: inventoryList });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/sync-inventory/auto ────────────────────
// סנכרון חד-שלבי: מבצע preview + sync בצד השרת ללא שלב אישור.
// exact → עדכון מחיר; fuzzy (>=60%) → עדכון מחיר; new → פריט חדש עם כמות.
router.post('/sync-inventory/auto', ...canManage, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [{ rows: invoiceItems }, { rows: inventory }] = await Promise.all([
      db.query(
        `SELECT LOWER(TRIM(it.name)) AS name_key, TRIM(it.name) AS name, it.unit, i.supplier_id,
                SUM(it.qty::numeric) AS total_qty,
                (ARRAY_AGG(it.unit_price::numeric ORDER BY i.invoice_date DESC NULLS LAST)
                 FILTER (WHERE it.unit_price IS NOT NULL AND it.unit_price > 0))[1] AS latest_price
         FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
         WHERE i.business_id = $1 AND TRIM(it.name) != ''
         GROUP BY LOWER(TRIM(it.name)), TRIM(it.name), it.unit, i.supplier_id`,
        [businessId]
      ),
      db.query(
        `SELECT id, name, LOWER(name) AS name_lower FROM inventory_items WHERE business_id = $1`,
        [businessId]
      ),
    ]);

    let updated = 0, inserted = 0;
    // Same two-tier fuzzy thresholds as the gold-standard implementation in
    // invoice.service.js's syncInventoryFromInvoice — 0.60 was the "warn, don't
    // auto-apply" tier there, but this route was silently auto-applying (and
    // overwriting cost_per_unit) at that tier with no alert at all, on short
    // Hebrew ingredient names where 60% similarity is easy to hit by accident
    // (e.g. two different-colored peppers, or two fat-% variants of one product).
    const FUZZY_AUTO = 0.80;
    const FUZZY_WARN = 0.60;

    await withTransaction(async (client) => {
      for (const item of invoiceItems) {
        const qty   = parseFloat(item.total_qty)   || 0;
        const price = parseFloat(item.latest_price) || 0;

        // Exact match — update price only
        const exactMatch = inventory.find(r => r.name_lower === item.name_key);
        if (exactMatch) {
          if (price > 0) {
            await client.query(
              `UPDATE inventory_items SET cost_per_unit = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3`,
              [price, exactMatch.id, businessId]
            );
            updated++;
          }
          continue;
        }

        // Fuzzy match
        let bestScore = 0, bestRow = null;
        for (const row of inventory) {
          const s = strSimilarity(item.name_key, row.name_lower);
          if (s > bestScore) { bestScore = s; bestRow = row; }
        }
        if (bestScore >= FUZZY_AUTO && bestRow) {
          if (price > 0) {
            await client.query(
              `UPDATE inventory_items SET cost_per_unit = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3`,
              [price, bestRow.id, businessId]
            );
            updated++;
          }
          await client.query(
            `INSERT INTO ai_insights (business_id, type, title, body, severity)
             SELECT $1, 'inventory_fuzzy_match', $2, $3, 'info'
             WHERE NOT EXISTS (
               SELECT 1 FROM ai_insights
               WHERE business_id = $1 AND type = 'inventory_fuzzy_match' AND title = $2
                 AND created_at > NOW() - INTERVAL '24 hours'
             )`,
            [businessId, `התאמה אוטומטית: "${item.name}"`,
             `הפריט "${item.name}" מהחשבונית זוהה כ-"${bestRow.name}" במלאי (דמיון ${Math.round(bestScore * 100)}%). המחיר עודכן אוטומטית. אם ההתאמה שגויה — ערוך את שמות הפריטים.`]
          );
          continue;
        }
        if (bestScore >= FUZZY_WARN && bestRow) {
          // Below the auto-apply confidence bar — warn instead of silently
          // overwriting a possibly-wrong item's cost, fall through to "new item"
          await client.query(
            `INSERT INTO ai_insights (business_id, type, title, body, severity)
             SELECT $1, 'inventory_fuzzy_suggestion', $2, $3, 'warning'
             WHERE NOT EXISTS (
               SELECT 1 FROM ai_insights
               WHERE business_id = $1 AND type = 'inventory_fuzzy_suggestion' AND title = $2
                 AND created_at > NOW() - INTERVAL '24 hours'
             )`,
            [businessId, `פריט דומה אפשרי: "${item.name}"`,
             `הפריט "${item.name}" מהחשבונית דומה ל-"${bestRow.name}" במלאי (דמיון ${Math.round(bestScore * 100)}%) אך לא מספיק כדי לעדכן אוטומטית. בדוק אם מדובר באותו פריט.`]
          );
        }

        // New item — insert with qty and price
        await client.query(
          `INSERT INTO inventory_items (business_id, name, unit, current_qty, min_qty, cost_per_unit)
           VALUES ($1, $2, $3, $4::numeric, 0, $5::numeric)
           ON CONFLICT DO NOTHING`,
          [businessId, item.name.slice(0, 255), item.unit || "יח'", qty, price]
        );
        inserted++;
      }
    });

    if (updated || inserted) {
      eventBus.publish(businessId, 'inventory.updated', { action: 'auto_synced', updated, inserted });
      bustContextCache(businessId).catch(() => {});
    }
    res.json({
      message: `סנכרון הושלם — ${updated} פריטים עודכנו, ${inserted} חדשים נוספו`,
      updated, inserted,
    });
  } catch (err) { next(err); }
});

// ── POST /api/invoices/sync-inventory ─────────────────────────
// מקבל מיפויים מאושרים מהמשתמש ומבצע את הסנכרון בפועל
// mappings: [{ invoiceNameKey, inventoryId (null = create new), invoiceName, price, qty, unit }]
router.post('/sync-inventory', ...canManage, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { mappings } = req.body;

    if (!Array.isArray(mappings) || !mappings.length) {
      return res.status(400).json({ error: 'נדרש מערך mappings' });
    }

    const toUpdate = mappings.filter(m => m.inventoryId);
    const toInsert = mappings.filter(m => !m.inventoryId);
    let updated = 0, inserted = 0;

    await withTransaction(async (client) => {
      // This is a backfill/calibration tool for historical invoices whose stock
      // is already reflected in current_qty (that's why qty is deliberately never
      // touched here, unlike the real receiving flow in invoice.service.js's
      // syncInventoryFromInvoice) — so there's no known "quantity added at this
      // price" to weight a real average against. Latest invoice price wins
      // outright; this is NOT a weighted-average calculation despite the name.
      for (const m of toUpdate) {
        const r = await client.query(
          `UPDATE inventory_items
           SET cost_per_unit = CASE WHEN $1 > 0 THEN $1 ELSE cost_per_unit END, updated_at = NOW()
           WHERE id = $2 AND business_id = $3`,
          [m.price > 0 ? m.price : null, m.inventoryId, businessId]
        );
        if (r.rowCount) updated++;
      }

      // INSERT new items
      if (toInsert.length) {
        const vals   = toInsert.map((_, j) => { const b = j * 5 + 1; return `($${b},$${b+1},$${b+2},$${b+3},0,$${b+4})`; });
        const params = toInsert.flatMap(m => [
          businessId, (m.invoiceName || '').slice(0, 255), m.unit || "יח'",
          parseFloat(m.qty) || 0, parseFloat(m.price) || 0,
        ]);
        const r = await client.query(
          `INSERT INTO inventory_items (business_id, name, unit, current_qty, min_qty, cost_per_unit) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`,
          params
        );
        inserted = r.rowCount;
      }
    });

    if (updated || inserted) {
      eventBus.publish(businessId, 'inventory.updated', { action: 'synced_from_invoices', updated, inserted });
    }
    res.json({
      message: `סנכרון הושלם — ${updated} פריטים עודכנו, ${inserted} חדשים נוספו`,
      updated,
      inserted,
    });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id/approve ─────────────────────────────
router.put('/:id/approve', ...canManage, async (req, res, next) => {
  try {
    let { supplierId, supplierName, invoiceNumber, invoiceDate, totalAmount, notes, invoiceCategory, items } = req.body;

    // Normalize explicit null to the default — but not undefined (field absent).
    // undefined means "client didn't send the field" → model receives undefined →
    // no SET clause → existing DB value preserved. null means "client wants default".
    if (invoiceCategory === null) invoiceCategory = 'food';
    const ALLOWED_INVOICE_CATEGORIES = ['food', 'cleaning', 'equipment', 'other'];
    // Only validate a value that was actually supplied. The allow-list used to
    // run unconditionally, so `undefined` failed it and the route answered
    // `400 קטגוריית חשבונית לא חוקית: undefined` — contradicting the rule
    // directly above it. The web client always sends the field, so the UI never
    // hit it, but every other caller (mobile, the OpenAPI contract, tests) did.
    if (invoiceCategory !== undefined && !ALLOWED_INVOICE_CATEGORIES.includes(invoiceCategory)) {
      return res.status(400).json({ error: `קטגוריית חשבונית לא חוקית: ${invoiceCategory}` });
    }

    if (!supplierId && !supplierName) {
      return res.status(400).json({ error: 'נדרש ספק לאישור חשבונית' });
    }

    // אם נשלח שם ספק במקום ID — חיפוש לפי שם, אם לא נמצא — יצירה אוטומטית
    if (!supplierId && supplierName?.trim()) {
      // INSERT ... ON CONFLICT מונע race condition בין שתי בקשות מקבילות
      const { rows } = await db.query(
        `INSERT INTO suppliers (business_id, name, preferred_channel, is_active)
         VALUES ($1, $2, 'email', TRUE)
         ON CONFLICT (business_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [req.user.businessId, supplierName.trim()]
      ).catch(async () => {
        // fallback אם אין UNIQUE constraint — SELECT רגיל
        return db.query(
          'SELECT id FROM suppliers WHERE business_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
          [req.user.businessId, supplierName.trim()]
        );
      });
      supplierId = rows[0]?.id;
    }

    // supplierId can also arrive as a caller-supplied UUID (not just resolved
    // by name above) — verify it actually belongs to this business before
    // writing it onto the invoice, otherwise a foreign supplier UUID gets
    // silently attached and its cost/name data leaks into this tenant's view.
    if (supplierId) {
      const { rows: ownRows } = await db.query(
        'SELECT 1 FROM suppliers WHERE id = $1 AND business_id = $2',
        [supplierId, req.user.businessId]
      );
      if (!ownRows.length) {
        return res.status(400).json({ error: 'ספק לא נמצא' });
      }
    }

    let updated;
    await withTransaction(async (client) => {
      updated = await invoiceModel.approve(req.params.id, req.user.businessId, {
        supplierId, invoiceNumber, invoiceDate, totalAmount, notes, invoiceCategory,
      }, client);
      if (!updated) {
        const e = new Error('חשבונית לא נמצאה');
        e.statusCode = 404;
        throw e;
      }
      // Item edits must always persist — even when re-saving an already-approved
      // invoice (the frontend's "ערוך" button reuses this same route for that).
      // Only the inventory sync is gated on wasAlreadyApproved, to avoid double-
      // counting stock: a double-click/retry — or a legitimate post-approval
      // correction — must not re-run syncInventoryFromInvoice a second time.
      if (Array.isArray(items)) {
        await invoiceModel.replaceItems(req.params.id, req.user.businessId, items, client);
        if (!updated.wasAlreadyApproved) {
          await syncInventoryFromInvoice(req.user.businessId, supplierId, items, client);
        }
      }
    });

    // שינויי מחיר — מחוץ לטרנזקציה, רק באישור ראשון (side effects לא קריטיים)
    if (Array.isArray(items) && !updated.wasAlreadyApproved) {
      // ai_insights (קיים — לדשבורד AI)
      checkPriceChanges(req.user.businessId, req.params.id, items).then(async priceAlerts => {
        if (!priceAlerts.length) return;
        const { rows: supRows } = await db.query('SELECT name FROM suppliers WHERE id=$1 AND business_id=$2', [supplierId, req.user.businessId]).catch(() => ({ rows: [] }));
        await storePriceAlerts(req.user.businessId, priceAlerts, supRows[0]?.name || supplierName);
      }).catch(e => logger.error('[Invoice] Price alert check failed', { err: e.message }));

      // notifications (חדש — מתריע בזמן אמת לבעל העסק עם % שינוי + השפעה חודשית)
      // supplierName מועבר כדי לחסוך query כפולה לטבלת suppliers
      notifyPriceChanges(req.user.businessId, req.params.id, supplierId, items, supplierName || null)
        .catch(e => logger.error('[Invoice] notifyPriceChanges failed', { err: e.message }));
    }

    eventBus.publish(req.user.businessId, 'invoice_approved', { invoiceId: updated.id, totalAmount: updated.total_amount });
    onInvoiceApproved(req.user.businessId, updated.id).catch(e => logger.error('[Invoice] onInvoiceApproved failed', { err: e.message }));
    // Bust stale caches — invoice approval changes cost and supplier trend data
    cache.del(`menu-engineering:${req.user.businessId}:*`).catch(() => {});
    cache.del(`menu-elasticity:${req.user.businessId}`).catch(() => {});
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    // Detect inventory duplicates after sync — fire-and-forget
    detectInventoryDuplicates(req.user.businessId)
      .then(pairs => pairs.length ? storeDuplicateAlerts(req.user.businessId, pairs) : null)
      .catch(e => logger.error('[Invoice] Duplicate detection failed', { err: e.message }));
    // Cost sanity check — warn frontend about suspiciously high unit prices
    const suspiciousCosts = Array.isArray(items) && !updated.wasAlreadyApproved
      ? checkInventoryCostSanity(items)
      : [];
    res.json({ invoice: updated, suspiciousCosts });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// ── PUT /api/invoices/:id/reject ──────────────────────────────
router.put('/:id/reject', ...canManage, async (req, res, next) => {
  try {
    // An approved invoice already ran syncInventoryFromInvoice — its
    // current_qty/cost_per_unit effects on inventory_items aren't reversible
    // by deleting the invoice row, so "reject" (decline an unapproved invoice)
    // must not be usable to erase the audit trail of an already-applied one.
    const existing = await invoiceModel.findById(req.params.id, req.user.businessId);
    if (existing?.approved_at) {
      return res.status(400).json({ error: 'לא ניתן לדחות חשבונית שכבר אושרה וסונכרנה למלאי — בצע התאמת מלאי ידנית במסך המלאי במקום' });
    }
    await invoiceModel.softDelete(req.params.id, req.user.businessId);
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    cache.del(`menu-engineering:${req.user.businessId}:*`).catch(() => {});
    cache.del(`menu-elasticity:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'rejected' });
    res.json({ message: 'חשבונית נדחתה ונמחקה' });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id/mark-paid ──────────────────────────
router.put('/:id/mark-paid', ...canManage, async (req, res, next) => {
  try {
    const updated = await invoiceModel.markPaid(req.params.id, req.user.businessId, true);
    if (!updated) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'paid' });
    res.json({ invoice: updated });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id/partial-payment ────────────────────
router.put('/:id/partial-payment', ...canManage, async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0)
      return res.status(400).json({ error: 'סכום לא תקין' });
    const updated = await invoiceModel.recordPartialPayment(req.params.id, req.user.businessId, amount);
    if (!updated) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'partial_payment' });
    res.json({ invoice: updated });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id/paid (legacy) ──────────────────────
router.put('/:id/paid', ...canManage, async (req, res, next) => {
  try {
    const isPaid  = req.body.isPaid !== false;
    const updated = await invoiceModel.markPaid(req.params.id, req.user.businessId, isPaid);
    if (!updated) return res.status(404).json({ error: 'חשבונית לא נמצאה' });
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'paid' });
    res.json({ invoice: updated });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id/supplier ────────────────────────────
router.put('/:id/supplier', ...canManage, async (req, res, next) => {
  try {
    const { supplierId } = req.body;
    if (!supplierId) return res.status(400).json({ error: 'supplierId חסר' });
    const { rows: ownRows } = await db.query(
      'SELECT 1 FROM suppliers WHERE id = $1 AND business_id = $2',
      [supplierId, req.user.businessId]
    );
    if (!ownRows.length) return res.status(400).json({ error: 'ספק לא נמצא' });
    await invoiceModel.updateSupplier(req.params.id, req.user.businessId, supplierId);
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'supplier_updated', invoiceId: req.params.id });
    res.json({ message: 'ספק עודכן' });
  } catch (err) { next(err); }
});

// ── DELETE /api/invoices/:id ──────────────────────────────────
router.delete('/:id', ...canManage, async (req, res, next) => {
  try {
    // Same reasoning as PUT /:id/reject — an approved invoice already changed
    // inventory_items, so deleting it would erase the audit trail while leaving
    // its (unreversed) stock/cost effects in place.
    const existing = await invoiceModel.findById(req.params.id, req.user.businessId);
    if (existing?.approved_at) {
      return res.status(400).json({ error: 'לא ניתן למחוק חשבונית שכבר אושרה וסונכרנה למלאי — בצע התאמת מלאי ידנית במסך המלאי במקום' });
    }
    await invoiceModel.softDelete(req.params.id, req.user.businessId);
    // Remove gallery card so deleted invoices don't leave phantom cards in the gallery
    db.query(
      `DELETE FROM gallery_items WHERE entity_type='invoice' AND entity_id=$1 AND business_id=$2`,
      [req.params.id, req.user.businessId]
    ).catch(() => {});
    cache.del(`supplier-trends:${req.user.businessId}`).catch(() => {});
    cache.del(`menu-engineering:${req.user.businessId}:*`).catch(() => {});
    cache.del(`menu-elasticity:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'invoice.updated', { action: 'deleted' });
    res.json({ message: 'חשבונית נמחקה' });
  } catch (err) { next(err); }
});

// ── GET /api/invoices/search/ai ───────────────────────────────
router.get('/search/ai', ...canView, rateLimitAI(), async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'שאילתת חיפוש חסרה' });

    const metaCacheKey = `invoice-ai-meta:${req.user.businessId}`;
    let meta = await cache.get(metaCacheKey);
    if (!meta) {
      const { rows } = await db.query(
        `SELECT i.id, s.name AS supplier_name, i.invoice_number,
                i.invoice_date, i.total_amount
         FROM invoices i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         WHERE i.business_id = $1
         ORDER BY i.invoice_date DESC LIMIT 200`,
        [req.user.businessId]
      );
      meta = rows;
      await cache.set(metaCacheKey, meta, 300); // 5 min TTL
    }

    if (!meta.length) return res.json({ invoices: [] });

    const response = await withTimeout(
    anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        system: `מתוך הרשימה הבאה, מצא חשבוניות שמתאימות לשאילתת המשתמש.\nהחזר מערך JSON של IDs בלבד: ["id1","id2"]\nחשבוניות: ${JSON.stringify(meta)}`,
        messages: [{ role: 'user', content: q }],
      }),
    15_000, "AI");

    if (response.stop_reason === 'max_tokens') {
      logger.warn('[invoices/search/ai] AI response truncated (max_tokens)');
      return res.status(502).json({ error: 'תשובת ה-AI נחתכה — נסה שנית' });
    }

    let ids = [];
    try { ids = JSON.parse(response.content[0].text.match(/\[[\s\S]*?\]/)?.[0] || '[]'); } catch { ids = []; }
    const results = meta.filter(m => ids.includes(m.id));
    res.json({ invoices: results });
  } catch (err) { next(err); }
});

module.exports = router;
