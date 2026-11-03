/**
 * Recurring subscription charges — PayPlus monthly billing.
 *
 * Extracted from scripts/charge_recurring.js so the exact same logic can run
 * either as a standalone CLI/PM2-cron invocation (docker-compose/bare-metal
 * deploys) or in-process on a schedule (see billing.scheduler.js) — Railway
 * runs `node src/index.js` directly with no PM2, so the PM2 cron_restart
 * entry in ecosystem.config.js never actually fires there.
 */
const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { PLANS } = require('../../config/plans');

const PP_BASE = 'https://restapi.payplus.co.il/api/v1.0';
const MAX_FAIL_BEFORE_PASTDUE = 3;

// Adds exactly one calendar month without day-overflow (Jan 31 → Feb 28, not Mar 3).
function _nextMonthEnd(from) {
  const d = new Date(from);
  const target = (d.getMonth() + 1) % 12;
  d.setMonth(d.getMonth() + 1);
  if (d.getMonth() !== target) d.setDate(0);
  return d;
}

async function _ppPost(path, body) {
  const res = await fetch(`${PP_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      authentication: {
        api_key:    process.env.PAYPLUS_API_KEY,
        secret_key: process.env.PAYPLUS_SECRET_KEY,
      },
      ...body,
    }),
  });
  const data = await res.json();
  if (!res.ok || String(data.results?.status) !== '1') {
    throw new Error(data.results?.description || `PayPlus error ${res.status}`);
  }
  return data;
}

async function _notifyFailure(businessId, bizName, plan, errMsg) {
  await db.query(`
    INSERT INTO notifications (business_id, user_id, type, title, body)
    SELECT $1, u.id, 'billing_charge_failed', $2, $3
    FROM users u
    WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM notifications
      WHERE business_id = $1 AND type = 'billing_charge_failed'
        AND created_at >= NOW() - INTERVAL '3 days'
    )
    LIMIT 1
  `, [
    businessId,
    'חיוב חודשי נכשל',
    `לא ניתן לחייב את המנוי שלך (${plan}). אנא עדכן את פרטי התשלום בהגדרות.`,
  ]).catch(e => logger.warn('[RecurringCharge] failed to write notification', { e: e.message }));

  logger.error('[RecurringCharge] Charge failed — owner notified', {
    bizId: businessId, bizName, plan, err: errMsg,
  });
}

/**
 * Charges every subscription whose current_period_end has passed, using the
 * stored PayPlus card token. Each subscription is processed inside its own
 * transaction on a single checked-out client (BEGIN … SELECT FOR UPDATE SKIP
 * LOCKED … charge … UPDATE … COMMIT) so the row lock is actually held for the
 * whole processing window — a bare db.query() per statement would release
 * the lock right after the SELECT (autocommit, no shared transaction), which
 * would let two overlapping runs both charge the same subscription.
 */
async function runRecurringCharges() {
  if (!process.env.PAYPLUS_API_KEY || !process.env.PAYPLUS_SECRET_KEY) {
    logger.warn('[RecurringCharge] PayPlus not configured — skipping');
    return { success: 0, failed: 0, canceled: 0, skipped: true };
  }

  // Add failed_charge_count column if it doesn't exist yet (safe on first run)
  await db.query(`
    ALTER TABLE billing_subscriptions
      ADD COLUMN IF NOT EXISTS failed_charge_count INTEGER NOT NULL DEFAULT 0
  `).catch(() => {});

  let success = 0;
  let failed  = 0;

  while (true) {
    const client = await db.getClient();
    let sub;
    try {
      await client.query('BEGIN');
      ({ rows: [sub] } = await client.query(`
        SELECT bs.id, bs.business_id, bs.pp_token_uid, bs.plan,
               bs.failed_charge_count, b.name AS biz_name, b.primary_email
        FROM billing_subscriptions bs
        JOIN businesses b ON b.id = bs.business_id
        WHERE bs.status = 'active'
          AND bs.cancel_at_period_end = FALSE
          AND bs.current_period_end   <= NOW()
          AND bs.pp_token_uid IS NOT NULL
        ORDER BY bs.current_period_end ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `));

      if (!sub) {
        await client.query('COMMIT');
        client.release();
        break;
      }

      const plan = PLANS[sub.plan];
      if (!plan) {
        logger.warn('[RecurringCharge] Unknown plan — marking canceled', {
          bizId: sub.business_id, plan: sub.plan,
        });
        await client.query(`
          UPDATE billing_subscriptions SET status = 'canceled', updated_at = NOW() WHERE id = $1
        `, [sub.id]);
        await client.query('COMMIT');
        client.release();
        continue;
      }

      // Write audit record before calling PayPlus
      await client.query(`
        INSERT INTO billing_events (business_id, type, plan, amount, status)
        VALUES ($1, 'charge_attempt', $2, $3, 'pending')
      `, [sub.business_id, sub.plan, plan.price]).catch(() => {});

      try {
        const result = await _ppPost('/Transactions/ChargeToken', {
          token_uid:     sub.pp_token_uid,
          amount:        plan.price,
          currency_code: 'ILS',
          more_info_1:   sub.business_id,
          more_info_2:   sub.plan,
        });

        const txUid = result.data?.transaction_uid;
        // Anchor to current_period_end so the billing cycle never drifts,
        // regardless of when the scheduler actually fires.
        const newPeriodEnd = _nextMonthEnd(sub.current_period_end);

        await client.query(`
          UPDATE billing_subscriptions SET
            pp_transaction_uid  = $1,
            current_period_end  = $2,
            status              = 'active',
            failed_charge_count = 0,
            updated_at          = NOW()
          WHERE id = $3
        `, [txUid, newPeriodEnd, sub.id]);

        await client.query(`
          INSERT INTO billing_events (business_id, type, plan, amount, transaction_id, status)
          VALUES ($1, 'charge_success', $2, $3, $4, 'success')
        `, [sub.business_id, sub.plan, plan.price, txUid]).catch(() => {});

        await client.query('COMMIT');

        logger.info('[RecurringCharge] Charged successfully', {
          bizId: sub.business_id, plan: sub.plan, amount: plan.price, txUid,
        });
        success++;
      } catch (err) {
        const newFailCount = (sub.failed_charge_count || 0) + 1;
        const newStatus = newFailCount >= MAX_FAIL_BEFORE_PASTDUE ? 'past_due' : 'active';

        await client.query(`
          UPDATE billing_subscriptions SET
            failed_charge_count = $1,
            status              = $2,
            updated_at          = NOW()
          WHERE id = $3
        `, [newFailCount, newStatus, sub.id]);

        await client.query(`
          INSERT INTO billing_events (business_id, type, plan, amount, status, error_message)
          VALUES ($1, 'charge_failed', $2, $3, 'failed', $4)
        `, [sub.business_id, sub.plan, plan.price, err.message]).catch(() => {});

        await client.query('COMMIT');

        await _notifyFailure(sub.business_id, sub.biz_name, sub.plan, err.message);

        if (newStatus === 'past_due') {
          logger.warn('[RecurringCharge] Subscription past_due after max failures', {
            bizId: sub.business_id, failCount: newFailCount,
          });
        }
        failed++;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();
  }

  // Cancel subscriptions past their period and marked for cancellation
  const { rowCount: canceled } = await db.query(`
    UPDATE billing_subscriptions SET
      plan               = 'free',
      status             = 'canceled',
      pp_token_uid       = NULL,
      current_period_end = NULL,
      updated_at         = NOW()
    WHERE cancel_at_period_end = TRUE
      AND current_period_end   <= NOW()
  `);

  logger.info(`[RecurringCharge] Done — success: ${success}, failed: ${failed}, canceled: ${canceled}`);
  return { success, failed, canceled, skipped: false };
}

module.exports = { runRecurringCharges };
