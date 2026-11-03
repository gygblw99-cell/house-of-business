/**
 * Standing Orders Scheduler
 * כל יום ב-07:00 — יוצר הזמנות יומיות אוטומטיות לספקים עם הזמנה עומדת
 */

const db                              = require('../../utils/db');
const logger                          = require('../../utils/logger');
const { buildOrderText, buildWhatsAppLink } = require('./order.sender');
const { sendEmail }                   = require('../notifications/email.service');
const { locked } = require('../../utils/jobLock');

async function createStandingOrders() {
  logger.info('[StandingOrders] Running daily standing order creation...');

  try {
    // Israel's calendar date/weekday, not the server's local time (UTC on
    // Railway) — a naive new Date().getDay()/CURRENT_DATE runs 2-3 hours
    // behind Israel around midnight, which could pick the wrong order_days
    // match or the wrong duplicate-check date near the day boundary.
    const ilDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const todayDay  = new Date(`${ilDateStr}T00:00:00Z`).getUTCDay(); // 0=ראשון ... 6=שבת

    // שלוף ספקים עם הזמנה עומדת + הגדרות לוח זמנים + פרטי קשר
    const { rows: suppliers } = await db.query(
      `SELECT s.id, s.business_id, s.name,
              s.preferred_channel,
              s.standing_order -> 'items'      AS items,
              s.standing_order -> 'order_days' AS order_days,
              (s.standing_order ->> 'auto_send')::boolean AS auto_send,
              sc.email AS contact_email,
              sc.phone AS contact_phone,
              b.name   AS business_name,
              b.email  AS business_email,
              u.email  AS owner_email
         FROM suppliers s
         INNER JOIN businesses b ON b.id = s.business_id
         LEFT  JOIN supplier_contacts sc ON sc.supplier_id = s.id AND sc.is_primary = TRUE
         LEFT  JOIN users u ON u.business_id = s.business_id AND u.role = 'owner'
        WHERE s.is_active = TRUE
          AND s.standing_order IS NOT NULL
          AND jsonb_array_length(COALESCE(s.standing_order -> 'items', '[]'::jsonb)) > 0`
    );

    if (!suppliers.length) {
      logger.info('[StandingOrders] No suppliers with standing orders found.');
      return;
    }

    let created = 0;
    let skipped = 0;

    for (const supplier of suppliers) {
      // בדוק ימי הזמנה — ברירת מחדל: כל יום
      const orderDays = Array.isArray(supplier.order_days) ? supplier.order_days : null;
      if (orderDays && !orderDays.includes(todayDay)) {
        skipped++;
        continue;
      }

      // בדוק אם כבר נוצרה הזמנה היום לאותו ספק
      const { rows: existing } = await db.query(
        `SELECT id FROM daily_orders
         WHERE business_id = $1 AND supplier_id = $2
           AND order_date = $3::date`,
        [supplier.business_id, supplier.id, ilDateStr]
      );

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const items = supplier.items || [];
      if (!items.length) continue;

      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // צור הזמנה יומית עם סטטוס pending
        const { rows: [order] } = await client.query(
          `INSERT INTO daily_orders (business_id, supplier_id, order_date, status)
           VALUES ($1, $2, $3::date, 'pending')
           RETURNING id`,
          [supplier.business_id, supplier.id, ilDateStr]
        );

        // הוסף פריטים מהמנה העומדת — batch INSERT
        if (items.length > 0) {
          const itemVals   = [];
          const itemParams = [order.id];
          items.forEach((item, i) => {
            const base = i * 4 + 2;
            itemVals.push(`($1,$${base},$${base+1},$${base+2},$${base+3})`);
            // qty_ordered is NOT NULL (schema.sql) — this insert never
            // supplied it, so it violated the constraint on every run and
            // silently rolled back, meaning standing orders never actually
            // got created. Suggested qty is what auto-generates the order,
            // so it's also what gets ordered until a human edits it.
            itemParams.push(item.name, item.qty || 0, item.qty || 0, item.unit || '');
          });
          await client.query(
            `INSERT INTO daily_order_items (order_id, name, qty_suggested, qty_ordered, unit) VALUES ${itemVals.join(',')}`,
            itemParams
          );
        }

        await client.query('COMMIT');
        created++;

        // ── שליחה / המתנה לאישור ─────────────────────────────
        const channel    = supplier.preferred_channel || 'email';
        const autoSend   = supplier.auto_send === true;
        const sendItems  = items.map(i => ({ ...i, qty_ordered: i.qty }));
        const orderText  = buildOrderText(
          supplier.name, sendItems, null, supplier.business_name || 'העסק'
        );

        if (autoSend) {
          // שלח אוטומטית
          if (channel === 'email' && supplier.contact_email) {
            sendEmail({
              to:      supplier.contact_email,
              subject: `הזמנה מ${supplier.business_name} — ${_todayHebrew()}`,
              html: `<div dir="rtl" style="font-family:Arial,sans-serif;white-space:pre-line">${orderText.replace(/\n/g,'<br>')}</div>`,
              text:    orderText,
            }).then(async () => {
              await db.query(`UPDATE daily_orders SET status='sent', sent_at=NOW() WHERE id=$1`, [order.id]);
            }).catch(e => logger.warn('[StandingOrders] Email failed', { supplier: supplier.name, err: e.message }));

          } else if (channel === 'whatsapp' && supplier.contact_phone) {
            // notifications has no `data` column — this INSERT threw on every
            // call (silently swallowed by the .catch below), so this alert
            // never actually reached the owner despite the order genuinely
            // being ready to send. The dropped waLink isn't needed here: the
            // real click-through flow is the /api/suppliers/orders/pending
            // list, which builds its own link — nothing reads notification
            // payload data. Also resolves an owner/partner user_id, since
            // GET /notifications requires user_id = $1.
            await db.query(
              `INSERT INTO notifications (business_id, user_id, title, body, type)
               SELECT $1, u.id, $2, $3, 'order_ready'
               FROM users u
               WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
               LIMIT 1`,
              [supplier.business_id, `הזמנה מוכנה — ${supplier.name}`, `לחץ לשלוח ב-WhatsApp`]
            ).catch(e => logger.warn('[StandingOrders] Notification insert failed', { orderId: order.id, err: e.message }));
            await db.query(`UPDATE daily_orders SET status='ready', sent_at=NOW() WHERE id=$1`, [order.id])
              .catch(e => logger.warn('[StandingOrders] Status update failed', { orderId: order.id, err: e.message }));
          }
        } else {
          // המתן לאישור בעל העסק — שלח התראה (same data-column/user_id fix as above)
          await db.query(
            `INSERT INTO notifications (business_id, user_id, title, body, type)
             SELECT $1, u.id, $2, $3, 'order_pending'
             FROM users u
             WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
             LIMIT 1`,
            [supplier.business_id,
             `הזמנה ממתינה לאישורך — ${supplier.name}`,
             `בדוק את הכמויות ושלח ל-${supplier.name}`]
          ).catch(e => logger.warn('[StandingOrders] Pending notification failed', { orderId: order.id, err: e.message }));
        }
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('[StandingOrders] Failed for supplier', { supplier: supplier.name, err: err.message });
      } finally {
        client.release();
      }
    }

    logger.info(`[StandingOrders] Done — created: ${created}, skipped (already exists): ${skipped}`);
  } catch (err) {
    logger.error('[StandingOrders] Fatal error', { err: err.message });
  }
}

const TARGET_HOUR = 7;

// Returns ms until the next 07:00 **Asia/Jerusalem** (DST-aware). The previous
// version used new Date().setHours(7,0,0,0) + a fixed 24h setInterval, which
// runs in the server's local time (UTC on Railway — no TZ env var set) and
// drifts across DST transitions — so the "daily 07:00" run was actually
// firing around 09:00/10:00 Israel time. Same fix pattern as
// weeklyReport.scheduler.js / audit.scheduler.js / priceAlert.scheduler.js.
function _msUntilIsraelHour(targetHour) {
  const nowMs = Date.now();

  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(nowMs));
  const get    = (t) => ilParts.find(p => p.type === t)?.value;
  const ilHour = parseInt(get('hour')   ?? '0', 10);
  const ilMin  = parseInt(get('minute') ?? '0', 10);

  const daysToAdd = ilHour >= targetHour ? 1 : 0;

  const ilDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(nowMs));
  const [iy, im, id] = ilDateStr.split('-').map(Number);
  const targetMidnightUtc = Date.UTC(iy, im - 1, id + daysToAdd);

  const ilHourAt = (ms) => parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false })
      .formatToParts(new Date(ms)).find(p => p.type === 'hour')?.value ?? '0', 10
  );
  for (const offsetH of [2, 3]) {
    const candidate = targetMidnightUtc + (targetHour - offsetH) * 3600_000;
    if (ilHourAt(candidate) === targetHour) return candidate - nowMs;
  }
  return targetMidnightUtc + (targetHour - 2) * 3600_000 - nowMs; // UTC+2 fallback
}

function _scheduleNext() {
  const delay   = _msUntilIsraelHour(TARGET_HOUR);
  const nextRun = new Date(Date.now() + delay);
  logger.info(`[StandingOrders] Scheduler — next run: ${nextRun.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  setTimeout(() => {
    _createStandingOrdersLocked()
      .catch(err => logger.error('[StandingOrders] Unhandled error', { err: err.message }))
      .finally(_scheduleNext);
  }, delay).unref();
}

function startStandingOrderScheduler() {
  _scheduleNext();
  logger.info('[StandingOrders] Scheduler started — runs daily at 07:00 שעון ישראל');
}

function _todayHebrew() {
  return new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _createStandingOrdersLocked = locked('standing-orders', createStandingOrders);
module.exports = { startStandingOrderScheduler, createStandingOrders };
