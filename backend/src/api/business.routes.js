const express = require('express');
const router  = express.Router();
const { requireAuth, requireOwner } = require('../middleware/auth');
const businessModel = require('../models/business.model');
const db            = require('../utils/db');
const userModel     = require('../models/user.model');
const logger        = require('../utils/logger');
const syncService   = require('../services/sync.service');
const eventBus      = require('../utils/eventBus');
const posSync       = require('../services/pos/pos.sync');
const { generateInsights, storeInsights } = require('../agents/autoInsights.agent');
const { bustContextCache } = require('../services/ai/business.context');
const { EXPENSE_ACTIVE_TODAY } = require('../utils/expenseWindow');

db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN`);
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS primary_email VARCHAR(255)`);
// שעות פתיחה/סגירה מפורטות לכל יום — open_days נשאר מערך ימים (עליו נשענים חישובי פיננסים/תזמון),
// open_hours שומר את ה-from/to לכל יום בנפרד לצורך תצוגה בהגדרות
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS open_hours JSONB`);

// GET /api/business/me — פרטי העסק הנוכחי
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const business = await businessModel.findById(req.user.businessId);
    if (!business) return res.status(404).json({ error: 'עסק לא נמצא' });
    res.json(business);
  } catch (err) {
    next(err);
  }
});

// PUT /api/business/me — עדכון פרטי עסק
router.put('/me', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const allowed = ['name', 'address', 'vat_number', 'phone', 'logo_url',
                     'close_hour', 'open_days', 'closed_dates', 'primary_email',
                     'delivery_fee_pct', 'wolt_commission_pct', 'ten_bis_commission_pct',
                     'z_report_includes_delivery_platforms'];
    const fields  = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (fields.open_days !== undefined) {
      // שומר את השעות המפורטות (from/to לכל יום) לפני שה-open_days מצטמצם למערך ימים בלבד
      if (!Array.isArray(fields.open_days)) fields.open_hours = fields.open_days;
      fields.open_days = normalizeOpenDays(fields.open_days);
    }
    // delivery_fee_pct feeds directly into pl-streams (deliveryCost = revenue * pct/100) —
    // an out-of-range value would silently inflate/deflate reported profit.
    // null is a documented, supported value ("no override — use the 15%
    // default" per COALESCE(delivery_fee_pct, 15) in finance.routes.js), so
    // only a non-null value gets range-validated.
    if (fields.delivery_fee_pct !== undefined && fields.delivery_fee_pct !== null) {
      const pct = parseFloat(fields.delivery_fee_pct);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'אחוז דמי משלוח לא חוקי — חייב להיות בין 0 ל-100' });
      }
      fields.delivery_fee_pct = pct;
    }
    // Same null-is-valid / range-validated-otherwise rule as delivery_fee_pct above —
    // these feed the pl-streams per-platform commission calculation.
    for (const [key, label] of [['wolt_commission_pct', 'וולט'], ['ten_bis_commission_pct', 'תן ביס']]) {
      if (fields[key] !== undefined && fields[key] !== null) {
        const pct = parseFloat(fields[key]);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: `אחוז עמלת ${label} לא חוקי — חייב להיות בין 0 ל-100` });
        }
        fields[key] = pct;
      }
    }
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'אין שדות לעדכון' });
    const updated = await businessModel.update(req.user.businessId, fields);
    // open_days/close_hour/delivery_fee_pct feed directly into finance calculations
    if ('open_days' in fields || 'close_hour' in fields || 'delivery_fee_pct' in fields
        || 'wolt_commission_pct' in fields || 'ten_bis_commission_pct' in fields
        || 'z_report_includes_delivery_platforms' in fields) {
      syncService.onShiftChanged(req.user.businessId).catch(() => {});
    }
    eventBus.publish(req.user.businessId, 'dashboard.refresh', { reason: 'business_updated' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/business/users — כל העובדים
router.get('/users', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const users = await userModel.findAllByBusiness(req.user.businessId);
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// PUT /api/business/users/:id/permissions — עדכון הרשאות עובד
router.put('/users/:id/permissions', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const allowed = ['perm_suppliers','perm_inventory','perm_recipes',
                     'perm_finance','perm_ai','perm_employees','perm_export','perm_audit'];
    const fields  = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const updated = await userModel.update(req.params.id, req.user.businessId, fields);
    if (!updated) return res.status(404).json({ error: 'עובד לא נמצא' });
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'permissions_updated', employeeId: req.params.id });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/business/users/:id — הסרת עובד (soft)
router.delete('/users/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await userModel.deactivate(req.params.id, req.user.businessId);
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'deactivated', employeeId: req.params.id });
    res.json({ message: 'העובד הוסר' });
  } catch (err) {
    next(err);
  }
});

const DOW_NAME = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function normalizeOpenDays(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([, v]) => v?.open)
      .map(([k]) => DOW_NAME[k])
      .filter(d => d !== undefined);
  }
  return [0, 1, 2, 3, 4, 5, 6];
}

// PUT /api/business/onboarding — השלמת wizard הגדרות ראשוניות (קריאה אחת)
router.put('/onboarding', requireAuth, requireOwner, async (req, res, next) => {
  try {

    const {
      open_days,           // {"sun":{"open":true,"from":"08:00","to":"23:00"}, ...}
      close_hour,          // "23:00"
      vat_number,
      address,
      phone,
      primary_email,       // אימייל ראשי מקושר למערכת
    } = req.body;

    const allowed = {};
    if (open_days      !== undefined) {
      // שומר את השעות המפורטות (from/to לכל יום) לפני שה-open_days מצטמצם למערך ימים בלבד
      if (!Array.isArray(open_days)) allowed.open_hours = JSON.stringify(open_days);
      allowed.open_days = JSON.stringify(normalizeOpenDays(open_days));
    }
    if (close_hour     !== undefined) allowed.close_hour     = close_hour;
    if (vat_number     !== undefined) allowed.vat_number     = vat_number;
    if (address        !== undefined) allowed.address        = address;
    if (phone          !== undefined) allowed.phone          = phone;
    if (primary_email  !== undefined) allowed.primary_email  = primary_email;
    allowed.onboarding_completed = true;

    const keys   = Object.keys(allowed);
    const values = Object.values(allowed);
    const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    const { rows } = await db.query(
      `UPDATE businesses SET ${set}, updated_at = NOW()
        WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.user.businessId]
    );

    // Bust all caches and fire SSE events so the dashboard hydrates immediately
    // when the browser navigates there after the wizard.
    syncService.fullCacheBust(req.user.businessId)
      .catch(e => logger.warn('[onboarding] fullCacheBust failed', { err: e.message }));

    res.json({ business: rows[0] });
  } catch (err) { next(err); }
});

// POST /api/business/finish-setup — כפתור "סיימתי — סנכרן הכל" בסוף מדריך ההגדרות (/setup)
// מריץ כל שלב סנכרון בנפרד ומחכה לו (לא fire-and-forget) — ומדווח הצלחה/כישלון
// אמיתיים לכל שלב, כדי שלא נחזיר "success" כוזב כשמשהו בפועל נכשל.
router.post('/finish-setup', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const steps = [];

    // 1. סנכרון קופה מחוברת (no-op בטוח אם לא חוברה קופה בכלל)
    try {
      await posSync.syncIncremental(businessId);
      steps.push({ step: 'pos', ok: true });
    } catch (err) {
      logger.warn('[finish-setup] POS sync failed', { businessId, err: err.message });
      steps.push({ step: 'pos', ok: false, error: err.message });
    }

    // 2. ניקוי כל הקאשים — דשבורד/פיננסים/AI יטענו נתונים טריים בכניסה
    try {
      await syncService.fullCacheBust(businessId);
      steps.push({ step: 'cache', ok: true });
    } catch (err) {
      logger.warn('[finish-setup] fullCacheBust failed', { businessId, err: err.message });
      steps.push({ step: 'cache', ok: false, error: err.message });
    }

    // 3. רענון קונטקסט ה-AI (עסק/מלאי/תפריט) — בסיס לכל תכונות ה-AI
    try {
      await bustContextCache(businessId);
      steps.push({ step: 'ai_context', ok: true });
    } catch (err) {
      logger.warn('[finish-setup] bustContextCache failed', { businessId, err: err.message });
      steps.push({ step: 'ai_context', ok: false, error: err.message });
    }

    const success = steps.every(s => s.ok);
    res.json({ success, steps });

    // תובנות AI — ברקע בלבד, לא חוסם את התשובה למשתמש (קריאה ל-Claude)
    generateInsights(businessId)
      .then(fresh => storeInsights(businessId, fresh))
      .catch(err => logger.warn('[finish-setup] background insights failed', { businessId, err: err.message }));
  } catch (err) { next(err); }
});

// DELETE /api/business/users/:id/hard — מחיקה מלאה
router.delete('/users/:id/hard', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await userModel.hardDelete(req.params.id, req.user.businessId);
    eventBus.publish(req.user.businessId, 'employee.updated', { action: 'deleted', employeeId: req.params.id });
    res.json({ message: 'העובד נמחק לצמיתות' });
  } catch (err) {
    next(err);
  }
});

// GET /api/business/data-health — מצב כל קטגוריות הנתונים
router.get('/data-health', requireAuth, async (req, res, next) => {
  try {
    const bid = req.user.businessId;
    // Each probe is catch-guarded individually. Under a plain Promise.all a
    // single bad query rejects the lot and the caller gets a 500 with no
    // categories at all — which is exactly what three non-existent tables
    // (recipe_items, delivery_orders, employees) did here for months. A
    // failed probe now degrades to "unknown" for that one category instead.
    const failed = [];
    const probe = (name, p) => p.catch(err => {
      logger.warn('[data-health] probe failed', { probe: name, err: err.message, businessId: bid });
      failed.push(name);
      return null;
    });
    const [pos, invoices, expenses, recipes, labor, inventory, delivery] = await Promise.all([
      probe('zreports', db.query(`SELECT COUNT(*) FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`, [bid])),
      probe('invoices', db.query(`SELECT COUNT(*) FROM invoices WHERE business_id = $1 AND approved_at IS NOT NULL`, [bid])),
      // Setup-completeness counter: an expense whose contract has ended is not
      // a configured fixed expense any more, so it shouldn't keep this box
      // ticked. Same window every other reader now applies.
      probe('fixed_expenses', db.query(`SELECT COUNT(*) FROM fixed_expenses WHERE business_id = $1 AND (is_active IS NULL OR is_active = TRUE)${EXPENSE_ACTIVE_TODAY}`, [bid])),
      // Was `recipe_items`, a table that has never existed — the ingredient
      // rows live in recipe_ingredients. Postgres raised 42P01, and because
      // these run under one Promise.all that took the whole endpoint down.
      probe('recipes', db.query(`SELECT COUNT(*) FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id WHERE r.business_id = $1`, [bid])),
      // And `employees` is a third table that never existed — staff are rows
      // in users, identified by having a salary_type set (shifts.employee_id
      // is a users.id, which is what makes the join below work at all).
      probe('labor', db.query(`SELECT
          COUNT(DISTINCT e.id) FILTER (WHERE e.salary_type IS NOT NULL AND e.salary_type != '') AS emp_count,
          COUNT(DISTINCT s.id) AS shift_count
        FROM users e LEFT JOIN shifts s ON s.employee_id = e.id AND e.business_id = $1
        WHERE e.business_id = $1`, [bid])),
      probe('inventory', db.query(`SELECT COUNT(*) FROM inventory_items WHERE business_id = $1 AND is_active = TRUE`, [bid])),
      // Likewise `delivery_orders` never existed — deliveries are rows in
      // sales carrying sale_type='delivery' (see deliveries.routes.js).
      probe('delivery', db.query(`SELECT COUNT(*) FROM sales WHERE business_id = $1 AND sale_type = 'delivery'`, [bid])),
    ]);
    // null = that probe failed, which is not the same as "counted, found none".
    const has = (r, col = 'count') => (r ? parseInt(r.rows[0][col]) > 0 : null);
    res.json({
      hasZReports:      has(pos),
      hasInvoices:      has(invoices),
      hasFixedExpenses: has(expenses),
      hasRecipes:       has(recipes),
      hasLaborData:     labor ? (parseInt(labor.rows[0].emp_count) + parseInt(labor.rows[0].shift_count)) > 0 : null,
      hasInventory:     has(inventory),
      hasDeliveryData:  has(delivery),
      degraded:         failed.length > 0,
      failed_probes:    failed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
