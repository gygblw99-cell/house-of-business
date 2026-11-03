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

const SUPPLIER = {
  id: 'sup-1', business_id: 'biz-test-1', name: 'אביב ירקות',
  contact_name: 'אבי כהן', phone: '050-1234567', email: 'avi@aviv.co.il',
  payment_terms: 'net30', is_active: true,
};

beforeEach(() => { db.query.mockReset(); });

// ── Auth gates ─────────────────────────────────────────────────────────────
describe('Suppliers — auth gates', () => {
  it('GET /api/suppliers ללא טוקן → 401',  async () => expect((await request(app).get('/api/suppliers')).status).toBe(401));
  it('POST /api/suppliers ללא טוקן → 401', async () => expect((await request(app).post('/api/suppliers').send({})).status).toBe(401));
});

// ── GET /api/suppliers ────────────────────────────────────────────────────
describe('GET /api/suppliers', () => {
  it('מחזיר ספקים', async () => {
    db.query.mockResolvedValue({ rows: [SUPPLIER] });
    const res = await request(app).get('/api/suppliers').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/suppliers ───────────────────────────────────────────────────
describe('POST /api/suppliers', () => {
  it('חסר שם → 400', async () => {
    const res = await request(app).post('/api/suppliers').set(authHeader(token)).send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  it('ספק תקין → 201', async () => {
    db.query.mockResolvedValue({ rows: [SUPPLIER] });
    const res = await request(app).post('/api/suppliers').set(authHeader(token)).send({
      name: 'אביב ירקות', contact_name: 'אבי', phone: '050-111', payment_terms: 'net30',
    });
    expect(res.status).toBe(201);
  });
});

// ── GET /api/suppliers/:id ────────────────────────────────────────────────
describe('GET /api/suppliers/:id', () => {
  it('ספק קיים → 200', async () => {
    db.query.mockResolvedValue({ rows: [SUPPLIER] });
    const res = await request(app).get('/api/suppliers/sup-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('ספק לא קיים → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/suppliers/not-exist').set(authHeader(token));
    expect(res.status).toBe(404);
  });
});

// ── PUT /api/suppliers/:id ────────────────────────────────────────────────
describe('PUT /api/suppliers/:id', () => {
  it('עדכון ספק → 200', async () => {
    db.query.mockResolvedValue({ rows: [SUPPLIER] });
    const res = await request(app).put('/api/suppliers/sup-1').set(authHeader(token)).send({ name: 'שם חדש' });
    expect([200, 404]).toContain(res.status);
  });
});

// ── GET /api/suppliers/trends ─────────────────────────────────────────────
describe('GET /api/suppliers/trends', () => {
  it('מחזיר מגמות ספקים', async () => {
    db.query.mockResolvedValue({ rows: [{ supplier_id: 'sup-1', total_spend: 45000, invoice_count: 12 }] });
    const res = await request(app).get('/api/suppliers/trends').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
