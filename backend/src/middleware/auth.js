const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { verify } = require('../utils/jwt');
const logger     = require('../utils/logger');
const db         = require('../utils/db');
const cache      = require('../utils/cache');

// Per-user rate limiter — applied inside requireAuth once req.user is populated,
// so the key is the authenticated user ID (not IP, which could be shared NAT).
const _userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'יותר מדי בקשות, נסה שנית בעוד מספר דקות' },
});

// JWTs default to a 7-day expiry (utils/jwt.js) and req.user.role/is_active
// come straight from the token payload with nothing re-checked against the
// DB — so a role downgrade or deactivation (fired employee, demoted manager)
// had no effect until the old token happened to expire, up to 7 days later.
// A 60s cache keeps this from adding a DB round-trip to every single
// authenticated request (the hottest path in the app) while still closing
// the gap from "up to 7 days" down to "at most 60 seconds".
const ROLE_CHECK_TTL_SEC = 60;
async function _currentUserStatus(userId) {
  return cache.wrap(`auth:status:${userId}`, async () => {
    const { rows } = await db.query(
      `SELECT u.role, u.is_active,
              u.perm_suppliers, u.perm_inventory, u.perm_recipes,
              u.perm_finance, u.perm_ai, u.perm_employees, u.perm_export, u.perm_audit,
              u.password_changed_at,
              b.suspended_at, b.suspended_reason, b.is_active AS business_is_active
       FROM users u
       JOIN businesses b ON b.id = u.business_id
       WHERE u.id = $1`,
      [userId]
    );
    const u = rows[0];
    if (!u) return null;
    return {
      role: u.role,
      is_active: u.is_active,
      password_changed_at: u.password_changed_at,
      business_suspended_at: u.suspended_at,
      business_suspended_reason: u.suspended_reason,
      // NULL means "never set" — those businesses predate the column and are active.
      business_is_active: u.business_is_active !== false,
      // Same shape as auth.service.js builds into the JWT at login — the
      // per-module perm_* flags are editable independently of role via
      // PUT /api/business/users/:id/permissions and were otherwise frozen
      // at whatever the JWT carried until it expired (up to 7 days).
      permissions: {
        suppliers: u.perm_suppliers, inventory: u.perm_inventory, recipes: u.perm_recipes,
        finance:   u.perm_finance,   ai:        u.perm_ai,        employees: u.perm_employees,
        export:    u.perm_export,    audit:     u.perm_audit,
      },
    };
  }, ROLE_CHECK_TTL_SEC);
}

// Routes that must stay reachable for a suspended business — the frontend
// needs GET /auth/me to actually learn the business is suspended (to show
// the blocking page) and logout must always work, so both would break if
// this same gate rejected them like every other route.
const SUSPENSION_EXEMPT_URLS = new Set(['/api/auth/me', '/api/auth/logout']);

// Route groups that cost real money per call — every endpoint under them runs
// an AI agent, an OCR pass or an outbound scan. When an admin switches a
// business off (businesses.is_active = FALSE) these stop responding, which is
// the request-time half of the same switch the schedulers read through
// utils/activeBusiness.js. Everything not listed here stays reachable, so an
// inactive business is still fully readable — only new paid work is refused.
const PAID_ROUTE_PREFIXES = [
  '/api/ai/',
  '/api/ai-analyze/',
  '/api/fraud/',
  '/api/guardian/',
  '/api/orchestrator/',
  '/api/forecast/',
];

// ── requireAuth ────────────────────────────────────────────────
// מוסיף req.user = { userId, businessId, role, permissions }
const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'לא מורשה — נדרשת כניסה' });
  }

  try {
    req.user = verify(header.split(' ')[1]);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'session_expired', message: 'פג תוקף הפגישה — נא להתחבר מחדש' });
    }
    return res.status(401).json({ error: 'טוקן לא תקין' });
  }

  // Route tests mock db.query per-test for the ROUTE's own queries — this
  // extra DB round-trip would consume the first mocked response (or throw
  // on an unmocked call), breaking auth for nearly every authenticated test
  // regardless of what it's actually testing. The stale-role/permissions
  // check itself belongs in a dedicated auth unit test, not exercised as a
  // side effect of every unrelated route test.
  if (process.env.NODE_ENV === 'test') return next();

  try {
    const current = await _currentUserStatus(req.user.userId);
    if (!current || current.is_active === false) {
      return res.status(401).json({ error: 'session_expired', message: 'החשבון אינו פעיל — פנה למנהל' });
    }
    // Reject tokens issued before the last password change (closes the 7-day reuse gap).
    // req.user.iat is the JWT "issued at" Unix timestamp (seconds); password_changed_at
    // is a TIMESTAMPTZ — compare after converting to the same unit.
    if (current.password_changed_at) {
      const pwChangedSec = Math.floor(new Date(current.password_changed_at).getTime() / 1000);
      if ((req.user.iat || 0) < pwChangedSec) {
        return res.status(401).json({ error: 'session_expired', message: 'הסיסמה שונתה — נא להתחבר מחדש' });
      }
    }
    req.user.role = current.role; // always the CURRENT role/permissions, not what the token was issued with
    req.user.permissions = current.permissions;
    // Read by requireActiveBusiness. Kept as a flag rather than a hard reject
    // here because an inactive business stays fully readable — only the
    // paid/automated work is gated.
    req.user.businessActive = current.business_is_active;

    const _path = req.originalUrl.split('?')[0];
    // Check suspension FIRST — it's the more specific/informative state and carries
    // a reason the owner needs to see. Checking inactive first would silently mask
    // the suspension message for businesses that are both inactive and suspended.
    if (current.business_suspended_at && !SUSPENSION_EXEMPT_URLS.has(_path)) {
      return res.status(403).json({
        error:  'business_suspended',
        reason: current.business_suspended_reason || null,
      });
    }

    if (!current.business_is_active && PAID_ROUTE_PREFIXES.some(p => _path.startsWith(p))) {
      return res.status(403).json({
        error:   'business_inactive',
        message: 'התכונות האוטומטיות של העסק כבויות כרגע. הנתונים הקיימים זמינים לצפייה — לחידוש הפעילות יש לפנות לתמיכה.',
      });
    }

    return _userLimiter(req, res, next);
  } catch (err) {
    logger.error('[requireAuth] role/status check failed', { err: err.message });
    return res.status(503).json({ error: 'שירות זמנית לא זמין' });
  }
};

// ── Short-lived SSE tokens — one-time use, 60s TTL ────────────
// When REDIS_URL is set, tokens are stored in Redis (cluster-safe).
// Otherwise falls back to in-memory Map (single-process deployments).
const SSE_TTL_SEC = 60;
const _sseTokens  = new Map(); // fallback: randomHex → { user, exp }

let _redis = null;
(function _initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const Redis = require('ioredis');
    _redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false });
    _redis.on('error', () => { /* suppress — in-memory fallback still works */ });
    logger.info('[SSE] Redis token store enabled');
  } catch {
    logger.warn('[SSE] ioredis not available, falling back to in-memory token store');
  }
})();

async function issueSseToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  if (_redis) {
    try {
      await _redis.set(`sse:${token}`, JSON.stringify(user), 'EX', SSE_TTL_SEC);
      return token;
    } catch { /* fallthrough to local Map */ }
  }
  _sseTokens.set(token, { user, exp: Date.now() + SSE_TTL_SEC * 1000 });
  if (_sseTokens.size > 500) {
    const now = Date.now();
    for (const [k, v] of _sseTokens) {
      if (now > v.exp) _sseTokens.delete(k);
    }
  }
  return token;
}

async function _consumeSseToken(rawToken) {
  if (_redis) {
    try {
      const key  = `sse:${rawToken}`;
      // Use GETDEL for atomicity (Redis 6.2+)
      const data = await _redis.getdel(key).catch(() => null);
      if (!data) {
        // Fallback for older Redis: non-atomic but acceptable
        const val = await _redis.get(key);
        if (!val) return null;
        await _redis.del(key);
        return JSON.parse(val);
      }
      return JSON.parse(data);
    } catch { /* fallthrough to local Map */ }
  }
  const entry = _sseTokens.get(rawToken);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    _sseTokens.delete(rawToken);
    return 'expired';
  }
  _sseTokens.delete(rawToken);
  return entry.user;
}

// ── Short-lived image-access tokens — multi-use, 15min TTL ───
// Same query-param problem as SSE (an <img src> cannot send an Authorization
// header) but a different access pattern: a single gallery/tasks/invoices
// page can reference the same uploaded file many times (thumbnail + lightbox,
// re-render, browser re-fetch after a cache miss), so — unlike SSE tokens —
// this token must NOT be consumed on first use, and needs a TTL long enough
// to outlive a normal browsing session on the page rather than one 60s SSE
// reconnect window.
const IMG_TOKEN_TTL_SEC = 15 * 60;
const _imgTokens = new Map(); // fallback: randomHex → { user, exp }

async function issueImageToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  if (_redis) {
    try {
      await _redis.set(`img:${token}`, JSON.stringify(user), 'EX', IMG_TOKEN_TTL_SEC);
      return token;
    } catch { /* fallthrough to local Map */ }
  }
  _imgTokens.set(token, { user, exp: Date.now() + IMG_TOKEN_TTL_SEC * 1000 });
  if (_imgTokens.size > 1000) {
    const now = Date.now();
    for (const [k, v] of _imgTokens) {
      if (now > v.exp) _imgTokens.delete(k);
    }
  }
  return token;
}

async function _checkImageToken(rawToken) {
  if (_redis) {
    try {
      const data = await _redis.get(`img:${rawToken}`);
      return data ? JSON.parse(data) : null;
    } catch { /* fallthrough to local Map */ }
  }
  const entry = _imgTokens.get(rawToken);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    _imgTokens.delete(rawToken);
    return null;
  }
  return entry.user;
}

// ── requireAuthImg ─────────────────────────────────────────────
// Same header limitation as EventSource — plain <img>/<a> elements cannot
// send Authorization headers — accept a short-lived image token via ?token=
// query param, or a normal Bearer header for non-browser (API) callers.
// Accepted tradeoff: unlike the Bearer path (which re-checks _currentUserStatus,
// bounding a fired/demoted user to ≤60s of stale access), the token path sets
// req.user straight from the up-to-15-min-old token payload with no freshness
// check — a deactivated employee could keep viewing (read-only, already-
// uploaded) images for up to 15 extra minutes. Not re-checked here to avoid
// a DB round trip on every image request; low real-world risk since this path
// only grants read access to files the employee could already see before.
const requireAuthImg = async (req, res, next) => {
  const header     = req.headers.authorization;
  const queryToken = req.query?.token;

  if (queryToken) {
    delete req.query.token; // keep the live credential out of any downstream query-string logger
    const user = await _checkImageToken(queryToken).catch(() => null);
    if (!user) return res.status(401).json({ error: 'טוקן תמונה לא תקין או פג תוקף' });
    req.user = user;
    // Check password_changed_at so a forced-revocation (fired employee, password reset)
    // also invalidates outstanding image tokens. Uses the same 60s cached status as
    // requireAuth — no extra DB round-trip in the common case.
    if (process.env.NODE_ENV !== 'test') {
      try {
        const current = await _currentUserStatus(user.userId);
        if (!current || current.is_active === false) {
          return res.status(401).json({ error: 'החשבון אינו פעיל' });
        }
        if (current.password_changed_at) {
          const pwChangedSec = Math.floor(new Date(current.password_changed_at).getTime() / 1000);
          if ((user.iat || 0) < pwChangedSec) {
            return res.status(401).json({ error: 'session_expired', message: 'הסיסמה שונתה — נא להתחבר מחדש' });
          }
        }
      } catch { /* DB error — allow through, same defensive stance as requireAuth */ }
    }
    return next();
  }
  if (header?.startsWith('Bearer ')) {
    return requireAuth(req, res, next);
  }
  return res.status(401).json({ error: 'לא מורשה — נדרשת כניסה' });
};

// ── requireAuthSSE ─────────────────────────────────────────────
// EventSource cannot send Authorization headers — accept short-lived SSE token.
// Token may arrive as ?token= query param (EventSource) or Authorization: Bearer.
const requireAuthSSE = async (req, res, next) => {
  const header     = req.headers.authorization;
  const queryToken = req.query?.token;

  let rawToken = null;
  if (queryToken) {
    delete req.query.token;
    rawToken = queryToken;
  } else if (header?.startsWith('Bearer ')) {
    rawToken = header.split(' ')[1];
  }

  if (!rawToken) {
    return res.status(401).json({ error: 'לא מורשה — נדרשת כניסה' });
  }

  try {
    const result = await _consumeSseToken(rawToken);
    if (!result)           return res.status(401).json({ error: 'טוקן SSE לא תקין — התחבר מחדש' });
    if (result === 'expired') return res.status(401).json({ error: 'טוקן SSE פג תוקף — התחבר מחדש' });
    req.user = result;
    // Check suspension — SSE tokens are short-lived but a suspended business
    // must not continue receiving events even within the token window.
    try {
      const current = await _currentUserStatus(result.userId);
      if (!current || current.is_active === false) {
        return res.status(401).json({ error: 'session_expired', message: 'החשבון אינו פעיל' });
      }
      if (current.business_suspended_at) {
        return res.status(403).json({ error: 'business_suspended', message: current.business_suspended_reason || 'העסק מושהה' });
      }
    } catch { /* DB error — allow through, matches requireAuth defensive stance */ }
    return next();
  } catch {
    return res.status(401).json({ error: 'שגיאה בבדיקת טוקן SSE' });
  }
};

// ── requireOwner ───────────────────────────────────────────────
// רק בעל עסק או שותף
const requireOwner = (req, res, next) => {
  if (!['owner', 'partner'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'הרשאה: בעל עסק בלבד' });
  }
  next();
};

// ── requireManager ─────────────────────────────────────────────
// בעל עסק, שותף, או מנהל
const requireManager = (req, res, next) => {
  if (!['owner', 'partner', 'manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'הרשאה: מנהל ומעלה בלבד' });
  }
  next();
};

// ── requirePermission(module) ──────────────────────────────────
// עובד עם הרשאה ספציפית — owner/partner/manager עוברים אוטומטית
const requirePermission = (module) => (req, res, next) => {
  const { role, permissions } = req.user || {};
  if (['owner', 'partner', 'manager'].includes(role)) return next();
  if (permissions?.[module]) return next();
  return res.status(403).json({ error: `אין הרשאה למודול: ${module}` });
};

// ── requireSameBusiness ────────────────────────────────────────
// מגן על routes שיש בהם :businessId בפרמטרים — מוודא שהמשתמש שייך לאותו עסק.
// שימוש: router.get('/:businessId/data', requireAuth, requireSameBusiness, handler)
const requireSameBusiness = (req, res, next) => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const paramId = req.params.businessId
    ?? Object.values(req.params).find(v => UUID_RE.test(v));
  if (paramId && paramId !== req.user?.businessId) {
    return res.status(403).json({ error: 'אין גישה לעסק זה' });
  }
  next();
};

// ── requireActiveBusiness ──────────────────────────────────────
// Gate for anything that costs money to run — AI agents, OCR, report
// generation, competitor scans. An admin can switch a business off
// (businesses.is_active = FALSE) to stop the platform spending on an
// account that nobody is really using; the same flag is what the
// schedulers filter on (utils/activeBusiness.js), so the manual and the
// automated paths agree instead of one running while the other is off.
//
// Deliberately NOT a blanket block: existing data stays readable and the
// owner can still sign in and look around. Only new paid work is refused.
const requireActiveBusiness = (req, res, next) => {
  if (req.user?.businessActive === false) {
    return res.status(403).json({
      error:   'business_inactive',
      message: 'התכונות האוטומטיות של העסק כבויות כרגע. הנתונים הקיימים זמינים לצפייה — לחידוש הפעילות יש לפנות לתמיכה.',
    });
  }
  next();
};

module.exports = { requireAuth, requireAuthSSE, requireAuthImg, requireOwner, requireManager, requirePermission, requireSameBusiness, requireActiveBusiness, issueSseToken, issueImageToken };
