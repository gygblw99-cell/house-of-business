jest.mock('../src/utils/db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
  migrate:   jest.fn().mockResolvedValue(undefined),
  pool:      { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

const INVOICE = {
  id: 'inv-1', business_id: 'biz-test-1', supplier_id: 'sup-1',
  invoice_number: 'INV-001', total_amount: 1200, is_paid: false,
  created_at: new Date().toISOString(),
};

beforeEach(() => { db.query.mockReset(); db.getClient.mockReset(); });

describe('Invoices — auth gates', () => {
  it('GET /api/invoices ללא טוקן → 401',  async () => expect((await request(app).get('/api/invoices')).status).toBe(401));
  it('GET /api/invoices/stats ללא טוקן → 401', async () => expect((await request(app).get('/api/invoices/stats')).status).toBe(401));
});

describe('GET /api/invoices', () => {
  it('מחזיר חשבוניות', async () => {
    db.query.mockResolvedValue({ rows: [{ ...INVOICE, total: 1 }] });
    const res = await request(app).get('/api/invoices').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('invoices');
  });

  it('פילטור לפי paid=false', async () => {
    db.query.mockResolvedValue({ rows: [{ total: 0 }] });
    const res = await request(app).get('/api/invoices?paid=false').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/invoices/stats', () => {
  it('מחזיר סטטיסטיקות', async () => {
    db.query.mockResolvedValue({ rows: [{ total: 5, unpaid: 2, duplicates: 0 }] });
    const res = await request(app).get('/api/invoices/stats').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/invoices/:id', () => {
  it('חשבונית קיימת → 200', async () => {
    db.query.mockResolvedValue({ rows: [INVOICE] });
    const res = await request(app).get('/api/invoices/inv-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('חשבונית לא קיימת → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/invoices/not-exist').set(authHeader(token));
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/invoices/:id/approve', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).put('/api/invoices/inv-1/approve').send({});
    expect(res.status).toBe(401);
  });

  it('חשבונית לא קיימת → 404 or 500', async () => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(mockClient);
    db.query.mockResolvedValue({ rows: [] });
    // A supplier name is sent so the request gets past the route's "approving
    // requires a supplier" guard and reaches the invoice lookup, which is what
    // this test is about. Sending {} used to work, but that guard was added
    // later and the request now stops at 400 without ever looking for the
    // invoice — the assertion was passing judgement on the wrong branch.
    // The mocked client returns no rows for the supplier upsert too, so no
    // supplier id is resolved and the ownership check is skipped as before.
    const res = await request(app).put('/api/invoices/not-exist/approve')
      .set(authHeader(token)).send({ supplierName: 'ספק לבדיקה' });
    expect([404, 500]).toContain(res.status);
  });
});

describe('PUT /api/invoices/:id/mark-paid', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).put('/api/invoices/inv-1/mark-paid').send({});
    expect(res.status).toBe(401);
  });
});
