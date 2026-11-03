const db = require('../utils/db');

const findAllByBusiness = async (businessId, { activeOnly = false, limit, offset = 0 } = {}) => {
  const where = activeOnly
    ? 'WHERE s.business_id = $1 AND s.is_active = TRUE'
    : 'WHERE s.business_id = $1';

  const params = [businessId];
  let limitClause = '';
  if (limit != null) {
    params.push(limit, offset);
    limitClause = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT
       s.*,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'id',         sc.id,
           'name',       sc.name,
           'email',      sc.email,
           'phone',      sc.phone,
           'is_primary', sc.is_primary
         )
       ) FILTER (WHERE sc.id IS NOT NULL) AS contacts
     FROM suppliers s
     LEFT JOIN supplier_contacts sc ON sc.supplier_id = s.id
     ${where}
     GROUP BY s.id
     ORDER BY s.name ASC${limitClause}`,
    params
  );
  return rows;
};

const findById = async (id, businessId) => {
  const { rows } = await db.query(
    `SELECT
       s.*,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'id',         sc.id,
           'name',       sc.name,
           'email',      sc.email,
           'phone',      sc.phone,
           'is_primary', sc.is_primary
         )
       ) FILTER (WHERE sc.id IS NOT NULL) AS contacts
     FROM suppliers s
     LEFT JOIN supplier_contacts sc ON sc.supplier_id = s.id
     WHERE s.id = $1 AND s.business_id = $2
     GROUP BY s.id`,
    [id, businessId]
  );
  return rows[0] || null;
};

const create = async (businessId, { name, categories, paymentMethod, preferredChannel, preferred_channel, notes, phone, email, contact_name }) => {
  // INSERT אטומי עם ON CONFLICT — נשען על idx_suppliers_business_name_unique
  // (business_id, LOWER(TRIM(name))) WHERE is_active=TRUE. קריאה כפולה עם אותו
  // שם (case/whitespace-insensitive) לעולם לא תיצור כפילות — תחזיר/תיגע בשורה הקיימת.
  const { rows } = await db.query(
    `INSERT INTO suppliers (business_id, name, categories, payment_method, preferred_channel, notes, phone, email, contact_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (business_id, (LOWER(TRIM(name)))) WHERE is_active = TRUE
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [businessId, name.trim(), categories || [], paymentMethod, preferredChannel || preferred_channel || 'whatsapp', notes, phone || null, email || null, contact_name || null]
  );
  return rows[0];
};

const update = async (id, businessId, fields) => {
  const allowed = ['name','contact_name','phone','email','categories','payment_method','preferred_channel','notes','is_active','standing_order'];
  const keys    = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return null;

  const values = keys.map(k => fields[k]);
  const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

  const { rows } = await db.query(
    `UPDATE suppliers SET ${set}, updated_at = NOW()
     WHERE id = $${keys.length + 1} AND business_id = $${keys.length + 2}
     RETURNING *`,
    [...values, id, businessId]
  );
  return rows[0] || null;
};

const deactivate = async (id, businessId) => {
  await db.query(
    'UPDATE suppliers SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
};

// ── היסטוריית הזמנות לספק ───────────────────────────────────
const getOrderHistory = async (supplierId, businessId) => {
  const { rows } = await db.query(
    `SELECT
       d.id, d.order_date, d.status, d.channel, d.note_to_supplier,
       d.sent_at, d.confirmed_at,
       JSON_AGG(
         JSON_BUILD_OBJECT('name', doi.name, 'qty', doi.qty_ordered, 'unit', doi.unit)
       ) AS items
     FROM daily_orders d
     INNER JOIN daily_order_items doi ON doi.order_id = d.id
     WHERE d.supplier_id = $1 AND d.business_id = $2
     GROUP BY d.id
     ORDER BY d.order_date DESC
     LIMIT 90`,
    [supplierId, businessId]
  );
  return rows;
};

// ── שינויי מחירים לפריט לאורך זמן (עד שנתיים) ───────────────
const getPriceHistory = async (supplierId, businessId) => {
  const { rows } = await db.query(
    `SELECT
       ii.name        AS item_name,
       ii.unit,
       it2.unit_price,
       i.invoice_date AS date
     FROM invoice_items it2
     INNER JOIN invoices i    ON i.id = it2.invoice_id
     INNER JOIN inventory_items ii ON ii.id = it2.inventory_item_id
     WHERE i.supplier_id = $1
       AND i.business_id = $2
       AND i.invoice_date >= NOW() - INTERVAL '2 years'
     ORDER BY ii.name, i.invoice_date ASC`,
    [supplierId, businessId]
  );
  return rows;
};

// ── אנשי קשר ─────────────────────────────────────────────────
const addContact = async (supplierId, { name, email, phone, isPrimary }) => {
  if (isPrimary) {
    await db.query(
      'UPDATE supplier_contacts SET is_primary = FALSE WHERE supplier_id = $1',
      [supplierId]
    );
  }
  const { rows } = await db.query(
    `INSERT INTO supplier_contacts (supplier_id, name, email, phone, is_primary)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [supplierId, name, email, phone, isPrimary || false]
  );
  return rows[0];
};

const removeContact = async (contactId, supplierId, businessId) => {
  await db.query(
    `DELETE FROM supplier_contacts
      WHERE id = $1 AND supplier_id = $2
        AND supplier_id IN (SELECT id FROM suppliers WHERE business_id = $3)`,
    [contactId, supplierId, businessId]
  );
};

module.exports = {
  findAllByBusiness, findById, create, update, deactivate,
  getOrderHistory, getPriceHistory, addContact, removeContact,
};
