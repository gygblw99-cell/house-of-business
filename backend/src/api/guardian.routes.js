const express  = require('express');
const router   = express.Router();
const db       = require('../utils/db');
const cache    = require('../utils/cache');
const { requireAuth, requireOwner, requireManager } = require('../middleware/auth');
const { requireAdmin, requireSuperAdmin } = require('../middleware/requireAdmin');
const eventBus = require('../utils/eventBus');
const { runGuardianScan, getHealthSummary, analyzeIncidentPatterns } = require('../services/guardian/guardian.service');
const { fixIncidentWithAI } = require('../agents/guardian.agent');

// ── Auto-create support_tickets table ────────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
    business_name TEXT,
    issue_type   TEXT NOT NULL DEFAULT 'platform',
    title        TEXT NOT NULL,
    description  TEXT,
    severity     TEXT NOT NULL DEFAULT 'medium',
    status       TEXT NOT NULL DEFAULT 'open',
    admin_note   TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ
  )
`);
db.migrate(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS owner_name TEXT`);

// ── GET /api/guardian/ping — public health probe (no auth) ────────────────────
router.get('/ping', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), service: 'guardian' });
});

// ── GET /api/guardian/health — current system health summary (admin only) ──────
router.get('/health', requireAdmin, async (req, res, next) => {
  try {
    const summary = await getHealthSummary();
    res.json(summary);
  } catch (err) { next(err); }
});

// ── GET /api/guardian/incidents — list incidents with filters (admin only) ─────
router.get('/incidents', requireAdmin, async (req, res, next) => {
  try {
    const { status = 'open', severity, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const params     = [];
    let   idx        = 1;

    if (status !== 'all') {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }
    if (severity) {
      conditions.push(`severity = $${idx++}`);
      params.push(severity);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit) || 50, 200));
    params.push(parseInt(offset) || 0);

    const { rows } = await db.query(
      `SELECT
         id, severity, feature, issue_summary, technical_details,
         root_cause_analysis, user_impact, estimated_risk, recommended_fix,
         confidence_score, affected_services, logs_summary, prediction_analysis,
         status, monitoring_actions, recovery_actions,
         occurrence_count, created_at, acknowledged_at, resolved_at, last_seen_at
       FROM guardian_incidents
       ${where}
       ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         last_seen_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM guardian_incidents ${where}`,
      params.slice(0, -2)
    );

    res.json({ incidents: rows, total: count });
  } catch (err) { next(err); }
});

// ── GET /api/guardian/incidents/:id — single incident detail (admin only) ──────
router.get('/incidents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM guardian_incidents WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incident not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/guardian/incidents/:id/acknowledge ─────────────────────────────
router.patch('/incidents/:id/acknowledge', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE guardian_incidents
       SET status = 'acknowledged', acknowledged_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING id, status, acknowledged_at`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incident not found or already acknowledged' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/guardian/incidents/:id/resolve ─────────────────────────────────
router.patch('/incidents/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE guardian_incidents
       SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1 AND status != 'resolved'
       RETURNING id, status, resolved_at`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incident not found or already resolved' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/guardian/incidents/:id/fix — AI-powered fix plan + auto-actions ──
router.post('/incidents/:id/fix', requireAdmin, requireSuperAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM guardian_incidents WHERE id = $1`,
      [req.params.id]
    );
    const incident = rows[0];
    if (!incident) return res.status(404).json({ error: 'תקלה לא נמצאה' });

    // 1. AI generates fix plan
    const fixPlan = await fixIncidentWithAI(incident);

    // 2. Execute automated steps (DB check, endpoint check)
    const executedSteps = [];
    for (const step of fixPlan.steps) {
      if (!step.automated) { executedSteps.push({ ...step, status: 'pending' }); continue; }

      let status = 'done';
      let result = step.expected_result || 'בוצע';
      try {
        if (step.action?.includes('DB') || step.action?.includes('מסד נתונים') || step.action?.includes('בסיס נתונים')) {
          await db.query('SELECT 1');
          result = 'בסיס נתונים תקין — חיבור הצליח';
        } else if (step.action?.includes('קאש') || step.action?.includes('cache')) {
          // guardian_incidents has no business_id column — these are
          // platform-wide incidents, not scoped to one tenant. This used to
          // run cache.del(`*:${incident.business_id}*`), which always
          // evaluated to cache.del('*:undefined*') (matched zero real keys)
          // and still reported "success" — a real stale-cache problem was
          // never actually cleared, and the incident could get
          // auto-acknowledged as resolved based on that false success.
          status = 'failed';
          result = 'ניקוי קאש דורש התערבות ידנית — אין מזהה עסק ספציפי בתקלה כללית זו כדי לדעת אילו מפתחות קאש לנקות';
        } else {
          result = step.expected_result || 'פעולה בוצעה';
        }
      } catch (e) {
        status = 'failed';
        result = `נכשל: ${e.message}`;
      }
      executedSteps.push({ ...step, status, result });
    }

    // 3. If all auto steps passed and can_auto_fix → mark acknowledged
    const allAutoPassed = executedSteps
      .filter(s => s.automated)
      .every(s => s.status === 'done');

    if (fixPlan.can_auto_fix && allAutoPassed && incident.status === 'open') {
      await db.query(
        `UPDATE guardian_incidents SET status='acknowledged', acknowledged_at=NOW() WHERE id=$1`,
        [incident.id]
      );
    }

    // 4. Store fix attempt in incident (monitoring_actions is TEXT[])
    await db.query(
      `UPDATE guardian_incidents
         SET monitoring_actions = array_append(COALESCE(monitoring_actions, ARRAY[]::TEXT[]), $1)
       WHERE id=$2`,
      [`תיקון אוטומטי הופעל: ${new Date().toLocaleString('he-IL')}`, incident.id]
    );

    res.json({
      summary:        fixPlan.summary,
      steps:          executedSteps,
      can_auto_fix:   fixPlan.can_auto_fix,
      risk_level:     fixPlan.risk_level,
      auto_resolved:  fixPlan.can_auto_fix && allAutoPassed,
    });
  } catch (err) { next(err); }
});

// ── PATCH /api/guardian/incidents/:id/reopen ──────────────────────────────────
router.patch('/incidents/:id/reopen', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE guardian_incidents
       SET status = 'open', resolved_at = NULL, acknowledged_at = NULL
       WHERE id = $1
       RETURNING id, status`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incident not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/guardian/patterns — predictive incident pattern analysis ─────────
router.get('/patterns', requireAdmin, async (req, res, next) => {
  try {
    const data = await analyzeIncidentPatterns();
    res.json(data);
  } catch (err) { next(err); }
});

// ── POST /api/guardian/run — manual scan trigger ──────────────────────────────
router.post('/run', requireAdmin, async (req, res, next) => {
  try {
    const result = await runGuardianScan();
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/guardian/health-log — recent health check history (admin only) ───
router.get('/health-log', requireAdmin, async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours) || 1, 1), 24);
    const { rows } = await db.query(
      `SELECT service, endpoint, status, response_time_ms, checked_at
       FROM guardian_health_log
       WHERE checked_at >= NOW() - ($1 * INTERVAL '1 hour')
       ORDER BY checked_at DESC
       LIMIT 500`,
      [hours]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── DELETE /api/guardian/incidents/resolved — purge old resolved ──────────────
router.delete('/incidents/resolved', requireAdmin, requireSuperAdmin, async (req, res, next) => {
  try {
    const days = Math.max(parseInt(req.query.days) || 7, 1);
    const { rowCount } = await db.query(
      `DELETE FROM guardian_incidents
       WHERE status = 'resolved' AND resolved_at < NOW() - ($1 * INTERVAL '1 day')`,
      [days]
    );
    res.json({ deleted: rowCount });
  } catch (err) { next(err); }
});

// ── POST /api/guardian/tickets — create support ticket ────────────────────────
router.post('/tickets', requireAuth, async (req, res, next) => {
  try {
    const { issueType = 'platform', title, description, severity = 'medium' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'כותרת חסרה' });

    // Fetch business name + owner name for admin view
    let businessName = '';
    let ownerName = '';
    try {
      const { rows } = await db.query(
        `SELECT b.name AS biz_name, u.full_name AS owner_full_name
         FROM businesses b
         LEFT JOIN users u ON u.id = $2
         WHERE b.id = $1`,
        [req.user.businessId, req.user.userId]
      );
      businessName = rows[0]?.biz_name || '';
      ownerName    = rows[0]?.owner_full_name || '';
    } catch {}

    const { rows: [ticket] } = await db.query(
      `INSERT INTO support_tickets (business_id, business_name, owner_name, issue_type, title, description, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.businessId, businessName, ownerName, issueType, title.trim(), description?.trim() || null, severity]
    );
    eventBus.publish(req.user.businessId, 'ticket.updated', { action: 'created', ticketId: ticket.id });
    res.status(201).json({ ticket });
  } catch (err) { next(err); }
});

// ── GET /api/guardian/tickets — own tickets (paginated) ────────────────────────
router.get('/tickets', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const where  = status && status !== 'all' ? 'AND status=$2' : '';
    const params = status && status !== 'all'
      ? [req.user.businessId, status]
      : [req.user.businessId];
    const [{ rows }, { rows: [countRow] }] = await Promise.all([
      db.query(
        `SELECT * FROM support_tickets WHERE business_id=$1 ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM support_tickets WHERE business_id=$1 ${where}`,
        params
      ),
    ]);
    res.json({ tickets: rows, total: countRow.total, limit, offset });
  } catch (err) { next(err); }
});

// ── GET /api/guardian/admin/tickets — own tickets ordered by severity ─────────
router.get('/admin/tickets', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { status } = req.query;
    const conditions = [`business_id=$1`];
    const params = [req.user.businessId];
    if (status && status !== 'all') {
      conditions.push(`status=$2`);
      params.push(status);
    }
    const { rows } = await db.query(
      `SELECT * FROM support_tickets WHERE ${conditions.join(' AND ')} ORDER BY
         CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         created_at DESC LIMIT 500`,
      params
    );
    res.json({ tickets: rows });
  } catch (err) { next(err); }
});

// ── PATCH /api/guardian/admin/tickets/:id — update ticket status ──────────────
router.patch('/admin/tickets/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { status, adminNote } = req.body;
    if (!['open','in_progress','resolved'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }
    const { rows: [ticket] } = await db.query(
      `UPDATE support_tickets
       SET status=$1, admin_note=COALESCE($2,admin_note), updated_at=NOW(),
           resolved_at=CASE WHEN $1='resolved' THEN NOW() ELSE resolved_at END
       WHERE id=$3 AND business_id=$4 RETURNING *`,
      [status, adminNote || null, req.params.id, req.user.businessId]
    );
    if (!ticket) return res.status(404).json({ error: 'קריאה לא נמצאה' });
    eventBus.publish(req.user.businessId, 'ticket.updated', { action: 'status_changed', ticketId: ticket.id, status });
    res.json({ ticket });
  } catch (err) { next(err); }
});

module.exports = router;
