/**
 * Delivery Email Scheduler
 * Runs every 8 hours — fetches delivery-platform emails for every business with
 * either a connected Gmail account (preferred, shared with the Z-report import)
 * or a legacy per-business IMAP config. Gmail-first, IMAP-fallback per business,
 * mirroring zreport.scheduler.js's own Gmail-priority logic.
 * Called from index.js startDeliveryEmailScheduler().
 */
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { getConfigWithPassword, fetchDeliveries } = require('./deliveries.emailConfig.service');
const { fetchDeliveriesFromGmail } = require('./gmail.deliveries.service');
const { locked } = require('../utils/jobLock');

let _timer = null;

async function runFetchForAll() {
  try {
    // Tracked as two separate sets (not a single UNION) so a business's IMAP
    // fallback can still run if it's configured, even when its Gmail account
    // is connected but erroring — inferring "not connected" from whatever
    // fetchDeliveriesFromGmail happens to return conflates a real error with
    // no-Gmail-account and permanently skips a working IMAP fallback.
    const [gmailRows, imapRows] = await Promise.all([
      db.query(`SELECT business_id FROM business_google_accounts WHERE is_active = TRUE`),
      db.query(`SELECT business_id FROM business_delivery_email_configs WHERE is_active = TRUE`),
    ]);
    const gmailIds = new Set(gmailRows.rows.map(r => r.business_id));
    const imapIds  = new Set(imapRows.rows.map(r => r.business_id));
    const allIds   = new Set([...gmailIds, ...imapIds]);
    if (!allIds.size) return;

    logger.info(`[DeliveryScheduler] Fetching emails for ${allIds.size} business(es)`);

    for (const business_id of allIds) {
      try {
        let gmailSucceeded = false;
        if (gmailIds.has(business_id)) {
          try {
            const result = await fetchDeliveriesFromGmail(business_id, 3);
            logger.info('[DeliveryScheduler] Gmail done', { business_id, ...result });
            gmailSucceeded = true;
          } catch (err) {
            logger.error('[DeliveryScheduler] Gmail error for business', { business_id, err: err.message });
          }
        }
        if (gmailSucceeded) continue;

        if (imapIds.has(business_id)) {
          const config = await getConfigWithPassword(business_id);
          if (!config) continue;
          const result = await fetchDeliveries(business_id, config, 3); // last 3 days
          logger.info('[DeliveryScheduler] IMAP done', { business_id, ...result });
        }
      } catch (err) {
        logger.error('[DeliveryScheduler] Error for business', { business_id, err: err.message });
      }
    }
  } catch (err) {
    logger.error('[DeliveryScheduler] Fatal error', { err: err.message });
  }
}

function startDeliveryEmailScheduler() {
  if (_timer) return;
  // First run: 2 minutes after startup (let DB bootstrap finish).
  // Locked like the interval — startup is when two replicas are both coming up.
  setTimeout(() => {
    _runFetchForAllLocked();
    // Then every 8 hours
    _timer = setInterval(_runFetchForAllLocked, 8 * 60 * 60 * 1000);
  }, 2 * 60 * 1000);

  logger.info('[DeliveryScheduler] Started — will fetch emails every 8 hours');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runFetchForAllLocked = locked('delivery-email', runFetchForAll);
module.exports = { startDeliveryEmailScheduler };
