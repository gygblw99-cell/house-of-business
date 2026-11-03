'use strict';

/**
 * fixed_expenses carries start_date / end_date, and until this branch neither
 * was writable, so nothing checked them and the columns were dead. Now that the
 * UI can set them, every reader has to agree on what they mean or the same
 * expense is counted on one screen and not on another — which is exactly what
 * happened: giving a cancelled contract an end date removed it from the VAT
 * estimate while it kept inflating the monthly P&L, the daily view, the
 * forecast and the breakeven day.
 *
 * The rule, everywhere: an expense costs money during a period when it started
 * before that period ended, and had not already ended when it began.
 *
 * These are plain SQL fragments with no bind parameters, so they can be pasted
 * into any query regardless of how its own placeholders are numbered — the
 * reason this is a shared string and not a helper that renumbers $n.
 */

// "In force today" — for the running-cost figures (survival runway, AI context,
// audit totals, advisor category breakdown, exports of current expenses).
const EXPENSE_ACTIVE_TODAY = `
  AND (start_date IS NULL OR start_date <= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date)
  AND (end_date   IS NULL OR end_date   >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date)`;

// Same, for queries that alias the table (e.g. `FROM fixed_expenses fe`).
const EXPENSE_ACTIVE_TODAY_AS = (alias) => `
  AND (${alias}.start_date IS NULL OR ${alias}.start_date <= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date)
  AND (${alias}.end_date   IS NULL OR ${alias}.end_date   >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date)`;

// "In force at any point between two bind params" — for reports covering a
// past range rather than today. Caller supplies the placeholder numbers.
const expenseActiveBetween = (fromParam, toParam) => `
  AND (start_date IS NULL OR start_date <= ${toParam}::date)
  AND (end_date   IS NULL OR end_date   >= ${fromParam}::date)`;

module.exports = { EXPENSE_ACTIVE_TODAY, EXPENSE_ACTIVE_TODAY_AS, expenseActiveBetween };
