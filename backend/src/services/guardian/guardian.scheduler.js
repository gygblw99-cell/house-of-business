/**
 * Guardian AI Scheduler
 * Runs a platform stability scan every 30 minutes.
 * Follows the same setTimeout/setInterval pattern as other schedulers.
 */

const logger = require('../../utils/logger');
const { runGuardianScan, ensureTables } = require('./guardian.service');
const { locked } = require('../../utils/jobLock');

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function runAllScans() {
  try {
    await runGuardianScan();
  } catch (err) {
    // A raw string in the metadata position is silently dropped by Winston's
    // JSON formatter (production) — this made every scan failure invisible
    // in the logs with no error detail. Use the { err } convention used
    // everywhere else in this codebase instead.
    logger.error('[Guardian Scheduler] Scan failed', { err: err.message, stack: err.stack });
  }
}

async function startGuardianScheduler() {
  // Ensure DB tables exist before first run
  try {
    await ensureTables();
    logger.info('[Guardian Scheduler] Tables ready');
  } catch (err) {
    logger.error(`[Guardian Scheduler] Table init failed: ${err.message}`);
    return;
  }

  // First run: 60 seconds after startup (give services time to start).
  // Locked like the interval below — startup is precisely when two replicas are
  // both coming up and would both fire this, so the first run needs the lock
  // more than any later one does.
  setTimeout(async () => {
    await _runAllScansLocked();
    // Then every 30 minutes
    setInterval(_runAllScansLocked, INTERVAL_MS).unref();
    logger.info('[Guardian Scheduler] Active — scanning every 30 minutes');
  }, 60 * 1000);

  logger.info('[Guardian Scheduler] First scan in 60 seconds');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runAllScansLocked = locked('guardian-scan', runAllScans);
module.exports = { startGuardianScheduler };
