/**
 * Order Sender Service
 * שולח הזמנות לספקים דרך מייל או WhatsApp
 */

const db         = require('../../utils/db');
// Raw SMTP (nodemailer, direct to SMTP_HOST) is blocked outbound on Railway's
// network — this used to build its own transporter from SMTP_HOST/SMTP_USER
// (almost never configured in production), so every order/cancellation email
// silently failed. sendEmailFromBusiness sends via the business's own
// configured Gmail when available, falling back to the platform's Resend
// HTTPS API otherwise — same pattern already used by priceAlert.scheduler.js.
const { sendEmailFromBusiness } = require('../notifications/email.service');

// ── יצירת טקסט הזמנה ─────────────────────────────────────────
function buildOrderText(supplierName, items, noteToSupplier, businessName) {
  const itemLines = items
    .map(i => `• ${i.name}: ${i.qty_ordered} ${i.unit || ''}`.trim())
    .join('\n');

  const note = noteToSupplier ? `\nהערה: ${noteToSupplier}` : '';

  return `שלום ${supplierName},\n\nהזמנה מ${businessName} לתאריך ${_todayHebrew()}:\n\n${itemLines}${note}\n\nתודה!`;
}

// ── WhatsApp — מחזיר קישור wa.me עם טקסט מוכן ───────────────
// (בעל העסק לוחץ שלח בלבד — אין שליחה אוטומטית)
function buildWhatsAppLink(phone, text) {
  const cleanPhone = phone.replace(/\D/g, '');
  const encoded    = encodeURIComponent(text);
  return `https://wa.me/${cleanPhone}?text=${encoded}`;
}

// ── confirmOrder — שומר הזמנה ב-DB ומחזיר דרך שליחה ─────────
async function confirmAndSend(businessId, orderId, userId = null) {
  // Atomic claim — prevents a double-click or retry from sending the same
  // order to the supplier twice. Reverted back to 'pending' in the catch
  // below if the actual send fails, so a legitimate retry can claim it again.
  const claim = await db.query(
    `UPDATE daily_orders SET status = 'sending'
     WHERE id = $1 AND business_id = $2 AND status NOT IN ('sent', 'sending')
     RETURNING id`,
    [orderId, businessId]
  );
  if (!claim.rows.length) {
    const err = new Error('ההזמנה כבר נשלחה או בתהליך שליחה');
    err.status = 409;
    throw err;
  }

  try {
    return await _doSend(businessId, orderId, userId);
  } catch (err) {
    await db.query(
      `UPDATE daily_orders SET status = 'pending' WHERE id = $1 AND business_id = $2 AND status = 'sending'`,
      [orderId, businessId]
    ).catch(() => {});
    throw err;
  }
}

async function _doSend(businessId, orderId, userId = null) {
  // טעינת ההזמנה עם פרטי הספק
  const { rows } = await db.query(
    `SELECT
       d.id, d.supplier_id, d.channel, d.note_to_supplier,
       s.name AS supplier_name,
       s.preferred_channel,
       s.contact_name AS supplier_contact_name,
       s.email AS supplier_email,
       s.phone AS supplier_phone,
       b.name AS business_name,
       b.email AS business_email,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'name',       doi.name,
           'qty_ordered', doi.qty_ordered,
           'unit',       doi.unit
         )
       ) AS items,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'id',         sc.id,
           'name',       sc.name,
           'email',      sc.email,
           'phone',      sc.phone,
           'is_primary', sc.is_primary
         )
       ) FILTER (WHERE sc.id IS NOT NULL) AS contacts
     FROM daily_orders d
     INNER JOIN daily_order_items doi ON doi.order_id = d.id
     INNER JOIN suppliers s           ON s.id = d.supplier_id
     INNER JOIN businesses b          ON b.id = d.business_id
     LEFT  JOIN supplier_contacts sc  ON sc.supplier_id = s.id
     WHERE d.id = $1 AND d.business_id = $2
     GROUP BY d.id, s.name, s.preferred_channel, b.name, b.email`,
    [orderId, businessId]
  );

  const order = rows[0];
  if (!order) {
    const err = new Error('הזמנה לא נמצאה');
    err.status = 404;
    throw err;
  }

  const channel  = order.channel || order.preferred_channel || 'email';
  const text     = buildOrderText(order.supplier_name, order.items, order.note_to_supplier, order.business_name);

  // בדיקת איש קשר — עדיפות לאיש קשר ייעודי (supplier_contacts), נפילה חזרה
  // לפרטי הספק עצמו (phone/email/contact_name) כשאין רשומת איש קשר נפרדת
  const dedicatedContact = (order.contacts || []).find(c => c.is_primary) || order.contacts?.[0];
  const primaryContact = dedicatedContact || (
    (order.supplier_email || order.supplier_phone)
      ? { name: order.supplier_contact_name || order.supplier_name, email: order.supplier_email, phone: order.supplier_phone }
      : null
  );
  if (!primaryContact) {
    const err = new Error(`לספק ${order.supplier_name} אין פרטי התקשרות (טלפון/מייל) — הוסף אותם בעריכת הספק`);
    err.status = 400;
    err.code   = 'NO_CONTACT';
    throw err;
  }

  let result = {};

  if (channel === 'email') {
    if (!primaryContact.email) {
      const err = new Error('לספק אין מייל — בחר ערוץ אחר');
      err.status = 400;
      throw err;
    }
    await sendEmailFromBusiness(businessId, {
      to:      primaryContact.email,
      subject: `הזמנה מ${order.business_name} — ${_todayHebrew()}`,
      text,
    });
    result = { channel: 'email', to: primaryContact.email };
  }

  if (channel === 'whatsapp') {
    if (!primaryContact.phone) {
      const err = new Error('לספק אין טלפון — בחר ערוץ אחר');
      err.status = 400;
      throw err;
    }
    const waLink = buildWhatsAppLink(primaryContact.phone, text);
    result = { channel: 'whatsapp', waLink, text };
    // הקישור מוחזר ל-app — בעל העסק לוחץ "פתח WhatsApp" ואז שולח בעצמו בתוך
    // WhatsApp. עד אז ההזמנה לא נשלחה בפועל, אז אסור לסמן אותה 'sent' כאן —
    // מחזירים אותה ל-'pending' (ר' PUT /:orderId/mark-sent, שנקרא כשהמשתמש
    // לוחץ בפועל על הקישור).
    await db.query(
      `UPDATE daily_orders SET status = 'pending' WHERE id = $1`,
      [orderId]
    );
    return { orderId, ...result, orderText: text };
  }

  // עדכון סטטוס ב-DB — מגיע לכאן רק לערוץ email, ששם השליחה כבר קרתה בפועל למעלה
  await db.query(
    `UPDATE daily_orders SET status = 'sent', sent_at = NOW() WHERE id = $1`,
    [orderId]
  );

  // יומן פעילות — user_id זמין ב-caller (req.user.userId) אבל לא הועבר
  // לכאן, אז כל רשומת order_sent הייתה יתומה (בלתי-ניתנת לסינון/ייחוס
  // לפי משתמש ביומן הפעילות)
  await db.query(
    `INSERT INTO activity_log (business_id, user_id, action, module, entity_id, entity_name)
     VALUES ($1, $2, 'order_sent', 'suppliers', $3, $4)`,
    [businessId, userId, orderId, order.supplier_name]
  );

  return { orderId, ...result, orderText: text };
}

// ── mark-sent — נקרא כשהמשתמש לחץ בפועל על קישור WhatsApp ──
// (ל-email אין צורך: השליחה שם מאושרת אוטומטית ע"י SMTP ב-_doSend)
async function markWhatsAppSent(businessId, orderId, userId = null) {
  const { rows } = await db.query(
    `UPDATE daily_orders SET status = 'sent', sent_at = NOW()
     WHERE id = $1 AND business_id = $2 AND channel = 'whatsapp' AND status = 'pending'
     RETURNING id, supplier_id`,
    [orderId, businessId]
  );
  if (!rows.length) return null;

  const { rows: supRows } = await db.query('SELECT name FROM suppliers WHERE id = $1', [rows[0].supplier_id]);
  await db.query(
    `INSERT INTO activity_log (business_id, user_id, action, module, entity_id, entity_name)
     VALUES ($1, $2, 'order_sent', 'suppliers', $3, $4)`,
    [businessId, userId, orderId, supRows[0]?.name || null]
  ).catch(() => {});

  return rows[0];
}

// ── ביטול/שינוי הזמנה — שולח עדכון לספק ────────────────────
async function sendCancellation(businessId, orderId) {
  const { rows } = await db.query(
    `SELECT d.*, s.name AS supplier_name, b.name AS business_name, b.email AS business_email,
            sc.email AS contact_email, sc.phone AS contact_phone
     FROM daily_orders d
     INNER JOIN suppliers s          ON s.id = d.supplier_id
     INNER JOIN businesses b         ON b.id = d.business_id
     LEFT  JOIN supplier_contacts sc ON sc.supplier_id = s.id AND sc.is_primary = TRUE
     WHERE d.id = $1 AND d.business_id = $2`,
    [orderId, businessId]
  );

  const order = rows[0];
  if (!order || order.status === 'cancelled') return;

  const cancelText = `שלום ${order.supplier_name},\n\nההזמנה מתאריך ${_todayHebrew()} מ${order.business_name} בוטלה.\n\nתודה על ההבנה.`;

  if (order.channel === 'email' && order.contact_email) {
    await sendEmailFromBusiness(businessId, {
      to:      order.contact_email,
      subject: `ביטול הזמנה — ${order.business_name}`,
      text:    cancelText,
    });
  }

  await db.query(
    `UPDATE daily_orders SET status = 'cancelled' WHERE id = $1`,
    [orderId]
  );
}

// ── עזר ──────────────────────────────────────────────────────
function _todayHebrew() {
  return new Date().toLocaleDateString('he-IL', {
    day:   'numeric',
    month: 'long',
    year:  'numeric',
  });
}

module.exports = { confirmAndSend, sendCancellation, markWhatsAppSent, buildOrderText, buildWhatsAppLink };
