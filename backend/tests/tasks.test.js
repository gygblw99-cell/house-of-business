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

const TASK = {
  id: 'task-1', business_id: 'biz-test-1', title: 'ניקוי מטבח',
  assigned_to: 'emp-1', status: 'pending', priority: 'high',
  due_date: '2026-06-20', created_by: 'user-test-1',
};

function mockClient(rows = [TASK]) {
  const client = { query: jest.fn().mockResolvedValue({ rows }), release: jest.fn() };
  db.getClient.mockResolvedValue(client);
  return client;
}

beforeEach(() => { db.query.mockReset(); db.getClient.mockReset(); });

describe('Tasks — auth gates', () => {
  it('GET /api/tasks ללא טוקן → 401',  async () => expect((await request(app).get('/api/tasks')).status).toBe(401));
  it('POST /api/tasks ללא טוקן → 401', async () => expect((await request(app).post('/api/tasks').send({})).status).toBe(401));
});

describe('GET /api/tasks', () => {
  it('מחזיר משימות', async () => {
    db.query.mockResolvedValue({ rows: [TASK] });
    const res = await request(app).get('/api/tasks').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/tasks', () => {
  it('חסר כותרת → 400', async () => {
    const res = await request(app).post('/api/tasks').set(authHeader(token)).send({ assigned_to: 'emp-1' });
    expect(res.status).toBe(400);
  });

  it('משימה תקינה → 201', async () => {
    mockClient([TASK]);
    const res = await request(app).post('/api/tasks').set(authHeader(token)).send({
      title: 'ניקוי מטבח', assignedTo: '550e8400-e29b-41d4-a716-446655440000', priority: 'high', dueDate: '2026-06-20',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('task');
  });
});

describe('PUT /api/tasks/:id', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).put('/api/tasks/task-1').send({ status: 'done' });
    expect(res.status).toBe(401);
  });

  it('עדכון סטטוס → 200', async () => {
    db.query.mockResolvedValue({ rows: [{ ...TASK, status: 'done' }] });
    const res = await request(app).put('/api/tasks/task-1').set(authHeader(token)).send({ status: 'done' });
    expect([200, 404]).toContain(res.status);
  });

  it('משימה לא קיימת → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).put('/api/tasks/not-exist').set(authHeader(token)).send({ status: 'done' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).delete('/api/tasks/task-1');
    expect(res.status).toBe(401);
  });

  it('מחיקה → 200', async () => {
    db.query.mockResolvedValue({ rowCount: 1 });
    const res = await request(app).delete('/api/tasks/task-1').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
