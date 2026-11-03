/**
 * Aviv Kasot POS Adapter
 * ממיר את תשובות ה-API של אביב קופות לפורמט פנימי אחיד
 */

const logger = require('../../utils/logger');

const BASE_URL = process.env.AVIV_API_URL || 'https://api.aviv-pos.co.il';

async function _fetch(path, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`Aviv API error: ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function testConnection(apiKey) {
  await _fetch('/api/status', apiKey);
  return true;
}

async function fetchSales(apiKey, fromDate = null) {
  const params = fromDate ? `?startDate=${fromDate.toISOString().split('T')[0]}` : '';
  const data   = await _fetch(`/api/transactions${params}`, apiKey);

  return (data.data || []).reduce((acc, s) => {
    const totalAmount = parseFloat(s.amount);
    const soldAt = new Date(s.transactionDate);
    if (!Number.isFinite(totalAmount) || Number.isNaN(soldAt.getTime())) {
      logger.warn('[Aviv] skipping sale with invalid amount/date', { posId: s.transactionId, amount: s.amount, transactionDate: s.transactionDate });
      return acc;
    }
    acc.push({
      posId:       s.transactionId,
      type:        mapSaleType(s.saleType),
      tableNumber: s.tableNo || null,
      totalAmount,
      soldAt,
      items: (s.lines || []).reduce((itemAcc, i) => {
        const qty        = parseFloat(i.qty);
        const unitPrice  = parseFloat(i.price);
        const totalPrice = parseFloat(i.lineTotal);
        if (!Number.isFinite(qty) || !Number.isFinite(unitPrice) || !Number.isFinite(totalPrice)) {
          logger.warn('[Aviv] skipping item with non-finite numerics', { name: i.itemName });
          return itemAcc;
        }
        itemAcc.push({ posItemId: i.itemCode, name: i.itemName, qty, unitPrice, totalPrice });
        return itemAcc;
      }, []),
    });
    return acc;
  }, []);
}

async function fetchProducts(apiKey) {
  const data = await _fetch('/api/items', apiKey);
  return (data.data || []).map((p) => ({
    posItemId: p.itemCode,
    name:      p.itemName,
    category:  p.groupName || null,
    price:     parseFloat(p.sellPrice || 0),
  }));
}

async function fetchCategories(apiKey) {
  const data = await _fetch('/api/groups', apiKey);
  return (data.data || []).map((c) => ({
    posId: c.groupCode,
    name:  c.groupName,
  }));
}

async function fetchZReports(apiKey, fromDate = null) {
  const params = fromDate ? `?startDate=${fromDate.toISOString().split('T')[0]}` : '';
  const data   = await _fetch(`/api/z-reports${params}`, apiKey);
  return data.data || [];
}

function mapSaleType(type) {
  const map = { '1': 'table', '2': 'delivery', '3': 'takeaway' };
  return map[String(type)] || 'other';
}

module.exports = { testConnection, fetchSales, fetchProducts, fetchCategories, fetchZReports };
