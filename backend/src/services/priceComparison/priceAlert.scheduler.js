/**
 * Price Alert Scheduler
 * כל יום ב-09:00 — בודק את כל התראות המחיר הפעילות, מריץ עבור כל אחת
 * חיפוש מחיר מחדש (SerpAPI + Claude, אותו מנוע כמו חיפוש ידני), ומשווה
 * את המחיר הזול שנמצא ליעד שהוגדר. אם נמצא מחיר מתחת ליעד — שולח מייל
 * ומסמן last_triggered_at (לא שולח שוב עד שעברו 3 ימים, כדי לא להציף).
 */

const db          = require('../../utils/db');
const logger      = require('../../utils/logger');
const eventBus    = require('../../utils/eventBus');
const { sendEmailFromBusiness } = require('../notifications/email.service');
const { searchPrice, extractNumericPrice } = require('./priceSearch.service');
const { locked } = require('../../utils/jobLock');

const RETRIGGER_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 ימים
const DELAY_BETWEEN_CHECKS_MS = 3000; // מרווח בין בדיקות — כל בדיקה = 3 קריאות SerpAPI (או 0 אם השאילתה ב-cache) + קריאת AI

const TARGET_HOUR = 9;

function startPriceAlertScheduler() {
  _scheduleNext();
  logger.info('[PriceAlert Scheduler] פעיל — בדיקת התראות מחיר כל יום ב-09:00 שעון ישראל');
}

// Returns ms until the next 09:00 **Asia/Jerusalem** (DST-aware). The previous
// version used new Date().setHours(9,0,0,0) + a fixed 24h setInterval, which
// runs in the server's local time (UTC on Railway — no TZ env var set) and
// drifts across DST transitions — so the "daily 09:00" check was actually
// firing around 11:00/12:00 Israel time. Same fix pattern as
// weeklyReport.scheduler.js / audit.scheduler.js.
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
  logger.info(`[PriceAlert Scheduler] ריצה הבאה: ${nextRun.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  setTimeout(() => {
    _checkPriceAlertsLocked()
      .catch(err => logger.error('[PriceAlert Scheduler] Scheduled run failed', { err: err.message }))
      .finally(_scheduleNext);
  }, delay);
}

async function checkPriceAlerts() {
  logger.info('[PriceAlert Scheduler] בודק התראות מחיר פעילות...');

  const { rows: alerts } = await db.query(
    `SELECT id, business_id, search_query, target_price, unit, notify_email, last_triggered_at
       FROM price_comparison_alerts
      WHERE is_active = TRUE`
  );

  if (alerts.length === 0) {
    logger.info('[PriceAlert Scheduler] אין התראות פעילות');
    return;
  }

  let checked = 0, triggered = 0, failed = 0;

  for (const alert of alerts) {
    try {
      await _checkOneAlert(alert);
      checked++;
      if (alert._triggered) triggered++;
    } catch (err) {
      failed++;
      logger.warn('[PriceAlert Scheduler] בדיקת התראה נכשלה', { alertId: alert.id, query: alert.search_query, err: err.message });
    }
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_CHECKS_MS));
  }

  logger.info(`[PriceAlert Scheduler] הושלם — ${checked} נבדקו, ${triggered} הופעלו, ${failed} נכשלו`);
}

async function _checkOneAlert(alert) {
  const { rows: bizRows } = await db.query(
    `SELECT address FROM businesses WHERE id = $1`,
    [alert.business_id]
  );
  const businessAddress = bizRows[0]?.address || '';
  const result = await searchPrice(alert.search_query, { businessAddress, businessId: alert.business_id });
  const foundPrice = extractNumericPrice(result?.cheapestPrice?.price);
  const targetPrice = parseFloat(alert.target_price);

  await db.query(
    `UPDATE price_comparison_alerts SET last_checked_at = NOW() WHERE id = $1`,
    [alert.id]
  );

  if (foundPrice === null || Number.isNaN(targetPrice)) return;
  if (foundPrice > targetPrice) return;

  // מניעת הצפה — לא מתריעים שוב אם כבר הופעל לאחרונה
  if (alert.last_triggered_at && (Date.now() - new Date(alert.last_triggered_at).getTime()) < RETRIGGER_COOLDOWN_MS) {
    return;
  }

  await db.query(
    `UPDATE price_comparison_alerts SET last_triggered_at = NOW() WHERE id = $1`,
    [alert.id]
  );
  alert._triggered = true;

  eventBus.publish(alert.business_id, 'price_comparison.updated', { action: 'alert_triggered', alertId: alert.id });

  const toEmail = alert.notify_email || await _resolveOwnerEmail(alert.business_id);
  if (!toEmail) return;

  const cheapest = result.cheapestPrice;
  await sendEmailFromBusiness(alert.business_id, {
    to: toEmail,
    subject: `🔔 נמצא מחיר טוב — ${alert.search_query}`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#059669">💰 התראת המחיר שלך הופעלה</h2>
      <p><strong>מוצר:</strong> ${_escapeHtml(alert.search_query)}</p>
      <p><strong>מחיר יעד:</strong> ₪${targetPrice} / ${_escapeHtml(alert.unit || '')}</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin-top:12px">
        <p style="font-weight:bold;margin:0 0 8px 0">נמצא מחיר: ${_escapeHtml(cheapest.price || '')}</p>
        ${cheapest.source ? `<p style="margin:4px 0">ספק: ${_escapeHtml(cheapest.source)}</p>` : ''}
        ${cheapest.note ? `<p style="margin:4px 0;color:#374151">${_escapeHtml(cheapest.note)}</p>` : ''}
      </div>
      <p style="margin-top:16px"><a href="${process.env.PLATFORM_URL || 'https://app.houseofbusiness.co.il'}/price-comparison" style="background:#059669;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">פתח את המערכת</a></p>
      <p style="color:#6b7280;font-size:12px;margin-top:20px">House of Business — מערכת ניהול עסקים</p>
    </div>`,
  }).catch(err => logger.warn('[PriceAlert Scheduler] שליחת מייל נכשלה', { alertId: alert.id, err: err.message }));
}

async function _resolveOwnerEmail(businessId) {
  const { rows } = await db.query(
    `SELECT COALESCE(ec.email, owner_u.email) AS owner_email
       FROM businesses b
       LEFT JOIN business_email_configs ec ON ec.business_id = b.id
       LEFT JOIN users owner_u ON owner_u.business_id = b.id AND owner_u.role = 'owner'
      WHERE b.id = $1
      LIMIT 1`,
    [businessId]
  );
  return rows[0]?.owner_email || null;
}

function _escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _checkPriceAlertsLocked = locked('price-alerts', checkPriceAlerts);
module.exports = { startPriceAlertScheduler, checkPriceAlerts };
