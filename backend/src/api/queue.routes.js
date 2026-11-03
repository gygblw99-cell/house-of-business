/**
 * Table waitlist / queue management.
 * Customers scan a QR code → join the queue from their phone.
 * Managers see the list, tap "שולחן מוכן" → wa.me link opens to notify the customer.
 */
const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const db       = require('../utils/db');
const eventBus = require('../utils/eventBus');

const joinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${req.params.businessId || 'unknown'}:${req.ip}`,
  message: { error: 'יותר מדי ניסיונות, נסה שוב בעוד מספר דקות' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

// ── Auto-create tables ────────────────────────────────────────
async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS table_queue (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id  UUID NOT NULL,
      customer_name VARCHAR(120) NOT NULL,
      phone        VARCHAR(30)  NOT NULL,
      party_size   INT NOT NULL DEFAULT 1,
      notes        TEXT,
      status       VARCHAR(20) NOT NULL DEFAULT 'waiting',
      -- status: waiting | ready | seated | cancelled
      position     INT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      notified_at  TIMESTAMPTZ,
      seated_at    TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS table_queue_business_idx
      ON table_queue(business_id, status, created_at)
  `);
}
ensureTables().catch(() => {});

// ── Manager routes (require auth) ────────────────────────────

// GET /api/queue — get current waitlist
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM table_queue
      WHERE business_id = $1
        AND status IN ('waiting','ready')
      ORDER BY created_at ASC
    `, [req.user.businessId]);

    // Assign live position numbers
    const waiting = rows.filter(r => r.status === 'waiting');
    waiting.forEach((r, i) => { r.position = i + 1; });

    res.json({ queue: rows, waiting_count: waiting.length });
  } catch (err) { next(err); }
});

// GET /api/queue/history — seated / cancelled today
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM table_queue
      WHERE business_id = $1
        AND (seated_at >= NOW() - INTERVAL '24 hours'
          OR cancelled_at >= NOW() - INTERVAL '24 hours')
      ORDER BY created_at DESC
    `, [req.user.businessId]);
    res.json({ history: rows });
  } catch (err) { next(err); }
});

// ── Helper — recompute live queue and broadcast via SSE ──────
async function _broadcastQueueUpdate(businessId) {
  try {
    const { rows } = await db.query(`
      SELECT id, customer_name, party_size, status, created_at
      FROM table_queue
      WHERE business_id = $1 AND status IN ('waiting','ready')
      ORDER BY created_at ASC
    `, [businessId]);
    const waiting = rows.filter(r => r.status === 'waiting');
    waiting.forEach((r, i) => { r.position = i + 1; });
    eventBus.publish(businessId, 'queue.updated', {
      queue: rows,
      waiting_count: waiting.length,
    });
  } catch { /* non-critical — SSE best effort */ }
}

// Normalizes a local Israeli number (the UI's own placeholder/example is
// "050-0000000") into E.164 so wa.me can actually resolve it — wa.me links
// built from a bare 0-prefixed number fail to open the right (or any) chat,
// silently breaking the "table ready" notification.
function _toWhatsAppPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0'))   return `972${digits.slice(1)}`;
  return digits;
}

// PUT /api/queue/:id/ready — notify customer their table is ready → returns wa.me link
router.put('/:id/ready', requireAuth, async (req, res, next) => {
  try {
    // Only a 'waiting' entry can become 'ready' — without this guard, calling
    // this route twice (double-click, stale tab) each returns its own wa_link,
    // so staff can independently send the "your table is ready" WhatsApp
    // message twice; calling it on an already-cancelled/seated entry silently
    // resurrects it into the live "waiting/ready" list (GET / filters on
    // status IN ('waiting','ready')).
    const { rows } = await db.query(
      `UPDATE table_queue SET status = 'ready', notified_at = NOW()
       WHERE id = $1 AND business_id = $2 AND status = 'waiting'
       RETURNING *`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) {
      const { rows: exists } = await db.query('SELECT status FROM table_queue WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
      return res.status(exists.length ? 409 : 404).json({
        error: exists.length ? `לא ניתן — הלקוח כבר במצב "${exists[0].status}"` : 'לא נמצא',
      });
    }

    const entry   = rows[0];
    const message = `שלום ${entry.customer_name}! 🎉\nהשולחן שלכם מוכן ב-House of Business.\nאנא הגיעו תוך 10 דקות.\nנתראה! 🍽️`;
    const waLink  = `https://wa.me/${_toWhatsAppPhone(entry.phone)}?text=${encodeURIComponent(message)}`;

    _broadcastQueueUpdate(req.user.businessId);
    res.json({ entry, wa_link: waLink, message });
  } catch (err) { next(err); }
});

// PUT /api/queue/:id/seated — mark as seated
router.put('/:id/seated', requireAuth, async (req, res, next) => {
  try {
    // Only a 'waiting'/'ready' entry can be seated — same reasoning as /ready:
    // without this guard, seating an already-cancelled entry silently flips
    // it back into a state that could be seated/notified again.
    const { rows } = await db.query(
      `UPDATE table_queue SET status = 'seated', seated_at = NOW()
       WHERE id = $1 AND business_id = $2 AND status IN ('waiting','ready') RETURNING *`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) {
      const { rows: exists } = await db.query('SELECT status FROM table_queue WHERE id = $1 AND business_id = $2', [req.params.id, req.user.businessId]);
      return res.status(exists.length ? 409 : 404).json({
        error: exists.length ? `לא ניתן — הלקוח כבר במצב "${exists[0].status}"` : 'לא נמצא',
      });
    }
    _broadcastQueueUpdate(req.user.businessId);
    res.json({ entry: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/queue/:id — cancel / remove
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE table_queue SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND business_id = $2 AND status IN ('waiting','ready')`,
      [req.params.id, req.user.businessId]
    );
    if (!rowCount) return res.status(404).json({ error: 'לא נמצא' });
    _broadcastQueueUpdate(req.user.businessId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Public route — customer joins queue via QR scan ──────────

// GET /api/queue/join/:businessId — public form info (business name)
router.get('/join/:businessId', joinLimiter, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT name FROM businesses WHERE id = $1',
      [req.params.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'עסק לא נמצא' });
    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int AS waiting_count
       FROM table_queue
       WHERE business_id = $1 AND status IN ('waiting','ready')`,
      [req.params.businessId]
    );
    res.json({ business_name: rows[0].name, waiting_count: stats[0].waiting_count });
  } catch (err) { next(err); }
});

// POST /api/queue/join/:businessId — customer submits name + phone + party_size
router.post('/join/:businessId', joinLimiter, validate({ body: schemas.joinQueueSchema }), async (req, res, next) => {
  let client;
  try {
    const { customerName, phone, partySize, notes } = req.body;

    client = await db.getClient();
    await client.query('BEGIN');
    // Public, unauthenticated route — verify the business actually exists
    // (table_queue.business_id has no FK constraint) before inserting,
    // matching the sibling GET /join/:businessId which already 404s for
    // unknown ids.
    const bizCheck = await client.query('SELECT 1 FROM businesses WHERE id = $1', [req.params.businessId]);
    if (!bizCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'עסק לא נמצא' });
    }
    // Advisory lock per business serializes concurrent queue inserts so two
    // simultaneous requests can't read the same COUNT and get the same position
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [req.params.businessId]);
    const { rows } = await client.query(
      `INSERT INTO table_queue (business_id, customer_name, phone, party_size, notes, position)
       VALUES ($1, $2, $3, $4, $5,
         (SELECT COUNT(*)::int + 1 FROM table_queue
          WHERE business_id = $1 AND status IN ('waiting','ready')))
       RETURNING *`,
      [req.params.businessId, customerName, phone, partySize, notes || null]
    );
    await client.query('COMMIT');
    const position = rows[0].position;

    _broadcastQueueUpdate(req.params.businessId);
    res.status(201).json({
      entry: rows[0],
      position,
      message: `תודה ${customerName}! אתם מספר ${position} בתור. נשלח לכם וואטסאפ כשהשולחן מוכן.`,
    });
  } catch (err) { if (client) await client.query('ROLLBACK').catch(() => {}); next(err); }
  finally { client?.release(); }
});

// POST /api/queue — manager adds customer manually
router.post('/', requireAuth, validate({ body: schemas.createQueueEntrySchema }), async (req, res, next) => {
  let client;
  try {
    // Fields already validated + stripped by Zod: name, phone, party_size, notes
    const { name, phone, party_size, notes } = req.body;
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [req.user.businessId]);
    const { rows } = await client.query(
      `INSERT INTO table_queue (business_id, customer_name, phone, party_size, notes, position)
       VALUES ($1, $2, $3, $4, $5,
         (SELECT COUNT(*)::int + 1 FROM table_queue
          WHERE business_id = $1 AND status IN ('waiting','ready')))
       RETURNING *`,
      [req.user.businessId, name, phone, party_size, notes || null]
    );
    await client.query('COMMIT');
    _broadcastQueueUpdate(req.user.businessId);
    res.status(201).json({ entry: rows[0], position: rows[0].position });
  } catch (err) { if (client) await client.query('ROLLBACK').catch(() => {}); next(err); }
  finally { client?.release(); }
});

module.exports = router;
