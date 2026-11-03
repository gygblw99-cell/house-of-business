import type { NextConfig } from "next";

// Next.js requires unsafe-inline + unsafe-eval for its own hydration scripts.
// All other directives meaningfully restrict attack surface.
//
// connect-src must explicitly include the backend's own origin: in
// production NEXT_PUBLIC_API_URL points at api.houseofbusiness.co.il
// (a different origin from app.houseofbusiness.co.il, not covered by
// 'self'), so every fetch to it — including login — was silently blocked
// by the browser itself. Curl/server-side testing never catches this,
// since CSP is a browser-enforced header, not something curl checks.
// NEXT_PUBLIC_API_URL is a relative path ('/api-proxy') in local dev, not an
// absolute URL — new URL() throws on that, so guard it explicitly.
let API_ORIGIN = '';
try {
  if (process.env.NEXT_PUBLIC_API_URL) {
    API_ORIGIN = new URL(process.env.NEXT_PUBLIC_API_URL).origin;
  }
} catch {
  // relative path (local dev) — 'self' in connect-src already covers it
}
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_ORIGIN} https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://fcm.googleapis.com https://firebaseinstallations.googleapis.com https://firebase.googleapis.com`,
  "media-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy',   value: CSP },
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'X-Frame-Options',           value: 'DENY' },
  { key: 'X-XSS-Protection',          value: '1; mode=block' },
  { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',        value: 'camera=(), microphone=(), geolocation=()' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
  // Rewrites removed — replaced by app/api-proxy/[...path]/route.ts
  // which has no timeout and properly handles long-running AI requests
};

export default nextConfig;
