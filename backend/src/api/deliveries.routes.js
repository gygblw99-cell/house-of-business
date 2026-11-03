const express     = require('express');
const router      = express.Router();
const db          = require('../utils/db');
const multer      = require('multer');
const XLSX        = require('xlsx');
const rateLimit   = require('express-rate-limit');
const { requireAuth, requireManager }   = require('../middleware/auth');
const eventBus = require('../utils/eventBus');
const deliveryEmailSvc  = require('../services/deliveries.emailConfig.service');
const gmailOAuth  = require('../services/gmail.oauth.service');
const {
  fetchDeliveriesFromGmail, fetchHistoricalDeliveriesFromGmail, getGmailDeliveryStatus,
} = require('../services/gmail.deliveries.service');
const logger = require('../utils/logger');
const path = require('path');
const { validateBufferMagicBytes } = require('../utils/upload');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ALLOWED_MIME = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/csv',
      'text/plain',
    ];
    if (ALLOWED_MIME.includes(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('סוג קובץ לא נתמך — יש להעלות קובץ Excel או CSV'), { status: 400 }));
    }
  },
});

// 10 file uploads per 5 minutes per user — XLSX parsing is CPU-synchronous
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.userId || 'anon',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי העלאות קבצים, נסה שנית בעוד מספר דקות' },
});

// Column-name aliases for Wolt / 10bis CSV exports
const COL_ALIASES = {
  order_id: ['order id', 'orderid', 'order_id', 'order number', 'מספר הזמנה', 'מספר', 'reference'],
  amount:   ['net revenue', 'restaurant revenue', 'restaurant earnings', 'amount', 'revenue', 'net', 'total',
              'סכום', 'הכנסה נטו', 'הכנסה', 'סה"כ'],
  date:     ['date', 'created at', 'creation time', 'time', 'created_at', 'sold at',
              'תאריך', 'זמן', 'תאריך ושעה'],
};

function mapColumns(headers) {
  const map = {};
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    for (const h of headers) {
      const hl = h.toString().toLowerCase().trim();
      if (aliases.some(a => hl.includes(a))) { map[field] = h; break; }
    }
  }
  return map;
}

const PLATFORMS = ['wolt', 'tenbis', 'sibuv', 'mislocha', 'self'];

// ── Auto-add missing columns ──────────────────────────────
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS external_order_id TEXT`);
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivery_platform TEXT`);
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'done'`);
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT`);

// GET /api/deliveries/today — סטטיסטיקות משלוחים של היום
router.get('/today', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = req.user;

    // סטטיסטיקות לפי פלטפורמה
    const { rows: byPlatform } = await db.query(`
      SELECT
        COALESCE(delivery_platform, 'other') AS platform,
        COUNT(*)::int          AS total,
        -- A cancelled order must not count toward revenue — only its own
        -- count (below) tracks it. This previously summed every status,
        -- permanently overstating "today's revenue" for any cancelled order.
        COALESCE(SUM(total_amount) FILTER (WHERE status IS DISTINCT FROM 'cancelled'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status = 'active')::int  AS active,
        COUNT(*) FILTER (WHERE status = 'done')::int    AS done,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM sales
      WHERE business_id = $1
        AND sale_type = 'delivery'
        AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jerusalem')::date
      GROUP BY COALESCE(delivery_platform, 'other')
    `, [businessId]);

    // סה"כ היום
    const { rows: [totals] } = await db.query(`
      SELECT
        COUNT(*)::int          AS total,
        COALESCE(SUM(total_amount) FILTER (WHERE status IS DISTINCT FROM 'cancelled'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status = 'active')::int  AS active
      FROM sales
      WHERE business_id = $1
        AND sale_type = 'delivery'
        AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jerusalem')::date
    `, [businessId]);

    // משלוחים פעילים כרגע
    const { rows: active } = await db.query(`
      SELECT id, delivery_platform, total_amount, sold_at, notes
      FROM sales
      WHERE business_id = $1
        AND sale_type = 'delivery'
        AND status = 'active'
        AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jerusalem')::date
      ORDER BY sold_at DESC
    `, [businessId]);

    res.json({
      totals: {
        total:   totals.total   || 0,
        revenue: Number(totals.revenue) || 0,
        active:  totals.active  || 0,
      },
      byPlatform: [...PLATFORMS, 'other'].map(p => {
        const found = byPlatform.find(r => r.platform === p);
        return {
          platform:  p,
          total:     found?.total     || 0,
          revenue:   Number(found?.revenue) || 0,
          active:    found?.active    || 0,
          done:      found?.done      || 0,
          cancelled: found?.cancelled || 0,
        };
      }),
      active,
    });
  } catch (err) { next(err); }
});

// POST /api/deliveries — הוסף משלוח
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = req.user;
    const { platform, amount, notes } = req.body;

    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'פלטפורמה לא תקינה' });
    }
    if (!amount || isNaN(amount) || amount <= 0 || amount > 50000) {
      return res.status(400).json({ error: 'סכום לא תקין' });
    }

    const { rows: [sale] } = await db.query(`
      INSERT INTO sales
        (business_id, sale_type, delivery_platform, total_amount, sold_at, status, notes)
      VALUES ($1, 'delivery', $2, $3, NOW(), 'active', $4)
      RETURNING id, delivery_platform, total_amount, sold_at, status, notes
    `, [businessId, platform, amount, notes || null]);

    eventBus.publish(businessId, 'delivery.imported', { action: 'added', deliveryId: sale.id });
    res.status(201).json(sale);
  } catch (err) { next(err); }
});

// PATCH /api/deliveries/:id/status — עדכן סטטוס (active → done / cancelled)
router.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = req.user;
    const { status } = req.body;

    if (!['active', 'done', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }

    const { rows: [sale] } = await db.query(`
      UPDATE sales SET status = $1
      WHERE id = $2 AND business_id = $3 AND sale_type = 'delivery'
      RETURNING id, delivery_platform, total_amount, status
    `, [status, req.params.id, businessId]);

    if (!sale) return res.status(404).json({ error: 'משלוח לא נמצא' });
    eventBus.publish(businessId, 'delivery.imported', { action: 'status_updated', deliveryId: sale.id, status });
    res.json(sale);
  } catch (err) { next(err); }
});

// POST /api/deliveries/import — bulk import from Wolt/10bis CSV rows
// Accepts JSON array: [{ platform, amount, sold_at, external_order_id, notes }]
router.post('/import', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = req.user;
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'אין שורות לייבוא' });

    // Validate and normalise rows first
    const valid = [];
    let skipped = 0;
    for (const row of rows) {
      const platform = (row.platform || 'self').toLowerCase();
      const amount   = parseFloat(row.amount);
      if (!amount || amount <= 0) { skipped++; continue; }
      const soldAt = row.sold_at ? new Date(row.sold_at) : new Date();
      if (isNaN(soldAt.getTime())) { skipped++; continue; }
      if (!PLATFORMS.includes(platform) && row.platform) {
        logger.warn('[Deliveries] Unknown platform in import', { platform: row.platform, businessId });
      }
      valid.push({
        platform: PLATFORMS.includes(platform) ? platform : 'other',
        amount,
        soldAt,
        extId:  row.external_order_id || null,
        notes:  row.notes || null,
      });
    }

    // Batch dedup check — one query for all external_order_ids
    const extIds = valid.map(r => r.extId).filter(Boolean);
    let existingSet = new Set();
    if (extIds.length > 0) {
      const { rows: existing } = await db.query(
        `SELECT external_order_id FROM sales WHERE business_id=$1 AND external_order_id = ANY($2)`,
        [businessId, extIds]
      );
      existingSet = new Set(existing.map(r => r.external_order_id));
    }

    const toInsert = valid.filter(r => !r.extId || !existingSet.has(r.extId));
    skipped += valid.length - toInsert.length;

    // Batch INSERT — one query for all rows
    let imported = 0;
    if (toInsert.length > 0) {
      const vals   = [];
      const params = [];
      toInsert.forEach((r, i) => {
        const base = i * 6;
        vals.push(`($${base+1},'delivery',$${base+2},$${base+3},$${base+4},'done',$${base+5},$${base+6})`);
        params.push(businessId, r.platform, r.amount, r.soldAt, r.notes, r.extId);
      });
      // rowCount, not toInsert.length — ON CONFLICT DO NOTHING can silently
      // drop a row that a concurrent import already inserted after this
      // route's own pre-check ran (see dedupAndInsertSales for the same fix)
      const result = await db.query(
        `INSERT INTO sales (business_id, sale_type, delivery_platform, total_amount, sold_at, status, notes, external_order_id) VALUES ${vals.join(',')}
         ON CONFLICT (business_id, external_order_id) WHERE external_order_id IS NOT NULL DO NOTHING`,
        params
      );
      imported = result.rowCount;
      skipped += toInsert.length - imported;
    }

    if (imported) eventBus.publish(req.user.businessId, 'delivery.imported', { count: imported });
    res.json({ imported, skipped, total: rows.length });
  } catch (err) { next(err); }
});

// GET /api/deliveries/history?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { businessId } = req.user;
    // Pass date strings directly; Postgres converts to Jerusalem-timezone boundaries
    // so that "from=2026-07-18" means start of July 18 in Jerusalem, not UTC
    // Both defaults must be Israel-calendar dates (toISOString() is UTC and
    // rolls over 2-3 hours early relative to Israel midnight — `to` already
    // got this right below; `from` didn't, an inconsistency within the same route).
    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const to   = req.query.to   || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    const [{ rows: byPlatform }, { rows: [totals] }, { rows: deliveries }] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(delivery_platform, 'other') AS platform,
          COUNT(*)::int          AS total,
          -- Same fix as GET /today — cancelled orders must not count toward revenue.
          COALESCE(SUM(total_amount) FILTER (WHERE status IS DISTINCT FROM 'cancelled'),0)::float AS revenue,
          COUNT(*) FILTER (WHERE status='done')::int      AS done,
          COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
        FROM sales
        WHERE business_id=$1 AND sale_type='delivery'
          AND sold_at >= ($2::date AT TIME ZONE 'Asia/Jerusalem')
          AND sold_at <  (($3::date + 1) AT TIME ZONE 'Asia/Jerusalem')
        GROUP BY COALESCE(delivery_platform, 'other')
      `, [businessId, from, to]),
      db.query(`
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(total_amount) FILTER (WHERE status IS DISTINCT FROM 'cancelled'),0)::float AS revenue,
          COUNT(*) FILTER (WHERE status='done')::int      AS done,
          COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
        FROM sales
        WHERE business_id=$1 AND sale_type='delivery'
          AND sold_at >= ($2::date AT TIME ZONE 'Asia/Jerusalem')
          AND sold_at <  (($3::date + 1) AT TIME ZONE 'Asia/Jerusalem')
      `, [businessId, from, to]),
      db.query(`
        SELECT id, delivery_platform, total_amount::float, sold_at, status, notes
        FROM sales
        WHERE business_id=$1 AND sale_type='delivery'
          AND sold_at >= ($2::date AT TIME ZONE 'Asia/Jerusalem')
          AND sold_at <  (($3::date + 1) AT TIME ZONE 'Asia/Jerusalem')
        ORDER BY sold_at DESC
        LIMIT 200
      `, [businessId, from, to]),
    ]);

    res.json({
      totals: {
        total:     totals?.total     || 0,
        revenue:   totals?.revenue   || 0,
        done:      totals?.done      || 0,
        cancelled: totals?.cancelled || 0,
      },
      byPlatform: [...PLATFORMS, 'other'].map(p => {
        const f = byPlatform.find(r => r.platform === p);
        return { platform: p, total: f?.total || 0, revenue: f?.revenue || 0, done: f?.done || 0, cancelled: f?.cancelled || 0 };
      }),
      deliveries,
    });
  } catch (err) { next(err); }
});

// GET /api/deliveries/import/template — returns a sample CSV template description
router.get('/import/template', requireAuth, async (_req, res) => {
  res.json({
    columns: ['platform (wolt/tenbis/sibuv/mislocha/self)', 'amount', 'sold_at (YYYY-MM-DD HH:mm)', 'external_order_id', 'notes'],
    example: [
      { platform: 'wolt',   amount: 58.90, sold_at: '2026-05-04 12:30', external_order_id: 'W123', notes: '' },
      { platform: 'tenbis', amount: 43.00, sold_at: '2026-05-04 13:15', external_order_id: 'T456', notes: '' },
    ],
  });
});

// ── File upload import ────────────────────────────────────────────────────────
// Handles both US (1,234.56) and European (1.234,56) number formats
function parseAmount(raw) {
  const s = String(raw ?? '').trim();
  const cleaned = s.replace(/[^\d.,]/g, '');
  if (!cleaned) return NaN;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot   = cleaned.lastIndexOf('.');
  if (lastComma > lastDot) {
    // European: comma is decimal separator (e.g. "1.234,56" or "1234,56")
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }
  if (lastDot > lastComma) {
    // US: period is decimal separator (e.g. "1,234.56" or "1234.56")
    return parseFloat(cleaned.replace(/,/g, ''));
  }
  // Only one type of separator or none
  return parseFloat(cleaned.replace(/,/g, '.'));
}

// POST /api/deliveries/upload — parse CSV/Excel exported from Wolt/10bis portal
router.post('/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res, next) => {
  try {
    const { businessId } = req.user;
    const platform = (req.body.platform || 'wolt').toLowerCase();
    if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'פלטפורמה לא תקינה' });

    // Content vs. declared-extension check — this route relied on MIME/
    // extension alone (no magic-byte validation, unlike gallery/tasks/
    // invoices uploads). Only meaningful for .xlsx (zip-based) — .csv is
    // plain text with no signature to check, and XLSX.read() below already
    // rejects genuinely malformed content either way.
    const _ext = path.extname(req.file.originalname).toLowerCase();
    if (_ext === '.xlsx' && !validateBufferMagicBytes(req.file.buffer, _ext)) {
      return res.status(400).json({ error: 'תוכן הקובץ לא תואם לסיומת .xlsx — ודא שהקובץ תקין' });
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
    if (!rawRows.length) return res.status(400).json({ error: 'הקובץ ריק' });

    const headers = Object.keys(rawRows[0]);
    const colMap  = mapColumns(headers);

    if (!colMap.amount) {
      return res.status(400).json({ error: 'לא נמצאה עמודת סכום. וודאו שמדובר בייצוא תקין מהפלטפורמה.' });
    }

    const parsed = rawRows.map(row => {
      const amount = parseAmount(row[colMap.amount]);
      let sold_at  = new Date();
      if (colMap.date && row[colMap.date]) {
        const raw = row[colMap.date];
        // Skip raw numbers — Excel serial not converted by cellDates (e.g. malformed file)
        if (typeof raw !== 'number') {
          const d = raw instanceof Date ? raw : new Date(raw);
          // Sanity: reject dates before 2000 (likely a serial-number parse error)
          if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) sold_at = d;
        }
      }
      const extId = colMap.order_id ? String(row[colMap.order_id] ?? '').trim() || null : null;
      return { platform, amount, sold_at, external_order_id: extId, notes: null };
    });

    const rows    = parsed.filter(r => r.amount > 0 && !isNaN(r.amount));
    const invalid = rawRows.length - rows.length;

    if (!rows.length) return res.status(400).json({ error: 'לא נמצאו שורות עם סכום תקין בקובץ' });

    // Dedup by external_order_id
    const extIds = rows.map(r => r.external_order_id).filter(Boolean);
    let existingSet = new Set();
    if (extIds.length) {
      const { rows: ex } = await db.query(
        `SELECT external_order_id FROM sales WHERE business_id=$1 AND external_order_id = ANY($2)`,
        [businessId, extIds]
      );
      existingSet = new Set(ex.map(r => r.external_order_id));
    }

    const toInsert = rows.filter(r => !r.external_order_id || !existingSet.has(r.external_order_id));
    let skipped  = rows.length - toInsert.length;
    let imported = 0;

    if (toInsert.length) {
      // Chunk to stay under pg's 65535-param hard limit (6 params per row → max 1000 rows/query)
      const CHUNK = 1000;
      for (let start = 0; start < toInsert.length; start += CHUNK) {
        const chunk = toInsert.slice(start, start + CHUNK);
        const vals = [], params = [];
        chunk.forEach((r, i) => {
          const b = i * 6;
          vals.push(`($${b+1},'delivery',$${b+2},$${b+3},$${b+4},'done',$${b+5},$${b+6})`);
          params.push(businessId, r.platform, r.amount, r.sold_at, r.notes, r.external_order_id);
        });
        // rowCount, not chunk.length — ON CONFLICT DO NOTHING can silently
        // drop a row a concurrent import already inserted after this route's
        // own pre-check ran (see dedupAndInsertSales for the same fix)
        const result = await db.query(
          `INSERT INTO sales (business_id, sale_type, delivery_platform, total_amount, sold_at, status, notes, external_order_id) VALUES ${vals.join(',')}
         ON CONFLICT (business_id, external_order_id) WHERE external_order_id IS NOT NULL DO NOTHING`,
          params
        );
        imported += result.rowCount;
      }
      skipped += toInsert.length - imported;
    }

    if (imported) eventBus.publish(businessId, 'delivery.imported', { count: imported, platform });
    res.json({ imported, skipped, invalid, total: rows.length, rawRows: rawRows.length });
  } catch (err) { next(err); }
});

// ── Delivery email IMAP config ────────────────────────────────────────────────

// GET /api/deliveries/email-config
router.get('/email-config', requireAuth, async (req, res, next) => {
  try {
    const config = await deliveryEmailSvc.getConfig(req.user.businessId);
    res.json(config || null);
  } catch (err) { next(err); }
});

const ALLOWED_IMAP_HOSTS = [
  'imap.gmail.com', 'outlook.office365.com', 'imap.mail.yahoo.com',
  'imap.mail.me.com', 'mail.walla.co.il', 'imap.netvision.net.il',
  'imap.bezeqint.net', 'imap.012.net.il', 'imap.014.net.il',
];

// POST /api/deliveries/email-config — save / update
router.post('/email-config', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { email, app_password, imap_host, imap_port, sender_filter } = req.body;
    if (!email || !app_password) return res.status(400).json({ error: 'נדרשים כתובת מייל וסיסמה' });
    if (imap_host && !ALLOWED_IMAP_HOSTS.includes(imap_host.trim().toLowerCase())) {
      return res.status(400).json({ error: 'שרת IMAP לא מורשה' });
    }
    await deliveryEmailSvc.saveConfig(req.user.businessId, { email, app_password, imap_host, imap_port, sender_filter });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/deliveries/email-config
router.delete('/email-config', requireAuth, requireManager, async (req, res, next) => {
  try {
    await deliveryEmailSvc.deleteConfig(req.user.businessId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/deliveries/email-config/test
router.post('/email-config/test', requireAuth, async (req, res, next) => {
  try {
    const { email, app_password, imap_host, imap_port } = req.body;
    if (!email || !app_password) return res.status(400).json({ error: 'נדרשים כתובת מייל וסיסמה' });
    if (imap_host && !ALLOWED_IMAP_HOSTS.includes(imap_host.trim().toLowerCase())) {
      return res.status(400).json({ error: 'שרת IMAP לא מורשה' });
    }
    const result = await deliveryEmailSvc.testConnection({ email, app_password, imap_host, imap_port });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/deliveries/email-fetch — trigger an IMAP scan and import
router.post('/email-fetch', requireAuth, async (req, res, next) => {
  try {
    const config = await deliveryEmailSvc.getConfigWithPassword(req.user.businessId);
    if (!config) return res.status(404).json({ error: 'לא הוגדר חיבור מייל' });
    const result = await deliveryEmailSvc.fetchDeliveries(req.user.businessId, config, Math.min(req.body.daysBack || 14, 90));
    res.json(result);
  } catch (err) { next(err); }
});

// ── Delivery email via Gmail OAuth (shared connection with Z-reports) ─────────

// GET /api/deliveries/gmail-status — merges Gmail connection status with this
// feature's own import-status row (business_delivery_gmail_status).
router.get('/gmail-status', requireAuth, async (req, res, next) => {
  try {
    const [conn, importStatus] = await Promise.all([
      gmailOAuth.getStatus(req.user.businessId),
      getGmailDeliveryStatus(req.user.businessId),
    ]);
    // conn.importStatus is Z-report's own field on the shared connection —
    // spreading importStatus below overrides it with deliveries' own status,
    // so surface Z-report's "awaiting_confirmation" separately here, or a
    // user who connected Gmail from this page never learns their Z-report
    // import is stuck waiting for a subject-confirmation step on /zreport.
    res.json({
      ...conn,
      ...importStatus,
      zreportAwaitingConfirmation: conn.importStatus === 'awaiting_confirmation',
    });
  } catch (err) { next(err); }
});

// POST /api/deliveries/gmail-fetch-now — recent-days on-demand scan
router.post('/gmail-fetch-now', requireAuth, requireManager, async (req, res, next) => {
  try {
    const result = await fetchDeliveriesFromGmail(req.user.businessId, 14);
    if (!result) return res.status(400).json({ error: 'חשבון Gmail לא מחובר' });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/deliveries/gmail-import-history — one-time historical import
router.post('/gmail-import-history', requireAuth, requireManager, async (req, res, next) => {
  try {
    const current = await getGmailDeliveryStatus(req.user.businessId);
    if (current.importStatus === 'running') {
      return res.status(409).json({ error: 'ייבוא היסטוריה כבר רץ ברקע — יש להמתין לסיומו' });
    }
    const months = Math.min(Math.max(parseInt(req.body?.months) || 12, 1), 24);
    res.json({ message: `ייבוא ${months} חודשים החל ברקע`, months });
    setImmediate(() => {
      fetchHistoricalDeliveriesFromGmail(req.user.businessId, months).catch(err => {
        logger.error('[deliveries] gmail-import-history', { err: err.message });
      });
    });
  } catch (err) { next(err); }
});

module.exports = router;
