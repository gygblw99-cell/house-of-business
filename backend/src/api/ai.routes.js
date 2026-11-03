const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const path      = require('path');
const { extractPdfText } = require('../services/zreport.import.service');
const { validateBufferMagicBytes } = require('../utils/upload');
const { requireAuth } = require('../middleware/auth');
const { rateLimitAI } = require('../middleware/rateLimitAI');

// This route (marketing-prompt) had no file-type filter at all — any content
// type was accepted, unlike every other upload route in the app. Restrict to
// what the handler actually branches on: images, PDF, or plain text.
const MARKETING_UPLOAD_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf', 'text/plain', 'text/csv',
]);
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, MARKETING_UPLOAD_MIME.has(file.mimetype) || file.mimetype.startsWith('image/'));
  },
});
const aiAdvisor = require('../agents/aiAdvisor.agent');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const cache     = require('../utils/cache');
const { logTokenUsage } = require('../utils/logTokenUsage');
const logger    = require('../utils/logger');
const { fetchMarketingContext } = require('../services/ai/marketing.context');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const { bustContextCache } = require('../services/ai/business.context');
const db = require('../utils/db');
const eventBus = require('../utils/eventBus');
const { withTimeout } = require('../utils/withTimeout');

// AI-specific rate limiter: max 20 requests per user per minute
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.userId || 'anon',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי שאלות ל-AI, המתן דקה ונסה שנית' },
});

const AI_TIMEOUT_MS = 55000; // 55 seconds — AI calls can take up to a minute

// In-flight deduplication: prevent identical concurrent requests from calling Claude twice
// Key: `${userId}:${msgHash}` → Promise
const _inFlightChats = new Map();

function _dedupChat(userId, message, fn) {
  // Key uses the trimmed message as-is (case-sensitive) so the dedup key matches exactly
  // what is forwarded to the AI, preventing a second requester from receiving a response
  // generated for a differently-cased version of their message.
  const hash = require('crypto').createHash('sha256').update(`${userId}:${message.trim()}`).digest('hex').slice(0, 16);
  const key = `chat:${userId}:${hash}`;
  if (_inFlightChats.has(key)) return _inFlightChats.get(key);
  const p = fn().finally(() => _inFlightChats.delete(key));
  _inFlightChats.set(key, p);
  // Auto-cleanup after 10 seconds to prevent memory leak if fn never resolves.
  // Compare against `p` so a new entry registered after fn() resolved is not deleted.
  setTimeout(() => { if (_inFlightChats.get(key) === p) _inFlightChats.delete(key); }, 10_000);
  return p;
}

// POST /api/ai/chat — שיחה עם היועץ
router.post('/chat', requireAuth, aiLimiter, rateLimitAI(), async (req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'בקשת ה-AI ארכה יותר מדי — נסה שנית' });
  }, AI_TIMEOUT_MS);

  try {
    const { message, isOffline } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      clearTimeout(timeout);
      return res.status(400).json({ error: 'הודעה ריקה' });
    }
    if (message.length > 10000) {
      clearTimeout(timeout);
      return res.status(413).json({ error: 'הודעה ארוכה מדי (מקסימום 10,000 תווים)' });
    }

    let result;
    try {
      result = await _dedupChat(req.user.userId, message, () =>
        aiAdvisor.chat(
          req.user.businessId,
          req.user.userId,
          message.trim(),
          { isOffline: !!isOffline, role: req.user.role || 'owner' }
        )
      );
    } catch (aiErr) {
      logger.error('[AI /chat] Unexpected error', { err: aiErr.message, stack: aiErr.stack });
      result = {
        response: 'שירות ה-AI אינו זמין כרגע — נסה שנית בעוד מספר שניות',
        sources: [],
        toolsUsed: [],
      };
    }

    clearTimeout(timeout);
    if (!res.headersSent) res.json(result);
    // מאפשר לטאב/מכשיר אחר של אותו משתמש לראות את ההודעה החדשה בזמן אמת —
    // כולל userId כי ה-SSE משודר לכל העסק, לא רק למשתמש הזה (היסטוריית
    // צ'אט היא אישית, אז הקליינט מסנן לפי userId לפני שהוא מרענן)
    eventBus.publish(req.user.businessId, 'ai_chat.updated', { userId: req.user.userId, action: 'message' });
  } catch (err) {
    clearTimeout(timeout);
    logger.error('[AI /chat] Outer error', { err: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'שירות ה-AI אינו זמין כרגע — נסה שנית' });
  }
});

// GET /api/ai/history — היסטוריית שיחה
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const rows = await aiAdvisor.getHistory(req.user.userId, req.user.businessId).catch(() => []);
    res.json({
      messages: rows.map(r => ({
        role:      r.role,
        content:   r.content,
        timestamp: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// DELETE /api/ai/history — מחיקת היסטוריה
router.delete('/history', requireAuth, async (req, res, next) => {
  try {
    await aiAdvisor.clearHistory(req.user.userId, req.user.businessId);
    eventBus.publish(req.user.businessId, 'ai_chat.updated', { userId: req.user.userId, action: 'cleared' });
    res.json({ message: 'היסטוריית השיחה נמחקה' });
  } catch (err) { next(err); }
});

// GET /api/ai/health — live DB numbers, bypasses cache, for validation.
// No aiLimiter here: this reads two rows and calls no model, so spending the
// user's 20-per-minute AI allowance on it made the advisor refuse to answer
// after a handful of page loads.
router.get('/health', requireAuth, async (req, res, next) => {
  try {
    const bId = req.user.businessId;

    const [revenue, zreports] = await Promise.all([
      db.query(`
        WITH smart AS (
          SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                 (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
          FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '30 days'
        ),
        ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
        SELECT
          COALESCE(SUM(total_amount), 0)::float  AS revenue_30d,
          COUNT(*)::int                           AS orders_30d,
          COALESCE(SUM(total_amount) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days'), 0)::float AS revenue_7d
        FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
      `, [bId]),
      db.query(`
        SELECT COUNT(*)::int AS total, MAX(report_date) AS last_date
        FROM z_reports WHERE business_id = $1
      `, [bId]).catch(() => ({ rows: [{ total: 0, last_date: null }] })),
    ]);

    const r = revenue.rows[0];
    const z = zreports.rows[0];

    res.json({
      revenue_30d:     r.revenue_30d,
      orders_30d:      r.orders_30d,
      revenue_7d:      r.revenue_7d,
      daily_avg_30d:   r.orders_30d > 0 ? parseFloat((r.revenue_30d / 30).toFixed(2)) : 0,
      zreports_total:  z.total,
      last_zreport:    z.last_date,
      checked_at:      new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// POST /api/ai/bust-cache — force refresh AI context (admin use)
router.post('/bust-cache', requireAuth, async (req, res, next) => {
  try {
    await bustContextCache(req.user.businessId);
    res.json({ ok: true, message: 'AI context cache cleared — next query will fetch fresh data' });
  } catch (err) { next(err); }
});

// ── Marketing AI Agent — pulls full business intelligence then generates ────────

function normalizeMarketingResult(obj, action) {
  const str  = (v) => (typeof v === 'string' ? v : '');
  const arr  = (v) => (Array.isArray(v) ? v : []);
  const recs = arr(obj.recommendations).map(r => ({
    title:        str(r.title),
    why:          str(r.why),
    content_idea: str(r.content_idea),
    platform:     str(r.platform),
    posting_time: str(r.posting_time),
    priority:     ['high','medium','low'].includes(r.priority) ? r.priority : 'medium',
    tool_name:    str(r.tool_name),
    tool_url:     str(r.tool_url),
    tool_reason:  str(r.tool_reason),
  }));
  return {
    campaign_type: str(obj.campaign_type) || action,
    audience:      str(obj.audience),
    summary:       str(obj.summary),
    recommendations: recs,
    quick_wins:    arr(obj.quick_wins).map(w => str(w)).filter(Boolean),
  };
}

const MARKETING_SYSTEM_PROMPT = `You are a marketing advisor for Israeli restaurants. Respond ONLY in Hebrew.
CRITICAL: Be EXTREMELY concise — Hebrew uses many tokens. Every field must be SHORT.

Return a valid JSON object, no markdown, no code blocks:
{
  "campaign_type": "מילה אחת או שתיים",
  "audience": "5 מילים מקסימום",
  "summary": "משפט אחד בלבד",
  "recommendations": [
    {
      "title": "3-4 מילים",
      "why": "משפט אחד קצר",
      "content_idea": "משפט אחד קצר",
      "platform": "instagram/tiktok/facebook/whatsapp/google",
      "posting_time": "3 מילים",
      "priority": "high/medium/low",
      "tool_name": "Canva/CapCut/Buffer/WhatsApp/Google Business",
      "tool_url": "https://canva.com או כלי אחר",
      "tool_reason": "5 מילים"
    }
  ],
  "quick_wins": ["פעולה 1 — 5 מילים", "פעולה 2 — 5 מילים", "פעולה 3 — 5 מילים"]
}
Return EXACTLY 3 recommendations. MAXIMUM 5 words per field unless specified. Total response must be under 800 tokens.`;

// Compact, not pretty-printed. The indentation and newlines JSON.stringify's
// 2-space form adds are billed as input tokens on every marketing call and buy
// the model nothing — it parses either form identically. On a context this
// shape that whitespace is roughly a fifth of the payload.
const ctxJson = (ctx) => JSON.stringify(ctx);

const ACTION_PROMPTS = {
  viral_post: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: המלץ איזה פוסט לפרסם עכשיו ואיפה.
- בחן את המנות עם הביקוש הגבוה ביותר, שעות השיא, והפלטפורמה הכי פעילה
- תן 3-4 המלצות ספציפיות לפוסטים (לא לכתוב את הפוסט — רק רעיון + כיוון)
- לכל המלצה: איזה כלי חינמי להשתמש ולמה
`,

  marketing_image: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: המלץ איך ליצור תמונה שיווקית חזקה.
- מה לצלם / מה לעצב בהתאם לנתוני העסק
- כיוון ויזואלי קצר (לא פרומפט מלא — הכוונה בלבד)
- המלץ על Canva או כלי עיצוב חינמי מתאים
- ציין איפה לפרסם ומתי
`,

  viral_video: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: המלץ על תוכן ווידאו קצר לצלם בעצמו.
- 3-4 רעיונות לווידאו פשוט (15-30 שניות) שהבעל עסק יכול לצלם בסמארטפון
- לכל רעיון: מה לצלם, למה זה יעבוד, איזה כלי עריכה חינמי להשתמש
- המלץ על CapCut / TikTok לעריכה ולפרסום
`,

  smart_promotion: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: המלץ על מבצע חכם שיגדיל מכירות בשעות החלשות.
- שעות חלשות: ${ctx.slowHours.join(', ')}
- מנות עם מרווח גבוה: ${ctx.highMarginDishes.join(', ')}
- מלאי נמוך (מועמד למבצע): ${ctx.lowInventory.join(', ')}
- תן 2-3 רעיונות למבצע + איך לפרסם אותו בכלים חינמיים
`,

  analyze_marketing: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: ניתוח שיווקי מלא + המלצות לפעולה.
- זהה 3 הזדמנויות שיווקיות שמפוספסות עכשיו
- זהה את הערוץ הכי חלש ומה לשפר בו
- לכל הזדמנות: פעולה ספציפית + כלי חינמי לביצוע
`,

  weekly_campaign: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: תכנן שבוע של תוכן שיווקי.
- 4-5 המלצות לימים ספציפיים בשבוע (לא כל יום — רק הימים החשובים)
- לכל יום: נושא, פלטפורמה, כיוון תוכן קצר, זמן פרסום
- המלץ על Buffer לתזמון אוטומטי
`,

  trending_ideas: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: 4-5 רעיונות תוכן טרנדינג שמתאימים לעסק הזה.
- התאם טרנדים של TikTok/Reels לסוג העסק הספציפי
- לכל רעיון: מה לעשות, למה זה רלוונטי, איך לצלם, איזה כלי להשתמש
`,

  viral_content: (ctx, extra) => `
נתוני עסק:
${ctxJson(ctx)}
${extra ? `הקשר נוסף: ${extra}` : ''}

המשימה: המלץ על תוכן אחד עם הפוטנציאל הגבוה ביותר לעסק הזה עכשיו.
- בחר מנה / נושא ספציפי מהנתונים
- תן המלצה מפורטת: מה לפרסם, באיזה פורמט, באיזה ערוץ, מתי
- פרט את כל הכלים החינמיים שדרושים לביצוע
`,
};

// Marketing daily budget — the ceiling below works out to ~$0.43 / business / day.
//
// Claude Haiku 4.5 is $1.00 per MTok input and $5.00 per MTok output. (An
// earlier note here had $0.80/$4.00, which understated every figure by 25% —
// this budget is reasoned from these numbers, so they need to be the real ones.)
//
// Average marketing call ≈ 1500 input + 600 output tokens:
//   1500 × $1/1M + 600 × $5/1M = $0.0015 + $0.0030 = $0.0045
// At the ~71/29 input:output split above, 200k tokens ≈ 143k in + 57k out
//   = $0.143 + $0.285 ≈ $0.43, i.e. roughly 95-110 calls per business per day.
const MARKETING_DAILY_TOKEN_BUDGET = 200_000; // total tokens budget per business per day

// Per-business in-process lock: serialises concurrent marketing requests within one
// process so they can't both read 0-tokens-used and both proceed past the budget guard.
// WARNING: In a multi-process cluster (PM2 workers) this gate is PER-WORKER and provides
// NO cross-worker protection — N workers can each spend the full budget independently.
// For strict multi-process enforcement, replace with a Redis atomic INCR/EXPIRE counter.
const _marketingGates = new Map(); // businessId → chain Promise
function _withMarketingGate(businessId, fn) {
  const prev = _marketingGates.get(businessId) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes, success or failure
  // Store `next` directly (not a derived promise) so the pruning equality check below works.
  _marketingGates.set(businessId, next);
  next.catch(() => {}); // prevent unhandled-rejection warnings on the stored reference
  next.finally(() => {
    // Prune only if no newer request has overwritten this entry since we started
    if (_marketingGates.get(businessId) === next) _marketingGates.delete(businessId);
  });
  return next;
}

// POST /api/ai/marketing — Marketing AI Agent
router.post('/marketing', requireAuth, aiLimiter, rateLimitAI(), async (req, res, next) => {
  try {
    const { action = 'viral_post' } = req.body;
    const extra = String(req.body.extra || '').replace(/[\r\n]/g, ' ').slice(0, 200);
    logger.info('[Marketing] action:', action, 'user:', req.user?.businessId);
    if (!ACTION_PROMPTS[action]) return res.status(400).json({ error: `Unknown action: ${action}` });

    await _withMarketingGate(req.user.businessId, async () => {

    // Token-based daily budget — prevents runaway costs even for heavy queries
    try {
      const { rows: capRows } = await db.query(
        `SELECT COALESCE(SUM(total_tokens), 0) AS tokens_today
         FROM ai_usage_logs
         WHERE business_id = $1
           AND feature LIKE 'marketing_%'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem')`,
        [req.user.businessId]
      );
      const tokensToday = parseInt(capRows[0]?.tokens_today || 0, 10);
      if (tokensToday >= MARKETING_DAILY_TOKEN_BUDGET) {
        return res.status(429).json({
          error: `הגעת לתקציב AI השיווק היומי. נסה שנית מחר.`,
          budget: MARKETING_DAILY_TOKEN_BUDGET,
          usedToday: tokensToday,
        });
      }
    } catch { /* non-fatal — continue if budget check fails */ }

    logger.info('[Marketing] fetching context...');
    const ctx = await cache.wrap(
      `marketing-ctx:${req.user.businessId}`,
      () => fetchMarketingContext(req.user.businessId),
      600 // 10 דקות
    );
    logger.info('[Marketing] context OK, calling Claude...');
    const userPrompt = ACTION_PROMPTS[action](ctx, extra);

    const message = await withTimeout(
    anthropic.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 5000,
        system:     MARKETING_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    AI_TIMEOUT_MS, "timeout");
    logger.info('[Marketing] Claude responded OK', { rawLength: message.content[0]?.text?.length || 0 });
    const parsed = parseClaudeJSON(message, { feature: 'marketing', action, businessId: req.user.businessId });
    if (!parsed) {
      return res.status(502).json({ error: 'לא הצלחנו לנתח את תשובת ה-AI, נסה שוב' });
    }
    const result = normalizeMarketingResult(parsed, action);

    logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: `marketing_${action}`, model: 'claude-haiku-4-5', usage: message.usage });

    res.json({ ...result, action, context_snapshot: {
      business_name: ctx.biz.name,
      revenue_30d:   ctx.summary.total_revenue_30d,
      top_dish:      ctx.dishes[0]?.name || '—',
      peak_hour:     ctx.peakHours[0] || '—',
    }});
    }); // end _withMarketingGate
  } catch (err) {
    if (err.message === 'timeout') return res.status(504).json({ error: 'בקשת ה-AI ארכה יותר מדי — נסה שנית' });
    logger.error('[Marketing] Error', { err: err.message });
    next(err);
  }
});

// ── Weekly Report Crew ────────────────────────────────────────────────────────
const { runWeeklyReportCrew, getLatestReport } = require('../agents/weeklyReportCrew.agent');

// GET /api/ai/weekly-report — fetch latest stored report
router.get('/weekly-report', requireAuth, async (req, res, next) => {
  try {
    const report = await getLatestReport(req.user.businessId);
    res.json({ report });
  } catch (err) { next(err); }
});

const WEEKLY_REPORT_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/ai/weekly-report/generate — run crew now (manual trigger, 2 min timeout)
router.post('/weekly-report/generate', requireAuth, aiLimiter, rateLimitAI(), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.body;
    for (const [label, val] of [['dateFrom', dateFrom], ['dateTo', dateTo]]) {
      if (val !== undefined && val !== null && val !== '' &&
          (typeof val !== 'string' || !WEEKLY_REPORT_ISO_DATE.test(val) || isNaN(new Date(val).getTime()))) {
        return res.status(400).json({ error: `${label === 'dateFrom' ? 'תאריך התחלה' : 'תאריך סיום'} לא תקין — פורמט נדרש YYYY-MM-DD` });
      }
    }
    const result = await withTimeout(
    runWeeklyReportCrew(req.user.businessId, dateFrom || null, dateTo || null),
    145_000, "timeout");
    eventBus.publish(req.user.businessId, 'weekly_report.updated', { action: 'generated', reportId: result.id });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message === 'timeout') return res.status(504).json({ error: 'הדו"ח לקח יותר מדי — נסה שנית' });
    next(err);
  }
});

// DELETE /api/ai/weekly-report/:id — מחיקת דוח שבועי ספציפי
router.delete('/weekly-report/:id', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM weekly_reports WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'דוח לא נמצא' });
    eventBus.publish(req.user.businessId, 'weekly_report.updated', { action: 'deleted', reportId: req.params.id });
    res.json({ message: 'הדוח נמחק' });
  } catch (err) { next(err); }
});

// ── Supplier Negotiation Crew ─────────────────────────────────────────────────
const { runSupplierNegotiationCrew } = require('../agents/supplierNegotiationCrew.agent');

// POST /api/ai/supplier-negotiate/:supplierId (2 min timeout)
router.post('/supplier-negotiate/:supplierId', requireAuth, aiLimiter, rateLimitAI(), async (req, res, next) => {
  // Extend socket timeout for this long-running route so proxies don't drop it
  req.socket?.setTimeout(150_000);
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const result = await withTimeout(
    runSupplierNegotiationCrew(req.user.businessId, req.params.supplierId),
    120_000, "timeout");
    res.json(result);
  } catch (err) {
    if (err.message === 'timeout') return res.status(504).json({ error: 'ניתוח הספק לקח יותר מדי — נסה שנית' });
    next(err);
  }
});

// POST /api/ai/marketing-prompt — מחולל פרומפטים לכלי שיווק (תומך העלאת תמונה / PDF)
router.post('/marketing-prompt', requireAuth, aiLimiter, rateLimitAI(), uploadMemory.single('file'), async (req, res, next) => {
  try {
    const tool        = String(req.body.tool        || '').slice(0, 100);
    const toolDesc    = String(req.body.toolDesc    || '').slice(0, 200);
    const userRequest = String(req.body.userRequest || '').slice(0, 500).trim();
    if (!tool || !userRequest) return res.status(400).json({ error: 'חסרים פרטים' });

    // System prompt is static — user values go only in the user message turn
    const systemPrompt = `אתה מומחה שיווק דיגיטלי למסעדות ועסקי מזון בישראל. כתוב פרומפט מקצועי שהמשתמש יוכל להכניס ישירות לכלי שיווק. הפרומפט חייב להיות: ספציפי למסעדה/עסק מזון ישראלי, מוכן לשימוש ישיר, בעברית (אלא אם הכלי דורש אנגלית), 3-6 משפטים. החזר את הפרומפט בלבד ללא הסברים.`;
    const userMessage = `כלי: ${tool}${toolDesc ? ` (${toolDesc})` : ''}\nבקשה: ${userRequest}${req.file ? '\n[קובץ מצורף — השתמש בו לבסיס עיצוב]' : ''}`;

    // Build user message content — user-supplied values stay in user turn, never in system
    let content;
    if (req.file) {
      const mime = req.file.mimetype || '';
      const ext  = path.extname(req.file.originalname || '').toLowerCase();
      if (!validateBufferMagicBytes(req.file.buffer, ext)) {
        return res.status(400).json({ error: 'תוכן הקובץ לא תואם לסוג המוצהר — ודא שהקובץ תקין' });
      }

      if (mime.startsWith('image/')) {
        content = [
          { type: 'image', source: { type: 'base64', media_type: mime, data: req.file.buffer.toString('base64') } },
          { type: 'text', text: userMessage },
        ];
      } else if (mime === 'application/pdf') {
        let pdfText = '';
        try {
          pdfText = (await extractPdfText(req.file.buffer)).slice(0, 2000).trim();
        } catch { pdfText = '[לא ניתן לחלץ טקסט מה-PDF]'; }
        content = userMessage + (pdfText ? `\n\nתוכן המסמך:\n${pdfText}` : '');
      } else {
        const textContent = req.file.buffer.toString('utf8').slice(0, 2000).trim();
        content = userMessage + (textContent ? `\n\nתוכן הקובץ:\n${textContent}` : '');
      }
    } else {
      content = userMessage;
    }

    const msg = await withTimeout(
    anthropic.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 700,
        system:     systemPrompt,
        messages:   [{ role: 'user', content }],
      }),
    AI_TIMEOUT_MS, "timeout");

    const prompt = msg.content[0]?.text?.trim() || '';
    // Unlike every other paid call in this router, this one never logged its
    // usage — MARKETING_DAILY_TOKEN_BUDGET (above) sums ai_usage_logs WHERE
    // feature LIKE 'marketing_%', so this route had zero token-based cost
    // ceiling (only the generic per-day request-count rate limit applied),
    // despite accepting image/PDF uploads that can cost far more per call
    // than a plain /marketing request.
    logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'marketing_prompt', model: 'claude-haiku-4-5', usage: msg.usage });
    res.json({ prompt });
  } catch (err) {
    if (err.message === 'timeout') return res.status(504).json({ error: 'בקשת ה-AI ארכה יותר מדי — נסה שנית' });
    next(err);
  }
});

module.exports = router;
