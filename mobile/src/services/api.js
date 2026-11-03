/**
 * API Service — כל קריאות ה-HTTP לשרת
 *
 * Token storage: react-native-keychain (encrypted hardware-backed store)
 * Falls back to AsyncStorage only when Keychain is unavailable (emulator/test).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { getApiUrl } from '../config';

const KEYCHAIN_SERVICE = 'house_of_business_auth';

// callback שנרשם מ-App.js — מבצע logout כשהשרת מחזיר 401
let _onUnauthorized = null;
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn; }

/**
 * Secure token helpers — prefer Keychain (hardware-backed), fallback to AsyncStorage.
 * On first call, migrates any existing AsyncStorage token to Keychain automatically.
 */
async function _saveToken(token) {
  try {
    await Keychain.setGenericPassword('token', token, { service: KEYCHAIN_SERVICE });
    await AsyncStorage.removeItem('token'); // remove plaintext copy after upgrade
  } catch {
    await AsyncStorage.setItem('token', token);
  }
}

async function _loadToken() {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (creds) return creds.password;
    // Migrate plaintext token from AsyncStorage on first run
    const legacy = await AsyncStorage.getItem('token');
    if (legacy) { await _saveToken(legacy); return legacy; }
    return null;
  } catch {
    return AsyncStorage.getItem('token');
  }
}

async function _clearToken() {
  try { await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE }); } catch { /* ignore */ }
  await AsyncStorage.removeItem('token');
}

export { _saveToken as saveToken, _loadToken as loadToken, _clearToken as clearToken };

// Hermes (React Native's default JS engine) has no global atob/btoa — decoding
// a JWT payload with atob() throws ReferenceError on every real device/build,
// which silently failed session restore (caught and treated as "no session")
// so users were forced to log in again on every app launch. Dependency-free
// base64url → UTF-8 string decoder, no polyfill package required.
const _B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// /uploads/:filename (gallery images) is auth-gated on the backend, but
// RN's <Image> can't send an Authorization header — same short-lived
// query-token workaround already shipped on the web frontend
// (web/src/hooks/useImgToken.ts). Cached at module scope, 10min refresh
// (backend TTL is 15min).
let _imgToken = null;
let _imgTokenAt = 0;
const IMG_TOKEN_REFRESH_MS = 10 * 60 * 1000;
export async function getCachedImgToken(apiInstance) {
  if (_imgToken && Date.now() - _imgTokenAt < IMG_TOKEN_REFRESH_MS) return _imgToken;
  const { token } = await apiInstance.getImgToken();
  _imgToken = token;
  _imgTokenAt = Date.now();
  return _imgToken;
}
export function withImgToken(url, token) {
  if (!url || !token || !url.includes('/uploads/')) return url;
  return url.includes('?') ? `${url}&token=${token}` : `${url}?token=${token}`;
}

export function decodeJwtPayload(token) {
  const b64url = token.split('.')[1];
  if (!b64url) throw new Error('Malformed JWT');
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = [];
  let buffer = 0, bits = 0;
  for (const ch of b64) {
    if (ch === '=') break;
    const val = _B64_CHARS.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // decodeURIComponent + escape gives a correct UTF-8 decode from raw bytes
  // without needing TextDecoder (also not guaranteed present in Hermes).
  const raw = bytes.map(b => String.fromCharCode(b)).join('');
  const json = decodeURIComponent(
    raw.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  );
  return JSON.parse(json);
}

const REQUEST_TIMEOUT_MS = 30_000; // 30s — matches backend timeout
const RETRY_STATUS       = new Set([429, 502, 503, 504]);
const MAX_RETRIES        = 2;

let _isRefreshing = false;
let _refreshQueue = []; // callbacks waiting for new token

function _drainRefreshQueue(token, err) {
  _refreshQueue.forEach(cb => cb(token, err));
  _refreshQueue = [];
}

class ApiService {
  async _getToken() {
    return _loadToken();
  }

  async _fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('הבקשה ארכה יותר מדי — נסה שנית');
        timeoutErr.status = 408;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, path, body = null, _attempt = 0) {
    const [token, baseUrl] = await Promise.all([this._getToken(), getApiUrl()]);

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    let res;
    try {
      res = await this._fetchWithTimeout(`${baseUrl}${path}`, options);
    } catch (networkErr) {
      // Retry on transient network failures (not timeouts)
      if (networkErr.status !== 408 && _attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, _attempt)));
        return this._request(method, path, body, _attempt + 1);
      }
      const err = new Error(networkErr.status === 408
        ? networkErr.message
        : `שגיאת חיבור — לא ניתן להגיע לשרת (${baseUrl})`);
      err.status = networkErr.status || 0;
      throw err;
    }

    // Retry on transient server errors (GET only — non-idempotent writes must not retry)
    if (RETRY_STATUS.has(res.status) && method === 'GET' && _attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, _attempt)));
      return this._request(method, path, body, _attempt + 1);
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 && path !== '/auth/refresh-token' && path !== '/auth/login') {
        // Try to silently refresh the token before giving up
        const newToken = await this._tryRefreshToken();
        if (newToken) {
          // Retry original request once with new token
          return this._request(method, path, body, _attempt);
        }
        // Refresh failed — clear session and redirect to login
        await _clearToken();
        await AsyncStorage.removeItem('business');
        if (_onUnauthorized) _onUnauthorized();
      }
      const err = new Error(data.error || `שגיאת שרת ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async _tryRefreshToken() {
    if (_isRefreshing) {
      // Another refresh is in flight — wait for it
      return new Promise((resolve) => {
        _refreshQueue.push((token) => resolve(token));
      });
    }
    _isRefreshing = true;
    try {
      const result = await this._request('POST', '/auth/refresh-token', null, 99); // sentinel to skip 401 loop
      if (result?.token) {
        await _saveToken(result.token);
        _drainRefreshQueue(result.token, null);
        return result.token;
      }
      _drainRefreshQueue(null, new Error('refresh failed'));
      return null;
    } catch {
      _drainRefreshQueue(null, new Error('refresh failed'));
      return null;
    } finally {
      _isRefreshing = false;
    }
  }

  get(path)         { return this._request('GET',    path); }
  post(path, body)  { return this._request('POST',   path, body); }
  put(path, body)   { return this._request('PUT',    path, body); }
  del(path)         { return this._request('DELETE', path); }

  // ── Auth ────────────────────────────────────────────────────
  login(email, password)           { return this.post('/auth/login',            { email, password }); }
  loginEmployee(username, password){ return this.post('/auth/login/employee',   { username, password }); }
  register(data)                   { return this.post('/auth/register',         data); }
  forgotPassword(email)            { return this.post('/auth/forgot-password',  { email }); }

  // ── Dashboard ───────────────────────────────────────────────
  getDashboard()                   { return this.get('/dashboard'); }
  getProfitLeaks()                 { return this.get('/dashboard/profit-leaks'); }
  getChart(days = 7)               { return this.get(`/dashboard/chart?days=${days}`); }
  getMenuEngineering(days = 30)    { return this.get(`/dashboard/menu-engineering?days=${days}`); }

  // ── POS ─────────────────────────────────────────────────────
  connectPOS(system, credentials)  { return this.post('/pos/connect', { system, credentials }); }
  syncPOS()                        { return this.post('/pos/sync', {}); }
  getPOSStatus()                   { return this.get('/pos/status'); }

  // ── Suppliers ───────────────────────────────────────────────
  getSuppliers()                   { return this.get('/suppliers'); }
  getSupplier(id)                  { return this.get(`/suppliers/${id}`); }
  createSupplier(data)             { return this.post('/suppliers', data); }
  updateSupplier(id, data)         { return this.put(`/suppliers/${id}`, data); }
  getDailyOrders()                 { return this.get('/suppliers/orders/daily'); }
  confirmOrder(supplierId, items)  { return this.post(`/suppliers/orders/daily/${supplierId}/confirm`, { items }); }
  skipOrder(supplierId)            { return this.post(`/suppliers/orders/daily/${supplierId}/skip`, {}); }

  // ── Invoices ────────────────────────────────────────────────
  getInvoices(params = {})         {
    const q = new URLSearchParams(params).toString();
    return this.get(`/invoices${q ? '?' + q : ''}`);
  }
  getInvoice(id)                   { return this.get(`/invoices/${id}`); }
  searchInvoices(query)            { return this.get(`/invoices/search?q=${encodeURIComponent(query)}`); }

  // ── Employees ───────────────────────────────────────────────
  getEmployees()                   { return this.get('/employees'); }
  createEmployee(data)             { return this.post('/employees', data); }
  updateEmployee(id, data)         { return this.put(`/employees/${id}`, data); }
  getActiveShifts()                { return this.get('/employees/shifts/active'); }
  getMyActiveShift()                { return this.get('/employees/shifts/my-active'); }
  getShifts(params = {})           {
    const q = new URLSearchParams(params).toString();
    return this.get(`/employees/shifts${q ? '?' + q : ''}`);
  }
  clockIn(lat, lng)                { return this.post('/employees/shifts/clock-in', { lat, lng }); }
  clockInQR(token)                  { return this.post('/employees/shifts/clock-in-qr', { token }); }
  clockOut()                       { return this.post('/employees/shifts/clock-out', {}); }
  getMonthlySummary(id, year, month){ return this.get(`/employees/${id}/shifts/monthly?year=${year}&month=${month}`); }
  getExpectedSalary(id)            { return this.get(`/employees/${id}/expected-salary`); }

  // ── Inventory ───────────────────────────────────────────────
  getInventory(params = {})        {
    const q = new URLSearchParams(params).toString();
    return this.get(`/inventory${q ? '?' + q : ''}`);
  }
  getInventoryValue()              { return this.get('/inventory/value'); }
  getWaste(days = 30)              { return this.get(`/inventory/waste?days=${days}`); }
  createInventoryItem(data)        { return this.post('/inventory', data); }
  updateInventoryItem(id, data)    { return this.put(`/inventory/${id}`, data); }
  recordTransaction(id, data)      { return this.post(`/inventory/${id}/transaction`, data); }
  getTransactions(params = {})     {
    const q = new URLSearchParams(params).toString();
    return this.get(`/inventory/transactions${q ? '?' + q : ''}`);
  }
  getInventoryCategories()         { return this.get('/inventory/categories'); }
  getExpiringItems(days = 7)       { return this.get(`/inventory/expiring?days=${days}`); }

  // ── Recipes ─────────────────────────────────────────────────
  getRecipes()                     { return this.get('/recipes'); }
  getRecipe(id)                    { return this.get(`/recipes/${id}`); }
  createRecipe(data)               { return this.post('/recipes', data); }
  updateRecipe(id, data)           { return this.put(`/recipes/${id}`, data); }
  deleteRecipe(id)                 { return this.del(`/recipes/${id}`); }
  getRecipeAnalysis()              { return this.get('/recipes/analysis'); }

  // ── Finance ─────────────────────────────────────────────────
  getDailyProfit(date)             { return this.get(`/finance/daily${date ? '?date=' + date : ''}`); }
  getCashflow(days = 30)           { return this.get(`/finance/cashflow?days=${days}`); }
  getForecast()                    { return this.get('/finance/forecast'); }
  getMonthlySummaryFinance(y, m)   { return this.get(`/finance/monthly?year=${y}&month=${m}`); }
  getExpenses(p = {})              { const q = new URLSearchParams(p).toString(); return this.get(`/finance/expenses${q ? '?' + q : ''}`); }
  createExpense(data)              { return this.post('/finance/expenses', data); }
  updateExpense(id, data)          { return this.put(`/finance/expenses/${id}`, data); }
  deleteExpense(id)                { return this.del(`/finance/expenses/${id}`); }

  // ── Audit ───────────────────────────────────────────────────
  getAuditScore()                  { return this.get('/audit/score'); }
  getAuditLatest()                 { return this.get('/audit/latest'); }
  runAudit()                       { return this.post('/audit/run', {}); }

  // ── AI ──────────────────────────────────────────────────────
  aiChat(message, isOffline)       { return this.post('/ai/chat', { message, isOffline }); }
  getAiHistory()                   { return this.get('/ai/history'); }
  clearAiHistory()                 { return this.del('/ai/history'); }

  // ── Notifications ───────────────────────────────────────────
  getNotifications()               { return this.get('/notifications'); }
  getUnreadCount()                 { return this.get('/notifications/unread-count'); }
  markRead(id)                     { return this.put(`/notifications/${id}/read`, {}); }
  markAllRead()                    { return this.put('/notifications/read-all', {}); }
  registerPushToken(fcmToken, platform) {
    return this.post('/notifications/token', { fcmToken, platform });
  }

  // ── Tasks & Reminders ───────────────────────────────────────
  getTasks(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/tasks${q ? '?' + q : ''}`);
  }
  getTask(id)                      { return this.get(`/tasks/${id}`); }
  createTask(data)                 { return this.post('/tasks', data); }
  updateTask(id, data)             { return this.put(`/tasks/${id}`, data); }
  completeTask(id)                 { return this.put(`/tasks/${id}`, { status: 'completed' }); }
  deleteTask(id)                   { return this.del(`/tasks/${id}`); }
  getReminders()                   { return this.get('/reminders'); }
  createReminder(data)             { return this.post('/reminders', data); }
  updateReminder(id, data)         { return this.put(`/reminders/${id}`, data); }
  deleteReminder(id)               { return this.del(`/reminders/${id}`); }
  snoozeReminder(id) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return this.put(`/reminders/${id}`, { remindAt: tomorrow });
  }

  // ── Customers / Loyalty ─────────────────────────────────────
  getCustomers(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/customers${q ? '?' + q : ''}`);
  }
  getCustomer(id)                  { return this.get(`/customers/${id}`); }
  createCustomer(data)             { return this.post('/customers', data); }
  updateCustomer(id, data)         { return this.put(`/customers/${id}`, data); }
  deleteCustomer(id)               { return this.del(`/customers/${id}`); }
  logCustomerVisit(id, data)       { return this.post(`/customers/${id}/visit`, data); }
  getCustomerStats()               { return this.get('/customers/stats'); }
  getLeaderboard()                 { return this.get('/customers/leaderboard'); }
  lookupCustomer(phone)            { return this.get(`/customers/lookup?phone=${encodeURIComponent(phone)}`); }
  getLoyaltySettings()             { return this.get('/customers/settings'); }
  updateLoyaltySettings(data)      { return this.put('/customers/settings', data); }

  // ── Weekly Reports ──────────────────────────────────────────
  getWeeklyReports()               { return this.get('/ai/weekly-report'); }
  getWeeklyReport(id)              { return this.get(`/ai/weekly-report${id ? '?id=' + id : ''}`); }
  generateWeeklyReport()           { return this.post('/ai/weekly-report/generate', {}); }

  // ── Reviews (batch analysis) ─────────────────────────────────
  getReviews()                     { return this.get('/reviews'); }
  analyzeReviews(data)             { return this.post('/reviews/analyze', data); }
  deleteReview(id)                 { return this.del(`/reviews/${id}`); }

  // ── Queue / Waitlist ────────────────────────────────────────
  getQueue()                       { return this.get('/queue'); }
  addToQueue(data)                 { return this.post('/queue', data); }
  markReady(id)                    { return this.put(`/queue/${id}/ready`, {}); }
  removeFromQueue(id)              { return this.del(`/queue/${id}`); }
  getQueueSettings()               { return this.get('/queue/settings'); }

  // ── Price Comparison ────────────────────────────────────────
  comparePrices(query)             { return this.post('/price-comparison/search', { searchQuery: query }); }
  getPriceHistory()                { return this.get('/price-comparison/history'); }
  exportPriceHistory()             { return this.get('/price-comparison/export', { responseType: 'blob' }); }

  // ── Gallery ─────────────────────────────────────────────────
  getGallery(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/gallery${q ? '?' + q : ''}`);
  }
  deleteGalleryItem(id)            { return this.del(`/gallery/${id}`); }
  getImgToken()                    { return this.post('/auth/img-token', {}); }

  // ── Payroll ─────────────────────────────────────────────────
  getPayslips(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/payroll${q ? '?' + q : ''}`);
  }
  getPayslip(id)                   { return this.get(`/payroll/${id}`); }
  generatePayslips(month, year)    { return this.post('/payroll/generate', { month, year }); }
  getPayrollSummary(month, year)   { return this.get(`/payroll/summary?month=${month}&year=${year}`); }

  // ── Z-Reports / POS Sales ───────────────────────────────────
  getZReports(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/zreport/summary${q ? '?' + q : ''}`);
  }
  getZReportStatus()               { return this.get('/zreport/status'); }
  importZReport(formData)          { return this.post('/zreport/import', formData); }
  getSalesHistory(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/pos/sales${q ? '?' + q : ''}`);
  }

  // ── Menu Engineering ────────────────────────────────────────
  getMenuAnalysis()                { return this.get('/recipes/analysis'); }
  getMenuTopActions()              { return this.get('/ai/menu-insights'); }
}

export default new ApiService();
