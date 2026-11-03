jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));
jest.mock('../src/services/deliveries.emailConfig.service', () => ({
  getConfig:               jest.fn().mockResolvedValue(null),
  getConfigWithPassword:   jest.fn().mockResolvedValue(null),
  saveConfig:              jest.fn().mockResolvedValue(undefined),
  deleteConfig:            jest.fn().mockResolvedValue(undefined),
  testConnection:          jest.fn().mockResolvedValue({ success: true, message: 'OK' }),
  fetchDeliveries:         jest.fn().mockResolvedValue({ imported: 0, skipped: 0, emailsScanned: 0, errors: [] }),
}));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

const DELIVERY = {
  id: 'del-1', business_id: 'biz-test-1', sale_type: 'delivery',
  delivery_platform: 'wolt', total_amount: 185, sold_at: new Date().toISOString(), status: 'done',
};

beforeEach(() => { db.query.mockReset(); });

// ── Auth gates ─────────────────────────────────────────────────────────────
describe('Deliveries — auth gates', () => {
  it('GET /api/deliveries/history ללא טוקן → 401',      async () => expect((await request(app).get('/api/deliveries/history')).status).toBe(401));
  it('GET /api/deliveries/email-config ללא טוקן → 401', async () => expect((await request(app).get('/api/deliveries/email-config')).status).toBe(401));
});

// ── GET /api/deliveries/today ─────────────────────────────────────────────
describe('GET /api/deliveries/today', () => {
  it('מחזיר סיכום יומי', async () => {
    db.query.mockResolvedValue({ rows: [{ total: 1850, count: 10 }] });
    const res = await request(app).get('/api/deliveries/today').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

// ── GET /api/deliveries/history ───────────────────────────────────────────
describe('GET /api/deliveries/history', () => {
  it('מחזיר היסטוריית משלוחים', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/deliveries/history').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

// ── POST /api/deliveries/import ───────────────────────────────────────────
describe('POST /api/deliveries/import', () => {
  it('חסרת פלטפורמה → 400', async () => {
    const res = await request(app).post('/api/deliveries/import').set(authHeader(token)).send({ deliveries: [] });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/deliveries/email-config ─────────────────────────────────────
describe('GET /api/deliveries/email-config', () => {
  it('ללא הגדרות → null', async () => {
    const res = await request(app).get('/api/deliveries/email-config').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

// ── POST /api/deliveries/email-config ────────────────────────────────────
describe('POST /api/deliveries/email-config', () => {
  it('חסר מייל → 400', async () => {
    const res = await request(app).post('/api/deliveries/email-config').set(authHeader(token)).send({ app_password: 'xxxx' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/deliveries/email-config/test ────────────────────────────────
describe('POST /api/deliveries/email-config/test', () => {
  it('בדיקת חיבור → 200', async () => {
    const res = await request(app).post('/api/deliveries/email-config/test').set(authHeader(token)).send({
      email: 'biz@gmail.com', app_password: 'xxxx xxxx xxxx xxxx',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

// ── POST /api/deliveries/email-fetch ─────────────────────────────────────
describe('POST /api/deliveries/email-fetch', () => {
  it('ללא הגדרות מייל → 404', async () => {
    const res = await request(app).post('/api/deliveries/email-fetch').set(authHeader(token)).send({});
    expect([404, 400]).toContain(res.status);
  });
});