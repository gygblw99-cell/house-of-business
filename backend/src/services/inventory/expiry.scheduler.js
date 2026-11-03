/**
 * Inventory Expiry Scheduler
 * בודק כל יום ב-08:00 פריטים עם תאריך תפוגה תוך 3 ימים
 * ושולח התראות לבעל העסק
 *
 * Batched: single query for all businesses (was N+1 per business)
 */

const db     = require('../../utils/db');
const logger = require('../../utils/logger');
const { locked } = require('../../utils/jobLock');

function startExpiryScheduler() {
  _scheduleDaily8am();
  logger.info('[Expiry Scheduler] פעיל — בדיקת תפוגות כל יום ב-08:00');
}

function _scheduleDaily8am() {
  const now  = new Date();
  const next = new Date();
  next.setHours(8, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);

  const ms = next.getTime() - now.getTime();
  setTimeout(() => {
    _runExpiryCheckLocked().catch(err => logger.error('[Expiry Scheduler] First run failed', { err: err.message }));
    setInterval(
      () => _runExpiryCheckLocked().catch(err => logger.error('[Expiry Scheduler] Scheduled run failed', { err: err.message })),
      24 * 60 * 60 * 1000
    ).unref();
  }, ms);

  logger.info(`[Expiry Scheduler] ריצה ראשונה בעוד ${Math.round(ms / 60000)} דקות`);
}

async function _runExpiryCheck() {
  logger.info('[Expiry Scheduler] בודק תפוגות מלאי לכל העסקים...');

  try {
    // Batch 1: all expiring items across all businesses in one query
    const { rows: expiringItems } = await db.query(`
      SELECT
        ii.id, ii.business_id, ii.name, ii.unit, ii.current_qty,
        ii.expiry_date,
        (ii.expiry_date - CURRENT_DATE)::int AS days_until_expiry
      FROM inventory_items ii
      WHERE ii.expiry_date IS NOT NULL
        AND ii.expiry_date <= CURRENT_DATE + 3
        AND ii.current_qty > 0
      ORDER BY ii.business_id, ii.expiry_date ASC
    `);

    if (expiringItems.length === 0) return;

    const bizIds = [...new Set(expiringItems.map(i => i.business_id))];

    // Batch 2: one owner per business
    const { rows: owners } = await db.query(`
      SELECT DISTINCT ON (business_id) business_id, id AS user_id
      FROM users
      WHERE business_id = ANY($1) AND role IN ('owner','partner') AND is_active = TRUE
    `, [bizIds]);
    const ownerMap = Object.fromEntries(owners.map(o => [o.business_id, o.user_id]));

    // Batch 3: existing notifications to skip duplicates
    const itemNames = expiringItems.map(i => i.name);
    const { rows: existing } = await db.query(`
      SELECT business_id, body
      FROM notifications
      WHERE type = 'expiry_alert'
        AND is_read = FALSE
        AND business_id = ANY($1)
        AND created_at > NOW() - INTERVAL '20 hours'
    `, [bizIds]);

    // Build a Set of "businessId:name" that already have a notification
    const alreadySent = new Set(
      existing
        .flatMap(n => itemNames.filter(name => n.body.includes(name)).map(name => `${n.business_id}:${name}`))
    );

    // Build batch INSERT for notifications
    const toInsert = expiringItems.filter(item => !alreadySent.has(`${item.business_id}:${item.name}`));

    if (toInsert.length === 0) {
      logger.info('[Expiry Scheduler] אין התראות חדשות לשלוח');
      return;
    }

    const vals   = [];
    const params = [];
    toInsert.forEach((item, i) => {
      const base      = i * 5;
      const daysLeft  = item.days_until_expiry;
      const isExpired = daysLeft < 0;
      const title     = isExpired ? `פג תוקף: ${item.name}` : `תפוגה קרובה: ${item.name}`;
      const body      = isExpired
        ? `${item.name} — פג תוקפו לפני ${Math.abs(daysLeft)} ימים. נותרו ${parseFloat(item.current_qty)} ${item.unit || ''}. יש להסיר מהמלאי.`
        : `${item.name} — פג תוקפו בעוד ${daysLeft} ${daysLeft === 1 ? 'יום' : 'ימים'}. נותרו ${parseFloat(item.current_qty)} ${item.unit || ''}.`;

      vals.push(`($${base+1},$${base+2},'expiry_alert',$${base+3},$${base+4},NOW() + INTERVAL '3 days')`);
      params.push(item.business_id, ownerMap[item.business_id] || null, title, body);
    });

    await db.query(
      `INSERT INTO notifications (business_id, user_id, type, title, body, expires_at) VALUES ${vals.join(',')}`,
      params
    );

    logger.info(`[Expiry Scheduler] נשלחו ${toInsert.length} התראות תפוגה`);
  } catch (err) {
    logger.error('[Expiry Scheduler] שגיאה', { err: err.message });
  }
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runExpiryCheckLocked = locked('expiry-check', _runExpiryCheck);
module.exports = { startExpiryScheduler };
