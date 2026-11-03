import { NextRequest, NextResponse } from 'next/server';

// Routes that are publicly accessible without auth
const PUBLIC_PATHS = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/onboarding',
  '/join',
  '/employee',
  '/privacy',
  '/terms',
]);

// Prefixes that are always public (API, assets, Next internals)
const PUBLIC_PREFIXES = [
  '/api-proxy', // proxy to backend — auth is handled by the backend itself
  '/api/public',
  '/_next',
  '/favicon',
  '/backgrounds',
  '/logo',
  '/icons',
  '/images',
  '/fonts',
  '/join-queue', // customer-facing waitlist form reached via QR code — no account required
];

// Admin panel has its own separate auth (admin_token cookie)
const ADMIN_PREFIX = '/admin';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── Skip Next.js internals and static assets ────────────────
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // ── Admin panel — guarded by admin_token cookie ─────────────
  if (pathname.startsWith(ADMIN_PREFIX)) {
    // /admin/login is always public — avoid infinite redirect loop
    if (pathname === '/admin/login') return NextResponse.next();
    const adminToken = req.cookies.get('admin_token')?.value;
    if (!adminToken) {
      return NextResponse.redirect(new URL('/admin/login', req.url));
    }
    // Verify the JWT is valid and the admin account is still active.
    // Presence check alone is not enough — any cookie value passes `if (!adminToken)`.
    const backendUrl = process.env.BACKEND_URL?.replace(/\/api\/?$/, '') || 'http://localhost:3001';
    try {
      const verifyRes = await fetch(`${backendUrl}/api/admin/auth/me`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!verifyRes.ok) {
        const redirect = NextResponse.redirect(new URL('/admin/login', req.url));
        redirect.cookies.delete('admin_token');
        return redirect;
      }
    } catch {
      // Backend unreachable — allow through; each API call will fail individually
    }
    return NextResponse.next();
  }

  // ── Exact public paths (login, register, etc.) ──────────────
  const cleanPath = pathname.split('?')[0].replace(/\/$/, '') || '/';
  if (PUBLIC_PATHS.has(cleanPath)) {
    // If already logged in and hitting /login or /register → send to dashboard
    const token = req.cookies.get('token')?.value;
    if (token && (cleanPath === '/login' || cleanPath === '/register')) {
      return NextResponse.redirect(new URL('/dashboard', req.url));
    }
    return NextResponse.next();
  }

  // ── All other routes require auth ───────────────────────────
  const token = req.cookies.get('token')?.value;
  if (!token) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
