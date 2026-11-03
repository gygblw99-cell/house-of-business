/**
 * DB Connection Watchdog
 *
 * db.query() already retries transient errors (ECONNRESET/ENOTFOUND/etc,
 * 400ms/800ms backoff) — that's the right amount of resilience for a
 * few-second network blip. It cannot and shouldn't try to survive a genuinely
 * sustained outage (observed once in practice: a ~56-minute local DNS/network
 * failure, likely the machine going to sleep) — nothing queued behind those
 * retries would be safe to keep retrying indefinitely, and per-request retry
 * logic has no way to notice "we've been broken for an hour."
 *
 * This runs a cheap, independent health check on its own timer. On a
 * sustained run of failures it exits the process — matching this file's
 * existing crash-guard philosophy in index.js (log, then let PM2 restart
 * clean) — rather than leaving the server silently unable to serve any
 * DB-backed request until someone happens to restart it manually.
 */
const db     = require('../utils/db');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS      = 60 * 1000;      // check every minute
const MAX_CONSECUTIVE_FAILURES = 5;            // ~5 minutes unreachable → restart

let _timer = null;
let _consecutiveFailures = 0;

async function _check() {
  try {
    await db.query('SELECT 1');
    if (_consecutiveFailures > 0) {
      logger.info('[DB Watchdog] connection recovered', { afterFailures: _consecutiveFailures });
    }
    _consecutiveFailures = 0;
  } catch (err) {
    _consecutiveFailures++;
    logger.warn('[DB Watchdog] health check failed', {
      consecutiveFailures: _consecutiveFailures,
      max: MAX_CONSECUTIVE_FAILURES,
      err: err.message,
    });
    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.error(`[DB Watchdog] DB unreachable for ${MAX_CONSECUTIVE_FAILURES} consecutive checks — exiting so PM2 restarts the process`);
      process.exit(1);
    }
  }
}

function startDbWatchdog() {
  if (_timer) return;
  _timer = setInterval(_check, CHECK_INTERVAL_MS);
  _timer.unref(); // don't keep the process alive on its own
  logger.info(`[DB Watchdog] started — checking every ${CHECK_INTERVAL_MS / 1000}s, restarts after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
}

module.exports = { startDbWatchdog };
