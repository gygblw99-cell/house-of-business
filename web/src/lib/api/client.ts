import axios, { type AxiosRequestConfig } from 'axios';
import Cookies from 'js-cookie';

const API_URL = process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('NEXT_PUBLIC_API_URL must be set in production'); })()
    : '/api-proxy');

const api = axios.create({ baseURL: API_URL, timeout: 30_000 });

// ── Auth header ────────────────────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = Cookies.get('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Response: 401 redirect + exponential retry on transient errors ─────────────
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES  = 2;

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const config  = err.config as AxiosRequestConfig & { _retries?: number };
    const url     = config?.url || '';
    const isAuth  = url.includes('/auth/login') || url.includes('/auth/join');

    if (err.response?.status === 401 && !isAuth) {
      Cookies.remove('token');
      // Don't navigate to /login from /login. Nothing on that page returns 401
      // today so this has never fired, but assigning location.href
      // unconditionally is a full reload loop the first time anything there
      // does: the browser reloads, the page repeats the call, it 401s again.
      // The 403 branch below already guards itself exactly this way.
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      return Promise.reject(err);
    }

    // Business suspended (admin action, e.g. non-payment) — the user stays
    // logged in (don't clear the token) but every route except /auth/me and
    // /auth/logout 403s until an admin unsuspends. Redirect to the blocking
    // page instead of letting each call surface as a generic error toast.
    if (
      err.response?.status === 403 &&
      err.response.data?.error === 'business_suspended' &&
      !window.location.pathname.startsWith('/suspended')
    ) {
      window.location.href = '/suspended';
      return Promise.reject(err);
    }

    // Only retry idempotent GET requests on transient server errors / network failures
    const isGet      = (config?.method || '').toUpperCase() === 'GET';
    const retries    = config?._retries ?? 0;
    const isTransient = !err.response || RETRY_STATUS.has(err.response.status);

    if (isGet && retries < MAX_RETRIES && isTransient) {
      config._retries = retries + 1;
      const delay = Math.min(400 * Math.pow(2, retries), 3200); // 400ms → 800ms → 1600ms
      await new Promise(r => setTimeout(r, delay));
      return api.request(config);
    }

    return Promise.reject(err);
  }
);

// ── GET deduplication — reuse in-flight identical requests ────────────────────
// Prevents duplicate API calls when user rapidly navigates or components mount together.
const _pending = new Map<string, Promise<unknown>>();
const _originalGet = api.get.bind(api);

// @ts-expect-error — overriding with compatible signature
api.get = function deduplicatedGet(url: string, config?: AxiosRequestConfig) {
  // Key includes the current auth token — on a shared/kiosk device (e.g. /employee)
  // where one user logs out and another logs in while a request is still in-flight,
  // this prevents the second user's request from silently returning the first
  // user's cached in-flight response instead of issuing its own authenticated call.
  // responseType is part of the identity too: /export/inventory fetched as a
  // blob and as JSON are different requests, and sharing one in-flight promise
  // between them would hand the caller a body it can't parse.
  const token = Cookies.get('token') || '';
  const key = `GET::${token}::${config?.responseType ?? 'json'}::${url}::${JSON.stringify(config?.params ?? {})}`;
  const existing = _pending.get(key);
  if (existing) return existing;

  const promise = _originalGet(url, config).finally(() => {
    _pending.delete(key);
  });
  _pending.set(key, promise);
  return promise;
};

export default api;
