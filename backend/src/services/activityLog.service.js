/**
 * Activity Log Service
 * רישום פעולות חשובות בעסק לצורך ביקורת ושקיפות
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');

const ACTIONS = {
  // Auth
  LOGIN:           'login',
  LOGOUT:          'logout',
  PASSWORD_RESET:  'password_reset',

  // Employees
  EMPLOYEE_ADDED:    'employee_added',
  EMPLOYEE_UPDATED:  'employee_updated',
  EMPLOYEE_REMOVED:  'employee_removed',
  SHIFT_CLOCK_IN:    'shift_clock_in',
  SHIFT_CLOCK_OUT:   'shift_clock_out',
  SHIFT_EDITED:      'shift_edited',
  ABSENT_MARKED:     'absent_marked',

  // Inventory
  INVENTORY_UPDATED: 'inventory_updated',
  WASTE_RECORDED:    'waste_recorded',
  STOCKTAKE_RECORDED:'stocktake_recorded',

  // Invoices
  INVOICE_UPLOADED:  'invoice_uploaded',
  INVOICE_APPROVED:  'invoice_approved',
  INVOICE_DELETED:   'invoice_deleted',

  // Suppliers
  SUPPLIER_ADDED:    'supplier_added',
  ORDER_SENT:        'order_sent',
  ORDER_CANCELLED:   'order_cancelled',

  // POS
  POS_CONNECTED:     'pos_connected',
  POS_SYNCED:        'pos_synced',

  // Finance
  EXPENSE_ADDED:     'expense_added',
  EXPENSE_DELETED:   'expense_deleted',

  // Recipes
  RECIPE_CREATED:    'recipe_created',
  RECIPE_UPDATED:    'recipe_updated',
  RECIPE_DELETED:    'recipe_deleted',

  // AI
  AI_CHAT:           'ai_chat',
};

// רישום פעולה
async function log(businessId, userId, action, details = {}) {
  try {
    await db.query(
      `INSERT INTO activity_log (business_id, user_id, action, metadata)
       VALUES ($1,$2,$3,$4)`,
      [businessId, userId, action, JSON.stringify(details)]
    );
  } catch (err) {
    // שגיאה ביומן לא עוצרת את הפעולה
    logger.error('[ActivityLog] error', { err: err.message });
  }
}

// שליפת לוג
async function getLog(businessId, { limit = 50, offset = 0, userId, action, fromDate, toDate } = {}) {
  const conditions = ['al.business_id = $1'];
  const values     = [businessId];
  let   idx        = 2;

  if (userId) {
    conditions.push(`al.user_id = $${idx++}`);
    values.push(userId);
  }
  if (action) {
    conditions.push(`al.action = $${idx++}`);
    values.push(action);
  }
  if (fromDate) {
    conditions.push(`al.created_at >= $${idx++}`);
    values.push(fromDate);
  }
  if (toDate) {
    conditions.push(`al.created_at <= $${idx++}`);
    values.push(toDate);
  }

  values.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(
    `SELECT al.id, al.action, al.metadata AS details, al.created_at,
            u.full_name, u.role
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY al.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values
  );

  return rows.map(r => ({
    id:        r.id,
    action:    r.action,
    details:   r.details,
    createdAt: r.created_at,
    user:      { name: r.full_name, role: r.role },
  }));
}

module.exports = { log, getLog, ACTIONS };
