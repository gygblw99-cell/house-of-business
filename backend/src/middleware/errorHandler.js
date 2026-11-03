const logger = require('../utils/logger');

const GENERIC_500 = 'שגיאת שרת פנימית';

// Multer errors have err.name === 'MulterError' and a string err.code (not a
// 5-char Postgres-style code, so they never matched PG_ERROR_MAP or the
// unmapped-PG-code regex below) — they used to fall straight through to the
// generic 500 branch. A photo over the 20MB limit (plausible from a modern
// phone camera) showed "שגיאת שרת פנימית" instead of a message telling the
// user what actually went wrong and how to fix it.
const MULTER_ERROR_MAP = {
  LIMIT_FILE_SIZE:      'הקובץ גדול מדי — הגודל המקסימלי הוא 20MB',
  LIMIT_FILE_COUNT:     'יותר מדי קבצים בבקשה אחת',
  LIMIT_UNEXPECTED_FILE: 'סוג קובץ לא צפוי',
};

// Postgres error codes → safe Hebrew messages (never expose column/table names)
const PG_ERROR_MAP = {
  '23505': { status: 409, message: 'הרשומה כבר קיימת במערכת' },
  '23503': { status: 409, message: 'לא ניתן לבצע פעולה — קיימת תלות בנתונים אחרים' },
  '23502': { status: 400, message: 'חסרים שדות חובה' },
  '23514': { status: 400, message: 'הנתונים אינם עומדים בדרישות המערכת' },
  '22001': { status: 400, message: 'אחד הערכים ארוך מדי' },
  '22P02': { status: 400, message: 'פורמט נתונים שגוי' },
  '42703': { status: 500, message: GENERIC_500 },
  '42P01': { status: 500, message: GENERIC_500 },
  '08001': { status: 503, message: 'שירות הנתונים אינו זמין כרגע' },
  '08006': { status: 503, message: 'שירות הנתונים אינו זמין כרגע' },
  '08003': { status: 503, message: 'שירות הנתונים אינו זמין כרגע' },
  '57014': { status: 503, message: 'הפעולה לקחה יותר מדי זמן' },
};

// ── Error monitoring — report 500s to external webhook (Sentry-compatible) ────
async function reportError(err, req, status) {
  const webhookUrl = process.env.ERROR_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const payload = {
      level:     status >= 500 ? 'error' : 'warning',
      message:   err.message,
      timestamp: new Date().toISOString(),
      request: {
        method: req.method,
        url:    req.originalUrl,
        userId: req.user?.userId,
        ip:     req.ip,
      },
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    };
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* never let monitoring crash the app */ }
}

const errorHandler = (err, req, res, next) => {
  // If response is already streaming, delegate to Express default handler
  if (res.headersSent) return next(err);

  const userId = req.user?.userId;

  // Multer upload errors — safe, specific, user-actionable messages
  if (err.name === 'MulterError') {
    logger.warn(`${req.method} ${req.path} → Multer ${err.code}`, { userId });
    return res.status(400).json({ error: MULTER_ERROR_MAP[err.code] || 'שגיאה בהעלאת הקובץ' });
  }

  // Postgres errors — map to safe messages regardless of status
  if (err.code && PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code];
    logger.error(`${req.method} ${req.path} → PG ${err.code}`, {
      pgCode: err.code, message: err.message, userId,
    });
    if (mapped.status >= 500) reportError(err, req, mapped.status);
    return res.status(mapped.status).json({ error: mapped.message });
  }

  // Raw DB error without a mapped code — treat as 500 and never expose message
  if (err.code && /^[0-9A-Z]{5}$/.test(err.code)) {
    logger.error(`${req.method} ${req.path} → unmapped PG ${err.code}`, {
      pgCode: err.code, message: err.message, stack: err.stack, userId,
    });
    reportError(err, req, 500);
    return res.status(500).json({ error: GENERIC_500 });
  }

  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    logger.error(`${req.method} ${req.path} → ${status}`, {
      error: err.message,
      stack: err.stack,
      userId,
    });
    reportError(err, req, status);
    return res.status(status).json({ error: GENERIC_500 });
  }

  // 4xx: safe to return the message (intentional user-facing text)
  logger.warn(`${req.method} ${req.path} → ${status}: ${err.message}`);
  res.status(status).json({ error: err.message || GENERIC_500 });
};

module.exports = errorHandler;
