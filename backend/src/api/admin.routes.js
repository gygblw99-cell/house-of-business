const express   = require('express');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const { sign }  = require('../utils/jwt');
const db        = require('../utils/db');
const logger    = require('../utils/logger');
const { parseIntRange } = require('../utils/parseQuery');
const { requireAdmin, requireSuperAdmin } = require('../middleware/requireAdmin');
const cache     = require('../utils/cache');
const eventBus  = require('../utils/eventBus');
const { sendBusinessWelcome, sendEmail } = require('../services/notifications/email.service');
const { isCycleOverdue, israelToday } = require('../services/billing/billingCycle');
const { checkFreeTierHealth } = require('../services/ai/freeTierHealth.service');

const router = express.Router();

// Parse JWT_EXPIRES_IN (e.g. '7d', '1h', '30m', '2w', '1y') into milliseconds for the cookie maxAge.
// Keeps the cookie lifetime in sync with the JWT lifetime so the two never diverge.
// Handles all suffixes accepted by jsonwebtoken: s m h d w y.
function _jwtExpiryMs() {
  const exp = process.env.JWT_EXPIRES_IN || '7d';
  const m = /^(\d+)([smhdwy])$/.exec(exp);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 }[m[2]];
}
const ADMIN_COOKIE_MAX_AGE = _jwtExpiryMs();

// Single normalizer for any user-supplied identifier (email / username).
//
// A rate limiter and the route it guards MUST derive their key from the exact
// same string. resetLimiter used to key on `req.body.email.toLowerCase()` while
// the route looked the admin up by `.toLowerCase().trim()` — so "admin@x.com "
// (one trailing space) got a *fresh* 5-attempt bucket while still resolving to
// the same admin row. That made the limit on the 6-digit reset code bypassable
// by padding, which is the only thing between a guessed code and an admin
// takeover. Non-strings normalize to '' so a JSON body like {"email": 123}
// can't throw inside the key generator either.
function normalizeIdentifier(v) {
  return typeof v === 'string' ? v.toLowerCase().trim() : '';
}

// מגביל ניסיונות התחברות — מקסימום 10 ב-15 דקות לכל IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות כניסה, נסה שוב עוד 15 דקות' },
});

// 5 ניסיונות לאימייל ב-15 דקות — מונע ברוטפורס על קוד האיפוס
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  // Must match the route's own lookup normalization exactly — see normalizeIdentifier.
  keyGenerator: (req) => normalizeIdentifier(req.body?.email) || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  message: { error: 'יותר מדי ניסיונות איפוס סיסמה, נסה שנית בעוד 15 דקות' },
});

// מגביל פעולות ניהוליות — מקסימום 30 ב-דקה לכל IP
const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'יותר מדי פעולות ניהוליות' },
});

// ג”€ג”€ Contract term helpers ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// The term the owner signed on: a free-form label normalized to a month count.
const CONTRACT_MONTHS = { trial: 1, year: 12 };

// Returns { type, months } on success (both null when nothing supplied ג€” the
// term is optional), or { error } on invalid input. 'custom' requires an
// explicit month count in 1..120.
function normalizeContract(type, months) {
  if (type === undefined || type === null || type === '') return { type: null, months: null };
  if (type === 'trial' || type === 'year') return { type, months: CONTRACT_MONTHS[type] };
  if (type === 'custom') {
    const n = parseInt(months, 10);
    if (!Number.isInteger(n) || n < 1 || n > 120) {
      return { error: 'מספר חודשים לא תקין (1–120)' };
    }
    return { type: 'custom', months: n };
  }
  return { error: 'סוג התקשרות לא תקין' };
}

// Parse a 'YYYY-MM-DD' calendar-date string into { y, m, d } (m is 1-based).
// The schedule query returns dates as ::text precisely so we never route a
// calendar date through a JS Date (which anchors it to local midnight and can
// shift the day across the UTC boundary ג€” an off-by-one on the billing day).
function parseDateStr(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

// Given a billing_day (1-28) and the LAST payment date as 'YYYY-MM-DD',
// returns the next due date as UTC-midnight Date: billing_day in the month
// after the last payment, clamped to the month's length.
// When lastPaymentStr is null (no payments yet), the next due is billing_day
// in the same month as billing_start_date (the first billing month).
function nextDueDate(billingDay, lastPaymentStr, billingStartStr) {
  let year, month;
  if (lastPaymentStr) {
    const last = parseDateStr(lastPaymentStr);
    year  = last.y;
    month = last.m; // 0-based of month AFTER last (last.m is 1-based)
    if (month > 11) { month = 0; year += 1; }
  } else if (billingStartStr) {
    const start = parseDateStr(billingStartStr);
    year  = start.y;
    month = start.m - 1; // 0-based of billing_start month
    // Mirror monthsDue: when billing_day already passed in the start month
    // (start.d > billingDay), the first due date is in the NEXT month.
    if (start.d > billingDay) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
  } else {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(billingDay, daysInMonth);
  return new Date(Date.UTC(year, month, day));
}

// How many billing cycles have passed (and are due) from billing_start_date
// through today, given billing_day. Returns 0 when billing hasn't started yet.
//
// First due date = first occurrence of billing_day ON OR AFTER billing_start_date.
// When billing_start_date day > billing_day (e.g. start=Aug-20, billing_day=5),
// billing_day already passed in the start month before the agreement began, so
// the first real charge is billing_day of the NEXT month (Sep-5). Counting from
// the start month instead would inflate mDue by 1 and trigger a phantom debt.
function monthsDue(billingDay, billingStartStr, todayTs) {
  if (!billingStartStr) return 0;
  const start = parseDateStr(billingStartStr);

  // Compute first due date
  let firstDueY = start.y;
  let firstDueM = start.m; // 1-based
  if (start.d > billingDay) {
    // billing_day already passed in the start month ג€” first charge is next month
    firstDueM += 1;
    if (firstDueM > 12) { firstDueM = 1; firstDueY += 1; }
  }
  const daysInFirstDueMonth = new Date(Date.UTC(firstDueY, firstDueM, 0)).getUTCDate();
  const firstDueTs = Date.UTC(firstDueY, firstDueM - 1, Math.min(billingDay, daysInFirstDueMonth));
  if (firstDueTs > todayTs) return 0;

  const todayDate = new Date(todayTs);
  const ty = todayDate.getUTCFullYear();
  const tm = todayDate.getUTCMonth() + 1; // 1-based
  const td = todayDate.getUTCDate();

  const monthsFromFirstDue = (ty - firstDueY) * 12 + (tm - firstDueM);
  const billingDayPassed = td >= billingDay;
  return monthsFromFirstDue + (billingDayPassed ? 1 : 0);
}

// Timing-equalising hash for the "no such admin" path.
//
// This was previously the literal '$2b$10$dummyhashvaluethatisnotreal000000000000000',
// which is 49 characters ג€” a bcrypt hash is 60. bcryptjs rejects a malformed
// hash and returns false immediately, so the compare cost 0.0ms instead of the
// ~75ms a real one takes (measured). The timing oracle the line was written to
// close was therefore wide open: a known admin email answered in ~75ms and an
// unknown one in ~0ms, which is enough to enumerate admin accounts.
//
// Generated at startup at the SAME cost factor used for real admin passwords
// (12, see the bcrypt.hash calls below), so the dummy compare and a genuine
// compare take the same time even if that factor is ever changed.
const ADMIN_BCRYPT_ROUNDS = 12;
// Generated async so module load doesn't block the event loop for ~300ms.
// Resolves before the first login request could ever hit the dummy path.
// .catch() logs and resolves to null ג€” callers skip the compare on null,
// which slightly breaks timing but avoids a 500 on an extremely rare bcrypt failure.
const DUMMY_PASSWORD_HASH_PROMISE = bcrypt.hash(
  crypto.randomBytes(24).toString('hex'),
  ADMIN_BCRYPT_ROUNDS
).catch(err => {
  logger.error('[Admin] Failed to generate dummy password hash ג€” timing oracle may open briefly', { err: err?.message });
  return null;
});

// Exponential backoff per email ג€” prevents distributed brute-force on one account
// { email ג†’ { count, unlockAt } }
const failedLoginAttempts = new Map();

function getLockoutMs(failCount) {
  if (failCount < 3)  return 0;
  if (failCount < 5)  return 30_000;       // 30s
  if (failCount < 7)  return 5 * 60_000;   // 5min
  if (failCount < 10) return 30 * 60_000;  // 30min
  return 24 * 60 * 60_000;                 // 24h
}

function recordFailedLogin(email) {
  // Hard cap ג€” prevents unbounded growth during email-enumeration DDoS
  if (failedLoginAttempts.size >= 20_000) failedLoginAttempts.clear();
  const entry = failedLoginAttempts.get(email) || { count: 0, unlockAt: 0 };
  entry.count += 1;
  entry.unlockAt = Date.now() + getLockoutMs(entry.count);
  failedLoginAttempts.set(email, entry);
}

function clearFailedLogin(email) {
  failedLoginAttempts.delete(email);
}

function getLockedUntil(email) {
  const entry = failedLoginAttempts.get(email);
  if (!entry || Date.now() >= entry.unlockAt) return null;
  return entry.unlockAt;
}

// Purge stale lockout entries every hour so Map doesn't grow indefinitely
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of failedLoginAttempts) {
    if (now >= entry.unlockAt + 24 * 60 * 60_000) failedLoginAttempts.delete(email);
  }
}, 60 * 60_000).unref(); // .unref() so this doesn't keep the process alive

// ג”€ג”€ POST /api/admin/auth/login ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });

    // Rejects non-strings and whitespace-only input, which would otherwise
    // normalize to '' and fall through to a pointless DB lookup.
    const normalizedUsername = normalizeIdentifier(username);
    if (!normalizedUsername) return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });

    // Check exponential backoff lockout before hitting the DB
    const lockedUntil = getLockedUntil(normalizedUsername);
    if (lockedUntil) {
      const secsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
      logger.warn('[Admin] login blocked by backoff', { username: normalizedUsername, secsLeft });
      return res.status(429).json({
        error: `חשבון נעול זמנית. נסה שוב בעוד ${secsLeft < 60 ? secsLeft + ' שניות' : Math.ceil(secsLeft / 60) + ' דקות'}`,
      });
    }

    const { rows } = await db.query(
      'SELECT id, email, username, full_name, role, password_hash, is_active, last_login FROM admin_users WHERE username = $1 AND is_active = TRUE',
      [normalizedUsername]
    );
    const admin = rows[0];
    if (!admin) {
      // Run dummy bcrypt to prevent timing oracle (same duration as a real compare)
      const dummyHash = await DUMMY_PASSWORD_HASH_PROMISE;
      if (dummyHash) await bcrypt.compare(password, dummyHash);
      recordFailedLogin(normalizedUsername);
      return res.status(401).json({ error: 'פרטים לא נכונים' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      recordFailedLogin(normalizedUsername);
      return res.status(401).json({ error: 'פרטים לא נכונים' });
    }

    clearFailedLogin(normalizedUsername);

    // Update last login
    await db.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [admin.id]);

    const token = sign({
      adminId:   admin.id,
      email:     admin.email,
      role:      admin.role,
      isAdmin:   true,
      full_name: admin.full_name || null,
    });

    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: ADMIN_COOKIE_MAX_AGE,
      path: '/',
    });

    res.json({
      ok: true,
      admin: {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
      },
    });
  } catch (err) {
    logger.error('[Admin] login error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/auth/forgot-password ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/auth/forgot-password', resetLimiter, async (req, res) => {
  try {
    const email = normalizeIdentifier(req.body?.email);
    if (!email) return res.status(400).json({ error: 'אימייל חסר' });

    const { rows } = await db.query(
      'SELECT id, full_name FROM admin_users WHERE email = $1 AND is_active = TRUE',
      [email]
    );
    // Never reveal whether the email exists (security)
    if (!rows[0]) return res.json({ message: 'אם המייל קיים במערכת — נשלח קוד לאיפוס סיסמה' });

    const code = crypto.randomInt(100000, 1000000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 דקות

    await db.query(
      'UPDATE admin_users SET reset_code = $1, reset_expires_at = $2 WHERE id = $3',
      [code, expires, rows[0].id]
    );

    try {
      await sendEmail({
        to: email,
        subject: 'House of Business Admin — קוד איפוס סיסמה',
        html: `
          <div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#c9a227">איפוס סיסמת אדמין</h2>
            <p>שלום ${rows[0].full_name || ''},</p>
            <p>קוד האימות שלך:</p>
            <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1e293b;
                        background:#f1f5f9;padding:16px;border-radius:8px;text-align:center">
              ${code}
            </div>
            <p style="color:#64748b;font-size:13px">הקוד תקף ל-10 דקות בלבד.</p>
            <p style="color:#64748b;font-size:13px">אם לא ביקשת איפוס — התעלם ממייל זה.</p>
          </div>`,
      });
    } catch (e) {
      logger.error('[Admin] forgot-password email failed', { adminId: rows[0].id, err: e.message });
      await db.query('UPDATE admin_users SET reset_code = NULL, reset_expires_at = NULL WHERE id = $1', [rows[0].id]);
      return res.status(503).json({ error: 'שירות האימייל אינו זמין כרגע' });
    }

    res.json({ message: 'אם המייל קיים במערכת — נשלח קוד לאיפוס סיסמה' });
  } catch (err) {
    logger.error('[Admin] forgot-password error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/auth/reset-password ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/auth/reset-password', resetLimiter, async (req, res) => {
  try {
    const email = normalizeIdentifier(req.body?.email);
    const { code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'חסרים פרטים' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות לפחות 8 תווים' });

    const { rows } = await db.query(
      'SELECT id, reset_code, reset_expires_at FROM admin_users WHERE email = $1 AND is_active = TRUE',
      [email]
    );
    const admin = rows[0];
    if (!admin || !admin.reset_code || admin.reset_code !== code) {
      return res.status(400).json({ error: 'קוד שגוי' });
    }
    if (new Date(admin.reset_expires_at) < new Date()) {
      return res.status(400).json({ error: 'הקוד פג תוקף' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      // password_changed_at is what makes this reset actually revoke sessions ג€”
      // requireAdmin rejects any admin token issued before this moment. Without
      // it, an admin resetting a compromised password left the attacker's
      // existing token valid for the rest of its 7-day lifetime.
      `UPDATE admin_users
          SET password_hash = $1, reset_code = NULL, reset_expires_at = NULL,
              password_changed_at = NOW()
        WHERE id = $2`,
      [passwordHash, admin.id]
    );

    logger.info('[Admin] password reset via forgot-password flow', { adminId: admin.id });
    res.json({ message: 'הסיסמה עודכנה בהצלחה' });
  } catch (err) {
    logger.error('[Admin] reset-password error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/auth/logout ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/auth/logout', (req, res) => {
  res.clearCookie('admin_token', { path: '/' });
  res.json({ ok: true });
});

// ג”€ג”€ GET /api/admin/auth/me ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// requireAdmin already verified the account is active (SELECT id); full_name is in JWT.
// No second DB roundtrip needed ג€” if admin name changes, re-login picks up the new value.
router.get('/auth/me', requireAdmin, (req, res) => {
  res.json({
    adminId:   req.admin.adminId,
    email:     req.admin.email,
    role:      req.admin.role,
    full_name: req.admin.full_name || null,
  });
});

// ג”€ג”€ GET /api/admin/stats ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const data = await cache.wrap('admin:stats', async () => {
    const [
      businessCount,
      userCount,
      aiUsage,
      activeBiz,
      topBiz,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM businesses'),
      db.query('SELECT COUNT(*) AS count FROM users'),
      db.query(`
        SELECT
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS total_cost
        FROM ai_usage_logs
        WHERE created_at >= date_trunc('month', NOW())
      `),
      db.query(`
        SELECT COUNT(DISTINCT business_id) AS count
        FROM sales
        WHERE sold_at >= NOW() - INTERVAL '30 days'
      `).catch(() => ({ rows: [{ count: 0 }] })),
      db.query(`
        SELECT
          b.id,
          b.name,
          COALESCE(s.total_revenue, 0)  AS total_revenue,
          COALESCE(ai.ai_tokens, 0)     AS ai_tokens
        FROM businesses b
        LEFT JOIN (
          SELECT business_id, COALESCE(SUM(total_amount), 0) AS total_revenue
          FROM sales
          WHERE sold_at >= NOW() - INTERVAL '30 days'
            AND (
              pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%'
              OR NOT EXISTS (
                SELECT 1 FROM sales s2
                WHERE s2.business_id = sales.business_id
                  AND (s2.pos_sale_id IS NULL OR s2.pos_sale_id NOT LIKE 'Z-%')
                  AND DATE(s2.sold_at AT TIME ZONE 'Asia/Jerusalem') = DATE(sales.sold_at AT TIME ZONE 'Asia/Jerusalem')
              )
            )
          GROUP BY business_id
        ) s ON s.business_id = b.id
        LEFT JOIN (
          SELECT business_id, SUM(total_tokens) AS ai_tokens
          FROM ai_usage_logs WHERE created_at >= date_trunc('month', NOW())
          GROUP BY business_id
        ) ai ON ai.business_id = b.id
        ORDER BY total_revenue DESC NULLS LAST
        LIMIT 5
      `).catch(() =>
        db.query(`
          SELECT b.id, b.name, 0 AS total_revenue, 0 AS ai_tokens
          FROM businesses b
          LIMIT 5
        `)
      ),
    ]);

    // Compute health scores for top businesses — שאילתה אחת לכולם
    const topRows = topBiz.rows || [];
    const topIds  = topRows.map(b => b.id);
    let topWithHealth = topRows;

    if (topIds.length > 0) {
      const [scBatch, ucBatch] = await Promise.all([
        db.query(`
          SELECT business_id,
                 COUNT(*) FILTER (WHERE pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS sales_count,
                 COALESCE(SUM(total_amount),0) AS revenue
          FROM sales
          WHERE business_id = ANY($1)
            AND sold_at >= NOW() - INTERVAL '30 days'
          GROUP BY business_id
        `, [topIds]).catch(() => ({ rows: [] })),
        db.query(`
          SELECT business_id, COUNT(*) AS user_count
          FROM users WHERE business_id = ANY($1)
          GROUP BY business_id
        `, [topIds]).catch(() => ({ rows: [] })),
      ]);
      const scMap = Object.fromEntries(scBatch.rows.map(r => [r.business_id, r]));
      const ucMap = Object.fromEntries(ucBatch.rows.map(r => [r.business_id, parseInt(r.user_count) || 0]));

      topWithHealth = topRows.map(biz => {
        const revenue     = parseFloat(scMap[biz.id]?.revenue    || 0);
        const sales_count = parseInt(scMap[biz.id]?.sales_count  || 0);
        const user_count  = ucMap[biz.id] || 0;
        const revenue_score  = Math.min(1, revenue / 50000);
        const activity_score = Math.min(1, sales_count / 200);
        const user_score     = Math.min(1, user_count / 10);
        const health_score   = Math.min(100, Math.round(revenue_score * 40 + activity_score * 40 + user_score * 20));
        // Postgres NUMERIC/BIGINT aggregates (total_revenue, ai_tokens) come back
        // as strings via node-pg ג€” parse them so the client gets real numbers.
        return {
          ...biz,
          total_revenue: parseFloat(biz.total_revenue) || 0,
          ai_tokens:     parseInt(biz.ai_tokens, 10) || 0,
          health_score,
        };
      });
    }

    return {
      total_businesses: parseInt(businessCount.rows[0].count),
      total_users: parseInt(userCount.rows[0].count),
      ai_tokens_month: parseInt(aiUsage.rows[0].total_tokens),
      ai_cost_month: parseFloat(aiUsage.rows[0].total_cost),
      active_businesses_30d: parseInt((activeBiz.rows[0] || {}).count || 0),
      top_businesses: topWithHealth,
    };
    }, 60); // cache 1 minute
    res.json(data);
  } catch (err) {
    logger.error('[Admin] stats error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/businesses ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/businesses', requireAdmin, async (req, res) => {
  try {
    const limit  = parseIntRange(req.query.limit,  1, 200, 50);
    const offset = parseIntRange(req.query.offset, 0, 1e9,  0);
    const { rows: [{ count: total }] } = await db.query('SELECT COUNT(*) AS count FROM businesses');
    const { rows: businesses } = await db.query(`
      SELECT
        b.id,
        b.name,
        b.business_type,
        b.email,
        b.created_at,
        b.suspended_at,
        b.suspended_reason,
        (b.is_active IS NOT FALSE) AS is_active,
        COALESCE(u.user_count, 0)::int  AS user_count,
        COALESCE(s.total_revenue, 0)    AS total_revenue,
        COALESCE(ai.ai_tokens_month, 0) AS ai_tokens_month
      FROM businesses b
      LEFT JOIN (
        SELECT business_id, COUNT(*) AS user_count FROM users GROUP BY business_id
      ) u ON u.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COALESCE(SUM(total_amount), 0) AS total_revenue
        FROM sales
        WHERE sold_at >= NOW() - INTERVAL '30 days'
          AND (
            pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%'
            OR NOT EXISTS (
              SELECT 1 FROM sales s2
              WHERE s2.business_id = sales.business_id
                AND (s2.pos_sale_id IS NULL OR s2.pos_sale_id NOT LIKE 'Z-%')
                AND DATE(s2.sold_at AT TIME ZONE 'Asia/Jerusalem') = DATE(sales.sold_at AT TIME ZONE 'Asia/Jerusalem')
            )
          )
        GROUP BY business_id
      ) s ON s.business_id = b.id
      LEFT JOIN (
        SELECT business_id, SUM(total_tokens) AS ai_tokens_month
        FROM ai_usage_logs
        WHERE created_at >= date_trunc('month', NOW())
        GROUP BY business_id
      ) ai ON ai.business_id = b.id
      ORDER BY b.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]).catch(async (err) => {
      logger.warn('[Admin] /businesses primary query failed, using fallback (metrics will be zero)', { err: err.message });
      return db.query(`
        SELECT b.id, b.name, b.business_type, b.email, b.created_at,
               b.suspended_at, b.suspended_reason,
               (b.is_active IS NOT FALSE) AS is_active,
               0 AS user_count, 0 AS total_revenue, 0 AS ai_tokens_month
        FROM businesses b
        ORDER BY b.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
    });

    if (businesses.length === 0) return res.json({ businesses: [], total: parseInt(total) });

    const bizIds = businesses.map(b => b.id);

    // שאילתה אחת לכל ספירות המכירות — זכור Z-reports כ-1 לא כ-N עסקאות
    const salesCountRes = await db.query(`
      SELECT business_id,
             COUNT(*) FILTER (WHERE pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS sales_count
      FROM sales
      WHERE business_id = ANY($1)
        AND sold_at >= NOW() - INTERVAL '30 days'
      GROUP BY business_id
    `, [bizIds]).catch(() => ({ rows: [] }));
    const salesCountMap = Object.fromEntries(salesCountRes.rows.map(r => [r.business_id, parseInt(r.sales_count) || 0]));

    // שאילתה אחת לפעילות אחרונה — כולל Z-reports
    const lastActivityRes = await db.query(`
      SELECT business_id, MAX(sold_at) AS last_activity
      FROM sales
      WHERE business_id = ANY($1)
      GROUP BY business_id
    `, [bizIds]).catch(() => ({ rows: [] }));
    const lastActivityMap = Object.fromEntries(lastActivityRes.rows.map(r => [r.business_id, r.last_activity]));

    const result = businesses.map(biz => {
      const revenue = parseFloat(biz.total_revenue) || 0;
      const user_count = parseInt(biz.user_count) || 0;
      const sales_count = salesCountMap[biz.id] || 0;

      const revenue_score  = Math.min(1, revenue / 50000);
      const activity_score = Math.min(1, sales_count / 200);
      const user_score     = Math.min(1, user_count / 10);
      const health_score   = Math.min(100, Math.round(revenue_score * 40 + activity_score * 40 + user_score * 20));

      return {
        ...biz,
        user_count,
        total_revenue: revenue,
        ai_tokens_month: parseInt(biz.ai_tokens_month) || 0,
        health_score,
        last_activity: lastActivityMap[biz.id] || null,
      };
    });

    res.json({ businesses: result, total: parseInt(total) });
  } catch (err) {
    logger.error('[Admin] businesses error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/businesses/:id ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/businesses/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [bizRes, usersRes, revenueRes, aiRes, activityRes] = await Promise.all([
      db.query(`SELECT id, name, business_type, address, vat_number, email, phone, logo_url,
                       currency, timezone, close_hour, open_days, closed_dates, onboarding_completed,
                       primary_email, suspended_at, suspended_reason, suspended_by, created_at, updated_at,
                       contract_type, contract_months,
                       (is_active IS NOT FALSE) AS is_active
                FROM businesses WHERE id = $1`, [id]),
      db.query('SELECT id, full_name, email, role, is_active, created_at FROM users WHERE business_id = $1 ORDER BY created_at DESC', [id]),
      db.query(`
        WITH smart_sales AS (
          SELECT total_amount, sold_at,
                 DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                 (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_individual
          FROM sales WHERE business_id = $1
        ),
        days_with_individual AS (
          SELECT DISTINCT sale_day FROM smart_sales WHERE is_individual
        )
        SELECT
          COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '30 days'
            AND (is_individual OR sale_day NOT IN (SELECT sale_day FROM days_with_individual))
            THEN total_amount END), 0) AS revenue_30d,
          COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '60 days' AND sold_at < NOW() - INTERVAL '30 days'
            AND (is_individual OR sale_day NOT IN (SELECT sale_day FROM days_with_individual))
            THEN total_amount END), 0) AS revenue_60d,
          COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '90 days' AND sold_at < NOW() - INTERVAL '60 days'
            AND (is_individual OR sale_day NOT IN (SELECT sale_day FROM days_with_individual))
            THEN total_amount END), 0) AS revenue_90d
        FROM smart_sales
      `, [id]).catch(() => ({ rows: [{ revenue_30d: 0, revenue_60d: 0, revenue_90d: 0 }] })),
      db.query(`
        SELECT feature, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
        FROM ai_usage_logs
        WHERE business_id = $1 AND created_at >= date_trunc('month', NOW())
        GROUP BY feature
        ORDER BY tokens DESC
      `, [id]),
      db.query(`
        SELECT action, entity_type, created_at, description
        FROM audit_log WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 10
      `, [id]).catch(() => ({ rows: [] })),
    ]);

    if (!bizRes.rows[0]) return res.status(404).json({ error: 'Business not found' });

    res.json({
      business: bizRes.rows[0],
      users: usersRes.rows,
      revenue: revenueRes.rows[0],
      ai_usage: aiRes.rows,
      recent_activity: activityRes.rows,
    });
  } catch (err) {
    logger.error('[Admin] business detail error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/users ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const limit  = parseIntRange(req.query.limit,  1, 200, 50);
    const offset = parseIntRange(req.query.offset, 0, 1e9,  0);
    const { rows: [{ count: total }] } = await db.query('SELECT COUNT(*) AS count FROM users');
    const { rows } = await db.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        u.is_active,
        u.created_at,
        b.name AS business_name,
        b.id AS business_id
      FROM users u
      LEFT JOIN businesses b ON b.id = u.business_id
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json({ users: rows, total: parseInt(total) });
  } catch (err) {
    logger.error('[Admin] users error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/users/:id/status ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.put('/users/:id/status', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be boolean' });
    // Use the explicit target value from the request body instead of flipping with NOT.
    // A blind flip causes two concurrent admin actions to cancel each other silently.
    const { rows } = await db.query(
      'UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id, is_active',
      [id, isActive]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    // requireAuth caches is_active for up to 60s (auth.js) ג€” this route
    // updates it via a raw query (not userModel.update/deactivate), so it
    // must bust the same cache key itself or a deactivation silently has no
    // effect until the cache TTL expires.
    cache.del(`auth:status:${id}`).catch(() => {});
    logger.info('[Admin] user status toggled', { adminId: req.admin?.adminId, targetUserId: id, newStatus: rows[0].is_active });
    res.json(rows[0]);
  } catch (err) {
    logger.error('[Admin] toggle user error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/businesses/:id/suspend ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Blocks the business's users from using the app (they can still log in and
// see the suspension reason ג€” requireAuth enforces this on every other route).
router.put('/businesses/:id/suspend', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

    const { rows } = await db.query(
      `UPDATE businesses SET suspended_at = NOW(), suspended_reason = $2, suspended_by = $3
       WHERE id = $1
       RETURNING id, suspended_at, suspended_reason`,
      [id, reason || null, req.admin.adminId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Business not found' });

    // requireAuth caches business-suspension status per user for up to 60s
    // (auth.js) ג€” bust every user of this business now so the block takes
    // effect immediately instead of up to a minute later.
    const { rows: users } = await db.query('SELECT id FROM users WHERE business_id = $1', [id]);
    await Promise.all(users.map(u => cache.del(`auth:status:${u.id}`).catch(() => {})));

    eventBus.publish(id, 'business.updated', { action: 'suspended', businessId: id, reason });
    logger.info('[Admin] business suspended', { adminId: req.admin?.adminId, businessId: id, reason });
    res.json(rows[0]);
  } catch (err) {
    logger.error('[Admin] suspend business error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/businesses/:id/unsuspend ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.put('/businesses/:id/unsuspend', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      // is_active is restored ONLY if the billing scheduler is what cleared it.
      // A business an admin deliberately parked (PUT /:id/active) stays parked
      // through a suspend/unsuspend cycle — previously unsuspend set is_active
      // = TRUE unconditionally and silently restarted its schedulers and AI spend.
      `UPDATE businesses
          SET suspended_at        = NULL,
              suspended_reason    = NULL,
              suspended_by        = NULL,
              is_active           = CASE WHEN billing_deactivated THEN TRUE ELSE is_active END,
              billing_deactivated = FALSE,
              updated_at          = NOW()
        WHERE id = $1
       RETURNING id, is_active`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Business not found' });

    const { rows: users } = await db.query('SELECT id FROM users WHERE business_id = $1', [id]);
    await Promise.all(users.map(u => cache.del(`auth:status:${u.id}`).catch(() => {})));

    eventBus.publish(id, 'business.updated', { action: 'unsuspended', businessId: id });
    logger.info('[Admin] business unsuspended', { adminId: req.admin?.adminId, businessId: id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[Admin] unsuspend business error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/businesses/:id/active ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// The switch that decides whether background work runs for a business at all.
//
// Suspension and this are deliberately separate. Suspending blocks the owner
// from signing in ג€” a billing or conduct action. This one is about whether the
// platform spends anything on the account: schedulers, AI scans, email polling.
// A demo or dormant business should cost nothing while its data stays intact
// and readable; that was not previously possible, and every scheduler kept
// running on businesses nobody was using.
router.put('/businesses/:id/active', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive (boolean) is required' });
    }
    const { rows } = await db.query(
      // An explicit admin decision overrides any billing-driven deactivation, so
      // a later unsuspend won't flip is_active back against that decision.
      `UPDATE businesses SET is_active = $2, billing_deactivated = FALSE
        WHERE id = $1 RETURNING id, name, is_active`,
      [id, req.body.isActive]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Business not found' });

    // requireAuth caches each user's status for 60s, so without this the switch
    // would take up to a minute to bite on already-signed-in sessions.
    const { rows: members } = await db.query('SELECT id FROM users WHERE business_id = $1', [id]);
    await Promise.all(members.map(m => cache.del(`auth:status:${m.id}`).catch(() => {})));

    eventBus.publish(id, 'business.updated', { action: 'active_changed', businessId: id, isActive: req.body.isActive });
    logger.info('[Admin] business active flag changed', {
      adminId: req.admin?.adminId, businessId: id, isActive: req.body.isActive,
    });
    res.json(rows[0]);
  } catch (err) {
    logger.error('[Admin] set business active error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/payments ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// All manually-recorded payments, newest first ג€” optionally filtered by business.
router.get('/payments', requireAdmin, async (req, res) => {
  try {
    const limit  = parseIntRange(req.query.limit,  1, 500, 100);
    const offset = parseIntRange(req.query.offset, 0, 1e9,   0);
    const businessId = req.query.businessId || null;

    const { rows } = await db.query(`
      SELECT p.id, p.business_id, b.name AS business_name, p.amount, p.payment_date,
             p.note, p.recorded_by, a.full_name AS recorded_by_name, p.created_at
      FROM manual_payments p
      JOIN businesses b ON b.id = p.business_id
      LEFT JOIN admin_users a ON a.id = p.recorded_by
      WHERE $1::uuid IS NULL OR p.business_id = $1
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT $2 OFFSET $3
    `, [businessId, limit, offset]);

    const { rows: [{ count: total }] } = await db.query(
      `SELECT COUNT(*) AS count FROM manual_payments WHERE $1::uuid IS NULL OR business_id = $1`,
      [businessId]
    );

    res.json({ payments: rows, total: parseInt(total) });
  } catch (err) {
    logger.error('[Admin] payments list error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/payments/schedule ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Monthly billing calendar. For each business with a billing agreement
// (billing_day + monthly_fee set), returns the next due date, debt balance,
// and open months count. Businesses without a billing agreement are returned
// in `no_agreement` for visibility.
router.get('/payments/schedule', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const reminderDays = parseIntRange(req.query.reminderDays, 1, 60, 3);

    const { rows } = await db.query(`
      SELECT b.id AS business_id, b.name AS business_name,
             b.contract_type, b.contract_months,
             b.billing_day, b.monthly_fee::float AS monthly_fee,
             b.billing_start_date::text AS billing_start_date,
             b.grace_period_days,
             b.suspended_at IS NOT NULL AS suspended,
             MAX(p.payment_date)::text AS last_payment,
             COUNT(p.id)::int          AS payments_count,
             COALESCE(SUM(p.amount), 0)::float AS total_paid
      FROM businesses b
      LEFT JOIN manual_payments p ON p.business_id = b.id
      GROUP BY b.id, b.name, b.contract_type, b.contract_months,
               b.billing_day, b.monthly_fee, b.billing_start_date,
               b.grace_period_days, b.suspended_at
      ORDER BY b.name
    `);

    const { todayY, todayM, todayD, todayTs: today } = israelToday();
    const MS_PER_DAY = 86400000;

    const schedule    = [];
    const no_agreement = [];

    for (const r of rows) {
      const base = {
        business_id:      r.business_id,
        business_name:    r.business_name,
        contract_type:    r.contract_type,
        contract_months:  r.contract_months,
        suspended:        r.suspended,
        payments_count:   r.payments_count,
        total_paid:       r.total_paid,
        billing_day:      r.billing_day,
        monthly_fee:      r.monthly_fee,
        billing_start_date: r.billing_start_date,
        grace_period_days:  r.grace_period_days,
        last_payment:     r.last_payment,
      };

      // No agreement configured yet ג€” can't compute debt or next due date.
      if (!r.billing_day || !r.monthly_fee || !r.billing_start_date) {
        no_agreement.push(base);
        continue;
      }

      const due = nextDueDate(r.billing_day, r.last_payment, r.billing_start_date);
      const dueTs = due ? due.getTime() : null;
      const daysUntil = dueTs != null ? Math.round((dueTs - today) / MS_PER_DAY) : null;

      // Indicative lifetime figures, shown for context only.
      //
      // CAVEAT: monthly_fee is a single mutable column with no history, so this
      // prices every past month at the CURRENT fee. After a fee change the
      // balance for months already paid at the old rate is wrong. It is not
      // what decides `status` (see below) and nothing acts on it automatically;
      // making it exact needs a fee-history table.
      const mDue          = monthsDue(r.billing_day, r.billing_start_date, today);
      const totalExpected = mDue * r.monthly_fee;
      const balance       = Math.max(0, totalExpected - r.total_paid);
      const openMonths    = r.monthly_fee > 0 ? Math.ceil(balance / r.monthly_fee) : 0;

      // 'overdue' is the flag an admin acts on, and it is the same question the
      // auto-suspend scheduler asks — "is the CURRENT cycle unpaid past grace?"
      // — so the dashboard can never disagree with what the scheduler does at
      // 09:00. It used to be derived from the lifetime `balance` above, which
      // meant a fee increase alone turned paid-up customers red.
      const overdue = isCycleOverdue({
        billingDay:       r.billing_day,
        gracePeriodDays:  r.grace_period_days,
        billingStartDate: r.billing_start_date,
        lastPayment:      r.last_payment,
        todayTs: today, todayY, todayM, todayD,
      });

      const status = overdue
        ? 'overdue'
        : daysUntil != null && daysUntil >= 0 && daysUntil <= reminderDays
          ? 'due_soon'
          : 'ok';

      schedule.push({
        ...base,
        next_due_date:  dueTs ? new Date(dueTs).toISOString().slice(0, 10) : null,
        days_until_due: daysUntil,
        total_expected: parseFloat(totalExpected.toFixed(2)),
        balance:        parseFloat(balance.toFixed(2)),
        open_months:    openMonths,
        status,
      });
    }

    schedule.sort((a, b) => (a.days_until_due ?? 999) - (b.days_until_due ?? 999));

    res.json({ reminderDays, schedule, no_agreement });
  } catch (err) {
    logger.error('[Admin] payment schedule error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/businesses/:id/billing ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Set or update the billing agreement for a business: fixed billing day,
// monthly fee, start date, and grace period.
router.put('/businesses/:id/billing', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { billingDay, monthlyFee, billingStartDate, gracePeriodDays } = req.body;

    const day = parseInt(billingDay, 10);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return res.status(400).json({ error: 'יום חיוב חייב להיות בין 1 ל-28' });
    }
    const fee = parseFloat(monthlyFee);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ error: 'סכום חודשי לא תקין' });
    }
    if (!billingStartDate || !/^\d{4}-\d{2}-\d{2}$/.test(billingStartDate)) {
      return res.status(400).json({ error: 'תאריך התחלה לא תקין (YYYY-MM-DD)' });
    }
    const grace = gracePeriodDays !== undefined ? parseInt(gracePeriodDays, 10) : 7;
    if (!Number.isInteger(grace) || grace < 0 || grace > 60) {
      return res.status(400).json({ error: 'ימי חסד חייבים להיות בין 0 ל-60' });
    }

    const { rows } = await db.query(
      `UPDATE businesses
       SET billing_day        = $1,
           monthly_fee        = $2,
           billing_start_date = $3,
           grace_period_days  = $4,
           updated_at         = NOW()
       WHERE id = $5
       RETURNING id, name, billing_day, monthly_fee, billing_start_date, grace_period_days`,
      [day, fee, billingStartDate, grace, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'עסק לא נמצא' });

    eventBus.publish(id, 'business.updated', { action: 'billing_updated', businessId: id });
    logger.info('[Admin] billing agreement updated', { businessId: id, billingDay: day, monthlyFee: fee });
    res.json({ ok: true, business: rows[0] });
  } catch (err) {
    logger.error('[Admin] billing update error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ PUT /api/admin/businesses/:id/contract ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Set or update the term an existing business signed on. Same normalization as
// create-business so legacy businesses (created before this field existed) and
// term changes both go through one path.
router.put('/businesses/:id/contract', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const contract = normalizeContract(req.body?.contractType, req.body?.contractMonths);
    if (contract.error) return res.status(400).json({ error: contract.error });

    const { rows } = await db.query(
      `UPDATE businesses SET contract_type = $2, contract_months = $3
       WHERE id = $1 RETURNING id, contract_type, contract_months`,
      [id, contract.type, contract.months]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Business not found' });

    logger.info('[Admin] contract updated', { adminId: req.admin?.adminId, businessId: id, contract: contract.type });
    res.json(rows[0]);
  } catch (err) {
    logger.error('[Admin] update contract error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/businesses/:id/payments ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Records a manually-collected payment (current onboarding is bank transfer +
// an invoice issued outside the system) ג€” for a record of who paid what and when.
router.post('/businesses/:id/payments', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, paymentDate, note } = req.body || {};

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'סכום לא תקין' });
    }
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) ? paymentDate : null;
    if (!dateStr) return res.status(400).json({ error: 'תאריך תשלום לא תקין' });

    const { rows: bizRows } = await db.query('SELECT id FROM businesses WHERE id = $1', [id]);
    if (!bizRows[0]) return res.status(404).json({ error: 'Business not found' });

    const { rows: [payment] } = await db.query(`
      INSERT INTO manual_payments (business_id, amount, payment_date, note, recorded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, business_id, amount, payment_date, note, created_at
    `, [id, amountNum, dateStr, note?.trim()?.slice(0, 500) || null, req.admin.adminId]);

    logger.info('[Admin] payment recorded', { adminId: req.admin?.adminId, businessId: id, amount: amountNum });
    res.status(201).json(payment);
  } catch (err) {
    logger.error('[Admin] record payment error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/create-business ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/create-business', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  const { businessName, businessType, ownerName, username, email, phone, password, contractType, contractMonths } = req.body;
  if (!businessName?.trim()) return res.status(400).json({ error: 'שם העסק חסר' });
  if (!ownerName?.trim())    return res.status(400).json({ error: 'שם הבעלים חסר' });
  if (!email?.trim())        return res.status(400).json({ error: 'אימייל חסר' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'סיסמה חייבת להיות לפחות 8 תווים' });

  const ALLOWED_BUSINESS_TYPES = ['restaurant', 'cafe', 'bar', 'bakery', 'barber', 'service'];
  if (businessType && !ALLOWED_BUSINESS_TYPES.includes(businessType)) {
    return res.status(400).json({ error: 'סוג עסק לא תקין' });
  }

  // Contract term (optional). 'trial' = 1 month, 'year' = 12, 'custom' = a
  // caller-supplied month count. Normalize to (type, months) so downstream code
  // never has to special-case the label.
  const contract = normalizeContract(contractType, contractMonths);
  if (contract.error) return res.status(400).json({ error: contract.error });

  const normalEmail = email.toLowerCase().trim();
  const normalUsername = username?.trim()?.toLowerCase() || null;

  // Required, not optional. This used to default to NULL while loginOwner
  // matched on username exclusively, so an owner created without one had no way
  // into their own account — the owner of "זוקו תל אביב" ended up exactly there.
  // loginOwner now also accepts the email, so that lockout can no longer
  // happen; this still refuses to create the half-configured account in the
  // first place, because an owner with no username cannot be told what to type.
  if (!normalUsername) {
    return res.status(400).json({ error: 'שם משתמש נדרש — בעלים ללא שם משתמש לא יוכל להתחבר' });
  }
  if (!/^[a-z0-9_]{2,30}$/.test(normalUsername)) {
    return res.status(400).json({ error: 'שם משתמש לא תקין (אותיות קטנות, מספרים, קו תחתון בלבד)' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE email = $1', [normalEmail]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'אימייל זה כבר קיים במערכת' });
    }

    if (normalUsername) {
      const { rows: existingUname } = await client.query(
        'SELECT id FROM users WHERE username = $1', [normalUsername]
      );
      if (existingUname.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'שם המשתמש כבר תפוס' });
      }
    }

    const { rows: [business] } = await client.query(`
      INSERT INTO businesses (name, business_type, email, phone, onboarding_completed, contract_type, contract_months)
      VALUES ($1, $2, $3, $4, FALSE, $5, $6)
      RETURNING id, name, business_type, email, created_at, onboarding_completed, contract_type, contract_months
    `, [businessName.trim(), businessType || 'restaurant', normalEmail, phone?.trim() || null, contract.type, contract.months]);

    const passwordHash = await bcrypt.hash(password, 12);

    const { rows: [user] } = await client.query(`
      INSERT INTO users (
        business_id, role, full_name, email, username, phone, password_hash, is_active,
        perm_suppliers, perm_inventory, perm_recipes, perm_finance,
        perm_ai, perm_employees, perm_export, perm_audit
      )
      VALUES ($1,'owner',$2,$3,$4,$5,$6,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE,TRUE)
      RETURNING id, full_name, email, username, role, created_at
    `, [business.id, ownerName.trim(), normalEmail, normalUsername, phone?.trim() || null, passwordHash]);

    await client.query('COMMIT');

    logger.info('[Admin] created business', { businessId: business.id, adminId: req.admin?.adminId });

    // Best-effort ג€” the business/user are already committed either way, and
    // the admin can always resend credentials manually if this fails.
    sendBusinessWelcome({
      to: normalEmail,
      ownerName: ownerName.trim(),
      businessName: business.name,
      username: normalUsername,
      email: normalEmail,
      password,
      loginUrl: process.env.APP_URL || 'https://app.houseofbusiness.co.il',
    }).catch(err => logger.warn('[Admin] welcome email failed', { businessId: business.id, err: err.message }));

    res.status(201).json({ business, user });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[Admin] create-business error', { err: err.message });
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
  }
});

// ג”€ג”€ GET /api/admin/ai-usage ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/ai-usage', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    const [byBusiness, byBusinessFeature, daily] = await Promise.all([
      // סיכום לפי עסק
      db.query(`
        SELECT
          b.name  AS business_name,
          b.id    AS business_id,
          SUM(a.input_tokens)  AS input_tokens,
          SUM(a.output_tokens) AS output_tokens,
          SUM(a.total_tokens)  AS total_tokens,
          SUM(a.cost_usd)      AS total_cost_usd,
          COUNT(*)::int        AS total_calls,
          MAX(a.created_at)    AS last_used_at
        FROM ai_usage_logs a
        LEFT JOIN businesses b ON b.id = a.business_id
        WHERE a.created_at >= NOW() - make_interval(days => $1::int)
        GROUP BY b.id, b.name
        ORDER BY total_cost_usd DESC
      `, [days]),

      // פירוט לפי עסק + פיצ'ר
      db.query(`
        SELECT
          a.business_id,
          a.feature,
          a.model,
          SUM(a.total_tokens) AS total_tokens,
          SUM(a.cost_usd)     AS cost_usd,
          COUNT(*)::int       AS calls
        FROM ai_usage_logs a
        WHERE a.created_at >= NOW() - make_interval(days => $1::int)
        GROUP BY a.business_id, a.feature, a.model
        ORDER BY cost_usd DESC
      `, [days]),

      // יומי — סה"כ
      db.query(`
        SELECT
          DATE(created_at) AS day,
          SUM(total_tokens) AS total_tokens,
          SUM(cost_usd)     AS total_cost_usd
        FROM ai_usage_logs
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `, [days]),
    ]);

    // מיזוג הפירוט לתוך כל עסק
    const featureMap = {};
    for (const row of byBusinessFeature.rows) {
      const bid = row.business_id;
      if (!featureMap[bid]) featureMap[bid] = [];
      featureMap[bid].push({
        feature:      row.feature,
        model:        row.model,
        total_tokens: parseInt(row.total_tokens) || 0,
        cost_usd:     parseFloat(row.cost_usd)   || 0,
        calls:        row.calls,
      });
    }

    const businesses = byBusiness.rows.map(b => ({
      business_id:    b.business_id,
      business_name:  b.business_name || 'לא ידוע',
      input_tokens:   parseInt(b.input_tokens)   || 0,
      output_tokens:  parseInt(b.output_tokens)  || 0,
      total_tokens:   parseInt(b.total_tokens)   || 0,
      total_cost_usd: parseFloat(b.total_cost_usd) || 0,
      total_calls:    b.total_calls || 0,
      last_used_at:   b.last_used_at,
      features:       featureMap[b.business_id]  || [],
    }));

    const grandTotal = {
      total_tokens:   businesses.reduce((s, b) => s + b.total_tokens,   0),
      total_cost_usd: businesses.reduce((s, b) => s + b.total_cost_usd, 0),
      total_calls:    businesses.reduce((s, b) => s + b.total_calls,    0),
      total_businesses: businesses.length,
    };

    // Free-tier health alongside the spend, because the two only make sense
    // together: the bill went up because the free tier stopped serving, and
    // this page was where that would have been visible if anything had reported it.
    const freeTier = await checkFreeTierHealth({ windowHours: 24 }).catch(() => null);

    res.json({ businesses, daily: daily.rows, grand_total: grandTotal, days, freeTier });
  } catch (err) {
    next(err);
  }
});

// ג”€ג”€ GET /api/admin/sync/status ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/sync/status', requireAdmin, async (req, res) => {
  try {
    const { getConnectionCounts } = require('./events.routes');
    const connections = getConnectionCounts();
    const totalConnections = Object.values(connections).reduce((s, v) => s + v, 0);

    const cacheKey = 'admin:sync:status';
    const cached   = await cache.get(cacheKey);
    if (cached) return res.json({ ...cached, active_sse_connections: totalConnections, connections_per_business: connections });

    const [bizCount, lowStockBiz, recentSales, activeBiz] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS cnt FROM businesses`),
      db.query(`SELECT COUNT(DISTINCT business_id)::int AS cnt FROM inventory_items WHERE current_qty <= min_qty AND min_qty > 0`),
      db.query(`SELECT COUNT(*)::int AS cnt, MAX(sold_at) AS last FROM sales WHERE sold_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT COUNT(DISTINCT business_id)::int AS cnt FROM sales WHERE sold_at >= NOW() - INTERVAL '7 days'`),
    ]);

    const result = {
      total_businesses:     bizCount.rows[0].cnt,
      low_stock_businesses: lowStockBiz.rows[0].cnt,
      sales_last_24h:       recentSales.rows[0].cnt,
      last_sale:            recentSales.rows[0].last,
      active_businesses_7d: activeBiz.rows[0].cnt,
      synced_at:            new Date().toISOString(),
    };
    cache.set(cacheKey, result, 60).catch(() => {});
    res.json({ ...result, active_sse_connections: totalConnections, connections_per_business: connections });
  } catch (err) {
    logger.error('[Admin] sync/status error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ POST /api/admin/sync/full-all ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.post('/sync/full-all', requireAdmin, requireSuperAdmin, adminActionLimiter, async (req, res) => {
  try {
    const { fullCacheBust } = require('../services/sync.service');
    const { rows: businesses } = await db.query('SELECT id FROM businesses');
    let busted = 0;
    for (const biz of businesses) {
      try { await fullCacheBust(biz.id); busted++; } catch (err) {
        logger.warn('[Admin] fullCacheBust failed for business', { bizId: biz.id, err: err.message });
      }
    }
    await Promise.all([
      cache.del('admin:stats').catch(() => {}),
      cache.del('admin:sync:status').catch(() => {}),
    ]);
    logger.info('[Admin] full-sync-all triggered', { adminId: req.admin?.adminId, busted, total: businesses.length });
    res.json({ ok: true, busted, total: businesses.length });
  } catch (err) {
    logger.error('[Admin] sync/full-all error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ GET /api/admin/support-tickets/count ג€” open tickets badge ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/support-tickets/count', requireAdmin, async (req, res, next) => {
  try {
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM support_tickets WHERE status != 'resolved'`
    );
    res.json({ count });
  } catch (err) { next(err); }
});

// ג”€ג”€ GET /api/admin/support-tickets ג€” all businesses' tickets ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/support-tickets', requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status && status !== 'all') {
      params.push(status);
      where = `WHERE st.status = $1`;
    }
    const { rows } = await db.query(
      `SELECT st.*,
         COALESCE(st.business_name, b.name) AS business_name,
         COALESCE(st.owner_name, u.full_name) AS owner_name,
         u.email AS owner_email
       FROM support_tickets st
       LEFT JOIN businesses b ON b.id = st.business_id
       LEFT JOIN users u ON u.business_id = st.business_id AND u.role = 'owner'
       ${where}
       ORDER BY
         CASE st.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
         CASE st.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         st.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ tickets: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ג”€ג”€ PATCH /api/admin/support-tickets/:id ג€” update status / admin note ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.patch('/support-tickets/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, adminNote } = req.body;
    const valid = ['open', 'in_progress', 'resolved'];
    if (status && !valid.includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא תקין' });
    }
    const { rows: [ticket] } = await db.query(
      `UPDATE support_tickets
       SET status      = COALESCE($1, status),
           admin_note  = COALESCE($2, admin_note),
           updated_at  = NOW(),
           resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END
       WHERE id = $3 RETURNING *`,
      [status || null, adminNote !== undefined ? adminNote : null, req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'קריאה לא נמצאה' });
    res.json({ ticket });
  } catch (err) { next(err); }
});

// ג”€ג”€ GET /api/admin/sse/connections ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
router.get('/sse/connections', requireAdmin, async (req, res) => {
  try {
    const { getConnectionCounts } = require('./events.routes');
    const counts = getConnectionCounts();
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    const bizIds = Object.keys(counts);

    let businesses = [];
    if (bizIds.length > 0) {
      const { rows } = await db.query('SELECT id, name FROM businesses WHERE id = ANY($1)', [bizIds]);
      const nameMap = Object.fromEntries(rows.map(r => [r.id, r.name]));
      businesses = bizIds
        .map(id => ({ business_id: id, business_name: nameMap[id] || 'לא ידוע', connections: counts[id] }))
        .sort((a, b) => b.connections - a.connections);
    }

    res.json({ total, businesses });
  } catch (err) {
    logger.error('[Admin] sse/connections error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ג”€ג”€ Z-Report Quality Monitor ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
// Returns completeness metrics for all Z-reports uploaded in the last 30 days,
// per business ג€” so the admin can spot businesses whose reports are missing
// revenue, payment channels, employee shifts, or item breakdowns.
router.get('/zreport-quality', requireAdmin, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    // Per-business summary
    const { rows: summaries } = await db.query(`
      SELECT
        b.id                                                      AS business_id,
        b.name                                                    AS business_name,
        COUNT(DISTINCT s.id)::int                                 AS zreports_count,
        COALESCE(SUM(s.total_amount), 0)::float                   AS total_revenue,
        BOOL_OR(s.total_amount > 0)                               AS has_revenue,
        BOOL_OR(
          s.cash_amount > 0 OR s.credit_amount > 0 OR
          s.wolt_amount > 0 OR s.ten_bis_amount > 0
        )                                                         AS has_channels,
        COALESCE(SUM(s.cash_amount),    0)::float                 AS total_cash,
        COALESCE(SUM(s.credit_amount),  0)::float                 AS total_credit,
        COALESCE(SUM(s.wolt_amount),    0)::float                 AS total_wolt,
        COALESCE(SUM(s.ten_bis_amount), 0)::float                 AS total_ten_bis,
        MAX(s.sold_at)::date                                      AS last_report_date,
        MIN(s.sold_at)::date                                      AS first_report_date,
        (
          SELECT COUNT(*) > 0 FROM sale_items si
          JOIN sales s2 ON s2.id = si.sale_id
          WHERE s2.business_id = b.id
            AND s2.pos_sale_id LIKE 'Z-%'
            AND s2.sold_at >= NOW() - ($1 || ' days')::INTERVAL
        )                                                         AS has_items,
        (
          SELECT COUNT(*) > 0 FROM z_report_shifts zrs
          WHERE zrs.business_id = b.id
            AND zrs.report_date >= NOW() - ($1 || ' days')::INTERVAL
        )                                                         AS has_shifts,
        (
          SELECT COUNT(*)::int FROM z_report_shifts zrs
          WHERE zrs.business_id = b.id
            AND zrs.report_date >= NOW() - ($1 || ' days')::INTERVAL
        )                                                         AS shifts_count,
        (
          SELECT COUNT(DISTINCT zrs.employee_id)::int
          FROM z_report_shifts zrs
          WHERE zrs.business_id = b.id
            AND zrs.employee_id IS NOT NULL
            AND zrs.report_date >= NOW() - ($1 || ' days')::INTERVAL
        )                                                         AS matched_employees
      FROM businesses b
      JOIN sales s ON s.business_id = b.id
        AND s.pos_sale_id LIKE 'Z-%'
        AND s.sold_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY b.id, b.name
      ORDER BY last_report_date DESC NULLS LAST
    `, [days]);

    // Per-report detail ג€” most recent 60 per business to keep response size manageable
    const { rows: details } = await db.query(`
      SELECT business_id, pos_sale_id, report_date, total_amount,
             cash_amount, credit_amount, wolt_amount, ten_bis_amount,
             items_count, shifts_count
      FROM (
        SELECT
          s.business_id,
          s.pos_sale_id,
          s.sold_at::date                                           AS report_date,
          s.total_amount::float                                     AS total_amount,
          s.cash_amount::float                                      AS cash_amount,
          s.credit_amount::float                                    AS credit_amount,
          s.wolt_amount::float                                      AS wolt_amount,
          s.ten_bis_amount::float                                   AS ten_bis_amount,
          (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
          (
            SELECT COUNT(*)::int FROM z_report_shifts zrs
            WHERE zrs.business_id = s.business_id
              AND zrs.report_date::date = s.sold_at::date
          )                                                         AS shifts_count,
          ROW_NUMBER() OVER (PARTITION BY s.business_id ORDER BY s.sold_at DESC) AS rn
        FROM sales s
        WHERE s.pos_sale_id LIKE 'Z-%'
          AND s.sold_at >= NOW() - ($1 || ' days')::INTERVAL
          AND s.business_id = ANY(
            SELECT DISTINCT business_id FROM sales
            WHERE pos_sale_id LIKE 'Z-%'
              AND sold_at >= NOW() - ($1 || ' days')::INTERVAL
          )
      ) ranked
      WHERE rn <= 60
      ORDER BY business_id, report_date DESC
    `, [days]);

    // Group details by business_id
    const detailsByBiz = {};
    for (const r of details) {
      if (!detailsByBiz[r.business_id]) detailsByBiz[r.business_id] = [];
      detailsByBiz[r.business_id].push(r);
    }

    // Attach details + compute completeness score + alerts
    const result = summaries.map(b => {
      const bDetails = detailsByBiz[b.business_id] || [];

      // Completeness: revenue 40pts, channels 25pts, items 20pts, shifts 15pts
      let score = 0;
      if (b.has_revenue)  score += 40;
      if (b.has_channels) score += 25;
      if (b.has_items)    score += 20;
      if (b.has_shifts)   score += 15;

      const alerts = [];
      if (!b.has_revenue)  alerts.push({ level: 'critical', msg: 'אין הכנסות — הדוח לא קרא סכומים' });
      if (!b.has_shifts)   alerts.push({ level: 'warning',  msg: 'אין משמרות עובדים' });
      if (!b.has_items)    alerts.push({ level: 'warning',  msg: 'אין פירוטי מנות' });
      if (!b.has_channels) alerts.push({ level: 'info',     msg: 'ערוצי מכירה לא זוהו (מזומן/אשראי/וולט/תן-ביס)' });

      const perReport = bDetails.map(r => {
        let rScore = 0;
        if (r.total_amount > 0) rScore += 40;
        if (r.cash_amount > 0 || r.credit_amount > 0 || r.wolt_amount > 0 || r.ten_bis_amount > 0) rScore += 25;
        if (r.items_count > 0)  rScore += 20;
        if (r.shifts_count > 0) rScore += 15;
        return { ...r, completeness: rScore };
      });

      return {
        ...b,
        completeness_score: score,
        alerts,
        reports: perReport,
      };
    });

    res.json({ businesses: result, days, generated_at: new Date().toISOString() });
  } catch (err) {
    logger.error('[Admin] zreport-quality error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;




