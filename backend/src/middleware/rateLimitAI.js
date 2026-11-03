/**
 * middleware/rateLimitAI.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-user AI rate limiter — database-backed (no Redis dependency).
 *
 * SECURITY:
 *  - Limits by userId (from validated JWT), NOT by IP.
 *    IP-based limiting is trivially bypassed by proxies/VPNs.
 *    userId-based limiting requires a valid JWT, making abuse much harder.
 *  - Daily window resets at midnight UTC (date_trunc in DB query).
 *  - Limit is configurable per role:
 *      owner/partner → 100 req/day
 *      manager       →  50 req/day
 *      employee      →  20 req/day
 *  - Returns standard 429 with a Retry-After header.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const db     = require('../utils/db');
const logger = require('../utils/logger');
const { DAILY_LIMITS } = require('../constants/ai');

function getLimitForRole(role) {
  return DAILY_LIMITS[role] ?? DAILY_LIMITS.default;
}

const TZ = 'Asia/Jerusalem';

// ── Seconds until midnight in Israel time ────────────────────────────────────
function secondsUntilMidnightIsrael() {
  const now = new Date();
  // Get current Israel date parts
  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type) => parseInt(ilParts.find(p => p.type === type).value);
  // Build midnight of next day in Israel time, expressed as UTC
  const nextMidnightIL = new Date(Date.UTC(
    get('year'), get('month') - 1, get('day') + 1, 0, 0, 0, 0
  ));
  // Adjust for Israel offset (approximate — DST handled by Intl)
  const ilOffsetMs = now - new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  return Math.ceil((nextMidnightIL.getTime() - now.getTime() + ilOffsetMs) / 1000);
}

// ── Middleware factory ───────────────────────────────────────────────────────
// Usage: router.post('/analyze/:userId', rateLimitAI(), ...)
//
// Quota is tracked in ai_rate_limit_counters via a single atomic
// INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count.
// Postgres serializes concurrent upserts to the same (user_id, day) row, so
// this closes the race a plain SELECT COUNT would have (several concurrent
// requests all reading the same pre-write count and all passing) WITHOUT
// holding a dedicated connection for the request's lifetime — a held
// connection per in-flight AI request would exhaust the pool (max 20) under
// moderate concurrent AI traffic and stall unrelated queries platform-wide.
function rateLimitAI() {
  return async (req, res, next) => {
    const userId = req.user?.userId;
    const role   = req.user?.role;

    // Sanity check — requireAuth should have already rejected unauthenticated requests
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const limit = getLimitForRole(role);

    try {
      const { rows } = await db.query(`
        INSERT INTO ai_rate_limit_counters (user_id, day, count)
        VALUES ($1, (NOW() AT TIME ZONE 'Asia/Jerusalem')::date, 1)
        ON CONFLICT (user_id, day) DO UPDATE SET count = ai_rate_limit_counters.count + 1
        RETURNING count
      `, [userId]);

      const usedToday = parseInt(rows[0]?.count || 1, 10); // includes this request
      const remaining = Math.max(0, limit - usedToday);

      // Attach usage info to req for downstream logging
      req.aiUsage = { usedToday, limit, remaining };

      if (usedToday > limit) {
        const retryAfter = secondsUntilMidnightIsrael();
        res.set('Retry-After', String(retryAfter));
        res.set('X-RateLimit-Limit', String(limit));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + retryAfter));

        return res.status(429).json({
          error: `הגעת למגבלת ${limit} בקשות AI ליום. נסה שנית מחר.`,
          limit,
          usedToday: usedToday - 1, // don't count the rejected request itself as "used"
          retryAfterSeconds: retryAfter,
        });
      }

      // Set informational headers (non-sensitive)
      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(remaining));

      next();
    } catch (err) {
      // SECURITY: Rate-limit DB failure should not silently allow unlimited requests.
      // Log the error and block the request with a 503 rather than accidentally allowing it.
      logger.error('[rateLimitAI] DB check failed', { err: err.message });
      return res.status(503).json({ error: 'שירות זמנית לא זמין' });
    }
  };
}

module.exports = { rateLimitAI };
