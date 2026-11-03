const crypto  = require('crypto');
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const eventBus = require('../utils/eventBus');
const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');

const ALGO = 'aes-256-cbc';

// Table is now created in bootstrap.js (awaited, sequential, fatal on failure).
// The old fire-and-forget db.migrate() calls here (including a dangerous DROP TABLE)
// have been removed. The bootstrap ensures the table exists before this module loads.

// Prefer DELIVERY_EMAIL_ENC_KEY. Fallback to JWT_SECRET for backward compat.
// WARNING: rotating JWT_SECRET will break decryption of stored passwords.
// Set DELIVERY_EMAIL_ENC_KEY separately to avoid this coupling.
function _key() {
  const secret = process.env.DELIVERY_EMAIL_ENC_KEY || process.env.JWT_SECRET;
  if (!secret || secret === 'fallback-key') {
    throw new Error('[emailConfig] DELIVERY_EMAIL_ENC_KEY or JWT_SECRET must be set');
  }
  return crypto.createHash('sha256').update(secret).digest();
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
  } catch { return null; }
}

async function getConfig(businessId) {
  const { rows } = await db.query(
    `SELECT id, email, imap_host, imap_port, sender_filter, is_active, last_fetched_at, last_result
     FROM business_delivery_email_configs WHERE business_id = $1`,
    [businessId]
  );
  return rows[0] || null;
}

async function getConfigWithPassword(businessId) {
  const { rows } = await db.query(
    `SELECT * FROM business_delivery_email_configs WHERE business_id = $1`,
    [businessId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], app_password: decrypt(rows[0].app_password) };
}

async function saveConfig(businessId, { email, app_password, imap_host, imap_port, sender_filter }) {
  const encPass = encrypt(app_password);
  await db.query(
    `INSERT INTO business_delivery_email_configs
       (business_id, email, app_password, imap_host, imap_port, sender_filter)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (business_id) DO UPDATE SET
       email         = EXCLUDED.email,
       app_password  = EXCLUDED.app_password,
       imap_host     = EXCLUDED.imap_host,
       imap_port     = EXCLUDED.imap_port,
       sender_filter = EXCLUDED.sender_filter,
       is_active     = TRUE,
       updated_at    = NOW()`,
    [businessId, email, encPass,
     imap_host  || 'imap.gmail.com',
     imap_port  || 993,
     sender_filter || '']
  );
}

async function deleteConfig(businessId) {
  await db.query(`DELETE FROM business_delivery_email_configs WHERE business_id = $1`, [businessId]);
}

async function testConnection({ email, app_password, imap_host, imap_port }) {
  const client = new ImapFlow({
    host:   imap_host || 'imap.gmail.com',
    port:   parseInt(imap_port || '993', 10),
    secure: true,
    auth:   { user: email, pass: app_password },
    logger: false,
    tls:    { rejectUnauthorized: true },
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

// ── Email parsing helpers ─────────────────────────────────────────────────────

// Named entities beyond &nbsp;/&amp; that receipt templates plausibly use
// around a currency amount (quotes/apostrophes wrapping a span, escaped
// angle brackets, explicit directional-mark entities). Decoded in addition
// to numeric character references (&#8206; / &#x200e; etc., handled below)
// rather than a hardcoded list of every mark that's ever showed up in one
// sampled receipt — a platform template that changes which invisible
// character it uses shouldn't need another manual entity added here.
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
};

// Converts a receipt's HTML body to plain-enough text for extractAmount's regexes.
// Real Wolt/10bis receipts often put the amount as "ILS&nbsp;<span>73.00</span>"
// (an HTML entity plus an invisible LTR mark before the digits) — a bare tag-strip
// leaves both in place and silently breaks every amount match, so entities and
// directional-mark characters need decoding/stripping here, not just tags.
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    // Zero-width space/joiners (200B-200D), LRM/RLM (200E-200F), directional
    // embedding/override (202A-202E), directional isolates (2066-2069),
    // Arabic letter mark (061C), BOM/zero-width-no-break-space (FEFF) — covers
    // both the literal characters and, after the numeric-entity decode above,
    // any of them that arrived as &#8206;/&#x200e;-style references too.
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[​-‏‪-‮⁦-⁩؜﻿]/g, '')
    .replace(/\s+/g, ' ');
}

function detectPlatform(parsed) {
  const from = (parsed.from?.text || '').toLowerCase();
  const subj = (parsed.subject   || '').toLowerCase();
  if (from.includes('wolt') || subj.includes('wolt'))                                           return 'wolt';
  if (from.includes('10bis') || from.includes('tenbis') || subj.includes('10bis') || subj.includes('תן ביס')) return 'tenbis';
  // 'sibuv'/'mislocha' are this codebase's internal platform-value strings
  // (stored as-is in sales.delivery_platform, kept for backward compat with
  // existing rows) — 'cibus'/'mishloha' are the real sender domains/brand
  // names (Sibus/Cibus, Mishloha) that were missing from FROM-address detection.
  if (from.includes('sibuv') || from.includes('cibus') || subj.includes('סיבוס'))                return 'sibuv';
  if (from.includes('mislocha') || from.includes('mishloha') || subj.includes('משלוחה'))          return 'mislocha';
  return null;
}

function extractAmount(text) {
  if (!text) return null;
  const s = text.replace(/\n/g, ' ');

  // Handles both US (1,234.56) and European (1.234,56) number formats
  function parseNum(raw) {
    const cleaned = raw.replace(/[^\d.,]/g, '');
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot   = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    if (lastDot > lastComma) return parseFloat(cleaned.replace(/,/g, ''));
    return parseFloat(cleaned.replace(/,/g, '.'));
  }

  // Regex captures numbers with optional thousands separators (up to 10 digits)
  const NUM = '([\\d,]{1,10}(?:\\.\\d{1,2})?|[\\d.]{1,10}(?:,\\d{1,2})?)';
  // Try specific net-revenue keywords first, then generic total/amount, then bare ₪ as last resort
  const pats = [
    new RegExp(`(?:net\\s+revenue|restaurant\\s+revenue|restaurant\\s+earnings|your\\s+earnings)[:\\s]+(?:₪\\s*)?${NUM}`, 'i'),
    new RegExp(`(?:total|amount)[:\\s]+(?:₪\\s*)?${NUM}`, 'i'),
    new RegExp(`(?:סה"כ|סכום)[:\\s]+(?:₪\\s*)?${NUM}`),
    new RegExp(`₪\\s*${NUM}`),
    new RegExp(`${NUM}\\s*₪`),
    new RegExp(`NIS\\s*${NUM}`, 'i'),
    new RegExp(`ILS\\s*${NUM}`, 'i'),
  ];
  for (const p of pats) {
    const m = s.match(p);
    if (m) {
      const v = parseNum(m[1]);
      if (v >= 5 && v <= 50000) return v;
    }
  }
  return null;
}

function extractOrderId(text, platform) {
  if (!text) return null;
  const prefix = platform ? platform[0].toUpperCase() : 'D';
  const pats = [
    /order[:\s#]+([A-Z0-9\-]{4,20})/i,
    /הזמנה[:\s#]+([A-Z0-9\-]{4,20})/i,
    /#([A-Z0-9\-]{6,20})/,
    /מזהה[:\s]+([A-Z0-9\-]{4,20})/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) return `${prefix}_${m[1]}`;
  }
  return null;
}

function isDeliveryEmail(parsed, senderFilter) {
  const from = (parsed.from?.text || '').toLowerCase();
  const subj = (parsed.subject   || '').toLowerCase();
  if (senderFilter) {
    const filters = senderFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (filters.length && !filters.some(f => from.includes(f))) return false;
  }
  // detectPlatform() is Hebrew-aware (תן ביס/סיבוס/משלוחה) — checking it first
  // catches Hebrew-subject receipts that would otherwise be silently dropped
  // before detectPlatform ever runs on them (this gate used to run first).
  if (detectPlatform(parsed)) return true;
  const keywords = ['wolt', '10bis', 'tenbis', 'sibuv', 'cibus', 'mislocha', 'mishloha', 'delivery', 'order'];
  return keywords.some(k => from.includes(k) || subj.includes(k));
}

// ── Fetch and import ──────────────────────────────────────────────────────────

async function fetchDeliveries(businessId, config, daysBack = 14) {
  const { email, app_password, imap_host, imap_port, sender_filter } = config;

  const client = new ImapFlow({
    host:   imap_host || 'imap.gmail.com',
    port:   parseInt(imap_port || '993', 10),
    secure: true,
    auth:   { user: email, pass: app_password },
    logger: false,
    tls:    { rejectUnauthorized: true },
  });

  const candidates = [];
  let emailsScanned = 0;
  const errors = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date();
      since.setDate(since.getDate() - daysBack);
      const uids = await client.search({ since }, { uid: true });

      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          try {
            if (!msg?.source) continue;
            const parsed = await simpleParser(msg.source);
            emailsScanned++;

            if (!isDeliveryEmail(parsed, sender_filter)) continue;
            const platform = detectPlatform(parsed);
            if (!platform) continue;

            const bodyText = parsed.text || '';
            const bodyHtml = htmlToText(parsed.html);
            const amount   = extractAmount(bodyText) || extractAmount(bodyHtml);
            if (!amount) continue;

            const soldAt = parsed.date || new Date();
            // Prefer explicit order ID; fall back to deterministic hash so the same email
            // is never inserted twice on subsequent scheduler runs (null extId bypasses dedup)
            const extId = extractOrderId(bodyText, platform)
              || extractOrderId(parsed.subject || '', platform)
              || (() => {
                   const seed = `${platform}|${soldAt.toISOString().slice(0, 16)}|${amount}`;
                   return `${platform[0].toUpperCase()}_AUTO_${crypto.createHash('md5').update(seed).digest('hex').slice(0, 12)}`;
                 })();

            candidates.push({ platform, amount, sold_at: soldAt, external_order_id: extId, notes: `מייל אוטומטי: ${(parsed.subject || '').slice(0, 120)}` });
          } catch (msgErr) { errors.push(`uid ${msg?.uid ?? '?'}: ${msgErr.message}`); }
        }
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (connErr) {
    errors.push(connErr.message);
    logger.error('[DeliveryEmail] connection error', { biz: businessId, err: connErr.message });
    try { await client.logout(); } catch {}
  }

  if (!candidates.length) {
    await _updateLastFetched(businessId, { imported: 0, skipped: 0, emailsScanned, errors });
    return { imported: 0, skipped: 0, emailsScanned, errors };
  }

  const { imported, skipped } = await dedupAndInsertSales(businessId, candidates);

  const result = { imported, skipped, emailsScanned, errors };
  await _updateLastFetched(businessId, result);
  logger.info('[DeliveryEmail]', { biz: businessId, ...result });
  if (imported) eventBus.publish(businessId, 'delivery.imported', { action: 'email_fetch', count: imported });
  return result;
}

// Dedups a batch of { platform, amount, sold_at, external_order_id, notes }
// candidates against sales.external_order_id and inserts the fresh ones.
// Shared by the IMAP fetch path (above) and the Gmail-based fetch path
// (gmail.deliveries.service.js) — the two email sources must not duplicate
// each other's rows if a business somehow has both configured.
async function dedupAndInsertSales(businessId, candidates) {
  const extIds = candidates.map(r => r.external_order_id).filter(Boolean);
  let existingSet = new Set();
  if (extIds.length) {
    const { rows } = await db.query(
      `SELECT external_order_id FROM sales WHERE business_id=$1 AND external_order_id = ANY($2)`,
      [businessId, extIds]
    );
    existingSet = new Set(rows.map(r => r.external_order_id));
  }

  const fresh = candidates.filter(r => !r.external_order_id || !existingSet.has(r.external_order_id));
  // Actual inserted count, not fresh.length — a concurrent scheduler tick /
  // manual fetch can race past this function's own pre-check (both see the
  // row as new) and collide on the DB's unique index; ON CONFLICT DO NOTHING
  // then silently drops the loser's row. Counting rowCount instead of the
  // pre-check length keeps imported/skipped (surfaced to the UI and stored
  // in last_sync_result) accurate even when that race happens.
  let imported = 0;

  if (fresh.length) {
    const CHUNK = 1000;
    for (let start = 0; start < fresh.length; start += CHUNK) {
      const chunk = fresh.slice(start, start + CHUNK);
      const vals = [], params = [];
      chunk.forEach((r, i) => {
        const b = i * 6;
        vals.push(`($${b+1},'delivery',$${b+2},$${b+3},$${b+4},'done',$${b+5},$${b+6})`);
        params.push(businessId, r.platform, r.amount, r.sold_at, r.notes, r.external_order_id);
      });
      const result = await db.query(
        `INSERT INTO sales (business_id, sale_type, delivery_platform, total_amount, sold_at, status, notes, external_order_id) VALUES ${vals.join(',')}
         ON CONFLICT (business_id, external_order_id) WHERE external_order_id IS NOT NULL DO NOTHING`,
        params
      );
      imported += result.rowCount;
    }
  }

  return { imported, skipped: candidates.length - imported };
}

async function _updateLastFetched(businessId, result) {
  await db.query(
    `UPDATE business_delivery_email_configs SET last_fetched_at = NOW(), last_result = $2 WHERE business_id = $1`,
    [businessId, JSON.stringify(result)]
  ).catch(() => {});
}

module.exports = {
  getConfig, getConfigWithPassword, saveConfig, deleteConfig, testConnection, fetchDeliveries,
  detectPlatform, extractAmount, extractOrderId, isDeliveryEmail, dedupAndInsertSales, htmlToText,
};
