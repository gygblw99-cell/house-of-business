/**
 * POS Auto-Sync Scheduler
 *
 * רץ כל 15 דקות ומסנכרן את כל הקופות המחוברות.
 * לאחר כל סנכרון נמחק cache של דשבורד + דליפות רווח —
 * כך שהלשונית "דליפות רווח" תמיד מציגה נתונים עדכניים מהקופה.
 *
 * Flow:
 *  קופה מחוברת → sales נשמרים → cache נמחק
 *  → הבא שיפתח "דליפות רווח" יקבל חישוב טרי עם המכירות החדשות
 */

const db      = require('../../utils/db');
const logger  = require('../../utils/logger');
const posSync = require('./pos.sync');
const { locked } = require('../../utils/jobLock');

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 דקות

async function syncAllConnectedBusinesses() {
  let synced = 0;
  let failed = 0;

  try {
    const { rows } = await db.query(
      `SELECT business_id FROM pos_connections WHERE is_connected = TRUE`
    );

    for (const { business_id } of rows) {
      try {
        await posSync.syncIncremental(business_id);
        synced++;
      } catch (err) {
        failed++;
        logger.error('[POS Scheduler] Sync failed', { business_id, err: err.message });
      }
    }

    if (rows.length > 0) {
      logger.info(`[POS Scheduler] Sync done — ${synced} ok, ${failed} failed (${rows.length} total)`);
    }
  } catch (err) {
    logger.error('[POS Scheduler] Failed to query connected businesses', { err: err.message });
  }
}

function startPosScheduler() {
  // הרצה ראשונה מיידית (30 שניות אחרי עלייה)
  setTimeout(() => {
    _syncAllConnectedBusinessesLocked().catch(err => logger.error('[POS Scheduler] sync error', { err: err.message }));
  }, 30_000);

  // ואז כל 15 דקות
  setInterval(() => {
    _syncAllConnectedBusinessesLocked().catch(err => logger.error('[POS Scheduler] sync error', { err: err.message }));
  }, SYNC_INTERVAL_MS).unref();

  logger.info('[POS Scheduler] פעיל — מסנכרן קופות כל 15 דקות');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _syncAllConnectedBusinessesLocked = locked('pos-sync', syncAllConnectedBusinesses);
module.exports = { startPosScheduler, syncAllConnectedBusinesses, SYNC_INTERVAL_MS };
