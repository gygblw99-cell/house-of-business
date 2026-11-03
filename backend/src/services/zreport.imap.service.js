/**
 * Z-Report IMAP Service
 * שואב דוחות Z אוטומטית מהמייל של BeePort דרך Gmail IMAP
 */

const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const db  = require('../utils/db');
const logger = require('../utils/logger');
const { parseZReportAuto, importToDatabase, decrementInventoryFromZItems } = require('./zreport.import.service');
const { fullCacheBust, saveLowInventoryNotification } = require('./sync.service');
const { ACTIVE_BUSINESS_SQL } = require('../utils/activeBusiness');

const IMAP_HOST    = process.env.IMAP_HOST     || 'imap.gmail.com';
const IMAP_PORT    = parseInt(process.env.IMAP_PORT || '993', 10);
const IMAP_USER    = process.env.IMAP_USER     || process.env.SMTP_USER;
const IMAP_PASS    = process.env.IMAP_PASSWORD || process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

// BeePort מזהים לחיפוש
const BEEPORT_SENDERS = ['beeport', 'beetrack', 'קופה', 'pos@'];
const BEEPORT_SUBJECTS = ['דוח z', 'דוח-z', 'z report', 'z-report', 'zreport'];

/**
 * Returns true if email is likely a BeePort Z-report email
 */
function _isBeeportEmail(parsed) {
  const from  = (parsed.from?.text || '').toLowerCase();
  const subj  = (parsed.subject   || '').toLowerCase();
  const fromMatch = BEEPORT_SENDERS.some(s  => from.includes(s));
  const subjMatch = BEEPORT_SUBJECTS.some(s => subj.includes(s));
  return fromMatch || subjMatch;
}

const IMAP_PRIORITY_EXTS = ['.xlsx','.xls','.csv','.pdf','.html','.htm','.txt','.xml','.json','.zip'];

function _extractBestAttachment(parsed) {
  const atts = parsed.attachments || [];
  for (const ext of IMAP_PRIORITY_EXTS) {
    const att = atts.find(a => {
      const name = (a.filename || '').toLowerCase();
      return name.endsWith(ext) ||
        (ext === '.xlsx' && (a.contentType?.includes('spreadsheetml') || a.contentType?.includes('excel'))) ||
        (ext === '.pdf'  && a.contentType?.includes('pdf')) ||
        (ext === '.csv'  && a.contentType?.includes('csv')) ||
        (ext === '.html' && a.contentType?.includes('html'));
    });
    if (att) return { buffer: att.content, mimetype: att.contentType, filename: att.filename };
  }
  return null;
}

/**
 * isImapConfigured ג€” true if credentials are available
 */
function isImapConfigured() {
  return !!(IMAP_USER && IMAP_PASS);
}

/**
 * isGlobalFallbackSafe ג€” the global IMAP_USER/IMAP_PASSWORD inbox has no way
 * to tell which business a given email belongs to, so it was only ever safe
 * as a single-tenant fallback. If more than one active business lacks its
 * own per-business email config, scanning the shared inbox for each of them
 * would import the same Z-report emails under multiple different business_ids.
 */
async function isGlobalFallbackSafe() {
  const { rows: businesses } = await db.query(`SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL}`);
  const { rows: configured } = await db.query(
    `SELECT business_id FROM business_email_configs WHERE is_active = TRUE AND app_password IS NOT NULL`
  );
  const configuredIds = new Set(configured.map(r => r.business_id));
  const unconfiguredCount = businesses.filter(b => !configuredIds.has(b.id)).length;
  return unconfiguredCount <= 1;
}

/**
 * fetchZReportsForBusiness ג€” connects to IMAP, finds BeePort emails in the last `daysBack` days,
 * imports any new Z-reports found.
 *
 * Returns { imported, skipped, emailsScanned, errors }
 */
async function fetchZReportsForBusiness(businessId, daysBack = 7) {
  if (!isImapConfigured()) {
    return { imported: 0, skipped: 0, emailsScanned: 0, errors: ['IMAP credentials not configured'] };
  }

  const client = new ImapFlow({
    host:   IMAP_HOST,
    port:   IMAP_PORT,
    secure: true,
    auth:   { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    tls: { rejectUnauthorized: process.env.IMAP_TLS_ALLOW_SELF_SIGNED !== 'true' },
    connectionTimeout: 30000,
    socketTimeout: 60000,
  });

  let imported = 0, skipped = 0, emailsScanned = 0;
  const errors = [];

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      // חיפוש מיילים מ-X ימים אחרונים
      const since = new Date();
      since.setDate(since.getDate() - daysBack);

      const uids = await client.search({ since }, { uid: true });

      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          try {
            if (!msg?.source) continue;

            const parsed = await simpleParser(msg.source);
            emailsScanned++;

            if (!_isBeeportEmail(parsed)) continue;

            // Try attachment first, then email body
            const src = _extractBestAttachment(parsed)
              || (parsed.html  ? { buffer: Buffer.from(parsed.html),  mimetype: 'text/html',  filename: 'body.html' } : null)
              || (parsed.text  ? { buffer: Buffer.from(parsed.text),  mimetype: 'text/plain', filename: 'body.txt'  } : null);
            if (!src) continue;

            let zData;
            try { zData = await parseZReportAuto(src.buffer, src.mimetype, src.filename, { businessId }); }
            catch { continue; }
            if (!zData.zReports.length) continue;

            const result = await importToDatabase(businessId, zData);
            imported += result.imported;
            skipped  += result.skipped;
            if (result.imported > 0) {
              fullCacheBust(businessId).catch(() => {});
            }
            if (result?.lastZSaleId) {
              await decrementInventoryFromZItems(businessId, result.lastZSaleId, zData.zReports || [])
                .catch(e => logger.warn('[ZReport IMAP] decrementInventory failed', { businessId, err: e.message }));
            }

            logger.info(`[ZReport IMAP] business=${businessId} email uid=${msg.uid} ג†’ imported=${result.imported} skipped=${result.skipped}`);
          } catch (msgErr) {
            errors.push(`uid ${msg?.uid ?? '?'}: ${msgErr.message}`);
          }
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (connErr) {
    errors.push(connErr.message);
    logger.error('[ZReport IMAP] connection error', { err: connErr.message });
    try { await client.logout(); } catch {}
  }

  return { imported, skipped, emailsScanned, errors };
}

/**
 * getMissingDays ג€” returns dates (yyyy-mm-dd strings) within the last `lookbackDays`
 * for which no Z-report sale exists in the database.
 * Skips today (report not due yet) and Shabbat (Saturday).
 *
 * All date arithmetic is done in Israel timezone (Asia/Jerusalem) so that the
 * Saturday-skip and the ISO date strings are always consistent with each other.
 * Bug fixed: previously used getDay() (local) but toISOString() (UTC), causing
 * a 1-day shift at UTC+3 that made Saturday appear as missing and Friday disappear.
 */
async function getMissingDays(businessId, lookbackDays = 7) {
  // If the business has never uploaded any Z-reports, nothing is "missing" yet
  const { rows: [{ total }] } = await db.query(
    `SELECT COUNT(*)::int AS total FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
    [businessId]
  );
  if (total === 0) return [];

  const [salesRes, bizRes, firstRes] = await Promise.all([
    db.query(
      `SELECT DISTINCT (sold_at AT TIME ZONE 'Asia/Jerusalem')::date::text AS report_date
       FROM sales
       WHERE business_id = $1
         AND pos_sale_id LIKE 'Z-%'
         AND (sold_at AT TIME ZONE 'Asia/Jerusalem')::date
               >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date - ($2 || ' days')::INTERVAL`,
      [businessId, lookbackDays]
    ),
    db.query(
      `SELECT COALESCE(open_days, '[0,1,2,3,4,5,6]'::jsonb) AS open_days
       FROM businesses WHERE id = $1`,
      [businessId]
    ),
    // Find the earliest Z-report date so we don't flag days before the business
    // started uploading. Without this, a brand-new business that just imported
    // its first report gets notifications for all prior open days in the window.
    db.query(
      `SELECT ((MIN(sold_at)) AT TIME ZONE 'Asia/Jerusalem')::date::text AS first_date
       FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
      [businessId]
    ),
  ]);

  const existingDates = new Set(salesRes.rows.map(r => r.report_date.slice(0, 10)));
  const firstReportDate = firstRes.rows[0]?.first_date?.slice(0, 10) || null;

  // Build a Set of open DOWs (0=Sun ג€¦ 6=Sat) from business settings
  // Handles three formats: numeric array [0,1,2,3], JSON string, and
  // object map {sun:{open:true}, mon:{open:false}, ...} from the settings UI.
  const rawDays = bizRes.rows[0]?.open_days;
  const _DOW_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let _openDowArr;
  if (Array.isArray(rawDays)) {
    _openDowArr = rawDays.map(Number);
  } else if (rawDays && typeof rawDays === 'object') {
    _openDowArr = Object.entries(rawDays)
      .filter(([, v]) => v?.open)
      .map(([k]) => _DOW_MAP[k])
      .filter(d => d !== undefined);
  } else if (typeof rawDays === 'string') {
    try { _openDowArr = JSON.parse(rawDays).map(Number); } catch { _openDowArr = [0,1,2,3,4,5,6]; }
  } else {
    _openDowArr = [0,1,2,3,4,5,6];
  }
  const openDowSet = new Set(_openDowArr);

  const missing = [];

  // Derive "today" in Israel timezone using Intl so DST (UTC+2/+3) is handled correctly.
  const israelToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' }); // "YYYY-MM-DD"
  const [iy, im, id] = israelToday.split('-').map(Number);
  // Anchor at UTC midnight of the Israel calendar date so setUTCDate arithmetic stays aligned.
  const today = new Date(Date.UTC(iy, im - 1, id));

  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10); // "YYYY-MM-DD" aligned to Israel calendar

    // Don't flag days before the business first started uploading Z-reports
    if (firstReportDate && iso < firstReportDate) continue;

    const dow = d.getUTCDay(); // consistent with the UTC-midnight-Israel dates above
    if (!openDowSet.has(dow)) continue; // skip days the business is closed

    if (!existingDates.has(iso)) {
      missing.push(iso);
    }
  }

  return missing.sort();
}

module.exports = { fetchZReportsForBusiness, getMissingDays, isImapConfigured, isGlobalFallbackSafe };
