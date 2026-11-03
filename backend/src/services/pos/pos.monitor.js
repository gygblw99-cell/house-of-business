/**
 * POS Monitor
 * בודק מדי כמה דקות אם הקופה מחוברת —
 * אם last_sync_at לא התעדכן הרבה מעבר למחזור הסנכרון הרגיל → שולח התראה לבעל העסק
 */

const db          = require('../../utils/db');
const logger      = require('../../utils/logger');
const posModel    = require('../../models/pos.model');
const { SYNC_INTERVAL_MS } = require('./pos.scheduler');
const { locked } = require('../../utils/jobLock');

// last_sync_at is only ever updated once per scheduled sync (every
// SYNC_INTERVAL_MS), so the disconnect threshold MUST be comfortably larger
// than that cadence — otherwise every connection gets flagged "disconnected"
// between syncs and is permanently excluded from future syncs (setDisconnected
// removes it from the `WHERE is_connected = TRUE` query both schedulers use).
const DISCONNECT_THRESHOLD_MS = SYNC_INTERVAL_MS * 2 + 5 * 60 * 1000; // 2 sync cycles + 5-minute buffer
const CHECK_INTERVAL_MS       = 5 * 60 * 1000; // how often we poll for staleness — independent of the threshold above

async function checkAllConnections() {
  const { rows } = await db.query(
    `SELECT pc.business_id, pc.last_sync_at, pc.is_connected
     FROM pos_connections pc
     WHERE pc.is_connected = TRUE`
  );

  for (const conn of rows) {
    const lastSync = conn.last_sync_at ? new Date(conn.last_sync_at) : null;
    const now      = Date.now();

    if (!lastSync || now - lastSync.getTime() > DISCONNECT_THRESHOLD_MS) {
      await _handleDisconnect(conn.business_id);
    }
  }
}

async function _handleDisconnect(businessId) {
  // סמן כמנותק
  await posModel.setDisconnected(businessId);

  // מוצא את בעל העסק
  const { rows } = await db.query(
    `SELECT u.id FROM users u
     WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
     LIMIT 1`,
    [businessId]
  );
  if (!rows[0]) return;

  // שומר התראה ב-DB (ה-push נשלח מ-notification service)
  await db.query(
    `INSERT INTO notifications (business_id, user_id, type, title, body)
     VALUES ($1, $2, 'pos_disconnected', 'הקופה מנותקת', 'הקופה לא סינכרנה נתונים לאחרונה — בדוק חיבור')`,
    [businessId, rows[0].id]
  );

  logger.warn('[POS Monitor] קופה מנותקת', { businessId });
}

// מפעיל polling — עם הגנה מפני ריצות מקבילות
function startMonitor() {
  let isRunning = false;

  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await _checkAllConnectionsLocked();
    } catch (err) {
      logger.error('[POS Monitor] Error', { err: err.message });
    } finally {
      isRunning = false;
    }
  }, CHECK_INTERVAL_MS).unref();

  logger.info(`[POS Monitor] פעיל — בודק חיבורי קופה כל ${CHECK_INTERVAL_MS / 60000} דקות (סף ניתוק: ${Math.round(DISCONNECT_THRESHOLD_MS / 60000)} דקות)`);
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _checkAllConnectionsLocked = locked('pos-monitor', checkAllConnections);
module.exports = { startMonitor, checkAllConnections };
