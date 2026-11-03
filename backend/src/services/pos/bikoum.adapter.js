/**
 * Bikoum POS Adapter
 * ממיר את תשובות ה-API של ביקום לפורמט פנימי אחיד
 */

const logger = require('../../utils/logger');

const BASE_URL = process.env.BIKOUM_API_URL || 'https://api.bikoum.co.il';

async function _fetch(path, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`Bikoum API error: ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// בדיקת חיבור תקין
async function testConnection(apiKey) {
  await _fetch('/v1/ping', apiKey);
  return true;
}

// שאיבת כל המכירות — מתאריך נתון (null = כל ההיסטוריה)
async function fetchSales(apiKey, fromDate = null) {
  const params = fromDate ? `?from=${fromDate.toISOString()}` : '';
  const data   = await _fetch(`/v1/sales${params}`, apiKey);

  return (data.sales || []).reduce((acc, s) => {
    const totalAmount = parseFloat(s.total);
    const soldAt = new Date(s.created_at);
    if (!Number.isFinite(totalAmount) || Number.isNaN(soldAt.getTime())) {
      logger.warn('[Bikoum] skipping sale with invalid total/date', { posId: s.id, total: s.total, created_at: s.created_at });
      return acc;
    }
    acc.push({
      posId:      s.id,
      type:       mapSaleType(s.type),
      tableNumber: s.table_number || null,
      totalAmount,
      soldAt,
      items: (s.items || []).reduce((itemAcc, i) => {
        const qty        = parseFloat(i.quantity);
        const unitPrice  = parseFloat(i.unit_price);
        const totalPrice = parseFloat(i.total);
        if (!Number.isFinite(qty) || !Number.isFinite(unitPrice) || !Number.isFinite(totalPrice)) {
          logger.warn('[Bikoum] skipping item with non-finite numerics', { name: i.name });
          return itemAcc;
        }
        itemAcc.push({ posItemId: i.product_id, name: i.name, qty, unitPrice, totalPrice });
        return itemAcc;
      }, []),
    });
    return acc;
  }, []);
}

// שאיבת פריטי תפריט/מוצרים
async function fetchProducts(apiKey) {
  const data = await _fetch('/v1/products', apiKey);

  return (data.products || []).map((p) => ({
    posItemId:  p.id,
    name:       p.name,
    category:   p.category_name || null,
    price:      parseFloat(p.price || 0),
  }));
}

// שאיבת קטגוריות מנות
async function fetchCategories(apiKey) {
  const data = await _fetch('/v1/categories', apiKey);
  return (data.categories || []).map((c) => ({
    posId: c.id,
    name:  c.name,
  }));
}

// שאיבת דוחות Z
async function fetchZReports(apiKey, fromDate = null) {
  const params = fromDate ? `?from=${fromDate.toISOString()}` : '';
  const data   = await _fetch(`/v1/z-reports${params}`, apiKey);
  return data.reports || [];
}

function mapSaleType(type) {
  const map = { table: 'table', delivery: 'delivery', takeaway: 'takeaway' };
  return map[type] || 'other';
}

module.exports = { testConnection, fetchSales, fetchProducts, fetchCategories, fetchZReports };
