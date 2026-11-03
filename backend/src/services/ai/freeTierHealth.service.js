'use strict';

/**
 * Is the free AI tier actually serving anything?
 *
 * Groq was pinned to llama-3.3-70b-versatile. That model was retired from the
 * account, so every call returned 404 and the platform fell through to Gemini or
 * Claude — correct behaviour, and completely silent. The only trace was a log
 * line per call. It went unnoticed until the Anthropic credit ran out.
 *
 * Nothing new has to be measured to catch that. ai_usage_logs already records
 * the model and the cost of every call, so a dead free tier is unmistakable in
 * data the platform has been collecting all along: its share of traffic goes to
 * zero while the paid spend carries the whole load.
 *
 * Reading the logs rather than probing the provider is deliberate. A probe
 * against /v1/models would only catch a model being retired; this catches every
 * cause — retirement, an exhausted quota, a revoked key, sustained rate limits —
 * and adds no outbound call of its own.
 *
 * ── Which table, and why it matters ────────────────────────────────────────
 *
 * There are two AI log tables and only one of them is live. ai_logs (written by
 * aiOrchestrator's batched _logQueue) holds a single row, last written in May;
 * ai_usage_logs (written by utils/logTokenUsage on every agent call) holds 763
 * and is current. An earlier version of this check queried ai_logs and would
 * therefore have reported 'insufficient_data' forever — a health check that
 * could never detect the thing it exists for.
 *
 * ai_logs.tier does not even exist on this database: it is declared in a
 * CREATE TABLE IF NOT EXISTS, which is a no-op where the table already exists.
 */

const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { MODEL_PRICES } = require('../../utils/logTokenUsage');

/**
 * A model is free when its published rate is zero on both sides.
 *
 * Deriving this from MODEL_PRICES rather than hard-coding provider names means a
 * future free provider is classified correctly the moment it is priced, and a
 * provider that stops being free stops counting as free.
 */
function isFreeModel(model) {
  const p = MODEL_PRICES[model];
  return Boolean(p) && p.input === 0 && p.output === 0;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.windowHours=168] How far back to look. A week by
 *        default: AI traffic here is tens of calls a day, so 24h is often below
 *        the significance floor and would just report insufficient_data.
 * @param {number} [opts.minCalls=20]     Below this the window says nothing.
 */
async function checkFreeTierHealth({ windowHours = 168, minCalls = 20 } = {}) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT COALESCE(model, 'unknown')      AS model,
              COUNT(*)::int                   AS calls,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd
         FROM ai_usage_logs
        WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
        GROUP BY COALESCE(model, 'unknown')
        ORDER BY calls DESC`,
      [windowHours],
    ));
  } catch (err) {
    logger.error('[FreeTierHealth] query failed', { err: err.message });
    return _unknown(windowHours, 'לא ניתן לקרוא את יומן השימוש ב-AI');
  }

  const byModel = {};
  let totalCalls = 0, freeCalls = 0, paidCostUsd = 0;
  for (const r of rows) {
    const free = isFreeModel(r.model);
    byModel[r.model] = { calls: r.calls, costUsd: r.cost_usd, free };
    totalCalls += r.calls;
    if (free) freeCalls += r.calls;
    else paidCostUsd += r.cost_usd;
  }

  if (totalCalls < minCalls) {
    return {
      ..._base(windowHours, byModel, totalCalls, freeCalls, paidCostUsd),
      verdict: 'insufficient_data',
      reason: `רק ${totalCalls} קריאות AI ב-${windowHours} השעות האחרונות — מעט מדי כדי להסיק משהו.`,
    };
  }

  const freeShare = freeCalls / totalCalls;

  // Spend is the window's rate extended to 30 days — an indication of scale,
  // not a forecast. AI traffic here is not uniform.
  const estimatedMonthlyCostUsd = Math.round((paidCostUsd / windowHours) * 24 * 30 * 100) / 100;

  let verdict, reason;
  if (freeCalls === 0) {
    verdict = 'dead';
    reason = `השכבה החינמית לא שירתה אף קריאה מתוך ${totalCalls} ב-${windowHours} השעות האחרונות — היא מושבתת, וכל בקשה נופלת לספק בתשלום (כ-$${estimatedMonthlyCostUsd} לחודש בקצב הזה).`;
  } else if (freeShare < 0.1) {
    verdict = 'degraded';
    reason = `השכבה החינמית שירתה רק ${freeCalls} מתוך ${totalCalls} קריאות (${Math.round(freeShare * 100)}%) — כמעט הכל נופל לספק בתשלום.`;
  } else {
    verdict = 'healthy';
    reason = `השכבה החינמית שירתה ${freeCalls} מתוך ${totalCalls} קריאות (${Math.round(freeShare * 100)}%).`;
  }

  return {
    ..._base(windowHours, byModel, totalCalls, freeCalls, paidCostUsd),
    freeShare: Math.round(freeShare * 1000) / 1000,
    estimatedMonthlyCostUsd,
    verdict,
    reason,
  };
}

function _base(windowHours, byModel, totalCalls, freeCalls, paidCostUsd) {
  return {
    windowHours,
    byModel,
    totalCalls,
    freeCalls,
    paidCostUsd: Math.round(paidCostUsd * 10000) / 10000,
  };
}

function _unknown(windowHours, reason) {
  return {
    windowHours, byModel: {}, totalCalls: null, freeCalls: null,
    paidCostUsd: null, freeShare: null, estimatedMonthlyCostUsd: null,
    verdict: 'unknown', reason,
  };
}

/**
 * Guardian adapter: an incident-shaped object when the free tier is not serving,
 * or null when there is nothing to report.
 *
 * 'dead' is high rather than critical — nothing is broken for the owner, the
 * platform is just paying for what it should not have to. It still mails the
 * admin, which is the whole point: this failure had no reader before.
 */
async function getFreeTierIncident(opts) {
  const health = await checkFreeTierHealth(opts);
  if (health.verdict !== 'dead' && health.verdict !== 'degraded') return null;

  return {
    severity: health.verdict === 'dead' ? 'high' : 'medium',
    feature:  'ai_free_tier',
    summary:  health.verdict === 'dead'
      ? 'שכבת ה-AI החינמית מושבתת — כל בקשה נופלת לספק בתשלום'
      : 'שכבת ה-AI החינמית כמעט לא משרתת בקשות',
    details: health.reason,
    health,
  };
}

module.exports = { checkFreeTierHealth, getFreeTierIncident, isFreeModel };
