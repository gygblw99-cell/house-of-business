/**
 * Billing Scheduler — runs recurring PayPlus charges monthly.
 *
 * ecosystem.config.js has a PM2 cron_restart entry for scripts/charge_recurring.js
 * ('0 8 1 * *'), but Railway runs `node src/index.js` directly with no PM2, so
 * that cron entry never fires there. This runs the same logic in-process
 * instead — checked daily at 08:00 Israel time, only acts on the 1st of the
 * month — following the same setTimeout scheduler pattern already used by
 * guardian.scheduler.js / payslip.service.js / standingOrder.scheduler.js.
 */

const logger = require('../../utils/logger');
const { runRecurringCharges } = require('./recurringCharge.service');
const { locked } = require('../../utils/jobLock');

// Locked: the single highest-stakes scheduled job here. Two replicas firing it
// on the 1st of the month would bill every customer twice.
const _runRecurringChargesLocked = locked('recurring-charges', runRecurringCharges);

const TARGET_HOUR = 8;

// Returns ms until the next 08:00 **Asia/Jerusalem** (DST-aware). Same
// technique as standingOrder.scheduler.js's _msUntilIsraelHour — a naive
// setHours(8,0,0,0) runs in the server's local time (UTC on Railway, no TZ
// env var set), which would fire the check around 10/11 AM Israel time.
function _msUntilIsraelHour(targetHour) {
  const nowMs = Date.now();

  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get    = (t) => ilParts.find(p => p.type === t)?.value;
  const ilHour = parseInt(get('hour')   ?? '0', 10);
  const ilMin  = parseInt(get('minute') ?? '0', 10);

  const daysToAdd = ilHour >= targetHour ? 1 : 0;

  const ilDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(nowMs));
  const [iy, im, id] = ilDateStr.split('-').map(Number);
  const targetMidnightUtc = Date.UTC(iy, im - 1, id + daysToAdd);

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

function _scheduleNext() {
  const delay   = _msUntilIsraelHour(TARGET_HOUR);
  const nextRun = new Date(Date.now() + delay);
  logger.info(`[Billing Scheduler] Next check: ${nextRun.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);

  setTimeout(async () => {
    try {
      const ilDateStr  = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
      const dayOfMonth = parseInt(ilDateStr.split('-')[2], 10);
      if (dayOfMonth === 1) {
        logger.info('[Billing Scheduler] 1st of month — running recurring charges');
        await _runRecurringChargesLocked();
      }
    } catch (err) {
      logger.error('[Billing Scheduler] run failed', { err: err.message });
    }
    _scheduleNext();
  }, delay).unref();
}

function startBillingScheduler() {
  _scheduleNext();
  logger.info('[Billing Scheduler] Active — checks daily at 08:00 Israel time, charges run on the 1st of the month');
}

module.exports = { startBillingScheduler };
