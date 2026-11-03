/**
 * Uploads proxy — forwards /uploads/:filename to the backend root (not /api).
 * The api-proxy route targets http://localhost:3001/api, but uploads are served
 * at the backend root (/uploads/:filename), so they need their own proxy.
 */
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function getBackendRoot(): string {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/api$/, '');
  return 'http://localhost:3001';
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  const targetUrl = `${getBackendRoot()}/uploads/${filename}${req.nextUrl.search}`;

  const SKIP = new Set(['host', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding']);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!SKIP.has(key.toLowerCase())) headers[key] = value;
  });

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    return new NextResponse(null, { status: 503 });
  }

  const SKIP_RESP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length']);
  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIP_RESP.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export const GET = handler;
