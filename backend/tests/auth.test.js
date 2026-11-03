/**
 * Auth API Tests
 */

// Mock DB so tests run without a real database connection
jest.mock('../src/utils/db', () => ({
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
  pool:    { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');

// Public self-registration is disabled (see auth.routes.js) — new businesses
// are created by admin only, so the route unconditionally rejects with 403
// regardless of the body. Input-validation scenarios no longer apply here.
describe('POST /api/auth/register — disabled', () => {
  it('כל בקשה → 403 (הרישום העצמי סגור)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@test.com' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/login', () => {
  it('אישורים שגויים → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'notexist_user', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('שדות חסרים → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'notexist@test.com' });
    expect(res.status).toBe(400);
  });

  it('מייל ארוך מדי (>254) → 400', async () => {
    const longEmail = 'a'.repeat(250) + '@x.com';
    const res = await request(app)
      .post('/api/auth/login/owner')
      .send({ email: longEmail, password: 'pass123' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/me — ללא אימות', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('טוקן לא תקין → 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/auth/change-password — ללא אימות', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app)
      .put('/api/auth/change-password')
      .send({ currentPassword: 'old', newPassword: 'newpass123' });
    expect(res.status).toBe(401);
  });
});
