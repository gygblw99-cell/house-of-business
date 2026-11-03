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

const ENTRY = {
  id: 'q-1', business_id: 'biz-test-1', customer_name: 'שרה כהן',
  phone: '052-9999999', party_size: 3, status: 'waiting', position: 1,
};

function mockClient(rows = [ENTRY]) {
  const client = {
    query:   jest.fn().mockResolvedValue({ rows }),
    release: jest.fn(),
  };
  db.getClient.mockResolvedValue(client);
  return client;
}

beforeEach(() => { db.query.mockReset(); db.getClient.mockReset(); });

// ── Auth gates ─────────────────────────────────────────────────────────────
describe('Queue — auth gates', () => {
  it('GET /api/queue ללא טוקן → 401',  async () => expect((await request(app).get('/api/queue')).status).toBe(401));
  it('POST /api/queue ללא טוקן → 401', async () => expect((await request(app).post('/api/queue').send({})).status).toBe(401));
});

// ── GET /api/queue ─────────────────────────────────────────────────────────
describe('GET /api/queue', () => {
  it('מחזיר תור', async () => {
    db.query.mockResolvedValue({ rows: [ENTRY] });
    const res = await request(app).get('/api/queue').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queue');
  });
});

// ── POST /api/queue — מנהל מוסיף לקוח ────────────────────────────────────
describe('POST /api/queue', () => {
  it('חסר שם → 400', async () => {
    mockClient([]);
    const res = await request(app).post('/api/queue').set(authHeader(token)).send({ phone: '052-1234567', party_size: 2 });
    expect(res.status).toBe(400);
  });

  it('לקוח תקין → 201', async () => {
    mockClient([ENTRY]);
    const res = await request(app).post('/api/queue').set(authHeader(token)).send({
      name: 'שרה כהן', phone: '052-9999999', party_size: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('entry');
  });
});

// ── POST /api/queue/join/:businessId — ציבורי ─────────────────────────────
describe('POST /api/queue/join/:businessId — public', () => {
  it('חסר שם → 400', async () => {
    mockClient([]);
    const res = await request(app).post('/api/queue/join/biz-test-1').send({ phone: '052-111' });
    expect(res.status).toBe(400);
  });

  it('חסר טלפון → 400', async () => {
    mockClient([]);
    const res = await request(app).post('/api/queue/join/biz-test-1').send({ customerName: 'שרה' });
    expect(res.status).toBe(400);
  });

  it('לקוח תקין → 201', async () => {
    mockClient([ENTRY]);
    const res = await request(app).post('/api/queue/join/biz-test-1').send({
      customerName: 'שרה כהן', phone: '052-9999999', partySize: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('position');
  });
});

// ── PUT /api/queue/:id/ready ───────────────────────────────────────────────
describe('PUT /api/queue/:id/ready', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).put('/api/queue/q-1/ready');
    expect(res.status).toBe(401);
  });

  it('לקוח לא קיים → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).put('/api/queue/q-1/ready').set(authHeader(token));
    expect(res.status).toBe(404);
  });

  it('לקוח קיים → 200 עם קישור WhatsApp', async () => {
    db.query.mockResolvedValue({ rows: [ENTRY] });
    const res = await request(app).put('/api/queue/q-1/ready').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('wa_link');
  });
});

// ── PUT /api/queue/:id/seated ──────────────────────────────────────────────
describe('PUT /api/queue/:id/seated', () => {
  it('סימון ישיבה → 200', async () => {
    db.query.mockResolvedValue({ rows: [{ ...ENTRY, status: 'seated' }] });
    const res = await request(app).put('/api/queue/q-1/seated').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── DELETE /api/queue/:id ──────────────────────────────────────────────────
describe('DELETE /api/queue/:id', () => {
  it('ביטול תור → 200', async () => {
    // rowCount, not just rows: the route answers 404 when the UPDATE matched
    // no waiting/ready row, which is correct — the mock was describing that case.
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(app).delete('/api/queue/q-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
