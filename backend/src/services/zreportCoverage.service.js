'use strict';

/**
 * Z-report coverage — an explicit answer to "do we actually have the data?"
 *
 * Every revenue figure in this platform originates in a Z-report, which makes
 * the Z-report pipeline the single point of failure for all financial output.
 * Its failure history is one repeated shape: a BOM that broke parsing, a Gmail
 * token that expired after 7 days, a non-atomic inventory deduction, an old
 * heuristic that quietly matched the wrong numbers. In every case the failure
 * was SILENT — the UI showed figures instead of admitting it had nothing, and
 * nobody could tell a real ₪0 day from a day that never imported.
 *
 * The weekly report already solved this for itself with `dataAvailability`
 * after it hallucinated findings from absent data. This is the same idea one
 * layer down, where every other consumer can reach it.
 *
 * The important distinction this draws, which a plain "missing days" count
 * cannot: an empty month because the business was CLOSED is not a failure, and
 * must not be reported as one. March came back empty for exactly that reason.
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');
const { todayIL } = require('../utils/dateIL');

const MS_DAY = 86_400_000;

/** Every YYYY-MM-DD from `from` to `to` inclusive. */
function dateRange(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let t = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += MS_DAY; }
  return out;
}

/** 0 = Sunday, timezone-independent. */
function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Collapses a sorted list of dates into consecutive runs. */
function toGaps(dates) {
  const gaps = [];
  for (const d of dates) {
    const last = gaps[gaps.length - 1];
    if (last && shift(last.to, 1) === d) { last.to = d; last.days++; }
    else gaps.push({ from: d, to: d, days: 1 });
  }
  return gaps;
}

function shift(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * MS_DAY).toISOString().slice(0, 10);
}

/**
 * Coverage for one business over [from, to] (YYYY-MM-DD, Israel calendar days).
 *
 * Never throws for data reasons: on a query failure it returns verdict 'unknown'
 * with canReportFinancials = false, because "we could not verify" must behave
 * like "we have nothing", not like "everything is fine".
 */
async function getZReportCoverage(businessId, { from, to } = {}) {
  const today = todayIL();
  const rangeTo   = to   || today;
  const rangeFrom = from || shift(rangeTo, -29);

  if (rangeFrom > rangeTo) {
    return _unknown(rangeFrom, rangeTo, 'טווח תאריכים לא תקין');
  }

  let salesRows, biz, firstRow, cfg;
  try {
    [{ rows: salesRows }, { rows: [biz] }, { rows: [firstRow] }, { rows: [cfg] }] = await Promise.all([
      db.query(
        `SELECT DISTINCT (sold_at AT TIME ZONE 'Asia/Jerusalem')::date::text AS d
           FROM sales
          WHERE business_id = $1
            AND pos_sale_id LIKE 'Z-%'
            AND (sold_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN $2::date AND $3::date`,
        [businessId, rangeFrom, rangeTo],
      ),
      db.query(
        `SELECT COALESCE(open_days, '[0,1,2,3,4,5,6]'::jsonb) AS open_days
           FROM businesses WHERE id = $1`,
        [businessId],
      ),
      db.query(
        `SELECT ((MIN(sold_at)) AT TIME ZONE 'Asia/Jerusalem')::date::text AS first_date
           FROM sales
          WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
        [businessId],
      ),
      // Both intake paths, newest success first.
      //
      // There are two: Gmail OAuth (business_google_accounts) and per-business
      // IMAP (business_email_configs). This originally read only the IMAP one,
      // so for a business on Gmail — which is the one actually in use — it
      // reported "no email connection configured" or a frozen timestamp from a
      // path that had not run in months. A health check that reads the wrong
      // table is worse than none, because it answers confidently.
      db.query(
        `SELECT is_active, last_sync_at AS last_fetched_at, last_success_at,
                last_sync_result AS last_result, 'gmail' AS source
           FROM business_google_accounts WHERE business_id = $1
          UNION ALL
         SELECT is_active, last_fetched_at, last_success_at,
                last_result, 'imap' AS source
           FROM business_email_configs   WHERE business_id = $1
          ORDER BY last_success_at DESC NULLS LAST, last_fetched_at DESC NULLS LAST
          LIMIT 1`,
        [businessId],
      ),
    ]);
  } catch (err) {
    logger.error('[ZCoverage] query failed', { businessId, err: err.message });
    return _unknown(rangeFrom, rangeTo, 'לא ניתן לאמת את זמינות הנתונים כרגע');
  }

  const presentDays = salesRows.map(r => r.d).sort();
  const firstEver   = firstRow?.first_date || null;

  // open_days is a JSON array of weekday numbers the business trades on.
  let openDays;
  try {
    const raw = typeof biz?.open_days === 'string' ? JSON.parse(biz.open_days) : biz?.open_days;
    openDays = new Set((Array.isArray(raw) ? raw : [0, 1, 2, 3, 4, 5, 6]).map(Number));
  } catch {
    openDays = new Set([0, 1, 2, 3, 4, 5, 6]);
  }

  // A day is "expected" only if the business trades that weekday, the day is
  // already over, and it is not before this business ever started reporting.
  const expectedDays = dateRange(rangeFrom, rangeTo).filter(d =>
    openDays.has(dayOfWeek(d)) &&
    d < today &&                              // today's report isn't due yet
    (!firstEver || d >= firstEver)            // don't blame a business for days predating its first upload
  );

  const presentSet = new Set(presentDays);
  const missingDays = expectedDays.filter(d => !presentSet.has(d));
  const coverage = expectedDays.length ? (expectedDays.length - missingDays.length) / expectedDays.length : null;

  const ingestion = _ingestionHealth(cfg, today);

  // ── verdict ───────────────────────────────────────────────────────────────
  const explanation = [];
  let verdict;

  if (!firstEver) {
    verdict = 'no_data';
    explanation.push('לא יובא אף דוח Z לעסק הזה — אין בסיס לשום נתון כספי.');
  } else if (!expectedDays.length) {
    // Nothing was expected: the business is closed on every weekday in range,
    // or the whole range predates its first report. NOT a failure.
    verdict = 'closed_period';
    explanation.push(
      firstEver > rangeTo
        ? `העסק התחיל לדווח ב-${firstEver}, אחרי הטווח המבוקש — אין מה לצפות כאן.`
        : 'העסק סגור בכל הימים בטווח המבוקש, ולכן היעדר דוחות אינו תקלה.'
    );
  } else if (!missingDays.length) {
    verdict = 'complete';
    explanation.push(`כל ${expectedDays.length} ימי הפעילות בטווח מכוסים.`);
  } else if (presentDays.length === 0) {
    verdict = 'empty';
    explanation.push(`אף אחד מ-${expectedDays.length} ימי הפעילות בטווח לא יובא. אין להציג נתונים כספיים לתקופה הזאת.`);
  } else {
    verdict = 'partial';
    explanation.push(`חסרים ${missingDays.length} מתוך ${expectedDays.length} ימי פעילות — כל סכום לתקופה הזאת חלקי.`);
  }

  if (ingestion.broken) explanation.push(ingestion.reason);

  // The flag consumers branch on. Partial data still blocks a headline figure:
  // a revenue total that silently omits a third of the month is worse than none.
  const canReportFinancials = verdict === 'complete' || verdict === 'closed_period';

  return {
    range: { from: rangeFrom, to: rangeTo, days: dateRange(rangeFrom, rangeTo).length },
    verdict,
    canReportFinancials,
    coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000,
    expectedDayCount: expectedDays.length,
    presentDayCount: presentDays.length,
    missingDays,
    gaps: toGaps(missingDays),
    firstReportDate: firstEver,
    ingestion,
    explanation,
  };
}

function _ingestionHealth(cfg, today) {
  if (!cfg) {
    return {
      configured: false, broken: false, lastSuccessAt: null, lastAttemptAt: null, staleDays: null,
      reason: 'לא מוגדר חיבור מייל — דוחות Z נכנסים רק בהעלאה ידנית.',
    };
  }
  const lastSuccessAt = cfg.last_success_at ? new Date(cfg.last_success_at).toISOString() : null;
  const lastAttemptAt = cfg.last_fetched_at ? new Date(cfg.last_fetched_at).toISOString() : null;
  const staleDays = cfg.last_success_at
    ? Math.floor((Date.now() - new Date(cfg.last_success_at).getTime()) / MS_DAY)
    : null;

  // A Gmail token in Google's "Testing" mode expires every 7 days, and the
  // failure is silent — this is the exact outage that hid a month of gaps.
  const fetchFailed = cfg.last_result?._fetchFailed === true;
  const stale = staleDays !== null && staleDays > 7;

  let reason = null;
  if (!cfg.is_active)   reason = 'חיבור המייל כבוי — דוחות Z לא נסרקים אוטומטית.';
  else if (fetchFailed) reason = 'הסריקה האחרונה של המייל נכשלה — יש לבדוק את חיבור ה-Gmail בדף דוחות Z.';
  else if (stale)       reason = `לא היה ייבוא מוצלח מהמייל ${staleDays} ימים. טוקן Gmail במצב Testing פג כל 7 ימים — כנראה צריך לחבר מחדש.`;
  else if (staleDays === null) reason = 'חיבור המייל מוגדר אך מעולם לא ייבא בהצלחה.';

  return {
    configured: true,
    broken: Boolean(reason),
    lastSuccessAt, lastAttemptAt, staleDays,
    reason,
  };
}

function _unknown(from, to, message) {
  return {
    range: { from, to, days: null },
    verdict: 'unknown',
    canReportFinancials: false,
    coverage: null,
    expectedDayCount: null,
    presentDayCount: null,
    missingDays: [],
    gaps: [],
    firstReportDate: null,
    ingestion: { configured: false, broken: true, lastSuccessAt: null, lastAttemptAt: null, staleDays: null, reason: message },
    explanation: [message],
  };
}

module.exports = { getZReportCoverage, _internals: { dateRange, dayOfWeek, toGaps, shift } };
