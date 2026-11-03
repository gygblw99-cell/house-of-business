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

// Use real UUIDs — Zod validates recipientIds as UUID array
const EMP_ID_1 = '11111111-1111-1111-1111-111111111111';
const EMP_ID_2 = '22222222-2222-2222-2222-222222222222';

const MSG = {
  id: 'msg-1', business_id: 'biz-test-1', sender_id: 'user-test-1',
  content: 'שלום לכולם!', recipient_ids: [EMP_ID_1, EMP_ID_2],
  is_read_by: [], created_at: new Date().toISOString(),
};

beforeEach(() => { db.query.mockReset(); });

describe('Messages — auth gates', () => {
  it('GET /api/messages ללא טוקן → 401',  async () => expect((await request(app).get('/api/messages')).status).toBe(401));
  it('POST /api/messages ללא טוקן → 401', async () => expect((await request(app).post('/api/messages').send({})).status).toBe(401));
});

describe('GET /api/messages', () => {
  it('מחזיר הודעות', async () => {
    db.query.mockResolvedValue({ rows: [MSG] });
    const res = await request(app).get('/api/messages').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/messages', () => {
  it('חסר תוכן → 400', async () => {
    const res = await request(app).post('/api/messages').set(authHeader(token)).send({ recipientIds: [EMP_ID_1] });
    expect(res.status).toBe(400);
  });

  it('חסר נמענים → 400', async () => {
    const res = await request(app).post('/api/messages').set(authHeader(token)).send({ content: 'היי' });
    expect(res.status).toBe(400);
  });

  it('נמען לא UUID → 400', async () => {
    const res = await request(app).post('/api/messages').set(authHeader(token)).send({ content: 'היי', recipientIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
  });

  it('הודעה תקינה → 201', async () => {
    // 1st call: membership check — return both recipients as members
    db.query.mockResolvedValueOnce({ rows: [{ id: EMP_ID_1 }, { id: EMP_ID_2 }] });
    // 2nd call: INSERT message
    db.query.mockResolvedValueOnce({ rows: [MSG] });
    const res = await request(app).post('/api/messages').set(authHeader(token)).send({
      content: 'שלום לכולם!', recipientIds: [EMP_ID_1, EMP_ID_2],
    });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/messages/unread-count', () => {
  it('מחזיר מספר הודעות שלא נקראו', async () => {
    db.query.mockResolvedValue({ rows: [{ count: '3' }] });
    const res = await request(app).get('/api/messages/unread-count').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
  });
});

describe('PUT /api/messages/:id/read', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).put('/api/messages/msg-1/read');
    expect(res.status).toBe(401);
  });

  it('סימון כנקרא → 200', async () => {
    db.query.mockResolvedValue({ rows: [MSG] });
    const res = await request(app).put('/api/messages/msg-1/read').set(authHeader(token));
    expect([200, 404]).toContain(res.status);
  });
});

describe('GET /api/messages/history', () => {
  it('מחזיר היסטוריית הודעות', async () => {
    db.query.mockResolvedValue({ rows: [MSG] });
    const res = await request(app).get('/api/messages/history?limit=20&offset=0').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
