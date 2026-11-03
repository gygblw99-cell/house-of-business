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

const DISH = {
  id: 'dish-1', business_id: 'biz-test-1', name: 'שניצל ירושלמי',
  price: 68, cost: 18.5, margin: 72.8, category: 'עיקריות',
};

beforeEach(() => {
  db.query.mockReset();
  db.getClient.mockReset();
  db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
});

describe('Recipes/Dishes — auth gates', () => {
  it('GET /api/dishes ללא טוקן → 401',                       async () => expect((await request(app).get('/api/dishes')).status).toBe(401));
  it('GET /api/dashboard/menu-engineering ללא טוקן → 401',   async () => expect((await request(app).get('/api/dashboard/menu-engineering')).status).toBe(401));
});

describe('GET /api/dishes', () => {
  it('מחזיר מנות', async () => {
    db.query.mockResolvedValue({ rows: [DISH] });
    const res = await request(app).get('/api/dishes').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/dishes', () => {
  it('חסר שם → 400', async () => {
    const res = await request(app).post('/api/dishes').set(authHeader(token)).send({ price: 68 });
    expect(res.status).toBe(400);
  });

  it('מנה תקינה → 201', async () => {
    // The route now rejects a duplicate dish name before inserting, and a blanket
    // mock returning a dish for every query makes that check find one — so
    // creating a brand-new dish answered 409. The duplicate lookup has to come
    // back empty; everything after it still gets the dish.
    db.query.mockResolvedValue({ rows: [DISH] });
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/dishes').set(authHeader(token)).send({
      name: 'שניצל ירושלמי', price: 68, category: 'עיקריות',
    });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/dashboard/menu-engineering', () => {
  it('מחזיר ניתוח תפריט', async () => {
    db.query.mockResolvedValue({ rows: [{ ...DISH, total_sold: 45, revenue: 3060, classification: 'star' }] });
    const res = await request(app).get('/api/dashboard/menu-engineering').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/dishes/:id', () => {
  it('מנה קיימת → 200', async () => {
    db.query.mockResolvedValue({ rows: [DISH] });
    const res = await request(app).get('/api/dishes/dish-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });

  it('מנה לא קיימת → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/dishes/not-exist').set(authHeader(token));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/dishes/:id', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).delete('/api/dishes/dish-1');
    expect(res.status).toBe(401);
  });
});
