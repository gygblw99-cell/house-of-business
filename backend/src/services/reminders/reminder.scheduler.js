/**
 * Reminder Scheduler
 * בודק כל 5 דקות תזכורות שהגיע זמנן ושולח התראה
 * Batched: single INSERT for all notifications (was N individual INSERTs)
 */

const db       = require('../../utils/db');
const logger   = require('../../utils/logger');
const eventBus = require('../../utils/eventBus');
const { withTransaction } = require('../../utils/transaction');
const { locked } = require('../../utils/jobLock');

async function checkReminders() {
  try {
    // Mark-sent and the notification INSERT run in one transaction — doing
    // them as two separate queries meant a failure between them left
    // reminders permanently marked sent with no notification ever created
    // and no retry path.
    const rows = await withTransaction(async (client) => {
      const { rows: due } = await client.query(
        `UPDATE reminders
            SET is_sent = TRUE
          WHERE remind_at <= NOW() AND is_sent = FALSE
          RETURNING id, user_id, business_id, title, remind_at`
      );
      if (due.length === 0) return due;

      const vals   = [];
      const params = [];
      due.forEach((reminder, i) => {
        const base = i * 4;
        vals.push(`($${base+1},$${base+2},'reminder',$${base+3},$${base+4})`);
        params.push(
          reminder.business_id,
          reminder.user_id,
          `תזכורת: ${reminder.title}`,
          reminder.title
        );
      });
      await client.query(
        `INSERT INTO notifications (business_id, user_id, type, title, body) VALUES ${vals.join(',')}`,
        params
      );
      return due;
    });

    if (rows.length === 0) return;

    // SSE broadcast per reminder (lightweight — just event emission, no DB)
    for (const reminder of rows) {
      eventBus.publish(reminder.business_id, 'notification', {
        type:   'reminder',
        title:  `תזכורת: ${reminder.title}`,
        userId: reminder.user_id,
      });
    }

    logger.info(`[Reminder Scheduler] triggered ${rows.length} reminder(s)`);
  } catch (err) {
    logger.error('[Reminder Scheduler] error', { err: err.message });
  }
}

function startReminderScheduler() {
  // בדיקה ראשונה אחרי 30 שניות מהעלייה
  setTimeout(_checkRemindersLocked, 30_000);
  // בדיקה כל 5 דקות — תזכורות אינן דורשות דיוק לדקה
  setInterval(_checkRemindersLocked, 5 * 60_000).unref();
  logger.info('[Reminder Scheduler] started — checking every 5 minutes');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _checkRemindersLocked = locked('reminders', checkReminders);
module.exports = { startReminderScheduler, checkReminders };
