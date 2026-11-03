const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const db = require('../utils/db');
const eventBus = require('../utils/eventBus');

// Shared query fragment — LATERAL join replaces correlated subquery to avoid per-row execution
const MSG_SELECT = `
  SELECT m.*,
         u.full_name AS sender_name,
         ($1 = ANY(m.is_read_by)) AS is_read,
         COALESCE(readers.data, '[]') AS readers
    FROM user_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', ru.id, 'full_name', ru.full_name)) AS data
        FROM unnest(m.is_read_by) AS rid
        JOIN users ru ON ru.id = rid
       WHERE rid != m.sender_id
    ) readers ON true`;

// ── GET /api/messages — הודעות אחרונות (30 יום) ─────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `${MSG_SELECT}
       WHERE m.business_id = $2
         AND ($1 = ANY(m.recipient_ids) OR m.sender_id = $1)
         AND m.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.user.userId, req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/messages/history — היסטוריה עם pagination ──────
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0,   0);
    const { rows } = await db.query(
      `${MSG_SELECT}
       WHERE m.business_id = $2
         AND ($1 = ANY(m.recipient_ids) OR m.sender_id = $1)
       ORDER BY m.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.userId, req.user.businessId, limit, offset]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/messages/unread-count ───────────────────────────
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS count
         FROM user_messages
        WHERE business_id = $2
          AND $1 = ANY(recipient_ids)
          AND NOT ($1 = ANY(is_read_by))`,
      [req.user.userId, req.user.businessId]
    );
    res.json({ count: parseInt(rows[0].count) });
  } catch (err) { next(err); }
});

// ── POST /api/messages — שליחת הודעה ─────────────────────────
router.post('/', requireAuth, validate({ body: schemas.createMessageSchema }), async (req, res, next) => {
  try {
    const { recipientIds, content, groupName } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'תוכן ההודעה חסר' });
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      return res.status(400).json({ error: 'נמענים חסרים' });
    }

    const { rows: memberRows } = await db.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND business_id = $2`,
      [recipientIds, req.user.businessId]
    );
    if (memberRows.length !== recipientIds.length) {
      return res.status(400).json({ error: 'נמען אחד או יותר אינו שייך לעסק זה' });
    }

    const { rows } = await db.query(
      `INSERT INTO user_messages (business_id, sender_id, recipient_ids, content, group_name, is_read_by)
       VALUES ($1, $2, $3, $4, $5, ARRAY[$2]::uuid[]) RETURNING *`,
      [req.user.businessId, req.user.userId, recipientIds, content.trim(), groupName || null]
    );

    // SSE — eventBus.publish broadcasts to every client connected for this business
    // (no per-recipient filtering), so the payload must not carry message content;
    // clients that are actual recipients re-fetch via the recipient-scoped REST routes.
    eventBus.publish(req.user.businessId, 'new_message', {
      messageId:    rows[0].id,
      senderId:     req.user.userId,
      recipientIds,
    });

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/messages/:id/read — סימון כנקרא ─────────────────
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE user_messages
          SET is_read_by = ARRAY(SELECT DISTINCT unnest(is_read_by || ARRAY[$1]::uuid[]))
        WHERE id = $2 AND business_id = $3`,
      [req.user.userId, req.params.id, req.user.businessId]
    );
    // Notify sender in real-time that message was read
    const { rows: msgRows } = await db.query(
      `SELECT sender_id FROM user_messages WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.user.businessId]
    );
    if (msgRows.length > 0 && msgRows[0].sender_id !== req.user.userId) {
      eventBus.publish(req.user.businessId, 'message_read', {
        messageId:    req.params.id,
        readBy:       req.user.userId,
        readByName:   req.user.fullName || req.user.email,
        senderId:     msgRows[0].sender_id,
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/messages/:id — מחיקה (שולח בלבד) ─────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM user_messages WHERE id = $1 AND sender_id = $2 AND business_id = $3',
      [req.params.id, req.user.userId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'message_read', { action: 'deleted', messageId: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
