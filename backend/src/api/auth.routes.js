const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const authService = require('../services/auth.service');
const { requireAuth, issueSseToken, issueImageToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const userModel = require('../models/user.model');
const bcrypt = require('bcryptjs');
const db     = require('../utils/db');
const logger  = require('../utils/logger');
const cache  = require('../utils/cache');

// 20 attempts per 15 minutes — brute-force protection for login/register only
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'יותר מדי ניסיונות כניסה, נסה שנית בעוד 15 דקות' },
});

// 6 TOTP attempts per 5 minutes — prevents TOTP brute-force independently of the broader login bucket
const totpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => !req.body?.totpCode,
  message: { error: 'יותר מדי ניסיונות אימות TOTP, נסה שנית בעוד 5 דקות' },
});

// 5 attempts per 15 minutes per IP — prevents TOTP secret enumeration
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'יותר מדי ניסיונות, נסה שוב עוד 15 דקות' },
});

// 5 attempts per email per 15 minutes — prevents OTP brute-force on password reset
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.body?.email || req.ip).toLowerCase(),
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  message: { error: 'יותר מדי ניסיונות איפוס סיסמה, נסה שנית בעוד 15 דקות' },
});

// POST /api/auth/register — disabled: new businesses are created by admin only
router.post('/register', (req, res) => {
  res.status(403).json({ error: 'הרישום העצמי סגור — צור קשר עם המנהל' });
});

// ── Shared 2FA check ──────────────────────────────────────────
// Called after password succeeds. Returns a response object if the request
// should be terminated (requires2FA / bad TOTP / DB error) or null to continue.
// Also increments failed_login_count on a wrong TOTP so the DB-level lockout
// still accumulates even after the per-password reset.
async function _check2FA(userId, totpCode, res) {
  const { rows } = await db.query(
    'SELECT totp_enabled, totp_secret FROM users WHERE id = $1', [userId]
  );
  const u2fa = rows[0];
  if (!u2fa?.totp_enabled) return null; // 2FA not configured — proceed
  if (!u2fa.totp_secret) {
    return res.status(503).json({ error: '2FA לא הוגדר כראוי — פנה לתמיכה' });
  }
  if (!totpCode) return res.json({ requires2FA: true });
  const valid = speakeasy.totp.verify({
    secret: u2fa.totp_secret, encoding: 'base32', token: totpCode, window: 1,
  });
  if (!valid) {
    // Re-increment the counter — loginOwner/loginEmployee reset it on correct password,
    // but a wrong TOTP is still a failed attempt toward the lockout threshold.
    await db.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN NOW() + INTERVAL '1 hour' ELSE locked_until END
       WHERE id = $1`, [userId]
    ).catch(() => {});
    return res.status(401).json({ error: 'קוד אימות שגוי' });
  }
  return null; // 2FA passed
}

// ── helper: build consistent auth response ────────────────────
async function _buildAuthResponse(db, result) {
  const { rows: bizRows }  = await db.query(
    'SELECT id, name, business_type, onboarding_completed, suspended_at, suspended_reason FROM businesses WHERE id = $1', [result.businessId]
  );
  const { rows: userRows } = await db.query(
    'SELECT id, full_name, email, role FROM users WHERE id = $1', [result.userId]
  );
  if (!userRows[0]) throw Object.assign(new Error('User not found after auth'), { status: 500 });
  return {
    token:    result.token,
    user:     { userId: userRows[0].id, fullName: userRows[0].full_name, email: userRows[0].email, role: userRows[0].role },
    business: bizRows[0] ? {
      id: bizRows[0].id, name: bizRows[0].name, type: bizRows[0].business_type,
      onboarding_completed: bizRows[0].onboarding_completed,
      is_suspended: !!bizRows[0].suspended_at, suspended_reason: bizRows[0].suspended_reason,
    } : null,
  };
}

// POST /api/auth/login/owner  (מנהל/שותף/מנהל — שם משתמש + סיסמה)
router.post('/login/owner', loginLimiter, totpLimiter, validate({ body: schemas.loginOwnerSchema }), async (req, res, next) => {
  try {
    const { username, password, totpCode } = req.body;
    const result = await authService.loginOwner({ username, password });
    if (await _check2FA(result.userId, totpCode, res)) return;
    res.json(await _buildAuthResponse(db, result));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login/employee  (עובד — שם משתמש + סיסמה)
router.post('/login/employee', loginLimiter, totpLimiter, validate({ body: schemas.loginEmployeeSchema }), async (req, res, next) => {
  try {
    const { username, password, totpCode } = req.body;
    const result = await authService.loginEmployee({ username, password });
    if (await _check2FA(result.userId, totpCode, res)) return;
    res.json(await _buildAuthResponse(db, result));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', resetLimiter, validate({ body: schemas.forgotPasswordSchema }), async (req, res, next) => {
  try {
    const { email } = req.body;
    const result = await authService.forgotPassword({ email });
    if (result && result.emailSent === false) {
      return res.status(503).json({ error: 'שירות האימייל אינו זמין כרגע. פנה לתמיכה.' });
    }
    res.json({ message: 'אם המייל קיים במערכת — נשלח קוד לאיפוס סיסמה' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', resetLimiter, validate({ body: schemas.resetPasswordSchema }), async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;
    await authService.resetPassword({ email, code, newPassword });
    res.json({ message: 'הסיסמה עודכנה בהצלחה' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — פרטי המשתמש הנוכחי
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const data = await authService.getMe(req.user.userId);
    if (!data) return res.status(404).json({ error: 'משתמש לא נמצא' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/auth/login — alias לבעלים/שותפים/מנהלים
router.post('/login', loginLimiter, totpLimiter, validate({ body: schemas.loginOwnerSchema }), async (req, res, next) => {
  try {
    const { password, totpCode } = req.body;
    const username = req.body.username?.trim().toLowerCase();
    if (!username || !password) return res.status(400).json({ error: 'שדות חסרים' });
    const result = await authService.loginOwner({ username, password });
    if (await _check2FA(result.userId, totpCode, res)) return;
    res.json(await _buildAuthResponse(db, result));
  } catch (err) { next(err); }
});

// PUT /api/auth/me — עדכון פרטי המשתמש (כולל שם משתמש להתחברות)
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const { fullName, email, phone, username } = req.body;

    // Block email changes until email verification is implemented.
    // Allowing unverified changes would let an attacker who briefly controls
    // a session permanently hijack account recovery by substituting their address.
    if (email) {
      const { rows: currentRows } = await db.query(
        'SELECT email FROM users WHERE id = $1', [req.user.userId]
      );
      const currentUser = currentRows[0];
      if (currentUser && email !== currentUser.email) {
        // TODO: Send verification email to new address before applying the change
        return res.status(403).json({ error: 'שינוי כתובת מייל דורש אימות — אנא פנה לתמיכה' });
      }
    }

    const fields = {};
    if (fullName) fields.full_name = fullName;
    if (email)    fields.email     = email;
    if (phone)    fields.phone     = phone;

    if (username) {
      const clean = username.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,50}$/.test(clean)) {
        return res.status(400).json({ error: 'שם משתמש: 3-50 תווים, אותיות/מספרים באנגלית בלבד' });
      }
      const { rows: dupe } = await db.query(
        'SELECT id FROM users WHERE LOWER(username) = $1 AND id != $2',
        [clean, req.user.userId]
      );
      if (dupe[0]) return res.status(409).json({ error: 'שם המשתמש כבר תפוס — בחר שם אחר' });
      fields.username = clean;
    }

    if (!Object.keys(fields).length) return res.status(400).json({ error: 'אין שדות לעדכון' });
    try {
      await userModel.update(req.user.userId, req.user.businessId, fields);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'שם המשתמש כבר תפוס — בחר שם אחר' });
      throw err;
    }
    res.json({ message: 'הפרופיל עודכן' });
  } catch (err) { next(err); }
});

// PUT /api/auth/change-password — שינוי סיסמה
router.put('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'שדות חסרים' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'סיסמה קצרה מדי — נדרשים לפחות 8 תווים' });

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'משתמש לא נמצא' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
      [hash, req.user.userId]
    );
    // Bust the cached status so requireAuth immediately sees the new password_changed_at
    // and revokes any other active sessions within the same 60 s cache window.
    cache.del('auth:status:' + req.user.userId).catch(() => {});
    res.json({ message: 'הסיסמה שונתה' });
  } catch (err) { next(err); }
});

// POST /api/auth/refresh-token — exchange a valid JWT for a fresh one (extends session)
router.post('/refresh-token', requireAuth, (req, res) => {
  const { sign } = require('../utils/jwt');
  const { userId, businessId, role, permissions } = req.user;
  const token = sign({ userId, businessId, role, permissions });
  res.json({ token });
});

// POST /api/auth/sse-token — exchange JWT for a short-lived SSE token (keeps JWT out of access logs)
router.post('/sse-token', requireAuth, async (req, res) => {
  const token = await issueSseToken(req.user);
  res.json({ token });
});

// POST /api/auth/img-token — short-lived token for <img>/<a> tags pointing at
// /uploads/:filename (plain image/link elements cannot send Authorization headers)
router.post('/img-token', requireAuth, async (req, res) => {
  const token = await issueImageToken(req.user);
  res.json({ token });
});

// ── 2FA ────────────���─────────────────────────────────────────
// POST /api/auth/2fa/setup — יוצר secret חדש ומחזיר QR code
router.post('/2fa/setup', requireAuth, setupLimiter, async (req, res, next) => {
  try {

    const { rows } = await db.query('SELECT email, totp_enabled FROM users WHERE id = $1', [req.user.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'משתמש לא נמצא' });
    if (rows[0].totp_enabled) return res.status(400).json({ error: 'אימות דו-שלבי כבר מופעל' });

    const secret = speakeasy.generateSecret({
      name: `House of Business (${rows[0].email})`,
      issuer: 'House of Business',
      length: 20,
    });

    // שמור את ה-secret זמנית (לא מופעל עדיין — יופעל רק לאחר אימות)
    await db.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret.base32, req.user.userId]);

    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qrCode: qrDataUrl });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/enable — מאמת קוד ומפעיל 2FA
router.post('/2fa/enable', requireAuth, setupLimiter, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'קוד חסר' });

    const { rows } = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.userId]);
    if (!rows[0]?.totp_secret) return res.status(400).json({ error: 'לא הוגדר secret — הפעל תחילה /2fa/setup' });
    if (rows[0].totp_enabled) return res.status(400).json({ error: 'אימות דו-שלבי כבר מופעל' });

    const valid = speakeasy.totp.verify({
      secret: rows[0].totp_secret, encoding: 'base32', token: code, window: 1,
    });
    if (!valid) return res.status(400).json({ error: 'קוד שגוי' });

    await db.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [req.user.userId]);
    res.json({ message: 'אימות דו-שלבי הופעל בהצלחה' });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/disable — מכבה 2FA (דורש קוד)
router.post('/2fa/disable', requireAuth, setupLimiter, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'קוד חסר' });

    const { rows } = await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.userId]);
    if (!rows[0]?.totp_enabled) return res.status(400).json({ error: 'אימות דו-שלבי אינו מופעל' });
    if (!rows[0].totp_secret) return res.status(503).json({ error: '2FA לא הוגדר כראוי — פנה לתמיכה' });

    const valid = speakeasy.totp.verify({
      secret: rows[0].totp_secret, encoding: 'base32', token: code, window: 1,
    });
    if (!valid) return res.status(400).json({ error: 'קוד שגוי' });

    await db.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [req.user.userId]);
    res.json({ message: 'אימות דו-שלבי כובה' });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/status — האם 2FA מופעל
router.get('/2fa/status', requireAuth, async (req, res, next) => {
  try {

    const { rows } = await db.query('SELECT totp_enabled FROM users WHERE id = $1', [req.user.userId]);
    res.json({ enabled: rows[0]?.totp_enabled ?? false });
  } catch (err) { next(err); }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  // Cancel any in-progress Gmail import for this business
  db.query(
    `UPDATE business_google_accounts
     SET import_status = 'idle', import_progress = NULL, updated_at = NOW()
     WHERE business_id = $1 AND import_status = 'running'`,
    [req.user.businessId]
  ).catch(() => {});
  res.json({ message: 'logged out' });
});

// GET /api/auth/join?token= — אימות token הזמנה
router.get('/join', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token חסר' });

    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, b.name AS business_name
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.invite_token = $1
          AND u.invite_expires_at > NOW()
          AND u.pending_invite = TRUE`,
      [token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'קישור לא תקף או פג תוקף' });
    res.json({ userId: rows[0].id, fullName: rows[0].full_name, email: rows[0].email, businessName: rows[0].business_name });
  } catch (err) { next(err); }
});

// POST /api/auth/join — השלמת הרשמת עובד
router.post('/join', loginLimiter, async (req, res, next) => {
  try {
    const { token, password, username } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'שדות חסרים' });
    if (password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להכיל לפחות 8 תווים' });
    if (username && !/^[a-z0-9._-]{3,50}$/.test(username.trim().toLowerCase())) {
      return res.status(400).json({ error: 'שם משתמש לא תקין — אותיות לטיניות קטנות, מספרים, נקודה, מקף (3–50 תווים)' });
    }

    const { rows } = await db.query(
      `SELECT id, business_id, role FROM users
        WHERE invite_token = $1 AND invite_expires_at > NOW() AND pending_invite = TRUE`,
      [token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'קישור לא תקף או פג תוקף' });
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      `UPDATE users
         SET password_hash = $1, pending_invite = FALSE,
             invite_token = NULL, invite_expires_at = NULL,
             username = COALESCE($2, username), is_active = TRUE
       WHERE id = $3`,
      [hash, username?.trim() || null, rows[0].id]
    );
    // התחבר אוטומטית
    const result = await authService.loginByUserId(rows[0].id);
    res.json(await _buildAuthResponse(db, result));
  } catch (err) { next(err); }
});

module.exports = router;
