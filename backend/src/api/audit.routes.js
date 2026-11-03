const express = require('express');
const router  = express.Router();
const { requireAuth, requireOwner, requirePermission } = require('../middleware/auth');
const { runAudit }  = require('../agents/businessAudit.agent');
const db            = require('../utils/db');
const cache         = require('../utils/cache');
const eventBus      = require('../utils/eventBus');

// POST /api/audit/run — ריצה ידנית
router.post('/run', requireAuth, requirePermission('audit'), async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.body || {};
    const result = await runAudit(req.user.businessId, { isManual: true, fromDate, toDate });
    if (!result.hasData) {
      return res.status(202).json({ hasData: false, message: result.message });
    }
    await cache.del(`audit:latest:${req.user.businessId}`);
    // dashboard.refresh — הדשבורד כבר מציג ניקוד ביקורת ומאזין לאירוע הזה;
    // audit.updated — ייעודי לעמוד הביקורת עצמו (עקביות בין טאבים/מכשירים)
    eventBus.publish(req.user.businessId, 'dashboard.refresh', { reason: 'audit' });
    eventBus.publish(req.user.businessId, 'audit.updated', { score: result.scores?.total });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/latest — תוצאה אחרונה (cached 10 min)
router.get('/latest', requireAuth, requirePermission('audit'), async (req, res, next) => {
  try {
    const cacheKey = `audit:latest:${req.user.businessId}`;
    const cached   = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await db.query(
      // is_manual_run = TRUE only: the audit surfaces (dashboard card, audit
      // page) show a score exclusively when the owner has actually run an audit
      // for a period they chose. Legacy nightly auto-audit rows are ignored so
      // the card reflects owner-requested audits, not a stale automatic score.
      `SELECT id, business_id, score, score_profitability, score_inventory,
              score_employees, score_avg_order, issues, recommendations,
              is_manual_run, created_at, from_date, to_date
       FROM business_audit_scores
       WHERE business_id = $1 AND is_manual_run = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.businessId]
    );
    const result = rows[0] ? { hasData: true, ...rows[0] } : { hasData: false };
    await cache.set(cacheKey, result, 600);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/score — ניקוד + מגמה לדשבורד
// המגמה מחושבת כממוצע נע של עד 4 הביקורות הקודמות (לא רק מול הריצה
// האחרונה) — השוואה מול ריצה בודדת מטעה אם היא הייתה יום חריג
// (חלש/חזק במיוחד), בעוד ממוצע נע נותן קו-בסיס יציב יותר.
router.get('/score', requireAuth, requirePermission('audit'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT score, created_at
       FROM business_audit_scores
       WHERE business_id = $1 AND is_manual_run = TRUE
       ORDER BY created_at DESC LIMIT 5`,
      [req.user.businessId]
    );

    if (!rows[0]) return res.json({ hasData: false });

    const current  = rows[0].score;
    const priorRuns = rows.slice(1, 5); // עד 4 ריצות קודמות
    const trend = priorRuns.length
      ? Math.round(priorRuns.reduce((s, r) => s + r.score, 0) / priorRuns.length)
      : null;
    const change = trend !== null ? current - trend : null;

    res.json({
      hasData:    true,
      score:      current,
      trend,                                 // ממוצע עד 4 הביקורות הקודמות, null אם זו הביקורת הראשונה
      trendCount: priorRuns.length,          // כמה ריצות קודמות נכנסו לממוצע — שקיפות על מהימנות המגמה
      lastScore:  priorRuns[0]?.score ?? null, // הריצה הבודדת האחרונה, לעיון בלבד
      change,                                // חיובי = מעל הממוצע, שלילי = מתחת
      direction:  change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'same',
      updatedAt:  rows[0].created_at,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/history — היסטוריית ניקוד (עד שנה)
router.get('/history', requireAuth, requirePermission('audit'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT score, score_profitability, score_inventory,
              score_employees, score_avg_order, created_at
       FROM business_audit_scores
       WHERE business_id = $1 AND is_manual_run = TRUE
         AND created_at >= NOW() - INTERVAL '1 year'
       ORDER BY created_at ASC`,
      [req.user.businessId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
