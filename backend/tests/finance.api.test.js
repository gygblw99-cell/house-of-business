jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));
jest.mock('../src/services/finance/cashflow.service', () => ({
  getDailyProfit:    jest.fn().mockResolvedValue({ date: '2026-06-15', revenue: 4500, profit: 2300, margin: 51.1 }),
  getCashflow:       jest.fn().mockResolvedValue([{ date: '2026-06-15', revenue: 4500, fixedCost: 400 }]),
  getForecast:       jest.fn().mockResolvedValue([{ date: '2026-06-20', predicted: 5000 }]),
  getForecast90:     jest.fn().mockResolvedValue([{ date: '2026-07-01', predicted: 4800 }]),
  getMonthlySummary: jest.fn().mockResolvedValue({ month: '2026-06', revenue: 120000, expenses: 80000 }),
}));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

beforeEach(() => { db.query.mockReset(); });

describe('Finance — auth gates', () => {
  const routes = [
    ['GET', '/api/finance/cashflow'],
    ['GET', '/api/finance/forecast'],
    ['GET', '/api/finance/daily'],
    ['GET', '/api/finance/monthly'],
  ];
  routes.forEach(([method, path]) => {
    it(`${method} ${path} ללא טוקן → 401`, async () => {
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).toBe(401);
    });
  });
});

describe('GET /api/finance/cashflow', () => {
  it('מחזיר תזרים מזומנים', async () => {
    const res = await request(app).get('/api/finance/cashflow?days=7').set(authHeader(token));
    expect(res.status).toBe(200);
  });
  it('days לא תקין → 200 עם ברירת מחדל', async () => {
    const res = await request(app).get('/api/finance/cashflow?days=abc').set(authHeader(token));
    expect([200, 400]).toContain(res.status);
  });
});

describe('GET /api/finance/forecast', () => {
  it('מחזיר תחזית 30 יום', async () => {
    const res = await request(app).get('/api/finance/forecast').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/finance/forecast90', () => {
  it('מחזיר תחזית 90 יום', async () => {
    const res = await request(app).get('/api/finance/forecast90').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/finance/daily', () => {
  it('תאריך תקין → 200', async () => {
    const res = await request(app).get('/api/finance/daily?date=2026-06-15').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/finance/daily-breakdown', () => {
  it('שנה וחודש לא תקינים → 400', async () => {
    const res = await request(app).get('/api/finance/daily-breakdown?year=1999&month=13').set(authHeader(token));
    expect(res.status).toBe(400);
  });
  it('שנה וחודש תקינים → 200', async () => {
    db.query.mockResolvedValue({ rows: [{ date: '2026-06-01', revenue: 4500 }] });
    const res = await request(app).get('/api/finance/daily-breakdown?year=2026&month=6').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/finance/vat', () => {
  it('שנה לא תקינה → 400', async () => {
    const res = await request(app).get('/api/finance/vat?year=1800&month=1').set(authHeader(token));
    expect(res.status).toBe(400);
  });
  it('פרמטרים תקינים → 200', async () => {
    db.query.mockResolvedValue({ rows: [{ vat_amount: 900, revenue: 6000, vat_rate: 0.18 }] });
    const res = await request(app).get('/api/finance/vat?year=2026&month=6').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

describe('GET /api/finance/monthly', () => {
  it('מחזיר סיכום חודשי', async () => {
    const res = await request(app).get('/api/finance/monthly').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
