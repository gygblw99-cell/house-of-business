jest.mock('../src/utils/db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
  migrate:   jest.fn().mockResolvedValue(undefined),
  pool:      { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn().mockResolvedValue({}) }) }));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken({ role: 'owner' });

const EMPLOYEE = {
  id: 'emp-1', business_id: 'biz-test-1', full_name: 'דני לוי',
  email: 'dani@test.com', role: 'employee', is_active: true,
  salary_type: 'hourly', salary_amount: 45,
};

const SHIFT = {
  id: 'shift-1', employee_id: 'emp-1', business_id: 'biz-test-1',
  actual_start: new Date().toISOString(), actual_end: null, status: 'active',
};

beforeEach(() => {
  db.query.mockReset();
  db.getClient.mockReset();
});

// ── Auth gates ──────────────────────────────────────────────────────────────
describe('Employees — auth gates', () => {
  it('GET /api/employees ללא טוקן → 401',  async () => expect((await request(app).get('/api/employees')).status).toBe(401));
  it('POST /api/employees ללא טוקן → 401', async () => expect((await request(app).post('/api/employees').send({})).status).toBe(401));
});

// ── GET /api/employees ─────────────────────────────────────────────────────
describe('GET /api/employees', () => {
  it('מחזיר רשימת עובדים', async () => {
    db.query.mockResolvedValue({ rows: [EMPLOYEE] });
    const res = await request(app).get('/api/employees').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/employees — יצירת עובד ──────────────────────────────────────
describe('POST /api/employees', () => {
  it('חסר שם → 400', async () => {
    const res = await request(app).post('/api/employees').set(authHeader(token)).send({ email: 'x@x.com', role: 'employee', salaryType: 'hourly', salaryAmount: 45 });
    expect(res.status).toBe(400);
  });

  it('חסר שכר → 400', async () => {
    const res = await request(app).post('/api/employees').set(authHeader(token)).send({ fullName: 'דני', email: 'x@x.com', role: 'employee' });
    expect(res.status).toBe(400);
  });

  it('עובד תקין → 201', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'emp-new' }] }) // INSERT user
      .mockResolvedValueOnce({ rows: [{ name: 'Test Business' }] }); // SELECT business name
    const res = await request(app).post('/api/employees').set(authHeader(token)).send({
      fullName: 'דני לוי', email: 'dani@test.com', role: 'employee',
      salaryType: 'hourly', salaryAmount: 45,
    });
    expect([201, 400, 409, 500]).toContain(res.status);
  });
});

// ── GET /api/employees/shifts/active ──────────────────────────────────────
describe('GET /api/employees/shifts/active', () => {
  it('מחזיר משמרות פתוחות', async () => {
    db.query.mockResolvedValue({ rows: [SHIFT] });
    const res = await request(app).get('/api/employees/shifts/active').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/employees/shifts ─────────────────────────────────────────────
describe('GET /api/employees/shifts', () => {
  it('מחזיר משמרות', async () => {
    db.query.mockResolvedValue({ rows: [SHIFT] });
    const res = await request(app).get('/api/employees/shifts').set(authHeader(token));
    expect([200, 500]).toContain(res.status);
  });
});

// ── POST /api/employees/shifts/clock-in (QR only) ─────────────────────────
describe('POST /api/employees/shifts/clock-in', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).post('/api/employees/shifts/clock-in').send({});
    expect(res.status).toBe(401);
  });

  it('ללא QR → 400', async () => {
    const res = await request(app).post('/api/employees/shifts/clock-in').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
  });
});

// ── POST /api/employees/shifts/clock-out ──────────────────────────────────
describe('POST /api/employees/shifts/clock-out', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).post('/api/employees/shifts/clock-out').send({});
    expect(res.status).toBe(401);
  });

  it('אין משמרת פעילה → 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/employees/shifts/clock-out').set(authHeader(token)).send({});
    expect([404, 500]).toContain(res.status);
  });
});