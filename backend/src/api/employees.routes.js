const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const multer  = require('multer');
const logger  = require('../utils/logger');
const { requireAuth, requireManager, requireOwner, requirePermission } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const userModel    = require('../models/user.model');
const shiftModel   = require('../models/shift.model');
const { parseShiftsFile } = require('../services/zreport.import.service');

const shiftFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx?|csv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error('סוג קובץ לא נתמך — נא לעלות Excel, CSV, או TXT'), ok);
  },
});
const { checkMinWage, calcExpectedSalary } = require('../services/employees/salary.calculator');
const { resendPayslip, sendMonthlyPayslips } = require('../services/employees/payslip.service');
const { getLaborAlerts }       = require('../services/employees/laborLaw.service');
const { paginated }     = require('../utils/apiResponse');
const { parseIntRange } = require('../utils/parseQuery');
const { getShiftSuggestions }  = require('../services/employees/shiftSuggestions.service');
const db     = require('../utils/db');
const bcrypt = require('bcryptjs');
const { generateInsights, storeInsights } = require('../agents/autoInsights.agent');
const eventBus = require('../utils/eventBus');
const { sendEmployeeInvite } = require('../services/notifications/email.service');
const cache  = require('../utils/cache');
const { bustContextCache } = require('../services/ai/business.context');
const { onShiftChanged } = require('../services/sync.service');
const { withTransaction } = require('../utils/transaction');

// Unique partial index — prevents race condition where two concurrent clock-in
// requests both pass the findActiveShift check and both insert a shift
db.migrate(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_active_per_employee
  ON shifts (business_id, employee_id)
  WHERE status = 'active' AND actual_end IS NULL
`).catch(() => {});

// position = תפקיד מפורט (שף/מלצר/ברמן וכו') — נפרד מ-role שהוא רק דרג הרשאה
// (owner/partner/manager/employee, מוגבל ב-CHECK constraint על הטבלה)
db.migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(50)`).catch(() => {});

// כשעובד עם שכר גלובלי/חודשי מושבת, דוחות כספיים היסטוריים (P&L, pl-streams,
// daily-breakdown) נהגו לסנן לפי is_active=TRUE בלבד — מה שמחק את עלות השכר
// שלו רטרואקטיבית גם מחודשים שבהם הוא עדיין היה פעיל ומשולם. deactivated_at
// נותן לשאילתות האלה סמן אמין: "היה פעיל בחודש X" = נוצר לפני סוף החודש וגם
// (עדיין פעיל עכשיו, או הושבת בחודש X או אחריו).
db.migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`).catch(() => {});

// expand salary_type CHECK to include 'monthly' and 'tips' (tips-only employees)
// NOTE: tips.routes.js also runs this migration to add 'tips' — DROP+ADD is idempotent
db.migrate(`
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_salary_type_check;
  ALTER TABLE users ADD CONSTRAINT users_salary_type_check
    CHECK (salary_type IN ('hourly','global','monthly','tips'))
`).catch(() => {});

// ── QR Clock-in helpers ───────────────────────────────────────
// QR_SECRET is dedicated so QR token derivation is decoupled from JWT signing.
// Falls back to JWT_SECRET only when QR_SECRET is not set (backward compat).
const QR_SECRET = process.env.QR_SECRET || process.env.JWT_SECRET;
if (!QR_SECRET) throw new Error('JWT_SECRET env variable is required');

function _qrToken(businessId) {
  // מתחלף כל 5 דקות
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  return crypto.createHmac('sha256', QR_SECRET)
    .update(`${businessId}:${bucket}`)
    .digest('hex').slice(0, 20);
}

function _verifyQrToken(businessId, token) {
  const secret = QR_SECRET;
  const now    = Date.now();
  const bucket = Math.floor(now / (5 * 60 * 1000));
  // קבל token נוכחי ואחד אחורה (כדי לא לנפול בגבול)
  for (const b of [bucket, bucket - 1]) {
    const expected = crypto.createHmac('sha256', secret)
      .update(`${businessId}:${b}`)
      .digest('hex').slice(0, 20);
    if (token === expected) return true;
  }
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EMPLOYEE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/employees — כל העובדים
router.get('/', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const limit  = parseIntRange(req.query.limit,  1, 500, 200);
    const offset = parseIntRange(req.query.offset, 0, 1e9,   0);
    // Opt-in — other consumers of this route (shifts/tasks/messages pages)
    // keep seeing everyone unless they explicitly ask for active-only, so
    // this doesn't silently change behavior anywhere but the employees page.
    const activeOnly = req.query.activeOnly === 'true';
    const activeFilter = activeOnly ? ' AND u.is_active = TRUE' : '';

    const [empRows, countRow] = await Promise.all([
      db.query(
        `SELECT u.id, u.role, u.position, u.full_name, u.username, u.email, u.phone,
                u.is_active, u.pending_invite,
                u.salary_type, u.salary_amount, u.tax_credit_points, u.participates_in_tips, u.created_at,
                COALESCE(zr.hours_30d,   0)::float AS zreport_hours_30d,
                COALESCE(zr.hours_total, 0)::float AS zreport_hours_total,
                COALESCE(zr.shift_count, 0)::int   AS zreport_shifts
         FROM users u
         LEFT JOIN (
           SELECT employee_id,
                  SUM(CASE WHEN report_date >= NOW() - INTERVAL '30 days'
                           THEN total_hours ELSE 0 END)   AS hours_30d,
                  SUM(total_hours)                         AS hours_total,
                  COUNT(*)::int                            AS shift_count
           FROM z_report_shifts
           WHERE business_id = $1
           GROUP BY employee_id
         ) zr ON zr.employee_id = u.id
         WHERE u.business_id = $1${activeFilter}
         ORDER BY u.created_at ASC
         LIMIT $2 OFFSET $3`,
        [req.user.businessId, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM users u WHERE u.business_id = $1${activeFilter}`, [req.user.businessId]),
    ]);

    const employees = empRows.rows;
    const total = countRow.rows[0].total;
    res.json({ employees, items: employees, total, limit, offset, hasMore: offset + employees.length < total });
  } catch (err) { next(err); }
});

// POST /api/employees — הוספת עובד + שליחת קישור
router.post('/', requireAuth, requireManager, validate({ body: schemas.createEmployeeSchema }), async (req, res, next) => {
  try {
    const { fullName, email, phone, role, position, salaryType, salaryAmount, taxCreditPoints, participatesInTips, username, password } = req.body;

    // בדיקת שכר מינימום — חוסם שמירה (עובדי טיפים פטורים — שכרם הוא הטיפים בלבד)
    const parsedSalary = salaryAmount || 0;
    if (salaryType !== 'tips') {
      if (parsedSalary <= 0) {
        return res.status(400).json({ error: 'שכר לא חוקי — חייב להיות מספר חיובי' });
      }
      const minCheck = checkMinWage(salaryType, parsedSalary);
      if (!minCheck.valid) {
        return res.status(400).json({
          error: `שכר נמוך משכר מינימום (₪${minCheck.minRequired} ל${minCheck.type === 'hourly' ? 'שעה' : 'חודש'})`,
          minRequired: minCheck.minRequired,
        });
      }
    }

    // אם המנהל מילא שם משתמש + סיסמה — יוצרים חשבון פעיל מיידית עם הפרטים
    // האלה (בלי הזמנה במייל). אחרת — נשמרת התנהגות ההזמנה הקיימת.
    const directCredentials = !!(username && password);

    if (directCredentials) {
      const { rows: dupe } = await db.query('SELECT id FROM users WHERE LOWER(username) = $1', [username]);
      if (dupe[0]) return res.status(409).json({ error: 'שם המשתמש כבר תפוס — בחר שם אחר' });
    }

    let rows;
    let inviteUrl = null;

    if (directCredentials) {
      const passwordHash = await bcrypt.hash(password, 12);
      try {
        ({ rows } = await db.query(
          `INSERT INTO users
             (business_id, role, position, full_name, email, phone,
              salary_type, salary_amount, tax_credit_points, participates_in_tips,
              username, password_hash, pending_invite, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,TRUE) RETURNING id`,
          [req.user.businessId, role || 'employee', position || null, fullName, email, phone || null,
           salaryType, parseFloat(salaryAmount), taxCreditPoints === undefined || taxCreditPoints === null || taxCreditPoints === '' ? 2.25 : parseFloat(taxCreditPoints),
           !!participatesInTips, username, passwordHash]
        ));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'שם המשתמש כבר תפוס — בחר שם אחר' });
        throw err;
      }
    } else {
      // יצירת token לקישור הזמנה (24 שעות)
      const inviteToken   = crypto.randomBytes(32).toString('hex');
      const inviteExpires = new Date(Date.now() + 24 * 3600 * 1000);
      const tempPassword  = crypto.randomBytes(8).toString('hex');
      const passwordHash  = await bcrypt.hash(tempPassword, 12);

      ({ rows } = await db.query(
        `INSERT INTO users
           (business_id, role, position, full_name, email, phone,
            salary_type, salary_amount, tax_credit_points, participates_in_tips,
            password_hash, invite_token, invite_expires_at, pending_invite, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,FALSE) RETURNING id`,
        [req.user.businessId, role || 'employee', position || null, fullName, email, phone || null,
         salaryType, parseFloat(salaryAmount), taxCreditPoints === undefined || taxCreditPoints === null || taxCreditPoints === '' ? 2.25 : parseFloat(taxCreditPoints),
         !!participatesInTips, passwordHash, inviteToken, inviteExpires]
      ));

      // שלח מייל עם קישור הזמנה לעובד
      const _appBase = process.env.APP_URL || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3002' : '');
      if (!_appBase) logger.warn('[Employees] APP_URL not set — invite link will be empty');
      inviteUrl = `${_appBase}/join?token=${inviteToken}`;
      const bizRow = await db.query('SELECT name FROM businesses WHERE id = $1', [req.user.businessId]);
      const businessName = bizRow.rows[0]?.name || 'העסק';
      sendEmployeeInvite({ to: email, fullName, businessName, inviteUrl }).catch(e =>
        logger.error('[Employees] invite email failed', { err: e.message })
      );
    }

    bustContextCache(req.user.businessId).catch(() => {});
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'created', employeeId: rows[0].id });
    res.status(201).json({
      employeeId: rows[0].id,
      message:    directCredentials ? 'עובד נוסף — ניתן להתחבר מיד עם שם המשתמש והסיסמה שהוגדרו' : 'עובד נוסף — קישור הזמנה נשלח למייל',
    });
  } catch (err) { next(err); }
});

// PUT /api/employees/bulk-status — סימון מספר עובדים כפעילים/לא פעילים בבת אחת
// (registered before /:id so Express doesn't match "bulk-status" as an :id param)
router.put('/bulk-status', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { ids, isActive } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'לא נבחרו עובדים' });
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'ערך סטטוס לא תקין' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ids.every(id => typeof id === 'string' && UUID_RE.test(id))) {
      return res.status(400).json({ error: 'מזהה עובד לא תקין' });
    }

    // Same protection as the single-employee edit route above — a plain
    // manager must not be able to deactivate an owner's/partner's account.
    if (!['owner', 'partner'].includes(req.user.role)) {
      const { rows: targets } = await db.query(
        `SELECT role FROM users WHERE id = ANY($1) AND business_id = $2`,
        [ids, req.user.businessId]
      );
      if (targets.some(t => ['owner', 'partner'].includes(t.role))) {
        return res.status(403).json({ error: 'הרשאה: לא ניתן לערוך בעל עסק/שותף' });
      }
    }

    // Only touches is_active — salary/hourly-rate fields are left completely
    // intact, so historical payroll math (שעות Z) for a deactivated employee
    // keeps working correctly. deactivated_at is also kept in sync here (not
    // just in userModel.deactivate()) so historical financial queries can
    // still count a global/monthly-salaried employee's cost for months
    // before this bulk action deactivated them.
    const { rows } = await db.query(
      `UPDATE users SET is_active = $1, updated_at = NOW(),
              deactivated_at = CASE WHEN $1 THEN NULL ELSE NOW() END
       WHERE id = ANY($2) AND business_id = $3
       RETURNING id`,
      [isActive, ids, req.user.businessId]
    );

    bustContextCache(req.user.businessId).catch(() => {});
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'bulk_status', count: rows.length, isActive });
    res.json({ updated: rows.length });
  } catch (err) { next(err); }
});

// PUT /api/employees/:id — עריכת עובד
router.put('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    // A plain manager must not be able to edit an owner's/partner's own
    // account (email, phone, salary, is_active) — that's how a manager could
    // hijack the owner's login email and take over the account via
    // forgot-password. Mirrors why /:id/hard already requires requireOwner.
    if (!['owner', 'partner'].includes(req.user.role)) {
      const target = await userModel.findById(req.params.id, req.user.businessId);
      if (target && ['owner', 'partner'].includes(target.role)) {
        return res.status(403).json({ error: 'הרשאה: לא ניתן לערוך בעל עסק/שותף' });
      }
    }

    const { salaryType, salaryAmount } = req.body;

    // If only salaryAmount is provided without salaryType, fetch the existing type
    // from the DB so the min-wage check cannot be bypassed by a partial update.
    let effectiveSalaryType = salaryType;
    if (!effectiveSalaryType && salaryAmount) {
      const { rows: existing } = await db.query(
        'SELECT salary_type FROM users WHERE id=$1 AND business_id=$2',
        [req.params.id, req.user.businessId]
      );
      effectiveSalaryType = existing[0]?.salary_type;
    }

    // tips-only employees have no base salary — skip min-wage check entirely
    if (effectiveSalaryType && effectiveSalaryType !== 'tips' && salaryAmount) {
      const parsedSalary = parseFloat(salaryAmount);
      if (isNaN(parsedSalary) || parsedSalary <= 0) {
        return res.status(400).json({ error: 'שכר לא חוקי — חייב להיות מספר חיובי' });
      }
      const minCheck = checkMinWage(effectiveSalaryType, parsedSalary);
      if (!minCheck.valid) {
        return res.status(400).json({
          error:       `שכר נמוך משכר מינימום (₪${minCheck.minRequired})`,
          minRequired: minCheck.minRequired,
        });
      }
    }

    const allowed = ['full_name','email','phone','role','position','salary_type','salary_amount','tax_credit_points','is_active','participates_in_tips'];
    const NUMERIC_FIELDS = ['salary_amount','tax_credit_points'];
    const fields  = Object.fromEntries(
      Object.entries(req.body)
        .map(([k, v]) => [k.replace(/([A-Z])/g, '_$1').toLowerCase(), v])
        .filter(([k, v]) => allowed.includes(k) && v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => [k, NUMERIC_FIELDS.includes(k) ? parseFloat(v) : v])
        .filter(([k, v]) => !NUMERIC_FIELDS.includes(k) || !isNaN(v))
    );

    // role כאן הוא רק דרג הרשאה — אסור לאפשר קידום ל-owner/partner דרך נתיב עריכת
    // עובד כללי (בדיוק כמו ב-POST); שינוי בעלות על עסק צריך זרימה ייעודית ומאובטחת יותר
    if ('role' in fields && !['employee', 'manager'].includes(fields.role)) {
      return res.status(400).json({ error: 'role לא חוקי — מותר employee או manager בלבד' });
    }

    const updated = await userModel.update(req.params.id, req.user.businessId, fields);
    if (!updated) return res.status(404).json({ error: 'עובד לא נמצא' });
    res.json(updated);

    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'updated', employeeId: req.params.id });
    bustContextCache(req.user.businessId).catch(() => {});
    // Regenerate insights when salary data changes (config warnings may shift)
    if (fields.salary_type || fields.salary_amount) {
      const bizId = req.user.businessId;
      generateInsights(bizId)
        .then(fresh => storeInsights(bizId, fresh))
        .catch(() => {});
    }
  } catch (err) { next(err); }
});

// DELETE /api/employees/:id — הסרה רגילה (היסטוריה נשמרת)
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    // Same protection as PUT /:id above — a plain manager must not be able
    // to deactivate (lock out) an owner/partner account.
    if (!['owner', 'partner'].includes(req.user.role)) {
      const target = await userModel.findById(req.params.id, req.user.businessId);
      if (target && ['owner', 'partner'].includes(target.role)) {
        return res.status(403).json({ error: 'הרשאה: לא ניתן להסיר בעל עסק/שותף' });
      }
    }

    await userModel.deactivate(req.params.id, req.user.businessId);
    bustContextCache(req.user.businessId).catch(() => {});
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'deactivated', employeeId: req.params.id });
    res.json({ message: 'עובד הוסר — היסטוריית משמרות נשמרת' });
  } catch (err) { next(err); }
});

// DELETE /api/employees/:id/hard — מחיקה מלאה (בלתי הפיכה) — בעל עסק/שותף בלבד,
// כי מנהל רגיל לא אמור להיות מסוגל למחוק לצמיתות משתמש אחר כולל בעל העסק עצמו.
router.delete('/:id/hard', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await userModel.hardDelete(req.params.id, req.user.businessId);
    bustContextCache(req.user.businessId).catch(() => {});
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'deleted', employeeId: req.params.id });
    res.json({ message: 'עובד נמחק לצמיתות' });
  } catch (err) { next(err); }
});

// GET /api/employees/:id/expected-salary — שכר צפוי
router.get('/:id/expected-salary', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const employee = await userModel.findById(req.params.id, req.user.businessId);
    if (!employee) return res.status(404).json({ error: 'עובד לא נמצא' });
    // Same protection as PUT /:id — a plain manager (or an employee granted
    // the 'employees' permission flag) must not be able to read the
    // owner's/partner's actual gross/net salary.
    if (!['owner', 'partner'].includes(req.user.role) && ['owner', 'partner'].includes(employee.role)) {
      return res.status(403).json({ error: 'הרשאה: לא ניתן לצפות בשכר בעל עסק/שותף' });
    }

    const now     = new Date();
    const summary = await shiftModel.getMonthlySummary(
      req.params.id, req.user.businessId, now.getFullYear(), now.getMonth() + 1
    );
    const shifts = summary?.shifts || [];
    const result = calcExpectedSalary(shifts, employee);
    res.json(result);
  } catch (err) { next(err); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SHIFTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/employees/shifts — כל המשמרות (מנהל)
router.get('/shifts', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { fromDate, toDate, employeeId, days } = req.query;
    let from = fromDate;
    if (!from && days) {
      // Israel calendar date, not UTC — toISOString() rolls over 2-3 hours
      // early relative to Israel's midnight, which could exclude today's
      // shifts from a "last N days" query during those early morning hours.
      const d = new Date(Date.now() - parseInt(days) * 86_400_000);
      from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
    }
    const shifts = await shiftModel.findByBusiness(req.user.businessId, { fromDate: from, toDate, employeeId });
    res.json({ shifts });
  } catch (err) { next(err); }
});

// GET /api/employees/shifts/my-active — משמרת פעילה של המשתמש המחובר
router.get('/shifts/my-active', requireAuth, async (req, res, next) => {
  try {
    const shift = await shiftModel.findActiveShift(req.user.userId, req.user.businessId);
    res.json({ shift: shift || null });
  } catch (err) { next(err); }
});

// GET /api/employees/qr — מחזיר token + URL לכניסה ב-QR (מנהל בלבד)
router.get('/qr', requireAuth, requireManager, (req, res) => {
  const token     = _qrToken(req.user.businessId);
  const appUrl    = process.env.APP_URL || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3002' : '');
  if (!appUrl) logger.warn('[QR] APP_URL not set — QR clock-in URL will be empty');
  const clockInUrl = `${appUrl}/clock-in?b=${req.user.businessId}&t=${token}`;
  // תוקף: עד סוף ה-5 דקות הנוכחיות
  const bucket    = Math.floor(Date.now() / (5 * 60 * 1000));
  const expiresAt = new Date((bucket + 1) * 5 * 60 * 1000).toISOString();
  res.json({ clockInUrl, expiresAt });
});

// POST /api/employees/shifts/clock-in-qr — כניסה ב-QR (עובד)
router.post('/shifts/clock-in-qr', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'QR token חסר' });

    if (!_verifyQrToken(req.user.businessId, token)) {
      return res.status(403).json({ error: 'QR לא תקין או פג תוקף — בקש מהמנהל לרענן', code: 'QR_EXPIRED' });
    }

    const active = await shiftModel.findActiveShift(req.user.userId, req.user.businessId);
    if (active) return res.status(409).json({ error: 'כבר קיימת משמרת פעילה', shift: active });

    let shift;
    try {
      const { rows } = await db.query(
        `INSERT INTO shifts (business_id, employee_id, actual_start, status, location_verified)
         VALUES ($1, $2, NOW(), 'active', TRUE) RETURNING *`,
        [req.user.businessId, req.user.userId]
      );
      shift = rows[0];
    } catch (insertErr) {
      // Unique index violation — race condition: another request just inserted
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'כבר קיימת משמרת פעילה', code: 'ALREADY_ACTIVE' });
      }
      throw insertErr;
    }
    eventBus.publish(req.user.businessId, 'shift_opened', { shiftId: shift.id, employeeId: req.user.userId, source: 'qr' });
    res.status(201).json(shift);
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/clock-in — מנותב ל-QR בלבד
router.post('/shifts/clock-in', requireAuth, (req, res) => {
  res.status(400).json({
    error: 'כניסה למשמרת מתבצעת דרך קוד QR בלבד. אנא סרוק את הקוד המוצב במקום.',
    code: 'QR_REQUIRED',
  });
});

// POST /api/employees/shifts/clock-out — יציאה ממשמרת
router.post('/shifts/clock-out', requireAuth, async (req, res, next) => {
  try {
    const active = await shiftModel.findActiveShift(req.user.userId, req.user.businessId);
    if (!active) return res.status(404).json({ error: 'אין משמרת פעילה' });

    const shift = await shiftModel.clockOut(active.id, req.user.businessId);

    const hours = shift.actual_end && shift.actual_start
      ? (new Date(shift.actual_end) - new Date(shift.actual_start)) / 3_600_000
      : 0;
    eventBus.publish(req.user.businessId, 'shift_closed', { shiftId: shift.id, hoursWorked: parseFloat(hours.toFixed(2)) });
    onShiftChanged(req.user.businessId).catch(() => {});
    res.json({ ...shift, hoursWorked: parseFloat(hours.toFixed(2)) });
  } catch (err) { next(err); }
});

// GET /api/employees/shifts/my-history — היסטוריית משמרות של העובד המחובר
router.get('/shifts/my-history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, actual_start, actual_end, status,
              ROUND(EXTRACT(EPOCH FROM (actual_end - actual_start)) / 3600, 2)::float AS hours_worked
       FROM shifts
       WHERE employee_id = $1
         AND business_id = $2
         AND status = 'completed'
         AND actual_start IS NOT NULL
         AND actual_end IS NOT NULL
       ORDER BY actual_start DESC
       LIMIT 90`,
      [req.user.userId, req.user.businessId]
    );
    res.json({ shifts: rows });
  } catch (err) { next(err); }
});

// GET /api/employees/shifts/active — עובדים פעילים עכשיו (מנהל)
router.get('/shifts/active', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT sh.id,
              sh.actual_start AS start_time,
              u.full_name     AS employee_name,
              EXTRACT(EPOCH FROM (NOW() - sh.actual_start)) / 3600 AS hours_so_far
       FROM shifts sh
       INNER JOIN users u ON u.id = sh.employee_id
       WHERE sh.business_id = $1 AND sh.status = 'active'
       ORDER BY sh.actual_start ASC`,
      [req.user.businessId]
    );
    res.json({ shifts: rows });
  } catch (err) { next(err); }
});

// PUT /api/employees/shifts/:id — עריכת שעות (מנהל)
router.put('/shifts/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    // תומך בשני פורמטים: actualStart/actualEnd ו-startTime/endTime
    const actualStart = req.body.actualStart || req.body.startTime;
    const actualEnd   = req.body.actualEnd   || req.body.endTime;
    const editNote    = req.body.editNote    || req.body.notes || null;
    if (!actualEnd) return res.status(400).json({ error: 'שעת יציאה נדרשת' });

    // שמור start קיים אם לא סופק חדש
    if (!actualStart) {
      const { rows } = await db.query(
        'SELECT actual_start FROM shifts WHERE id = $1 AND business_id = $2',
        [req.params.id, req.user.businessId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'משמרת לא נמצאה' });
      req.body.actualStart = rows[0].actual_start;
    }

    // Same bounds as POST /shifts/manual — this route had none, so a manager
    // could save actualEnd before actualStart (negative hours_worked) or a
    // multi-day span, silently corrupting monthly hours/salary calculations.
    const finalStart = new Date(actualStart || req.body.actualStart);
    const finalEnd   = new Date(actualEnd);
    if (isNaN(finalStart.getTime()) || isNaN(finalEnd.getTime())) {
      return res.status(400).json({ error: 'תאריכים לא תקינים' });
    }
    if (finalEnd <= finalStart) {
      return res.status(400).json({ error: 'שעת יציאה חייבת להיות אחרי שעת כניסה' });
    }
    if ((finalEnd - finalStart) / 3_600_000 > 24) {
      return res.status(400).json({ error: 'משמרת לא יכולה לעלות על 24 שעות' });
    }

    const shift = await shiftModel.editHours(req.params.id, req.user.businessId, {
      actualStart: actualStart || req.body.actualStart,
      actualEnd,
      editedBy: req.user.userId,
      editNote,
    });
    eventBus.publish(req.user.businessId, 'shift_closed', { shiftId: req.params.id, action: 'edited' });
    onShiftChanged(req.user.businessId).catch(() => {});
    res.json(shift);
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/absent — סימון היעדרות
router.post('/shifts/absent', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { employeeId, date, reason } = req.body;
    if (!employeeId || !date || !['vacation','sick'].includes(reason)) {
      return res.status(400).json({ error: 'פרמטרים שגויים' });
    }
    const shift = await shiftModel.markAbsent(employeeId, req.user.businessId, date, reason);
    // markAbsent's ON CONFLICT ... DO NOTHING now matches a real unique index
    // (backend/src/db/bootstrap.js), so a repeat call for the same
    // employee/date legitimately returns no row instead of always inserting.
    if (!shift) {
      return res.status(200).json({ message: 'היעדרות כבר סומנה לתאריך זה', alreadyMarked: true });
    }
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'absence_marked', employeeId, date, reason });
    res.status(201).json(shift);
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/manual — הוספת משמרת ידנית (ללא הגבלת תאריך, כולל היסטורי)
router.post('/shifts/manual', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { employeeId, actualStart, actualEnd, editNote } = req.body;
    if (!employeeId || !actualStart || !actualEnd) {
      return res.status(400).json({ error: 'employeeId, actualStart ו-actualEnd הם שדות חובה' });
    }
    const start = new Date(actualStart);
    const end   = new Date(actualEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'תאריכים לא תקינים' });
    }
    if (end <= start) {
      return res.status(400).json({ error: 'שעת יציאה חייבת להיות אחרי שעת כניסה' });
    }
    if ((end - start) / 3_600_000 > 24) {
      return res.status(400).json({ error: 'משמרת לא יכולה לעלות על 24 שעות' });
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(employeeId)) return res.status(400).json({ error: 'employeeId לא תקין' });

    const shift = await shiftModel.createManual(req.user.businessId, employeeId, {
      actualStart: start, actualEnd: end, editNote: editNote || null,
    });
    if (!shift) return res.status(404).json({ error: 'עובד לא נמצא' });
    eventBus.publish(req.user.businessId, 'shift_closed', { shiftId: shift.id, employeeId, action: 'manual_created' });
    cache.del(`employee-perf:${req.user.businessId}:*`).catch(() => {});
    onShiftChanged(req.user.businessId).catch(() => {});
    res.status(201).json(shift);
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/plan — תכנון משמרת עתידית
router.post('/shifts/plan', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { employeeId, plannedStart, plannedEnd } = req.body;
    const shift = await shiftModel.planShift(req.user.businessId, employeeId, { plannedStart, plannedEnd });
    if (!shift) return res.status(404).json({ error: 'עובד לא נמצא' });
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'shift_planned', employeeId });
    res.status(201).json(shift);
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/upload-report — ייבוא ידני של דוח משמרות (Excel/CSV מחברת הקופה)
router.post('/shifts/upload-report', requireAuth, requireManager, shiftFileUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });

    const bizId      = req.user.businessId;
    const { buffer, originalname } = req.file;
    // fallbackDate: used for shifts that have no date in the file
    const fallbackDate = req.body.reportDate || new Date().toISOString().split('T')[0];

    const { shifts: parsed } = parseShiftsFile(buffer, originalname);
    if (!parsed.length) {
      return res.status(400).json({ error: 'לא נמצאו נתוני משמרות בקובץ — בדוק שהקובץ מכיל טבלת עובדים/שעות' });
    }

    // Resolve each shift's date
    const toDateStr = (d) => {
      if (!d) return fallbackDate;
      const dt = d instanceof Date ? d : new Date(d);
      return isNaN(dt.getTime()) ? fallbackDate : dt.toISOString().split('T')[0];
    };
    const shiftsWithDates = parsed
      .filter(s => s.employeeName && String(s.employeeName).trim())
      .map(s => ({
        ...s,
        employeeName: String(s.employeeName).trim(),
        dateStr: toDateStr(s.shiftDate),
      }));

    if (!shiftsWithDates.length) {
      return res.status(400).json({ error: 'לא נמצאו שורות עם שם עובד בקובץ' });
    }

    // Scope duplicate-check queries to the actual date range in the file
    const fileDates = shiftsWithDates.map(s => s.dateStr).sort();
    const fileMinDate = fileDates[0];
    const fileMaxDate = fileDates[fileDates.length - 1];

    // Bulk-match employee names to users
    const empNames = [...new Set(shiftsWithDates.map(s => s.employeeName.toLowerCase()))];
    const { rows: empRows } = await db.query(
      `SELECT id, LOWER(full_name) AS lname, full_name, salary_type, salary_amount
       FROM users WHERE business_id = $1 AND LOWER(full_name) = ANY($2::text[])`,
      [bizId, empNames]
    );
    const empMap = Object.fromEntries(empRows.map(e => [e.lname, e]));

    // Check existing z_report_shifts to avoid duplicates — scoped to file date range
    const { rows: existZRows } = await db.query(
      `SELECT LOWER(employee_name) AS lname, report_date::date::text AS d
       FROM z_report_shifts
       WHERE business_id = $1 AND LOWER(employee_name) = ANY($2::text[])
         AND report_date::date BETWEEN $3::date AND $4::date`,
      [bizId, empNames, fileMinDate, fileMaxDate]
    );
    const existZSet = new Set(existZRows.map(r => `${r.lname}::${r.d}`));

    // Check existing shifts to avoid duplicates — scoped to file date range
    const matchedEmpIds = empRows.map(e => e.id);
    let existShiftSet = new Set();
    if (matchedEmpIds.length) {
      const { rows: existSRows } = await db.query(
        `SELECT employee_id::text AS eid, DATE(actual_start AT TIME ZONE 'Asia/Jerusalem')::text AS d
         FROM shifts
         WHERE business_id = $1 AND employee_id = ANY($2::uuid[])
           AND DATE(actual_start AT TIME ZONE 'Asia/Jerusalem') BETWEEN $3::date AND $4::date`,
        [bizId, matchedEmpIds, fileMinDate, fileMaxDate]
      );
      existShiftSet = new Set(existSRows.map(r => `${r.eid}::${r.d}`));
    }

    let imported = 0, skipped = 0;
    const unmatched = [];
    const details   = [];

    for (const s of shiftsWithDates) {
      const emp      = empMap[s.employeeName.toLowerCase()];
      const zKey     = `${s.employeeName.toLowerCase()}::${s.dateStr}`;

      // Insert into z_report_shifts (for display in Z-shifts tab) — skip duplicates
      if (!existZSet.has(zKey)) {
        try {
          await db.query(
            `INSERT INTO z_report_shifts (business_id, employee_name, total_hours, report_date, employee_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [bizId, s.employeeName, s.totalHours, s.dateStr, emp?.id || null]
          );
          existZSet.add(zKey);
        } catch (insertErr) {
          logger.warn('[Shifts Upload] z_report_shifts insert failed', { err: insertErr.message, name: s.employeeName, date: s.dateStr });
        }
      }

      if (!emp) {
        unmatched.push(s.employeeName);
        continue;
      }

      const shiftKey = `${emp.id}::${s.dateStr}`;
      if (existShiftSet.has(shiftKey)) { skipped++; continue; }

      const hours = parseFloat(s.totalHours);
      if (!hours || isNaN(hours) || hours <= 0 || hours > 24) { skipped++; continue; }

      // Create completed shift: 08:00 IL time → 08:00 + hours
      try {
        await db.query(
          `INSERT INTO shifts (business_id, employee_id, actual_start, actual_end, status, edit_note)
           VALUES ($1, $2,
             ($3::date + '08:00:00'::time) AT TIME ZONE 'Asia/Jerusalem',
             ($3::date + '08:00:00'::time) AT TIME ZONE 'Asia/Jerusalem' + ($4 * interval '1 hour'),
             'completed', 'יובא מדוח משמרות ידני')`,
          [bizId, emp.id, s.dateStr, hours]
        );
        existShiftSet.add(shiftKey);
        imported++;
        details.push({ name: emp.full_name, hours, date: s.dateStr });
      } catch (shiftErr) {
        logger.warn('[Shifts Upload] shifts insert failed', { err: shiftErr.message, emp: emp.full_name, date: s.dateStr });
        skipped++;
      }
    }

    const uniqueUnmatched = [...new Set(unmatched)];
    logger.info('[Shifts Upload] import complete', { bizId, imported, skipped, unmatched: uniqueUnmatched.length });
    res.json({ success: true, imported, skipped, unmatched: uniqueUnmatched, details });
  } catch (err) { next(err); }
});

// Multer error handler for /shifts/upload-report (file-too-large, wrong type)
router.use('/shifts/upload-report', (err, _req, res, _next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.message?.includes('סוג קובץ'))) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'הקובץ גדול מדי (מקסימום 8MB)' : err.message });
  }
  _next(err);
});

// GET /api/employees/:id/shifts/monthly — סיכום חודשי לעובד
router.get('/:id/shifts/monthly', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const yr  = parseIntRange(req.query.year,  2000, 2100, new Date().getFullYear());
    const mon = parseIntRange(req.query.month, 1,    12,   new Date().getMonth() + 1);
    const summary = await shiftModel.getMonthlySummary(req.params.id, req.user.businessId, yr, mon);
    res.json(summary);
  } catch (err) { next(err); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FORM 101 — כרטיס עובד חדש
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── יצירת טבלת טופס 101 אם לא קיימת ───────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS employee_form101 (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    id_number           VARCHAR(20),
    birth_date          DATE,
    gender              VARCHAR(10),
    marital_status      VARCHAR(20),
    num_children        INTEGER DEFAULT 0,
    address_city        TEXT,
    address_street      TEXT,
    address_num         VARCHAR(20),
    address_zip         VARCHAR(20),
    bank_name           VARCHAR(100),
    bank_branch         VARCHAR(20),
    bank_account        VARCHAR(30),
    start_date          DATE,
    employment_scope    INTEGER DEFAULT 100,
    tax_credit_points   NUMERIC(5,2) DEFAULT 2.25,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(employee_id)
  )
`);

// GET /api/employees/:id/form101 — שליפת טופס 101 לעובד
router.get('/:id/form101', requireAuth, requireManager, async (req, res, next) => {
  try {
    // Same protection as PUT /:id — a plain manager must not be able to read
    // an owner's/partner's bank account, ID number, and address.
    if (!['owner', 'partner'].includes(req.user.role)) {
      const target = await userModel.findById(req.params.id, req.user.businessId);
      if (target && ['owner', 'partner'].includes(target.role)) {
        return res.status(403).json({ error: 'הרשאה: לא ניתן לצפות בפרטי בעל עסק/שותף' });
      }
    }
    const { rows } = await db.query(
      `SELECT id, employee_id, id_number, birth_date, gender, marital_status,
              num_children, address_city, address_street, address_num, address_zip,
              bank_name, bank_branch, bank_account,
              start_date, employment_scope, tax_credit_points, notes, created_at, updated_at
       FROM employee_form101 WHERE employee_id = $1 AND business_id = $2`,
      [req.params.id, req.user.businessId]
    );
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// POST /api/employees/:id/form101 — שמירת/עדכון טופס 101
router.post('/:id/form101', requireAuth, requireManager, async (req, res, next) => {
  try {
    // employee_form101.employee_id is UNIQUE across the whole table (not
    // per-business) and the UPDATE branch below never touches business_id —
    // without this check, POSTing a UUID belonging to another business's
    // employee would silently overwrite that employee's real bank
    // account/ID-number/address with attacker-supplied values on conflict,
    // completely invisible to the victim business (their own business_id-
    // scoped GET would still find "their" row, just with tampered data).
    const owns = await db.query('SELECT role FROM users WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
    if (!owns.rows.length) return res.status(404).json({ error: 'עובד לא נמצא' });
    // Same protection as PUT /:id — a plain manager must not be able to
    // overwrite an owner's/partner's bank account, ID number, and address.
    if (!['owner', 'partner'].includes(req.user.role) && ['owner', 'partner'].includes(owns.rows[0].role)) {
      return res.status(403).json({ error: 'הרשאה: לא ניתן לערוך פרטי בעל עסק/שותף' });
    }

    const {
      idNumber, birthDate, gender, maritalStatus, numChildren,
      addressCity, addressStreet, addressNum, addressZip,
      bankName, bankBranch, bankAccount,
      startDate, employmentScope, taxCreditPoints, notes,
    } = req.body;

    // Form 101 writes two tables: the form itself, and the employee's tax credit
    // points on users. Without one transaction a failure between them leaves the
    // form saved and the tax points stale — and the stale value is what the
    // salary calculation reads, so the payslip comes out wrong with nothing
    // reporting a problem.
    const form = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO employee_form101
         (employee_id, business_id, id_number, birth_date, gender, marital_status, num_children,
          address_city, address_street, address_num, address_zip,
          bank_name, bank_branch, bank_account,
          start_date, employment_scope, tax_credit_points, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (employee_id) DO UPDATE SET
         id_number         = EXCLUDED.id_number,
         birth_date        = EXCLUDED.birth_date,
         gender            = EXCLUDED.gender,
         marital_status    = EXCLUDED.marital_status,
         num_children      = EXCLUDED.num_children,
         address_city      = EXCLUDED.address_city,
         address_street    = EXCLUDED.address_street,
         address_num       = EXCLUDED.address_num,
         address_zip       = EXCLUDED.address_zip,
         bank_name         = EXCLUDED.bank_name,
         bank_branch       = EXCLUDED.bank_branch,
         bank_account      = EXCLUDED.bank_account,
         start_date        = EXCLUDED.start_date,
         employment_scope  = EXCLUDED.employment_scope,
         tax_credit_points = EXCLUDED.tax_credit_points,
         notes             = EXCLUDED.notes,
         updated_at        = NOW()
       RETURNING *`,
      [req.params.id, req.user.businessId,
       idNumber || null, birthDate || null, gender || null, maritalStatus || null, numChildren || 0,
       addressCity || null, addressStreet || null, addressNum || null, addressZip || null,
       bankName || null, bankBranch || null, bankAccount || null,
       startDate || null, employmentScope ?? 100, taxCreditPoints ?? 2.25, notes || null]
    );

    // עדכון נקודות זיכוי גם בטבלת users
    if (taxCreditPoints != null) {
      await client.query(
        `UPDATE users SET tax_credit_points = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3`,
        [parseFloat(taxCreditPoints), req.params.id, req.user.businessId]
      );
    }

      return rows[0];
    });

    res.json(form);
  } catch (err) { next(err); }
});

// POST /api/employees/:id/invite — שליחת הזמנה מחדש לעובד
router.post('/:id/invite', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT full_name, email FROM users WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'עובד לא נמצא' });
    const { full_name, email } = rows[0];

    const inviteToken   = crypto.randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 24 * 3600 * 1000);
    const updateResult = await db.query(
      'UPDATE users SET invite_token = $1, invite_expires_at = $2, pending_invite = TRUE WHERE id = $3 AND business_id = $4',
      [inviteToken, inviteExpires, req.params.id, req.user.businessId]
    );
    if (!updateResult.rowCount) return res.status(404).json({ error: 'עובד לא נמצא' });

    const bizRow = await db.query('SELECT name FROM businesses WHERE id = $1', [req.user.businessId]);
    const businessName = bizRow.rows[0]?.name || 'העסק';
    const _appBase2 = process.env.APP_URL || (process.env.NODE_ENV !== 'production' ? 'http://localhost:3002' : '');
    const inviteUrl = `${_appBase2}/join?token=${inviteToken}`;
    sendEmployeeInvite({ to: email, fullName: full_name, businessName, inviteUrl }).catch(e =>
      logger.error('[Employees] invite email failed', { err: e.message })
    );

    res.json({ message: 'הזמנה נשלחה' });
  } catch (err) { next(err); }
});

// POST /api/employees/shifts/open — פתיחת משמרת לעובד ספציפי (מנהל)
router.post('/shifts/open', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { employeeId, startTime } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'employeeId נדרש' });
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(employeeId)) return res.status(400).json({ error: 'employeeId לא תקין' });
    if (startTime && isNaN(new Date(startTime).getTime())) {
      return res.status(400).json({ error: 'startTime לא תקין' });
    }
    // Atomic ownership check + INSERT in a single statement — eliminates the TOCTOU
    // window that existed when ownership was verified in a separate SELECT beforehand.
    const { rows } = await db.query(
      `INSERT INTO shifts (business_id, employee_id, actual_start, status, location_verified)
       SELECT $1, u.id, $3, 'active', TRUE
         FROM users u
        WHERE u.id = $2 AND u.business_id = $1
       RETURNING *`,
      [req.user.businessId, employeeId, startTime ? new Date(startTime) : new Date()]
    );
    if (!rows.length) return res.status(404).json({ error: 'עובד לא נמצא' });
    eventBus.publish(req.user.businessId, 'shift_opened', { shiftId: rows[0].id, employeeId });
    res.status(201).json(rows[0]);
  } catch (err) {
    // Unique index violation — employee already has an open shift
    if (err.code === '23505') {
      return res.status(409).json({ error: 'לעובד כבר יש משמרת פתוחה' });
    }
    next(err);
  }
});

// DELETE /api/employees/shifts/:id — מחיקת משמרת
router.delete('/shifts/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM shifts WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'משמרת לא נמצאה' });
    eventBus.publish(req.user.businessId, 'shift_closed', { shiftId: req.params.id, action: 'deleted' });
    onShiftChanged(req.user.businessId).catch(() => {});
    res.json({ message: 'משמרת נמחקה' });
  } catch (err) { next(err); }
});

// GET /api/employees/shifts/salary-preview — תצפית שכר שבועי
router.get('/shifts/salary-preview', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const now  = new Date();
    const y    = parseIntRange(req.query.year,  2000, 2100, now.getFullYear());
    const m    = parseIntRange(req.query.month, 1,    12,   now.getMonth() + 1);
    // Use date strings — SQL compares using AT TIME ZONE to stay tz-safe
    const pad  = n => String(n).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${y}-${pad(m)}-01`;
    const to   = `${y}-${pad(m)}-${pad(lastDay)}`;

    const { rows } = await db.query(
      `SELECT
         u.id, u.full_name, u.salary_type, u.salary_amount,
         COALESCE(SUM(
           EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600
         ), 0) AS hours,
         COALESCE(tips_sub.tips_total, 0) AS tips_total
       FROM users u
       LEFT JOIN shifts sh ON sh.employee_id = u.id
         AND sh.business_id = $1
         AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') >= $2::date
         AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') <= $3::date
         AND sh.actual_end IS NOT NULL
       LEFT JOIN (
         SELECT td.employee_id, SUM(td.amount)::numeric AS tips_total
         FROM tip_distributions td
         JOIN tip_entries te ON te.id = td.tip_entry_id
         WHERE te.business_id = $1
           AND te.entry_date >= DATE_TRUNC('month', $2::timestamptz AT TIME ZONE 'Asia/Jerusalem')
           AND te.entry_date <  DATE_TRUNC('month', $2::timestamptz AT TIME ZONE 'Asia/Jerusalem') + INTERVAL '1 month'
         GROUP BY td.employee_id
       ) tips_sub ON tips_sub.employee_id = u.id
       WHERE u.business_id = $1
         AND u.role != 'owner'
         AND (u.is_active = TRUE OR u.salary_type IN ('global', 'monthly', 'tips'))
       GROUP BY u.id, u.full_name, u.salary_type, u.salary_amount, tips_sub.tips_total
       ORDER BY u.full_name`,
      [req.user.businessId, from, to]
    );

    const breakdown = rows.map(e => {
      const hours = parseFloat(e.hours) || 0;
      let gross;
      if (['global', 'monthly'].includes(e.salary_type)) {
        gross = parseFloat(e.salary_amount);
      } else if (e.salary_type === 'tips') {
        gross = parseFloat(e.tips_total) || 0;
      } else {
        gross = hours * parseFloat(e.salary_amount || 0);
      }
      return { employee_name: e.full_name, salary_type: e.salary_type, hours: parseFloat(hours.toFixed(2)), gross: parseFloat(gross.toFixed(2)) };
    });

    res.json({ breakdown, total_gross: breakdown.reduce((s, e) => s + e.gross, 0) });
  } catch (err) { next(err); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYSLIPS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /api/employees/payslips/send — שליחת תלושים חודשיים (ידני)
router.post('/payslips/send', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { year, month } = req.body;
    const yr  = parseIntRange(year,  2000, 2100, new Date().getFullYear());
    const mon = parseIntRange(month, 1,    12,   new Date().getMonth() + 1);
    const results = await sendMonthlyPayslips(req.user.businessId, yr, mon);
    res.json({ results });
  } catch (err) { next(err); }
});

// GET /api/employees/:id/payslips — ארכיון תלושים לעובד (מנהל)
router.get('/:id/payslips', requireAuth, requireManager, async (req, res, next) => {
  try {
    // Same protection as PUT /:id — a plain manager must not be able to
    // read the owner's/partner's actual gross/net salary history.
    if (!['owner', 'partner'].includes(req.user.role)) {
      const target = await userModel.findById(req.params.id, req.user.businessId);
      if (target && ['owner', 'partner'].includes(target.role)) {
        return res.status(403).json({ error: 'הרשאה: לא ניתן לצפות בתלושי בעל עסק/שותף' });
      }
    }
    const { rows } = await db.query(
      `SELECT id, period_month, period_year, gross_salary, net_salary, sent_at
       FROM payslips
       WHERE business_id = $1 AND employee_id = $2
       ORDER BY period_year DESC, period_month DESC`,
      [req.user.businessId, req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/employees/:id/payslips/resend — שליחה מחדש
router.post('/:id/payslips/resend', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { year, month } = req.body;
    const yr  = parseIntRange(year,  2000, 2100, new Date().getFullYear());
    const mon = parseIntRange(month, 1,    12,   new Date().getMonth() + 1);
    const payslipData = await resendPayslip(req.user.businessId, req.params.id, yr, mon);
    res.json({ message: 'תלוש נשלח מחדש', netSalary: payslipData.netSalary });
  } catch (err) { next(err); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PERFORMANCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/employees/performance?year=YYYY&month=MM
router.get('/performance', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const year  = parseIntRange(req.query.year,  2000, 2100, new Date().getFullYear());
    const month = parseIntRange(req.query.month, 1,    12,   new Date().getMonth() + 1);

    const cacheKey = `employee-perf:${req.user.businessId}:${year}:${month}`;
    const cached   = await cache.get(cacheKey);
    if (cached) return res.json(cached);
    const from  = `${year}-${String(month).padStart(2,'0')}-01`;
    const to    = new Date(year, month, 0).toISOString().slice(0,10); // last day of month

    // Per-employee stats for the month
    const { rows: emp } = await db.query(`
      SELECT
        u.id,
        u.full_name,
        u.role,
        u.salary_type,
        u.salary_amount,
        -- avatar_url is not a users column and never has been, so this SELECT
        -- threw 42703 and next(err) turned it into a 500 — the entire employee
        -- performance screen returned "שגיאת שרת פנימית" on every single load.
        -- No avatar storage exists anywhere in the schema; the field is emitted
        -- as NULL so the response shape the frontend expects is preserved.
        NULL::text AS avatar_url,
        COUNT(sh.id)::int                                                         AS shift_count,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600
        ), 0)::float                                                              AS total_hours,
        COALESCE(AVG(
          EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600
        ), 0)::float                                                              AS avg_shift_hours,
        COUNT(sh.id) FILTER (WHERE sh.actual_end IS NULL AND sh.status = 'open')::int AS open_shifts
      FROM users u
      LEFT JOIN shifts sh
        ON sh.employee_id = u.id
        AND sh.business_id = $1
        AND sh.actual_start >= $2
        AND sh.actual_start <= ($3::date + INTERVAL '1 day')
        AND sh.actual_end IS NOT NULL
      WHERE u.business_id = $1
        AND u.is_active = TRUE
      GROUP BY u.id
      ORDER BY total_hours DESC
    `, [req.user.businessId, from, to]);

    // Gross pay calculation
    const daysInMonth = new Date(year, month, 0).getDate();

    const employees = emp.map(e => {
      const hours = parseFloat(e.total_hours) || 0;
      const gross = ['global', 'monthly'].includes(e.salary_type)
        ? parseFloat(e.salary_amount || 0)
        : hours * parseFloat(e.salary_amount || 0);

      return {
        id:            e.id,
        full_name:     e.full_name,
        role:          e.role,
        salary_type:   e.salary_type,
        avatar_url:    e.avatar_url,
        shift_count:   e.shift_count,
        total_hours:   parseFloat(hours.toFixed(1)),
        avg_shift_hours: parseFloat((e.avg_shift_hours || 0).toFixed(1)),
        gross_pay:     parseFloat(gross.toFixed(0)),
        cost_per_hour: hours > 0 ? parseFloat((gross / hours).toFixed(1)) : 0,
      };
    });

    // Weekly trend for current month (hours by week)
    const { rows: weekly } = await db.query(`
      SELECT
        u.id AS employee_id,
        u.full_name,
        EXTRACT(WEEK FROM sh.actual_start)::int AS week_num,
        SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600)::float AS hours
      FROM users u
      JOIN shifts sh ON sh.employee_id = u.id
        AND sh.business_id = $1
        AND sh.actual_start >= $2
        AND sh.actual_start <= ($3::date + INTERVAL '1 day')
        AND sh.actual_end IS NOT NULL
      WHERE u.business_id = $1
      GROUP BY u.id, u.full_name, week_num
      ORDER BY week_num
    `, [req.user.businessId, from, to]);

    // Hours by day of week (attendance patterns)
    const { rows: byDow } = await db.query(`
      SELECT
        EXTRACT(DOW FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
        COUNT(sh.id)::int AS shift_count,
        SUM(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600)::float AS total_hours
      FROM shifts sh
      WHERE sh.business_id = $1
        AND sh.actual_start >= $2
        AND sh.actual_start <= ($3::date + INTERVAL '1 day')
        AND sh.actual_end IS NOT NULL
      GROUP BY dow ORDER BY dow
    `, [req.user.businessId, from, to]);

    const totals = {
      total_hours:  parseFloat(employees.reduce((s,e) => s + e.total_hours, 0).toFixed(1)),
      total_shifts: employees.reduce((s,e) => s + e.shift_count, 0),
      total_gross:  employees.reduce((s,e) => s + e.gross_pay, 0),
      active_employees: employees.filter(e => e.shift_count > 0).length,
    };

    const result = { employees, weekly, byDow, totals, year, month };
    await cache.set(cacheKey, result, 120); // 2 דקות
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/employees/labor-alerts — בדיקת חוקי עבודה
router.get('/labor-alerts', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const alerts = await getLaborAlerts(req.user.businessId);
    res.json({ alerts, count: alerts.length });
  } catch (err) { next(err); }
});

// GET /api/employees/schedule-suggestions — תזמון חכם לשבוע הבא
router.get('/schedule-suggestions', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const result = await getShiftSuggestions(req.user.businessId);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/employees/z-shifts/unmatched — משמרות Z-report שלא שויכו לעובד
router.get('/z-shifts/unmatched', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         zs.id, zs.employee_name, zs.total_hours,
         zs.report_date,
         (SELECT COUNT(*)::int FROM z_report_shifts
          WHERE business_id = $1 AND employee_id IS NULL) AS total_unmatched
       FROM z_report_shifts zs
       WHERE zs.business_id = $1 AND zs.employee_id IS NULL
       ORDER BY zs.report_date DESC
       LIMIT 50`,
      [req.user.businessId]
    );
    res.json({
      total: rows[0]?.total_unmatched || 0,
      shifts: rows.map(r => ({
        id: r.id,
        employeeName: r.employee_name,
        totalHours: parseFloat(r.total_hours) || 0,
        reportDate: r.report_date,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/employees/z-shifts/match — שיוך ידני של משמרת Z לעובד
router.post('/z-shifts/match', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { shiftId, employeeId } = req.body;
    if (!shiftId || !employeeId) return res.status(400).json({ error: 'shiftId ו-employeeId הם שדות חובה' });

    const { rows: empCheck } = await db.query(
      'SELECT id FROM users WHERE id = $1 AND business_id = $2',
      [employeeId, req.user.businessId]
    );
    if (!empCheck[0]) return res.status(404).json({ error: 'עובד לא נמצא בעסק זה' });

    const { rowCount } = await db.query(
      `UPDATE z_report_shifts SET employee_id = $1
       WHERE id = $2 AND business_id = $3`,
      [employeeId, shiftId, req.user.businessId]
    );
    if (!rowCount) return res.status(404).json({ error: 'משמרת לא נמצאה' });
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'z_shift_matched', employeeId, shiftId });
    res.json({ message: 'משמרת שויכה בהצלחה' });
  } catch (err) { next(err); }
});

module.exports = router;
