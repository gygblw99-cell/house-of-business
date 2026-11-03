const express = require('express');
const router  = express.Router();
const { requireAuth, requireManager } = require('../middleware/auth');
const { fullCacheBust } = require('../services/sync.service');
const db = require('../utils/db');

// POST /api/sync/full — מחיקת כל הקאש + רענון נתונים לעסק
// שימושי לאחר אונבורדינג ראשוני, ייבוא גדול, או לפתרון בעיות תצוגה
router.post('/full', requireAuth, requireManager, async (req, res, next) => {
  try {
    const result = await fullCacheBust(req.user.businessId);
    res.json({ message: 'סנכרון מלא הושלם', ...result });
  } catch (err) { next(err); }
});

// GET /api/sync/status — בדיקת עקביות נתונים בסיסית
router.get('/status', requireAuth, requireManager, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const [salesRow, invoiceRow, invRow, zRow] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS cnt, MAX(sold_at) AS last FROM sales WHERE business_id = $1`, [biz]),
      db.query(`SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE is_paid = false)::int AS unpaid FROM invoices WHERE business_id = $1`, [biz]),
      db.query(`SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE current_qty <= min_qty)::int AS low FROM inventory_items WHERE business_id = $1`, [biz]),
      db.query(`SELECT COUNT(*)::int AS cnt, MAX(report_date) AS last FROM z_reports WHERE business_id = $1`, [biz]),
    ]);

    res.json({
      sales:     { count: salesRow.rows[0].cnt,   lastSale:    salesRow.rows[0].last },
      invoices:  { count: invoiceRow.rows[0].cnt,  unpaid:      invoiceRow.rows[0].unpaid },
      inventory: { count: invRow.rows[0].cnt,      lowStock:    invRow.rows[0].low },
      zReports:  { count: zRow.rows[0].cnt,        lastReport:  zRow.rows[0].last },
      syncedAt:  new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
