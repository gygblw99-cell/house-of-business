const db     = require('../../utils/db');
const logger = require('../../utils/logger');

const _UPLOAD_BASE = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// Strip base URL from an /uploads/ URL, leaving just the bare filename.
// Stored as bare filename so the UNIQUE constraint works across server URL changes.
function _normalizeImageUrl(url) {
  if (!url || !url.includes('/uploads/')) return url;
  return url.replace(/^.*\/uploads\//, '');
}

// Reconstruct the full serving URL from a bare filename.
function _expandImageUrl(url) {
  if (!url) return url;
  if (url.startsWith('http')) return url; // already a full URL — legacy row
  return `${_UPLOAD_BASE}/uploads/${url}`;
}

// ── Add one image to the gallery (silent fail — gallery is secondary) ──────────
async function addToGallery({ businessId, imageUrl, category = 'other', title, description, entityId, entityType }) {
  try {
    const normalized = _normalizeImageUrl(imageUrl);
    await db.query(
      `INSERT INTO gallery_items
         (business_id, image_url, category, title, description, entity_id, entity_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (business_id, image_url) DO NOTHING`,
      [businessId, normalized, category, title || null, description || null, entityId || null, entityType || null]
    );
  } catch (err) {
    logger.warn('[Gallery] addToGallery error', { err: err.message });
  }
}

// ── Batch-add images (used for retroactive migration) ─────────────────────────
async function addManyToGallery(items) {
  if (!items?.length) return;
  try {
    const normalized = items.map(it => ({ ...it, imageUrl: _normalizeImageUrl(it.imageUrl) }));
    const values = normalized.map((_, i) => {
      const b = i * 7;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
    }).join(',');
    const params = normalized.flatMap(({ businessId, imageUrl, category, title, description, entityId, entityType }) => [
      businessId, imageUrl, category || 'other', title || null, description || null, entityId || null, entityType || null,
    ]);
    await db.query(
      `INSERT INTO gallery_items (business_id,image_url,category,title,description,entity_id,entity_type)
       VALUES ${values} ON CONFLICT (business_id, image_url) DO NOTHING`,
      params
    );
  } catch (err) {
    logger.warn('[Gallery] addManyToGallery error', { err: err.message });
  }
}

// ── Query gallery with filters ────────────────────────────────────────────────
async function getGallery(businessId, { category, search, dateFrom, dateTo, page = 1, limit = 40 } = {}) {
  const conditions = ['g.business_id = $1'];
  const params = [businessId];
  let idx = 2;

  if (category && category !== 'all') {
    conditions.push(`g.category = $${idx++}`);
    params.push(category);
  }
  if (search) {
    conditions.push(`(g.title ILIKE $${idx} OR g.description ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }
  if (dateFrom) {
    conditions.push(`g.upload_date >= $${idx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`g.upload_date < ($${idx++}::date + INTERVAL '1 day')`);
    params.push(dateTo);
  }

  const where  = conditions.join(' AND ');
  const safeLimit  = Math.min(Math.max(parseInt(limit) || 40, 1), 200);
  const safeOffset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

  const [rowsRes, countRes] = await Promise.all([
    db.query(
      `SELECT g.id, g.image_url, g.category, g.title, g.description,
              g.entity_id, g.entity_type, g.upload_date
       FROM gallery_items g
       WHERE ${where}
       ORDER BY g.upload_date DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, safeLimit, safeOffset]
    ),
    db.query(`SELECT COUNT(*)::int AS total FROM gallery_items g WHERE ${where}`, params),
  ]);

  // Expand bare filenames → full serving URL so the frontend can render them.
  // JS dedup by filename as a permanent safety net — if a race on startup left
  // stale-base-URL rows in the DB, the frontend should never see duplicate cards.
  const seen = new Set();
  const items = [];
  for (const row of rowsRes.rows) {
    const key = row.image_url.includes('/uploads/')
      ? row.image_url.replace(/^.*\/uploads\//, '')
      : row.image_url;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...row, image_url: _expandImageUrl(row.image_url) });
  }

  return {
    items,
    total: countRes.rows[0].total,
    page: parseInt(page) || 1,
    limit: safeLimit,
    pages: Math.ceil(countRes.rows[0].total / safeLimit),
  };
}

// ── Natural-language query parser (Hebrew) ────────────────────────────────────
const HEBREW_MONTHS = {
  ינואר:1, פברואר:2, מרץ:3, אפריל:4, מאי:5, יוני:6,
  יולי:7, אוגוסט:8, ספטמבר:9, אוקטובר:10, נובמבר:11, דצמבר:12,
};
const CATEGORY_KEYWORDS = {
  חשבונית:'invoices', חשבוניות:'invoices',
  ספק:'suppliers',    ספקים:'suppliers',
  משימה:'tasks',      משימות:'tasks',
  פיננסים:'finance',  כספים:'finance',
};
const SKIP_WORDS = new Set(['לי','את','של','מ','ב','ה','ו','תמצא','חפש','הצג','מציג','כל','בשם','מתאריך','תאריך','את','לפי']);

function parseSmartQuery(query) {
  const words = (query || '').trim().split(/\s+/);
  let category = null, dateFrom = null, dateTo = null;
  const searchTokens = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (CATEGORY_KEYWORDS[w]) {
      category = CATEGORY_KEYWORDS[w];
    } else if (HEBREW_MONTHS[w] !== undefined) {
      const month = HEBREW_MONTHS[w];
      const nextW = words[i + 1];
      const year = (nextW && /^\d{4}$/.test(nextW)) ? parseInt(nextW) : new Date().getFullYear();
      if (nextW && /^\d{4}$/.test(nextW)) i++;
      const lastDay = new Date(year, month, 0).getDate();
      dateFrom = `${year}-${String(month).padStart(2,'0')}-01`;
      dateTo   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    } else if (/^\d{4}$/.test(w)) {
      dateFrom = `${w}-01-01`;
      dateTo   = `${w}-12-31`;
    } else if (!SKIP_WORDS.has(w) && w.length > 1) {
      searchTokens.push(w);
    }
  }

  return { category, search: searchTokens.join(' ') || null, dateFrom, dateTo };
}

module.exports = { addToGallery, addManyToGallery, getGallery, parseSmartQuery };
