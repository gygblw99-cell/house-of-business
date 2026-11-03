import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function safePhone(s: unknown): string {
  return String(s ?? '').replace(/[^0-9+\-() ]/g, '');
}

// Nothing here is trusted: the endpoint is public and unauthenticated, so cap
// every field before it reaches the email body. Without this a script could
// post megabytes of text per request, and newlines in `name` would end up in
// the subject line.
const MAX_FIELD_LEN = 200;
function clamp(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN);
}

// A lead is only useful if someone can call it back. Enough digits to be a
// real number, loose enough not to reject valid international formats.
function isPlausiblePhone(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

// Public, unauthenticated, no CAPTCHA — a simple in-memory per-IP limiter is
// the minimum needed before launch so a script can't flood the owner's inbox
// (or trip Gmail's spam/abuse detection on the sending account) for free.
// In-memory only (resets on deploy/restart, not shared across instances) —
// acceptable here since this route only guards against casual abuse, not a
// determined attacker; add a shared store (Redis) if that ever changes.
const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const _submissions = new Map<string, number[]>(); // ip → timestamps

function _isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (_submissions.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    _submissions.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  _submissions.set(ip, timestamps);
  if (_submissions.size > 5000) {
    for (const [k, v] of _submissions) {
      if (!v.some(t => now - t < RATE_LIMIT_WINDOW_MS)) _submissions.delete(k);
    }
  }
  return false;
}

// Raw SMTP (nodemailer) is blocked outbound on Railway's network — switched to
// Resend's HTTPS API, which isn't affected by that. RESEND_FROM_EMAIL defaults
// to Resend's shared testing address; set it to something on a verified domain
// (e.g. leads@houseofbusiness.co.il) once houseofbusiness.co.il is verified in
// the Resend dashboard, for better deliverability.
//
// The Resend client is constructed lazily (not at module scope) — its
// constructor throws immediately if the API key is missing, and this module
// is evaluated during `next build`'s page-data-collection pass, before
// Railway's runtime env vars are available, so throwing here would fail the
// build itself.
let resend: Resend | null = null;
function getResend(): Resend {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'House of Business <onboarding@resend.dev>';

interface Lead { name: string; phone: string; business: string; type: string; date: string }

// Single, greppable shape so a lost lead can always be recovered from the
// deploy logs. Tag every line with LEAD so ops can alert on it.
function logLead(stage: string, lead: Lead) {
  console.log(`[LEAD] ${stage} | ${JSON.stringify(lead)}`);
}

export async function POST(req: NextRequest) {
  // Hoisted out of the try so the catch can still report what was lost when
  // the failure happens *during* the send.
  let lead: Lead | null = null;

  try {
    // CF-Connecting-IP is injected by Cloudflare and can't be spoofed.
    // Fall back to the RIGHTMOST X-Forwarded-For entry (added by the last
    // trusted proxy/CDN), not the leftmost (which the client controls).
    const ip = req.headers.get('cf-connecting-ip')
      || req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
      || 'unknown';
    if (_isRateLimited(ip)) {
      return NextResponse.json({ ok: false, error: 'יותר מדי בקשות, נסה שוב מאוחר יותר' }, { status: 429 });
    }

    const body = await req.json();
    const name     = clamp(body?.name);
    const phone    = clamp(body?.phone);
    const business = clamp(body?.business);
    const type     = clamp(body?.type);

    if (!name || !phone) {
      return NextResponse.json({ ok: false, error: 'חסרים פרטים' }, { status: 400 });
    }
    if (!isPlausiblePhone(phone)) {
      return NextResponse.json({ ok: false, error: 'מספר טלפון לא תקין' }, { status: 400 });
    }

    const date = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    lead = { name, phone, business, type, date };

    // Log the lead before attempting delivery, and again on any failure. Email
    // is the only channel here — there's no database behind this form — so if
    // Resend is down or misconfigured the lead exists nowhere else. A line in
    // the server log is recoverable; a dropped lead is not.
    logLead('received', lead);

    if (!process.env.LEAD_EMAIL) {
      logLead('DROPPED — LEAD_EMAIL env var is not set', lead);
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to: process.env.LEAD_EMAIL,
      subject: `🔔 ליד חדש — ${name}`,
      html: `
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"></head><body>
        <div dir="rtl" style="font-family:sans-serif;max-width:480px;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
          <h2 style="color:#b8941f;margin:0 0 20px">ליד חדש מהאתר</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#6b7280;width:120px">שם</td><td style="padding:8px 0;font-weight:600">${escHtml(name)}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280">טלפון</td><td style="padding:8px 0;font-weight:600"><a href="tel:${safePhone(phone)}">${escHtml(phone)}</a></td></tr>
            ${business ? `<tr><td style="padding:8px 0;color:#6b7280">עסק</td><td style="padding:8px 0">${escHtml(business)}</td></tr>` : ''}
            ${type ? `<tr><td style="padding:8px 0;color:#6b7280">סוג עסק</td><td style="padding:8px 0">${escHtml(type)}</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#6b7280">תאריך</td><td style="padding:8px 0;color:#9ca3af;font-size:13px">${date}</td></tr>
          </table>
        </div>
        </body></html>
      `,
    });

    if (error) {
      console.error('Lead email error:', error);
      logLead('DROPPED — Resend rejected the send', lead);
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    logLead('sent', lead);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Reaches here on malformed JSON, a Resend outage, or a missing API key.
    // `lead` is null only when req.json() itself threw — in which case there
    // was never a usable lead to lose.
    console.error('Lead email error:', err);
    if (lead) logLead('DROPPED — send threw', lead);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
