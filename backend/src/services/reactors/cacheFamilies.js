'use strict';

/**
 * Cache keys grouped by what they are DERIVED FROM, rather than by the feature
 * that happens to own them.
 *
 * The problem this replaces: each publisher hand-maintained its own list of
 * downstream keys to clear. invoices.routes.js cleared menu-engineering,
 * menu-elasticity and supplier-trends on approve — and missed ingredient-cost,
 * ingredient-leakage, profit-leaks, finance-cashflow, forecast and
 * weekly-report, every one of which is computed from ingredient cost. So after
 * approving an invoice the ingredient-cost and profit-leak pages kept serving
 * pre-invoice numbers until something else happened to clear them.
 *
 * That is not a list anyone can keep correct by hand, because it has to be
 * updated in the publisher every time a new derived feature is added somewhere
 * else. Grouping by provenance means a new consumer registers its key next to
 * the others it belongs with, and every publisher gets it for free.
 */

/** Anything computed from what an ingredient costs. */
const COST_DERIVED = [
  'ingredient-cost:{b}:*',
  'ingredient-leakage:{b}:*',
  'menu-engineering:{b}:*',
  'menu-elasticity:{b}',
  'profit-leaks:{b}',
  'supplier-trends:{b}',
  'survival-mode:{b}',
];

/** Anything computed from revenue or sales volume. */
const SALES_DERIVED = [
  'dashboard:{b}',
  'dashboard-chart:{b}:*',
  'dashboard-orders:{b}:*',
  'daily-summary:{b}:{today}',
  'fraud-alerts:{b}:*',
  'forecast:{b}:*',
];

/** Anything computed from hours worked or payroll. */
const LABOR_DERIVED = [
  'dashboard:{b}',
  'profit-leaks:{b}',
  'survival-mode:{b}',
];

/** Anything that rolls money up into a statement. */
const FINANCE_DERIVED = [
  'finance-cashflow:{b}:*',
  'finance-forecast:{b}',
  'finance-forecast90:{b}',
  'weekly-report:{b}:*',
  'audit:latest:{b}',
];

/** What the AI advisor reads as its view of the business. */
const AI_CONTEXT = [
  'ai-context:{b}',
  'ai-context:v2:{b}',
  'insights:{b}:*',
  'ai_advisor_resp:{b}:*',
  'ai_advisor_generic:{b}:*',
];

/** Z-report completeness (see zreportCoverage.service.js). */
const ZREPORT_DERIVED = [
  'zreport:missing:{b}',
];

/** Expands {b} and {today} and de-duplicates across families. */
function expand(families, businessId, todayStr) {
  const out = new Set();
  for (const fam of families) {
    for (const tpl of fam) {
      out.add(tpl.replace('{b}', businessId).replace('{today}', todayStr));
    }
  }
  return [...out];
}

module.exports = {
  COST_DERIVED, SALES_DERIVED, LABOR_DERIVED, FINANCE_DERIVED, AI_CONTEXT, ZREPORT_DERIVED,
  expand,
};
