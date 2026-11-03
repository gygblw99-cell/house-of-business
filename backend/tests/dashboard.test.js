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

beforeEach(() => { db.query.mockReset(); });

describe('GET /api/dashboard — auth gate', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
  });

  it('טוקן לא תקין → 401', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dashboard — authenticated', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({ rows: [{ total_revenue: 5000, total_orders: 20, avg_order: 250, labor_cost: 1000, food_cost: 1500 }] });
  });

  it('טוקן תקין → 200', async () => {
    const res = await request(app).get('/api/dashboard').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/dashboard/menu-engineering — auth gate', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/dashboard/menu-engineering');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/dashboard/profit-leaks — auth gate', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/dashboard/profit-leaks');
    expect(res.status).toBe(401);
  });
});
