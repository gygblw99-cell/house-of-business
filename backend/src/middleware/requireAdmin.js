const { verify } = require('../utils/jwt');
const { TokenExpiredError } = require('jsonwebtoken');
const db = require('../utils/db');
const logger = require('../utils/logger');

// Allowed origins for admin panel — read at startup so ALLOWED_ADMIN_ORIGINS is immutable.
// NOTE: NEXT_PUBLIC_APP_URL is a Next.js build-time client variable and is never present in
// the backend Node process. Use ADMIN_ORIGIN in the backend .env instead.
const ALLOWED_ADMIN_ORIGINS = new Set(
  [
    process.env.ADMIN_ORIGIN,
    ...(process.env.NODE_ENV !== 'production'
      ? ['http://localhost:3002', 'http://localhost:3001']
      : []),
  ].filter(Boolean)
);
// Pre-materialised array for the referer-prefix check — avoids spreading the Set on every request
const ALLOWED_ADMIN_ORIGINS_ARR = [...ALLOWED_ADMIN_ORIGINS];

// CSRF: enforce Same-Origin for all state-changing admin requests.
// Combined with SameSite=strict cookie this gives defence-in-depth against CSRF.
function _verifyCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin  = req.headers.origin  || '';
  const referer = req.headers.referer || '';
  // Block requests with neither Origin nor Referer — browser always sends at least one.
  // curl / direct API calls without a valid origin are not allowed on admin endpoints.
  if (!origin && !referer) return false;
  if (origin  && ALLOWED_ADMIN_ORIGINS.has(origin))                           return true;
  if (!origin && referer && ALLOWED_ADMIN_ORIGINS_ARR.some(o => referer === o || referer.startsWith(o + '/'))) return true;
  return false;
}

function _extractAdminToken(req) {
  // 1. Authorization header (dev/tools usage)
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.split(' ')[1];
  // 2. HttpOnly cookie (browser sessions)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)admin_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

const requireAdmin = async (req, res, next) => {
  if (!_verifyCsrf(req)) {
    logger.warn('[requireAdmin] CSRF check failed', { origin: req.headers.origin, method: req.method, path: req.path });
    return res.status(403).json({ error: 'CSRF: cross-origin request not allowed' });
  }
  const token = _extractAdminToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let payload;
  try {
    payload = verify(token);
  } catch (err) {
    if (err instanceof TokenExpiredError) return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (!payload.isAdmin) return res.status(403).json({ error: 'Admin only' });
  try {
    // Verify the admin account still exists and is active in the DB, and read
    // the CURRENT role — the JWT's role claim is fixed at login time, so a
    // super_admin demoted to admin after login must lose super_admin access
    // immediately, not just once their (up to 7-day) token expires.
    const { rows } = await db.query(
      'SELECT id, role, password_changed_at FROM admin_users WHERE id = $1 AND is_active = TRUE',
      [payload.adminId]
    );
    if (!rows[0]) return res.status(403).json({ error: 'Admin account suspended' });

    // Reject tokens issued before the last password change — the same check
    // middleware/auth.js applies to tenant users, where its comment calls it
    // "closes the 7-day reuse gap". It was never applied to admins, so the gap
    // it names stayed open on precisely the highest-privilege accounts: an
    // admin who reset their password *because* their session was stolen did not
    // revoke the thief's token, which stayed valid for the full cookie lifetime
    // (7 days by default). Suspending the account was the only real remedy.
    if (rows[0].password_changed_at) {
      const pwChangedSec = Math.floor(new Date(rows[0].password_changed_at).getTime() / 1000);
      if ((payload.iat || 0) < pwChangedSec) {
        return res.status(401).json({ error: 'Password changed — please sign in again' });
      }
    }

    req.admin = { ...payload, role: rows[0].role };
    next();
  } catch (err) {
    logger.error('[requireAdmin] DB lookup failed', { adminId: payload?.adminId, err: err.message });
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }
};

// ── requireSuperAdmin ────────────────────────────────────────────────────────
// admin_users.role is 'admin' or 'super_admin' (DB CHECK constraint) — gate the
// most destructive/high-blast-radius actions (business creation, mass sync,
// automated incident "fixes") behind the higher tier. Must run after requireAdmin.
const requireSuperAdmin = (req, res, next) => {
  if (req.admin?.role !== 'super_admin') {
    return res.status(403).json({ error: 'הרשאה: super_admin בלבד' });
  }
  next();
};

module.exports = { requireAdmin, requireSuperAdmin };
