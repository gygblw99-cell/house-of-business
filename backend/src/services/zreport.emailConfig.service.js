/**
 * Per-business email config for Z-report auto-fetch
 * Stores IMAP credentials per business; encrypts the app password at rest.
 */

const crypto  = require('crypto');
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const { parseZReportAuto, importToDatabase, decrementInventoryFromZItems } = require('./zreport.import.service');
const { saveLowInventoryNotification } = require('./sync.service');

const ALGO = 'aes-256-cbc';

function _key() {
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'fallback-key').digest();
}

function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  try {
    const [ivHex, encHex] = (data || '').split(':');
    if (!ivHex || !encHex) return null;
    const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
  } catch (err) {
    logger.warn('[EmailConfig] password decryption failed ג€” JWT_SECRET may have changed', { err: err.message });
    return null;
  }
}

// ג”€ג”€ CRUD ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

async function getEmailConfig(businessId) {
  const { rows } = await db.query(
    `SELECT id, email, imap_host, imap_port, sender_filter, subject_filter,
            is_active, last_fetched_at, last_result,
            last_success_at, last_success_result
     FROM business_email_configs WHERE business_id = $1`,
    [businessId]
  );
  return rows[0] || null;
}

async function getEmailConfigWithPassword(businessId) {
  const { rows } = await db.query(
    `SELECT * FROM business_email_configs WHERE business_id = $1`,
    [businessId]
  );
  if (!rows[0]) return null;
  const decrypted = decrypt(rows[0].app_password);
  // Expose a flag when the stored password exists but can't be decrypted
  // (e.g. JWT_SECRET was rotated). Callers can surface this as a notification
  // rather than silently falling back to global IMAP or doing nothing.
  const _decryption_failed = decrypted === null && rows[0].app_password != null;
  return { ...rows[0], app_password: decrypted, _decryption_failed };
}

async function saveEmailConfig(businessId, { email, app_password, imap_host, imap_port, sender_filter, subject_filter }) {
  const encPass = encrypt(app_password);
  await db.query(
    `INSERT INTO business_email_configs
       (business_id, email, app_password, imap_host, imap_port, sender_filter, subject_filter)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id) DO UPDATE SET
       email          = EXCLUDED.email,
       app_password   = EXCLUDED.app_password,
       imap_host      = EXCLUDED.imap_host,
       imap_port      = EXCLUDED.imap_port,
       sender_filter  = EXCLUDED.sender_filter,
       subject_filter = EXCLUDED.subject_filter,
       is_active      = TRUE,
       updated_at     = NOW()`,
    [businessId, email, encPass,
     imap_host  || 'imap.gmail.com',
     imap_port  || 993,
     sender_filter  || '',
     subject_filter || '']
  );
}

async function deleteEmailConfig(businessId) {
  await db.query(`DELETE FROM business_email_configs WHERE business_id = $1`, [businessId]);
}

// last_result holds only the most recent run, so a scan that imported three
// reports at 10:00 was erased by an afternoon scan that found nothing new and
// tripped over one unparseable attachment. The screen then showed a bare
// failure for a pipeline that was working correctly. Successful imports are
// now recorded separately and never overwritten by a later empty run.
// A scan that ran cleanly and found nothing new to import IS a success.
//
// Success used to require imported > 0, so a stretch of days with no new
// Z-report — a closed business, or attachments that legitimately held no Z rows
// — left last_success_at frozen. Everything downstream then read that as an
// outage: the admin screen showed the last success days ago, and the
// ingestion-health check raised "no successful import in N days" against a
// pipeline that was working perfectly. That is how three ordinary days got
// reported as a three-day failure.
//
// What matters is whether the scan COMPLETED, not whether it happened to find
// anything: no hard errors, and files were actually looked at.
async function updateLastFetched(businessId, result) {
  const importedOk = (result?.imported || 0) > 0;
  const ranCleanly = !result?._fetchFailed && !(result?.errors?.length);
  const lookedAtFiles = (result?.scanned || 0) > 0 || (result?.noData || 0) > 0;
  const success = importedOk || (ranCleanly && lookedAtFiles);

  await db.query(
    `UPDATE business_email_configs
     SET last_fetched_at     = NOW(),
         last_result         = $2,
         last_success_at     = CASE WHEN $3 THEN NOW() ELSE last_success_at END,
         last_success_result = CASE WHEN $3 THEN $2::jsonb ELSE last_success_result END,
         updated_at          = NOW()
     WHERE business_id = $1`,
    [businessId, JSON.stringify(result), success]
  ).catch(() => {});
}

// ג”€ג”€ Connection test ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

async function testEmailConnection({ email, app_password, imap_host, imap_port }) {
  const client = new ImapFlow({
    host:   imap_host || 'imap.gmail.com',
    port:   parseInt(imap_port || '993', 10),
    secure: true,
    auth:   { user: email, pass: app_password },
    logger: false,
    tls:    { rejectUnauthorized: process.env.IMAP_TLS_ALLOW_SELF_SIGNED !== 'true' },
    connectionTimeout: 30000,
    socketTimeout: 60000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let count = 0;
    try {
      const st = await client.status('INBOX', { messages: true });
      count = st.messages || 0;
    } finally { lock.release(); }
    await client.logout();
    return { success: true, message: `חיבור הצליח — ${count} מיילים ב-Inbox` };
  } catch (err) {
    try { await client.logout(); } catch {}
    return { success: false, message: err.message };
  }
}

// ג”€ג”€ Per-business IMAP fetch ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

const ZREPORT_ATTACH_EXTS = new Set(['.xlsx','.xls','.csv','.pdf','.txt','.html','.htm','.xml','.json','.zip','.eml']);

function _hasZReportAttachment(parsed) {
  return (parsed.attachments || []).some(a => {
    const name = (a.filename || '').toLowerCase();
    const dot  = name.lastIndexOf('.');
    return dot !== -1 && ZREPORT_ATTACH_EXTS.has(name.slice(dot));
  });
}

function _isZReportEmail(parsed, senderFilter, subjectFilter) {
  const from = (parsed.from?.text || '').toLowerCase();
  const subj = (parsed.subject   || '').toLowerCase();

  const hasSenderFilter  = !!(senderFilter  && senderFilter.trim());
  const hasSubjectFilter = !!(subjectFilter && subjectFilter.trim());

  // כשאין פילטרים בכלל — קבל כל מייל שיש לו קובץ מצורף רלוונטי (הפרסר יחליט אם זה Z)
  if (!hasSenderFilter && !hasSubjectFilter) {
    return _hasZReportAttachment(parsed);
  }

  const senders  = hasSenderFilter  ? senderFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)  : [];
  const subjects = hasSubjectFilter ? subjectFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
                                    : ['דוח z', 'דוח-z', 'z report', 'z-report', 'zreport', 'z-174', 'beeport', 'pos report'];

  const fromOk = !hasSenderFilter  || senders.some(s => from.includes(s));
  const subjOk = !hasSubjectFilter || subjects.some(s => subj.includes(s));
  return fromOk && subjOk;
}

// Returns the best attachment for Z-report parsing (any supported format)
const ZREPORT_EXTS = new Set(['.xlsx','.xls','.csv','.pdf','.txt','.html','.htm','.xml','.json','.zip']);

function _extractBestAttachment(parsed) {
  const atts = parsed.attachments || [];
  // Priority order: xlsx > csv > pdf > html > txt > xml > json > zip
  const priority = ['.xlsx','.xls','.csv','.pdf','.html','.htm','.txt','.xml','.json','.zip'];
  for (const ext of priority) {
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

// Fallback: parse the email body itself (HTML or plain text)
function _emailBodyBuffer(parsed) {
  if (parsed.html) return { buffer: Buffer.from(parsed.html), mimetype: 'text/html', filename: 'email-body.html' };
  if (parsed.text) return { buffer: Buffer.from(parsed.text), mimetype: 'text/plain', filename: 'email-body.txt' };
  return null;
}

async function fetchWithConfig(businessId, config, daysBack = 7) {
  const { email, app_password, imap_host, imap_port, sender_filter, subject_filter } = config;

  const client = new ImapFlow({
    host:   imap_host || 'imap.gmail.com',
    port:   parseInt(imap_port || '993', 10),
    secure: true,
    auth:   { user: email, pass: app_password },
    logger: false,
    tls:    { rejectUnauthorized: process.env.IMAP_TLS_ALLOW_SELF_SIGNED !== 'true' },
    connectionTimeout: 30000,
    socketTimeout: 60000,
  });

  let imported = 0, skipped = 0, emailsScanned = 0;
  const errors = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date();
      since.setDate(since.getDate() - daysBack);

      const uids = await client.search({ since }, { uid: true });
      logger.info(`[ZReport Email] biz=${businessId} found ${uids.length} emails in last ${daysBack} days`);

      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          try {
            if (!msg?.source) continue;

            const parsed = await simpleParser(msg.source);
            emailsScanned++;

            const passes = _isZReportEmail(parsed, sender_filter, subject_filter);
            logger.debug(`[ZReport Email] uid=${msg.uid} from="${parsed.from?.text}" subj="${parsed.subject}" ג†’ ${passes ? 'PASS' : 'skip'}`);
            if (!passes) continue;

            // Try attachment first, then email body as fallback
            const src = _extractBestAttachment(parsed) || _emailBodyBuffer(parsed);
            if (!src) { logger.debug(`[ZReport Email] uid=${msg.uid} no usable content, skip`); continue; }

            let zData;
            try {
              zData = await parseZReportAuto(src.buffer, src.mimetype, src.filename, { businessId });
            } catch (parseErr) {
              logger.debug(`[ZReport Email] uid=${msg.uid} parse failed: ${parseErr.message}`);
              continue;
            }
            if (!zData.zReports.length) {
              logger.debug(`[ZReport Email] uid=${msg.uid} parsed but 0 zReports`);
              continue;
            }

            const result = await importToDatabase(businessId, zData);
            imported += result.imported;
            skipped  += result.skipped;
            if (result?.lastZSaleId) {
              await decrementInventoryFromZItems(businessId, result.lastZSaleId, zData.zReports || [])
                .catch(e => logger.warn('[ZReport Email] decrementInventory failed', { businessId, err: e.message }));
            }

            logger.info(`[ZReport Email] biz=${businessId} uid=${msg.uid} imported=${result.imported} skipped=${result.skipped}`);
          } catch (msgErr) {
            errors.push(`uid ${msg?.uid ?? '?'}: ${msgErr.message}`);
          }
        }
      }
      logger.info(`[ZReport Email] biz=${businessId} done ג€” scanned=${emailsScanned} imported=${imported} skipped=${skipped} errors=${errors.length}`);
    } finally { lock.release(); }

    await client.logout();
  } catch (connErr) {
    errors.push(connErr.message);
    logger.error('[ZReport Email] connection error', { biz: businessId, err: connErr.message });
    try { await client.logout(); } catch {}
  }

  return { imported, skipped, emailsScanned, errors };
}

module.exports = {
  getEmailConfig,
  getEmailConfigWithPassword,
  saveEmailConfig,
  deleteEmailConfig,
  testEmailConnection,
  fetchWithConfig,
  updateLastFetched,
};
