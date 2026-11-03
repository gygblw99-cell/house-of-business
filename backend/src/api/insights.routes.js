const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../utils/db');
const { generateInsights, storeInsights } = require('../agents/autoInsights.agent');

// GET /api/insights — last 10 insights for current business
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, type, title, body, impact, severity, is_read, created_at
       FROM ai_insights
       WHERE business_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/insights/generate — force regenerate insights now (for testing/onboarding)
// Deletes ALL existing insights (not just today's) before regenerating,
// so stale/wrong insights from previous days are wiped on manual refresh.
router.post('/generate', requireAuth, requirePermission('ai'), async (req, res, next) => {
  try {
    await db.query(`DELETE FROM ai_insights WHERE business_id = $1`, [req.user.businessId]);
    const insights = await generateInsights(req.user.businessId);
    const stored   = await storeInsights(req.user.businessId, insights);
    res.json({ generated: stored.length, insights: stored });
  } catch (err) { next(err); }
});

// PUT /api/insights/:id/read — mark as read
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE ai_insights SET is_read = TRUE WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.user.businessId]
    );
    res.json({ message: 'סומן כנקרא' });
  } catch (err) { next(err); }
});

// PUT /api/insights/read-all — mark all as read
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE ai_insights SET is_read = TRUE WHERE business_id = $1`,
      [req.user.businessId]
    );
    res.json({ message: 'כל התובנות סומנו כנקראו' });
  } catch (err) { next(err); }
});

module.exports = router;
