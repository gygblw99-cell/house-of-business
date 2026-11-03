import { timingSafeEqual } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

// Constant-time comparison so the endpoint can't be used as an oracle to
// recover the secret one byte at a time. Lengths are compared first (and leak,
// unavoidably — timingSafeEqual throws on a length mismatch).
function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Simple in-memory rate limiter — caps ISR regeneration at 10 calls/minute
// even from a caller that knows the secret (leaked .env, CI logs).
const REVALIDATE_LIMIT = 10;
const REVALIDATE_WINDOW_MS = 60 * 1000;
const _calls: number[] = [];

function _isRateLimited(): boolean {
  const now = Date.now();
  const windowStart = now - REVALIDATE_WINDOW_MS;
  // Remove timestamps outside the current window
  while (_calls.length && _calls[0] < windowStart) _calls.shift();
  if (_calls.length >= REVALIDATE_LIMIT) return true;
  _calls.push(now);
  return false;
}

export async function POST(req: NextRequest) {
  // Authenticate FIRST, then spend the rate-limit budget.
  //
  // The limiter used to run before the secret check, and it is a single global
  // counter. Anyone could therefore post 10 unauthenticated requests a minute
  // and exhaust the window, so the real deploy hook — which knows the secret —
  // got 429s and the site silently stopped regenerating. Only calls that pass
  // auth consume the budget now, which keeps the limiter doing its actual job
  // (capping ISR churn from a leaked secret) without handing anonymous callers
  // a switch to turn revalidation off.
  try {
    const { secret } = await req.json();
    const expected = process.env.REVALIDATE_SECRET;
    if (!expected || !secretMatches(secret, expected)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (_isRateLimited()) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }
    revalidatePath('/');
    return NextResponse.json({ revalidated: true, ts: Date.now() });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}
