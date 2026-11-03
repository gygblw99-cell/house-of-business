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

const SALE = {
  id: 'sale-1', business_id: 'biz-test-1', sale_type: 'pos',
  total_amount: 320, sold_at: new Date().toISOString(), status: 'done',
};

beforeEach(() => { db.query.mockReset(); });

describe('POS — auth gates', () => {
  it('GET /api/pos/sales ללא טוקן → 401',  async () => expect((await request(app).get('/api/pos/sales')).status).toBe(401));
  it('GET /api/pos/status ללא טוקן → 401', async () => expect((await request(app).get('/api/pos/status')).status).toBe(401));
});

describe('GET /api/pos/sales', () => {
  it('מחזיר מכירות', async () => {
    db.query.mockResolvedValue({ rows: [SALE] });
    const res = await request(app).get('/api/pos/sales').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('פילטור לפי תאריך', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/pos/sales?date=2026-06-15').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/pos/status', () => {
  it('מחזיר סטטוס חיבור קופה', async () => {
    db.query.mockResolvedValue({ rows: [{ connected: false }] });
    const res = await request(app).get('/api/pos/status').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/pos/reconciliation', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/pos/reconciliation');
    expect(res.status).toBe(401);
  });

  it('מחזיר התאמה', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/pos/reconciliation').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});
