/**
 * Email Service — Nodemailer + SMTP
 * שליחת מיילים לעובדים ומנהלים
 */

const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const logger     = require('../../utils/logger');
const db         = require('../../utils/db');

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Per-business transporter cache ──────────────────────────────────────────
const _bizTransporters = new Map(); // businessId → { transporter, createdAt }
const BIZ_TRANSPORTER_TTL = 10 * 60 * 1000; // 10 min cache

function _smtpHostFromImap(imapHost) {
  if (!imapHost) return 'smtp.gmail.com';
  return imapHost.replace(/^imap\./, 'smtp.');
}

async function _getBizTransporter(businessId) {
  const cached = _bizTransporters.get(businessId);
  if (cached && Date.now() - cached.createdAt < BIZ_TRANSPORTER_TTL) {
    return { transporter: cached.transporter, email: cached.email };
  }

  // getEmailConfigWithPassword handles decryption internally
  const { getEmailConfigWithPassword } = require('../zreport.emailConfig.service');
  const config = await getEmailConfigWithPassword(businessId).catch(() => null);
  if (!config?.email || !config?.app_password) return null;

  const bizPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const transporter = nodemailer.createTransport({
    host:   _smtpHostFromImap(config.imap_host),
    port:   bizPort,
    secure: bizPort === 465, // implicit TLS on 465; STARTTLS (secure:false) on 587/25
    auth:   { user: config.email, pass: config.app_password },
  });

  _bizTransporters.set(businessId, { transporter, email: config.email, createdAt: Date.now() });
  return { transporter, email: config.email };
}

// Raw SMTP (nodemailer) is blocked outbound on Railway's network — the system
// mailer goes through Resend's HTTPS API instead, which isn't affected by
// that. RESEND_FROM_EMAIL defaults to Resend's shared testing address; set it
// to something on a verified domain (e.g. noreply@houseofbusiness.co.il) once
// houseofbusiness.co.il is verified in the Resend dashboard.
let resendClient;
function _getResend() {
  if (!process.env.RESEND_API_KEY) {
    const err = new Error('Email not configured — set RESEND_API_KEY in .env');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'House of Business <onboarding@resend.dev>';

// Wrap in a full HTML document with an explicit charset — without it, some
// mail clients guess the encoding wrong and render Hebrew as "?????".
function _wrapHtml(html) {
  if (!html) return html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

// שליחת מייל גנרי
async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
  try {
    const opts = { from: FROM, to, subject, html: _wrapHtml(html), text };
    if (replyTo) opts.replyTo = replyTo;
    if (attachments) {
      opts.attachments = attachments.map(a => ({ filename: a.filename, content: a.content }));
    }
    const { data, error } = await _getResend().emails.send(opts);
    if (error) throw new Error(error.message || 'Resend send failed');
    return { messageId: data?.id };
  } catch (err) {
    logger.error('[Email] sendEmail error', { err: err.message });
    throw err;
  }
}

// הזמנת עובד
async function sendEmployeeInvite({ to, fullName, businessName, inviteUrl }) {
  return sendEmail({
    to,
    subject: `הצטרף ל-${escapeHtml(businessName)} — House of Business`,
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2>שלום ${escapeHtml(fullName)},</h2>
        <p>הוזמנת להצטרף ל<strong>${escapeHtml(businessName)}</strong> בפלטפורמת House of Business.</p>
        <p>לחץ על הקישור להשלמת ההרשמה:</p>
        <a href="${escapeHtml(inviteUrl)}"
           style="background:#2563EB;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">
          הצטרף עכשיו
        </a>
        <p style="color:#666;font-size:12px">הקישור תקף ל-24 שעות.</p>
      </div>`,
  });
}

// ברוכים הבאים — נשלח אחרי שאדמין יוצר עסק חדש, כולל פרטי הכניסה שהוזנו
async function sendBusinessWelcome({ to, ownerName, businessName, username, email, password, loginUrl }) {
  return sendEmail({
    to,
    subject: `ברוכים הבאים ל-House of Business, ${escapeHtml(ownerName)}!`,
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2>שלום ${escapeHtml(ownerName)},</h2>
        <p>העסק <strong>${escapeHtml(businessName)}</strong> נפתח בהצלחה במערכת House of Business.</p>
        <p>אלה פרטי הכניסה שלך:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          ${username ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;color:#666">שם משתמש</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${escapeHtml(username)}</td></tr>` : ''}
          <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#666">אימייל</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${escapeHtml(email)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#666">סיסמה</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${escapeHtml(password)}</td></tr>
        </table>
        <a href="${escapeHtml(loginUrl)}"
           style="background:#2563EB;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">
          כניסה למערכת
        </a>
        <p style="color:#666;font-size:12px">מומלץ להחליף את הסיסמה לאחר הכניסה הראשונה. לשאלות ותמיכה — פנה אלינו.</p>
      </div>`,
  });
}

// איפוס סיסמה
async function sendPasswordReset({ to, fullName, resetUrl }) {
  return sendEmail({
    to,
    subject: 'איפוס סיסמה — House of Business',
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2>שלום ${escapeHtml(fullName)},</h2>
        <p>קיבלנו בקשה לאיפוס הסיסמה שלך.</p>
        <a href="${escapeHtml(resetUrl)}"
           style="background:#DC2626;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">
          אפס סיסמה
        </a>
        <p style="color:#666;font-size:12px">אם לא ביקשת איפוס — התעלם מהמייל הזה. הקישור תקף לשעה.</p>
      </div>`,
  });
}

// תלוש שכר
async function sendPayslip({ to, fullName, month, year, pdfBuffer }) {
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                      'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const monthName = monthNames[month - 1];

  return sendEmail({
    to,
    subject: `תלוש שכר ${monthName} ${year} — House of Business`,
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2>שלום ${escapeHtml(fullName)},</h2>
        <p>מצורף תלוש השכר שלך עבור <strong>${escapeHtml(monthName)} ${escapeHtml(String(year))}</strong>.</p>
        <p style="color:#666;font-size:12px">לשאלות פנה למנהל העסק.</p>
      </div>`,
    ...(pdfBuffer && {
      attachments: [{
        filename:    `payslip-${year}-${String(month).padStart(2,'0')}.pdf`,
        content:     pdfBuffer,
        contentType: 'application/pdf',
      }],
    }),
  });
}

// התראת מלאי נמוך
async function sendLowInventoryAlert({ to, businessName, items }) {
  const itemsList = items.map(i =>
    `<li>${escapeHtml(i.name)}: ${escapeHtml(String(i.current_qty))} ${escapeHtml(i.unit)} (מינימום: ${escapeHtml(String(i.min_qty))})</li>`
  ).join('');

  return sendEmail({
    to,
    subject: `התראת מלאי נמוך — ${escapeHtml(businessName)}`,
    html: `
      <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <h2>⚠️ מלאי נמוך — ${escapeHtml(businessName)}</h2>
        <p>הפריטים הבאים הגיעו לרמת מינימום:</p>
        <ul>${itemsList}</ul>
      </div>`,
  });
}

/**
 * sendEmailFromBusiness — sends from the business's own configured Gmail (business_email_configs).
 * Falls back to system SMTP + replyTo if no business config exists.
 */
async function sendEmailFromBusiness(businessId, { to, subject, html, text }) {
  const biz = await _getBizTransporter(businessId).catch(() => null);

  if (biz) {
    const from = `"House of Business" <${biz.email}>`;
    try {
      const info = await biz.transporter.sendMail({ from, to, subject, html, text });
      logger.info(`[Email] sent via business SMTP <${biz.email}> → ${to}`);
      return { messageId: info.messageId, sentFrom: biz.email };
    } catch (err) {
      logger.warn(`[Email] business SMTP failed, falling back to system SMTP`, { err: err.message });
    }
  }

  // Fallback: system SMTP + replyTo = business primary_email
  let replyTo;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(b.primary_email, u.email) AS contact_email
       FROM businesses b
       LEFT JOIN users u ON u.business_id = b.id AND u.role = 'owner' AND u.is_active = TRUE
       WHERE b.id = $1 LIMIT 1`,
      [businessId]
    );
    replyTo = rows[0]?.contact_email || undefined;
  } catch { /* non-fatal */ }

  return sendEmail({ to, subject, html, text, replyTo });
}

module.exports = { sendEmail, sendEmailFromBusiness, sendEmployeeInvite, sendBusinessWelcome, sendPasswordReset, sendPayslip, sendLowInventoryAlert };
