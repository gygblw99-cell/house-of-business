const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db      = require('../utils/db');
const jwt     = require('../utils/jwt');
const logger  = require('../utils/logger');
const { fullCacheBust } = require('./sync.service');

// Twilio — נטען רק אם TWILIO_ACCOUNT_SID קיים
function _sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    logger.warn('[Auth] Twilio not configured — SMS not sent');
    return Promise.resolve();
  }
  const twilio = require('twilio')(sid, token);
  return twilio.messages.create({ body, from, to });
}

const SALT_ROUNDS    = 12;
const MAX_FAIL_LOGIN = 5;

// ── Register ─────────────────────────────────────────────────
async function register({ name, businessName, businessType, phone, email, password }) {
  // מייל כפול?
  const exists = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows.length > 0) {
    const err = new Error('מייל זה כבר רשום במערכת');
    err.status = 409;
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // יצירת עסק עם כל 7 ימי השבוע פתוחים כברירת מחדל
    const bizResult = await client.query(
      `INSERT INTO businesses (name, business_type, email, phone, open_days)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [businessName, businessType, email, phone, JSON.stringify([0,1,2,3,4,5,6])]
    );
    const businessId = bizResult.rows[0].id;

    // יצירת בעל עסק
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userResult = await client.query(
      `INSERT INTO users (business_id, role, full_name, email, phone, password_hash)
       VALUES ($1, 'owner', $2, $3, $4, $5) RETURNING id`,
      [businessId, name, email, phone, passwordHash]
    );
    const userId = userResult.rows[0].id;

    // קטגוריות מלאי ברירת מחדל
    const DEFAULT_CATEGORIES = ['בשר ועוף','דגים','ירקות ופירות','מוצרי חלב','יבש ומשומר','שתייה ובר','ניקיון וחומרים','כלים וציוד'];
    for (const catName of DEFAULT_CATEGORIES) {
      await client.query(
        `INSERT INTO inventory_categories (business_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [businessId, catName]
      );
    }

    await client.query('COMMIT');

    // Initialise cache slot and warm SSE listeners for any open tab.
    fullCacheBust(businessId).catch(() => {});

    const token = jwt.sign({ userId, businessId, role: 'owner' });
    return { token, userId, businessId };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Login (מנהל — שם משתמש או אימייל + סיסמה) ───────────────
//
// Accepts either identifier, because username alone locked people out of their
// own accounts. POST /api/admin/create-business treated username as optional
// (`username?.trim()?.toLowerCase() || null`) while this query matched on it
// exclusively, so an owner created without one had no way in at all — no email
// fallback, no phone, no recovery. It happened in production: the owner of
// "זוקו תל אביב" sat with username = NULL.
//
// users.email is UNIQUE NOT NULL, so it is a safe second identifier. The ORDER
// BY keeps it deterministic if a username ever collides with someone's email:
// an exact username match always wins.
async function loginOwner({ username, password }) {
  const identifier = String(username || '').trim().toLowerCase();

  const result = await db.query(
    `SELECT u.id, u.business_id, u.role, u.password_hash,
            u.failed_login_count, u.locked_until, u.is_active
       FROM users u
      WHERE (u.username = $1 OR LOWER(u.email) = $1)
        AND u.role IN ('owner', 'partner', 'manager')
      ORDER BY (u.username = $1) DESC
      LIMIT 1`,
    [identifier]
  );

  const user = result.rows[0];

  if (!user || !user.is_active) {
    const err = new Error('פרטי כניסה שגויים');
    err.status = 401;
    throw err;
  }

  // חסום?
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const err = new Error('החשבון נעול — נשלח מייל לפתיחה');
    err.status = 423;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    // Atomic increment — prevents race condition where two concurrent failed logins
    // both read count=4 and both write 5, effectively doubling the brute-force budget.
    const { rows: lockRows } = await db.query(
      `UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= $2 THEN NOW() + INTERVAL '1 hour'
             ELSE locked_until
           END
       WHERE id = $1
       RETURNING failed_login_count`,
      [user.id, MAX_FAIL_LOGIN]
    );
    if (lockRows[0].failed_login_count >= MAX_FAIL_LOGIN) {
      const err = new Error('5 ניסיונות כושלים — החשבון נעול, נשלח מייל לפתיחה');
      err.status = 423;
      throw err;
    }
    const err = new Error('פרטי כניסה שגויים');
    err.status = 401;
    throw err;
  }

  // איפוס ניסיונות כושלים
  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const token = jwt.sign({ userId: user.id, businessId: user.business_id, role: user.role });
  return { token, userId: user.id, businessId: user.business_id, role: user.role };
}

// ── Login (עובד — שם משתמש + סיסמה) ─────────────────────────
async function loginEmployee({ username, password }) {
  const result = await db.query(
    `SELECT u.id, u.business_id, u.role, u.password_hash,
            u.failed_login_count, u.locked_until, u.is_active,
            u.perm_suppliers, u.perm_inventory, u.perm_recipes,
            u.perm_finance, u.perm_ai, u.perm_employees, u.perm_export, u.perm_audit
     FROM users u WHERE u.username = $1 AND u.role != 'owner'`,
    [username.trim().toLowerCase()]
  );

  const user = result.rows[0];
  if (!user || !user.is_active) {
    const err = new Error('פרטי כניסה שגויים');
    err.status = 401;
    throw err;
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const err = new Error('החשבון נעול');
    err.status = 423;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const { rows: lockRows } = await db.query(
      `UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= $2 THEN NOW() + INTERVAL '1 hour'
             ELSE locked_until
           END
       WHERE id = $1
       RETURNING failed_login_count`,
      [user.id, MAX_FAIL_LOGIN]
    );
    if (lockRows[0].failed_login_count >= MAX_FAIL_LOGIN) {
      const err = new Error('החשבון נעול');
      err.status = 423;
      throw err;
    }
    const err = new Error('פרטי כניסה שגויים');
    err.status = 401;
    throw err;
  }

  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const permissions = {
    suppliers: user.perm_suppliers,
    inventory: user.perm_inventory,
    recipes:   user.perm_recipes,
    finance:   user.perm_finance,
    ai:        user.perm_ai,
    employees: user.perm_employees,
    export:    user.perm_export,
    audit:     user.perm_audit,
  };

  const token = jwt.sign({ userId: user.id, businessId: user.business_id, role: user.role, permissions });
  return { token, userId: user.id, businessId: user.business_id, role: user.role, permissions };
}

// ── Forgot password (Email) ───────────────────────────────────
async function forgotPassword({ email }) {
  const result = await db.query(
    'SELECT id, full_name FROM users WHERE email = $1 AND is_active = TRUE AND NOT pending_invite',
    [email]
  );
  // לא חושפים אם המייל קיים (security)
  if (!result.rows[0]) return;

  const code = require('crypto').randomInt(100000, 1000000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 דקות

  await db.query(
    `UPDATE users SET invite_token = $1, invite_expires_at = $2 WHERE id = $3`,
    [code, expires, result.rows[0].id]
  );

  // שלח מייל עם קוד אימות
  let emailSent = false;
  try {
    const { sendEmail } = require('./notifications/email.service');
    await sendEmail({
      to:      email,
      subject: 'House of Business — קוד איפוס סיסמה',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2563eb">איפוס סיסמה</h2>
          <p>שלום ${result.rows[0].full_name},</p>
          <p>קוד האימות שלך:</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1e293b;
                      background:#f1f5f9;padding:16px;border-radius:8px;text-align:center">
            ${code}
          </div>
          <p style="color:#64748b;font-size:13px">הקוד תקף ל-10 דקות בלבד.</p>
          <p style="color:#64748b;font-size:13px">אם לא ביקשת איפוס — התעלם ממייל זה.</p>
        </div>
      `,
    });
    emailSent = true;
  } catch (e) {
    logger.error('[Auth] forgotPassword email failed', { userId: result.rows[0].id, err: e.message });
    // Clear the token so it doesn't sit in the DB unused
    await db.query(
      `UPDATE users SET invite_token = NULL, invite_expires_at = NULL WHERE id = $1`,
      [result.rows[0].id]
    ).catch(() => {});
  }

  return { userId: result.rows[0].id, emailSent };
}

// ── Reset password ────────────────────────────────────────────
async function resetPassword({ email, code, newPassword }) {
  const result = await db.query(
    `SELECT id, invite_token, invite_expires_at
     FROM users WHERE email = $1 AND is_active = TRUE`,
    [email]
  );

  const user = result.rows[0];
  if (!user || user.invite_token !== code) {
    const err = new Error('קוד שגוי');
    err.status = 400;
    throw err;
  }
  if (new Date(user.invite_expires_at) < new Date()) {
    const err = new Error('הקוד פג תוקף');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.query(
    `UPDATE users SET password_hash = $1, invite_token = NULL, invite_expires_at = NULL,
            failed_login_count = 0, locked_until = NULL, password_changed_at = NOW()
     WHERE id = $2`,
    [passwordHash, user.id]
  );
}

// ── Login by userId (לאחר השלמת הרשמה) ──────────────────────
async function loginByUserId(userId) {
  const { rows } = await db.query(
    `SELECT id, business_id, role,
            perm_suppliers, perm_inventory, perm_recipes,
            perm_finance, perm_ai, perm_employees, perm_export, perm_audit
       FROM users WHERE id = $1 AND is_active = TRUE`,
    [userId]
  );
  if (!rows[0]) { const e = new Error('משתמש לא נמצא'); e.status = 404; throw e; }
  const u = rows[0];
  const permissions = {
    suppliers: u.perm_suppliers, inventory: u.perm_inventory,
    recipes: u.perm_recipes,     finance:   u.perm_finance,
    ai:      u.perm_ai,          employees: u.perm_employees,
    export:  u.perm_export,      audit:     u.perm_audit,
  };
  const token = jwt.sign({ userId: u.id, businessId: u.business_id, role: u.role, permissions });
  return { token, userId: u.id, businessId: u.business_id, role: u.role, permissions };
}

// ── Get current user profile ──────────────────────────────────
async function getMe(userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.username,
            u.perm_suppliers, u.perm_inventory, u.perm_recipes,
            u.perm_finance, u.perm_ai, u.perm_employees, u.perm_export, u.perm_audit,
            b.id AS biz_id, b.name AS biz_name, b.business_type AS biz_type,
            b.onboarding_completed AS biz_onboarding,
            b.suspended_at AS biz_suspended_at, b.suspended_reason AS biz_suspended_reason
     FROM users u
     JOIN businesses b ON b.id = u.business_id
     WHERE u.id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    user: {
      userId: r.id, fullName: r.full_name, email: r.email, phone: r.phone, role: r.role, username: r.username,
      permissions: {
        suppliers: r.perm_suppliers, inventory: r.perm_inventory, recipes: r.perm_recipes,
        finance: r.perm_finance, ai: r.perm_ai, employees: r.perm_employees,
        export: r.perm_export, audit: r.perm_audit,
      },
    },
    business: {
      id: r.biz_id, name: r.biz_name, type: r.biz_type, onboarding_completed: r.biz_onboarding,
      is_suspended: !!r.biz_suspended_at, suspended_reason: r.biz_suspended_reason,
    },
  };
}

module.exports = { register, loginOwner, loginEmployee, forgotPassword, resetPassword, loginByUserId, getMe };
