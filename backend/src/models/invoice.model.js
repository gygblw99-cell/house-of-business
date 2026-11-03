const db = require('../utils/db');
const { parseIntRange } = require('../utils/parseQuery');

const findAllByBusiness = async (businessId, { supplierId, isPaid, search, year, month, limit = 50, offset = 0 } = {}) => {
  const conditions = ['i.business_id = $1'];
  const params     = [businessId];
  let   idx        = 2;

  if (supplierId) { conditions.push(`i.supplier_id = $${idx++}`); params.push(supplierId); }
  if (isPaid !== undefined) { conditions.push(`i.is_paid = $${idx++}`); params.push(isPaid); }
  if (year)  { conditions.push(`EXTRACT(YEAR FROM i.invoice_date) = $${idx++}`);  params.push(year); }
  if (month) { conditions.push(`EXTRACT(MONTH FROM i.invoice_date) = $${idx++}`); params.push(month); }

  if (search?.trim()) {
    conditions.push(`(LOWER(s.name) LIKE $${idx} OR LOWER(i.invoice_number) LIKE $${idx})`);
    params.push(`%${search.trim().toLowerCase()}%`);
    idx++;
  }

  const safeLimit  = parseIntRange(limit,  1, 200, 50);
  const safeOffset = parseIntRange(offset, 0, 1e9,  0);

  const where = conditions.join(' AND ');
  params.push(safeLimit, safeOffset);

  const { rows } = await db.query(
    `SELECT
       i.id, i.supplier_id, s.name AS supplier_name,
       i.invoice_number, i.invoice_date, i.total_amount,
       i.is_paid, i.paid_at, i.paid_amount, i.is_duplicate, i.image_urls,
       i.ai_confidence, i.notes, i.created_at,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'id',         it.id,
           'name',       it.name,
           'qty',        it.qty,
           'unit',       it.unit,
           'unit_price', it.unit_price,
           'total_price',it.total_price
         )
       ) FILTER (WHERE it.id IS NOT NULL) AS items
     FROM invoices i
     LEFT JOIN suppliers s    ON s.id = i.supplier_id
     LEFT JOIN invoice_items it ON it.invoice_id = i.id
     WHERE ${where}
     GROUP BY i.id, s.name
     ORDER BY i.invoice_date DESC NULLS LAST, i.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  return rows;
};

const findById = async (id, businessId) => {
  const { rows } = await db.query(
    `SELECT i.*, s.name AS supplier_name,
            JSON_AGG(
              JSON_BUILD_OBJECT('id',it.id,'name',it.name,'qty',it.qty,
                'unit',it.unit,'unit_price',it.unit_price,'total_price',it.total_price)
            ) FILTER (WHERE it.id IS NOT NULL) AS items
     FROM invoices i
     LEFT JOIN suppliers s      ON s.id = i.supplier_id
     LEFT JOIN invoice_items it ON it.invoice_id = i.id
     WHERE i.id = $1 AND i.business_id = $2
     GROUP BY i.id, s.name`,
    [id, businessId]
  );
  return rows[0] || null;
};

const create = async (businessId, data, uploadedBy) => {
  const { rows } = await db.query(
    `INSERT INTO invoices
       (business_id, supplier_id, invoice_number, invoice_date, total_amount,
        vat_amount, ai_confidence, ai_raw_data, image_urls, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      businessId,
      data.supplierId    || null,
      data.invoiceNumber || null,
      data.invoiceDate   || null,
      data.totalAmount   || null,
      // The OCR agent has always extracted vatAmount (it's in the prompt and in
      // ai_raw_data) — it just had nowhere to land, so the VAT report derived
      // every invoice's VAT from the standard rate instead of reading what the
      // invoice said. `?? null` not `|| null`: a genuine 0 (zero-rated produce)
      // is the single most valuable value here and must not fall through.
      data.vatAmount != null && !isNaN(Number(data.vatAmount)) ? Number(data.vatAmount) : null,
      data.aiConfidence  || null,
      data.aiRawData     ? JSON.stringify(data.aiRawData) : null,
      data.imageUrls     || [],
      data.notes         || null,
      uploadedBy,
    ]
  );
  return rows[0];
};

// businessId מאומת כאן (לא רק ב-route הקורא) — הפונקציה בטוחה בפני עצמה
// גם אם קורא עתידי ישכח לבדוק בעלות לפני הקריאה
const addItems = async (invoiceId, businessId, items) => {
  if (!items.length) return;
  const owns = await db.query('SELECT 1 FROM invoices WHERE id=$1 AND business_id=$2', [invoiceId, businessId]);
  if (!owns.rows.length) return;
  const vals   = items.map((_, i) => { const b = i * 7; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`; }).join(',');
  const params = items.flatMap(item => [invoiceId, item.inventoryItemId || null, item.name, item.qty ?? null, item.unit || null, item.unitPrice ?? null, item.totalPrice ?? null]);
  await db.query(
    `INSERT INTO invoice_items (invoice_id, inventory_item_id, name, qty, unit, unit_price, total_price) VALUES ${vals}`,
    params
  );
};

const markPaid = async (id, businessId, isPaid) => {
  const { rows } = await db.query(
    `UPDATE invoices
     SET is_paid = $1,
         paid_at = $2,
         paid_amount = CASE WHEN $1 THEN COALESCE(total_amount, 0) ELSE paid_amount END,
         updated_at = NOW()
     WHERE id = $3 AND business_id = $4 RETURNING *`,
    [isPaid, isPaid ? new Date() : null, id, businessId]
  );
  return rows[0];
};

const recordPartialPayment = async (id, businessId, amount) => {
  const { rows } = await db.query(
    `UPDATE invoices
     SET paid_amount = $3, updated_at = NOW()
     WHERE id = $1 AND business_id = $2
     RETURNING *`,
    [id, businessId, amount]
  );
  return rows[0] || null;
};

const softDelete = async (id, businessId) => {
  // מחיקה מהארכיון בלבד — לא מבטל עדכוני מלאי/כספים
  await db.query(
    'DELETE FROM invoices WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
};

// מחזיר גם wasAlreadyApproved (approved_at כבר לא היה NULL *לפני* הקריאה הזו) —
// כך שקורא (route) יכול לדלג על פעולות שאסור להריץ פעמיים על אותה חשבונית
// (בעיקר סנכרון מלאי: לחיצה כפולה/retry על "אשר" לא אמורה להוסיף מלאי פעמיים).
// לא ניתן להשתמש ב-ai_confidence לצורך זה: צינור ה-OCR עצמו יכול לקבוע
// ai_confidence=1.0 (מודל שהיה בטוח מאוד) עוד לפני שאדם אישר בפועל, מה שהיה
// גורם לאישור האמיתי הראשון להיחשב בטעות כ"כבר אושר" ולדלג על סנכרון המלאי.
const approve = async (id, businessId, data = {}, client = db) => {
  const sets = ['updated_at = NOW()', 'approved_at = COALESCE(approved_at, NOW())'];
  const params = [id, businessId];
  let idx = 3;

  if (data.supplierId !== undefined)    { sets.push(`supplier_id = $${idx++}`);    params.push(data.supplierId || null); }
  if (data.invoiceNumber !== undefined) { sets.push(`invoice_number = $${idx++}`); params.push(data.invoiceNumber || null); }
  if (data.invoiceDate   !== undefined) { sets.push(`invoice_date = $${idx++}`);   params.push(data.invoiceDate || null); }
  if (data.totalAmount   !== undefined) { sets.push(`total_amount = $${idx++}`);   params.push(data.totalAmount != null ? data.totalAmount : null); }
  if (data.notes            !== undefined) { sets.push(`notes = $${idx++}`);             params.push(data.notes || null); }
  if (data.invoiceCategory  !== undefined) { sets.push(`invoice_category = $${idx++}`); params.push(data.invoiceCategory || 'food'); }
  // 0 is a meaningful VAT figure (zero-rated purchase), so this tests for
  // undefined rather than falsiness.
  if (data.vatAmount !== undefined) {
    sets.push(`vat_amount = $${idx++}`);
    params.push(data.vatAmount != null && !isNaN(Number(data.vatAmount)) ? Number(data.vatAmount) : null);
  } else if (data.totalAmount !== undefined) {
    // Only when the total actually MOVED. The approve route always sends
    // totalAmount — the form posts it back whether or not it was edited — so
    // an unconditional clear here wiped the OCR-extracted VAT off every
    // invoice the moment it was approved, which is exactly the value the VAT
    // report was given a column for. Comparing against prev.total_amount means
    // a corrected total drops the now-mismatched VAT (falling back to rate
    // derivation, approximate but at least self-consistent) while an untouched
    // one keeps what was read off the paper.
    sets.push(`vat_amount = CASE
                 WHEN (SELECT total_amount FROM prev) IS DISTINCT FROM $${idx}::numeric
                 THEN NULL ELSE vat_amount END`);
    params.push(data.totalAmount != null ? data.totalAmount : null);
    idx++;
  }
  sets.push(`ai_confidence = $${idx++}`);
  params.push(1.0); // מאושר ידנית = confidence מלא

  const { rows } = await client.query(
    `WITH prev AS (
       SELECT approved_at, total_amount FROM invoices WHERE id = $1 AND business_id = $2
     )
     UPDATE invoices SET ${sets.join(', ')}
     WHERE id = $1 AND business_id = $2
     RETURNING *, (SELECT approved_at FROM prev) AS previous_approved_at`,
    params
  );
  const row = rows[0];
  if (!row) return null;
  const wasAlreadyApproved = row.previous_approved_at != null;
  delete row.previous_approved_at;
  return { ...row, wasAlreadyApproved };
};

// businessId מאומת כאן (לא רק ב-route הקורא) — הפונקציה בטוחה בפני עצמה
// גם אם קורא עתידי ישכח לבדוק בעלות לפני הקריאה
const replaceItems = async (invoiceId, businessId, items, client = db) => {
  const owns = await client.query('SELECT 1 FROM invoices WHERE id=$1 AND business_id=$2', [invoiceId, businessId]);
  if (!owns.rows.length) return;
  await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [invoiceId]);
  const valid = (items || []).filter(item => item.name?.trim());
  if (!valid.length) return;
  const vals   = valid.map((_, i) => { const b = i * 7; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`; }).join(',');
  const params = valid.flatMap(item => [invoiceId, item.name.trim(), parseFloat(item.qty) || null, item.unit?.trim() || null, parseFloat(item.unit_price) || null, parseFloat(item.total_price) || null, item.item_type || 'מזון']);
  await client.query(
    `INSERT INTO invoice_items (invoice_id, name, qty, unit, unit_price, total_price, item_type) VALUES ${vals}`,
    params
  );
};

const count = async (businessId, { supplierId, isPaid, search, year, month } = {}) => {
  const conditions = ['i.business_id = $1'];
  const params = [businessId];
  let idx = 2;
  if (supplierId) { conditions.push(`i.supplier_id = $${idx++}`); params.push(supplierId); }
  if (isPaid !== undefined) { conditions.push(`i.is_paid = $${idx++}`); params.push(isPaid); }
  if (year)  { conditions.push(`EXTRACT(YEAR FROM i.invoice_date) = $${idx++}`);  params.push(year); }
  if (month) { conditions.push(`EXTRACT(MONTH FROM i.invoice_date) = $${idx++}`); params.push(month); }
  if (search?.trim()) {
    conditions.push(`(LOWER(s.name) LIKE $${idx} OR LOWER(i.invoice_number) LIKE $${idx})`);
    params.push(`%${search.trim().toLowerCase()}%`);
    idx++;
  }
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE ${conditions.join(' AND ')}`,
    params
  );
  return rows[0].total;
};

const getStats = async (businessId) => {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)                                           AS total,
       COUNT(*) FILTER (WHERE is_paid = false)           AS unpaid,
       -- is_duplicate is written by nothing in the codebase: findDuplicate
       -- REJECTS a duplicate upload rather than storing it flagged, so this
       -- counter was structurally always 0. Replaced with a count that is both
       -- real and actionable — every one of these invoices is already feeding
       -- the VAT report and COGS on un-reviewed OCR output.
       COUNT(*) FILTER (WHERE approved_at IS NULL)       AS pending_approval,
       COUNT(*) FILTER (WHERE ai_confidence < 0.8
                          AND ai_confidence IS NOT NULL)  AS low_confidence,
       COALESCE(SUM(total_amount), 0)                    AS total_amount,
       COALESCE(SUM(total_amount) FILTER (WHERE is_paid = false), 0) AS unpaid_amount
     FROM invoices
     WHERE business_id = $1`,
    [businessId]
  );
  return rows[0];
};

const updateSupplier = async (id, businessId, supplierId) => {
  await db.query(
    'UPDATE invoices SET supplier_id = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3',
    [supplierId, id, businessId]
  );
};

// בדיקת כפילות לפי מספר חשבונית + ספק + סכום
// IS NOT DISTINCT FROM (not "=") — a NULL supplierId (no supplier identified/
// matched by OCR) must still match other supplier-less invoices instead of
// silently comparing NULL = NULL (always unknown in SQL, so it never matched).
const findDuplicate = async (businessId, { supplierId, invoiceNumber, totalAmount, invoiceDate }) => {
  const numStr = invoiceNumber || '';
  const { rows } = await db.query(
    `SELECT id FROM invoices
     WHERE business_id = $1
       AND supplier_id IS NOT DISTINCT FROM $2
       AND (
         -- match by invoice number when both sides have one
         ($3 != '' AND invoice_number IS NOT NULL AND invoice_number != '' AND invoice_number = $3)
         -- fallback: match by amount+date only when neither side has an invoice number
         OR ($3 = '' AND (invoice_number IS NULL OR invoice_number = '') AND total_amount = $4 AND invoice_date = $5)
       )
     LIMIT 1`,
    [businessId, supplierId, numStr, totalAmount, invoiceDate]
  );
  return rows[0] || null;
};

module.exports = {
  findAllByBusiness, count, findById, create, addItems,
  markPaid, recordPartialPayment, approve, replaceItems, softDelete, updateSupplier, findDuplicate, getStats,
};
