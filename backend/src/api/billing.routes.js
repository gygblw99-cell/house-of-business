/**
 * Billing — PayPlus subscription management (Israeli payment processor)
 *
 * Required env vars:
 *   PAYPLUS_API_KEY    — from PayPlus dashboard → הגדרות → API Management
 *   PAYPLUS_SECRET_KEY — same location
 *   APP_URL            — https://your-platform.com
 *
 * Flow:
 *   1. POST /checkout  → creates PayPlus payment page → returns { url }
 *   2. User pays on PayPlus page → PayPlus calls POST /webhook (IPN)
 *   3. Webhook stores card token + activates subscription in DB
 *   4. Monthly cron (scripts/charge_recurring.js) charges token automatically
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { requireAuth, requireOwner } = require('../middleware/auth');

// ── PayPlus helpers ─────────────────────────────────────────────────────────
const PP_BASE = 'https://restapi.payplus.co.il/api/v1.0';

function _ppReady() {
  return !!(process.env.PAYPLUS_API_KEY && process.env.PAYPLUS_SECRET_KEY);
}

function _ppAuth() {
  return {
    api_key:    process.env.PAYPLUS_API_KEY,
    secret_key: process.env.PAYPLUS_SECRET_KEY,
  };
}

async function _ppPost(path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(`${PP_BASE}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ authentication: _ppAuth(), ...body }),
      signal:  ac.signal,
    });
    const data = await res.json();
    // PayPlus returns results.status = "1" on success
    if (!res.ok || String(data.results?.status) !== '1') {
      throw new Error(data.results?.description || data.results?.message || `PayPlus error ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Adds exactly one calendar month without day-overflow (Jan 31 → Feb 28, not Mar 3).
function _nextMonthEnd(from) {
  const d = new Date(from);
  const target = (d.getMonth() + 1) % 12;
  d.setMonth(d.getMonth() + 1);
  if (d.getMonth() !== target) d.setDate(0);
  return d;
}

// ── DB migration ────────────────────────────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        UUID UNIQUE NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pp_token_uid       TEXT,
    pp_transaction_uid TEXT,
    plan               TEXT NOT NULL DEFAULT 'free',
    status             TEXT NOT NULL DEFAULT 'active',
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE billing_subscriptions
    ADD COLUMN IF NOT EXISTS pp_token_uid TEXT,
    ADD COLUMN IF NOT EXISTS pp_transaction_uid TEXT;
  CREATE INDEX IF NOT EXISTS idx_billing_business ON billing_subscriptions(business_id);
`);

const { PLANS } = require('../config/plans');

// ── GET /api/billing/plans ─────────────────────────────────────────────────
router.get('/plans', requireAuth, (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([key, p]) => ({
      id:        key,
      name:      p.name,
      price_ils: p.price,
      features:  _planFeatures(key),
      available: _ppReady(),
    })),
  });
});

// ── GET /api/billing/subscription ─────────────────────────────────────────
router.get('/subscription', requireAuth, async (req, res, next) => {
  try {
    const { rows: [sub] } = await db.query(
      `SELECT plan, status, current_period_end, cancel_at_period_end, created_at, updated_at
       FROM billing_subscriptions WHERE business_id=$1`,
      [req.user.businessId]
    );
    res.json(sub || { plan: 'free', status: 'active' });
  } catch (err) { next(err); }
});

// ── POST /api/billing/checkout ─────────────────────────────────────────────
// Creates a PayPlus payment page → returns { url }
router.post('/checkout', requireAuth, requireOwner, async (req, res, next) => {
  try {
    if (!_ppReady()) {
      return res.status(503).json({ error: 'PayPlus לא מוגדר עדיין — פנה לתמיכה' });
    }

    const { planId } = req.body;
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'תוכנית לא קיימת' });

    const { rows: [biz] } = await db.query(
      'SELECT name, email FROM businesses WHERE id=$1',
      [req.user.businessId]
    );

    // Proration — if there's an active paid subscription with time left on its
    // current period, credit the unused portion of the OLD plan's price
    // against the NEW plan's price, instead of charging the new plan's full
    // price on top of what was already paid for the remainder of this month.
    // Floored at ₪1 rather than allowing a ₪0 charge (avoids relying on
    // PayPlus's handling of zero-amount transactions, and keeps the flow
    // simple — always goes through the normal charge → IPN → activate path).
    const { rows: [existingSub] } = await db.query(
      `SELECT plan, current_period_end FROM billing_subscriptions
       WHERE business_id = $1 AND status = 'active' AND plan != 'free'`,
      [req.user.businessId]
    );

    let chargeAmount = plan.price;
    if (existingSub?.current_period_end && new Date(existingSub.current_period_end) > new Date()) {
      const oldPlan = PLANS[existingSub.plan];
      if (oldPlan) {
        const msRemaining   = new Date(existingSub.current_period_end).getTime() - Date.now();
        const daysRemaining = Math.max(0, msRemaining / (24 * 60 * 60 * 1000));
        const credit        = (oldPlan.price / 30) * daysRemaining;
        chargeAmount = Math.max(1, Math.round((plan.price - credit) * 100) / 100);
      }
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3002';

    const result = await _ppPost('/PaymentPages/generateLink', {
      charge_method:      2,         // credit card
      currency_code:      'ILS',
      amount:             chargeAmount,
      max_payments:       1,
      create_token:       true,      // save card for monthly recurring charges
      sendEmailApproval:  false,
      document: {
        type:       4,               // receipt
        send_email: false,
      },
      product: [{
        name:          `מנוי ${plan.name} — House of Business`,
        quantity:      1,
        price:         chargeAmount,
        currency_code: 'ILS',
      }],
      redirect_url: `${appUrl}/billing?success=1`,
      cancel_url:   `${appUrl}/billing?canceled=1`,
      customer: {
        customer_name: biz?.name  || '',
        email:         biz?.email || '',
      },
      // Encode business_id + plan so the webhook knows what to activate
      // PayPlus more_info is max 100 chars
      more_info_1: req.user.businessId,
      more_info_2: planId,
    });

    const url = result.data?.payment_page_link;
    if (!url) throw new Error('PayPlus לא החזיר URL לתשלום');

    logger.info('[Billing] PayPlus checkout page created', {
      bizId: req.user.businessId, plan: planId,
      page_uid: result.data?.payment_page_uid,
    });

    res.json({ url });
  } catch (err) {
    logger.error('[Billing] checkout error', { err: err.message });
    next(err);
  }
});

// ── POST /api/billing/cancel ───────────────────────────────────────────────
// Mark subscription to cancel at end of current period (no immediate charge)
router.post('/cancel', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { rows: [sub] } = await db.query(
      'SELECT * FROM billing_subscriptions WHERE business_id=$1',
      [req.user.businessId]
    );
    if (!sub || sub.plan === 'free') {
      return res.status(400).json({ error: 'אין מנוי פעיל לביטול' });
    }

    await db.query(`
      UPDATE billing_subscriptions
      SET cancel_at_period_end = TRUE, updated_at = NOW()
      WHERE business_id = $1
    `, [req.user.businessId]);

    logger.info('[Billing] subscription marked for cancellation', { bizId: req.user.businessId });
    res.json({ ok: true, message: 'המנוי יבוטל בסוף תקופת החיוב הנוכחית' });
  } catch (err) { next(err); }
});

// ── POST /api/billing/uncancel ─────────────────────────────────────────────
// Undo cancel — keep the subscription
router.post('/uncancel', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { rows: [sub] } = await db.query(
      'SELECT id FROM billing_subscriptions WHERE business_id=$1',
      [req.user.businessId]
    );
    if (!sub) return res.status(400).json({ error: 'אין מנוי פעיל לשחזור' });

    await db.query(`
      UPDATE billing_subscriptions
      SET cancel_at_period_end = FALSE, updated_at = NOW()
      WHERE business_id = $1
    `, [req.user.businessId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/billing/webhook ──────────────────────────────────────────────
// PayPlus IPN (Instant Payment Notification)
// Register this URL in PayPlus dashboard → הגדרות → IPN
//
// express.raw() preserves the exact bytes PayPlus signed so the HMAC check
// is computed over the same representation, not over a re-serialized object.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Never log token_uid (live charge credential) or customer PII.
  const { token_uid, customer, ...safeBody } = body || {};
  logger.info('[Billing] IPN received', { body: safeBody });

  // Reject all IPNs when PAYPLUS_SECRET_KEY is not configured — accepting
  // unverified webhook calls would allow anyone to activate free subscriptions.
  if (!process.env.PAYPLUS_SECRET_KEY) {
    logger.warn('[Billing] PAYPLUS_SECRET_KEY not set — IPN rejected.');
    return res.status(503).json({ error: 'Billing webhook not configured' });
  }

  // HMAC-SHA256 over the raw request bytes (same bytes PayPlus signed).
  const receivedHash = typeof req.headers['hash'] === 'string' ? req.headers['hash'] : null;
  const expectedHash = crypto
    .createHmac('sha256', process.env.PAYPLUS_SECRET_KEY)
    .update(req.body)
    .digest('base64');
  const hashesMatch = receivedHash !== null
    && receivedHash.length === expectedHash.length
    && crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash));
  if (!hashesMatch) {
    logger.warn('[Billing] IPN hash missing or mismatched — rejected');
    return res.status(401).json({ error: 'IPN verification failed' });
  }

  // Only process successful payments (status "1" = success)
  const status = String(body.status ?? body.StatusCode ?? '');
  if (status !== '1') {
    logger.info('[Billing] IPN: non-success status, ignoring', { status });
    return res.json({ received: true });
  }

  try {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const bizId   = body.more_info_1;
    const planId  = body.more_info_2;

    if (!bizId || !planId) {
      logger.warn('[Billing] IPN: missing more_info fields');
      return res.json({ received: true });
    }
    if (!UUID_RE.test(bizId)) {
      logger.warn('[Billing] IPN: invalid business UUID in more_info_1', { more_info_1: bizId });
      return res.json({ received: true });
    }
    const plan = PLANS[planId];
    if (!plan) {
      logger.warn('[Billing] IPN: unknown planId', { planId });
      return res.json({ received: true });
    }

    const tokenUid = body.token_uid;
    const txUid    = body.transaction_uid;

    // Idempotency — gateways retry on 5xx. Skip if we already processed this txUid.
    const { rows: [existingSub] } = await db.query(
      'SELECT pp_transaction_uid FROM billing_subscriptions WHERE business_id = $1',
      [bizId]
    );
    if (txUid && existingSub?.pp_transaction_uid === txUid) {
      logger.info('[Billing] IPN: duplicate transaction_uid — skipping', { bizId, txUid });
      return res.json({ received: true });
    }

    // Activate subscription — exactly one calendar month, no day-overflow.
    const periodEnd = _nextMonthEnd(new Date());

    await db.query(`
      INSERT INTO billing_subscriptions
        (business_id, pp_token_uid, pp_transaction_uid, plan, status, current_period_end, updated_at)
      VALUES ($1,$2,$3,$4,'active',$5,NOW())
      ON CONFLICT (business_id) DO UPDATE SET
        pp_token_uid         = COALESCE(EXCLUDED.pp_token_uid, billing_subscriptions.pp_token_uid),
        pp_transaction_uid   = EXCLUDED.pp_transaction_uid,
        plan                 = EXCLUDED.plan,
        status               = 'active',
        current_period_end   = EXCLUDED.current_period_end,
        cancel_at_period_end = FALSE,
        updated_at           = NOW()
    `, [bizId, tokenUid, txUid, planId, periodEnd]);

    logger.info('[Billing] subscription activated via IPN', { bizId, plan: planId });
    res.json({ received: true });
  } catch (err) {
    // next(err) → Express error handler → returns 500 → PayPlus retries the IPN.
    logger.error('[Billing] IPN handler error', { err: err.message });
    next(err);
  }
});

function _planFeatures(planId) {
  const common = ['דוחות Z', 'מלאי', 'ספקים', 'עובדים', 'פיננסים'];
  if (planId === 'starter')    return [...common, 'AI advisor (50 שאלות/חודש)'];
  if (planId === 'pro')        return [...common, 'AI advisor (ללא הגבלה)', 'דוח שבועי AI', 'ניתוח מחירים'];
  if (planId === 'enterprise') return [...common, 'AI ללא הגבלה', 'כל הפיצ׳רים', 'תמיכה עדיפותית'];
  return ['גישה בסיסית'];
}

module.exports = router;
