/**
 * Daily Order Suggestion Service
 * מחשב כמויות מוצעות לכל פריט לפי ממוצע היסטורי ביום בשבוע
 */

const db = require('../../utils/db');

// ── כמויות מוצעות לספק ───────────────────────────────────────
async function getSuggestedOrder(businessId, supplierId) {
  const supplier = await _getSupplierWithItems(businessId, supplierId);
  if (!supplier) return null;

  // אם יש הזמנה עומדת — מחזירים אותה
  if (supplier.standing_order?.items?.length > 0) {
    return {
      supplierId,
      supplierName: supplier.name,
      isStandingOrder: true,
      items: supplier.standing_order.items,
      contacts: supplier.contacts || [],
      preferredChannel: supplier.preferred_channel,
    };
  }

  // חישוב ממוצע לפי יום בשבוע — לפי שעון ישראל ולא UTC
  const nowInIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const todayDow = nowInIsrael.getDay(); // 0=ראשון
  const items    = await _calcSuggestedQtys(businessId, supplierId, todayDow);

  return {
    supplierId,
    supplierName:    supplier.name,
    isStandingOrder: false,
    contacts:        supplier.contacts || [],
    preferredChannel: supplier.preferred_channel,
    items,
  };
}

// ── כל ההצעות ליום (לפי סדר אלפביתי) ───────────────────────
// Batched: 3-4 queries total regardless of supplier count (was N+1)
async function getAllDailySuggestions(businessId) {
  const { rows: suppliers } = await db.query(
    `SELECT s.id, s.name, s.preferred_channel, s.standing_order,
            JSON_AGG(
              JSON_BUILD_OBJECT('id',sc.id,'name',sc.name,'email',sc.email,'phone',sc.phone,'is_primary',sc.is_primary)
            ) FILTER (WHERE sc.id IS NOT NULL) AS contacts
     FROM suppliers s
     LEFT JOIN supplier_contacts sc ON sc.supplier_id = s.id
     WHERE s.business_id = $1 AND s.is_active = TRUE
     GROUP BY s.id
     ORDER BY s.name ASC`,
    [businessId]
  );

  if (!suppliers.length) return [];

  const nowInIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const todayDow    = nowInIsrael.getDay(); // 0=ראשון, לפי שעון ישראל
  const supplierIds = suppliers.map(s => s.id);

  // Batch 1: check which suppliers already have today's order
  const { rows: existingOrders } = await db.query(
    `SELECT supplier_id, id AS order_id, status
     FROM daily_orders
     WHERE business_id = $1 AND supplier_id = ANY($2) AND order_date = CURRENT_DATE`,
    [businessId, supplierIds]
  );
  const existingMap = Object.fromEntries(existingOrders.map(o => [o.supplier_id, o]));
  // A WhatsApp order sits at 'pending' until the user actually clicks the
  // wa.me link (order.sender.js leaves it there on purpose — see mark-sent) —
  // that's not "already ordered" yet, it still needs to show items/quantities
  // and the send button, same as a supplier with no order row at all today.
  const isDone = (o) => o && (o.status === 'sent' || o.status === 'confirmed');

  // Suppliers that need dynamic qty calculation (no standing order, not yet ordered)
  const needsCalcIds = suppliers
    .filter(s => !isDone(existingMap[s.id]) && !(s.standing_order?.items?.length > 0))
    .map(s => s.id);

  const calcMap = {}; // supplierId → item[]

  if (needsCalcIds.length > 0) {
    // Batch 2: historical averages per DOW for all needing calc
    const { rows: calcRows } = await db.query(
      `SELECT
         dord.supplier_id,
         doi.name,
         doi.unit,
         ROUND(AVG(doi.qty_ordered)::numeric, 2)::float AS suggested_qty
       FROM daily_order_items doi
       INNER JOIN daily_orders dord ON dord.id = doi.order_id
       WHERE dord.business_id = $1
         AND dord.supplier_id = ANY($2)
         AND dord.status IN ('sent','confirmed')
         AND EXTRACT(DOW FROM dord.order_date) = $3
       GROUP BY dord.supplier_id, doi.name, doi.unit
       ORDER BY dord.supplier_id, doi.name ASC`,
      [businessId, needsCalcIds, todayDow]
    );
    for (const row of calcRows) {
      if (!calcMap[row.supplier_id]) calcMap[row.supplier_id] = [];
      calcMap[row.supplier_id].push({ name: row.name, unit: row.unit, suggested_qty: row.suggested_qty });
    }

    // Batch 3: invoice fallback for suppliers with no DOW history
    const needsFallback = needsCalcIds.filter(id => !calcMap[id]);
    if (needsFallback.length > 0) {
      const { rows: fbRows } = await db.query(
        `SELECT
           i.supplier_id,
           ii.name,
           ii.unit,
           ROUND(AVG(it2.qty)::numeric, 2)::float AS suggested_qty
         FROM invoice_items it2
         INNER JOIN invoices i ON i.id = it2.invoice_id
         INNER JOIN inventory_items ii ON ii.id = it2.inventory_item_id
         WHERE i.business_id = $1 AND i.supplier_id = ANY($2)
         GROUP BY i.supplier_id, ii.id, ii.name, ii.unit
         ORDER BY i.supplier_id, ii.name ASC`,
        [businessId, needsFallback]
      );
      for (const row of fbRows) {
        if (!calcMap[row.supplier_id]) calcMap[row.supplier_id] = [];
        calcMap[row.supplier_id].push({ name: row.name, unit: row.unit, suggested_qty: row.suggested_qty });
      }
    }
  }

  return suppliers.map(s => {
    const existing = existingMap[s.id];
    if (isDone(existing)) {
      return {
        supplierId:      s.id,
        supplierName:    s.name,
        status:          existing.status,
        orderId:         existing.order_id,
        alreadyOrdered:  true,
        contacts:        s.contacts || [],
        preferredChannel: s.preferred_channel,
        items:           [],
      };
    }
    const isStanding = !!(s.standing_order?.items?.length > 0);
    return {
      supplierId:      s.id,
      supplierName:    s.name,
      orderId:         existing?.order_id,
      isStandingOrder: isStanding,
      alreadyOrdered:  false,
      contacts:        s.contacts || [],
      preferredChannel: s.preferred_channel,
      items:           isStanding ? s.standing_order.items : (calcMap[s.id] || []),
    };
  });
}

// ── חישוב כמויות לפי ממוצע יום בשבוע ───────────────────────
async function _calcSuggestedQtys(businessId, supplierId, dayOfWeek) {
  // שואב פריטים שהוזמנו מספק זה בעבר באותו יום בשבוע
  const { rows } = await db.query(
    `SELECT
       doi.name,
       doi.unit,
       ROUND(AVG(doi.qty_ordered)::numeric, 2)::float AS suggested_qty
     FROM daily_order_items doi
     INNER JOIN daily_orders dord ON dord.id = doi.order_id
     WHERE dord.business_id = $1
       AND dord.supplier_id = $2
       AND dord.status IN ('sent','confirmed')
       AND EXTRACT(DOW FROM dord.order_date) = $3
     GROUP BY doi.name, doi.unit
     ORDER BY doi.name ASC`,
    [businessId, supplierId, dayOfWeek]
  );

  // אם אין היסטוריה — ממוצע כללי לפריטים מהחשבוניות
  if (rows.length === 0) {
    return await _fallbackFromInvoices(businessId, supplierId);
  }

  return rows;
}

// ── fallback — כמויות מחשבוניות אם אין היסטוריית הזמנות ─────
async function _fallbackFromInvoices(businessId, supplierId) {
  const { rows } = await db.query(
    `SELECT
       ii.name,
       ii.unit,
       ROUND(AVG(it2.qty)::numeric, 2)::float AS suggested_qty
     FROM invoice_items it2
     INNER JOIN invoices i    ON i.id = it2.invoice_id
     INNER JOIN inventory_items ii ON ii.id = it2.inventory_item_id
     WHERE i.business_id = $1 AND i.supplier_id = $2
     GROUP BY ii.id, ii.name, ii.unit
     ORDER BY ii.name ASC`,
    [businessId, supplierId]
  );
  return rows;
}

async function _getSupplierWithItems(businessId, supplierId) {
  const { rows } = await db.query(
    `SELECT s.*, JSON_AGG(
       JSON_BUILD_OBJECT('id',sc.id,'name',sc.name,'email',sc.email,'phone',sc.phone,'is_primary',sc.is_primary)
     ) FILTER (WHERE sc.id IS NOT NULL) AS contacts
     FROM suppliers s
     LEFT JOIN supplier_contacts sc ON sc.supplier_id = s.id
     WHERE s.id = $1 AND s.business_id = $2 AND s.is_active = TRUE
     GROUP BY s.id`,
    [supplierId, businessId]
  );
  return rows[0] || null;
}

module.exports = { getSuggestedOrder, getAllDailySuggestions };
