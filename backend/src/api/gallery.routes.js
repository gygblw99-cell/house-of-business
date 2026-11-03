const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { requireAuth } = require('../middleware/auth');
const { upload, validateMagicBytes, buildUploadUrl, UPLOAD_DIR } = require('../utils/upload');
const db      = require('../utils/db');
const cache   = require('../utils/cache');
const { getGallery, parseSmartQuery } = require('../services/gallery/gallery.service');

// gallery_items.image_url must always be a full absolute URL — the gallery
// page renders it directly with no host prefix, and the auth-token hook
// (useImgToken) only appends the token when the URL contains '/uploads/'
// after the host. The retroactive migrations/sync below used to insert a
// bare filename (for invoices) or a root-relative path (for task photos)
// straight from the source tables, producing broken/tokenless <img> tags for
// any business with pre-existing invoice/task photos. buildUploadUrl() is
// the single source of truth for this base — mirrored here as a SQL literal
// since these are one-shot bulk INSERT...SELECT migrations, not per-row JS.
const _UPLOAD_BASE = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Auto-create table + unique constraint ─────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS gallery_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    image_url   TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'other',
    title       TEXT,
    description TEXT,
    entity_id   TEXT,
    entity_type TEXT,
    upload_date TIMESTAMPTZ DEFAULT NOW(),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (business_id, image_url)
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_gallery_biz_date ON gallery_items(business_id, upload_date DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_gallery_biz_cat  ON gallery_items(business_id, category)`);

// Dedup + normalize is handled in bootstrap.js (gallery_normalize_image_url_v2)
// which runs sequentially after the DB connection is established.

// ── Retroactive migration: populate from existing invoices ─────────────────────
// image_urls stores bare filenames (path.basename of the uploaded file) —
// so we insert them directly. The service expands to a full URL at read time.
db.migrate(`
  INSERT INTO gallery_items (business_id, image_url, category, title, description, entity_id, entity_type, upload_date)
  SELECT
    i.business_id,
    UNNEST(i.image_urls)  AS image_url,
    'invoices'            AS category,
    COALESCE(s.name, 'חשבונית') || CASE WHEN i.invoice_number IS NOT NULL AND i.invoice_number != '' THEN ' #' || i.invoice_number ELSE '' END AS title,
    'חשבונית מ-' || TO_CHAR(COALESCE(i.invoice_date, i.created_at::date), 'DD/MM/YYYY') AS description,
    i.id::text            AS entity_id,
    'invoice'             AS entity_type,
    i.created_at          AS upload_date
  FROM invoices i
  LEFT JOIN suppliers s ON s.id = i.supplier_id
  WHERE array_length(i.image_urls, 1) > 0
  ON CONFLICT (business_id, image_url) DO NOTHING
`).catch(() => {}); // silent — invoices table might not have image_urls as TEXT[]

// ── Retroactive migration: task subtask completion photos ──────────────────────
// completion_photo is stored as "/uploads/filename.jpg" — strip the prefix.
db.migrate(`
  INSERT INTO gallery_items (business_id, image_url, category, title, description, entity_id, entity_type, upload_date)
  SELECT
    t.business_id,
    REGEXP_REPLACE(ts.completion_photo, '^.*/?uploads/', '') AS image_url,
    'tasks'               AS category,
    t.title               AS title,
    'תמונת ביצוע: ' || COALESCE(ts.title, '') AS description,
    ts.id::text           AS entity_id,
    'task_subtask'        AS entity_type,
    COALESCE(ts.completed_at, ts.created_at) AS upload_date
  FROM task_subtasks ts
  JOIN tasks t ON t.id = ts.task_id
  WHERE ts.completion_photo IS NOT NULL
    AND ts.completion_photo != ''
  ON CONFLICT (business_id, image_url) DO NOTHING
`).catch(() => {}); // silent — tasks table might not exist yet

// ── POST /api/gallery/sync — retroactive full sync ────────────────────────────
router.post('/sync', requireAuth, async (req, res, next) => {
  try {
    // Invoices — image_urls stores bare filenames; insert them directly
    const inv = await db.query(`
      INSERT INTO gallery_items (business_id, image_url, category, title, description, entity_id, entity_type, upload_date)
      SELECT
        i.business_id,
        UNNEST(i.image_urls),
        'invoices',
        COALESCE(s.name, 'חשבונית') || CASE WHEN i.invoice_number IS NOT NULL AND i.invoice_number != '' THEN ' #' || i.invoice_number ELSE '' END,
        'חשבונית מ-' || TO_CHAR(COALESCE(i.invoice_date, i.created_at::date), 'DD/MM/YYYY'),
        i.id::text,
        'invoice',
        i.created_at
      FROM invoices i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.business_id = $1 AND array_length(i.image_urls, 1) > 0
      ON CONFLICT (business_id, image_url) DO NOTHING
    `, [req.user.businessId]).catch(() => ({ rowCount: 0 }));

    // Task subtask photos — strip /uploads/ prefix to store bare filename
    const tasks = await db.query(`
      INSERT INTO gallery_items (business_id, image_url, category, title, description, entity_id, entity_type, upload_date)
      SELECT
        t.business_id,
        REGEXP_REPLACE(ts.completion_photo, '^.*/?uploads/', ''),
        'tasks',
        t.title,
        'תמונת ביצוע: ' || COALESCE(ts.title, ''),
        ts.id::text,
        'task_subtask',
        COALESCE(ts.completed_at, ts.created_at)
      FROM task_subtasks ts
      JOIN tasks t ON t.id = ts.task_id
      WHERE t.business_id = $1
        AND ts.completion_photo IS NOT NULL
        AND ts.completion_photo != ''
      ON CONFLICT (business_id, image_url) DO NOTHING
    `, [req.user.businessId]).catch(() => ({ rowCount: 0 }));

    cache.del(`gallery-cats:${req.user.businessId}`).catch(() => {});
    res.json({ ok: true, synced: { invoices: inv.rowCount || 0, tasks: tasks.rowCount || 0 } });
  } catch (err) { next(err); }
});

// ── GET /api/gallery?category=&search=&dateFrom=&dateTo=&page=&limit= ─────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { category, search, dateFrom, dateTo, page = 1, limit = 40 } = req.query;
    const result = await getGallery(req.user.businessId, { category, search, dateFrom, dateTo, page, limit });
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/gallery/categories — counts per category ─────────────────────────
router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const key = `gallery-cats:${req.user.businessId}`;
    const data = await cache.wrap(key, async () => {
      const { rows } = await db.query(
        `SELECT category, COUNT(*)::int AS count
         FROM gallery_items WHERE business_id=$1
         GROUP BY category ORDER BY count DESC`,
        [req.user.businessId]
      );
      const total = rows.reduce((s, r) => s + r.count, 0);
      return { categories: rows, total };
    }, 120);
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/gallery/smart-search — natural language search ───────────────────
router.post('/smart-search', requireAuth, async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'שאילתה חסרה' });

    const parsed = parseSmartQuery(query);
    const result = await getGallery(req.user.businessId, {
      category:  parsed.category  || undefined,
      search:    parsed.search    || undefined,
      dateFrom:  parsed.dateFrom  || undefined,
      dateTo:    parsed.dateTo    || undefined,
      page: 1,
      limit: 40,
    });

    res.json({ ...result, parsed });
  } catch (err) { next(err); }
});

// ── POST /api/gallery/upload — direct image upload to gallery ────────────────
router.post('/upload', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });
    const valid = await validateMagicBytes(req.file.path).catch(() => false);
    if (!valid) return res.status(400).json({ error: 'סוג קובץ לא נתמך' });

    const filename = path.basename(req.file.path);
    const imageUrl = filename; // store bare filename — service expands to full URL at read time
    const title = req.body.title?.trim() || null;
    const VALID_CATS = ['invoices', 'suppliers', 'tasks', 'finance', 'other'];
    const category = VALID_CATS.includes(req.body.category) ? req.body.category : 'other';
    const { rows: [item] } = await db.query(
      `INSERT INTO gallery_items (business_id, image_url, category, title, description)
       VALUES ($1, $2, $3, $4, 'הועלה ישירות לגלריה')
       ON CONFLICT (business_id, image_url) DO NOTHING
       RETURNING *`,
      [req.user.businessId, imageUrl, category, title]
    );
    cache.del(`gallery-cats:${req.user.businessId}`).catch(() => {});
    res.status(201).json({ item });
  } catch (err) { next(err); }
});

// ── DELETE /api/gallery/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM gallery_items WHERE id=$1 AND business_id=$2 RETURNING image_url, entity_type`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'פריט לא נמצא' });

    // Only unlink the physical file for standalone gallery uploads
    // (entity_type IS NULL, i.e. POST /gallery/upload) — an item with an
    // entity_type (invoice/task_subtask) points at a file another feature's
    // row still references, so deleting it here would break that invoice's/
    // task's own image display. Standalone uploads previously left their
    // file on disk forever with no cleanup path anywhere in the codebase.
    const item = rows[0];
    if (!item.entity_type && item.image_url?.includes('/uploads/')) {
      const filename = item.image_url.split('/uploads/').pop();
      if (filename && !filename.includes('/') && !filename.includes('..')) {
        fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch(() => {});
      }
    }

    cache.del(`gallery-cats:${req.user.businessId}`).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
