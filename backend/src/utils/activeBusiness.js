'use strict';

/**
 * One definition of "a business that background work should run for".
 *
 * There were two independent off-switches and they disagreed. Suspending a
 * business from the admin screen sets suspended_at, which blocks its users from
 * logging in — but every scheduler filters on is_active, so a suspended
 * business kept being scanned, kept calling the AI, and kept costing money for
 * an account nobody could even sign into.
 *
 * The filters were also inconsistent among themselves: some checked
 * `is_active = TRUE`, others `is_active = TRUE OR is_active IS NULL`, and the
 * payslip job had no filter at all. So whether a business was skipped depended
 * on which scheduler happened to be asking.
 *
 * A business is dormant when an admin turned it off (is_active = FALSE) or
 * suspended it. NULL counts as active — older rows predate the column and have
 * never been switched off by anyone.
 *
 * Exported as SQL text rather than a function that runs the query: these run
 * inside larger statements with their own bind parameters, and this has to drop
 * in without renumbering them.
 */

// For `FROM businesses` with no alias.
const ACTIVE_BUSINESS_SQL = `(is_active IS NOT FALSE AND suspended_at IS NULL)`;

// For a query that aliases the table, e.g. `FROM businesses b`.
const activeBusinessSql = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `(${p}is_active IS NOT FALSE AND ${p}suspended_at IS NULL)`;
};

/** Ids of every business background work should run for. */
async function listActiveBusinessIds(db) {
  const { rows } = await db.query(
    `SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL} ORDER BY id`
  );
  return rows.map(r => r.id);
}

/** Whether one business is currently eligible — for per-business entry points. */
async function isBusinessActive(db, businessId) {
  const { rows } = await db.query(
    `SELECT ${ACTIVE_BUSINESS_SQL} AS ok FROM businesses WHERE id = $1`,
    [businessId]
  );
  // A business that no longer exists is not eligible.
  return rows[0]?.ok === true;
}

module.exports = { ACTIVE_BUSINESS_SQL, activeBusinessSql, listActiveBusinessIds, isBusinessActive };
