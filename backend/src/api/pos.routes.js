const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const os         = require('os');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const { requireAuth, requireOwner } = require('../middleware/auth');
const posSync    = require('../services/pos/pos.sync');
const posModel   = require('../models/pos.model');
const { onSaleCreated } = require('../services/sync.service');
const eventBus   = require('../utils/eventBus');
const { parseIntRange } = require('../utils/parseQuery');
const logger     = require('../utils/logger');
const db         = require('../utils/db');

// Converts a "wall-clock time in Asia/Jerusalem" (date+time strings, no
// offset) into the correct UTC Date — DST-aware for the specific calendar
// date. The naive `new Date(dateStr + 'T' + timeStr)` used before this parsed
// the string in the server's local timezone (UTC), silently shifting the
// stored sold_at by 2-3 hours and landing it on the wrong Israel calendar day
// wherever downstream code buckets by `sold_at AT TIME ZONE 'Asia/Jerusalem'`
// (e.g. the POS-vs-Z-report reconciliation check further down this file).
function _parseIsraelDateTime(dateStr, timeStr) {
  const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  if (isNaN(naiveUtc.getTime())) return naiveUtc; // Invalid Date — let the caller's isNaN check catch it
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(naiveUtc);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const asIfIsraelWasUtc = Date.UTC(
    +get('year'), +get('month') - 1, +get('day'),
    +get('hour') % 24, +get('minute'), +get('second')
  );
  const offsetMs = asIfIsraelWasUtc - naiveUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs);
}

// 6 manual syncs per minute per user — each sync hits the POS provider API
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => req.user?.businessId || 'anon',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות סנכרון — נסה שנית בעוד דקה' },
});

const csvUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    const ok = ['text/csv', 'text/plain', 'application/csv',
                'application/vnd.ms-excel'].includes(file.mimetype)
              || file.originalname.toLowerCase().endsWith('.csv');
    if (ok) return cb(null, true);
    const err = new Error('סוג קובץ לא נתמך — יש להעלות קובץ CSV. להעלאת דוחות Z (XLSX/EML) השתמש בכפתור "העלאת דוח Z" מטה');
    err.status = 400;
    cb(err, false);
  },
});

// POST /api/pos/connect — חיבור קופה ראשון
router.post('/connect', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { provider, apiKey, apiUrl } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: 'חסרים פרטי קופה' });

    const result = await posSync.connect(req.user.businessId, { provider, apiKey, apiUrl });
    eventBus.publish(req.user.businessId, 'pos.updated', { action: 'connected', provider });
    res.json({
      ...result,
      message: 'הקופה חוברה — שאיבת ההיסטוריה המלאה מתבצעת ברקע',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/pos/sync — סנכרון ידני / שוטף
router.post('/sync', requireAuth, requireOwner, syncLimiter, async (req, res, next) => {
  try {
    await posSync.syncIncremental(req.user.businessId);
    eventBus.publish(req.user.businessId, 'pos.updated', { action: 'synced' });
    res.json({ message: 'סנכרון הושלם' });
  } catch (err) {
    next(err);
  }
});

// GET /api/pos/status — סטטוס חיבור
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const conn = await posModel.findByBusiness(req.user.businessId);
    if (!conn) return res.json({ connected: false });
    res.json({
      connected:   conn.is_connected,
      provider:    conn.provider,
      lastSyncAt:  conn.last_sync_at,
      connectedAt: conn.connected_at,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/pos/sales — רשימת מכירות עם פילטרים
router.get('/sales', requireAuth, async (req, res, next) => {
  try {
    const { date }  = req.query;
    const days      = parseIntRange(req.query.days,   1, 365, 1);
    const limit     = parseIntRange(req.query.limit,  1, 500, 100);
    const offset    = parseIntRange(req.query.offset, 0, 1e9,   0);

    const dateFilter = date
      ? `DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') = $2`
      : `s.sold_at >= NOW() - ($2 || ' days')::INTERVAL`;
    const dateParam = date || String(days);

    const [{ rows: sales }, { rows: stats }] = await Promise.all([
      db.query(
        `SELECT s.id, s.sale_type, s.table_number, s.total_amount, s.sold_at,
                COALESCE(json_agg(
                  json_build_object(
                    'name', si.name, 'qty', si.qty,
                    'unit_price', si.unit_price, 'total_price', si.total_price
                  ) ORDER BY si.total_price DESC
                ) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
         FROM sales s
         LEFT JOIN sale_items si ON si.sale_id = s.id
         WHERE s.business_id = $1 AND ${dateFilter}
           AND (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%')
         GROUP BY s.id
         ORDER BY s.sold_at DESC
         LIMIT $3 OFFSET $4`,
        [req.user.businessId, dateParam, limit, offset]
      ),
      db.query(
        `SELECT
           COUNT(*)::int                                                           AS total_count,
           COALESCE(SUM(s.total_amount), 0)                                       AS total_revenue,
           COUNT(*) FILTER (WHERE s.sale_type='table')::int                       AS table_count,
           COUNT(*) FILTER (WHERE s.sale_type='delivery')::int                    AS delivery_count,
           COUNT(*) FILTER (WHERE s.sale_type='takeaway')::int                    AS takeaway_count,
           COALESCE(SUM(s.total_amount) FILTER (WHERE s.sale_type='table'),    0) AS table_revenue,
           COALESCE(SUM(s.total_amount) FILTER (WHERE s.sale_type='delivery'), 0) AS delivery_revenue,
           COALESCE(SUM(s.total_amount) FILTER (WHERE s.sale_type='takeaway'), 0) AS takeaway_revenue
         FROM sales s
         WHERE s.business_id = $1 AND ${dateFilter}
           AND (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%')`,
        [req.user.businessId, dateParam]
      ),
    ]);

    const statsRow = stats[0] || { total_count: 0 };
    const total = statsRow.total_count || 0;
    res.json({
      sales, stats: statsRow,
      total, limit, offset, hasMore: offset + sales.length < total,
    });
  } catch (err) { next(err); }
});

// POST /api/pos/import — העלאת נתוני מכירות ידנית מ-CSV
router.post('/import', requireAuth, requireOwner, csvUpload.single('file'), async (req, res, next) => {
  const tempPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });

    const content = await fs.promises.readFile(tempPath, 'utf8');

    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length < 2) return res.status(400).json({ error: 'הקובץ ריק או לא תקין' });

    // Header row: date,time,sale_type,table_number,total_amount
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const colIdx = (name) => header.indexOf(name);

    const dateCol  = colIdx('date');
    const timeCol  = colIdx('time');
    const typeCol  = colIdx('sale_type');
    const tableCol = colIdx('table_number');
    const amtCol   = colIdx('total_amount');

    if (dateCol === -1 || amtCol === -1) {
      return res.status(400).json({ error: 'עמודות חובה חסרות: date, total_amount' });
    }

    // Parse all valid rows first (no DB I/O in the loop)
    const validRows = [];
    let skipped = 0;

    for (const line of lines.slice(1, 10_001)) { // cap at 10k rows per import
      const cols = line.split(',').map(c => c.trim());
      const dateStr  = cols[dateCol];
      const timeStr  = timeCol !== -1 ? (cols[timeCol] || '12:00') : '12:00';
      // sales.sale_type has a CHECK constraint (table/delivery/takeaway/other)
      // — an unrecognized value used to reach the batch INSERT below and
      // throw a constraint violation that silently discarded the ENTIRE
      // 500-row chunk it was batched into, not just this one bad row.
      const rawType  = typeCol !== -1 ? (cols[typeCol] || '').toLowerCase() : '';
      const saleType = ['table', 'delivery', 'takeaway'].includes(rawType) ? rawType : 'other';
      const tableNum = tableCol !== -1 ? (cols[tableCol] || null) : null;
      const amount   = parseFloat(cols[amtCol]);

      if (!dateStr || isNaN(amount) || amount < 0) { skipped++; continue; }

      const soldAt = _parseIsraelDateTime(dateStr, timeStr);
      if (isNaN(soldAt.getTime())) { skipped++; continue; }

      validRows.push([saleType, tableNum || null, amount, soldAt]);
    }

    // Batch INSERT in chunks of 500 (single round-trip per chunk)
    const CHUNK = 500;
    let imported = 0;

    for (let i = 0; i < validRows.length; i += CHUNK) {
      const chunk = validRows.slice(i, i + CHUNK);
      const vals  = chunk.map((_, j) => {
        const b = j * 4 + 2;
        return `($1,$${b},$${b+1},$${b+2},$${b+3},'manual')`;
      }).join(',');

      const result = await db.query(
        `INSERT INTO sales (business_id, sale_type, table_number, total_amount, sold_at, source)
         VALUES ${vals}
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [req.user.businessId, ...chunk.flat()]
      ).catch(err => { logger.warn('[POS import] batch insert failed', { err: err.message }); return { rows: [] }; });

      imported += result.rows.length;

      // Fire-and-forget cache/sync invalidation for each new sale
      for (const row of result.rows) {
        onSaleCreated(req.user.businessId, row.id).catch(() => {});
      }
    }

    res.json({ message: `יובאו ${imported} רשומות`, imported, skipped });
  } catch (err) { next(err); } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {}); // always clean up temp file
  }
});

// DELETE /api/pos/disconnect — ניתוק קופה
router.delete('/disconnect', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await posModel.setDisconnected(req.user.businessId);
    eventBus.publish(req.user.businessId, 'pos.updated', { action: 'disconnected' });
    res.json({ message: 'הקופה נותקה' });
  } catch (err) { next(err); }
});

// GET /api/pos/reconciliation?days=30 — השוואת POS מול Z-reports לזיהוי פערים
router.get('/reconciliation', requireAuth, async (req, res, next) => {
  try {
    const biz  = req.user.businessId;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    // Days that have BOTH POS individual sales AND Z-report aggregates
    const { rows } = await db.query(
      `WITH pos_daily AS (
         SELECT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS day,
                COALESCE(SUM(total_amount), 0)::float AS pos_total,
                COUNT(*)::int AS pos_tx
         FROM sales
         WHERE business_id = $1
           AND pos_sale_id IS NOT NULL AND pos_sale_id NOT LIKE 'Z-%'
           AND sold_at >= NOW() - ($2 || ' days')::INTERVAL
         GROUP BY day
       ),
       z_daily AS (
         SELECT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS day,
                COALESCE(SUM(total_amount), 0)::float AS z_total,
                COUNT(*)::int AS z_reports
         FROM sales
         WHERE business_id = $1
           AND pos_sale_id LIKE 'Z-%'
           AND sold_at >= NOW() - ($2 || ' days')::INTERVAL
         GROUP BY day
       )
       SELECT
         p.day,
         p.pos_total,
         p.pos_tx,
         z.z_total,
         z.z_reports,
         ROUND(ABS(p.pos_total - COALESCE(z.z_total, 0))::numeric, 2) AS diff_amount,
         CASE
           WHEN z.z_total IS NULL THEN 'no_z_report'
           WHEN ABS(p.pos_total - z.z_total) > 0.01 * GREATEST(p.pos_total, z.z_total) THEN 'mismatch'
           ELSE 'ok'
         END AS status
       FROM pos_daily p
       LEFT JOIN z_daily z ON z.day = p.day
       WHERE z.z_total IS NULL OR ABS(p.pos_total - COALESCE(z.z_total, 0)) > 50
       ORDER BY p.day DESC
       LIMIT 20`,
      [biz, days]
    );

    const mismatches = rows.filter(r => r.status === 'mismatch');
    const noZReport  = rows.filter(r => r.status === 'no_z_report');

    res.json({
      days,
      summary: {
        totalMismatches:    mismatches.length,
        totalMissingZDays:  noZReport.length,
        totalDiffAmount:    mismatches.reduce((s, r) => s + parseFloat(r.diff_amount || 0), 0),
        clean: mismatches.length === 0 && noZReport.length === 0,
      },
      issues: rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
