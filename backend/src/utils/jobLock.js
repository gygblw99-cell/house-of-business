'use strict';

/**
 * Cross-process mutual exclusion for scheduled jobs.
 *
 * Every scheduler in this codebase runs inside the API process on a plain
 * setTimeout/setInterval with no coordination. That is correct for exactly one
 * replica. The moment a second one starts — to absorb load, or during a rolling
 * deploy where old and new overlap — every job fires twice: two auto-suspend
 * passes over the same overdue businesses, two copies of every scheduled email,
 * and double the Anthropic spend on the nightly AI work.
 *
 * A Postgres advisory lock is the cheapest fix that needs no new infrastructure:
 * the database the replicas already share becomes the arbiter. Whoever takes the
 * lock runs; everyone else skips this tick and tries again on the next one.
 *
 * Why session-level (pg_try_advisory_lock) and not the xact variant: a job can
 * run for minutes, and pg_try_advisory_xact_lock would hold a transaction open
 * for its whole duration, parking a connection as idle-in-transaction and
 * blocking vacuum. A session lock on one dedicated client, released in a
 * finally, keeps the job's own queries on the normal pool.
 */

const db     = require('./db');
const logger = require('./logger');

/** Stable 64-bit key from the job name. hashtext is deterministic across sessions. */
const LOCK_NAMESPACE = 'hob:job:';

/**
 * Runs `fn` only if this process can take the named lock.
 *
 * Returns { ran: true, result } when it executed, or { ran: false } when another
 * replica held the lock. Skipping is a normal outcome, not an error.
 *
 * If the lock cannot be checked at all (database down), the job is SKIPPED
 * rather than run: a job that double-charges is worse than a job that misses a
 * tick, and the next tick will retry.
 */
async function withJobLock(jobName, fn) {
  const key = LOCK_NAMESPACE + jobName;
  let client;
  let locked = false;

  try {
    client = await db.getClient();
  } catch (err) {
    logger.error('[JobLock] could not get a connection — skipping run', { jobName, err: err.message });
    return { ran: false, skipped: 'no_connection' };
  }

  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS got', [key]);
    locked = rows[0]?.got === true;

    if (!locked) {
      logger.info('[JobLock] another instance holds the lock — skipping', { jobName });
      return { ran: false, skipped: 'locked_elsewhere' };
    }

    const result = await fn();
    return { ran: true, result };
  } catch (err) {
    // Surface the job's own failure to the caller; the lock still gets released.
    throw err;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (err) {
        // The lock dies with the session anyway, so a failed unlock delays the
        // next run at worst — it cannot wedge the job permanently.
        logger.warn('[JobLock] unlock failed; lock will clear when the session ends', { jobName, err: err.message });
      }
    }
    try { client.release(); } catch { /* already released */ }
  }
}

/**
 * Wraps a scheduler's tick function so every invocation goes through the lock.
 * Keeps the original function's signature, and swallows nothing — a throwing job
 * still throws, so the scheduler's own error handling applies unchanged.
 */
function locked(jobName, fn) {
  return async (...args) => {
    const outcome = await withJobLock(jobName, () => fn(...args));
    return outcome.ran ? outcome.result : undefined;
  };
}

module.exports = { withJobLock, locked };
