import { useCallback, useEffect, useState } from 'react';
import { authApi } from '@/lib/api';

// /uploads/:filename is auth-gated (business-scoped) on the backend, but a
// plain <img>/<a> element can't send an Authorization header — so pages that
// render uploaded files (gallery, tasks) attach this short-lived token as a
// ?token= query param instead. Cached at module scope (not per-component) so
// every page sharing this hook reuses one fetch instead of one per mount.
// Token is also persisted to localStorage so a page reload reuses the same
// token → same image URL → browser cache hit (no re-fetch needed).
let _cachedToken: string | null = null;
let _cachedAt = 0;
let _inFlight: Promise<string> | null = null;
const REFRESH_MS = 10 * 60 * 1000; // backend TTL is 15min — refresh with margin
const LS_KEY    = 'hob_img_tok';
const LS_KEY_AT = 'hob_img_tok_at';

function _lsRead(): { token: string; at: number } | null {
  try {
    const tok = localStorage.getItem(LS_KEY);
    const at  = Number(localStorage.getItem(LS_KEY_AT) || 0);
    if (tok && at && Date.now() - at < REFRESH_MS) return { token: tok, at };
  } catch { /* private-mode / storage full */ }
  return null;
}
function _lsWrite(token: string) {
  try {
    localStorage.setItem(LS_KEY, token);
    localStorage.setItem(LS_KEY_AT, String(Date.now()));
  } catch { /* ignore */ }
}

// Seed module-level cache from localStorage on first import (survives reload).
const _stored = _lsRead();
if (_stored) { _cachedToken = _stored.token; _cachedAt = _stored.at; }

async function _fetchToken(force = false): Promise<string> {
  if (!force && _cachedToken && Date.now() - _cachedAt < REFRESH_MS) return _cachedToken;
  if (_inFlight) return _inFlight;
  // force=true: clear cache so a fresh POST is made even within the TTL window.
  // Used by callers that detected a 401 from an image load (e.g. backend restart
  // invalidated the in-memory token map while the cached token was still "fresh").
  if (force) { _cachedToken = null; _cachedAt = 0; }
  _inFlight = authApi.imgToken()
    .then(({ data }) => {
      _cachedToken = data.token;
      _cachedAt = Date.now();
      _lsWrite(data.token);
      return data.token;
    })
    .finally(() => { _inFlight = null; });
  return _inFlight;
}

// Returns [token, refreshToken].
// refreshToken() force-fetches a new token (e.g. after detecting a 401 from an
// image load — the cached token may have been invalidated by a backend restart).
export function useImgToken(): [string | null, () => void] {
  const [token, setToken] = useState<string | null>(_cachedToken);

  const refreshToken = useCallback(() => {
    _fetchToken(true).then(t => setToken(t)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function attempt(retryDelay = 5_000) {
      _fetchToken()
        .then(t => { if (!cancelled) setToken(t); })
        .catch(() => {
          // On failure, retry after a short back-off rather than waiting the full
          // REFRESH_MS interval — a backend restart invalidates in-memory tokens, and
          // a 10-minute wait would leave gallery/task images stuck as spinners.
          if (!cancelled) retryTimer = setTimeout(() => attempt(Math.min(retryDelay * 2, 60_000)), retryDelay);
        });
    }

    attempt();
    const interval = setInterval(() => {
      _fetchToken().then(t => { if (!cancelled) setToken(t); }).catch(() => {});
    }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  return [token, refreshToken];
}

// Converts an /uploads/... URL to a same-origin proxy URL and appends the
// img token. The backend expands gallery filenames to absolute URLs like
// http://localhost:3001/uploads/file.jpg, but loading those directly from a
// different port triggers CORP: same-origin blocking. Routing through the
// Next.js api-proxy (/api-proxy/uploads/file.jpg) keeps the request
// same-origin and skips the CORP issue entirely — the same approach the
// invoices and tasks pages already use for their image buttons.
export function withImgToken(url: string | null | undefined, token: string | null): string {
  if (!url || !url.includes('/uploads/')) return url || '';
  const filename = url.replace(/^.*\/uploads\//, '');
  const proxyUrl = `/api-proxy/uploads/${filename}`;
  if (!token) return proxyUrl;
  return `${proxyUrl}?token=${token}`;
}
