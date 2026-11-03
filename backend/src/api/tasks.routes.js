const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requireManager } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const { upload, UPLOAD_DIR, validateMagicBytes, buildUploadUrl } = require('../utils/upload');
const db = require('../utils/db');
const { withTransaction } = require('../utils/transaction');
const { addToGallery } = require('../services/gallery/gallery.service');
const eventBus = require('../utils/eventBus');

// הוסף עמודת approved_at אם לא קיימת
db.migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
db.migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_by TEXT`);
db.migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_photo TEXT`);

// GET /api/tasks — רשימת משימות לעסק (?history=1 לגרסת היסטוריה)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const history = req.query.history === '1';
    const { rows } = await db.query(
      `SELECT t.*,
              u.full_name  AS created_by_name,
              a.full_name  AS assigned_to_name,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id',               s.id,
                    'title',            s.title,
                    'status',           s.status,
                    'completed_by',     s.completed_by,
                    'completed_by_name',cb.full_name,
                    'completion_photo', s.completion_photo,
                    'completed_at',     s.completed_at
                  ) ORDER BY s.created_at
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) AS subtasks
         FROM tasks t
         JOIN users u ON u.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_to
    LEFT JOIN task_subtasks s ON s.task_id = t.id
    LEFT JOIN users cb ON cb.id = s.completed_by
        WHERE t.business_id = $1
          AND (${history ? 't.approved_at IS NOT NULL' : 't.approved_at IS NULL'})
        GROUP BY t.id, u.full_name, a.full_name
        ORDER BY t.created_at DESC
        LIMIT 500`,
      [req.user.businessId]
    );
    res.json({ tasks: rows });
  } catch (err) { next(err); }
});

// POST /api/tasks — יצירת משימה חדשה
router.post('/', requireAuth, requireManager, validate({ body: schemas.createTaskSchema }), async (req, res, next) => {
  try {
    const { title, description, assignedTo, priority, dueDate, subtasks } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'כותרת משימה חסרה' });

    const client = await db.getClient();
    let task;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO tasks (business_id, created_by, assigned_to, title, description, priority, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          req.user.businessId,
          req.user.userId,
          assignedTo || null,
          title.trim(),
          description?.trim() || null,
          priority || 'normal',
          dueDate || null,
        ]
      );
      task = rows[0];

      // הוסף תת-משימות אם נשלחו — באותה טרנזקציה
      const validSubs = (Array.isArray(subtasks) ? subtasks : []).map(s => s?.trim()).filter(Boolean);
      if (validSubs.length > 0) {
        const vals   = validSubs.map((_, i) => `($1,$${i + 2})`).join(',');
        const params = [task.id, ...validSubs];
        await client.query(`INSERT INTO task_subtasks (task_id, title) VALUES ${vals}`, params);
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }

    eventBus.publish(req.user.businessId, 'task.updated', { taskId: task.id, action: 'created' });
    res.status(201).json({ task });
  } catch (err) { next(err); }
});

// PUT /api/tasks/:id — עדכון משימה
router.put('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { title, description, assignedTo, priority, dueDate, status } = req.body;
    const { rows } = await db.query(
      `UPDATE tasks
          SET title       = COALESCE($1, title),
              description = COALESCE($2, description),
              assigned_to = $3,
              priority    = COALESCE($4, priority),
              due_date    = $5,
              status      = COALESCE($6, status),
              updated_at  = NOW()
        WHERE id = $7 AND business_id = $8
       RETURNING *`,
      [title, description, assignedTo || null, priority, dueDate || null, status, req.params.id, req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'משימה לא נמצאה' });
    eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'updated' });
    res.json({ task: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM tasks WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
    if (!rowCount) return res.status(404).json({ error: 'משימה לא נמצאה' });
    eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'deleted' });
    res.json({ message: 'משימה נמחקה' });
  } catch (err) { next(err); }
});

// POST /api/tasks/:id/subtasks — הוספת תת-משימה
router.post('/:id/subtasks', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'כותרת תת-משימה חסרה' });

    // וידוא שהמשימה שייכת לעסק
    const { rows: taskRows } = await db.query(
      'SELECT id FROM tasks WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!taskRows[0]) return res.status(404).json({ error: 'משימה לא נמצאה' });

    const { rows } = await db.query(
      'INSERT INTO task_subtasks (task_id, title) VALUES ($1,$2) RETURNING *',
      [req.params.id, title.trim()]
    );
    eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'subtask_added' });
    res.status(201).json({ subtask: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id/subtasks/:subId
router.delete('/:id/subtasks/:subId', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rows: taskRows } = await db.query(
      'SELECT id FROM tasks WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!taskRows[0]) return res.status(404).json({ error: 'משימה לא נמצאה' });
    // Include business_id atomically in the DELETE via EXISTS — prevents TOCTOU cross-business deletion
    await db.query(
      `DELETE FROM task_subtasks
       WHERE id = $1 AND task_id = $2
         AND EXISTS (SELECT 1 FROM tasks WHERE id = $2 AND business_id = $3)`,
      [req.params.subId, req.params.id, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'subtask_deleted' });
    res.json({ message: 'תת-משימה נמחקה' });
  } catch (err) { next(err); }
});

// POST /api/tasks/:id/subtasks/:subId/complete — סיום תת-משימה + העלאת תמונה
// מנהל ומעלה יכולים לסיים כל משימה; עובד רגיל יכול לסיים רק משימה שהוקצתה לו
router.post(
  '/:id/subtasks/:subId/complete',
  requireAuth,
  upload.single('photo'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'נדרשת תמונה לאישור ביצוע' });
      const validPhoto = await validateMagicBytes(req.file.path).catch(() => false);
      if (!validPhoto) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'סוג קובץ לא נתמך' });
      }

      // וידוא שהמשימה שייכת לעסק
      const { rows: taskRows } = await db.query(
        'SELECT id, title, assigned_to FROM tasks WHERE id = $1 AND business_id = $2',
        [req.params.id, req.user.businessId]
      );
      if (!taskRows[0]) return res.status(404).json({ error: 'משימה לא נמצאה' });
      const isManager = ['owner', 'partner', 'manager'].includes(req.user.role);
      if (!isManager && taskRows[0].assigned_to && taskRows[0].assigned_to !== req.user.userId) {
        return res.status(403).json({ error: 'ניתן לסיים רק משימות שהוקצו אליך' });
      }

      const photoPath = `/uploads/${req.file.filename}`;

      let completedSubtask;
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          `UPDATE task_subtasks
              SET status           = 'done',
                  completed_by     = $1,
                  completion_photo = $2,
                  completed_at     = NOW()
            WHERE id = $3 AND task_id = $4
           RETURNING *`,
          [req.user.userId, photoPath, req.params.subId, req.params.id]
        );
        if (!rows[0]) throw Object.assign(new Error('תת-משימה לא נמצאה'), { status: 404 });
        completedSubtask = rows[0];

        // אם כל תת-המשימות הושלמו — עדכן סטטוס משימה ל-done
        const { rows: remaining } = await client.query(
          `SELECT COUNT(*) AS cnt FROM task_subtasks WHERE task_id = $1 AND status = 'pending'`,
          [req.params.id]
        );
        if (parseInt(remaining[0].cnt) === 0) {
          await client.query(
            `UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1 AND business_id = $2`,
            [req.params.id, req.user.businessId]
          );
        } else {
          await client.query(
            `UPDATE tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND status = 'open' AND business_id = $2`,
            [req.params.id, req.user.businessId]
          );
        }
      });

      // fire-and-forget gallery sync (outside transaction)
      // gallery_items.image_url must be a full absolute URL (that's what the
      // gallery page assumes) — photoPath itself stays root-relative on
      // completion_photo since the tasks page prefixes it with BACKEND itself.
      addToGallery({
        businessId: req.user.businessId,
        imageUrl:   buildUploadUrl(req.file.filename),
        category:   'tasks',
        title:      taskRows[0].title,
        description: 'תמונת ביצוע: ' + (completedSubtask.title || ''),
        entityId:   completedSubtask.id,
        entityType: 'task_subtask',
        uploadDate: completedSubtask.completed_at,
      }).catch(() => {});

      eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'subtask_completed' });
      res.json({ subtask: completedSubtask, photoUrl: photoPath });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  }
);

// POST /api/tasks/:id/complete — סיום המשימה הראשית + תמונה
// מנהל ומעלה יכולים לסיים כל משימה; עובד רגיל יכול לסיים רק משימה שהוקצתה לו
router.post(
  '/:id/complete',
  requireAuth,
  upload.single('photo'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'נדרשת תמונה לאישור ביצוע' });
      const validPhoto = await validateMagicBytes(req.file.path).catch(() => false);
      if (!validPhoto) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'סוג קובץ לא נתמך' });
      }

      const { rows: taskRows } = await db.query(
        'SELECT id, title, assigned_to FROM tasks WHERE id = $1 AND business_id = $2',
        [req.params.id, req.user.businessId]
      );
      if (!taskRows[0]) return res.status(404).json({ error: 'משימה לא נמצאה' });
      const isManager = ['owner', 'partner', 'manager'].includes(req.user.role);
      if (!isManager && taskRows[0].assigned_to && taskRows[0].assigned_to !== req.user.userId) {
        return res.status(403).json({ error: 'ניתן לסיים רק משימות שהוקצו אליך' });
      }

      const photoPath = `/uploads/${req.file.filename}`;

      // מוסיף תת-משימה אוטומטית "ביצוע" עם תמונה
      const { rows: subRows } = await db.query(
        `INSERT INTO task_subtasks (task_id, title, status, completed_by, completion_photo, completed_at)
         VALUES ($1, 'ביצוע המשימה', 'done', $2, $3, NOW()) RETURNING id, completed_at`,
        [req.params.id, req.user.userId, photoPath]
      );

      // מסמן את המשימה כ-done
      const { rows } = await db.query(
        `UPDATE tasks SET status = 'done', updated_at = NOW()
          WHERE id = $1 AND business_id = $2 RETURNING *`,
        [req.params.id, req.user.businessId]
      );

      // fire-and-forget gallery sync — full absolute URL, see comment above
      addToGallery({
        businessId: req.user.businessId,
        imageUrl:   buildUploadUrl(req.file.filename),
        category:   'tasks',
        title:      taskRows[0].title,
        description: 'תמונת ביצוע משימה',
        entityId:   subRows[0]?.id,
        entityType: 'task_subtask',
        uploadDate: subRows[0]?.completed_at,
      }).catch(() => {});

      eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'completed' });
      res.json({ task: rows[0], photoUrl: photoPath });
    } catch (err) { next(err); }
  }
);

// GET /api/tasks/ai-suggest — הצעות משימות חכמות מנתוני העסק
router.get('/ai-suggest', requireAuth, requireManager, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const suggestions = [];

    const [lowInvRes, unmatchedRes, expiryRes, invoiceRes] = await Promise.all([
      db.query(
        `SELECT name, current_qty, min_qty FROM inventory_items
          WHERE business_id = $1 AND current_qty <= min_qty AND min_qty > 0
          ORDER BY (current_qty::float / NULLIF(min_qty,0)) ASC LIMIT 5`,
        [biz]
      ),
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM z_employee_records
          WHERE business_id = $1 AND employee_id IS NULL
          AND created_at >= NOW() - INTERVAL '7 days'`,
        [biz]
      ),
      db.query(
        `SELECT name, expiry_date FROM inventory_items
          WHERE business_id = $1
            AND expiry_date IS NOT NULL
            AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL '3 days'
          ORDER BY expiry_date ASC LIMIT 5`,
        [biz]
      ),
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM invoices
          WHERE business_id = $1 AND is_paid = false
          AND created_at <= NOW() - INTERVAL '7 days'`,
        [biz]
      ),
    ]);

    for (const item of lowInvRes.rows) {
      suggestions.push({
        title:       `הזמן מלאי: ${item.name}`,
        description: `כמות נוכחית ${item.current_qty} — הגיעה לרמת מינימום ${item.min_qty}`,
        priority:    'high',
        source:      'inventory',
      });
    }

    if ((unmatchedRes.rows[0]?.cnt || 0) > 0) {
      suggestions.push({
        title:       'התאמת עובדים בדוח Z',
        description: `${unmatchedRes.rows[0].cnt} רשומות עובדים לא הותאמו לעובד קיים`,
        priority:    'normal',
        source:      'zreport',
      });
    }

    for (const item of expiryRes.rows) {
      suggestions.push({
        title:       `פג תוקף קרוב: ${item.name}`,
        description: `פג תוקף ב-${new Date(item.expiry_date).toLocaleDateString('he-IL')} — תכנן שימוש`,
        priority:    'urgent',
        source:      'inventory',
      });
    }

    if ((invoiceRes.rows[0]?.cnt || 0) > 0) {
      suggestions.push({
        title:       'אישור חשבוניות ממתינות',
        description: `${invoiceRes.rows[0].cnt} חשבוניות ממתינות לאישור יותר מ-7 ימים`,
        priority:    'normal',
        source:      'invoices',
      });
    }

    // Remove suggestions that match existing active tasks
    const { rows: activeTasks } = await db.query(
      `SELECT title FROM tasks WHERE business_id = $1 AND approved_at IS NULL`,
      [biz]
    );
    const activeTitles = activeTasks.map(t => t.title.toLowerCase());
    const filtered = suggestions.filter(s =>
      !activeTitles.some(t => t.includes(s.title.slice(0, 15).toLowerCase()))
    );

    res.json({ suggestions: filtered });
  } catch (err) { next(err); }
});

// POST /api/tasks/:id/approve — מנהל מאשר משימה שהושלמה → עוברת להיסטוריה
router.post('/:id/approve', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE tasks SET approved_at = NOW(), approved_by = $1, updated_at = NOW()
        WHERE id = $2 AND business_id = $3 AND status = 'done'
       RETURNING *`,
      [req.user.userId, req.params.id, req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'משימה לא נמצאה או לא הושלמה' });
    eventBus.publish(req.user.businessId, 'task.updated', { taskId: req.params.id, action: 'approved' });
    res.json({ task: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
