'use strict';

/**
 * Centralized input validation — Zod schemas for all critical routes.
 * Strips unknown fields (.strict / .strip) to prevent mass-assignment.
 * UUID format enforced on all ID params — reduces injection attack surface.
 */

const { z } = require('zod');
const logger = require('../utils/logger');

// ── Primitives ────────────────────────────────────────────────────────────────
const uuidSchema  = z.string().uuid({ message: 'Invalid ID format' });
const emailSchema = z.string().email({ message: 'כתובת מייל לא תקינה' }).max(254);
const phoneSchema = z.string().regex(/^[+\d\s\-()]{7,20}$/, 'מספר טלפון לא תקין').optional();
const nonEmpty    = (max = 200) => z.string().min(1, 'שדה חובה').max(max).trim();
// Frontends commonly send `null` (not just omit the key) for a cleared/empty
// optional field (e.g. `categoryId: value || null`). z.optional() only
// accepts undefined, so plain .optional() rejects that null with a 400 —
// .nullable() + transform keeps the field's type as string|undefined for
// every downstream consumer.
const optStr      = (max = 200) => z.string().max(max).trim().optional().nullable().transform(v => v ?? undefined);

// ── Auth ──────────────────────────────────────────────────────────────────────
const registerSchema = z.object({
  name:         nonEmpty(100),
  businessName: nonEmpty(100),
  businessType: z.enum(['restaurant', 'cafe', 'bar', 'bakery', 'other']),
  phone:        phoneSchema,
  email:        emailSchema,
  password:     z.string().min(8, 'סיסמה חייבת לכלול לפחות 8 תווים').max(128),
}).strip();

const loginOwnerSchema = z.object({
  username: nonEmpty(50),
  password: z.string().min(1, 'סיסמה חובה').max(128),
  totpCode: z.string().length(6).optional(),
}).strip();

const loginEmployeeSchema = z.object({
  username: nonEmpty(50),
  password: z.string().min(1).max(128),
  businessCode: optStr(20),
  // Must be declared here, not just read in the route: .strip() drops any key
  // the schema doesn't know about, so omitting it made totpCode permanently
  // undefined in the handler — an employee who enabled 2FA could never finish
  // logging in, no matter what the client sent.
  totpCode: z.string().length(6).optional(),
}).strip();

const forgotPasswordSchema = z.object({
  email: emailSchema,
}).strip();

const resetPasswordSchema = z.object({
  email:       emailSchema,
  code:        nonEmpty(10),
  newPassword: z.string().min(8, 'סיסמה חייבת לכלול לפחות 8 תווים').max(128),
}).strip();

// ── Tasks ─────────────────────────────────────────────────────────────────────
const createTaskSchema = z.object({
  title:       nonEmpty(200),
  description: optStr(1000),
  priority:    z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueDate:     z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  assignedTo:  uuidSchema.optional(),
  subtasks:    z.array(z.string().max(200)).max(50).optional(),
}).strip();

const updateTaskSchema = z.object({
  title:       optStr(200),
  description: optStr(1000),
  priority:    z.enum(['low', 'medium', 'high']).optional(),
  status:      z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  due_date:    z.string().datetime({ offset: true }).optional(),
  assignee_id: uuidSchema.optional(),
}).strip();

// ── Customers ─────────────────────────────────────────────────────────────────
const createCustomerSchema = z.object({
  name:     optStr(100),
  phone:    phoneSchema,
  email:    emailSchema.optional(),
  birthday: z.string().date().optional(),
  notes:    optStr(500),
}).strip();

const logVisitSchema = z.object({
  amount: z.number().min(0).max(99999),
  note:   optStr(300),
}).strip();

// ── Employees ─────────────────────────────────────────────────────────────────
const createEmployeeSchema = z.object({
  fullName:         nonEmpty(100),
  email:            emailSchema,
  phone:            phoneSchema,
  role:             z.enum(['employee', 'manager']).default('employee'),
  position:         optStr(50),
  salaryType:       z.enum(['hourly', 'monthly', 'global', 'tips']).default('hourly'),
  salaryAmount:     z.coerce.number().min(0).max(999999),
  taxCreditPoints:  z.coerce.number().min(0).max(10).default(2.25),
  participatesInTips: z.boolean().optional(),
  // אם המנהל ממלא את שניהם — נוצר חשבון פעיל עם הסיסמה הזו במקום הזמנה במייל
  username:         z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,50}$/, 'שם משתמש: 3-50 תווים, אותיות/מספרים באנגלית בלבד').optional(),
  password:         z.string().min(8).max(128).optional(),
}).strip();

// ── Inventory ──────────────────────────────────────────────────────────────────
const ITEM_TYPE_VALUES = ['מזון', 'ניקיון', 'ציוד', 'שונות'];

const createInventoryItemSchema = z.object({
  name:        nonEmpty(255),
  unit:        optStr(50),
  currentQty:  z.number().min(0).max(999999).optional(),
  minQty:      z.number().min(0).max(999999).optional(),
  maxQty:      z.number().min(0).max(999999).optional().nullable().transform(v => v ?? undefined),
  costPerUnit: z.number().min(0).max(9999999).optional(),
  categoryId:  optStr(100),
  barcode:     optStr(100),
  expiryDate:  z.string().date().optional().nullable().transform(v => v ?? undefined),
  itemType:    z.enum(ITEM_TYPE_VALUES).optional(),
  purchaseUnit:     optStr(50),
  unitsPerPurchase: z.number().min(0).max(999999).optional().nullable().transform(v => v ?? undefined),
}).strip();

const updateInventoryItemSchema = z.object({
  name:        nonEmpty(255).optional(),
  unit:        optStr(50),
  currentQty:  z.number().min(0).max(999999).optional(),
  minQty:      z.number().min(0).max(999999).optional().nullable().transform(v => v ?? undefined),
  maxQty:      z.number().min(0).max(999999).optional().nullable().transform(v => v ?? undefined),
  costPerUnit: z.number().min(0).max(9999999).optional(),
  categoryId:  optStr(100),
  barcode:     optStr(100),
  expiryDate:  z.string().date().optional().nullable().transform(v => v ?? undefined),
  itemType:    z.enum(ITEM_TYPE_VALUES).optional(),
  // Missing from this schema, and .strip() drops whatever it does not list —
  // so the purchase-unit fields were silently discarded on every edit. Setting
  // a package size worked when creating an item and vanished when changing one.
  purchaseUnit:     optStr(50),
  unitsPerPurchase: z.number().min(0).max(999999).optional().nullable().transform(v => v ?? undefined),
}).strip();

const createInventoryCategorySchema = z.object({
  name: nonEmpty(100),
}).strip();

const inventoryTransactionSchema = z.object({
  type:      z.enum(['add', 'remove', 'waste', 'purchase', 'sale', 'adjustment', 'transfer'], { message: 'סוג תנועה לא חוקי' }),
  // .finite() — without it z.number() accepts Infinity/-Infinity, which
  // passes every ">0"/"!==undefined" guard in the route handler and would
  // get written straight into inventory_items.current_qty via a plain
  // `current_qty + $1` SQL update (no overflow check there either).
  // Same 999999 cap as createInventoryItemSchema's minQty — .finite() alone
  // blocks Infinity but still let an absurd value (e.g. a misplaced decimal
  // point) get written straight into current_qty with no sanity check.
  qty:       z.number().finite().min(-999999).max(999999).optional(),
  qtyChange: z.number().finite().min(-999999).max(999999).optional(),
  note:      optStr(500),
  // תאריך דיווח אופציונלי (לדיווח בזבוז מרוכז על טווח של עד שבוע אחורה) —
  // מאומת/מוגבל שוב בשרת ב-recordTransaction (יום קדימה מקסימום, שבוע אחורה)
  date:      optStr(20),
}).strip().refine(d => d.qty !== undefined || d.qtyChange !== undefined, {
  message: 'qty חובה',
  path: ['qty'],
});

// ── Suppliers ─────────────────────────────────────────────────────────────────
const createSupplierSchema = z.object({
  name:     nonEmpty(100),
  category: optStr(60),
  contacts: z.array(z.object({
    name:  optStr(100),
    phone: phoneSchema,
    email: emailSchema.optional(),
  })).max(10).optional(),
  notes: optStr(500),
}).strip();

// ── Reminders ─────────────────────────────────────────────────────────────────
const createReminderSchema = z.object({
  title:           nonEmpty(200),
  description:     optStr(500),
  remindAt:        z.string().datetime({ offset: true }),
  showOnDashboard: z.boolean().default(false),
  expiresAt:       z.string().datetime({ offset: true }).optional().nullable(),
  endAt:           z.string().datetime({ offset: true }).optional().nullable(),
  isRecurring:     z.boolean().default(false),
  recurEvery:      z.enum(['daily', 'weekly', 'monthly']).optional(),
}).strip();

// ── Reviews (batch analysis) ──────────────────────────────────────────────────
const analyzeReviewsSchema = z.object({
  platform: z.enum(['google', 'tripadvisor', 'wolt', 'tenbis', 'mishloha', 'facebook', 'other']),
  text:     z.string().min(10, 'הטקסט קצר מדי').max(20000, 'הטקסט ארוך מדי'),
}).strip();

// ── AI Analysis ───────────────────────────────────────────────────────────────
const ALLOWED_ANALYSIS_TYPES = ['general', 'revenue', 'inventory', 'employees', 'expenses'];

const analyzeParamsSchema = z.object({ userId: uuidSchema });
const analyzeBodySchema   = z.object({
  businessId:   uuidSchema,
  analysisType: z.enum(ALLOWED_ANALYSIS_TYPES).optional().default('general'),
}).strict();

// ── Queue ─────────────────────────────────────────────────────────────────────
const createQueueEntrySchema = z.object({
  name:       nonEmpty(100),
  // phone (unlike the shared, .optional() phoneSchema) is required here —
  // table_queue.phone is NOT NULL, and it's how the "table ready" WhatsApp
  // notification is sent; an omitted phone previously passed validation and
  // failed as an unhandled 500 at the DB constraint instead of a clean 400.
  phone:      z.string().regex(/^[+\d\s\-()]{7,20}$/, 'מספר טלפון לא תקין'),
  party_size: z.number().int().min(1).max(50),
  notes:      optStr(300),
}).strip();

// Public queue join — uses camelCase field names to match QR form convention
const joinQueueSchema = z.object({
  customerName: nonEmpty(80),
  phone:        z.string().regex(/^[+\d\s\-()]{7,20}$/, 'מספר טלפון לא תקין'),
  partySize:    z.number().int().min(1).max(20).default(2),
  notes:        optStr(300),
}).strip();

// ── Finance / Ledger Expenses (legacy schema — tested in validation.test.js) ──
const createExpenseSchema = z.object({
  description: optStr(200),
  amount:      z.number().min(0.01).max(9999999),
  category:    z.enum(['שכר', 'ספקים', 'שכירות', 'ציוד', 'שיווק', 'אחר']).default('אחר'),
  date:        z.string().date().optional(),
}).strip();

// ── Finance / Fixed Expenses (route schema — name + frequency required) ───────
// .strip() drops unknown keys silently, so anything the route reads off
// req.body MUST be declared here or it never arrives.
const fixedExpenseSchema = z.object({
  name:      z.string().min(1, 'שם הוצאה חובה').max(200).trim(),
  amount:    z.number().positive('סכום חייב להיות חיובי').max(9999999),
  frequency: z.enum(['monthly', 'weekly', 'yearly', 'bimonthly', 'one_time'], { message: 'תדירות לא חוקית' }),
  category:  optStr(100),
  // coerce, like salaryAmount above: a <select>/<input> posts "15", not 15,
  // and a plain z.number() would 400 on it.
  dueDay:    z.coerce.number().int().min(1).max(31).nullish(),
  startDate: z.string().date().nullish(),
  endDate:   z.string().date().nullish(),
  // Whether this expense arrives with a tax invoice whose VAT may be deducted.
  // Tri-state on purpose — null means "not answered yet", which vat.service
  // treats as unknown (excluded from the claim) rather than as a yes.
  hasTaxInvoice: z.boolean().nullish(),
}).strip();

// ── Finance / Manual Income ───────────────────────────────────────────────────
const createManualIncomeSchema = z.object({
  amount:      z.number().positive('סכום חייב להיות חיובי').max(9999999),
  description: z.string().min(1, 'תיאור חובה').max(500).trim(),
  incomeDate:  z.string().date().optional(),
}).strip();

// ── Payroll ───────────────────────────────────────────────────────────────────
const generatePayrollSchema = z.object({
  year:        z.number().int().min(2020).max(2100),
  month:       z.number().int().min(1).max(12),
  employeeIds: z.array(uuidSchema).max(500).optional(),
}).strip();

// ── Messages ──────────────────────────────────────────────────────────────────
const createMessageSchema = z.object({
  recipientIds: z.array(uuidSchema).min(1, 'נדרש לפחות נמען אחד').max(200),
  content:      z.string().min(1, 'תוכן חסר').max(4000),
  groupName:    optStr(100),
}).strip();

// ── Recipes ───────────────────────────────────────────────────────────────────
const createRecipeSchema = z.object({
  name:         nonEmpty(255),
  sellingPrice: z.number().min(0).max(99999).optional(),
  categoryId:   optStr(100),
  posItemId:    optStr(100),
  ingredients:  z.array(z.object({
    inventoryItemId: uuidSchema.nullable().optional(),
    name:            optStr(255),
    qty:             z.number().positive(),
    unit:            optStr(50),
    manualCost:      z.number().min(0).nullable().optional(),
  })).max(100).optional(),
}).strip();

const updateRecipeSchema = createRecipeSchema.partial();

// ── Dishes ────────────────────────────────────────────────────────────────────
const createDishSchema = z.object({
  name:         nonEmpty(255),
  sellingPrice: z.number().min(0).max(99999).optional(),
  notes:        optStr(500),
  dishType:     z.string().max(60).optional(),
  category:     optStr(100),
  recipeText:   z.string().max(5000).nullable().optional(),
  recipes:      z.array(z.object({ recipeId: uuidSchema, qty: z.number().min(0) })).max(20).optional(),
  ingredients:  z.array(z.object({
    inventoryItemId: uuidSchema.nullable().optional(),
    name:            optStr(255),
    qty:             z.number().min(0),
    unit:            optStr(50),
    manualCost:      z.number().min(0).nullable().optional(),
  })).max(50).optional(),
  packaging: z.array(z.any()).max(20).optional(),
}).strip();

const updateDishSchema = createDishSchema.partial();

// ── Reminders update ──────────────────────────────────────────────────────────
const updateReminderSchema = z.object({
  title:           optStr(200),
  remindAt:        z.string().datetime({ offset: true }).optional(),
  showOnDashboard: z.boolean().optional(),
  expiresAt:       z.string().datetime({ offset: true }).optional().nullable(),
  endAt:           z.string().datetime({ offset: true }).optional().nullable(),
  isRecurring:     z.boolean().optional(),
  recurEvery:      z.enum(['daily', 'weekly', 'monthly']).optional(),
}).strip();

// ── Middleware factory ─────────────────────────────────────────────────────────
function validate({ params, body, query } = {}) {
  return (req, res, next) => {
    const errors = [];

    if (params) {
      const r = params.safeParse(req.params);
      if (!r.success) errors.push(...r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
      else req.params = r.data;
    }
    if (body) {
      const r = body.safeParse(req.body);
      if (!r.success) errors.push(...r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
      else {
        // Schemas use .strip(), which silently drops any body key the schema
        // doesn't declare — the exact mechanism behind several confirmed bugs
        // (a frontend field renamed/added without updating the matching
        // schema, silently discarded in both dev and prod with no error).
        // This doesn't change behavior — .strip() still applies — it just
        // makes the drop visible instead of silent.
        if (req.body && typeof req.body === 'object') {
          const dropped = Object.keys(req.body).filter(k => !(k in r.data));
          if (dropped.length) {
            logger.warn('[validate] body field(s) silently stripped — schema/frontend mismatch?', {
              path: req.path, method: req.method, droppedFields: dropped,
            });
          }
        }
        req.body = r.data;
      }
    }
    if (query) {
      const r = query.safeParse(req.query);
      if (!r.success) errors.push(...r.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
      else req.query = r.data;
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'שגיאת קלט', details: errors });
    }
    next();
  };
}

module.exports = {
  validate,
  schemas: {
    // Auth
    registerSchema, loginOwnerSchema, loginEmployeeSchema,
    forgotPasswordSchema, resetPasswordSchema,
    // Tasks
    createTaskSchema, updateTaskSchema,
    // Customers
    createCustomerSchema, logVisitSchema,
    // Employees
    createEmployeeSchema,
    // Inventory
    createInventoryItemSchema, updateInventoryItemSchema, createInventoryCategorySchema, inventoryTransactionSchema,
    // Suppliers
    createSupplierSchema,
    // Reminders
    createReminderSchema,
    // Reviews
    analyzeReviewsSchema,
    // AI
    analyzeParamsSchema, analyzeBodySchema,
    // Queue
    createQueueEntrySchema, joinQueueSchema,
    // Finance
    createExpenseSchema, fixedExpenseSchema, createManualIncomeSchema,
    // Payroll
    generatePayrollSchema,
    // Messages
    createMessageSchema,
    // Recipes
    createRecipeSchema, updateRecipeSchema,
    // Dishes
    createDishSchema, updateDishSchema,
    // Reminders
    updateReminderSchema,
    // Utils
    uuidSchema,
  },
};
