const express = require('express');
const router  = express.Router();
const db      = require('../utils/db');
const cache   = require('../utils/cache');
const eventBus = require('../utils/eventBus');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');

const can = [requireAuth, requirePermission('finance')];

// ── loyalty_settings table ────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS loyalty_settings (
    business_id       UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    points_per_shekel DECIMAL(6,2) DEFAULT 0.1,
    tier_silver       INTEGER DEFAULT 40,
    tier_gold         INTEGER DEFAULT 100,
    tier_platinum     INTEGER DEFAULT 300,
    reward_text       TEXT DEFAULT 'אחרי 10 ביקורים — פינוק בחינם!',
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS customers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name         VARCHAR(255),
    phone        VARCHAR(30) NOT NULL,
    email        VARCHAR(255),
    notes        TEXT,
    total_visits INTEGER DEFAULT 0,
    total_spent  DECIMAL(12,2) DEFAULT 0,
    points       INTEGER DEFAULT 0,
    birthday     DATE,
    first_visit  TIMESTAMPTZ DEFAULT NOW(),
    last_visit   TIMESTAMPTZ DEFAULT NOW(),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(business_id, phone)
  );
  CREATE TABLE IF NOT EXISTS customer_visits (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id    UUID REFERENCES customers(id) ON DELETE CASCADE,
    business_id    UUID,
    amount         DECIMAL(12,2) DEFAULT 0,
    points_earned  INTEGER DEFAULT 0,
    note           TEXT,
    visited_at     TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
  CREATE INDEX IF NOT EXISTS idx_customer_visits_customer ON customer_visits(customer_id);
`);

// GET /api/customers — list with stats
router.get('/', ...can, async (req, res, next) => {
  try {
    const { search, sort = 'last_visit', limit = 50 } = req.query;
    const safeSort = ['last_visit','total_visits','total_spent','points','created_at'].includes(sort) ? sort : 'last_visit';
    let sql = `
      SELECT id, name, phone, email, total_visits, total_spent, points, birthday, last_visit, first_visit
      FROM customers
      WHERE business_id = $1
    `;
    const params = [req.user.businessId];
    if (search) {
      sql += ` AND (name ILIKE $2 OR phone ILIKE $2)`;
      params.push(`%${search}%`);
    }
    params.push(Math.min(parseInt(limit) || 50, 500));
    sql += ` ORDER BY ${safeSort} DESC LIMIT $${params.length}`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/customers/stats — aggregate stats (cached 5 min)
router.get('/stats', ...can, async (req, res, next) => {
  try {
    const biz = req.user.businessId;
    const data = await cache.wrap(`customers-stats:${biz}`, async () => {
      // VIP = the business's own gold-tier threshold (settings modal on the
      // loyalty page) — was hardcoded to 100 here regardless of what the
      // business actually configured.
      const { rows: tierRows } = await db.query(
        'SELECT tier_gold FROM loyalty_settings WHERE business_id = $1', [biz]
      );
      const tierGold = tierRows[0]?.tier_gold ?? 100;

      const [statsRes, todayRes] = await Promise.all([
        db.query(`
          SELECT
            COUNT(*)::int                          AS total_customers,
            COUNT(*) FILTER (WHERE last_visit >= NOW() - INTERVAL '30 days')::int AS active_this_month,
            COUNT(*) FILTER (WHERE first_visit >= date_trunc('month', NOW()))::int AS new_this_month,
            COUNT(*) FILTER (WHERE points >= $2)::int AS vip_count,
            SUM(total_visits)::int                 AS total_visits_all,
            COALESCE(SUM(total_spent),0)::float    AS total_revenue_all
          FROM customers WHERE business_id = $1
        `, [biz, tierGold]),
        db.query(`
          SELECT COUNT(*)::int AS visits_today
          FROM customer_visits
          WHERE business_id = $1 AND visited_at >= CURRENT_DATE
        `, [biz]),
      ]);
      return { ...statsRes.rows[0], visits_today: todayRes.rows[0].visits_today };
    }, 300);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/customers/leaderboard — top 10 by points
router.get('/leaderboard', ...can, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, phone, total_visits, total_spent, points, last_visit
      FROM customers
      WHERE business_id = $1
      ORDER BY points DESC, total_visits DESC
      LIMIT 10
    `, [req.user.businessId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/customers/lookup?phone=XXX — find by phone (for quick POS lookup)
router.get('/lookup', ...can, async (req, res, next) => {
  try {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 7) return res.json(null);
    const { rows: [customer] } = await db.query(`
      SELECT id, name, phone, total_visits, points, last_visit
      FROM customers WHERE business_id = $1 AND phone LIKE $2
      LIMIT 1
    `, [req.user.businessId, `%${phone}%`]);
    res.json(customer || null);
  } catch (err) { next(err); }
});

// GET /api/customers/settings
router.get('/settings', ...can, async (req, res, next) => {
  try {
    const { rows: [s] } = await db.query(`
      SELECT * FROM loyalty_settings WHERE business_id = $1
    `, [req.user.businessId]);
    res.json(s || {
      points_per_shekel: 0.1,
      tier_silver: 40, tier_gold: 100, tier_platinum: 300,
      reward_text: 'אחרי 10 ביקורים — פינוק בחינם!',
    });
  } catch (err) { next(err); }
});

// PUT /api/customers/settings
router.put('/settings', ...can, async (req, res, next) => {
  try {
    const { points_per_shekel, tier_silver, tier_gold, tier_platinum, reward_text } = req.body;
    const { rows: [s] } = await db.query(`
      INSERT INTO loyalty_settings (business_id, points_per_shekel, tier_silver, tier_gold, tier_platinum, reward_text, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (business_id) DO UPDATE SET
        points_per_shekel = EXCLUDED.points_per_shekel,
        tier_silver       = EXCLUDED.tier_silver,
        tier_gold         = EXCLUDED.tier_gold,
        tier_platinum     = EXCLUDED.tier_platinum,
        reward_text       = EXCLUDED.reward_text,
        updated_at        = NOW()
      RETURNING *
    `, [req.user.businessId, points_per_shekel ?? 0.1, tier_silver ?? 40,
        tier_gold ?? 100, tier_platinum ?? 300, reward_text || '']);
    eventBus.publish(req.user.businessId, 'customer.updated', { action: 'settings_updated' });
    res.json(s);
  } catch (err) { next(err); }
});

// GET /api/customers/:id — full customer with recent visits
router.get('/:id', ...can, async (req, res, next) => {
  try {
    const { rows: [customer] } = await db.query(`
      SELECT id, name, phone, email, notes, total_visits, total_spent,
             points, birthday, first_visit, last_visit, created_at
      FROM customers WHERE id = $1 AND business_id = $2
    `, [req.params.id, req.user.businessId]);
    if (!customer) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const { rows: visits } = await db.query(`
      SELECT id, amount, points_earned, note, visited_at
      FROM customer_visits WHERE customer_id = $1 AND business_id = $2
      ORDER BY visited_at DESC LIMIT 20
    `, [req.params.id, req.user.businessId]);

    res.json({ ...customer, visits });
  } catch (err) { next(err); }
});

// POST /api/customers — create or get-by-phone
router.post('/', ...can, validate({ body: schemas.createCustomerSchema }), async (req, res, next) => {
  try {
    const { name, phone, email, notes, birthday } = req.body;
    if (!phone) return res.status(400).json({ error: 'מספר טלפון חובה' });

    const { rows: [customer] } = await db.query(`
      INSERT INTO customers (business_id, name, phone, email, notes, birthday)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (business_id, phone) DO UPDATE
        SET name    = COALESCE(EXCLUDED.name, customers.name),
            email   = COALESCE(EXCLUDED.email, customers.email),
            notes   = COALESCE(EXCLUDED.notes, customers.notes),
            birthday= COALESCE(EXCLUDED.birthday, customers.birthday)
      RETURNING id, name, phone, email, notes, birthday, total_visits, total_spent, points, first_visit, last_visit, created_at
    `, [req.user.businessId, name || null, phone, email || null, notes || null, birthday || null]);

    cache.del(`customers-stats:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'customer.updated', { action: 'created', customerId: customer.id });
    res.status(201).json(customer);
  } catch (err) { next(err); }
});

// PUT /api/customers/:id — update customer
router.put('/:id', ...can, async (req, res, next) => {
  try {
    const { name, phone, email, notes, birthday } = req.body;
    const { rows: [customer] } = await db.query(`
      UPDATE customers SET
        name     = COALESCE($3, name),
        phone    = COALESCE($4, phone),
        email    = COALESCE($5, email),
        notes    = COALESCE($6, notes),
        birthday = COALESCE($7, birthday)
      WHERE id = $1 AND business_id = $2
      RETURNING id, name, phone, email, notes, birthday, total_visits, total_spent, points, first_visit, last_visit, created_at
    `, [req.params.id, req.user.businessId, name, phone, email, notes, birthday || null]);
    if (!customer) return res.status(404).json({ error: 'לקוח לא נמצא' });
    cache.del(`customers-stats:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'customer.updated', { action: 'updated', customerId: customer.id });
    res.json(customer);
  } catch (err) { next(err); }
});

// POST /api/customers/:id/visit — log a visit + award points
router.post('/:id/visit', ...can, async (req, res, next) => {
  try {
    const { amount = 0, note } = req.body;
    const amountNum = Math.max(0, parseFloat(amount) || 0);

    // Fetch points_per_shekel from loyalty_settings (default 0.1 = 1pt per ₪10)
    const { rows: [ls] } = await db.query(
      'SELECT points_per_shekel FROM loyalty_settings WHERE business_id=$1',
      [req.user.businessId]
    ).catch(() => ({ rows: [] }));
    const pps = parseFloat(ls?.points_per_shekel ?? 0.1) || 0.1;
    const pointsEarned = Math.floor(amountNum * pps);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const { rows: [updated] } = await client.query(`
        UPDATE customers SET
          total_visits = total_visits + 1,
          total_spent  = total_spent + $3,
          points       = points + $4,
          last_visit   = NOW()
        WHERE id = $1 AND business_id = $2
        RETURNING id, name, total_visits, total_spent, points
      `, [req.params.id, req.user.businessId, amountNum, pointsEarned]);

      if (!updated) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'לקוח לא נמצא' });
      }

      await client.query(`
        INSERT INTO customer_visits (customer_id, business_id, amount, points_earned, note)
        VALUES ($1,$2,$3,$4,$5)
      `, [req.params.id, req.user.businessId, amountNum, pointsEarned, note || null]);

      await client.query('COMMIT');
      cache.del(`customers-stats:${req.user.businessId}`).catch(() => {});
      eventBus.publish(req.user.businessId, 'customer.updated', { action: 'visit_recorded', customerId: req.params.id });
      res.json({ ...updated, pointsEarned, message: `ביקור נרשם! +${pointsEarned} נקודות` });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

// DELETE /api/customers/:id
router.delete('/:id', ...can, async (req, res, next) => {
  try {
    await db.query(`DELETE FROM customers WHERE id=$1 AND business_id=$2`, [req.params.id, req.user.businessId]);
    cache.del(`customers-stats:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'customer.updated', { action: 'deleted', customerId: req.params.id });
    res.json({ message: 'לקוח נמחק' });
  } catch (err) { next(err); }
});

module.exports = router;
