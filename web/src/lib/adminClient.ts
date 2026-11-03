/**
 * Shared transport for the admin panel.
 *
 * Every admin page called `fetch` directly and re-implemented the same three
 * things by hand, inconsistently: build the base URL, send credentials, and
 * decide what a 401 means. The tenant side has had all of that in one axios
 * client for a long time; the admin side never did, so a page that forgot the
 * 401 branch just rendered an error toast and left the operator on a dead screen.
 *
 * This keeps the `fetch` shape — it returns a real Response — so it can replace
 * a `fetch` call without rewriting how each caller reads its body.
 */

const API = process.env.NEXT_PUBLIC_API_URL || '/api-proxy';

/** Transient statuses worth one retry on an idempotent request. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

let redirecting = false;

function toLogin() {
  // Guard against a burst of parallel 401s each kicking off a navigation.
  if (redirecting || typeof window === 'undefined') return;
  redirecting = true;
  window.location.href = '/admin/login';
}

export interface AdminFetchOptions extends RequestInit {
  /** Set false to handle 401/403 yourself (the login page does). */
  redirectOnAuthFailure?: boolean;
}

/**
 * `path` is relative to the API root, with or without a leading slash:
 *   adminFetch('/admin/businesses?limit=200')
 */
export async function adminFetch(path: string, options: AdminFetchOptions = {}): Promise<Response> {
  const { redirectOnAuthFailure = true, ...init } = options;
  const url = `${API}${path.startsWith('/') ? path : `/${path}`}`;
  const method = (init.method || 'GET').toUpperCase();

  // JSON by default when there's a body, unless the caller set its own type.
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers, credentials: 'include' });

      if ((res.status === 401 || res.status === 403) && redirectOnAuthFailure) {
        toLogin();
        return res;
      }

      // Only GET is safe to repeat — a retried POST could double-charge or
      // double-suspend a business.
      if (RETRY_STATUS.has(res.status) && method === 'GET' && attempt < MAX_RETRIES) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      // Network failure. Same rule: retry idempotent requests only.
      lastError = err;
      if (method === 'GET' && attempt < MAX_RETRIES) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

/**
 * Reads the server's error message. The API answers with `{ error }` in Hebrew;
 * falling back to res.statusText would show the operator "Bad Request".
 */
export async function adminError(res: Response, fallback = 'שגיאת שרת'): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

/** GET + parse, throwing the server's Hebrew message on failure. */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await adminFetch(path);
  if (!res.ok) throw new Error(await adminError(res));
  return res.json() as Promise<T>;
}

/** Send JSON and parse the reply, throwing the server's Hebrew message. */
export async function adminSend<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const res = await adminFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await adminError(res));
  // 204 and empty bodies are normal for DELETE.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export { API as ADMIN_API_BASE };
