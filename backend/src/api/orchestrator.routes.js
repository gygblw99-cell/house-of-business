const express    = require('express');
const router     = express.Router();
const logger     = require('../utils/logger');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { rateLimitAI } = require('../middleware/rateLimitAI');
const orchestrator    = require('../services/ai/aiOrchestrator.service');
const { score: computeScore } = require('../services/ai/scoringEngine');
const Anthropic       = require('@anthropic-ai/sdk');
const db              = require('../utils/db');
const { withTimeout } = require('../utils/withTimeout');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── POST /api/orchestrator/execute — run a task through the orchestrator ───────
router.post('/execute', requireAuth, requireOwner, rateLimitAI(), async (req, res) => {
  const { message, maxTokens } = req.body;
  // Array.isArray guard (not just `history = []` default) — a default
  // parameter only applies to `undefined`, not an explicit `null`, and
  // `null.map(...)` below would throw outside any try/catch. In an async
  // Express 4 handler that becomes an unhandled rejection, and index.js's
  // global unhandledRejection handler kills the whole process for every
  // tenant 5s later — so this must be validated before any other statement.
  const history = Array.isArray(req.body.history) ? req.body.history : [];
  if (!message?.trim()) return res.status(400).json({ error: 'message נדרש' });

  const system = 'You are a helpful AI assistant for a restaurant management platform. Respond in the same language as the user. Be concise and accurate.';

  const messages = [
    ...history
      .filter(m => m && typeof m === 'object')
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message.trim() },
  ];

  // Pre-classify so we can return routing decision synchronously
  const routing = computeScore({
    message,
    historyLength: history.length,
    userRole: req.user?.role || 'employee',
    recentGrokFails: 0,
  });

  try {
    const claudeCallFn = async (sys, msgs) => {
      const result = await withTimeout(
    anthropic.messages.create({
          model:      'claude-sonnet-5',
          max_tokens: Math.min(parseInt(maxTokens) || 1500, 4000),
          system:     sys,
          messages:   msgs,
        }),
    55000, "AI request");
      const text       = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const tokensUsed = (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
      const costUsd    = (result.usage?.input_tokens || 0) * 0.000003 + (result.usage?.output_tokens || 0) * 0.000015;
      return { text, tokensUsed, costUsd };
    };

    const result = await orchestrator.route({
      message,
      systemPrompt: system,
      messages,
      claudeCallFn,
      businessId:   req.user.businessId,
      userId:       req.user.userId,
      userRole:     req.user.role,
      historyLength: history.length,
      maxTokens: Math.min(parseInt(maxTokens) || 1500, 4000),
    });

    res.json({
      text:             result.text,
      provider:         result.provider,
      tier:             result.tier,
      score:            result.score,
      fallbackTriggered: result.fallbackTriggered,
      tokensUsed:       result.tokensUsed,
      costUsd:          result.costUsd,
      responseTimeMs:   result.responseTimeMs,
      routing: {
        score:     routing.total,
        breakdown: routing.breakdown,
        reason:    routing.reason,
      },
    });
  } catch (err) {
    logger.error('[Orchestrator Route] Error', { err: err.message });
    res.status(503).json({ error: 'שגיאה בהפעלת המנוע — נסה שנית' });
  }
});

// ── GET /api/orchestrator/stats — cost & routing summary ──────────────────────
router.get('/stats', requireAuth, requireOwner, async (req, res) => {
  try {
    const biz = req.user.businessId;
    const days = parseInt(req.query.days) || 30;

    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int                                                           AS total_requests,
         COALESCE(SUM(cost_usd), 0)                                             AS total_cost_usd,
         COUNT(*) FILTER (WHERE tier = 'free')::int                             AS free_count,
         COUNT(*) FILTER (WHERE tier = 'low_cost')::int                         AS low_cost_count,
         COUNT(*) FILTER (WHERE tier = 'mid_cost')::int                         AS mid_cost_count,
         COUNT(*) FILTER (WHERE tier = 'premium')::int                          AS premium_count,
         COUNT(*) FILTER (WHERE fallback_triggered)::int                        AS fallback_count,
         COALESCE(AVG(response_time_ms)::int, 0)                                AS avg_response_ms,
         COALESCE(AVG(score)::int, 0)                                           AS avg_score,
         COALESCE(SUM(tokens_used), 0)                                          AS total_tokens,
         -- Cost if everything had gone through Claude
         COALESCE(SUM(tokens_used) * 0.000009, 0)                              AS hypothetical_claude_cost
       FROM ai_logs
       WHERE business_id = $1
         AND created_at >= NOW() - ($2 * INTERVAL '1 day')`,
      [biz, days]
    );

    const s = rows[0];
    const saved = Math.max(0, parseFloat(s.hypothetical_claude_cost) - parseFloat(s.total_cost_usd));
    const freePercent = s.total_requests > 0 ? Math.round(s.free_count / s.total_requests * 100) : 0;

    res.json({
      totalRequests:      s.total_requests,
      totalCostUsd:       parseFloat(s.total_cost_usd).toFixed(6),
      costSavedUsd:       saved.toFixed(6),
      freeCount:          s.free_count,
      lowCostCount:       s.low_cost_count,
      midCostCount:       s.mid_cost_count,
      premiumCount:       s.premium_count,
      fallbackCount:      s.fallback_count,
      freePercent,
      avgResponseMs:      s.avg_response_ms,
      avgScore:           s.avg_score,
      totalTokens:        s.total_tokens,
      days,
    });
  } catch (err) {
    logger.error('[Orchestrator] stats error', { err: err.message });
    res.json({ totalRequests: 0, totalCostUsd: '0', costSavedUsd: '0', freeCount: 0, lowCostCount: 0, premiumCount: 0, fallbackCount: 0, freePercent: 0, avgResponseMs: 0, avgScore: 0, totalTokens: 0, days: 30 });
  }
});

// ── GET /api/orchestrator/logs — recent routing decisions ─────────────────────
router.get('/logs', requireAuth, requireOwner, async (req, res) => {
  try {
    const biz   = req.user.businessId;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const { rows } = await db.query(
      `SELECT id, request_type, provider_used, tier, score, tokens_used,
              cost_usd, response_time_ms, fallback_triggered, response, created_at
       FROM ai_logs
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [biz, limit]
    );

    res.json({ logs: rows });
  } catch (err) {
    res.json({ logs: [] });
  }
});

// ── GET /api/orchestrator/models — available models info ──────────────────────
router.get('/models', requireAuth, requireOwner, (_req, res) => {
  res.json({
    models: [
      {
        id:       'groq-llama-70b',
        name:     'Llama 3.3 70B',
        provider: 'Groq',
        tier:     'free',
        costPer1kTokens: 0,
        maxTokens: 32768,
        strengths: ['מהירות', 'עברית', 'קוד', 'שאלות בינוניות'],
        color:    '#10b981',
        icon:     '⚡',
      },
      {
        id:       'gemini-flash',
        name:     'Gemini 2.0 Flash',
        provider: 'Google',
        tier:     'low_cost',
        costPer1kTokens: 0.000075,
        maxTokens: 100000,
        strengths: ['הקשר ארוך', 'ניתוח עמוק', 'יצירתיות', 'כמעט חינם'],
        color:    '#3b82f6',
        icon:     '🔷',
      },
      {
        id:       'claude-haiku',
        name:     'Claude Haiku 4.5',
        provider: 'Anthropic',
        tier:     'mid_cost',
        // $1.00 per 1M input tokens. Was 0.0008 — the same 20% under-count that
        // MODEL_PRICES in logTokenUsage.js already corrected for Haiku.
        costPer1kTokens: 0.001,
        maxTokens: 200000,
        strengths: ['עברית', 'מדויק', 'מהיר', 'tier 2.5'],
        color:    '#f59e0b',
        icon:     '🔸',
      },
      {
        id:       'claude-sonnet',
        name:     'Claude Sonnet 5',
        provider: 'Anthropic',
        tier:     'premium',
        // Sonnet 5 replaced Sonnet 4.6 at a lower rate: $2/1M input (was $3)
        // and $10/1M output (was $15), with a 1M context window (was listed
        // here as 200K, which was wrong for 4.6 too).
        costPer1kTokens: 0.002,
        maxTokens: 1000000,
        strengths: ['איכות מקסימלית', 'ארכיטקטורה', 'היגיון מורכב', 'משימות קריטיות'],
        color:    '#8b5cf6',
        icon:     '👑',
      },
    ],
  });
});

module.exports = router;
