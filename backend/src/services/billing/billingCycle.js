/**
 * Billing-cycle date maths, shared by the auto-suspend scheduler and the admin
 * payments dashboard so the two can never disagree about who is overdue.
 *
 * Deliberately has no notion of money. Whether a business is overdue is decided
 * by ONE question — "was a payment recorded for the current cycle?" — and never
 * by comparing a lifetime balance against months_due * monthly_fee. monthly_fee
 * is a single mutable column with no history (PUT /api/admin/businesses/:id/
 * billing overwrites it), so that sum silently re-prices every month a customer
 * already paid at the old rate: raising a ₪500 customer to ₪700 after a year
 * invented ₪2,600 of debt and suspended an account that was fully paid up.
 */

const MS_PER_DAY = 86400000;

/** Day-of-month clamped to the length of that month (Feb, 30-day months). */
function _clampDay(year, month1, day) {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return Math.min(day, daysInMonth);
}

/** UTC midnight timestamp for billing_day in the given 1-based month. */
function dueTsFor(year, month1, billingDay) {
  return Date.UTC(year, month1 - 1, _clampDay(year, month1, billingDay));
}

/**
 * The cycle that is currently open, given "today" as Israel calendar parts.
 *
 * Returns { dueTs, prevDueTs, deadlineTs } where:
 *   dueTs      — billing_day of this month once it has arrived, else last month's
 *   prevDueTs  — one month earlier; the moment the current cycle opened
 *   deadlineTs — dueTs + grace, as a timestamp so grace may spill into the next
 *                month (billing_day 25 + 10 days grace → Nov 4, not "day 35")
 */
function currentCycle({ billingDay, gracePeriodDays, todayY, todayM, todayD }) {
  const billingDayPassed = todayD >= _clampDay(todayY, todayM, billingDay);
  const dueY = billingDayPassed ? todayY : (todayM === 1 ? todayY - 1 : todayY);
  const dueM = billingDayPassed ? todayM : (todayM === 1 ? 12 : todayM - 1);

  const prevDueY = dueM === 1 ? dueY - 1 : dueY;
  const prevDueM = dueM === 1 ? 12 : dueM - 1;

  const dueTs = dueTsFor(dueY, dueM, billingDay);
  return {
    dueTs,
    prevDueTs:  dueTsFor(prevDueY, prevDueM, billingDay),
    deadlineTs: dueTs + (gracePeriodDays || 0) * MS_PER_DAY,
  };
}

/** UTC-midnight timestamp of the first cycle ever due under this agreement. */
function firstDueTs(billingDay, billingStartDate) {
  const [sy, sm, sd] = billingStartDate.split('-').map(Number);
  // Started after billing_day had already passed that month → first charge is
  // the following month.
  let y = sy, m = sm;
  if (sd > billingDay) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return dueTsFor(y, m, billingDay);
}

/**
 * Is the current cycle unpaid past its grace window?
 *
 * `lastPayment` is the most recent payment_date as 'YYYY-MM-DD' (or null). Any
 * payment recorded after the previous due date settles the current cycle — that
 * window covers paying a few days early as well as late.
 */
function isCycleOverdue({ billingDay, gracePeriodDays, billingStartDate, lastPayment, todayTs, todayY, todayM, todayD }) {
  if (firstDueTs(billingDay, billingStartDate) > todayTs) return false; // not started yet

  const { prevDueTs, deadlineTs } = currentCycle({ billingDay, gracePeriodDays, todayY, todayM, todayD });
  if (todayTs <= deadlineTs) return false; // still inside grace

  const lastPaymentTs = lastPayment ? Date.parse(lastPayment + 'T00:00:00Z') : null;
  return !(lastPaymentTs != null && lastPaymentTs > prevDueTs);
}

/** Israel calendar parts for a given instant (defaults to now). */
function israelToday(now = new Date()) {
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).split('-').map(Number);
  return { todayY: y, todayM: m, todayD: d, todayTs: Date.UTC(y, m - 1, d) };
}

module.exports = { currentCycle, firstDueTs, isCycleOverdue, israelToday, dueTsFor, MS_PER_DAY };
