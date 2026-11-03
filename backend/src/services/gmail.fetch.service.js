'use strict';

const { google }  = require('googleapis');
const logger      = require('../utils/logger');
const db          = require('../utils/db');
const gmailOAuth  = require('./gmail.oauth.service');
const { parseZReportAuto, importToDatabase, decrementInventoryFromZItems, syncEmployeesAndShifts } = require('./zreport.import.service');
const { bustContextCache } = require('./ai/business.context');
const cache       = require('../utils/cache');
const eventBus    = require('../utils/eventBus');
const { dateToGmailAfter: _dateToGmailAfter, listMessages: _listMessages } = require('./gmail.shared');
const { fullCacheBust } = require('./sync.service');

// ג”€ג”€ Email search queries ג€” any of these in the subject triggers fetch ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
const ZREPORT_SUBJECTS = [
  'דוח z', 'דוח-z', 'z report', 'z-report', 'zreport',
  'beeport', 'pos report', 'z-174', 'קופה',
  'דוח מסכם יומי',
];
// Gmail query: subject contains any of these terms
const GMAIL_QUERY_SUBJECTS = ZREPORT_SUBJECTS
  .map(t => `subject:"${t}"`)
  .join(' OR ');

// Attachment file extensions we can parse
const SUPPORTED_EXTS = new Set(['xlsx', 'xls', 'csv', 'pdf', 'txt', 'html', 'htm', 'json', 'zip', 'eml']);
// Priority order: best format first
const EXT_PRIO = ['xlsx', 'xls', 'csv', 'pdf', 'html', 'htm', 'txt', 'json', 'zip', 'eml'];

// ג”€ג”€ Helpers ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

// Recursively collect all MIME parts that have an attachmentId
function _flattenParts(payload, out = []) {
  if (!payload) return out;
  if (payload.body?.attachmentId && payload.filename) out.push(payload);
  if (payload.parts) payload.parts.forEach(p => _flattenParts(p, out));
  return out;
}

// Pick the best attachment by format priority
function _pickBestAttachment(parts) {
  const ranked = parts
    .map(p => {
      const ext   = (p.filename || '').split('.').pop()?.toLowerCase() || '';
      const prio  = EXT_PRIO.indexOf(ext);
      return { part: p, ext, prio };
    })
    .filter(x => x.prio >= 0 && SUPPORTED_EXTS.has(x.ext))
    .sort((a, b) => a.prio - b.prio);

  if (!ranked.length) return null;
  const best = ranked[0].part;
  return { attachmentId: best.body.attachmentId, mimeType: best.mimeType, filename: best.filename };
}

// Download attachment bytes, decode from base64url
async function _downloadAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me', messageId, id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64url');
}

// Fallback: extract the email body (HTML preferred, then plain text) when there
// is no parseable attachment. Some POS systems embed the Z-report directly in
// the message body rather than attaching a file.
function _getEmailBodyBuffer(payload) {
  const findPart = (p, mime) => {
    if (!p) return null;
    if (p.mimeType === mime && p.body?.data) return p;
    for (const part of (p.parts || [])) {
      const found = findPart(part, mime);
      if (found) return found;
    }
    return null;
  };
  const html = findPart(payload, 'text/html');
  if (html) return { buffer: Buffer.from(html.body.data, 'base64url'), mimeType: 'text/html', filename: 'email-body.html' };
  const txt = findPart(payload, 'text/plain');
  if (txt) return { buffer: Buffer.from(txt.body.data, 'base64url'), mimeType: 'text/plain', filename: 'email-body.txt' };
  return null;
}

// Process a single message ג€” returns number of Z-records imported
// Wraps the entire operation in a 60-second timeout so a single slow/hung
// email never freezes the whole import.
async function _processMessage(gmail, businessId, msgId) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('message timeout after 60s')), 60_000);
  });
  try {
    return await Promise.race([_processMessageInner(gmail, businessId, msgId), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function _processMessageInner(gmail, businessId, msgId) {
  const msg     = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
  const payload = msg.data.payload;
  const parts   = _flattenParts(payload);
  const att     = _pickBestAttachment(parts);

  let buffer, mimeType, filename;
  if (att) {
    buffer   = await _downloadAttachment(gmail, msgId, att.attachmentId);
    mimeType = att.mimeType;
    filename = att.filename;
  } else {
    const body = _getEmailBodyBuffer(payload);
    if (!body) return 0;
    ({ buffer, mimeType, filename } = body);
  }

  // Identify the message on failure. The raw parser error names the file at
  // best, which is no help when a scan covers ninety-odd messages and the same
  // unreadable attachment resurfaces on every run ג€” there was no way to tell
  // which email to go and look at.
  const _hdr = (n) => (payload.headers || []).find(h => h.name?.toLowerCase() === n)?.value || '';
  let parsed;
  try {
    parsed = await parseZReportAuto(buffer, mimeType, filename, { businessId });
  } catch (err) {
    const subject = _hdr('subject');
    const date    = _hdr('date');
    err.message = `${err.message} [מייל: "${subject || '(ללא נושא)'}"${date ? `, ${date}` : ''}]`;
    throw err;
  }
  if (!parsed?.zReports?.length) return 0;

  const result = await importToDatabase(businessId, parsed);
  if (result?.lastZSaleId) {
    await decrementInventoryFromZItems(businessId, result.lastZSaleId, parsed.zReports || [])
      .catch(e => logger.warn('[Gmail] decrementInventory failed', { businessId, err: e.message }));
  }
  if (result?.imported > 0 && parsed.shifts?.length) {
    await syncEmployeesAndShifts(businessId)
      .catch(e => logger.warn('[Gmail] syncEmployeesAndShifts failed', { businessId, err: e.message }));
  }
  return result?.imported || 0;
}

// Bust all derived caches after a Gmail import.
// Delegates to fullCacheBust (single source of truth) + bustContextCache.
async function _bustCaches(businessId) {
  await Promise.allSettled([fullCacheBust(businessId), bustContextCache(businessId)]);
}

// ג”€ג”€ Public: detect subject pattern from recent emails ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

const POS_KEYWORDS = ['דוח', 'z report', 'zreport', 'beeport', 'pos', 'קופה', 'מסכם', 'יומי', 'מכירות', 'סיכום'];

async function detectSubjectPattern(businessId) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth || auth._tokensBroken) return [];

  const gmail = google.gmail({ version: 'v1', auth });

  // List up to 100 recent inbox messages (no attachment filter ג€” body-only
  // Z-report emails must also be visible for subject detection)
  const listRes = await gmail.users.messages.list({
    userId: 'me', q: 'in:inbox', maxResults: 100,
  }).catch(() => null);

  const msgIds = (listRes?.data?.messages || []).map(m => m.id);
  if (!msgIds.length) return [];

  // Fetch metadata in parallel batches of 20 (subject only ג€” no attachment download)
  const subjectCounts = {};
  for (let i = 0; i < Math.min(msgIds.length, 60); i += 20) {
    const batch = msgIds.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(id =>
        gmail.users.messages.get({
          userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'],
        }).catch(() => null)
      )
    );
    for (const res of results) {
      if (!res) continue;
      const subjectHeader = res.data.payload?.headers?.find(h => h.name === 'Subject');
      const subject = subjectHeader?.value;
      if (subject) subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
    }
  }

  // Candidates: appear 2+ times OR contain POS-related keyword
  return Object.entries(subjectCounts)
    .filter(([subject, count]) => {
      const lower = subject.toLowerCase();
      return count >= 2 || POS_KEYWORDS.some(kw => lower.includes(kw));
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([subject, count]) => ({ subject, count }));
}

// ג”€ג”€ Public: nightly fetch (last N days) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

async function fetchZReportsFromGmail(businessId, daysBack = 7) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth) return null; // no Gmail account connected ג€” caller falls back to IMAP
  // Account exists but tokens can't be decrypted (JWT_SECRET was rotated).
  // Return a fetchFailed result so the scheduler sends a reconnect notification.
  if (auth._tokensBroken) {
    return { scanned: 0, imported: 0, errors: ['tokens_unreadable: יש לנתק ולחבר מחדש את Gmail'], _fetchFailed: true };
  }

  // Use confirmed subjects if user has set them, otherwise fall back to defaults
  const { rows } = await db.query(
    'SELECT confirmed_subjects FROM business_google_accounts WHERE business_id = $1',
    [businessId]
  );
  const confirmed = rows[0]?.confirmed_subjects;
  const querySubjects = confirmed?.length
    ? confirmed.map(s => `subject:"${s}"`).join(' OR ')
    : GMAIL_QUERY_SUBJECTS;

  const gmail   = google.gmail({ version: 'v1', auth });
  const after   = new Date(Date.now() - daysBack * 86400000);
  const query   = `after:${_dateToGmailAfter(after)} (${querySubjects})`;

  let msgIds = [];
  try {
    msgIds = await _listMessages(gmail, query, 200);
  } catch (err) {
    logger.error('[Gmail Fetch] list messages failed', { businessId, err: err.message });
    return { scanned: 0, imported: 0, errors: [err.message], _fetchFailed: true };
  }

  logger.info('[Gmail Fetch] nightly scan', { businessId, found: msgIds.length, daysBack });

  let imported = 0;
  let noData   = 0;
  const errors = [];

  for (const msgId of msgIds) {
    try {
      imported += await _processMessage(gmail, businessId, msgId);
    } catch (err) {
      // An attachment that read fine and held no Z rows is not an error.
      // Lumping it in with real failures is what made three days of ordinary
      // scans look like a broken importer: "scanned 90, imported 0" plus ninety
      // error strings, when the honest summary was "ninety files, none with Z rows".
      if (err.isNoData || err.code === 'ZREPORT_NO_DATA') {
        noData++;
        logger.info('[Gmail Fetch] message had no Z data', { businessId, msgId });
        continue;
      }
      logger.warn('[Gmail Fetch] message error', { businessId, msgId, err: err.message });
      errors.push(err.message);
    }
  }

  // noData is reported separately so "nothing to import" can never be read as
  // "the scan failed" — by a person or by the ingestion-health check.
  const result = { scanned: msgIds.length, imported, noData, errors };
  // Wrap post-import side-effects so a transient DB error never makes the
  // caller (scheduler) think there is no Gmail account at all.
  try {
    await gmailOAuth.updateSyncResult(businessId, result);
  } catch (err) {
    logger.warn('[Gmail Fetch] updateSyncResult failed', { businessId, err: err.message });
  }
  if (imported > 0) {
    await _bustCaches(businessId).catch(err =>
      logger.warn('[Gmail Fetch] cache bust failed', { businessId, err: err.message })
    );
  }

  return result;
}

// ג”€ג”€ Public: full historical import (first-time onboarding) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

async function fetchHistoricalFromGmail(businessId, monthsBack = 24) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth || auth._tokensBroken) {
    await gmailOAuth.updateImportProgress(businessId, 'error', {
      error: auth?._tokensBroken
        ? 'טוקן Gmail לא קריא — יש לנתק ולחבר מחדש'
        : 'חשבון Gmail לא מחובר',
    });
    return;
  }

  await gmailOAuth.updateImportProgress(businessId, 'running', {
    phase: 'searching', monthsBack, found: 0, processed: 0, imported: 0,
  });

  // Use confirmed subjects if set
  const { rows } = await db.query(
    'SELECT confirmed_subjects FROM business_google_accounts WHERE business_id = $1',
    [businessId]
  );
  const confirmed = rows[0]?.confirmed_subjects;
  const querySubjects = confirmed?.length
    ? confirmed.map(s => `subject:"${s}"`).join(' OR ')
    : GMAIL_QUERY_SUBJECTS;

  const gmail = google.gmail({ version: 'v1', auth });
  const after = new Date();
  after.setMonth(after.getMonth() - monthsBack);
  const query = `after:${_dateToGmailAfter(after)} (${querySubjects})`;

  let msgIds = [];
  try {
    msgIds = await _listMessages(gmail, query, 2000);
  } catch (err) {
    logger.error('[Gmail Historical] list failed', { businessId, err: err.message });
    await gmailOAuth.updateImportProgress(businessId, 'error', { error: err.message });
    return;
  }

  logger.info('[Gmail Historical] starting', { businessId, found: msgIds.length, monthsBack });
  await gmailOAuth.updateImportProgress(businessId, 'running', {
    phase: 'processing', found: msgIds.length, processed: 0, imported: 0,
  });

  let imported = 0;
  const errors = [];

  for (let i = 0; i < msgIds.length; i++) {
    // Check every 10 messages if the import was cancelled (e.g. user logged out)
    if (i > 0 && i % 10 === 0) {
      const { rows } = await db.query(
        'SELECT import_status FROM business_google_accounts WHERE business_id = $1',
        [businessId]
      );
      if (rows[0]?.import_status !== 'running') {
        logger.info('[Gmail Historical] import cancelled', { businessId, processed: i, imported });
        return;
      }
    }

    try {
      imported += await _processMessage(gmail, businessId, msgIds[i]);
    } catch (err) {
      errors.push(err.message);
    }

    await gmailOAuth.updateImportProgress(businessId, 'running', {
      phase: 'processing', found: msgIds.length, processed: i + 1, imported,
    });
  }

  await gmailOAuth.updateImportProgress(businessId, 'done', {
    phase: 'done', found: msgIds.length, processed: msgIds.length, imported,
  });
  await gmailOAuth.updateSyncResult(businessId, { scanned: msgIds.length, imported, errors });

  if (imported > 0) await _bustCaches(businessId);
  logger.info('[Gmail Historical] done', { businessId, scanned: msgIds.length, imported });
}

// ג”€ג”€ Public: diagnose current Gmail search config ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Returns what query would be used, how many emails match it in the last 14
// days, and the subjects of those emails ג€” lets the owner see in one click
// whether their Gmail connection is reaching the right emails.
async function diagnoseGmailFetch(businessId) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth) return { connected: false };
  if (auth._tokensBroken) {
    return { connected: true, tokensBroken: true, error: 'טוקן Gmail לא קריא — יש לנתק ולחבר מחדש. ייתכן שה-JWT_SECRET השתנה.' };
  }

  const { rows } = await db.query(
    'SELECT confirmed_subjects FROM business_google_accounts WHERE business_id = $1',
    [businessId]
  );
  const confirmed = rows[0]?.confirmed_subjects;
  const querySubjects = confirmed?.length
    ? confirmed.map(s => `subject:"${s}"`).join(' OR ')
    : GMAIL_QUERY_SUBJECTS;

  const gmail = google.gmail({ version: 'v1', auth });
  const after = new Date(Date.now() - 14 * 86_400_000);
  const query = `after:${_dateToGmailAfter(after)} (${querySubjects})`;

  let emailsFound = 0;
  let sampleSubjects = [];
  try {
    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 });
    const msgIds = (listRes.data.messages || []).map(m => m.id);
    emailsFound = msgIds.length;
    const metas = await Promise.all(
      msgIds.slice(0, 5).map(id =>
        gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'Date'] })
          .catch(() => null)
      )
    );
    sampleSubjects = metas
      .filter(Boolean)
      .map(res => {
        const headers = res.data.payload?.headers || [];
        return {
          subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
          date:    headers.find(h => h.name === 'Date')?.value || '',
        };
      });
  } catch (err) {
    return { connected: true, error: err.message, query, confirmedSubjects: confirmed || null };
  }

  return {
    connected: true,
    query,
    confirmedSubjects: confirmed || null,
    usingDefaults: !confirmed?.length,
    emailsFound,
    sampleSubjects,
  };
}

module.exports = { fetchZReportsFromGmail, fetchHistoricalFromGmail, detectSubjectPattern, diagnoseGmailFetch };
