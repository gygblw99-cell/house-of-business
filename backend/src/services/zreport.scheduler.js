/**
 * Z-Report Scheduler
 * כל לילה ב-02:00 (שעון ישראל) בודק אם יש ימים שדוח Z חסר.
 * תחילה מנסה שליפה אוטומטית מ-IMAP; אם נשאר חסר — יוצר התראה ידנית.
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');
const { fetchZReportsForBusiness, getMissingDays, isImapConfigured, isGlobalFallbackSafe } = require('./zreport.imap.service');
const { getEmailConfigWithPassword, fetchWithConfig, updateLastFetched } = require('./zreport.emailConfig.service');
const { fullCacheBust } = require('./sync.service');
const { fetchZReportsFromGmail } = require('./gmail.fetch.service');
const { ACTIVE_BUSINESS_SQL } = require('../utils/activeBusiness');
const { locked } = require('../utils/jobLock');

// Use the same full cache bust as the manual import route (20+ keys).
// The old 6-key version left fraud-alerts, audit, daily-summary, forecast,
// ingredient-leakage, and survival-mode stale after a nightly IMAP import.
async function _bustAfterImport(businessId) {
  await fullCacheBust(businessId).catch(() => {});
}

// שתי ריצות יומיות — DST-aware: computed from Israel local time, not fixed UTC offsets.
// UTC+2 (חורף) / UTC+3 (קיץ) means a fixed UTC hour drifts by 1h on DST boundaries.
const DAILY_RUNS_IL = [
  { hour: 2,  min: 0, label: '02:00 IL (לילה)' },
  { hour: 10, min: 0, label: '10:00 IL (בוקר)' },
];

const _IL_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
});
const _IL_HM_FMT = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Jerusalem', hour12: false, hour: '2-digit', minute: '2-digit',
});

// Returns ms until the next occurrence of hour:min in Asia/Jerusalem.
// Tries today then tomorrow; for each day tries both UTC+3 (summer) and UTC+2 (winter),
// verifies the candidate actually maps to the target IL local time (handles DST boundary).
function _msUntilRunIL(ilHour, ilMin) {
  const now = Date.now();
  for (let dayOff = 0; dayOff <= 1; dayOff++) {
    const ilDate = _IL_FMT.format(new Date(now + dayOff * 86_400_000));
    for (const tzOff of ['+03:00', '+02:00']) {
      const c = new Date(`${ilDate}T${String(ilHour).padStart(2,'0')}:${String(ilMin).padStart(2,'0')}:00${tzOff}`);
      if (isNaN(c.getTime())) continue;
      const actual = _IL_HM_FMT.format(c).replace(/ /g, ' ');
      const [h, m] = actual.split(':').map(Number);
      if (h === ilHour && m === ilMin && c.getTime() > now) return c.getTime() - now;
    }
  }
  return 24 * 60 * 60 * 1000;
}

// Returns the UTC ms of a given IL hour:min for today, or null if it can't be determined.
function _ilSlotToday(ilHour, ilMin) {
  const todayIL = _IL_FMT.format(new Date());
  for (const tzOff of ['+03:00', '+02:00']) {
    const c = new Date(`${todayIL}T${String(ilHour).padStart(2,'0')}:${String(ilMin).padStart(2,'0')}:00${tzOff}`);
    if (isNaN(c.getTime())) continue;
    const actual = _IL_HM_FMT.format(c).replace(/ /g, ' ');
    const [h, m] = actual.split(':').map(Number);
    if (h === ilHour && m === ilMin) return c.getTime();
  }
  return null;
}

async function _runForAllBusinesses() {
  logger.info('[ZReport Scheduler] starting nightly Z-report check');
  try {
    const { rows: businesses } = await db.query(
      `SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL}`
    );

    const globalFallbackSafe = await isGlobalFallbackSafe();
    if (!globalFallbackSafe) {
      logger.warn('[ZReport Scheduler] more than one business shares no per-business email config — disabling global IMAP fallback to avoid cross-tenant import');
    }

    for (const biz of businesses) {
      await _checkBusiness(biz.id, globalFallbackSafe);
    }
  } catch (err) {
    logger.error('[ZReport Scheduler] outer error', { err: err.message });
  }
}

async function _checkBusiness(businessId, globalFallbackSafe) {
  try {
    // חשב חלון חיפוש דינמי — מכסה ימים חסרים עד 90 יום אחורה
    const DEFAULT_LOOKBACK = 7;
    const MAX_LOOKBACK = 90;
    let daysBack = DEFAULT_LOOKBACK;
    try {
      const missing = await getMissingDays(businessId, MAX_LOOKBACK);
      if (missing.length > 0) {
        const israelToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
        const todayMs  = new Date(israelToday).getTime();
        const oldestMs = new Date(missing[0]).getTime();
        const gapDays  = Math.ceil((todayMs - oldestMs) / 86_400_000);
        daysBack = Math.max(DEFAULT_LOOKBACK, Math.min(gapDays + 1, MAX_LOOKBACK));
        if (daysBack > DEFAULT_LOOKBACK) {
          logger.info(`[ZReport Scheduler] business=${businessId} gap detected (${missing[0]}) — extending lookback to ${daysBack} days`);
        }
      }
    } catch { /* ignore — use default */ }

    // ── 1. Gmail OAuth (עדיפות ראשונה — ה-UX הכי טוב) ───────────────────────
    const gmailResult = await fetchZReportsFromGmail(businessId, daysBack).catch(() => null);
    if (gmailResult !== null) {
      // Gmail OAuth account exists — use it, skip IMAP
      if (gmailResult.imported > 0) {
        logger.info(`[ZReport Scheduler] business=${businessId} Gmail imported=${gmailResult.imported}`);
        await _bustAfterImport(businessId);
      }
      // Only stamp last_fetched_at when the fetch actually succeeded —
      // a failed fetch must not overwrite the timestamp from the last good run.
      if (!gmailResult._fetchFailed) {
        await updateLastFetched(businessId, { ...gmailResult, source: 'gmail' });
      }

      // A revoked/expired Google authorisation used to fail in total silence:
      // this branch logged nothing, raised no notification, and still stamped
      // last_fetched_at — so the screen kept showing a fresh "scanned just now"
      // while nothing had been scanned for days. The only way anyone found out
      // was noticing a missing Z-report, which took three separate outages.
      //
      // invalid_grant means the refresh token is dead (revoked, password
      // changed, or — the common one — the Google Cloud OAuth consent screen is
      // still in "Testing", where Google expires refresh tokens after 7 days).
      // Nothing here can fix that; only the owner re-authorising can, so tell
      // them. Deduplicated to one notification per 3 days so a nightly failure
      // doesn't bury the rest of their notifications.
      const gErr = (gmailResult.errors || []).join(' ');
      if (gmailResult._fetchFailed && /invalid_grant|invalid_client|unauthorized|401|tokens_unreadable/i.test(gErr)) {
        const tokensBroken = /tokens_unreadable/i.test(gErr);
        logger.error(`[ZReport Scheduler] business=${businessId} Gmail auth problem — owner must reconnect`, { err: gErr, tokensBroken });
        await db.query(
          `INSERT INTO notifications (business_id, user_id, type, title, body)
           SELECT $1, u.id, 'gmail_auth_expired', $2, $3
           FROM users u
           WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
             AND NOT EXISTS (
               SELECT 1 FROM notifications
               WHERE business_id = $1 AND type = 'gmail_auth_expired'
                 AND created_at >= NOW() - INTERVAL '3 days'
             )
           LIMIT 1`,
          [businessId,
           'חיבור Gmail פגוע — דוחות Z לא נסרקים',
           tokensBroken
             ? 'מפתח ההצפנה השתנה מאז החיבור ל-Gmail. יש לנתק ולחבר מחדש את Gmail בדף דוחות Z כדי לחדש את הסריקה האוטומטית.'
             : 'Google ביטל את ההרשאה לקריאת המייל, ולכן דוחות Z לא מיובאים אוטומטית. יש להתחבר מחדש ל-Gmail בהגדרות הדוחות.']
        ).catch(() => {});
      } else if (gmailResult._fetchFailed) {
        // Catch-all: fetch failed for a reason other than auth (network timeout,
        // API error, etc.) — errors array may be empty or contain only a generic
        // message. Still notify so the failure doesn't go completely undetected.
        logger.error(`[ZReport Scheduler] business=${businessId} Gmail fetch failed (non-auth)`, { errors: gmailResult.errors });
        await db.query(
          `INSERT INTO notifications (business_id, user_id, type, title, body)
           SELECT $1, u.id, 'gmail_fetch_failed', $2, $3
           FROM users u
           WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
             AND NOT EXISTS (
               SELECT 1 FROM notifications
               WHERE business_id = $1 AND type = 'gmail_fetch_failed'
                 AND created_at >= NOW() - INTERVAL '3 days'
             )
           LIMIT 1`,
          [businessId,
           'שגיאה בסריקת Gmail — דוחות Z לא נסרקו',
           `אירעה שגיאה בסריקת Gmail. יש לנסות ידנית מדף דוחות Z. שגיאה: ${gmailResult.errors?.slice(0, 1).join('') || 'שגיאת רשת לא ידועה'}`]
        ).catch(() => {});
      }
      // Still check for missing days below
    } else {
      // ── 2. IMAP per-business config (fallback) ──────────────────────────────
      const emailConfig = await getEmailConfigWithPassword(businessId).catch(() => null);

    if (emailConfig?.is_active && emailConfig.app_password) {
      const res = await fetchWithConfig(businessId, emailConfig, daysBack);
      // Only stamp last_fetched_at if the scan actually ran (imported something
      // OR completed with no errors). A full connection failure must not overwrite
      // the timestamp from the last successful run.
      if (res.imported > 0 || res.errors.length === 0) {
        await updateLastFetched(businessId, res);
      }
      if (res.imported > 0) {
        logger.info(`[ZReport Scheduler] business=${businessId} email-fetch imported=${res.imported}`);
        await _bustAfterImport(businessId);
      }
      if (res.errors.length) {
        logger.warn(`[ZReport Scheduler] business=${businessId} email-fetch errors`, { errors: res.errors });
      }
    } else if (emailConfig?._decryption_failed) {
      // The business has a stored email config but its password can't be decrypted
      // (JWT_SECRET was likely rotated). Alert the owner so they can reconfigure.
      logger.warn(`[ZReport Scheduler] business=${businessId} email config password unreadable — notifying owner`);
      // notifications.routes.js's GET/unread-count both require user_id = $1 —
      // a notification inserted with NULL user_id (as this used to do) is
      // permanently invisible in the UI, silently discarding this alert.
      await db.query(
        `INSERT INTO notifications (business_id, user_id, type, title, body)
         SELECT $1, u.id, 'email_config_broken', $2, $3
         FROM users u
         WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE business_id = $1 AND type = 'email_config_broken'
             AND created_at >= NOW() - INTERVAL '7 days'
         )
         LIMIT 1`,
        [businessId,
         'הגדרות מייל פגומות — דוחות Z לא יסרקו אוטומטית',
         'לא ניתן לפענח את סיסמת המייל לסריקת דוחות Z. יש להגדיר מחדש את חיבור המייל בהגדרות הדוחות.']
      ).catch(() => {});
    } else if (isImapConfigured() && globalFallbackSafe) {
      // fallback to global IMAP credentials — only safe when this is the sole
      // business without its own per-business config (see _runForAllBusinesses)
      const res = await fetchZReportsForBusiness(businessId, daysBack);
      if (res.imported > 0) {
        logger.info(`[ZReport Scheduler] business=${businessId} IMAP imported=${res.imported}`);
        await _bustAfterImport(businessId);
      }
      if (res.errors.length) {
        logger.warn(`[ZReport Scheduler] business=${businessId} IMAP errors`, { errors: res.errors });
      }
    } else if (!emailConfig) {
      // No email config at all — no Gmail, no IMAP, no global fallback
      logger.warn(`[ZReport Scheduler] business=${businessId} has no email config — Z-reports will NOT be auto-fetched. Configure IMAP or Gmail in platform settings.`);
    }
    } // end of gmailResult === null block

    // בדוק ימים חסרים לאחר הניסיון
    const missing = await getMissingDays(businessId, 7);
    if (!missing.length) return;

    logger.info(`[ZReport Scheduler] business=${businessId} missing days: ${missing.join(', ')}`);

    // יצור/עדכן notification אחת עם כל הימים החסרים
    const datesList = missing.map(d => {
      const [y, m, day] = d.split('-');
      return `${day}/${m}/${y}`;
    }).join(', ');

    // בדוק אם יש כבר התראה פתוחה על אותו נושא (לא לשלוח ספאם)
    const { rows: existing } = await db.query(
      `SELECT id FROM notifications
       WHERE business_id = $1
         AND type = 'zreport_missing'
         AND created_at >= NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [businessId]
    );

    if (existing.length > 0) {
      // עדכן את ההתראה הקיימת במקום ליצור חדשה
      await db.query(
        `UPDATE notifications
         SET title = $2, body = $3, created_at = NOW()
         WHERE id = $1`,
        [existing[0].id,
         `דוח Z חסר (${missing.length} ימים)`,
         `חסרים דוחות Z לתאריכים: ${datesList}. העלה קובץ EML/XLSX מהקופה ידנית.`]
      );
    } else {
      // Same NULL-user_id visibility bug as email_config_broken above — resolve
      // an actual owner/partner instead of leaving user_id unset.
      const { rows: ownerRows } = await db.query(
        `SELECT id FROM users WHERE business_id = $1 AND role IN ('owner','partner') AND is_active = TRUE LIMIT 1`,
        [businessId]
      );
      await db.query(
        `INSERT INTO notifications (business_id, user_id, type, title, body)
         VALUES ($1, $2, 'zreport_missing', $3, $4)`,
        [businessId, ownerRows[0]?.id || null,
         `דוח Z חסר (${missing.length} ימים)`,
         `חסרים דוחות Z לתאריכים: ${datesList}. העלה קובץ EML/XLSX מהקופה ידנית.`]
      );
    }
  } catch (err) {
    logger.error(`[ZReport Scheduler] business=${businessId} error`, { err: err.message });
  }
}

let _isRunning = false; // global — prevents concurrent 02:00 + 10:00 runs

async function _scheduledTick(label) {
  if (_isRunning) {
    logger.warn(`[ZReport Scheduler] skipping ${label} — previous run still in progress`);
    return;
  }
  _isRunning = true;
  logger.info(`[ZReport Scheduler] starting run at ${label}`);
  try {
    await _runForAllBusinesses();
  } catch (err) {
    logger.error('[ZReport Scheduler] uncaught error', { err: err.message });
  } finally {
    _isRunning = false;
  }
}

function startZReportScheduler() {
  // Catch-up: if the backend restarted after a scheduled slot was missed,
  // run immediately. If BOTH slots were missed, stagger by 5 min so the
  // second doesn't collide with the first (_isRunning would block it).
  let catchUpDelay = 8_000;

  for (const { hour, min, label } of DAILY_RUNS_IL) {
    const slotMs     = _ilSlotToday(hour, min);
    const msSinceSlot = slotMs ? Date.now() - slotMs : -1;
    if (msSinceSlot > 0 && msSinceSlot < 11 * 60 * 60 * 1000) {
      const minsMissed = Math.round(msSinceSlot / 60_000);
      logger.info(`[ZReport Scheduler] ${label} was missed by ${minsMissed}min — catch-up in ${catchUpDelay / 1_000}s`);
      setTimeout(() => _scheduledTickLocked(`${label} (catch-up)`), catchUpDelay).unref();
      catchUpDelay += 5 * 60 * 1_000;
    }

    const delay = _msUntilRunIL(hour, min);
    const hoursUntil = Math.round(delay / 3_600_000 * 10) / 10;
    logger.info(`[ZReport Scheduler] registered — next ${label} run in ${hoursUntil}h`);

    const tick = async () => {
      await _scheduledTickLocked(label);
      // Recompute delay each day so DST transitions don't drift the schedule.
      setTimeout(tick, _msUntilRunIL(hour, min)).unref();
    };
    setTimeout(tick, delay).unref();
  }
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _scheduledTickLocked = locked('zreport-check', _scheduledTick);
module.exports = { startZReportScheduler };
