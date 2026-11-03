'use strict';

/**
 * Races a promise against a deadline, and ALWAYS clears the timer.
 *
 * The hand-rolled version of this was written 20 times across the codebase:
 *
 *   await Promise.race([
 *     anthropic.messages.create({ ... }),
 *     new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
 *   ]);
 *
 * Promise.race settles on the first promise to finish, but it does not cancel
 * the loser. When the real call returns in 200ms the 30-second timer stays
 * armed, holding its reject closure — and the whole surrounding scope with it —
 * alive. Only 4 of the 20 sites cleared it, so 16 leaked a live timer on every
 * single call: every AI request, every invoice OCR, every DB health check.
 *
 * The visible symptoms were a Node process that would not exit (and Jest
 * reporting exactly that: "A worker process has failed to exit gracefully...
 * Active timers can also cause this, ensure that .unref() was called on them")
 * and AI orchestrator tests that failed intermittently under load as the timers
 * accumulated.
 *
 * Two deliberate limits:
 *
 * - This does NOT cancel the work. A timed-out Anthropic request keeps running
 *   to completion on their side and still bills; the caller simply stops waiting.
 *   Cancelling needs an AbortSignal threaded into the SDK call, which is a
 *   separate change at each call site.
 * - A rejection arriving from the work AFTER the timeout already fired is
 *   swallowed here. Without that, every timeout would be followed by an
 *   unhandled rejection, and this process treats unhandled rejections as fatal.
 */

class TimeoutError extends Error {
  constructor(label, ms) {
    super(label ? `${label} timed out after ${ms}ms` : `timed out after ${ms}ms`);
    this.name      = 'TimeoutError';
    this.isTimeout = true;
    this.timeoutMs = ms;
  }
}

/**
 * @param {Promise|Function} work  A promise, or a function returning one. Passing
 *                                 a function is preferred — it makes the start of
 *                                 the work visibly part of the race.
 * @param {number} ms              Deadline in milliseconds.
 * @param {string} [label]         Appears in the error message, e.g. 'Haiku'.
 */
async function withTimeout(work, ms, label) {
  const promise = typeof work === 'function' ? work() : work;

  // Once the timeout wins, nothing is listening to `promise` any more. Attach a
  // sink so a rejection arriving later cannot surface as an unhandled rejection.
  // This does not suppress the error the caller sees: the race below already
  // has its own handler on the same promise.
  Promise.resolve(promise).catch(() => {});

  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withTimeout, TimeoutError };
