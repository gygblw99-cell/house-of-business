/**
 * api/aiAnalyze.routes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/ai/analyze/:userId
 *
 * SECURITY CHAIN (middleware order matters):
 *  1. requireAuth       — Validates JWT, rejects unauthenticated requests
 *  2. validate(params)  — Enforces UUID format on :userId (prevents injection)
 *  3. requirePermission — Only users with 'ai' module permission can proceed
 *  4. rateLimitAI()     — Checks DB usage count, blocks at daily limit
 *  5. validate(body)    — Validates businessId + analysisType from body
 *  6. controller        — Verifies ownership, fetches data, calls Claude
 *
 * AUTHORIZATION:
 *  - A user can only analyze their OWN business (businessId from JWT must
 *    match the businessId in the request body).
 *  - Admin impersonation is a separate endpoint (see below) requiring
 *    super_admin role, full audit logging, and a 1-hour token expiry.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const db       = require('../utils/db');
const logger   = require('../utils/logger');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { rateLimitAI }  = require('../middleware/rateLimitAI');
const { validate, schemas } = require('../middleware/validateInput');
const { auditLogMiddleware, ACTIONS } = require('../middleware/auditLog');
const { analyzeBusinessData } = require('../services/ai/aiAnalyze.service');
const bcrypt = require('bcryptjs');

const router = express.Router();

// Apply audit log middleware to all routes in this file
router.use(auditLogMiddleware);

// ── POST /api/ai/analyze/:userId ─────────────────────────────────────────────
router.post(
  '/analyze/:userId',

  // 1. JWT authentication
  requireAuth,

  // 2. Validate :userId is a valid UUID (early rejection before any DB calls)
  validate({ params: schemas.analyzeParamsSchema }),

  // 3. Check AI module permission
  requirePermission('ai'),

  // 4. Per-user daily rate limit (DB-backed, role-aware)
  rateLimitAI(),

  // 5. Validate request body
  validate({ body: schemas.analyzeBodySchema }),

  // 6. Controller
  async (req, res) => {
    const { userId } = req.params;
    const { businessId, analysisType } = req.body;

    // ── AUTHORIZATION: Self-only access ──────────────────────────────────────
    // Prevents user A from analyzing user B's business by putting B's userId
    // in the URL param. The user can only analyze themselves.
    if (req.user.userId !== userId) {
      // Log this — it may indicate an active attack or a bug
      await req.logAction({
        actionType: 'security.unauthorized_access_attempt',
        entityType: 'ai_analyze',
        metadata: {
          requestedUserId: userId,
          authenticatedUserId: req.user.userId,
        },
        success: false,
      });
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── AUTHORIZATION: Business ownership ────────────────────────────────────
    // The businessId from the request body must match what's in the JWT.
    // This prevents a user from analyzing a business they're not part of
    // even if they know the business UUID.
    if (req.user.businessId !== businessId) {
      return res.status(403).json({ error: 'Access denied: business mismatch' });
    }

    try {
      const { insights, tokensUsed } = await analyzeBusinessData(
        userId,
        businessId,
        analysisType
      );

      // Log successful AI analysis
      await req.logAction({
        actionType: ACTIONS.AI_ANALYZE,
        entityType: 'business',
        entityId:   businessId,
        metadata:   {
          analysisType,
          tokensUsed,
          remaining: req.aiUsage?.remaining ?? null,
        },
        success: true,
      });

      return res.json({
        insights,
        tokensUsed,
        usage: {
          usedToday: (req.aiUsage?.usedToday ?? 0) + 1,
          limit:     req.aiUsage?.limit ?? 100,
          remaining: Math.max(0, (req.aiUsage?.remaining ?? 0) - 1),
        },
      });
    } catch (err) {
      // SECURITY: Log full error internally but send only generic message to client
      logger.error('[aiAnalyze] Error', { err: err.message, userId, businessId, analysisType });

      await req.logAction({
        actionType: ACTIONS.AI_ANALYZE,
        entityType: 'business',
        entityId:   businessId,
        metadata:   { analysisType, error: err.message?.substring(0, 100) },
        success:    false,
      });

      const status = err.statusCode || 500;
      const message = status === 403
        ? err.message          // Ownership errors are safe to surface
        : 'שגיאה בניתוח הנתונים. נסה שנית.'; // All others get generic message

      return res.status(status).json({ error: message });
    }
  }
);

// ── GET /api/ai/analyze/usage ─────────────────────────────────────────────────
// Returns current user's AI usage stats for today.
router.get('/analyze/usage', requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const role   = req.user.role;

  const DAILY_LIMITS = { owner: 100, partner: 100, manager: 50, employee: 20 };
  const limit = DAILY_LIMITS[role] ?? 10;

  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) AS count
      FROM ai_logs
      WHERE user_id = $1
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
    `, [userId]);

    const usedToday = parseInt(rows[0]?.count || 0, 10);

    return res.json({
      usedToday,
      limit,
      remaining: Math.max(0, limit - usedToday),
    });
  } catch (err) {
    logger.warn('[aiAnalyze/usage] DB error — returning zeros', { err: err.message });
    return res.json({ usedToday: 0, limit, remaining: limit });
  }
});

module.exports = router;
