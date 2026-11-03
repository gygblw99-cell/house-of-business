const express = require('express');
const router  = express.Router();
const { requireAuth, requireManager } = require('../middleware/auth');
const { getLog, ACTIONS } = require('../services/activityLog.service');

// GET /api/activity — לוג פעילות
router.get('/', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { limit, offset, userId, action, fromDate, toDate } = req.query;
    const logs = await getLog(req.user.businessId, {
      limit:    Math.min(parseInt(limit) || 50, 200),
      offset:   parseInt(offset) || 0,
      userId:   userId   || null,
      action:   action   || null,
      fromDate: fromDate || null,
      toDate:   toDate   || null,
    });
    res.json(logs);
  } catch (err) { next(err); }
});

// GET /api/activity/actions — רשימת סוגי פעולות
router.get('/actions', requireAuth, requireManager, (_req, res) => {
  res.json(Object.values(ACTIONS));
});

module.exports = router;
