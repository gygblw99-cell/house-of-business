/**
 * Tasks AI Suggest — בדיקות endpoint הצעות משימות
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
  pool:    { on: jest.fn(), end: jest.fn() },
}));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');

const jwt = require('jsonwebtoken');
function makeToken(role = 'owner') {
  return jwt.sign(
    { userId: 'u1', businessId: 'b1', role },
    process.env.JWT_SECRET
  );
}

// 5 db.query calls inside ai-suggest: lowInv, unmatched, expiry, invoices, activeTasks
function mockNoIssues() {
  db.query
    .mockResolvedValueOnce({ rows: [] })       // low inventory
    .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })  // unmatched z-employees
    .mockResolvedValueOnce({ rows: [] })       // expiring items
    .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })  // pending invoices
    .mockResolvedValueOnce({ rows: [] });      // active tasks
}

function mockWithIssues() {
  db.query
    .mockResolvedValueOnce({ rows: [{ name: 'עגבניות', quantity: 2, min_quantity: 10 }] })
    .mockResolvedValueOnce({ rows: [{ cnt: 3 }] })
    .mockResolvedValueOnce({ rows: [{ name: 'חסה', expiry_date: new Date(Date.now() + 86400000).toISOString() }] })
    .mockResolvedValueOnce({ rows: [{ cnt: 2 }] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('GET /api/tasks/ai-suggest', () => {
  beforeEach(() => db.query.mockReset());

  it('ללא טוקן → 401', async () => {
    const res = await request(app).get('/api/tasks/ai-suggest');
    expect(res.status).toBe(401);
  });

  it('עובד (לא מנהל) → 403', async () => {
    const res = await request(app)
      .get('/api/tasks/ai-suggest')
      .set('Authorization', `Bearer ${makeToken('employee')}`);
    expect(res.status).toBe(403);
  });

  it('אין בעיות → מחזיר מערך ריק', async () => {
    mockNoIssues();
    const res = await request(app)
      .get('/api/tasks/ai-suggest')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions).toHaveLength(0);
  });

  it('בעיות מלאי + עובדים לא מותאמים → מחזיר הצעות', async () => {
    mockWithIssues();
    const res = await request(app)
      .get('/api/tasks/ai-suggest')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions.some(s => s.source === 'inventory')).toBe(true);
    expect(res.body.suggestions.some(s => s.source === 'zreport')).toBe(true);
  });

  it('הצעות לא כוללות משימות קיימות', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ name: 'עגבניות', quantity: 2, min_quantity: 10 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({ rows: [{ title: 'הזמן מלאי: עגבניות' }] }); // existing task

    const res = await request(app)
      .get('/api/tasks/ai-suggest')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.every(s => !s.title.includes('עגבניות'))).toBe(true);
  });
});
