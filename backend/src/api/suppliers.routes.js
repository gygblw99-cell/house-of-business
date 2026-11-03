const express  = require('express');
const router   = express.Router();
const { requireAuth, requirePermission, requireManager } = require('../middleware/auth');
const supplierModel = require('../models/supplier.model');
const { paginated }     = require('../utils/apiResponse');
const { parseIntRange } = require('../utils/parseQuery');
const { getAllDailySuggestions, getSuggestedOrder } = require('../services/suppliers/order.suggestion');
const { withTransaction } = require('../utils/transaction');
const { confirmAndSend, sendCancellation, markWhatsAppSent } = require('../services/suppliers/order.sender');
const db = require('../utils/db');

const eventBus = require('../utils/eventBus');
const { onSupplierChanged, dismissNotifications } = require('../services/sync.service');
const canSuppliers = [requireAuth, requirePermission('suppliers')];

// הוסף עמודות ישירות לטבלת suppliers אם לא קיימות
db.migrate(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone TEXT`);
db.migrate(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email TEXT`);
db.migrate(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT`);
// הרחב את CHECK constraint של preferred_channel לכלול phone ו-fax
db.migrate(`
  ALTER TABLE suppliers
    DROP CONSTRAINT IF EXISTS suppliers_preferred_channel_check;
  ALTER TABLE suppliers
    ADD CONSTRAINT suppliers_preferred_channel_check
      CHECK (preferred_channel IN ('email','whatsapp','phone','fax'));
`);
// מונע כפילויות ספק באותו עסק ברמת ה-DB (חסם אחרון — גם אם באג עתידי יעקוף
// את הבדיקה ב-application layer). רק על ספקים פעילים, כדי לא לחסום יצירה
// מחדש של שם שהועבר לארכיון (is_active=FALSE).
db.migrate(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_business_name_unique
    ON suppliers (business_id, (LOWER(TRIM(name))))
    WHERE is_active = TRUE;
`);
// At most one daily_orders row per supplier per day — the standing-order
// scheduler already assumes this (it does its own SELECT-then-INSERT
// duplicate check before creating one), but nothing enforced it at the DB
// level, and the /skip route's "ON CONFLICT DO NOTHING" had no matching
// constraint to actually apply to — it was a no-op, so a double-click on
// confirm/skip silently created a second daily_orders row (and, for
// confirm, sent a second order to the supplier).
db.migrate(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_orders_biz_supplier_date_unique
    ON daily_orders (business_id, supplier_id, order_date);
`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUPPLIERS CRUD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/suppliers?active=true&limit=50&offset=0
router.get('/', ...canSuppliers, async (req, res, next) => {
  try {
    const activeOnly = req.query.active === 'true';
    const limit      = parseIntRange(req.query.limit,  1, 200, 100);
    const offset     = parseIntRange(req.query.offset, 0, 1e9,   0);
    const activeFilter = activeOnly ? ' AND is_active = TRUE' : '';

    const [items, countRow] = await Promise.all([
      supplierModel.findAllByBusiness(req.user.businessId, { activeOnly, limit, offset }),
      db.query(`SELECT COUNT(*)::int AS total FROM suppliers WHERE business_id = $1${activeFilter}`, [req.user.businessId]),
    ]);

    paginated(res, { items, total: countRow.rows[0].total, limit, offset });
  } catch (err) { next(err); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DAILY ORDERS
//  NOTE: registered BEFORE /:id to prevent Express from matching
//  /orders/daily and /orders/pending against the /:id catch-all.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/suppliers/orders/daily — כל ההצעות ליום
router.get('/orders/daily', ...canSuppliers, async (req, res, next) => {
  try {
    const suggestions = await getAllDailySuggestions(req.user.businessId);
    res.json(suggestions);
  } catch (err) { next(err); }
});

// POST /api/suppliers/orders/daily/:supplierId/confirm — אישור הזמנה (מנהל בלבד)
router.post('/orders/daily/:supplierId/confirm', ...canSuppliers, requireManager, async (req, res, next) => {
  try {
    const { items, contactId, channel, noteToSupplier } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'אין פריטים להזמנה' });

    const supplierCheck = await supplierModel.findById(req.params.supplierId, req.user.businessId);
    if (!supplierCheck) return res.status(404).json({ error: 'ספק לא נמצא' });

    let orderId;
    try {
      orderId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO daily_orders
           (business_id, supplier_id, contact_id, order_date, status, channel, note_to_supplier, ordered_by)
         VALUES ($1,$2,$3,CURRENT_DATE,'pending',$4,$5,$6) RETURNING id`,
        [req.user.businessId, req.params.supplierId, contactId || null,
         channel || null, noteToSupplier || null, req.user.userId]
      );
      const id = rows[0].id;

      const itemValues = items.map((item, i) => {
        const base = i * 6;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`;
      }).join(',');
      const itemParams = items.flatMap(item => [
        id, item.inventoryItemId || null, item.name,
        item.qtySuggested || null, item.qtyOrdered, item.unit || null,
      ]);
      await client.query(
        `INSERT INTO daily_order_items (order_id, inventory_item_id, name, qty_suggested, qty_ordered, unit)
         VALUES ${itemValues}`,
        itemParams
      );
      return id;
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'כבר קיימת הזמנה לספק הזה היום' });
      }
      throw err;
    }

    // Send to supplier AFTER the transaction is fully committed and released
    const sendResult = await confirmAndSend(req.user.businessId, orderId, req.user.userId);
    // WhatsApp isn't actually sent yet at this point (order.sender.js leaves it
    // 'pending' until the user clicks the wa.me link — see /mark-sent below,
    // which publishes this same event once it's truly sent). Publishing here
    // for whatsapp too would make every open tab's SSE listener re-fetch
    // suggestions immediately, and the refetched row would look identical to
    // a genuinely-sent order (no way to tell "pending" from "link generated,
    // not yet clicked" apart), stranding the order with no way to complete it.
    if (sendResult.channel !== 'whatsapp') {
      eventBus.publish(req.user.businessId, 'order_sent', { orderId, supplierId: req.params.supplierId });
      dismissNotifications(req.user.businessId, 'order_ready').catch(() => {});
      dismissNotifications(req.user.businessId, 'order_pending').catch(() => {});
    }
    res.status(201).json(sendResult);
  } catch (err) { next(err); }
});

// POST /api/suppliers/orders/daily/:supplierId/skip — דילוג על ספק
router.post('/orders/daily/:supplierId/skip', ...canSuppliers, async (req, res, next) => {
  try {
    await db.query(
      `INSERT INTO daily_orders (business_id, supplier_id, order_date, status, ordered_by)
       VALUES ($1,$2,CURRENT_DATE,'skipped',$3)
       ON CONFLICT (business_id, supplier_id, order_date) DO NOTHING`,
      [req.user.businessId, req.params.supplierId, req.user.userId]
    );
    eventBus.publish(req.user.businessId, 'order_sent', { supplierId: req.params.supplierId, action: 'skipped' });
    res.json({ message: 'הספק דולג להיום' });
  } catch (err) { next(err); }
});

// PUT /api/suppliers/orders/:orderId/cancel — ביטול הזמנה שנשלחה
router.put('/orders/:orderId/cancel', ...canSuppliers, async (req, res, next) => {
  try {
    await sendCancellation(req.user.businessId, req.params.orderId);
    eventBus.publish(req.user.businessId, 'order_sent', { orderId: req.params.orderId, action: 'cancelled' });
    res.json({ message: 'הזמנה בוטלה — הודעה נשלחה לספק' });
  } catch (err) { next(err); }
});

// PUT /api/suppliers/orders/:orderId/confirm-supplier — סימון שהספק אישר
router.put('/orders/:orderId/confirm-supplier', ...canSuppliers, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE daily_orders SET status = 'confirmed', confirmed_at = NOW()
       WHERE id = $1 AND business_id = $2`,
      [req.params.orderId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'order_sent', { orderId: req.params.orderId, action: 'confirmed_by_supplier' });
    res.json({ message: 'ההזמנה סומנה כמאושרת על ידי הספק' });
  } catch (err) { next(err); }
});

// GET /api/suppliers/orders/pending — הזמנות ממתינות לאישור היום
router.get('/orders/pending', ...canSuppliers, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.supplier_id, d.order_date, d.status, d.note_to_supplier,
              s.name AS supplier_name, s.preferred_channel, s.phone, s.email,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'id', doi.id, 'name', doi.name,
                  'qty', COALESCE(doi.qty_ordered, doi.qty_suggested, 0)::float,
                  'unit', COALESCE(doi.unit,'')
                )) FILTER (WHERE doi.id IS NOT NULL),
                '[]'::json
              ) AS items
         FROM daily_orders d
         INNER JOIN suppliers s ON s.id = d.supplier_id
         LEFT  JOIN daily_order_items doi ON doi.order_id = d.id
        WHERE d.business_id = $1
          AND d.status IN ('pending','ready')
          AND d.order_date = CURRENT_DATE
        GROUP BY d.id, s.name, s.preferred_channel, s.phone, s.email
        ORDER BY s.name`,
      [req.user.businessId]
    );
    res.json({ orders: rows });
  } catch (err) { next(err); }
});

// PUT /api/suppliers/orders/:orderId — עדכון כמויות בהזמנה ממתינה
router.put('/orders/:orderId', ...canSuppliers, async (req, res, next) => {
  try {
    const { items, noteToSupplier } = req.body;
    const { rows: [order] } = await db.query(
      `SELECT id FROM daily_orders WHERE id = $1 AND business_id = $2 AND status IN ('pending','ready')`,
      [req.params.orderId, req.user.businessId]
    );
    if (!order) return res.status(404).json({ error: 'הזמנה ממתינה לא נמצאה' });

    await withTransaction(async (client) => {
      await client.query(`DELETE FROM daily_order_items WHERE order_id = $1`, [req.params.orderId]);
      const orderItems = (items || []).filter(i => i?.name);
      if (orderItems.length > 0) {
        const vals   = orderItems.map((_, i) => { const b = i * 4; return `($${b+1},$${b+2},$${b+3},$${b+3},$${b+4})`; }).join(',');
        const params = orderItems.flatMap(i => [req.params.orderId, i.name, parseFloat(i.qty) || 0, i.unit || '']);
        await client.query(
          `INSERT INTO daily_order_items (order_id, name, qty_suggested, qty_ordered, unit) VALUES ${vals}`,
          params
        );
      }
      if (noteToSupplier !== undefined) {
        await client.query(
          `UPDATE daily_orders SET note_to_supplier = $1 WHERE id = $2`,
          [noteToSupplier || null, req.params.orderId]
        );
      }
    });
    eventBus.publish(req.user.businessId, 'order_sent', { orderId: req.params.orderId, action: 'updated' });
    res.json({ message: 'הזמנה עודכנה' });
  } catch (err) { next(err); }
});

// PUT /api/suppliers/orders/:orderId/mark-sent — מסמן הזמנת WhatsApp כנשלחה
// בפועל, אחרי שהמשתמש לחץ על קישור ה-wa.me ופתח את WhatsApp (השליחה עצמה
// קורית מחוץ למערכת, אין דרך לאמת אותה — לחיצה על הקישור היא האישור היחיד שיש)
router.put('/orders/:orderId/mark-sent', ...canSuppliers, async (req, res, next) => {
  try {
    const order = await markWhatsAppSent(req.user.businessId, req.params.orderId, req.user.userId);
    if (!order) return res.status(404).json({ error: 'הזמנה ממתינה בוואטסאפ לא נמצאה' });
    eventBus.publish(req.user.businessId, 'order_sent', { orderId: req.params.orderId });
    dismissNotifications(req.user.businessId, 'order_ready').catch(() => {});
    dismissNotifications(req.user.businessId, 'order_pending').catch(() => {});
    res.json({ message: 'ההזמנה סומנה כנשלחה' });
  } catch (err) { next(err); }
});

// POST /api/suppliers/orders/:orderId/send — שליחת הזמנה ממתינה
router.post('/orders/:orderId/send', ...canSuppliers, async (req, res, next) => {
  try {
    const result = await confirmAndSend(req.user.businessId, req.params.orderId, req.user.userId);
    // See the identical guard + comment in POST /orders/daily/:supplierId/confirm above.
    if (result.channel !== 'whatsapp') {
      eventBus.publish(req.user.businessId, 'order_sent', { orderId: req.params.orderId });
      dismissNotifications(req.user.businessId, 'order_ready').catch(() => {});
      dismissNotifications(req.user.businessId, 'order_pending').catch(() => {});
    }
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/suppliers/:id
router.get('/:id', ...canSuppliers, async (req, res, next) => {
  try {
    const supplier = await supplierModel.findById(req.params.id, req.user.businessId);
    if (!supplier) return res.status(404).json({ error: 'ספק לא נמצא' });
    res.json(supplier);
  } catch (err) { next(err); }
});

// POST /api/suppliers
router.post('/', ...canSuppliers, async (req, res, next) => {
  try {
    const { name, categories, paymentMethod, payment_method, preferredChannel, preferred_channel, notes, phone, email, contact_name, contactName } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'שם ספק חסר' });
    if (name.length > 255) return res.status(400).json({ error: 'שם ספק ארוך מדי' });
    const supplier = await supplierModel.create(req.user.businessId, {
      name, categories,
      paymentMethod: paymentMethod || payment_method,
      preferredChannel: preferredChannel || preferred_channel,
      notes, phone, email,
      contact_name: contact_name || contactName,
    });
    onSupplierChanged(req.user.businessId, supplier.id).catch(() => {});
    res.status(201).json(supplier);
  } catch (err) { next(err); }
});

// PUT /api/suppliers/:id
router.put('/:id', ...canSuppliers, async (req, res, next) => {
  try {
    const updated = await supplierModel.update(req.params.id, req.user.businessId, req.body);
    if (!updated) return res.status(404).json({ error: 'ספק לא נמצא' });
    onSupplierChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/suppliers/:id — הסרה רכה (לא פעיל)
router.delete('/:id', ...canSuppliers, async (req, res, next) => {
  try {
    await supplierModel.deactivate(req.params.id, req.user.businessId);
    onSupplierChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json({ message: 'ספק הועבר לארכיון' });
  } catch (err) { next(err); }
});

// GET /api/suppliers/:id/history — היסטוריית הזמנות
router.get('/:id/history', ...canSuppliers, async (req, res, next) => {
  try {
    const history = await supplierModel.getOrderHistory(req.params.id, req.user.businessId);
    res.json(history);
  } catch (err) { next(err); }
});

// GET /api/suppliers/:id/price-history — שינויי מחירים
router.get('/:id/price-history', ...canSuppliers, async (req, res, next) => {
  try {
    const history = await supplierModel.getPriceHistory(req.params.id, req.user.businessId);
    res.json(history);
  } catch (err) { next(err); }
});

// ── אנשי קשר ─────────────────────────────────────────────────

// POST /api/suppliers/:id/contacts
router.post('/:id/contacts', ...canSuppliers, async (req, res, next) => {
  try {
    const owner = await supplierModel.findById(req.params.id, req.user.businessId);
    if (!owner) return res.status(404).json({ error: 'ספק לא נמצא' });
    const { name, email, phone, isPrimary } = req.body;
    const contact = await supplierModel.addContact(req.params.id, { name, email, phone, isPrimary });
    onSupplierChanged(req.user.businessId, req.params.id).catch(() => {});
    res.status(201).json(contact);
  } catch (err) { next(err); }
});

// DELETE /api/suppliers/:id/contacts/:contactId
router.delete('/:id/contacts/:contactId', ...canSuppliers, async (req, res, next) => {
  try {
    const owner = await supplierModel.findById(req.params.id, req.user.businessId);
    if (!owner) return res.status(404).json({ error: 'ספק לא נמצא' });
    await supplierModel.removeContact(req.params.contactId, req.params.id, req.user.businessId);
    onSupplierChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json({ message: 'איש קשר נמחק' });
  } catch (err) { next(err); }
});

module.exports = router;
