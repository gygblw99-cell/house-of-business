/**
 * Manual-billing auto-suspend scheduler.
 *
 * Runs daily at 09:00 Asia/Jerusalem. For every active business that has a
 * billing agreement (billing_day + monthly_fee + billing_start_date), checks
 * whether the current billing cycle is overdue:
 *
 *   overdue = today > billing_day + grace_period_days
 *             AND no payment recorded in the current billing cycle
 *
 * If overdue → suspend the business (suspended_at = NOW(), suspended_reason
 * explains it was automatic) and log to the admin console.
 *
 * Note: this only auto-suspends — an admin must manually unsuspend once payment
 * is received (via the existing admin "unsuspend" endpoint).
 */

const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { currentCycle, isCycleOverdue, israelToday } = require('./billingCycle');
const { locked } = require('../../utils/jobLock');

const TARGET_HOUR = 9; // 09:00 Asia/Jerusalem

function _msUntilIsraelHour(targetHour) {
  const nowMs  = Date.now();
  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get     = t => ilParts.find(p => p.type === t)?.value;
  const ilHour  = parseInt(get('hour')   ?? '0', 10);
  const ilMin   = parseInt(get('minute') ?? '0', 10);
  const elapsedMs = (ilHour * 60 + ilMin) * 60000;
  const targetMs  = targetHour * 3600000;
  const remaining = targetMs - elapsedMs;
  return remaining > 0 ? remaining : 86400000 + remaining;
}

async function checkOverdueBusinesses() {
  logger.info('[ManualBilling] checking for overdue businesses');

  // Fetch all active businesses with a billing agreement.
  // "Active" = is_active IS NOT FALSE AND suspended_at IS NULL
  // (we skip already-suspended businesses — they can't become more suspended).
  const { rows } = await db.query(`
    SELECT b.id, b.name,
           b.billing_day, b.monthly_fee::float AS monthly_fee,
           b.billing_start_date::text AS billing_start_date,
           b.grace_period_days,
           -- last payment date for this business
           (SELECT MAX(p.payment_date)::text
            FROM manual_payments p
            WHERE p.business_id = b.id) AS last_payment,
           -- total paid
           (SELECT COALESCE(SUM(p.amount), 0)::float
            FROM manual_payments p
            WHERE p.business_id = b.id) AS total_paid
    FROM businesses b
    WHERE b.billing_day IS NOT NULL
      AND b.monthly_fee IS NOT NULL
      AND b.billing_start_date IS NOT NULL
      AND (b.is_active IS NOT FALSE)
      AND b.suspended_at IS NULL
  `).catch(err => {
    logger.error('[ManualBilling] query failed', { err: err.message });
    return { rows: [] };
  });

  if (!rows.length) return;

  // "Today" as Israel calendar date parts.
  const { todayY: ty, todayM: tm, todayD: td, todayTs } = israelToday();

  let suspended = 0;

  for (const biz of rows) {
    const { id, name, billing_day, monthly_fee, billing_start_date, grace_period_days, last_payment, total_paid } = biz;

    const cycleArgs = {
      billingDay:       billing_day,
      gracePeriodDays:  grace_period_days,
      billingStartDate: billing_start_date,
      lastPayment:      last_payment,
      todayTs, todayY: ty, todayM: tm, todayD: td,
    };
    if (!isCycleOverdue(cycleArgs)) continue;

    const { dueTs } = currentCycle(cycleArgs);
    const dueDateStr = new Date(dueTs).toISOString().slice(0, 10);

    // Auto-suspend.
    await db.query(
      // billing_deactivated marks THIS as the reason is_active went false, so
      // unsuspend restores it — and leaves a business the admin parked on purpose
      // parked. Only set the flag when is_active was actually true beforehand.
      `UPDATE businesses
       SET suspended_at        = NOW(),
           suspended_reason    = $2,
           billing_deactivated = (is_active IS NOT FALSE),
           is_active           = FALSE,
           updated_at          = NOW()
       WHERE id = $1 AND suspended_at IS NULL`,
      [
        id,
        `השהייה אוטומטית — לא נרשם תשלום עבור מחזור החיוב שהחל ב-${dueDateStr} (₪${monthly_fee}), ${grace_period_days || 0} ימי חסד חלפו. יש לאשר תשלום כדי לשחרר.`,
      ]
    ).catch(err => logger.error('[ManualBilling] suspend failed', { businessId: id, err: err.message }));

    logger.warn('[ManualBilling] auto-suspended business for non-payment', {
      businessId: id, name, dueDate: dueDateStr, monthly_fee, last_payment, total_paid,
    });
    suspended++;
  }

  logger.info('[ManualBilling] check complete', { checked: rows.length, suspended });
}

function startManualBillingScheduler() {
  const run = async () => {
    try { await _checkOverdueBusinessesLocked(); } catch (err) {
      logger.error('[ManualBilling] scheduler error', { err: err.message });
    }
    setTimeout(run, _msUntilIsraelHour(TARGET_HOUR));
  };

  const delay = _msUntilIsraelHour(TARGET_HOUR);
  logger.info(`[ManualBilling] scheduler starting, first run in ${Math.round(delay / 60000)} min`);
  setTimeout(run, delay);
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _checkOverdueBusinessesLocked = locked('manual-billing', checkOverdueBusinesses);
module.exports = { startManualBillingScheduler, checkOverdueBusinesses };
