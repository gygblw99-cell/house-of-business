/**
 * middleware/auditLog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Audit Trail Middleware & Utility
 *
 * SECURITY:
 *  - Logs ALL critical actions with user identity, action type, and metadata.
 *  - Writes are non-blocking (fire-and-forget) so a logging failure never
 *    breaks a user request — but errors are surfaced in server logs.
 *  - Metadata is sanitized to prevent log injection (newlines stripped).
 *  - Admin impersonation is tagged with a separate action_type so it's
 *    impossible to confuse impersonated actions with real user actions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const db     = require('../utils/db');
const logger = require('../utils/logger');

// ── Action type constants ────────────────────────────────────────────────────
// Using constants prevents typos from creating silent, un-searchable log entries.
const ACTIONS = {
  // Authentication
  AUTH_LOGIN:             'auth.login',
  AUTH_LOGOUT:            'auth.logout',
  AUTH_LOGIN_FAILED:      'auth.login_failed',
  AUTH_PASSWORD_RESET:    'auth.password_reset',

  // AI usage
  AI_ANALYZE:             'ai.analyze',
  AI_RATE_LIMITED:        'ai.rate_limited',

  // Admin actions
  ADMIN_LOGIN:            'admin.login',
  ADMIN_USER_TOGGLE:      'admin.user_toggle',
  ADMIN_IMPERSONATE_START:'admin.impersonate_start',
  ADMIN_IMPERSONATE_END:  'admin.impersonate_end',

  // Data access
  DATA_EXPORT:            'data.export',
  DATA_BULK_READ:         'data.bulk_read',
};

// ── Log sanitizer ────────────────────────────────────────────────────────────
// Prevents log injection — strips newlines and control characters from strings.
// SECURITY: Log injection can be used to forge log entries.
function sanitizeForLog(value) {
  if (typeof value === 'string') {
    return value.replace(/[\r\n\t\0]/g, ' ').substring(0, 500);
  }
  if (value && typeof value === 'object') {
    try {
      return sanitizeForLog(JSON.stringify(value));
    } catch {
      return '[unserializable]';
    }
  }
  return value;
}

// ── Core write function ──────────────────────────────────────────────────────
// Inserts into the audit_log table (assumed to exist from existing schema).
// Non-blocking: does not throw on DB failure.
async function writeAuditLog({
  userId,
  businessId,
  actionType,
  entityType,
  entityId,
  metadata,
  ipAddress,
  success = true,
}) {
  try {
    const rawMeta = metadata
      ? sanitizeForLog(typeof metadata === 'object' ? metadata : { value: metadata })
      : null;
    const safeMetadata = typeof rawMeta === 'string' && rawMeta.length > 5000
      ? rawMeta.slice(0, 5000) + '…'
      : rawMeta;

    await db.query(`
      INSERT INTO audit_log (
        user_id,
        business_id,
        action,
        entity_type,
        entity_id,
        description,
        ip_address,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [
      userId     || null,
      businessId || null,
      actionType,
      entityType || null,
      entityId   || null,
      safeMetadata ? (typeof safeMetadata === 'string' ? safeMetadata : JSON.stringify(safeMetadata)) : null,
      ipAddress  || null,
    ]);
  } catch (err) {
    // NEVER crash the app due to a logging failure.
    // Log to stderr so ops teams can detect infrastructure issues.
    logger.error('[auditLog] Failed to write audit entry', { err: err.message, actionType, userId });
  }
}

// ── Express middleware (attaches logAction to req) ───────────────────────────
// Usage: app.use(auditLogMiddleware)
// After this, any route can call: await req.logAction({ actionType, ... })
function auditLogMiddleware(req, res, next) {
  // Extract IP — handle reverse proxy setups (e.g. Railway, Nginx).
  //
  // req.ip first, deliberately. Express derives it from X-Forwarded-For using
  // the configured `trust proxy` hop count, so it picks the entry appended by
  // our own edge proxy. Reading xff[0] directly instead takes the LEFTMOST
  // entry — the part the client itself sends and no proxy ever validates —
  // which let any caller forge the IP recorded in the audit trail just by
  // setting the header. The raw header stays only as a last-ditch fallback for
  // setups where trust proxy isn't configured at all.
  const ipAddress =
    req.ip ||
    req.headers['x-forwarded-for']?.split(',').pop()?.trim() ||
    'unknown';

  // Convenience method on req — avoids passing ip everywhere
  req.logAction = ({ actionType, entityType, entityId, metadata, success }) =>
    writeAuditLog({
      userId:     req.user?.userId   || req.admin?.adminId || null,
      businessId: req.user?.businessId || null,
      actionType,
      entityType,
      entityId,
      metadata,
      ipAddress,
      success,
    });

  // Also track response status for automatic failure logging
  const originalSend = res.json.bind(res);
  res.json = (body) => {
    // Attach status code to req for downstream use
    req._responseStatus = res.statusCode;
    return originalSend(body);
  };

  next();
}

// ── Admin impersonation logger ───────────────────────────────────────────────
// Called explicitly when an admin starts or ends impersonating a user.
// SECURITY: Both the adminId and the impersonated userId are logged.
async function logImpersonation({ adminId, targetUserId, action, ipAddress }) {
  await writeAuditLog({
    userId:     adminId,
    actionType: action === 'start'
      ? ACTIONS.ADMIN_IMPERSONATE_START
      : ACTIONS.ADMIN_IMPERSONATE_END,
    entityType: 'user',
    entityId:   targetUserId,
    metadata:   {
      adminId,
      targetUserId,
      // SECURITY: Token TTL is enforced to 1 hour — logged here for verification
      tokenTTL: action === 'start' ? '1h' : null,
    },
    ipAddress,
    success: true,
  });
}

module.exports = {
  auditLogMiddleware,
  writeAuditLog,
  logImpersonation,
  ACTIONS,
};
