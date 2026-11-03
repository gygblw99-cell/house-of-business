const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth, requireManager } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const db        = require('../utils/db');
const eventBus  = require('../utils/eventBus');

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.userId || 'anon',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  message: { error: 'חרגת ממגבלת ניתוח ביקורות — נסה שוב בעוד שעה' },
  standardHeaders: true,
  legacyHeaders: false,
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { logTokenUsage } = require('../utils/logTokenUsage');

// ── DB: יצירת טבלאות אם לא קיימות ─────────────────────────
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS review_batches (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      platform     TEXT NOT NULL,
      raw_text     TEXT NOT NULL,
      analysis     JSONB,
      created_by   UUID NOT NULL REFERENCES users(id),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_review_batches_biz ON review_batches(business_id, created_at DESC);
  `);
  // Individual reviews table (used by AI context queries for rating analytics)
  await db.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL DEFAULT 'manual',
      reviewer    TEXT,
      rating      NUMERIC(3,1) CHECK (rating >= 0 AND rating <= 5),
      content     TEXT,
      source_url  TEXT,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_biz_date ON reviews(business_id, created_at DESC);
  `);
}
ensureTable().catch(e => logger.warn('[Reviews] table init warning', { err: e.message }));

// ── Prompt לניתוח ביקורות ────────────────────────────────
function buildPrompt(platform, text) {
  return `אתה מנתח ביקורות לעסקי מזון. קיבלת ביקורות מהפלטפורמה: ${platform}.

ביקורות:
---
${text.slice(0, 6000)}
---

נתח את הביקורות ובנה תשובה בפורמט JSON בלבד (ללא טקסט נוסף מחוץ ל-JSON):
{
  "overallSentiment": "חיובי" | "ניטרלי" | "שלילי",
  "averageRating": number (1-5, הערכה מהטקסט),
  "totalReviews": number (ספור ביקורות),
  "summary": "סיכום 2-3 משפטים בעברית",
  "strengths": ["חוזקה 1", "חוזקה 2", ...],
  "issues": [
    { "topic": "נושא הבעיה", "count": number, "severity": "גבוה"|"בינוני"|"נמוך", "example": "ציטוט קצר מהביקורת" }
  ],
  "repeatingComplaints": ["תלונה חוזרת 1", "תלונה חוזרת 2", ...],
  "actionItems": ["פעולה מוצעת 1", "פעולה מוצעת 2", ...],
  "positiveHighlights": ["הדגשה חיובית 1", ...],
  "keywords": ["מילת מפתח 1", "מילת מפתח 2", ...]
}`;
}

// GET /api/reviews — רשימת ניתוחים
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, platform, analysis, created_at,
              LEFT(raw_text, 120) AS preview
         FROM review_batches
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.user.businessId]
    );
    res.json({ batches: rows });
  } catch (err) { next(err); }
});

// POST /api/reviews/analyze — ניתוח ביקורות חדש
router.post('/analyze', requireAuth, requireManager, analyzeLimiter, validate({ body: schemas.analyzeReviewsSchema }), async (req, res, next) => {
  try {
    const { platform, text } = req.body;
    // Zod schema already validates platform enum and text length/min — no need to re-validate here

    // ניתוח עם Claude
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: buildPrompt(platform, text) }],
    });

    logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'reviews_analysis', model: 'claude-haiku-4-5', usage: msg.usage });

    let analysis = null;
    try {
      const raw = msg.content[0]?.text || '';
      // חלץ JSON מהתשובה
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) analysis = JSON.parse(match[0]);
    } catch { /* אם parse נכשל — שמור null */ }

    // שמור ב-DB
    const { rows } = await db.query(
      `INSERT INTO review_batches (business_id, platform, raw_text, analysis, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [req.user.businessId, platform, text.trim(), JSON.stringify(analysis), req.user.userId]
    );

    eventBus.publish(req.user.businessId, 'review.updated', { action: 'analyzed', id: rows[0].id });
    res.json({ id: rows[0].id, analysis, createdAt: rows[0].created_at });
  } catch (err) { next(err); }
});

// DELETE /api/reviews/:id — מחיקת ניתוח
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM review_batches WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'review.updated', { action: 'deleted', id: req.params.id });
    res.json({ message: 'נמחק' });
  } catch (err) { next(err); }
});

// POST /api/reviews/batch/:batchId/create-tasks — יצירת משימות מפעולות מומלצות של ניתוח
router.post('/batch/:batchId/create-tasks', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, analysis, platform FROM review_batches WHERE id = $1 AND business_id = $2',
      [req.params.batchId, req.user.businessId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ניתוח לא נמצא' });

    const batch = rows[0];
    const actionItems = batch.analysis?.actionItems || [];
    if (actionItems.length === 0) return res.json({ created: 0, tasks: [] });

    const tasks = [];
    for (const item of actionItems) {
      const title       = String(item).slice(0, 200);
      const description = `מתוך ניתוח ביקורות (${batch.platform || 'ידני'})`;
      const { rows: inserted } = await db.query(
        `INSERT INTO tasks (id, business_id, created_by, title, description, priority, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'normal', 'open', NOW(), NOW())
         RETURNING id, title, priority, status, created_at`,
        [req.user.businessId, req.user.userId, title, description]
      );
      tasks.push(inserted[0]);
    }

    res.json({ created: tasks.length, tasks });
  } catch (err) { next(err); }
});

module.exports = router;
