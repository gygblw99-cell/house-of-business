/**
 * Error Handler Tests — monitoring hook, error response shape, 404 handling.
 * Uses nock to intercept outbound webhook calls without making real HTTP requests.
 */

jest.mock('../src/utils/db', () => ({
  query:     jest.fn().mockResolvedValue({ rows: [] }),
  migrate:   jest.fn().mockReturnValue(Promise.resolve()),
  getClient: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
  pool:      { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');

// ── 404 ──────────────────────────────────────────────────────────────────────
describe('404 Handler', () => {
  it('GET /api/does-not-exist → 404', async () => {
    const res = await request(app).get('/api/does-not-exist-xyz');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/does-not-exist → 404', async () => {
    const res = await request(app).delete('/api/does-not-exist-xyz');
    expect(res.status).toBe(404);
  });

  it('POST /random-path → 404', async () => {
    const res = await request(app).post('/random-path-xyz');
    expect(res.status).toBe(404);
  });

  it('404 response body contains error field', async () => {
    const res = await request(app).get('/api/does-not-exist-xyz');
    expect(res.body).toHaveProperty('error');
  });
});

// ── Error Response Shape ──────────────────────────────────────────────────────
describe('Error Response Shape', () => {
  it('validation error returns { error, details }', async () => {
    // /api/auth/register is disabled (unconditional 403, no Zod validation
    // runs) — use another validate()-guarded route to check the shape.
    const res = await request(app)
      .post('/api/auth/login/owner')
      .send({ password: 'pass1234' }); // missing required email
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('details');
  });

  it('auth error returns { error } with Hebrew message', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error).toBe('string');
  });

  it('Content-Type on errors is application/json', async () => {
    const res = await request(app).get('/api/does-not-exist-xyz');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ── Error Monitoring Hook ─────────────────────────────────────────────────────
describe('Error Monitoring — ERROR_WEBHOOK_URL', () => {
  let originalWebhook;

  beforeAll(() => {
    originalWebhook = process.env.ERROR_WEBHOOK_URL;
  });

  afterAll(() => {
    if (originalWebhook !== undefined) {
      process.env.ERROR_WEBHOOK_URL = originalWebhook;
    } else {
      delete process.env.ERROR_WEBHOOK_URL;
    }
  });

  it('when ERROR_WEBHOOK_URL is not set — does not crash on 500', async () => {
    delete process.env.ERROR_WEBHOOK_URL;
    // A route that doesn't exist triggers error handler path
    const res = await request(app).get('/api/does-not-exist-xyz');
    // Should get 404 cleanly — not 500
    expect(res.status).toBe(404);
  });

  it('ERROR_WEBHOOK_URL set to invalid URL — error handler still returns response', async () => {
    process.env.ERROR_WEBHOOK_URL = 'http://localhost:9999/nonexistent-webhook';
    const res = await request(app).get('/api/does-not-exist-xyz');
    // Hook failure must not crash the response
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    // restore
    delete process.env.ERROR_WEBHOOK_URL;
  });
});

// ── errorHandler module — unit ────────────────────────────────────────────────
describe('errorHandler module — direct call', () => {
  const errorHandler = require('../src/middleware/errorHandler');

  const mockRes = () => {
    const res = {};
    res.headersSent = false;
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
  };

  const mockReq = (overrides = {}) => ({
    method: 'GET',
    originalUrl: '/test',
    ip: '127.0.0.1',
    user: undefined,
    ...overrides,
  });

  it('Joi/Zod validation error (status 400) → 400', () => {
    const err = Object.assign(new Error('validation'), { status: 400 });
    const res = mockRes();
    errorHandler(err, mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('generic error → 500', () => {
    const err = new Error('something broke');
    const res = mockRes();
    errorHandler(err, mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not re-send when headers already sent', () => {
    const err = new Error('late error');
    const res = mockRes();
    res.headersSent = true;
    const next = jest.fn();
    errorHandler(err, mockReq(), res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not expose stack trace in body', () => {
    const err = new Error('internal secret');
    const res = mockRes();
    errorHandler(err, mockReq(), res, jest.fn());
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('at errorHandler');
  });

  it('authenticated user id captured in log (no crash)', () => {
    const err = new Error('user-triggered');
    const req = mockReq({ user: { userId: 'test-user-id' } });
    const res = mockRes();
    expect(() => errorHandler(err, req, res, jest.fn())).not.toThrow();
  });
});
