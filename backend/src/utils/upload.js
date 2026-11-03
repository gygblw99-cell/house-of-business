const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const db     = require('./db');
const logger = require('./logger');

// שמירה זמנית בשרת לפני עיבוד
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// Same reasoning as payslipPdf.service.js: never let a filesystem call at
// import time decide whether the server boots. multer's destination callback
// runs per request, which is where a missing/unwritable directory should
// surface — as a failed upload, not a dead process.
function ensureUploadDir() {
  if (fs.existsSync(UPLOAD_DIR)) return;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// מעקב בעלות — מאפשר ל-/uploads/:filename לוודא שהקורא שייך לאותו עסק שהעלה
// את הקובץ. הקריאה נכשלת סגור: קובץ ללא רשומה לא יוגש כלל, ולכן חובה
// שכתיבת הרשומה תצליח או שההעלאה כולה תיכשל (ראה filename() למטה).
db.migrate(`
  CREATE TABLE IF NOT EXISTS file_uploads (
    filename    TEXT PRIMARY KEY,
    business_id UUID NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureUploadDir();
    } catch (err) {
      return cb(Object.assign(new Error('תיקיית ההעלאות אינה זמינה'), { status: 503, cause: err }));
    }
    cb(null, UPLOAD_DIR);
  },
  filename:    async (req, file, cb) => {
    const unique   = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const filename = `${unique}${path.extname(file.originalname)}`;
    const bizId    = req.user?.businessId;
    // Ownership must be recorded, or the file is unreachable: the read path
    // refuses anything it can't attribute to a business. Failing the upload
    // here is the honest outcome — the previous silent catch produced files
    // that were written to disk but could never be served back.
    if (!bizId) return cb(Object.assign(new Error('לא ניתן להעלות קובץ ללא הקשר עסק'), { status: 401 }));
    try {
      await db.query(
        `INSERT INTO file_uploads (filename, business_id) VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
        [filename, bizId]
      );
    } catch (err) {
      return cb(Object.assign(new Error('שמירת הקובץ נכשלה — נסה שוב'), { status: 503, cause: err }));
    }
    cb(null, filename);
  },
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const ALLOWED_EXT  = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']);

// Magic bytes: validate actual file content, not just the reported MIME/extension
const MAGIC_SIGNATURES = [
  { magic: Buffer.from([0xFF, 0xD8, 0xFF]),             mime: 'image/jpeg' },
  { magic: Buffer.from([0x89, 0x50, 0x4E, 0x47]),       mime: 'image/png'  },
  { magic: Buffer.from([0x52, 0x49, 0x46, 0x46]),       mime: 'image/webp' }, // RIFF (WebP)
  { magic: Buffer.from([0x25, 0x50, 0x44, 0x46]),       mime: 'application/pdf' }, // %PDF
];

async function validateMagicBytes(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  const buf = Buffer.alloc(8);
  await fd.read(buf, 0, 8, 0);
  await fd.close();
  // HEIC/HEIF: ftyp box at offset 4 — looser check, accept if MIME declared correctly
  const isHeic = buf.slice(4, 8).toString('ascii') === 'ftyp';
  if (isHeic) return true;
  return MAGIC_SIGNATURES.some(sig => buf.slice(0, sig.magic.length).equals(sig.magic));
}

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext));
};

// Buffer-based magic-byte check for routes using multer.memoryStorage()
// (no disk path for validateMagicBytes() above to open) — covers the binary
// formats with real parser attack surface (zip-based xlsx/zip, PDF, images).
// Plain-text formats (csv/txt/html/xml/json/eml) have no meaningful magic-byte
// signature to check — their own parsers already reject malformed content,
// which is the right layer of defense for those.
const BUFFER_MAGIC_RULES = [
  { ext: ['.xlsx', '.zip'], sigs: [[0x50,0x4B,0x03,0x04], [0x50,0x4B,0x05,0x06], [0x50,0x4B,0x07,0x08]] },
  { ext: ['.pdf'],          sigs: [[0x25,0x50,0x44,0x46]] },
  { ext: ['.jpg', '.jpeg'], sigs: [[0xFF,0xD8,0xFF]] },
  { ext: ['.png'],          sigs: [[0x89,0x50,0x4E,0x47]] },
  { ext: ['.webp'],         sigs: [[0x52,0x49,0x46,0x46]] },
];

function validateBufferMagicBytes(buffer, ext) {
  const rule = BUFFER_MAGIC_RULES.find(r => r.ext.includes(String(ext).toLowerCase()));
  if (!rule || !buffer || !buffer.length) return true; // no signature defined for this ext — nothing to check here
  return rule.sigs.some(sig => sig.every((b, i) => buffer[i] === b));
}

// עד 10 תמונות (חשבונית מרובת עמודים) — 20MB לקובץ
const _multer = multer({ storage, fileFilter, limits: { files: 10, fileSize: 20 * 1024 * 1024 } });

// ── Persist to object storage after multer, before the route runs ────────────
// multer keeps writing to local disk on purpose: three route files read
// req.file.path afterwards (magic-byte validation, the invoice OCR pipeline,
// task photos), and rewriting all of them to work from buffers would be a far
// larger and riskier change than this. Local disk becomes a scratch area for
// the duration of the request; the durable copy goes to R2.
//
// Wrapping the middleware rather than asking each route to call a helper is
// deliberate. A route that forgot the call would still appear to work — the
// file would be written, served back within the same container, and vanish at
// the next deploy. That failure is invisible until someone opens an old
// invoice, which is exactly the class of silent loss this change exists to end.
const objectStore = require('./storage');

async function _persist(req, _res, next) {
  const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat())
              : req.file ? [req.file] : [];
  // Warn only when files were accepted but will not be kept. Both skip paths
  // return silently and an upload that stayed on local disk looks, from
  // outside, exactly like one that reached R2 — so the case that matters
  // (files present, no durable backend) says so rather than passing quietly.
  if (files.length && !objectStore.isRemote()) {
    logger.warn('[upload] object storage not configured — files stay on local disk and will not survive a deploy',
      { files: files.length, url: req.originalUrl });
    return next();
  }
  if (!objectStore.isRemote() || !files.length) return next();
  try {
    // The local copy has to survive until the route is done with req.file.path,
    // so upload now and let the response hook remove it afterwards.
    await Promise.all(files.map(f => objectStore.put(f.filename, fs.readFileSync(f.path))));
    _res.on('finish', () => {
      for (const f of files) fs.promises.unlink(f.path).catch(() => {});
    });
    next();
  } catch (err) {
    // Failing loudly beats accepting a file we can't keep: the ownership row
    // is already written, so a silent miss would leave a permanently
    // unreachable record pointing at a file that dies with the container.
    logger.error('[upload] object storage write failed', { err: err.message, count: files.length });
    next(Object.assign(new Error('שמירת הקובץ נכשלה — נסה שוב'), { status: 503, cause: err }));
  }
}

// Same call signature as multer's, so no route changes: Express accepts an
// array of middleware wherever it accepts one.
const upload = {
  single: (field)      => [_multer.single(field), _persist],
  array:  (field, max) => [_multer.array(field, max), _persist],
  any:    ()           => [_multer.any(), _persist],
  fields: (f)          => [_multer.fields(f), _persist],
  none:   ()           => _multer.none(),
};

// Full absolute URL for an uploaded file — BACKEND_BASE_URL (no /api suffix,
// used by Guardian health checks) is the correct base here, NOT BACKEND_URL
// (which has an /api suffix for the frontend's api-proxy and would 404
// against /uploads/:filename, which is mounted at the app root, not under /api).
function buildUploadUrl(filename) {
  const base = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
  return `${base}/uploads/${filename}`;
}

module.exports = { upload, UPLOAD_DIR, validateMagicBytes, validateBufferMagicBytes, buildUploadUrl };
