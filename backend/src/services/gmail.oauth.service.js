'use strict';

const { google } = require('googleapis');
const crypto     = require('crypto');
const db         = require('../utils/db');
const logger     = require('../utils/logger');

// ── Encryption (same pattern as zreport.emailConfig.service.js) ──────────────
const ALGO = 'aes-256-cbc';

function _key() {
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'fallback-key').digest();
}

function encrypt(text) {
  if (!text) return null;
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  try {
    if (!data) return null;
    const [ivHex, encHex] = data.split(':');
    if (!ivHex || !encHex) return null;
    const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── OAuth2 client factory ─────────────────────────────────────────────────────
function _createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/gmail/callback'
  );
}

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// ── OAuth state signing ───────────────────────────────────────────────────────
// GET /gmail/callback has no session available — it's a top-level browser
// navigation from Google's own domain, and the app's auth cookie is scoped to
// the frontend origin only, never sent to this backend origin. Without a
// signature, the businessId in `state` would be a bare client-suppliable
// value: an attacker could complete Google's consent screen with their OWN
// account, then call the callback directly with a guessed/known victim
// businessId and hijack that business's Gmail connection. Signing state at
// issuance (getAuthUrl, called only from the requireAuth-gated /auth-url
// route) and verifying the signature in the callback proves the businessId
// actually came from an authenticated request for that specific business.
function _stateKey() {
  return crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'fallback-key'}:oauth-state`).digest();
}

function signState(businessId, returnTo) {
  const payload = `${businessId}|${returnTo || ''}`;
  const sig = crypto.createHmac('sha256', _stateKey()).update(payload).digest('hex').slice(0, 32);
  return `${payload}|${sig}`;
}

// Returns { businessId, returnTo } on a valid signature, or null (bad/missing
// signature, malformed state — treat identically to "reject the callback").
function verifyState(rawState) {
  const parts = String(rawState || '').split('|');
  if (parts.length !== 3) return null;
  const [businessId, returnTo, sig] = parts;
  if (!businessId || !sig) return null;
  const expected = crypto.createHmac('sha256', _stateKey()).update(`${businessId}|${returnTo}`).digest('hex').slice(0, 32);
  const given = Buffer.from(sig, 'hex');
  const want  = Buffer.from(expected, 'hex');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return { businessId, returnTo: returnTo || null };
}

// ── Public API ────────────────────────────────────────────────────────────────

function getAuthUrl(state) {
  const client = _createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',   // always request refresh_token
    scope:       SCOPES,
    state:       state || '',
  });
}

async function exchangeCode(code, businessId) {
  const client = _createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Fetch the user's Gmail address
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const googleEmail = profile.data.emailAddress;

  await db.query(`
    INSERT INTO business_google_accounts
      (business_id, google_email, access_token, refresh_token, token_expiry, scopes, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, TRUE)
    ON CONFLICT (business_id) DO UPDATE SET
      google_email  = EXCLUDED.google_email,
      access_token  = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, business_google_accounts.refresh_token),
      token_expiry  = EXCLUDED.token_expiry,
      scopes        = EXCLUDED.scopes,
      is_active     = TRUE,
      import_status = 'idle',
      -- Cleared alongside import_status. Reconnecting reset the status but left
      -- the failure that caused it sitting in import_progress, so every screen
      -- reading that field kept reporting the old fault against brand-new,
      -- working tokens.
      import_progress = NULL,
      updated_at    = NOW()
  `, [
    businessId,
    googleEmail,
    encrypt(tokens.access_token),
    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokens.expiry_date   ? new Date(tokens.expiry_date)   : null,
    SCOPES.join(','),
  ]);

  logger.info('[Gmail OAuth] connected', { businessId, googleEmail });
  return { googleEmail };
}

async function getAuthClient(businessId) {
  const { rows } = await db.query(
    `SELECT access_token, refresh_token, token_expiry, is_active
     FROM business_google_accounts WHERE business_id = $1`,
    [businessId]
  );
  if (!rows.length || !rows[0].is_active) return null;

  const row          = rows[0];
  const accessToken  = decrypt(row.access_token);
  const refreshToken = row.refresh_token ? decrypt(row.refresh_token) : null;
  if (!accessToken && !refreshToken) {
    logger.warn('[Gmail OAuth] tokens unreadable (JWT_SECRET rotated?) — account needs reconnect', { businessId });
    // Mark import_status so the UI shows an error/reconnect prompt
    await db.query(
      `UPDATE business_google_accounts
       SET import_status = 'error',
           import_progress = '{"error":"tokens_unreadable"}',
           updated_at = NOW()
       WHERE business_id = $1`,
      [businessId]
    ).catch(() => {});
    // Return a special marker (not null) so callers know the account EXISTS
    // but its tokens are broken — distinct from "no Gmail account at all".
    return { _tokensBroken: true };
  }

  const client = _createOAuth2Client();
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   row.token_expiry ? new Date(row.token_expiry).getTime() : undefined,
  });

  // Persist auto-refreshed tokens. Google occasionally rotates the refresh_token
  // too (rare but happens on reconnect or policy change) — save it when present
  // so we don't silently keep using a stale one that will eventually be revoked.
  client.on('tokens', async (tokens) => {
    try {
      if (tokens.refresh_token) {
        await db.query(`
          UPDATE business_google_accounts
          SET access_token = $1, refresh_token = $2, token_expiry = $3, updated_at = NOW()
          WHERE business_id = $4
        `, [encrypt(tokens.access_token), encrypt(tokens.refresh_token), tokens.expiry_date ? new Date(tokens.expiry_date) : null, businessId]);
      } else {
        await db.query(`
          UPDATE business_google_accounts
          SET access_token = $1, token_expiry = $2, updated_at = NOW()
          WHERE business_id = $3
        `, [encrypt(tokens.access_token), tokens.expiry_date ? new Date(tokens.expiry_date) : null, businessId]);
      }
    } catch (err) {
      logger.warn('[Gmail OAuth] failed to persist refreshed token', { err: err.message });
    }
  });

  return client;
}

async function revokeAccess(businessId) {
  await db.query(
    `UPDATE business_google_accounts SET is_active = FALSE, updated_at = NOW()
     WHERE business_id = $1`,
    [businessId]
  );
}

async function getStatus(businessId) {
  const { rows } = await db.query(
    `SELECT google_email, is_active, last_sync_at, last_sync_result,
            import_status, import_progress, detected_subjects, confirmed_subjects, created_at,
            refresh_token, access_token
     FROM business_google_accounts WHERE business_id = $1`,
    [businessId]
  );
  if (!rows.length) return { connected: false };
  const r = rows[0];
  const importProgress = r.import_progress;
  // Decided by decrypting the stored token, not by reading a leftover error
  // from the last import. Reconnecting writes fresh tokens but did not clear
  // import_progress, so a successful reconnection kept reporting "token
  // unreadable" forever — the owner reconnects, the screen still says it is
  // broken, and the only thing left to try is reconnecting again.
  const stored = r.refresh_token || r.access_token;
  const tokensBroken = !!r.is_active && !!stored && decrypt(stored) === null;
  return {
    connected:         !!r.is_active,
    googleEmail:       r.google_email,
    lastSyncAt:        r.last_sync_at,
    lastSyncResult:    r.last_sync_result,
    importStatus:      r.import_status,
    importProgress,
    detectedSubjects:  r.detected_subjects,
    confirmedSubjects: r.confirmed_subjects,
    connectedAt:       r.created_at,
    // true when tokens exist but can't be decrypted (JWT_SECRET was rotated)
    tokensBroken,
  };
}

// Records the last SUCCESSFUL scan separately from the last attempt.
//
// This table only ever had last_sync_at/last_sync_result, both overwritten on
// every run, so there was no durable evidence of the pipeline last working. The
// only "last success" anywhere lived on business_email_configs — the IMAP path
// — and for a business on Gmail OAuth it just sat frozen. That stale timestamp
// is what three days of ordinary scans were read from and reported as a
// three-day outage.
//
// Success means the scan COMPLETED, not that it found something: a closed
// business legitimately imports nothing and that is still a healthy scan. Same
// rule as zreport.emailConfig.service.js — the two intake paths must not
// disagree about what "working" means.
async function updateSyncResult(businessId, result) {
  const importedOk    = (result?.imported || 0) > 0;
  const ranCleanly    = !result?._fetchFailed && !(result?.errors?.length);
  const lookedAtFiles = (result?.scanned || 0) > 0 || (result?.noData || 0) > 0;
  const success       = importedOk || (ranCleanly && lookedAtFiles);

  await db.query(`
    UPDATE business_google_accounts
    SET last_sync_at        = NOW(),
        last_sync_result    = $2,
        last_success_at     = CASE WHEN $3 THEN NOW() ELSE last_success_at END,
        last_success_result = CASE WHEN $3 THEN $2::jsonb ELSE last_success_result END,
        updated_at          = NOW()
    WHERE business_id = $1
  `, [businessId, JSON.stringify(result), success]);
}

async function updateImportProgress(businessId, status, progress) {
  await db.query(`
    UPDATE business_google_accounts
    SET import_status = $2, import_progress = $3, updated_at = NOW()
    WHERE business_id = $1
  `, [businessId, status, JSON.stringify(progress)]);
}

module.exports = {
  getAuthUrl, exchangeCode, getAuthClient, revokeAccess,
  getStatus, updateSyncResult, updateImportProgress,
  signState, verifyState,
};
