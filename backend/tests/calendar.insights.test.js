/**
 * Calendar Smart Insights — בדיקות לוגיקה
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
  pool:    { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');

// Helper: sign a test token
const jwt = require('jsonwebtoken');
function makeToken() {
  return jwt.sign(
    { userId: 'u1', businessId: 'b1', role: 'owner' },
    process.env.JWT_SECRET
  );
}

describe('GET /api/calendar/smart-insights', () => {
  beforeEach(() => {
    db.query.mockReset();
    // 3 queries: dow_averages, weekly_trend, record
    db.query
      .mockResolvedValueOnce({ rows: [
        { dow: 5, avg_revenue: '8000', sample_count: 12 },
        { dow: 0, avg_revenue: '3000', sample_count: 10 },
      ] })
      .mockResolvedValueOnce({ rows: [
        { week_start: '2026-05-25', total: '40000' },
        { week_start: '2026-06-01', total: '46000' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { record: 12000, report_date: '2026-04-01' },
      ] });
  });

  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/calendar/smart-insights');
    expect(res.status).toBe(401);
  });

  it('עם טוקן תקין → 200 עם insights', async () => {
    const res = await request(app)
      .get('/api/calendar/smart-insights')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.insights)).toBe(true);
    expect(Array.isArray(res.body.dow_averages)).toBe(true);
  });

  it('מחזיר best_day insight כאשר יש נתוני Z-report', async () => {
    const res = await request(app)
      .get('/api/calendar/smart-insights')
      .set('Authorization', `Bearer ${makeToken()}`);
    const hasBestDay = res.body.insights.some(i => i.type === 'best_day');
    expect(hasBestDay).toBe(true);
  });

  it('מחזיר weekly_trend insight כאשר יש מגמה של >5%', async () => {
    const res = await request(app)
      .get('/api/calendar/smart-insights')
      .set('Authorization', `Bearer ${makeToken()}`);
    const hasTrend = res.body.insights.some(i => i.type === 'weekly_trend');
    expect(hasTrend).toBe(true);
  });

  it('ריק → 200 ללא insights', async () => {
    db.query.mockReset();
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/calendar/smart-insights')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.insights).toHaveLength(0);
  });
});
