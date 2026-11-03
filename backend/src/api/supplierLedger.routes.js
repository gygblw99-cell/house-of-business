const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission, requireManager } = require('../middleware/auth');
const db = require('../utils/db');

// Run migration on startup
db.migrate(`
  CREATE TABLE IF NOT EXISTS supplier_payments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    method      VARCHAR(50) DEFAULT 'bank_transfer',
    reference   TEXT,
    notes       TEXT,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_business ON supplier_payments(business_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id, payment_date DESC)`);

const canSuppliers = [requireAuth, requirePermission('suppliers')];

// GET /api/supplier-ledger — כל הספקים עם יתרות
router.get('/', ...canSuppliers, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const { rows } = await db.query(`
      SELECT
        s.id, s.name, s.phone, s.email,
        COALESCE(inv_totals.total_invoiced, 0)::float   AS total_invoiced,
        COALESCE(pay_totals.total_paid, 0)::float        AS total_paid,
        COALESCE(inv_totals.total_invoiced, 0)
          - COALESCE(pay_totals.total_paid, 0)           AS balance,
        COALESCE(inv_totals.open_invoices, 0)::int       AS open_invoices,
        inv_totals.oldest_unpaid
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_id,
               SUM(total_amount)::float           AS total_invoiced,
               COUNT(*) FILTER (WHERE is_paid = false)::int AS open_invoices,
               MIN(invoice_date) FILTER (WHERE is_paid = false) AS oldest_unpaid
        FROM invoices
        WHERE business_id = $1
        GROUP BY supplier_id
      ) inv_totals ON inv_totals.supplier_id = s.id
      LEFT JOIN (
        SELECT supplier_id, SUM(amount)::float AS total_paid
        FROM supplier_payments
        WHERE business_id = $1
        GROUP BY supplier_id
      ) pay_totals ON pay_totals.supplier_id = s.id
      WHERE s.business_id = $1
        AND s.is_active = true
      ORDER BY balance DESC
    `, [biz]);

    res.json({ suppliers: rows });
  } catch (err) { next(err); }
});

// GET /api/supplier-ledger/:supplierId — ספר חשבונות מפורט
router.get('/:supplierId', ...canSuppliers, async (req, res, next) => {
  try {
    const { supplierId } = req.params;
    const biz = req.user.businessId;

    // Verify supplier belongs to this business
    const { rows: [supplier] } = await db.query(
      'SELECT id, name, phone, email, payment_method FROM suppliers WHERE id=$1 AND business_id=$2',
      [supplierId, biz]
    );
    if (!supplier) return res.status(404).json({ error: 'ספק לא נמצא' });

    // Total invoiced — computed in SQL to avoid being capped by the LIMIT 100 below
    const { rows: totals } = await db.query(
      `SELECT COALESCE(SUM(total_amount),0) AS total_invoiced
       FROM invoices WHERE supplier_id=$1 AND business_id=$2`,
      [supplierId, biz]
    );
    const totalInvoiced = parseFloat(totals[0].total_invoiced);

    // Invoices from this supplier (last 100 for ledger display)
    const { rows: invoices } = await db.query(`
      SELECT id, invoice_number, invoice_date, total_amount::float,
             is_paid, paid_at, notes
      FROM invoices
      WHERE supplier_id = $1 AND business_id = $2
      ORDER BY invoice_date DESC
      LIMIT 100
    `, [supplierId, biz]);

    // Payments to this supplier
    const { rows: payments } = await db.query(`
      SELECT id, amount::float, payment_date, method, reference, notes, created_at
      FROM supplier_payments
      WHERE supplier_id = $1 AND business_id = $2
      ORDER BY payment_date DESC
    `, [supplierId, biz]);

    // Build chronological ledger (merge invoices + payments, sorted by date)
    const entries = [
      ...invoices.map(i => ({
        type: 'invoice',
        id: i.id,
        date: i.invoice_date,
        description: `חשבונית ${i.invoice_number || i.id.slice(0,8)}`,
        debit: parseFloat(i.total_amount),
        credit: 0,
        status: i.is_paid ? 'paid' : 'open',
        paid_at: i.paid_at,
        notes: i.notes,
      })),
      ...payments.map(p => ({
        type: 'payment',
        id: p.id,
        date: p.payment_date,
        description: `תשלום — ${p.method}${p.reference ? ` (${p.reference})` : ''}`,
        debit: 0,
        credit: parseFloat(p.amount),
        notes: p.notes,
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Running balance (oldest first)
    let running = 0;
    const withBalance = [...entries].reverse().map(e => {
      running += e.debit - e.credit;
      return { ...e, running_balance: parseFloat(running.toFixed(2)) };
    }).reverse();

    const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount), 0);

    res.json({
      supplier,
      summary: {
        total_invoiced: parseFloat(totalInvoiced.toFixed(2)),
        total_paid:     parseFloat(totalPaid.toFixed(2)),
        balance:        parseFloat((totalInvoiced - totalPaid).toFixed(2)),
        open_invoices:  invoices.filter(i => !i.is_paid).length,
      },
      entries: withBalance,
    });
  } catch (err) { next(err); }
});

// POST /api/supplier-ledger/:supplierId/payment — רשום תשלום
router.post('/:supplierId/payment', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { supplierId } = req.params;
    const biz = req.user.businessId;
    const { amount, method, reference, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'סכום תשלום לא תקין' });

    const payment_date = req.body.payment_date || new Date().toISOString().slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) {
      return res.status(400).json({ error: 'תאריך תשלום לא תקין (נדרש YYYY-MM-DD)' });
    }

    // Verify supplier ownership
    const { rows: [supplier] } = await db.query(
      'SELECT id FROM suppliers WHERE id=$1 AND business_id=$2',
      [supplierId, biz]
    );
    if (!supplier) return res.status(404).json({ error: 'ספק לא נמצא' });

    const { rows: [payment] } = await db.query(`
      INSERT INTO supplier_payments
        (business_id, supplier_id, amount, payment_date, method, reference, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [biz, supplierId, parseFloat(amount),
        payment_date,
        method || 'bank_transfer', reference || null,
        notes || null, req.user.userId]);

    res.status(201).json({ payment });
  } catch (err) { next(err); }
});

// DELETE /api/supplier-ledger/payment/:paymentId — מחק תשלום
router.delete('/payment/:paymentId', requireAuth, requireManager, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const result = await db.query(
      'DELETE FROM supplier_payments WHERE id=$1 AND business_id=$2',
      [req.params.paymentId, biz]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'תשלום לא נמצא' });
    res.json({ message: 'תשלום נמחק' });
  } catch (err) { next(err); }
});

module.exports = router;
