'use strict';

const express  = require('express');
const router   = express.Router();
const logger   = require('../utils/logger');
const db       = require('../utils/db');
const { requireAuth, requireManager } = require('../middleware/auth');
const gmailOAuth  = require('../services/gmail.oauth.service');
const { fetchZReportsFromGmail, fetchHistoricalFromGmail, detectSubjectPattern, diagnoseGmailFetch } = require('../services/gmail.fetch.service');

// ── One-time table migration ──────────────────────────────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS business_google_accounts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
    google_email       VARCHAR(255),
    access_token       TEXT,
    refresh_token      TEXT,
    token_expiry       TIMESTAMPTZ,
    scopes             TEXT,
    is_active          BOOLEAN DEFAULT TRUE,
    last_sync_at       TIMESTAMPTZ,
    last_sync_result   JSONB,
    import_status      VARCHAR(50) DEFAULT 'idle',
    import_progress    JSONB,
    detected_subjects  JSONB,
    confirmed_subjects JSONB,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`ALTER TABLE business_google_accounts ADD COLUMN IF NOT EXISTS detected_subjects  JSONB`);
db.migrate(`ALTER TABLE business_google_accounts ADD COLUMN IF NOT EXISTS confirmed_subjects JSONB`);
// The last SUCCESSFUL scan, kept apart from the last attempt. Without it there
// was no durable record of the Gmail pipeline ever working: last_sync_result is
// overwritten on every run, so one quiet scan erased the evidence of the import
// before it, and the only "last success" in the schema belonged to the IMAP path
// and sat frozen for a business on Gmail OAuth.
db.migrate(`ALTER TABLE business_google_accounts ADD COLUMN IF NOT EXISTS last_success_at     TIMESTAMPTZ`);
db.migrate(`ALTER TABLE business_google_accounts ADD COLUMN IF NOT EXISTS last_success_result JSONB`);

// ── GET /api/gmail/auth-url ───────────────────────────────────────────────────
// Returns the Google OAuth consent-screen URL.
// Pages allowed to receive the OAuth callback redirect — prevents an
// open-redirect via an arbitrary ?returnTo= value.
const ALLOWED_RETURN_PATHS = ['/zreport', '/deliveries'];

router.get('/auth-url', requireAuth, requireManager, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Gmail OAuth אינו מוגדר בשרת — צור קשר עם התמיכה' });
  }
  try {
    const returnTo = ALLOWED_RETURN_PATHS.includes(req.query.returnTo) ? req.query.returnTo : null;
    const state = gmailOAuth.signState(req.user.businessId, returnTo);
    const url = gmailOAuth.getAuthUrl(state);
    res.json({ url });
  } catch (err) {
    logger.error('[gmail] auth-url', { err: err.message });
    res.status(500).json({ error: 'שגיאה ביצירת קישור ההתחברות' });
  }
});

// ── GET /api/gmail/callback ───────────────────────────────────────────────────
// Google redirects here after user approves (or denies) the permission screen.
// No requireAuth here — the user session isn't present in the redirect.
router.get('/callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;

  // Frontend URL — must point to the web app, not this backend server
  const FRONTEND = process.env.APP_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://app.houseofbusiness.co.il' : 'http://localhost:3002');

  // No session is available on this route (see comment above) — the state's
  // HMAC signature is the only proof the businessId actually came from an
  // authenticated /auth-url call rather than being guessed/crafted by the
  // caller. An invalid/missing signature is treated as a denied request,
  // same as the user cancelling on Google's consent screen.
  const verified = gmailOAuth.verifyState(rawState);
  const businessId = verified?.businessId;
  const redirectBase = verified && ALLOWED_RETURN_PATHS.includes(verified.returnTo) ? verified.returnTo : '/zreport';

  if (error) {
    logger.warn('[gmail] user denied OAuth', { error, businessId });
    return res.redirect(`${FRONTEND}${redirectBase}?gmail_error=${encodeURIComponent('ההרשאה בוטלה')}`);
  }
  if (!code || !verified) {
    logger.warn('[gmail] callback rejected — missing code or invalid state signature');
    return res.redirect(`${FRONTEND}${redirectBase}?gmail_error=${encodeURIComponent('שגיאה בחיבור — נסה שנית')}`);
  }

  try {
    const { googleEmail } = await gmailOAuth.exchangeCode(String(code), String(businessId));

    // Detect subject pattern in background, then wait briefly for result
    // (Z-report-specific onboarding step — fires regardless of which page
    // initiated the connection, since the Gmail account itself is shared.)
    const detected = await detectSubjectPattern(String(businessId)).catch(() => []);
    if (detected.length) {
      await db.query(
        `UPDATE business_google_accounts
         SET detected_subjects = $2, import_status = 'awaiting_confirmation', updated_at = NOW()
         WHERE business_id = $1`,
        [String(businessId), JSON.stringify(detected)]
      );
    } else {
      // No detection — start import immediately with defaults
      fetchHistoricalFromGmail(String(businessId), 24).catch(err => {
        logger.error('[gmail] historical import failed', { businessId, err: err.message });
        gmailOAuth.updateImportProgress(String(businessId), 'error', { error: err.message }).catch(() => {});
      });
    }

    res.redirect(`${FRONTEND}${redirectBase}?gmail_connected=1&email=${encodeURIComponent(googleEmail)}`);
  } catch (err) {
    logger.error('[gmail] callback error', { businessId, err: err.message });
    res.redirect(`${FRONTEND}${redirectBase}?gmail_error=${encodeURIComponent('שגיאה בחיבור — נסה שנית')}`);
  }
});

// ── GET /api/gmail/status ─────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = await gmailOAuth.getStatus(req.user.businessId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gmail/disconnect ────────────────────────────────────────────────
router.post('/disconnect', requireAuth, requireManager, async (req, res) => {
  try {
    await gmailOAuth.revokeAccess(req.user.businessId);
    res.json({ message: 'חשבון Gmail נותק' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gmail/fetch-now ─────────────────────────────────────────────────
// Immediate on-demand fetch. Body: { days?: number } — defaults to 14, max 90.
router.post('/fetch-now', requireAuth, requireManager, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.body?.days) || 14, 1), 90);
    const result = await fetchZReportsFromGmail(req.user.businessId, days);
    if (!result) return res.status(400).json({ error: 'חשבון Gmail לא מחובר' });
    res.json({ ...result, daysBack: days });
  } catch (err) {
    logger.error('[gmail] fetch-now', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gmail/reset-subjects ───────────────────────────────────────────
// Clears confirmed_subjects so the next scan uses the built-in defaults.
// Useful when confirmed subjects no longer match the POS email subject line.
router.post('/reset-subjects', requireAuth, requireManager, async (req, res) => {
  try {
    await db.query(
      `UPDATE business_google_accounts
       SET confirmed_subjects = NULL, import_status = 'idle', updated_at = NOW()
       WHERE business_id = $1`,
      [req.user.businessId]
    );
    res.json({ message: 'נושאי החיפוש אופסו — הסריקה הבאה תשתמש בברירת המחדל' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/gmail/diagnose ───────────────────────────────────────────────────
// Returns what search query will be used and how many emails match it.
// Lets the owner verify the Gmail connection is reaching the right emails.
router.get('/diagnose', requireAuth, requireManager, async (req, res) => {
  try {
    const result = await diagnoseGmailFetch(req.user.businessId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gmail/confirm-subjects ─────────────────────────────────────────
// User confirms (or edits) the detected subjects, then starts historical import.
router.post('/confirm-subjects', requireAuth, requireManager, async (req, res) => {
  const { subjects } = req.body; // string[]
  if (!Array.isArray(subjects) || !subjects.length) {
    return res.status(400).json({ error: 'יש לשלוח לפחות נושא אחד' });
  }
  try {
    await db.query(
      `UPDATE business_google_accounts
       SET confirmed_subjects = $2,
           import_status = 'running',
           import_progress = '{"phase":"searching","found":0,"processed":0,"imported":0}',
           updated_at = NOW()
       WHERE business_id = $1`,
      [req.user.businessId, JSON.stringify(subjects)]
    );
    res.json({ message: 'נושאים אושרו — מתחיל ייבוא היסטוריה' });
    // Start historical import after response
    setImmediate(() => {
      fetchHistoricalFromGmail(req.user.businessId, 24).catch(err => {
        logger.error('[gmail] historical import failed', { err: err.message });
        gmailOAuth.updateImportProgress(req.user.businessId, 'error', { error: err.message }).catch(() => {});
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/gmail/import-history ───────────────────────────────────────────
// Kicks off (or re-runs) the historical import asynchronously.
router.post('/import-history', requireAuth, requireManager, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.body?.months) || 12, 24);
    res.json({ message: `ייבוא ${months} חודשים החל ברקע`, months });
    // Run after response is sent
    setImmediate(() => {
      fetchHistoricalFromGmail(req.user.businessId, months).catch(err => {
        logger.error('[gmail] import-history', { err: err.message });
        gmailOAuth.updateImportProgress(req.user.businessId, 'error', { error: err.message }).catch(() => {});
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
