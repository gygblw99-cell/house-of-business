const express  = require('express');
const router   = express.Router();
const db       = require('../utils/db');
const logger   = require('../utils/logger');
const { requireAuth, requireManager } = require('../middleware/auth');
const { withTransaction } = require('../utils/transaction');

// ── DB Migrations ────────────────────────────────────────────────────────────

// salary_type constraint is owned by employees.routes.js (canonical location).
// tips.routes.js does NOT re-run it to avoid concurrent DROP+ADD races at startup.

// Flag: participates in the tip pool regardless of salary_type
db.migrate(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS participates_in_tips BOOLEAN NOT NULL DEFAULT FALSE
`).catch(() => {});

// One-time wizard flag — set after the manager completes the tip pool setup wizard
db.migrate(`
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tip_pool_configured_at TIMESTAMPTZ
`).catch(() => {});

// tip_entries first, then tip_distributions (which FK-references tip_entries).
// Chained with .then() so the second runs only after the first succeeds.
db.migrate(`
  CREATE TABLE IF NOT EXISTS tip_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entry_date   DATE NOT NULL,
    shift_label  TEXT,
    shift_start  TIME,
    shift_end    TIME,
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    notes        TEXT,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tip_entries_business_date
    ON tip_entries(business_id, entry_date DESC)
`).then(() => db.migrate(`
  CREATE TABLE IF NOT EXISTS tip_distributions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tip_entry_id  UUID NOT NULL REFERENCES tip_entries(id) ON DELETE CASCADE,
    employee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_name TEXT NOT NULL,
    hours_worked  NUMERIC(5,2) NOT NULL,
    amount        NUMERIC(10,2) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tip_dist_entry    ON tip_distributions(tip_entry_id);
  CREATE INDEX IF NOT EXISTS idx_tip_dist_employee ON tip_distributions(employee_id)
`)).catch(() => {});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate tip distribution for a given date and optional time window.
 * Finds all employees with participates_in_tips=true who worked during the window,
 * computes each one's overlap hours, and returns proportional amounts.
 *
 * shiftStart / shiftEnd are TIME strings ("HH:MM") or null (= full day).
 */
async function _calculateDistribution(bizId, entryDate, shiftStart, shiftEnd, totalAmount) {
  const amount = parseFloat(totalAmount);
  if (isNaN(amount) || amount <= 0) return { distributions: [], totalHours: 0 };

  let rows;
  if (shiftStart && shiftEnd) {
    // Build Israel-timezone window timestamps.
    // For overnight windows (e.g. 22:00–02:00) shiftEnd < shiftStart, so the
    // end lands on the NEXT calendar day — detected with $4::time <= $3::time.
    const { rows: r } = await db.query(`
      SELECT
        u.id          AS employee_id,
        u.full_name   AS employee_name,
        GREATEST(0,
          EXTRACT(EPOCH FROM (
            LEAST(s.actual_end,
              (CASE WHEN $4::time <= $3::time THEN ($2::date + 1)::text ELSE $2 END
               || ' ' || $4)::timestamp AT TIME ZONE 'Asia/Jerusalem'
            ) -
            GREATEST(s.actual_start,
              ($2::date || ' ' || $3)::timestamp AT TIME ZONE 'Asia/Jerusalem'
            )
          )) / 3600
        )::numeric(6,2) AS hours_worked
      FROM shifts s
      JOIN users u ON u.id = s.employee_id
      WHERE s.business_id            = $1
        AND u.business_id            = $1
        AND u.participates_in_tips   = TRUE
        AND s.actual_start IS NOT NULL
        AND s.actual_end   IS NOT NULL
        AND s.status       = 'completed'
        AND DATE(s.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2::date
        AND s.actual_start < (CASE WHEN $4::time <= $3::time THEN ($2::date + 1)::text ELSE $2 END
                              || ' ' || $4)::timestamp AT TIME ZONE 'Asia/Jerusalem'
        AND s.actual_end   > ($2::date || ' ' || $3)::timestamp AT TIME ZONE 'Asia/Jerusalem'
    `, [bizId, entryDate, shiftStart, shiftEnd]);
    rows = r;
  } else {
    // Full day — all completed shifts on the entry date, aggregated per employee
    // (GROUP BY prevents an employee who worked multiple shifts from appearing
    //  twice in the distribution with split hours/amounts).
    const { rows: r } = await db.query(`
      SELECT
        u.id          AS employee_id,
        u.full_name   AS employee_name,
        GREATEST(0,
          SUM(EXTRACT(EPOCH FROM (s.actual_end - s.actual_start))) / 3600
        )::numeric(6,2) AS hours_worked
      FROM shifts s
      JOIN users u ON u.id = s.employee_id
      WHERE s.business_id          = $1
        AND u.business_id          = $1
        AND u.participates_in_tips = TRUE
        AND s.actual_start IS NOT NULL
        AND s.actual_end   IS NOT NULL
        AND s.status       = 'completed'
        AND DATE(s.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2::date
      GROUP BY u.id, u.full_name
    `, [bizId, entryDate]);
    rows = r;
  }

  const eligible  = rows.filter(r => parseFloat(r.hours_worked) > 0);
  const totalHours = eligible.reduce((s, r) => s + parseFloat(r.hours_worked), 0);
  if (totalHours === 0) return { distributions: [], totalHours: 0 };

  const distributions = eligible.map(r => ({
    employee_id:   r.employee_id,
    employee_name: r.employee_name,
    hours_worked:  parseFloat(parseFloat(r.hours_worked).toFixed(2)),
    amount:        parseFloat(((parseFloat(r.hours_worked) / totalHours) * amount).toFixed(2)),
  }));

  // Fix rounding error on the first employee (always <= 1 agora off)
  const distributed = distributions.reduce((s, d) => s + d.amount, 0);
  const diff = parseFloat((amount - distributed).toFixed(2));
  if (distributions.length > 0 && diff !== 0) {
    distributions[0].amount = parseFloat((distributions[0].amount + diff).toFixed(2));
  }

  return { distributions, totalHours: parseFloat(totalHours.toFixed(2)) };
}

// Roles considered eligible for tip pool by default (front-of-house service roles)
const TIP_ELIGIBLE_ROLES = new Set(['waiter','head_waiter','bartender','host']);

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/tips/pool-status — wizard state + suggestions
// configured=true  → wizard was already completed (or pool already has members)
// suggestions      → employees with tip-eligible roles not yet in pool
router.get('/pool-status', requireAuth, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;

    const { rows: [biz] } = await db.query(
      'SELECT tip_pool_configured_at FROM businesses WHERE id=$1',
      [bizId]
    );
    const alreadyConfigured = !!(biz?.tip_pool_configured_at);

    // Employees with eligible roles who are active and not yet in the pool
    const { rows: suggestions } = await db.query(`
      SELECT id, full_name, position, salary_type, participates_in_tips
      FROM users
      WHERE business_id       = $1
        AND is_active          = TRUE
        AND position           = ANY($2)
        AND participates_in_tips = FALSE
        AND salary_type        != 'tips'
      ORDER BY full_name
    `, [bizId, [...TIP_ELIGIBLE_ROLES]]);

    res.json({ configured: alreadyConfigured, suggestions });
  } catch (err) { next(err); }
});

// POST /api/tips/pool-setup — complete wizard: mark selected employees + flag business
router.post('/pool-setup', requireAuth, requireManager, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;
    const { employeeIds = [] } = req.body;

    // Marking the participants and marking the pool as configured are one step.
    // Split, a failure between them left tip_pool_configured_at set with no
    // participants — the app then treats setup as done and distributes a pool
    // across nobody — or participants flagged while setup still looks pending.
    await withTransaction(async (client) => {
      if (employeeIds.length > 0) {
        await client.query(
          'UPDATE users SET participates_in_tips=TRUE WHERE id=ANY($1) AND business_id=$2',
          [employeeIds, bizId]
        );
      }

      await client.query(
        'UPDATE businesses SET tip_pool_configured_at=NOW() WHERE id=$1',
        [bizId]
      );
    });

    logger.info('[Tips] pool setup completed', { bizId, added: employeeIds.length });
    res.json({ ok: true, added: employeeIds.length });
  } catch (err) { next(err); }
});

// GET /api/tips/monthly-summary — per-employee tip totals for a given month (payslip use)
// Must be declared before /:id to avoid route collision
router.get('/monthly-summary', requireAuth, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;
    const month = parseInt(req.query.month, 10);
    const year  = parseInt(req.query.year,  10);
    if (!month || !year) return res.status(400).json({ error: 'חסרים month/year' });

    const { rows } = await db.query(`
      SELECT
        td.employee_id,
        u.full_name       AS employee_name,
        SUM(td.amount)::numeric AS total_tips,
        COUNT(td.id)::int       AS entries_count
      FROM tip_distributions td
      JOIN tip_entries te ON te.id = td.tip_entry_id
      JOIN users u        ON u.id  = td.employee_id
      WHERE te.business_id             = $1
        AND EXTRACT(YEAR  FROM te.entry_date) = $2
        AND EXTRACT(MONTH FROM te.entry_date) = $3
      GROUP BY td.employee_id, u.full_name
      ORDER BY total_tips DESC
    `, [bizId, year, month]);

    res.json({ summary: rows });
  } catch (err) { next(err); }
});

// GET /api/tips — list tip entries (optionally filtered by month/year)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;
    const params = [bizId];
    let dateFilter = '';

    const month = parseInt(req.query.month, 10);
    const year  = parseInt(req.query.year,  10);
    if (month && year) {
      params.push(year, month);
      dateFilter = `AND EXTRACT(YEAR FROM te.entry_date) = $${params.length - 1}
                    AND EXTRACT(MONTH FROM te.entry_date) = $${params.length}`;
    }

    const { rows } = await db.query(`
      SELECT
        te.*,
        json_agg(
          json_build_object(
            'employee_id',   td.employee_id,
            'employee_name', td.employee_name,
            'hours_worked',  td.hours_worked,
            'amount',        td.amount
          ) ORDER BY td.amount DESC
        ) FILTER (WHERE td.id IS NOT NULL) AS distributions
      FROM tip_entries te
      LEFT JOIN tip_distributions td ON td.tip_entry_id = te.id
      WHERE te.business_id = $1 ${dateFilter}
      GROUP BY te.id
      ORDER BY te.entry_date DESC, te.created_at DESC
    `, params);

    res.json({ entries: rows });
  } catch (err) { next(err); }
});

// POST /api/tips/preview — calculate distribution without saving
router.post('/preview', requireAuth, requireManager, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;
    const { entry_date, shift_start, shift_end, total_amount } = req.body;

    if (!entry_date || !total_amount) {
      return res.status(400).json({ error: 'חסרים entry_date ו-total_amount' });
    }

    const { distributions, totalHours } = await _calculateDistribution(
      bizId, entry_date, shift_start || null, shift_end || null, total_amount
    );

    res.json({ distributions, totalHours, totalAmount: parseFloat(total_amount) });
  } catch (err) { next(err); }
});

// POST /api/tips — save tip entry + distributions (atomic — both or neither)
router.post('/', requireAuth, requireManager, async (req, res, next) => {
  try {
    const bizId = req.user.businessId;
    const { entry_date, shift_label, shift_start, shift_end, total_amount, notes } = req.body;

    const amount = parseFloat(total_amount);
    if (!entry_date || !total_amount || isNaN(amount) || amount < 0) {
      return res.status(400).json({ error: 'חסרים entry_date ו-total_amount' });
    }

    const { distributions } = await _calculateDistribution(
      bizId, entry_date, shift_start || null, shift_end || null, total_amount
    );

    if (distributions.length === 0) {
      return res.status(422).json({
        error: 'לא נמצאו עובדים זכאים לחלוקת טיפים בתקופה זו — בדוק שהמשמרות סומנו כ"הסתיימו"',
        noEligibleEmployees: true,
      });
    }

    const client = await db.getClient();
    let entry;
    try {
      await client.query('BEGIN');

      const { rows: [e] } = await client.query(`
        INSERT INTO tip_entries
          (business_id, entry_date, shift_label, shift_start, shift_end, total_amount, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
      `, [bizId, entry_date, shift_label || null, shift_start || null, shift_end || null,
          total_amount, notes || null, req.user.userId]);
      entry = e;

      for (const d of distributions) {
        await client.query(`
          INSERT INTO tip_distributions
            (tip_entry_id, employee_id, employee_name, hours_worked, amount)
          VALUES ($1,$2,$3,$4,$5)
        `, [entry.id, d.employee_id, d.employee_name, d.hours_worked, d.amount]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    logger.info('[Tips] entry saved', {
      bizId, date: entry_date, total: total_amount, employees: distributions.length,
    });

    res.status(201).json({ entry: { ...entry, distributions } });
  } catch (err) { next(err); }
});

// DELETE /api/tips/:id — delete entry (distributions cascade)
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rows: [entry] } = await db.query(
      'SELECT id FROM tip_entries WHERE id=$1 AND business_id=$2',
      [req.params.id, req.user.businessId]
    );
    if (!entry) return res.status(404).json({ error: 'הזנה לא נמצאה' });

    await db.query('DELETE FROM tip_entries WHERE id=$1', [entry.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
