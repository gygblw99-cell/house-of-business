/**
 * AI Advisor Agent
 * יועץ עסקי חכם עם גישה לכל נתוני העסק + חיפוש אינטרנט
 * - Multi-turn conversation עם היסטוריה פרטית לכל משתמש
 * - Web search tool use
 * - עונה בשפה שפונים אליו
 * - לא מבצע פעולות — רק מייעץ
 */

const Anthropic      = require('@anthropic-ai/sdk');
const crypto         = require('crypto');
const db             = require('../utils/db');
const logger         = require('../utils/logger');
const cache          = require('../utils/cache');
const { buildBusinessContext } = require('../services/ai/business.context');
const orchestrator   = require('../services/ai/aiOrchestrator.service');
const { looksDataDependent } = require('../services/ai/scoringEngine');
const { detectDataWarning } = require('./menuEngineering.agent');
const { EXPENSE_ACTIVE_TODAY } = require('../utils/expenseWindow');
const { INGREDIENT_COST_CTE } = require('../utils/ingredientSource');
const inventoryModel = require('../models/inventory.model');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { logTokenUsage } = require('../utils/logTokenUsage');
const { createWithRetry } = require('../utils/anthropicRetry');
const { sanitizeObject } = require('../utils/aiSanitize');

// ── Conversation encryption (AES-256-GCM) ────────────────────────────────────
// Use a dedicated CONVERSATION_ENCRYPT_KEY so rotating JWT_SECRET does not
// destroy all existing encrypted conversation history.
// Falls back to JWT_SECRET only when CONVERSATION_ENCRYPT_KEY is not set.
const _CONV_KEY_SOURCE = process.env.CONVERSATION_ENCRYPT_KEY || process.env.JWT_SECRET;
if (!_CONV_KEY_SOURCE) {
  throw new Error('[aiAdvisor] Missing CONVERSATION_ENCRYPT_KEY and JWT_SECRET — cannot start without an encryption key');
}
const _CONV_KEY = crypto.createHash('sha256').update(_CONV_KEY_SOURCE).digest(); // 32 bytes

function _encrypt(text) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _CONV_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function _decrypt(stored) {
  try {
    const [ivB64, tagB64, encB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !encB64) return stored; // not encrypted (legacy row)
    const iv      = Buffer.from(ivB64,  'base64');
    const tag     = Buffer.from(tagB64, 'base64');
    const enc     = Buffer.from(encB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', _CONV_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return stored; // legacy plain-text row — return as-is
  }
}

// ── Auto-create conversation history table ────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    user_id     UUID NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_ai_conv_user_biz ON ai_conversations(user_id, business_id, created_at DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_ai_conv_biz_created ON ai_conversations(business_id, created_at DESC)`);

// ── כלים זמינים ל-Agent ───────────────────────────────────────
const TOOLS = [
  {
    name:        'web_search',
    description: 'Search the internet for market prices, industry benchmarks, regulations, supplier research, and trends',
    input_schema: {
      type:       'object',
      properties: {
        query:    { type: 'string', description: 'Search query' },
        language: { type: 'string', description: 'Search language (he/en)' },
      },
      required: ['query'],
    },
  },
  {
    name:        'get_business_data',
    description: `Retrieve deep-dive business data from the DB. Call this whenever the system prompt data is insufficient to answer the user's question.

dataType guide — use the RIGHT type for the question:
• revenue_by_day       → "which day of week is strongest/weakest?" "מה היום הכי חזק?" "מה היום הכי חלש?"
• cashflow             → daily revenue trend, cash flow over time
• recipe_profit        → profit margin per dish / recipe
• supplier_prices      → ingredient prices per supplier
• employee_hours       → hours worked this month per employee
• inventory_detail     → exact stock levels and costs
• compare_periods      → month vs month revenue comparison
• revenue_forecast     → projected revenue for next 7/30 days
• customer_retention   → repeat customer rate
• financial_breakdown  → full P&L: revenue, COGS, fixed expenses, net profit
• top_customers        → top customers by spend
• promotion_analysis   → revenue by channel (dine-in, delivery, takeout)
• supplier_invoices    → invoices and spend per supplier

IMPORTANT: If the user asks about day-of-week patterns (strongest/weakest day), ALWAYS call with dataType="revenue_by_day" — do NOT guess without this data.`,
    input_schema: {
      type:       'object',
      properties: {
        dataType: {
          type: 'string',
          enum: [
            'recipe_profit',
            'supplier_prices',
            'employee_hours',
            'cashflow',
            'inventory_detail',
            'revenue_by_day',
            'top_customers',
            'promotion_analysis',
            'supplier_invoices',
            'compare_periods',
            'revenue_forecast',
            'customer_retention',
            'financial_breakdown',
          ],
          description: 'Type of data to retrieve — see tool description for which type to use per question',
        },
        identifier: { type: 'string', description: 'Specific name (dish/supplier/employee) to filter by — optional' },
        days:       { type: 'number', description: 'Number of days to look back — default 30' },
        period1:    { type: 'string', description: 'First period for comparison (YYYY-MM) — used with compare_periods' },
        period2:    { type: 'string', description: 'Second period for comparison (YYYY-MM) — used with compare_periods' },
      },
      required: ['dataType'],
    },
  },
];

// ── chat — שיחה חדשה / המשך שיחה ────────────────────────────
async function chat(businessId, userId, userMessage, { isOffline = false, role = 'owner' } = {}) {
  // מצב Offline — הודעה קבועה, ללא קריאה ל-AI. נשמר בהיסטוריה כמו כל הודעה
  // אחרת (בניגוד לקודם) — קודם ההחזרה קרתה לפני השמירה, ומכיוון ש-POST /chat
  // מפרסם ai_chat.updated גם במצב הזה, ה-frontend היה מרענן את ההיסטוריה
  // מה-DB ומוחק את ההחלפה הזו מהתצוגה כמעט מיד, גם באותו טאב.
  if (isOffline) {
    const offlineResponse = 'אני במצב לא מקוון — זו הודעה קבועה ולא ניתוח אמיתי של נתוני העסק שלך. כבה את המצב הזה כדי לקבל ייעוץ אמיתי המבוסס על הנתונים שלך.';
    _saveMessage(businessId, userId, 'user', userMessage).catch(() => {});
    _saveMessage(businessId, userId, 'assistant', offlineResponse).catch(() => {});
    return {
      response: offlineResponse,
      sources:  [],
      toolsUsed: [],
    };
  }

  // Response cache — generic per-business for pure knowledge questions (no tools, no history).
  const _msgHash = crypto.createHash('sha256').update(userMessage.trim().toLowerCase()).digest('hex').slice(0, 16);
  // _genericKey is per-user (not just per-business) so two users in the same business
  // do not share cached answers built from different conversation histories.
  const _genericKey  = `ai_advisor_generic:${businessId}:${userId}:${_msgHash}`;
  // Check per-business generic cache (zero-history, zero-tools responses only)
  const _cachedGeneric = await cache.get(_genericKey);
  if (_cachedGeneric) return _cachedGeneric;

  // Save user message (cache miss confirmed — no write on cache hits, no orphaned rows)
  _saveMessage(businessId, userId, 'user', userMessage).catch(() => {});

  // טעינת היסטוריה + context — שניהם non-fatal
  const [history, systemPrompt] = await Promise.all([
    _loadHistory(userId, businessId).catch(() => []),
    buildBusinessContext(businessId).catch(() => '# Business AI Advisor\nYou are a helpful business advisor. Answer in the language the user writes in.'),
  ]);

  // בניית מערך messages ל-Claude (היסטוריה + הודעה נוכחית)
  // סינון רצפים עם אותו role (Anthropic דורש סירוגין user/assistant)
  const rawMessages = [...history, { role: 'user', content: userMessage }];
  const messages = rawMessages.reduce((acc, msg) => {
    if (acc.length > 0 && acc[acc.length - 1].role === msg.role) {
      // דלג על הודעה כפולה — שמור רק את האחרונה
      acc[acc.length - 1] = msg;
    } else {
      acc.push(msg);
    }
    return acc;
  }, []);
  // חייב להתחיל ב-user
  while (messages.length > 0 && messages[0].role !== 'user') messages.shift();

  const sources   = [];
  const toolsUsed = [];

  // ── Claude call wrapper (used by orchestrator as fallback) ──
  const claudeCallFn = async (sysPrompt, msgs) => {
    const text = await _callClaude(sysPrompt, msgs, sources, toolsUsed, businessId);
    return { text, sources, toolsUsed };
  };

  let result;
  try {
    result = await orchestrator.route({
      message:       userMessage,
      systemPrompt,
      messages,
      claudeCallFn,
      businessId,
      userId,
      userRole:      role,
      historyLength: history.length,
    });
  } catch (err) {
    // אם Anthropic מחזיר 400 (היסטוריה פגומה) — נסה מחדש עם ההודעה בלבד
    if (err.status === 400) {
      await db.query(
        'DELETE FROM ai_conversations WHERE user_id = $1 AND business_id = $2',
        [userId, businessId]
      ).catch(() => {});
      _saveMessage(businessId, userId, 'user', userMessage).catch(() => {});
      try {
        result = await orchestrator.route({
          message:    userMessage,
          systemPrompt,
          messages:   [{ role: 'user', content: userMessage }],
          claudeCallFn,
          businessId,
          userId,
          userRole:   role,
          historyLength: 0,
        });
      } catch (retryErr) {
        logger.error('[AI] Retry after 400 also failed', { err: retryErr.message });
        return { response: 'אירעה שגיאה בשירות ה-AI — נסה שנית בעוד מספר שניות', sources: [], toolsUsed: [] };
      }
    } else {
      logger.error('[AI] Orchestrator error', { err: err.message, status: err.status });
      return { response: 'שירות ה-AI אינו זמין כרגע — נסה שנית בעוד מספר שניות', sources: [], toolsUsed: [] };
    }
  }

  const response = result.text;

  // שמירת תשובת ה-assistant — non-fatal
  _saveMessage(businessId, userId, 'assistant', response).catch(() => {});

  const finalResult = {
    response,
    sources:          result.sources   || sources,
    toolsUsed:        result.toolsUsed || toolsUsed,
    provider:         result.provider,
    routingScore:     result.score,
    fallbackTriggered: result.fallbackTriggered,
  };

  // שמור בcache רק כשאין כלים וגם השאלה לא נראית תלוית-נתונים (תשובות ידע
  // טהורות — לא תלויות בנתונים משתנים). "אין כלים" לבד לא מספיק: Groq/Gemini
  // אף פעם לא מקבלים גישה לכלים בכלל, אז שאלה על הכנסות/מלאי/שכר וכו' שהם
  // עונים עליה ישירות מה-snapshot הסטטי נראית זהה לשאלת ידע כללית — בלי
  // הבדיקה הזו, "מה ההכנסות היום?" היה נשמר לשעה ומוגש שוב מיושן גם אחרי
  // שנכנסו מכירות חדשות. History-influenced answers are also time-sensitive,
  // and there is no invalidation path for ai_advisor_generic keys on data
  // changes, so caching them would serve stale business data for up to an hour.
  const usedTools = result.toolsUsed || toolsUsed;
  if (usedTools.length === 0 && history.length === 0 && !looksDataDependent(userMessage)) {
    cache.set(_genericKey, finalResult, 3600).catch(() => {});
  }

  return finalResult;
}

// ── קריאה ל-Claude עם tool use ────────────────────────────────
async function _callClaude(systemPrompt, messages, sources, toolsUsed, businessId, depth = 0) {
  if (depth > 10) return 'אירעה שגיאה — ניסיונות חיפוש רבים מדי';

  const res = await createWithRetry(client, {
    model:      'claude-haiku-4-5',
    max_tokens: 2000,
    // Prompt caching — system prompt נשמר 5 דקות, חוסך ~87% מטוקני ה-context
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools:      TOOLS,
    messages,
  }, { context: { agent: 'aiAdvisor', businessId } });

  // בדיקה אם Claude רוצה להשתמש בכלי
  if (res.stop_reason === 'tool_use') {
    const toolUseBlocks = res.content.filter(b => b.type === 'tool_use');
    const toolResults   = [];

    for (const toolUse of toolUseBlocks) {
      // מעקב אחר כלים שהופעלו
      if (!toolsUsed.includes(toolUse.name)) toolsUsed.push(toolUse.name);

      let result;
      if (toolUse.name === 'web_search') {
        result = await _webSearch(toolUse.input.query, sources);
      } else if (toolUse.name === 'get_business_data') {
        result = await _getBusinessData(businessId, toolUse.input);
      }

      // result carries raw DB rows (dish/customer/supplier names etc. — free
      // text entered by any staff member or captured verbatim from OCR) back
      // into the conversation as trusted tool_result content the model acts
      // on in its next turn; sanitize it the same way any other untrusted
      // user-supplied input is sanitized before reaching a prompt.
      toolResults.push({
        type:        'tool_result',
        tool_use_id: toolUse.id,
        content:     JSON.stringify(sanitizeObject(result)),
      });
    }

    // המשך השיחה עם תוצאות הכלי
    const updatedMessages = [
      ...messages,
      { role: 'assistant', content: res.content },
      { role: 'user',      content: toolResults },
    ];

    return _callClaude(systemPrompt, updatedMessages, sources, toolsUsed, businessId, depth + 1);
  }

  // לוגינג טוקנים
  logTokenUsage({ businessId, feature: 'ai_advisor', model: 'claude-haiku-4-5', usage: res.usage });

  // תשובה סופית
  const textBlock = res.content.find(b => b.type === 'text');
  return textBlock?.text || 'לא הצלחתי לייצר תשובה';
}

// ── Web Search ────────────────────────────────────────────────
async function _webSearch(query, sources) {
  try {
    const SERP_KEY = process.env.SERP_API_KEY;
    if (!SERP_KEY) return { results: [], note: 'חיפוש אינטרנט לא מוגדר' };

    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&hl=iw&gl=il&api_key=${SERP_KEY}&num=5`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json();

    const results = (data.organic_results || []).slice(0, 4).map(r => ({
      title:   r.title,
      snippet: r.snippet,
      link:    r.link,
    }));

    // שמירת מקורות להצגה למשתמש
    sources.push(...results.map(r => ({ title: r.title, url: r.link })));

    return { query, results };
  } catch (err) {
    return { error: 'חיפוש נכשל', query };
  }
}

// ── Business Data Tool ────────────────────────────────────────
async function _getBusinessData(businessId, { dataType, identifier, days = 30, period1, period2 }) {
  try {
    const interval = `${Math.min(Math.max(parseInt(days) || 30, 1), 365)} days`;
    switch (dataType) {
      case 'recipe_profit': {
        // Forward-looking "which recipes are most profitable" — deleted
        // (is_active=false) recipes are excluded, same as chef-chat's own
        // recipe context.
        //
        // Cost comes from recipe_cost_source (utils/ingredientSource.js). The
        // previous version chose recipe_ingredients whenever the recipe had ANY
        // cost-bearing row (has_own_cost), and only fell back to the matching
        // dish otherwise — so a stale partial recipe with unlinked rows beat a
        // fully-linked dish, and an inflated margin went straight into the
        // LLM's answer with no caveat. That is worse than the cost=0 case the
        // old comment worried about, because the number looks plausible.
        const { rows } = await db.query(
          `WITH ${INGREDIENT_COST_CTE}
           SELECT r.name, r.selling_price::float AS selling_price,
                  COALESCE(co.cost_price, 0)::float AS cost,
                  (r.selling_price - COALESCE(co.cost_price, 0))::float AS profit
           FROM recipes r
           LEFT JOIN recipe_cost_source co ON co.recipe_id = r.id
           WHERE r.business_id = $1
             AND COALESCE(r.is_active, TRUE) = TRUE
             AND ($2::text IS NULL OR LOWER(r.name) LIKE LOWER('%' || $2 || '%'))
           ORDER BY profit DESC LIMIT 10`,
          [businessId, identifier || null]
        );
        return rows.map(r => {
          const warning = detectDataWarning({ name: r.name, selling_price: r.selling_price, cost_per_dish: r.cost });
          return warning ? { ...r, data_warning: warning } : r;
        });
      }

      case 'supplier_prices': {
        const { rows } = await db.query(
          `SELECT s.name AS supplier, ii.name AS item, it.unit_price, i.invoice_date
           FROM invoice_items it
           INNER JOIN invoices i    ON i.id = it.invoice_id
           INNER JOIN inventory_items ii ON ii.id = it.inventory_item_id
           INNER JOIN suppliers s   ON s.id = i.supplier_id
           WHERE i.business_id = $1
             AND ($2::text IS NULL OR LOWER(s.name) LIKE LOWER('%' || $2 || '%'))
           ORDER BY i.invoice_date DESC LIMIT 20`,
          [businessId, identifier || null]
        );
        return rows;
      }

      case 'employee_hours': {
        const { rows } = await db.query(
          `SELECT u.full_name,
                  u.salary_type,
                  u.salary_amount,
                  COALESCE(SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start))/3600), 0)::float AS hours,
                  CASE
                    WHEN u.salary_type IN ('global','monthly') THEN u.salary_amount
                    WHEN u.salary_type = 'hourly' THEN
                      u.salary_amount * COALESCE(SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start))/3600), 0)
                    ELSE 0
                  END AS estimated_cost
           FROM users u
           LEFT JOIN shifts sh
             ON sh.employee_id = u.id
             AND sh.business_id = $1
             AND sh.actual_start >= DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Jerusalem')
           WHERE u.business_id = $1
             AND u.is_active = TRUE
             AND ($2::text IS NULL OR LOWER(u.full_name) LIKE LOWER('%' || $2 || '%'))
           GROUP BY u.id, u.full_name, u.salary_type, u.salary_amount
           ORDER BY u.full_name`,
          [businessId, identifier || null]
        );
        return rows;
      }

      case 'inventory_detail': {
        const { rows } = await db.query(
          `SELECT name, current_qty, min_qty, unit, cost_per_unit
           FROM inventory_items
           WHERE business_id = $1
             AND ($2::text IS NULL OR LOWER(name) LIKE LOWER('%' || $2 || '%'))
           ORDER BY name LIMIT 20`,
          [businessId, identifier || null]
        );
        return rows;
      }

      case 'cashflow': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
           SELECT
             sale_day AS date,
             COALESCE(SUM(total_amount), 0)::float AS revenue,
             -- שורת POS בודדת = עסקה אחת; שורת Z-report = orders_count עסקאות
             -- (לא COUNT(*), אחרת יום עם דוח Z אחד נספר כ"עסקה אחת")
             COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END), 0)::int AS transactions
           FROM smart
           WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           GROUP BY sale_day ORDER BY sale_day DESC`,
          [businessId]
        );
        return rows;
      }

      case 'revenue_by_day': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
           filtered AS (
             SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           )
           SELECT
             TO_CHAR(sold_at AT TIME ZONE 'Asia/Jerusalem', 'Day') AS day_name,
             EXTRACT(DOW FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS day_num,
             COALESCE(AVG(daily_rev), 0)::float AS avg_revenue,
             COUNT(*)::int AS data_points
           FROM (
             SELECT
               sale_day AS day,
               EXTRACT(DOW FROM sold_at AT TIME ZONE 'Asia/Jerusalem') AS day_num,
               TO_CHAR(sold_at AT TIME ZONE 'Asia/Jerusalem', 'Day') AS day_name,
               SUM(total_amount) AS daily_rev
             FROM filtered
             GROUP BY sale_day, day_num, day_name
           ) daily
           GROUP BY day_name, day_num ORDER BY day_num`,
          [businessId]
        );
        return rows;
      }

      case 'top_customers': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
           SELECT
             COALESCE(customer_name, 'אנונימי') AS customer,
             COUNT(*)::int AS visits,
             COALESCE(SUM(total_amount), 0)::float AS total_spent,
             COALESCE(AVG(total_amount), 0)::float AS avg_order,
             MAX(sold_at)::date AS last_visit
           FROM smart
           WHERE (is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
             AND customer_name IS NOT NULL
           GROUP BY customer_name ORDER BY total_spent DESC LIMIT 15`,
          [businessId]
        );
        return rows;
      }

      case 'promotion_analysis': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
           SELECT
             sale_type,
             COUNT(*)::int AS count,
             COALESCE(SUM(total_amount), 0)::float AS revenue,
             COALESCE(AVG(total_amount), 0)::float AS avg_order,
             COALESCE(SUM(discount_amount), 0)::float AS total_discount
           FROM smart
           WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           GROUP BY sale_type ORDER BY revenue DESC`,
          [businessId]
        );
        return rows;
      }

      case 'supplier_invoices': {
        const { rows } = await db.query(
          `SELECT
             s.name AS supplier,
             COUNT(i.id)::int AS invoice_count,
             COALESCE(SUM(i.total_amount), 0)::float AS total_spent,
             COALESCE(AVG(i.total_amount), 0)::float AS avg_invoice,
             MAX(i.invoice_date)::date AS last_invoice,
             COUNT(*) FILTER (WHERE i.is_paid = FALSE)::int AS unpaid_count
           FROM invoices i
           INNER JOIN suppliers s ON s.id = i.supplier_id
           WHERE i.business_id = $1
             AND i.invoice_date >= NOW() - INTERVAL '${interval}'
             AND ($2::text IS NULL OR LOWER(s.name) LIKE LOWER('%' || $2 || '%'))
           GROUP BY s.name ORDER BY total_spent DESC LIMIT 10`,
          [businessId, identifier || null]
        );
        return rows;
      }

      case 'compare_periods': {
        const p1 = period1 || new Date().toISOString().slice(0, 7);
        const p2 = period2 || (() => {
          const d = new Date(); d.setMonth(d.getMonth() - 1);
          return d.toISOString().slice(0, 7);
        })();
        const [y1, m1] = p1.split('-').map(Number);
        const [y2, m2] = p2.split('-').map(Number);
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1
               AND (
                 (EXTRACT(YEAR FROM sold_at) = $2 AND EXTRACT(MONTH FROM sold_at) = $3)
                 OR
                 (EXTRACT(YEAR FROM sold_at) = $4 AND EXTRACT(MONTH FROM sold_at) = $5)
               )
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
           filtered AS (
             SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           )
           SELECT
             SUM(CASE WHEN EXTRACT(YEAR FROM sold_at)=$2 AND EXTRACT(MONTH FROM sold_at)=$3 THEN total_amount ELSE 0 END)::float AS period1_rev,
             -- שורת POS בודדת = הזמנה אחת; שורת Z-report = orders_count הזמנות
             -- (לא COUNT(*), אחרת חודש עם רק דוחות Z נספר כאילו יש בו הזמנה אחת ליום)
             SUM(CASE WHEN EXTRACT(YEAR FROM sold_at)=$2 AND EXTRACT(MONTH FROM sold_at)=$3
                      THEN (CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END) ELSE 0 END)::int AS period1_orders,
             SUM(CASE WHEN EXTRACT(YEAR FROM sold_at)=$4 AND EXTRACT(MONTH FROM sold_at)=$5 THEN total_amount ELSE 0 END)::float AS period2_rev,
             SUM(CASE WHEN EXTRACT(YEAR FROM sold_at)=$4 AND EXTRACT(MONTH FROM sold_at)=$5
                      THEN (CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END) ELSE 0 END)::int AS period2_orders
           FROM filtered`,
          [businessId, y1, m1, y2, m2]
        );
        const r = rows[0];
        const p1Orders = parseInt(r.period1_orders);
        const p2Orders = parseInt(r.period2_orders);
        return {
          period1: p1, period2: p2,
          period1_revenue: r.period1_rev, period1_orders: p1Orders, period1_avg_order: p1Orders > 0 ? r.period1_rev / p1Orders : null,
          period2_revenue: r.period2_rev, period2_orders: p2Orders, period2_avg_order: p2Orders > 0 ? r.period2_rev / p2Orders : null,
          revenue_change_pct: r.period2_rev > 0 ? ((r.period1_rev - r.period2_rev) / r.period2_rev * 100).toFixed(1) : 'N/A',
          orders_change_pct:  p2Orders > 0 ? ((p1Orders - p2Orders) / p2Orders * 100).toFixed(1) : 'N/A',
        };
      }

      case 'revenue_forecast': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
           filtered AS (
             SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           )
           SELECT
             DATE_TRUNC('week', sold_at AT TIME ZONE 'Asia/Jerusalem')::date AS week,
             COALESCE(SUM(total_amount), 0)::float AS revenue,
             -- שורת POS בודדת = הזמנה אחת; שורת Z-report = orders_count הזמנות
             COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count,0) END), 0)::int AS orders
           FROM filtered
           GROUP BY week ORDER BY week`,
          [businessId]
        );
        if (rows.length < 2) return { note: 'insufficient data for forecast', rows };
        const revenues = rows.map(r => parseFloat(r.revenue));
        const avg   = revenues.reduce((a, b) => a + b, 0) / revenues.length;
        const trend = revenues.length > 1
          ? (revenues[revenues.length - 1] - revenues[0]) / (revenues.length - 1)
          : 0;
        const next7  = Math.max(0, revenues[revenues.length - 1] + trend).toFixed(0);
        const next30 = Math.max(0, (avg + trend * 4) * 4).toFixed(0);
        return {
          historical_weeks: rows,
          weekly_avg: avg.toFixed(0),
          weekly_trend: trend.toFixed(0),
          forecast_next_7_days:  `₪${next7}`,
          forecast_next_30_days: `₪${next30}`,
          trend_direction: trend > 0 ? 'upward' : trend < 0 ? 'downward' : 'flat',
        };
      }

      case 'customer_retention': {
        const { rows } = await db.query(
          `WITH smart AS (
             SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                    (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
             FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
           ),
           ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
           filtered AS (
             SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
           )
           SELECT
             COUNT(DISTINCT customer_name) FILTER (WHERE customer_name IS NOT NULL) AS total_unique,
             COUNT(DISTINCT customer_name) FILTER (
               WHERE customer_name IS NOT NULL
               AND customer_name IN (
                 SELECT customer_name FROM sales
                 WHERE business_id = $1
                   AND sold_at < NOW() - INTERVAL '${interval}'
                   AND customer_name IS NOT NULL
               )
             ) AS returning_customers,
             COUNT(*) FILTER (WHERE customer_name IS NOT NULL) AS total_named_orders,
             COALESCE(AVG(total_amount) FILTER (WHERE customer_name IS NOT NULL), 0)::float AS avg_named_order
           FROM filtered`,
          [businessId]
        );
        const r = rows[0];
        const retention = r.total_unique > 0
          ? ((parseInt(r.returning_customers) / parseInt(r.total_unique)) * 100).toFixed(1)
          : '0';
        return {
          unique_customers: parseInt(r.total_unique),
          returning_customers: parseInt(r.returning_customers),
          retention_rate_pct: retention,
          new_customers: parseInt(r.total_unique) - parseInt(r.returning_customers),
          avg_order_named: r.avg_named_order,
          total_named_orders: parseInt(r.total_named_orders),
        };
      }

      case 'financial_breakdown': {
        const [sales, expenses, invoices] = await Promise.all([
          db.query(
            `WITH smart AS (
               SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                      (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
               FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '${interval}'
             ),
             ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
             filtered AS (
               SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
             )
             SELECT
               COALESCE(SUM(total_amount), 0)::float AS total_revenue,
               COALESCE(AVG(total_amount), 0)::float AS avg_order,
               COUNT(*)::int AS order_count,
               COALESCE(SUM(discount_amount), 0)::float AS total_discounts
             FROM filtered`,
            [businessId]
          ),
          db.query(
            // one_time is scoped to the CURRENT month (created_at) — without
            // this it fell to ELSE amount, counting it at full value in
            // every single financial_breakdown call forever, not just the
            // month it was logged (same bug class already fixed in
            // vat.service.js / cashflow.service.js this session).
            `SELECT category, SUM(CASE WHEN frequency='monthly'   THEN amount
                                       WHEN frequency='weekly'    THEN amount*(52.0/12)
                                       WHEN frequency='yearly'    THEN amount/12
                                       WHEN frequency='bimonthly' THEN amount/2
                                       WHEN frequency='one_time'
                                            AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE) THEN amount
                                       ELSE 0 END)::float AS monthly_cost
             FROM fixed_expenses WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}
             GROUP BY category ORDER BY monthly_cost DESC`,
            [businessId]
          ),
          db.query(
            `SELECT
               COALESCE(SUM(total_amount), 0)::float AS total_cogs,
               COUNT(*)::int AS invoice_count,
               COUNT(*) FILTER (WHERE is_paid = FALSE)::int AS unpaid_count
             FROM invoices WHERE business_id = $1 AND invoice_date >= NOW() - INTERVAL '${interval}'`,
            [businessId]
          ),
        ]);
        const rev  = parseFloat(sales.rows[0].total_revenue || 0);
        let   cogs = parseFloat(invoices.rows[0].total_cogs || 0);
        let   cogsIsEstimated = false;
        // No supplier invoices for the period → cogs=0 would make gross_margin_pct
        // read as a fake ~100%. Fall back to the theoretical ingredient-consumption
        // estimate, same priority order already used in survivalMode.agent.js /
        // finance.routes.js / cashflow.service.js.
        if ((invoices.rows[0]?.invoice_count || 0) === 0) {
          const periodDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);
          const toDateObj = new Date();
          const fromDateObj = new Date(Date.now() - periodDays * 86400000);
          const pad = (n) => String(n).padStart(2, '0');
          const fromDateStr = `${fromDateObj.getFullYear()}-${pad(fromDateObj.getMonth() + 1)}-${pad(fromDateObj.getDate())}`;
          const toDateStr   = `${toDateObj.getFullYear()}-${pad(toDateObj.getMonth() + 1)}-${pad(toDateObj.getDate())}`;
          const theo = await inventoryModel.getConsumptionAnalysis(businessId, fromDateStr, toDateStr)
            .catch(() => ({ totalConsumedValue: 0 }));
          if (theo.totalConsumedValue > 0) {
            cogs = theo.totalConsumedValue;
            cogsIsEstimated = true;
          }
        }
        const fixedTotal = expenses.rows.reduce((s, e) => s + parseFloat(e.monthly_cost || 0), 0);
        return {
          revenue: rev,
          cogs: cogs,
          cogs_is_estimated: cogsIsEstimated,
          gross_profit: (rev - cogs).toFixed(0),
          gross_margin_pct: rev > 0 ? ((1 - cogs / rev) * 100).toFixed(1) : '0',
          fixed_expenses_monthly: fixedTotal.toFixed(0),
          net_profit_estimate: (rev - cogs - fixedTotal).toFixed(0),
          expenses_by_category: expenses.rows,
          total_discounts: sales.rows[0].total_discounts,
          unpaid_invoices: invoices.rows[0].unpaid_count,
        };
      }

      default:
        return { error: `Unknown data type: ${dataType}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── היסטוריה פרטית עם context compression ─────────────────────
async function _loadHistory(userId, businessId, limit = 10) {
  const { rows } = await db.query(
    `SELECT role, content FROM ai_conversations
     WHERE user_id = $1 AND business_id = $2
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC LIMIT $3`,
    [userId, businessId, limit]
  );
  return rows.reverse().map(r => ({ role: r.role, content: _decrypt(r.content) }));
}

async function _saveMessage(businessId, userId, role, content) {
  await db.query(
    `INSERT INTO ai_conversations (business_id, user_id, role, content)
     VALUES ($1, $2, $3, $4)`,
    [businessId, userId, role, _encrypt(content)]
  );
  // Prune messages older than 7 days — stale history causes wrong answers
  db.query(
    `DELETE FROM ai_conversations
     WHERE user_id = $1 AND business_id = $2 AND created_at < NOW() - INTERVAL '7 days'`,
    [userId, businessId]
  ).catch(() => {});
}

// ── מחיקת היסטוריה ────────────────────────────────────────────
async function clearHistory(userId, businessId) {
  await db.query(
    'DELETE FROM ai_conversations WHERE user_id = $1 AND business_id = $2',
    [userId, businessId]
  );
}

// ── היסטוריה לתצוגה ───────────────────────────────────────────
async function getHistory(userId, businessId) {
  const { rows } = await db.query(
    `SELECT id, role, content, created_at
     FROM ai_conversations
     WHERE user_id = $1 AND business_id = $2
     ORDER BY created_at ASC
     LIMIT 100`,
    [userId, businessId]
  );
  return rows.map(r => ({ ...r, content: _decrypt(r.content) }));
}

module.exports = { chat, clearHistory, getHistory };
