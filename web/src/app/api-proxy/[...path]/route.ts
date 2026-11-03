/**
 * API Proxy Route — replaces the next.config.ts rewrite.
 * Route handlers have no dev-server timeout, unlike rewrites.
 * This allows long-running backend calls (AI pipelines, ~60s) to complete.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Read lazily (not at module scope) — this route handler's module is evaluated
// during `next build`'s page-data-collection pass, before Railway's runtime env
// vars are available, so throwing here would fail the build itself.
function getBackendUrl(): string {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BACKEND_URL must be set in production');
  }
  return 'http://localhost:3001/api';
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;

  // Catch-all segments arrive percent-DECODED, so a request to
  // /api-proxy/..%2Fuploads yields the single segment '../uploads'. Joined into
  // the target URL that is `${BACKEND_URL}/../uploads`, which fetch() normalises
  // to the backend root — letting a caller step outside the /api prefix this
  // proxy is supposed to be limited to and reach any route the backend mounts.
  // Everything back there has its own auth, so this was not an open door, but
  // the proxy's contract was bypassable and shouldn't be.
  if (path.some(seg => seg === '..' || seg.includes('/') || seg.includes('\\'))) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const targetUrl = `${getBackendUrl()}/${path.join('/')}${req.nextUrl.search}`;

  // Forward headers except hop-by-hop ones. accept-encoding is dropped too:
  // we don't want the upstream compressing a body that undici will silently
  // inflate again, leaving us to re-derive the encoding headers on the way out.
  const SKIP_REQUEST_HEADERS = new Set([
    'host', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding',
  ]);

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
      signal: AbortSignal.timeout(145_000), // 145 seconds — covers AI pipelines (weekly report: 120s)
      // @ts-expect-error — `duplex` isn't in the DOM RequestInit types yet, but
      // Node's fetch requires it when the body is a stream.
      duplex: 'half',
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return NextResponse.json(
      { error: isTimeout ? 'הבקשה לקחה יותר מדי זמן' : 'השרת אינו זמין כרגע, נסה שוב עוד רגע' },
      { status: 503 },
    );
  }

  // Headers that must never be copied from the upstream response.
  //
  // content-encoding / content-length are the subtle ones: undici transparently
  // decompresses the body, but leaves the *original* headers on the response
  // object. Copying them would tell the browser "N bytes of gzip" while handing
  // it the already-inflated payload — the browser then fails to decode it. The
  // backend doesn't run compression middleware today, so this is latent, but it
  // would break every proxied response the moment someone enables it.
  //
  // set-cookie is excluded here because Headers.set() collapses repeated
  // cookies into one; it's re-added below with append().
  const SKIP_RESPONSE_HEADERS = new Set([
    'transfer-encoding', 'connection', 'keep-alive',
    'content-encoding', 'content-length', 'set-cookie',
  ]);

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      respHeaders.set(key, value);
    }
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    respHeaders.append('set-cookie', cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export const GET    = handler;
export const POST   = handler;
export const PUT    = handler;
export const PATCH  = handler;
export const DELETE = handler;
