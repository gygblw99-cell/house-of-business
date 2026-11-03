const express = require('express');
const router  = express.Router();
const { requireAuth, requireManager } = require('../middleware/auth');
const { registerToken, unregisterToken, sendToUser } = require('../services/notifications/push.service');
const db       = require('../utils/db');
const eventBus = require('../utils/eventBus');

// POST /api/notifications/token — רישום FCM token
router.post('/token', requireAuth, async (req, res, next) => {
  try {
    const { fcmToken, platform } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken חסר' });
    await registerToken(req.user.userId, fcmToken, platform || 'android');
    res.json({ message: 'Token נרשם' });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/token — ביטול FCM token
router.delete('/token', requireAuth, async (req, res, next) => {
  try {
    await unregisterToken(req.user.userId);
    res.json({ message: 'Token בוטל' });
  } catch (err) { next(err); }
});

// GET /api/notifications — התראות של המשתמש (pagination: ?limit=50&offset=0)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const { rows } = await db.query(
      `SELECT id, title, body, type, is_read, created_at
       FROM notifications
       WHERE user_id = $1 AND business_id = $2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.userId, req.user.businessId, limit, offset]
    );
    res.json({ notifications: rows });
  } catch (err) { next(err); }
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM notifications
       WHERE user_id = $1 AND business_id = $2 AND is_read = FALSE`,
      [req.user.userId, req.user.businessId]
    );
    res.json({ count: rows[0].count });
  } catch (err) { next(err); }
});

// PUT /api/notifications/:id/read — סימון כנקרא
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2 AND business_id = $3`,
      [req.params.id, req.user.userId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'read' });
    res.json({ message: 'סומן כנקרא' });
  } catch (err) { next(err); }
});

// PUT /api/notifications/read-all — סימון כולם כנקראו
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE user_id = $1 AND business_id = $2`,
      [req.user.userId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'read_all' });
    res.json({ message: 'כל ההתראות סומנו כנקראות' });
  } catch (err) { next(err); }
});

// DELETE /api/notifications/:id — מחיקת התראה
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 AND business_id = $3',
      [req.params.id, req.user.userId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'deleted' });
    res.json({ message: 'התראה נמחקה' });
  } catch (err) { next(err); }
});

// POST /api/notifications/send — שליחת Push ידנית (מנהל)
router.post('/send', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { userId, title, body } = req.body;
    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title ו-body הם שדות חובה' });
    }
    if (title.length > 200 || body.length > 1000) {
      return res.status(400).json({ error: 'כותרת או גוף ההתראה ארוכים מדי' });
    }

    // verify userId belongs to caller's business
    const { rows: [member] } = await db.query(
      'SELECT id FROM users WHERE id = $1 AND business_id = $2',
      [userId, req.user.businessId]
    );
    if (!member) return res.status(404).json({ error: 'משתמש לא נמצא בעסק זה' });

    // שמירה ב-DB
    await db.query(
      `INSERT INTO notifications (business_id, user_id, title, body, type)
       VALUES ($1,$2,$3,$4,'manual')`,
      [req.user.businessId, userId, title, body]
    );

    // שליחת Push
    const result = await sendToUser(userId, { title, body });
    eventBus.publish(req.user.businessId, 'notification', { userId, title });
    res.json({ message: 'התראה נשלחה', ...result });
  } catch (err) { next(err); }
});

module.exports = router;
