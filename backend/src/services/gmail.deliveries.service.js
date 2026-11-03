'use strict';

const crypto       = require('crypto');
const { google }  = require('googleapis');
const logger       = require('../utils/logger');
const db           = require('../utils/db');
const gmailOAuth    = require('./gmail.oauth.service');
const eventBus      = require('../utils/eventBus');
const {
  detectPlatform, extractAmount, extractOrderId, isDeliveryEmail, dedupAndInsertSales, htmlToText,
} = require('./deliveries.emailConfig.service');
const { dateToGmailAfter: _dateToGmailAfter, listMessages: _listMessages } = require('./gmail.shared');

// ── Email search query — delivery-platform senders/subjects ───────────────────
// Unlike Z-reports (attachment-based), delivery receipts live in the email body,
// so this query has no `has:attachment` filter, and detection needs no
// user-confirmation step: sender/subject keyword matching is already reliable.
const DELIVERY_QUERY_TERMS = ['wolt', '10bis', 'tenbis', 'תן ביס', 'sibuv', 'cibus', 'סיבוס', 'mislocha', 'mishloha', 'משלוחה'];
const GMAIL_QUERY_DELIVERY = DELIVERY_QUERY_TERMS
  .map(t => `(from:"${t}" OR subject:"${t}")`)
  .join(' OR ');

// Recursively collects the first text/plain and text/html parts of a message,
// decoding base64url body data — same encoding the attachment path already
// uses (gmail.fetch.service.js), just applied to inline body parts here.
function _collectBodyParts(payload, out) {
  if (!payload) return;
  const mime = payload.mimeType || '';
  if (payload.body?.data) {
    if (mime === 'text/plain' && !out.text) out.text = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    if (mime === 'text/html' && !out.html) out.html = Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) payload.parts.forEach(p => _collectBodyParts(p, out));
}

// Fetches a message and shapes it like a mailparser result ({from:{text}, subject,
// date, text, html}) so the existing pure detectPlatform/extractAmount/
// extractOrderId/isDeliveryEmail functions work unmodified.
async function _getMessageBody(gmail, msgId) {
  const msg = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
  const headers = msg.data.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const body = {};
  _collectBodyParts(msg.data.payload, body);

  const dateHeader = getHeader('Date');
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  return {
    from: { text: getHeader('From') },
    subject: getHeader('Subject'),
    // A malformed/unparseable Date header produces an Invalid Date object,
    // which is truthy — without this check it would flow through as soldAt
    // and blow up pg's parameter serialization on insert (see _processMessage).
    date: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null,
    text: body.text || '',
    html: body.html || '',
  };
}

async function _processMessage(gmail, msgId) {
  const parsed = await _getMessageBody(gmail, msgId);
  if (!isDeliveryEmail(parsed, null)) return null;
  const platform = detectPlatform(parsed);
  if (!platform) return null;

  const bodyHtml = htmlToText(parsed.html);
  const amount   = extractAmount(parsed.text) || extractAmount(bodyHtml);
  if (!amount) return null;

  const soldAt = parsed.date || new Date();
  const extId = extractOrderId(parsed.text, platform)
    || extractOrderId(parsed.subject, platform)
    || (() => {
         const seed = `${platform}|${soldAt.toISOString().slice(0, 16)}|${amount}`;
         return `${platform[0].toUpperCase()}_AUTO_${crypto.createHash('md5').update(seed).digest('hex').slice(0, 12)}`;
       })();

  return { platform, amount, sold_at: soldAt, external_order_id: extId, notes: `מייל אוטומטי: ${(parsed.subject || '').slice(0, 120)}` };
}

async function _updateStatus(businessId, { import_status, import_progress, last_sync_at, last_sync_result }) {
  await db.query(
    `INSERT INTO business_delivery_gmail_status (business_id, import_status, import_progress, last_sync_at, last_sync_result)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id) DO UPDATE SET
       import_status     = COALESCE(EXCLUDED.import_status, business_delivery_gmail_status.import_status),
       import_progress    = COALESCE(EXCLUDED.import_progress, business_delivery_gmail_status.import_progress),
       last_sync_at       = COALESCE(EXCLUDED.last_sync_at, business_delivery_gmail_status.last_sync_at),
       last_sync_result   = COALESCE(EXCLUDED.last_sync_result, business_delivery_gmail_status.last_sync_result),
       updated_at         = NOW()`,
    [businessId, import_status || null, import_progress ? JSON.stringify(import_progress) : null,
     last_sync_at || null, last_sync_result ? JSON.stringify(last_sync_result) : null]
  );
}

// Recent/on-demand scan (scheduler + manual "fetch now"). Returns null if no
// Gmail account is connected — callers fall back to the IMAP path.
async function fetchDeliveriesFromGmail(businessId, daysBack = 3) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth) return null;

  const gmail = google.gmail({ version: 'v1', auth });
  const after = new Date(Date.now() - daysBack * 86400000);
  const query = `after:${_dateToGmailAfter(after)} (${GMAIL_QUERY_DELIVERY})`;

  // Thrown (not swallowed into a fake-success result) so callers — the
  // scheduler's Gmail-first/IMAP-fallback logic, and the manual "fetch now"
  // route — can tell a real failure (revoked token, rate limit) apart from
  // "nothing new found" and react accordingly, instead of silently reporting
  // 0 scanned/imported as if the scan had genuinely come up empty.
  let msgIds = [];
  try {
    msgIds = await _listMessages(gmail, query, 300);
  } catch (err) {
    logger.error('[Gmail Deliveries] list messages failed', { businessId, err: err.message });
    throw err;
  }

  const candidates = [];
  const errors = [];
  for (const msgId of msgIds) {
    try {
      const c = await _processMessage(gmail, msgId);
      if (c) candidates.push(c);
    } catch (err) {
      errors.push(err.message);
    }
  }

  let imported = 0, skipped = 0;
  try {
    ({ imported, skipped } = candidates.length
      ? await dedupAndInsertSales(businessId, candidates)
      : { imported: 0, skipped: 0 });
  } catch (err) {
    // Record the failure before rethrowing — callers (scheduler, manual
    // fetch-now) still need the throw to distinguish this from "nothing
    // new found", but without this the last_sync_result on this row would
    // just silently stay stale instead of reflecting the failed attempt.
    logger.error('[Gmail Deliveries] insert failed', { businessId, err: err.message });
    await _updateStatus(businessId, {
      last_sync_at: new Date(),
      last_sync_result: { scanned: msgIds.length, imported: 0, skipped: 0, errors: [...errors, err.message] },
    }).catch(() => {});
    throw err;
  }

  const result = { scanned: msgIds.length, imported, skipped, errors };
  await _updateStatus(businessId, { last_sync_at: new Date(), last_sync_result: result });
  logger.info('[Gmail Deliveries] scan', { businessId, ...result });
  if (imported > 0) eventBus.publish(businessId, 'delivery.imported', { action: 'gmail_fetch', count: imported });
  return result;
}

// One-time/onboarding historical import with progress tracking.
async function fetchHistoricalDeliveriesFromGmail(businessId, monthsBack = 12) {
  const auth = await gmailOAuth.getAuthClient(businessId);
  if (!auth) {
    await _updateStatus(businessId, { import_status: 'error', import_progress: { error: 'חשבון Gmail לא מחובר' } });
    return;
  }

  await _updateStatus(businessId, { import_status: 'running', import_progress: { phase: 'searching', monthsBack, found: 0, processed: 0, imported: 0 } });

  // Everything below is wrapped so import_status always resolves to 'done'
  // or 'error' — without this, a failure anywhere in here (list call, the
  // final insert) left the row stuck at 'running' forever, since the route
  // that calls this function only logs a rejected promise and never updates
  // status itself.
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const after = new Date();
    after.setMonth(after.getMonth() - monthsBack);
    const query = `after:${_dateToGmailAfter(after)} (${GMAIL_QUERY_DELIVERY})`;

    const msgIds = await _listMessages(gmail, query, 3000);

    logger.info('[Gmail Deliveries Historical] starting', { businessId, found: msgIds.length, monthsBack });
    await _updateStatus(businessId, { import_status: 'running', import_progress: { phase: 'processing', found: msgIds.length, processed: 0, imported: 0 } });

    // Collected in memory and inserted once at the end — realistic candidate
    // counts here are in the hundreds, not thousands (delivery-platform emails
    // over 1-24 months), so the extra complexity of flushing in chunks mid-loop
    // (as an earlier version of this function did) bought nothing; this also
    // matches how Z-report's own historical import (gmail.fetch.service.js)
    // handles the same shape of work. dedupAndInsertSales already chunks its
    // own INSERTs internally (1000 rows/statement) regardless of call size.
    const candidates = [];
    const errors = [];

    for (let i = 0; i < msgIds.length; i++) {
      try {
        const c = await _processMessage(gmail, msgIds[i]);
        if (c) candidates.push(c);
      } catch (err) {
        errors.push(err.message);
      }

      if (i % 5 === 4 || i === msgIds.length - 1) {
        await _updateStatus(businessId, { import_status: 'running', import_progress: { phase: 'processing', found: msgIds.length, processed: i + 1, imported: 0 } });
      }
    }

    const { imported } = candidates.length
      ? await dedupAndInsertSales(businessId, candidates)
      : { imported: 0 };

    const result = { scanned: msgIds.length, imported, errors };
    await _updateStatus(businessId, {
      import_status: 'done',
      import_progress: { phase: 'done', found: msgIds.length, processed: msgIds.length, imported },
      last_sync_at: new Date(),
      last_sync_result: result,
    });
    logger.info('[Gmail Deliveries Historical] done', { businessId, scanned: msgIds.length, imported });

    if (imported > 0) eventBus.publish(businessId, 'delivery.imported', { action: 'gmail_import_history', count: imported });
  } catch (err) {
    logger.error('[Gmail Deliveries Historical] failed', { businessId, err: err.message });
    await _updateStatus(businessId, { import_status: 'error', import_progress: { error: err.message } }).catch(() => {});
  }
}

async function getGmailDeliveryStatus(businessId) {
  const { rows } = await db.query(
    `SELECT import_status, import_progress, last_sync_at, last_sync_result
     FROM business_delivery_gmail_status WHERE business_id = $1`,
    [businessId]
  );
  const r = rows[0];
  return {
    importStatus: r?.import_status || 'idle',
    importProgress: r?.import_progress || null,
    lastSyncAt: r?.last_sync_at || null,
    lastSyncResult: r?.last_sync_result || null,
  };
}

module.exports = { fetchDeliveriesFromGmail, fetchHistoricalDeliveriesFromGmail, getGmailDeliveryStatus };
