const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const db = require('../utils/db');
const eventBus = require('../utils/eventBus');
const { withTransaction } = require('../utils/transaction');

// migration — הוספת עמודות חדשות אם לא קיימות
db.migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS show_on_dashboard BOOLEAN DEFAULT FALSE`);
db.migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
db.migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
// Calendar page's "Add Event" modal collects an end time (implying a real
// duration) but there was nowhere to persist it — every event silently
// rendered as a hard-coded 1-hour block regardless of what the user picked.
db.migrate(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ`);

// ── GET /api/reminders ────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM reminders
        WHERE user_id = $1 AND business_id = $2
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY remind_at ASC
        LIMIT 200`,
      [req.user.userId, req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/reminders/history ────────────────────────────────
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM reminders
        WHERE user_id = $1 AND business_id = $2
          AND (deleted_at IS NOT NULL OR expires_at <= NOW() OR is_sent = TRUE)
        ORDER BY COALESCE(deleted_at, remind_at) DESC
        LIMIT 100`,
      [req.user.userId, req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/reminders/dashboard — תזכורות לדשבורד ──────────
router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM reminders
        WHERE user_id = $1 AND business_id = $2
          AND show_on_dashboard = TRUE
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND is_sent = FALSE
        ORDER BY remind_at ASC
        LIMIT 10`,
      [req.user.userId, req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/reminders ───────────────────────────────────────
router.post('/', requireAuth, validate({ body: schemas.createReminderSchema }), async (req, res, next) => {
  try {
    const { title, remindAt, showOnDashboard, expiresAt, endAt } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'כותרת חסרה' });
    if (!remindAt)       return res.status(400).json({ error: 'תאריך חסר' });
    const remindDate  = new Date(remindAt);
    if (isNaN(remindDate.getTime())) return res.status(400).json({ error: 'תאריך לא תקין' });
    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresDate && isNaN(expiresDate.getTime())) return res.status(400).json({ error: 'תאריך תפוגה לא תקין' });
    const endDate = endAt ? new Date(endAt) : null;
    if (endDate && isNaN(endDate.getTime())) return res.status(400).json({ error: 'שעת סיום לא תקינה' });
    const { rows } = await db.query(
      `INSERT INTO reminders (user_id, business_id, title, remind_at, show_on_dashboard, expires_at, end_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.userId, req.user.businessId, title.trim(), remindDate,
       !!showOnDashboard, expiresDate, endDate]
    );
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'reminder_created' });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/reminders/:id ────────────────────────────────────
router.put('/:id', requireAuth, validate({ body: schemas.updateReminderSchema }), async (req, res, next) => {
  try {
    const { title, remindAt, showOnDashboard, expiresAt, endAt } = req.body;
    // expiresAt is schema .optional().nullable() specifically so a client can
    // send null to intentionally clear it — but that's indistinguishable from
    // "omitted" once collapsed through `expiresAt ? new Date(expiresAt) : null`
    // (the old code), so ANY partial update that didn't resend expiresAt
    // silently wiped it. touchExpires checks whether the key was present in
    // the body at all, so an omitted field now leaves the column untouched.
    const touchExpires = Object.prototype.hasOwnProperty.call(req.body, 'expiresAt');
    const touchEnd     = Object.prototype.hasOwnProperty.call(req.body, 'endAt');
    const { rows } = await db.query(
      `UPDATE reminders
          SET title             = COALESCE($1, title),
              remind_at         = COALESCE($2, remind_at),
              show_on_dashboard = COALESCE($3, show_on_dashboard),
              expires_at        = CASE WHEN $4 THEN $5 ELSE expires_at END,
              end_at            = CASE WHEN $6 THEN $7 ELSE end_at END
        WHERE id = $8 AND user_id = $9 AND business_id = $10
        RETURNING *`,
      [title?.trim() || null,
       remindAt ? new Date(remindAt) : null,
       showOnDashboard != null ? !!showOnDashboard : null,
       touchExpires,
       expiresAt ? new Date(expiresAt) : null,
       touchEnd,
       endAt ? new Date(endAt) : null,
       req.params.id, req.user.userId, req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'תזכורת לא נמצאה' });
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'reminder_updated' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/reminders/:id — soft delete ───────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE reminders SET deleted_at = NOW()
        WHERE id = $1 AND user_id = $2 AND business_id = $3`,
      [req.params.id, req.user.userId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'notification', { userId: req.user.userId, action: 'reminder_deleted' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/reminders/smart-suggest ─────────────────────────
router.get('/smart-suggest', requireAuth, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const now = new Date();
    const suggestions = [];

    // 1. Payroll reminder — 2 days before the 25th
    const payrollDay = new Date(now.getFullYear(), now.getMonth(), 25);
    if (payrollDay <= now) payrollDay.setMonth(payrollDay.getMonth() + 1);
    const daysToPayroll = Math.round((payrollDay - now) / 86400000);
    if (daysToPayroll <= 7) {
      suggestions.push({
        title:       'תשלום משכורות',
        remind_at:   new Date(payrollDay.getTime() - 2 * 86400000).toISOString(),
        description: `תשלום משכורות מתוכנן ל-${payrollDay.toLocaleDateString('he-IL')}`,
        source:      'payroll',
      });
    }

    // 2. VAT filing — 3 days before 15th of bimonthly deadline
    const vatOffset = now.getMonth() % 2 === 0 ? 1 : 2;
    const vatDeadline = new Date(now.getFullYear(), now.getMonth() + vatOffset, 15);
    const daysToVat = Math.round((vatDeadline - now) / 86400000);
    if (daysToVat <= 14) {
      suggestions.push({
        title:       'הגשת דוח מע"מ',
        remind_at:   new Date(vatDeadline.getTime() - 3 * 86400000).toISOString(),
        description: `מועד הגשת דוח מע"מ: ${vatDeadline.toLocaleDateString('he-IL')}`,
        source:      'vat',
      });
    }

    // 3. Low inventory reorder reminder
    const { rows: lowInv } = await db.query(
      `SELECT name FROM inventory_items
        WHERE business_id = $1 AND current_qty <= min_qty AND min_qty > 0
        ORDER BY (current_qty::float / NULLIF(min_qty,0)) ASC LIMIT 3`,
      [biz]
    );
    if (lowInv.length > 0) {
      suggestions.push({
        title:       'הזמנת חומרי גלם',
        remind_at:   new Date(Date.now() + 86400000).toISOString(),
        description: `מלאי נמוך: ${lowInv.map(i => i.name).join(', ')}`,
        source:      'inventory',
      });
    }

    // 4. Overdue supplier invoices
    const { rows: supplierRows } = await db.query(
      `SELECT s.name, COUNT(i.id)::int AS cnt
        FROM invoices i
        JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.business_id = $1 AND i.is_paid = false
          AND i.created_at <= NOW() - INTERVAL '14 days'
        GROUP BY s.name ORDER BY cnt DESC LIMIT 2`,
      [biz]
    );
    for (const row of supplierRows) {
      suggestions.push({
        title:       `תשלום לספק: ${row.name}`,
        remind_at:   new Date(Date.now() + 2 * 86400000).toISOString(),
        description: `${row.cnt} חשבוניות ממתינות לתשלום`,
        source:      'suppliers',
      });
    }

    // Filter out titles already in active reminders
    const { rows: existing } = await db.query(
      `SELECT title FROM reminders
        WHERE user_id = $1 AND business_id = $2
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
          AND remind_at > NOW()`,
      [req.user.userId, biz]
    );
    const existingTitles = existing.map(r => r.title.toLowerCase());
    const filtered = suggestions.filter(s => !existingTitles.includes(s.title.toLowerCase()));

    res.json({ suggestions: filtered });
  } catch (err) { next(err); }
});

// ── POST /api/reminders/check ─────────────────────────────────
// This raced with reminder.scheduler.js's own background checkReminders():
// both UPDATE the same rows under the same "remind_at <= NOW() AND
// is_sent = FALSE" guard, so whichever won the race consumed the reminder.
// This route only flipped is_sent — it never inserted into notifications or
// published the SSE event the scheduler does — so a reminder "won" by this
// route was marked sent (disappearing from GET / and /dashboard) with no
// notification ever created, and no retry since is_sent already blocks it.
// Now mirrors the scheduler's transactional mark-sent + notify pattern.
router.post('/check', requireAuth, async (req, res, next) => {
  try {
    const rows = await withTransaction(async (client) => {
      const { rows: due } = await client.query(
        `UPDATE reminders SET is_sent = TRUE
          WHERE user_id = $1 AND business_id = $2 AND remind_at <= NOW() AND is_sent = FALSE
          RETURNING *`,
        [req.user.userId, req.user.businessId]
      );
      if (!due.length) return due;
      const vals   = [];
      const params = [];
      due.forEach((reminder, i) => {
        const base = i * 4;
        vals.push(`($${base+1},$${base+2},'reminder',$${base+3},$${base+4})`);
        params.push(reminder.business_id, reminder.user_id, `תזכורת: ${reminder.title}`, reminder.title);
      });
      await client.query(
        `INSERT INTO notifications (business_id, user_id, type, title, body) VALUES ${vals.join(',')}`,
        params
      );
      return due;
    });

    for (const reminder of rows) {
      eventBus.publish(req.user.businessId, 'notification', { type: 'reminder', title: `תזכורת: ${reminder.title}`, userId: req.user.userId });
    }
    res.json({ triggered: rows.length, reminders: rows });
  } catch (err) { next(err); }
});

module.exports = router;
