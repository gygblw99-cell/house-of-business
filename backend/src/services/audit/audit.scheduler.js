/**
 * Audit Scheduler
 * מריץ ביקורת עסקית לכל העסקים המחוברים בכל יום בשעה 22:00 (שעון ישראל)
 */

const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { runAudit } = require('../../agents/businessAudit.agent');
const { ACTIVE_BUSINESS_SQL } = require('../../utils/activeBusiness');
const { locked } = require('../../utils/jobLock');

const TARGET_HOUR = 22;

// ── startScheduler ────────────────────────────────────────────
function startScheduler() {
  scheduleNext();
  logger.info('[Audit Scheduler] פעיל — ביקורת עסקית רצה בכל יום ב-22:00 שעון ישראל');
}

// Returns ms until the next 22:00 **Asia/Jerusalem** (DST-aware). The previous
// version used new Date().setHours(22,0,0,0), which runs in the server's
// local time (UTC on Railway — no TZ env var set anywhere), so the "daily
// 22:00" audit was actually firing at 00:00/01:00 Israel time, not 22:00 as
// the log message claimed. Same fix pattern as weeklyReport.scheduler.js's
// msUntilSunday8am(), generalized to any target hour without a day-of-week
// component.
function msUntilIsraelHour(targetHour) {
  const nowMs = Date.now();

  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get    = (t) => ilParts.find(p => p.type === t)?.value;
  const ilHour = parseInt(get('hour')   ?? '0', 10);
  const ilMin  = parseInt(get('minute') ?? '0', 10);

  // Already past today's target hour in Israel — schedule for tomorrow
  // >= not >: at exactly the target hour (ilMin=0), delay would be 0 or negative
  // causing an immediate-retry storm; schedule tomorrow when at or past the target.
  const daysToAdd = ilHour >= targetHour ? 1 : 0;

  // Israel current date as "YYYY-MM-DD" (en-CA locale format)
  const ilDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(nowMs));
  const [iy, im, id] = ilDateStr.split('-').map(Number);

  // Midnight UTC on the target Israel calendar date
  const targetMidnightUtc = Date.UTC(iy, im - 1, id + daysToAdd);

  // Find exact UTC ms where the Israel clock = targetHour (Israel is UTC+2 or UTC+3)
  const ilHourAt = (ms) => parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false })
      .formatToParts(new Date(ms)).find(p => p.type === 'hour')?.value ?? '0', 10
  );
  for (const offsetH of [2, 3]) {
    const candidate = targetMidnightUtc + (targetHour - offsetH) * 3600_000;
    if (ilHourAt(candidate) === targetHour) return candidate - nowMs;
  }
  return targetMidnightUtc + (targetHour - 2) * 3600_000 - nowMs; // UTC+2 fallback
}

function scheduleNext() {
  const delay    = msUntilIsraelHour(TARGET_HOUR);
  const nextRun  = new Date(Date.now() + delay);
  logger.info(`[Audit Scheduler] ריצה הבאה: ${nextRun.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  setTimeout(() => {
    _runAllAuditsLocked()
      .catch(err => logger.error('[Audit Scheduler] Scheduled run failed', { err: err.message }))
      .finally(scheduleNext);
  }, delay);
}

// ── runAllAudits ──────────────────────────────────────────────
async function runAllAudits() {
  logger.info('[Audit Scheduler] מריץ ביקורת עסקית לכל העסקים...');

  // Not scoped to businesses with a connected POS: runAudit() already gates
  // on hasEnoughData() internally (works off the sales table regardless of
  // whether it was populated via POS sync or Z-report import), so requiring
  // a live pos_connections row here silently skipped every Z-report-only
  // business from ever getting an automatic nightly audit.
  const { rows } = await db.query(
    `SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL}`
  );

  let success = 0;
  let failed  = 0;

  for (const { id } of rows) {
    try {
      await runAudit(id);
      success++;
    } catch (err) {
      failed++;
      logger.error('[Audit Scheduler] נכשל', { id, err: err.message });
    }
  }

  logger.info(`[Audit Scheduler] הושלם — ${success} הצלחות, ${failed} כישלונות`);
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runAllAuditsLocked = locked('business-audit', runAllAudits);
module.exports = { startScheduler, runAllAudits };
