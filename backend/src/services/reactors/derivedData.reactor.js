'use strict';

/**
 * Keeps derived figures honest after a fact changes underneath them.
 *
 * Each of these used to be the publisher's job, which meant every publisher
 * needed a list of its downstream consumers. invoices.routes.js cleared three
 * keys on approve and missed six more that are computed from ingredient cost,
 * so the ingredient-cost and profit-leak pages served pre-invoice numbers.
 *
 * All four reactors only invalidate caches: the next read recomputes from the
 * database. No reactor writes stock, money, or anything the user typed, so
 * replaying an event is harmless (see ../index.js, rule 1 and rule 3).
 */

const { on }     = require('./index');
const cache      = require('../../utils/cache');
const logger     = require('../../utils/logger');
const { todayIL } = require('../../utils/dateIL');
const F          = require('./cacheFamilies');

async function bust(businessId, families, why) {
  if (!businessId) return;
  const keys = F.expand(families, businessId, todayIL());
  const results = await Promise.allSettled(keys.map(k => cache.del(k)));
  const failed = results.filter(r => r.status === 'rejected').length;
  logger.info('[Reactor] caches invalidated', {
    why, businessId, keys: keys.length, failed: failed || undefined,
  });
}

function register() {
  // An approved invoice changes what ingredients cost (WAC is recalculated on
  // the items), which moves dish margins, ingredient-cost, profit leaks, the
  // cash-flow projection and the weekly report. The route itself cleared only
  // menu-engineering, menu-elasticity and supplier-trends.
  on('invoice_approved', 'cost:invoice-approved', ({ businessId }) =>
    bust(businessId, [F.COST_DERIVED, F.FINANCE_DERIVED, F.AI_CONTEXT], 'invoice_approved'));

  // Waste changes stock on hand and the real cost of what was sold, which is an
  // input to the same cost-derived set.
  on('waste_recorded', 'cost:waste-recorded', ({ businessId }) =>
    bust(businessId, [F.COST_DERIVED, F.AI_CONTEXT], 'waste_recorded'));

  // A closed shift finalizes hours, which is the labor line in the P&L.
  on('shift_closed', 'labor:shift-closed', ({ businessId }) =>
    bust(businessId, [F.LABOR_DERIVED, F.FINANCE_DERIVED], 'shift_closed'));

  // Z-report data arriving or being deleted changes revenue and therefore the
  // completeness answer zreportCoverage.service.js gives.
  on('finance.updated', 'sales:finance-updated', ({ businessId, data }) => {
    // full_sync already clears everything via fullCacheBust — don't duplicate it.
    if (data?.source === 'full_sync') return Promise.resolve();
    return bust(businessId, [F.SALES_DERIVED, F.FINANCE_DERIVED, F.ZREPORT_DERIVED], 'finance.updated');
  });
}

module.exports = { register, _bust: bust };
