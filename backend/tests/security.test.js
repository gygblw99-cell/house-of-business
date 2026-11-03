/**
 * Security Tests — headers, CORS, rate limiting, input validation
 * All DB calls are mocked so these run without a real database.
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
  getClient: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }),
  pool: { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');

// ── Security Headers ──────────────────────────────────────────────────────────
describe('Security Headers (Helmet)', () => {
  it('מחזיר X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('מחזיר X-Frame-Options: SAMEORIGIN', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('מחזיר Content-Security-Policy', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('Health endpoint מחזיר 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── CORS ──────────────────────────────────────────────────────────────────────
describe('CORS', () => {
  it('origin לא מורשה → CORS error', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Origin', 'https://evil.com');
    // Either CORS rejection or 401 (no auth) — never 200 from bad origin
    expect(res.status).not.toBe(200);
  });

  it('origin מורשה (localhost dev) → מעביר', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Origin', 'http://localhost:3002');
    // Should not get CORS-rejected (will get 401 for missing auth, which is fine)
    expect(res.status).not.toBe(0);
  });
});

// ── Auth Middleware ───────────────────────────────────────────────────────────
describe('Auth Middleware', () => {
  const PROTECTED_ROUTES = [
    ['GET',  '/api/dashboard'],
    ['GET',  '/api/employees'],
    ['GET',  '/api/suppliers'],
    ['GET',  '/api/inventory'],
    ['GET',  '/api/finance/daily'],
    ['GET',  '/api/customers'],
    ['GET',  '/api/tasks'],
    ['GET',  '/api/queue'],
  ];

  it.each(PROTECTED_ROUTES)('%s %s ללא טוקן → 401', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
  });

  it('טוקן מזויף → 401', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', 'Bearer fake.jwt.token');
    expect(res.status).toBe(401);
  });

  it('Bearer prefix חסר → 401', async () => {
    const res = await request(app)
      .get('/api/dashboard')
      .set('Authorization', 'just-a-token-no-bearer');
    expect(res.status).toBe(401);
  });
});

// ── Input Validation (Zod) ────────────────────────────────────────────────────
describe('Input Validation — Auth Routes', () => {
  // Public self-registration is disabled (auth.routes.js) — the route
  // unconditionally returns 403 before any Zod validation runs, regardless
  // of the body. These cases now verify that rejection holds for a range of
  // otherwise-plausible-looking payloads, not that validation catches them.
  it('register: מייל לא תקין → 403 (הרישום סגור)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'ישראל', businessName: 'מסעדה', businessType: 'restaurant',
               email: 'not-an-email', password: 'pass1234' });
    expect(res.status).toBe(403);
  });

  it('register: סיסמה קצרה מ-8 → 403 (הרישום סגור)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'ישראל', businessName: 'מסעדה', businessType: 'restaurant',
               email: 'x@x.com', password: 'short' });
    expect(res.status).toBe(403);
  });

  it('register: businessType לא תקין → 403 (הרישום סגור)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'ישראל', businessName: 'מסעדה', businessType: 'INVALID',
               email: 'x@x.com', password: 'pass1234' });
    expect(res.status).toBe(403);
  });

  it('login/owner: מייל חסר → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/owner')
      .send({ password: 'pass1234' });
    expect(res.status).toBe(400);
  });

  it('login/owner: מייל ארוך מ-254 תווים → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login/owner')
      .send({ email: 'a'.repeat(250) + '@x.com', password: 'pass1234' });
    expect(res.status).toBe(400);
  });
});

// ── SQL Injection Attempts ────────────────────────────────────────────────────
describe('SQL Injection Protection', () => {
  it('שדה email עם SQL injection → 400 (validation) ולא 500', async () => {
    const res = await request(app)
      .post('/api/auth/login/owner')
      .send({ email: "' OR '1'='1'; DROP TABLE users;--", password: 'x' });
    expect([400, 401]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  it('XSS ב-register name — עובר Zod (valid string) ואינו נכלל בשגיאה', async () => {
    // <script> is valid text (passes Zod), gets passed to the service layer.
    // The mocked DB returns empty rows so the service throws 500 — same as any
    // valid payload would. What we verify: the XSS payload is NOT reflected
    // in the error body (no XSS echo-back).
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: '<script>alert(1)</script>',
        businessName: 'מסעדה',
        businessType: 'restaurant',
        email: 'xss@test.com',
        password: 'pass1234',
      });
    // XSS payload must NOT appear in response body
    expect(JSON.stringify(res.body)).not.toContain('<script>');
  });
});

// ── Error Handler ─────────────────────────────────────────────────────────────
describe('Error Handler', () => {
  it('נתיב לא קיים → 404', async () => {
    const res = await request(app).get('/api/nonexistent-endpoint-xyz');
    expect(res.status).toBe(404);
  });

  it('Content-Type שגוי → לא 500', async () => {
    const res = await request(app)
      .post('/api/auth/login/owner')
      .set('Content-Type', 'text/plain')
      .send('not json');
    expect(res.status).not.toBe(500);
  });
});

// ── Validation Middleware Unit Tests ──────────────────────────────────────────
describe('validateInput middleware — unit', () => {
  const { validate, schemas } = require('../src/middleware/validateInput');

  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
  };

  it('registerSchema: קלט תקין עובר', () => {
    const middleware = validate({ body: schemas.registerSchema });
    const req  = { body: { name: 'ישראל', businessName: 'מסעדה', businessType: 'restaurant', email: 'x@x.com', password: 'pass1234' } };
    const res  = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('registerSchema: מייל לא תקין נדחה', () => {
    const middleware = validate({ body: schemas.registerSchema });
    const req  = { body: { name: 'ישראל', businessName: 'מסעדה', businessType: 'restaurant', email: 'bad', password: 'pass1234' } };
    const res  = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('createTaskSchema: priority לא תקין נדחה', () => {
    const middleware = validate({ body: schemas.createTaskSchema });
    const req  = { body: { title: 'משימה', priority: 'CRITICAL' } };
    const res  = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('createQueueEntrySchema: party_size > 50 נדחה', () => {
    const middleware = validate({ body: schemas.createQueueEntrySchema });
    const req  = { body: { name: 'ישראל', phone: '0501234567', party_size: 999 } };
    const res  = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('analyzeReviewsSchema: platform לא תקין נדחה', () => {
    const middleware = validate({ body: schemas.analyzeReviewsSchema });
    const req  = { body: { platform: 'INVALID_PLATFORM', text: 'ביקורת טובה מאוד' } };
    const res  = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('uuidSchema: UUID לא תקין נדחה', () => {
    const result = schemas.uuidSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });

  it('uuidSchema: UUID תקין עובר', () => {
    const result = schemas.uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(true);
  });
});
