/**
 * AI Orchestrator Service — 3-Tier Intelligent Routing
 *
 * TIER 1 — FREE    : Groq  Llama 3.3 70B  (score ≤ 35)
 * TIER 2 — CHEAP   : Gemini 2.0 Flash      (score 36–60, or Groq quality poor)
 * TIER 3 — PREMIUM : Claude Sonnet 4.6     (score > 60, or Gemini quality poor)
 *
 * Flow:
 *   score request
 *     → score ≤ 35         → Groq only
 *     → score 36–60        → Groq → validate → Gemini if poor
 *     → score > 60         → Gemini → validate → Claude if poor
 *     → tool use detected  → Claude directly
 */

const { score: computeScore, likelyNeedsTools } = require('./scoringEngine');
const grokService                               = require('./grokService');
const geminiService                             = require('./geminiService');
const { validate }                              = require('./responseValidator');
const db                                        = require('../../utils/db');
const logger                                    = require('../../utils/logger');
const Anthropic                                 = require('@anthropic-ai/sdk');
const { withTimeout } = require('../../utils/withTimeout');

const _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Auto-create ai_logs table ─────────────────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS ai_logs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        UUID,
    user_id            UUID,
    request_type       TEXT    DEFAULT 'chat',
    tokens_used        INTEGER DEFAULT 0,
    response           TEXT,
    provider_used      TEXT,
    score              INTEGER DEFAULT 0,
    cost_usd           NUMERIC(12,8) DEFAULT 0,
    response_time_ms   INTEGER DEFAULT 0,
    fallback_triggered BOOLEAN DEFAULT FALSE,
    tier               TEXT    DEFAULT 'free',
    created_at         TIMESTAMPTZ DEFAULT NOW()
  )
`);

// ── Groq failure tracker (in-memory, 1-hour TTL) ──────────────────────────────
const _failures = new Map();
const FAIL_TTL  = 60 * 60 * 1000;

function _failCount(businessId, userId) {
  const e = _failures.get(`${businessId}:${userId}`);
  return (!e || Date.now() > e.exp) ? 0 : e.count;
}
function _incFail(businessId, userId) {
  const key = `${businessId}:${userId}`;
  _failures.set(key, { count: _failCount(businessId, userId) + 1, exp: Date.now() + FAIL_TTL });
  if (_failures.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _failures) { if (now > v.exp) _failures.delete(k); }
    // If still > 10k after pruning expired entries, clear all — DDoS safety valve
    if (_failures.size > 10_000) _failures.clear();
  }
}
function _resetFail(businessId, userId) { _failures.delete(`${businessId}:${userId}`); }

// ── AI log batch queue — adaptive flush (size OR time, whichever comes first) ─
const _logQueue    = [];
const LOG_BATCH    = 50;    // flush early when this many entries accumulate
const LOG_FLUSH_MS = 5000;  // also flush every 5 seconds
let   _lastFlushSize = 0;   // track queue size at last flush to avoid empty ticks

async function _flushLogQueue() {
  // Adaptive: skip if queue hasn't grown since last flush
  if (_logQueue.length === 0 || _logQueue.length === _lastFlushSize) return;
  _lastFlushSize = 0;
  const batch = _logQueue.splice(0, _logQueue.length);
  try {
    const placeholders = batch.map((_, i) => {
      const base = i * 11;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
    }).join(',');
    const values = batch.flatMap(r => [
      r.businessId, r.userId, r.requestType, r.tokensUsed, r.response, r.providerUsed, r.score, r.costUsd, r.responseTimeMs, r.fallbackTriggered, r.tier,
    ]);
    await db.query(
      `INSERT INTO ai_logs (business_id, user_id, request_type, tokens_used, response, provider_used, score, cost_usd, response_time_ms, fallback_triggered, tier) VALUES ${placeholders}`,
      values
    );
  } catch (err) {
    logger.error('[Orchestrator] Log batch error', { err: err.message });
  }
}

setInterval(_flushLogQueue, LOG_FLUSH_MS).unref(); // .unref() so it doesn't block process exit

function _log(params) {
  const { businessId, userId, requestType = 'chat', providerUsed, score, tokensUsed = 0, costUsd = 0, responseTimeMs = 0, fallbackTriggered = false, response = '', tier = 'free' } = params;
  _logQueue.push({ businessId, userId, requestType, tokensUsed, response: String(response).slice(0, 500), providerUsed, score, costUsd, responseTimeMs, fallbackTriggered, tier });
  if (_logQueue.length >= LOG_BATCH) _flushLogQueue().catch(() => {}); // flush early, fire-and-forget
}

// ── Tier callers ──────────────────────────────────────────────────────────────
async function _callGroq(systemPrompt, messages, maxTokens) {
  return grokService.chat(systemPrompt, messages, { maxTokens: maxTokens || 1500 });
}

async function _callGemini(systemPrompt, messages, maxTokens) {
  return geminiService.chat(systemPrompt, messages, { maxTokens: maxTokens || 1500 });
}

async function _callClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered }) {
  const start  = Date.now();
  const result = await claudeCallFn(systemPrompt, messages);
  const ms     = Date.now() - start;
  const text   = typeof result === 'string' ? result : result.text;

  await _log({ businessId, userId, providerUsed: 'claude', score: routingScore, tokensUsed: result.tokensUsed || 0, costUsd: result.costUsd || 0, responseTimeMs: ms, fallbackTriggered, tier: 'premium', response: text });
  return { text, provider: 'claude', tier: 'premium', score: routingScore, fallbackTriggered, tokensUsed: result.tokensUsed || 0, costUsd: result.costUsd || 0, responseTimeMs: ms };
}

async function _callHaiku({ systemPrompt, messages, businessId, userId, routingScore, fallbackTriggered, maxTokens }) {
  const start = Date.now();
  const result = await withTimeout(
    _anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: Math.min(maxTokens || 1500, 4000),
      system:     systemPrompt,
      messages,
    }),
    30000, "Haiku");
  const ms         = Date.now() - start;
  const text       = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const tokensUsed = (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
  const costUsd    = (result.usage?.input_tokens || 0) * 0.0000008 + (result.usage?.output_tokens || 0) * 0.000004;
  await _log({ businessId, userId, providerUsed: 'haiku', score: routingScore, tokensUsed, costUsd, responseTimeMs: ms, fallbackTriggered, tier: 'mid_cost', response: text });
  return { text, provider: 'haiku', tier: 'mid_cost', score: routingScore, fallbackTriggered, tokensUsed, costUsd, responseTimeMs: ms };
}

async function _tryHaikuThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered, maxTokens }) {
  try {
    const haiku   = await _callHaiku({ systemPrompt, messages, businessId, userId, routingScore, fallbackTriggered, maxTokens });
    const userMsg = messages[messages.length - 1]?.content || '';
    const v       = validate(haiku.text, userMsg);
    if (v.acceptable) return haiku;
    logger.warn('[Orchestrator] Haiku quality poor → Sonnet');
  } catch (err) {
    logger.warn('[Orchestrator] Haiku failed → Sonnet', { err: err.message });
  }
  return _callClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered: true });
}

async function _tryGeminiThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, breakdown, reason, fallbackTriggered, skipValidation = false, maxTokens }) {
  try {
    const gem = await _callGemini(systemPrompt, messages, maxTokens);
    const userMsg = messages[messages.length - 1]?.content || '';

    if (!skipValidation) {
      const v = validate(gem.text, userMsg);
      if (!v.acceptable) {
        logger.warn('[Orchestrator] Gemini quality poor → escalate Haiku');
        return _tryHaikuThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered: true, maxTokens });
      }
    }

    await _log({ businessId, userId, providerUsed: 'gemini', score: routingScore, tokensUsed: gem.tokensUsed, costUsd: gem.costUsd, responseTimeMs: gem.responseTimeMs, fallbackTriggered, tier: 'low_cost', response: gem.text });
    return { text: gem.text, provider: 'gemini', tier: 'low_cost', score: routingScore, fallbackTriggered, tokensUsed: gem.tokensUsed, costUsd: gem.costUsd, responseTimeMs: gem.responseTimeMs, routing: { breakdown, reason } };
  } catch (err) {
    logger.warn('[Orchestrator] Gemini failed → escalate Haiku', { err: err.message });
    return _tryHaikuThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered: true, maxTokens });
  }
}

// ── Main router ───────────────────────────────────────────────────────────────
async function route(params) {
  const { message, systemPrompt, messages, claudeCallFn, businessId, userId, userRole = 'employee', historyLength = 0, maxTokens } = params;

  const recentFails = _failCount(businessId, userId);
  const routing     = computeScore({ message, historyLength, userRole, recentGrokFails: recentFails });
  const { total: routingScore, provider, reason, breakdown } = routing;

  logger.info(`[Orchestrator] score=${routingScore} tier=${routingScore <= 35 ? 'free' : routingScore <= 60 ? 'low_cost' : 'premium'} reason=${reason}`);

  // Tool use → Claude directly
  if (likelyNeedsTools(message)) {
    return _callClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, fallbackTriggered: false });
  }

  // ── TIER 1: Groq free (score ≤ 35) ───────────────────────────────────────
  if (routingScore <= 35) {
    try {
      const g = await _callGroq(systemPrompt, messages, maxTokens);
      const v = validate(g.text, message);
      if (v.acceptable) {
        _resetFail(businessId, userId);
        await _log({ businessId, userId, providerUsed: 'groq', score: routingScore, tokensUsed: g.tokensUsed, costUsd: g.costUsd, responseTimeMs: g.responseTimeMs, fallbackTriggered: false, tier: 'free', response: g.text });
        return { text: g.text, provider: 'groq', tier: 'free', score: routingScore, fallbackTriggered: false, tokensUsed: g.tokensUsed, costUsd: g.costUsd, responseTimeMs: g.responseTimeMs, routing: { breakdown, reason } };
      }
      _incFail(businessId, userId);
      logger.warn('[Orchestrator] Groq quality poor → Gemini');
    } catch (err) {
      _incFail(businessId, userId);
      logger.warn('[Orchestrator] Groq Tier1 error → Gemini', { err: err.message });
    }
    return _tryGeminiThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, breakdown, reason, fallbackTriggered: true, maxTokens });
  }

  // ── TIER 2: Groq → Gemini (score 36–60) ──────────────────────────────────
  if (routingScore <= 60) {
    try {
      const g = await _callGroq(systemPrompt, messages, maxTokens);
      const v = validate(g.text, message);
      if (v.acceptable) {
        _resetFail(businessId, userId);
        await _log({ businessId, userId, providerUsed: 'groq', score: routingScore, tokensUsed: g.tokensUsed, costUsd: g.costUsd, responseTimeMs: g.responseTimeMs, fallbackTriggered: false, tier: 'free', response: g.text });
        return { text: g.text, provider: 'groq', tier: 'free', score: routingScore, fallbackTriggered: false, tokensUsed: g.tokensUsed, costUsd: g.costUsd, responseTimeMs: g.responseTimeMs, routing: { breakdown, reason } };
      }
      _incFail(businessId, userId);
    } catch (err) {
      _incFail(businessId, userId);
    }
    return _tryGeminiThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, breakdown, reason, fallbackTriggered: true, maxTokens });
  }

  // ── TIER 3: Gemini → Claude (score > 60) ─────────────────────────────────
  return _tryGeminiThenClaude({ systemPrompt, messages, claudeCallFn, businessId, userId, routingScore, breakdown, reason, fallbackTriggered: false, maxTokens });
}

module.exports = { route };
