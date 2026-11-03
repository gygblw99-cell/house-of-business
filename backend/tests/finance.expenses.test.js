/**
 * Finance — Expenses & Income Routes (CRUD success paths)
 * Tests the write endpoints with proper DB mock data.
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache', () => ({
  get:  jest.fn().mockResolvedValue(null),
  set:  jest.fn().mockResolvedValue(undefined),
  del:  jest.fn().mockResolvedValue(undefined),
  wrap: jest.fn((k, fn) => fn()),
}));
jest.mock('../src/utils/eventBus', () => ({
  publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn(),
}));
jest.mock('../src/services/finance/cashflow.service', () => ({
  getDailyProfit:    jest.fn().mockResolvedValue({}),
  getCashflow:       jest.fn().mockResolvedValue([]),
  getForecast:       jest.fn().mockResolvedValue([]),
  getForecast90:     jest.fn().mockResolvedValue([]),
  getMonthlySummary: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

// ── GET /api/finance/expenses ─────────────────────────────────
describe('GET /api/finance/expenses', () => {
  it('מחזיר רשימת הוצאות', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'e1', name: 'שכירות', amount: 5000, frequency: 'monthly', is_active: true },
      { id: 'e2', name: 'חשמל',   amount: 800,  frequency: 'monthly', is_active: true },
    ]});
    const res = await request(app).get('/api/finance/expenses').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/finance/expenses');
    expect(res.status).toBe(401);
  });
});

// ── POST /api/finance/expenses ────────────────────────────────
describe('POST /api/finance/expenses', () => {
  it('יוצר הוצאה → 201 + data', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      id: 'new-e1', name: 'שכירות', amount: 5000, frequency: 'monthly', business_id: 'biz-1',
    }]});
    const res = await request(app)
      .post('/api/finance/expenses')
      .set(authHeader(token))
      .send({ name: 'שכירות', amount: 5000, frequency: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('שכירות');
  });

  it('שדות חסרים (name) → 400', async () => {
    const res = await request(app)
      .post('/api/finance/expenses')
      .set(authHeader(token))
      .send({ amount: 500 });
    expect(res.status).toBe(400);
  });

  it('שדות חסרים (amount) → 400', async () => {
    const res = await request(app)
      .post('/api/finance/expenses')
      .set(authHeader(token))
      .send({ name: 'שכר', frequency: 'monthly' });
    expect(res.status).toBe(400);
  });

  it('frequency לא חוקית → 400', async () => {
    const res = await request(app)
      .post('/api/finance/expenses')
      .set(authHeader(token))
      .send({ name: 'שכר', amount: 100, frequency: 'invalid_freq' });
    expect(res.status).toBe(400);
  });
});

// ── PUT /api/finance/expenses/:id ─────────────────────────────
describe('PUT /api/finance/expenses/:id', () => {
  it('מעדכן הוצאה קיימת → 200', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'שכירות', amount: 6000 }] });
    const res = await request(app)
      .put('/api/finance/expenses/e1')
      .set(authHeader(token))
      .send({ amount: 6000 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(6000);
  });

  it('הוצאה לא קיימת → 404', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .put('/api/finance/expenses/nonexistent')
      .set(authHeader(token))
      .send({ amount: 100 });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/finance/expenses/:id ──────────────────────────
describe('DELETE /api/finance/expenses/:id', () => {
  it('מוחק הוצאה → 200', async () => {
    // rowCount, not just rows: the route returns 404 when the DELETE matched
    // nothing, which is the correct behaviour and what this mock was
    // accidentally describing.
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app)
      .delete('/api/finance/expenses/e1')
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
  });
});

// ── GET /api/finance/income ───────────────────────────────────
describe('GET /api/finance/income', () => {
  it('מחזיר הכנסות ידניות', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'i1', amount: 2000, description: 'הכנסה פרטית', income_date: '2026-06-01' },
    ]});
    const res = await request(app).get('/api/finance/income').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── POST /api/finance/income ──────────────────────────────────
describe('POST /api/finance/income', () => {
  it('יוצר הכנסה → 201', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      id: 'new-i1', amount: 1500, description: 'הכנסה נוספת', business_id: 'biz-1',
    }]});
    const res = await request(app)
      .post('/api/finance/income')
      .set(authHeader(token))
      .send({ amount: 1500, description: 'הכנסה נוספת' });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1500);
  });

  it('שדות חסרים → 400', async () => {
    const res = await request(app)
      .post('/api/finance/income')
      .set(authHeader(token))
      .send({ amount: 100 });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/finance/income/:id ────────────────────────────
describe('DELETE /api/finance/income/:id', () => {
  it('מוחק הכנסה → 200', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/api/finance/income/i1')
      .set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/finance/monthly ──────────────────────────────────
describe('GET /api/finance/monthly', () => {
  it('מחזיר סיכום חודשי', async () => {
    const res = await request(app).get('/api/finance/monthly').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
