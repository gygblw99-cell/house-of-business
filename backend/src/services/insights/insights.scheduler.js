/**
 * AI Auto-Insights Scheduler
 * מריץ ניתוח תובנות לכל העסקים בכל יום בשעה 07:00
 */

const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { generateInsights, storeInsights } = require('../../agents/autoInsights.agent');
const { ACTIVE_BUSINESS_SQL } = require('../../utils/activeBusiness');
const { locked } = require('../../utils/jobLock');
const { withTimeout } = require('../../utils/withTimeout');

function startInsightsScheduler() {
  _scheduleDaily7am();
  logger.info('[Insights Scheduler] פעיל — תובנות AI נוצרות כל יום ב-07:00');
}

function _scheduleDaily7am() {
  const now   = new Date();
  const next7 = new Date();
  next7.setHours(7, 0, 0, 0);
  if (now >= next7) next7.setDate(next7.getDate() + 1);

  const ms = next7.getTime() - now.getTime();

  setTimeout(() => {
    _runAllInsightsLocked().catch(err => logger.error('[Insights Scheduler] First run failed', { err: err.message }));
    setInterval(
      () => _runAllInsightsLocked().catch(err => logger.error('[Insights Scheduler] Scheduled run failed', { err: err.message })),
      24 * 60 * 60 * 1000
    ).unref();
  }, ms);

  logger.info(`[Insights Scheduler] ריצה ראשונה בעוד ${Math.round(ms / 60000)} דקות`);
}

const CONCURRENCY   = 3;
const AGENT_TIMEOUT = 15_000;
const MAX_ATTEMPTS  = 2; // 1 initial + 1 retry with backoff

async function _runWithRetry(businessId) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const insights = await withTimeout(
    generateInsights(businessId),
    AGENT_TIMEOUT, "agent");
      await storeInsights(businessId, insights);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000)); // 2s, 4s...
    }
  }
}

async function _runAllInsights() {
  logger.info('[Insights Scheduler] מייצר תובנות לכל העסקים...');

  const { rows } = await db.query(
    `SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL} ORDER BY id`
  );

  let success = 0;
  let failed  = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch   = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(({ id }) => _runWithRetry(id))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') success++;
      else { failed++; logger.error('[Insights Scheduler] נכשל אחרי retry', { err: r.reason?.message }); }
    });
  }

  logger.info(`[Insights Scheduler] הושלם — ${success} הצלחות, ${failed} כישלונות`);
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runAllInsightsLocked = locked('insights', _runAllInsights);
module.exports = { startInsightsScheduler };
