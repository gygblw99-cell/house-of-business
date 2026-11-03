jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

const CUSTOMER = {
  id: 'cust-1', business_id: 'biz-test-1', name: 'רחל לוי',
  phone: '054-7777777', email: 'rachel@test.com', visit_count: 5, total_spent: 1200,
};
const REVIEW = {
  id: 'rev-1', business_id: 'biz-test-1', customer_name: 'רחל לוי',
  rating: 5, comment: 'מעולה!', platform: 'google', created_at: new Date().toISOString(),
};

beforeEach(() => { db.query.mockReset(); });

// ── Auth gates ─────────────────────────────────────────────────────────────
describe('Customers — auth gates', () => {
  it('GET /api/customers ללא טוקן → 401',  async () => expect((await request(app).get('/api/customers')).status).toBe(401));
  it('GET /api/reviews ללא טוקן → 401',    async () => expect((await request(app).get('/api/reviews')).status).toBe(401));
});

// ── GET /api/customers ────────────────────────────────────────────────────
describe('GET /api/customers', () => {
  it('מחזיר לקוחות', async () => {
    db.query.mockResolvedValue({ rows: [CUSTOMER] });
    const res = await request(app).get('/api/customers').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('חיפוש בשם', async () => {
    db.query.mockResolvedValue({ rows: [CUSTOMER] });
    const res = await request(app).get('/api/customers').query({ search: 'rachel' }).set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/customers/stats ──────────────────────────────────────────────
describe('GET /api/customers/stats', () => {
  it('מחזיר סטטיסטיקות', async () => {
    db.query.mockResolvedValue({ rows: [{ total_customers: 120, new_this_month: 15, visits_today: 5 }] });
    const res = await request(app).get('/api/customers/stats').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/reviews ──────────────────────────────────────────────────────
describe('GET /api/reviews', () => {
  it('מחזיר ביקורות', async () => {
    db.query.mockResolvedValue({ rows: [REVIEW] });
    const res = await request(app).get('/api/reviews').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/customers/:id ────────────────────────────────────────────────
describe('GET /api/customers/:id', () => {
  it('לקוח קיים → 200', async () => {
    db.query.mockResolvedValue({ rows: [CUSTOMER] });
    const res = await request(app).get('/api/customers/cust-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('לקוח לא קיים → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/customers/not-exist').set(authHeader(token));
    expect(res.status).toBe(404);
  });
});
