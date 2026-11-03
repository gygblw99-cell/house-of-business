/**
 * Monthly recurring charge — CLI entry point.
 *
 * Charges all active subscriptions whose current_period_end has passed,
 * using the stored PayPlus card token. The actual logic lives in
 * src/services/billing/recurringCharge.service.js, shared with the
 * in-process billing.scheduler.js (which is what actually runs this on
 * Railway — see that file for why). This script remains for manual runs and
 * the PM2 cron_restart entry in ecosystem.config.js on docker-compose/bare-metal
 * deploys.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const db     = require('../src/utils/db');
const logger = require('../src/utils/logger');
const { runRecurringCharges } = require('../src/services/billing/recurringCharge.service');

async function main() {
  const { success, failed, canceled, skipped } = await runRecurringCharges();

  if (skipped) {
    console.log('⏭️  PayPlus not configured — skipped');
  } else {
    console.log(`✅ הסתיים — ${success} חויבו, ${failed} נכשלו, ${canceled} בוטלו`);
  }

  await db.closePool();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  logger.error('[RecurringCharge] Fatal error', { err: err.message });
  console.error(err.message);
  process.exit(1);
});
