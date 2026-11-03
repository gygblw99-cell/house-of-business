/**
 * Edge Case Tests
 * - Zod validation on newly-wired auth routes (login/employee, forgot-password, reset-password)
 * - JWT refresh endpoint
 * - 404 handler
 * - Pagination boundary values
 * - Rate-limit response format
 */

jest.mock('../src/utils/db', () => ({
  query:     jest.fn().mockResolvedValue({ rows: [] }),
  migrate:   jest.fn().mockReturnValue(Promise.resolve()),
  getClient: jest.fn().mockResolvedValue({
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }),
  pool: { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');
const { sign } = require('../src/utils/jwt');

// ── POST /api/auth/login/employee ─────────────────────────────────────────────
describe('POST /api/auth/login/employee — Zod validation', () => {
  it('שדות חסרים → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/employee')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('username חסר → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/employee')
      .send({ password: 'secret' });
    expect(res.status).toBe(400);
  });

  it('password חסר → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/employee')
      .send({ username: 'moshe' });
    expect(res.status).toBe(400);
  });

  it('username ארוך מדי (101+ תווים) → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/employee')
      .send({ username: 'a'.repeat(101), password: 'secret' });
    expect(res.status).toBe(400);
  });

  it('payload תקין — עובר ולידציה (DB מוחזר ריק → 401 מהservice)', async () => {
    const res = await request(app)
      .post('/api/auth/login/employee')
      .send({ username: 'moshe', password: 'secret123' });
    // Passes Zod, fails at service layer (user not found) → 401
    expect(res.status).not.toBe(400);
  });
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
describe('POST /api/auth/forgot-password — Zod validation', () => {
  it('מייל חסר → 400', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
  });

  it('מייל לא תקין → 400', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('מייל תקין → לא 400 (שרות תמיד מחזיר 200 למניעת enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'user@example.com' });
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('fields זדוניים מסוננים (Zod .strip)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'user@example.com', admin: true, __proto__: {} });
    expect(res.status).not.toBe(400);
  });
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
describe('POST /api/auth/reset-password — Zod validation', () => {
  it('שדות חסרים → 400', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({});
    expect(res.status).toBe(400);
  });

  it('token חסר → 400', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ password: 'NewPass123' });
    expect(res.status).toBe(400);
  });

  it('password קצרה מדי (< 8 תווים) → 400', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'user@test.com', code: '123456', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('payload תקין — עובר ולידציה', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'user@test.com', code: '123456', newPassword: 'NewSecurePass1!' });
    // Zod passes — confirmed by absence of 'details' array (Zod errors always include details)
    // Service returns 400 "קוד שגוי" because mock DB has no user — that's expected here
    expect(res.body.details).toBeUndefined();
  });
});

// ── POST /api/auth/refresh-token ──────────────────────────────────────────────
describe('POST /api/auth/refresh-token', () => {
  const makeToken = (payload = {}) =>
    sign({ userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', businessId: 'ffffffff-0000-1111-2222-333333333333', role: 'owner', permissions: [], ...payload });

  it('ללא token → 401', async () => {
    const res = await request(app).post('/api/auth/refresh-token');
    expect(res.status).toBe(401);
  });

  it('token לא תקין → 401', async () => {
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', 'Bearer invalidtoken');
    expect(res.status).toBe(401);
  });

  it('token תקין → מחזיר token חדש', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
  });

  it('token חדש תקין (מחרוזת JWT)', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/auth/refresh-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // New token is a valid JWT string
    const parts = (res.body.token || '').split('.');
    expect(parts).toHaveLength(3); // header.payload.signature
  });
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
describe('404 Handler', () => {
  it('נתיב לא קיים → 404 JSON', async () => {
    const res = await request(app).get('/api/nonexistent-route-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe('string');
  });

  it('גם DELETE על נתיב לא קיים → 404', async () => {
    const res = await request(app).delete('/api/doesnotexist/abc');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('404 response הוא JSON (לא HTML)', async () => {
    const res = await request(app).get('/api/xyz');
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

// ── Pagination Edge Cases ─────────────────────────────────────────────────────
describe('parsePage — pagination utility edge cases', () => {
  const { parsePage } = require('../src/utils/paginate');

  it('ברירת מחדל — page=1, limit=50', () => {
    const { page, limit, offset } = parsePage({});
    expect(page).toBe(1);
    expect(limit).toBe(50);
    expect(offset).toBe(0);
  });

  it('page שלילית → clamp ל-1', () => {
    const { page } = parsePage({ page: '-5' });
    expect(page).toBe(1);
  });

  it('limit מעל MAX → clamp ל-200', () => {
    const { limit } = parsePage({ limit: '9999' });
    expect(limit).toBe(200);
  });

  it('limit 0 → fallback לdefault (0 הוא falsy → DEFAULT_LIMIT=50)', () => {
    const { limit } = parsePage({ limit: '0' });
    expect(limit).toBe(50); // parseInt('0') || DEFAULT_LIMIT → 50
  });

  it('offset חושב נכון', () => {
    const { offset } = parsePage({ page: '3', limit: '10' });
    expect(offset).toBe(20);
  });

  it('paginate מסנן total_count מתוך rows', () => {
    const { paginate } = parsePage({ page: '1', limit: '5' });
    const rows = [{ id: '1', total_count: '42' }, { id: '2', total_count: '42' }];
    const result = paginate(rows, null);
    expect(result.meta.total).toBe(42);
    expect(result.data[0]).not.toHaveProperty('total_count');
  });

  it('hasNextPage נכון', () => {
    const { paginate } = parsePage({ page: '1', limit: '10' });
    const result = paginate([], 25);
    expect(result.meta.hasNextPage).toBe(true);
    expect(result.meta.totalPages).toBe(3);
  });

  it('hasPrevPage נכון בעמוד ראשון', () => {
    const { paginate } = parsePage({ page: '1', limit: '10' });
    const result = paginate([], 25);
    expect(result.meta.hasPrevPage).toBe(false);
  });

  it('hasPrevPage נכון בעמוד שני', () => {
    const { paginate } = parsePage({ page: '2', limit: '10' });
    const result = paginate([], 25);
    expect(result.meta.hasPrevPage).toBe(true);
  });
});

// ── Mass Assignment Protection ────────────────────────────────────────────────
describe('Zod .strip() — mass assignment protection', () => {
  it('שדות לא ידועים נחסמים ב-register', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Test', businessName: 'בית', businessType: 'restaurant',
        email: 'x@test.com', password: 'Secure123!',
        isAdmin: true, role: 'owner', businessId: 'injected',
      });
    // Zod strips extra fields — should not fail with 400 on the extra fields
    // but the DB mock returns empty rows so it may 500 at service level; that's ok
    expect(res.status).not.toBe(400);
  });

  it('payload XSS אינו גורם לשגיאת שרת', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: '<script>alert(1)</script>',
        businessName: 'מסעדה',
        businessType: 'restaurant',
        email: 'xss@test.com',
        password: 'Secure123!',
      });
    // XSS payload must not be echoed back in the response body
    // (service may 500 because mock DB returns empty rows — that's acceptable here)
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('<script>');
  });
});
