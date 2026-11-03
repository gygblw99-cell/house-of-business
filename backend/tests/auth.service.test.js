/**
 * Auth Service — Unit Tests
 * Tests the service layer directly (not HTTP routes).
 * DB is mocked to control all possible code paths.
 */

const bcrypt = require('bcryptjs');

// ── DB mock — we control responses per test ───────────────────
const mockQuery     = jest.fn();
const mockGetClient = jest.fn();

jest.mock('../src/utils/db', () => ({
  query:     mockQuery,
  getClient: mockGetClient,
  migrate:   jest.fn().mockResolvedValue(undefined),
  pool:      { on: jest.fn(), end: jest.fn() },
}));

jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

// Mock Twilio so SMS calls don't fail
jest.mock('twilio', () => () => ({
  messages: { create: jest.fn().mockResolvedValue({}) },
}));

// Mock nodemailer so email calls don't fail
jest.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: jest.fn().mockResolvedValue({}) }),
}));

const authService = require('../src/services/auth.service');

// ── Helpers ───────────────────────────────────────────────────
async function hashPassword(pw) {
  return bcrypt.hash(pw, 1); // fast rounds for tests
}

function makeMockClient(responses = []) {
  const client = {
    query:   jest.fn(),
    release: jest.fn(),
  };
  let idx = 0;
  client.query.mockImplementation(() => {
    const res = responses[idx++] ?? { rows: [] };
    return Promise.resolve(res);
  });
  return client;
}

// ─────────────────────────────────────────────────────────────
describe('authService.register', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('מייל כפול → זורק 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] });
    await expect(
      authService.register({ name: 'ישראל', businessName: 'מסעדה', businessType: 'restaurant', email: 'dup@test.com', password: 'Pass123!' })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('רישום מוצלח → מחזיר token + userId + businessId', async () => {
    const client = makeMockClient([
      { rows: [] },                              // BEGIN
      { rows: [{ id: 'biz-uuid' }] },           // INSERT businesses
      { rows: [{ id: 'user-uuid' }] },          // INSERT users
      { rows: [] },                              // INSERT categories (×8) — loop
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [] }, { rows: [] },
      { rows: [] },                              // COMMIT
    ]);

    // First query = SELECT (no duplicate)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockGetClient.mockResolvedValueOnce(client);

    const result = await authService.register({
      name: 'ישראל ישראלי', businessName: 'מסעדת ישראל', businessType: 'restaurant',
      email: 'new@test.com', password: 'Secure123!',
    });

    expect(result.token).toBeDefined();
    expect(result.userId).toBe('user-uuid');
    expect(result.businessId).toBe('biz-uuid');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('שגיאת DB → ROLLBACK נקרא + שגיאה מועלית', async () => {
    const dbError = new Error('DB_FAIL');
    const client = {
      query:   jest.fn().mockRejectedValue(dbError),
      release: jest.fn(),
    };

    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT (no duplicate)
    mockGetClient.mockResolvedValueOnce(client);

    await expect(
      authService.register({ name: 'x', businessName: 'y', businessType: 'restaurant', email: 'e@e.com', password: 'Pass123!' })
    ).rejects.toThrow('DB_FAIL');
    expect(client.release).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('authService.loginOwner', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('משתמש לא קיים → 401', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(authService.loginOwner({ username: 'nouser', password: 'x' }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('משתמש לא פעיל → 401', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u', business_id: 'b', role: 'owner', is_active: false, password_hash: 'h', failed_login_count: 0, locked_until: null }] });
    await expect(authService.loginOwner({ username: 'inactive_user', password: 'x' }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('חשבון נעול → 423', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u', business_id: 'b', role: 'owner', is_active: true, password_hash: 'h', failed_login_count: 5, locked_until: future }] });
    await expect(authService.loginOwner({ username: 'locked_user', password: 'x' }))
      .rejects.toMatchObject({ status: 423 });
  });

  it('סיסמה שגויה → 401 + מעלה failed_login_count', async () => {
    const hash = await hashPassword('correct');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u', business_id: 'b', role: 'owner', is_active: true, password_hash: hash, failed_login_count: 0, locked_until: null }] })
      .mockResolvedValueOnce({ rows: [{ failed_login_count: 1 }] }); // UPDATE ... RETURNING failed_login_count

    await expect(authService.loginOwner({ username: 'test_user', password: 'wrong' }))
      .rejects.toMatchObject({ status: 401 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('5 ניסיונות כושלים → נועל חשבון (423)', async () => {
    const hash = await hashPassword('correct');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u', business_id: 'b', role: 'owner', is_active: true, password_hash: hash, failed_login_count: 4, locked_until: null }] })
      .mockResolvedValueOnce({ rows: [{ failed_login_count: 5 }] }); // UPDATE ... RETURNING failed_login_count, locked_until set

    await expect(authService.loginOwner({ username: 'test_user', password: 'wrong' }))
      .rejects.toMatchObject({ status: 423 });
    // Update should include locked_until
    const updateCall = mockQuery.mock.calls[1][0];
    expect(updateCall).toMatch(/locked_until/i);
  });

  it('סיסמה נכונה → token + userId + businessId', async () => {
    const hash = await hashPassword('correct');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', business_id: 'b1', role: 'owner', is_active: true, password_hash: hash, failed_login_count: 0, locked_until: null, perm_suppliers: true, perm_inventory: true, perm_recipes: true, perm_finance: true, perm_ai: true, perm_employees: true, perm_export: true, perm_audit: true }] })
      .mockResolvedValueOnce({ rows: [] }); // reset failed_login_count

    const result = await authService.loginOwner({ username: 'ok_user', password: 'correct' });
    expect(result.token).toBeDefined();
    expect(result.userId).toBe('u1');
    expect(result.businessId).toBe('b1');
  });
});

// ─────────────────────────────────────────────────────────────
describe('authService.loginEmployee', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('עובד לא קיים → 401', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(authService.loginEmployee({ username: 'notexist', password: 'x' }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('סיסמה שגויה → 401', async () => {
    const hash = await hashPassword('correct');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e1', business_id: 'b1', role: 'employee', password_hash: hash, is_active: true, failed_login_count: 0, locked_until: null, perm_suppliers: false, perm_inventory: true, perm_recipes: false, perm_finance: false, perm_ai: false, perm_employees: false, perm_export: false, perm_audit: false }] })
      .mockResolvedValueOnce({ rows: [{ failed_login_count: 1 }] }); // UPDATE ... RETURNING failed_login_count
    await expect(authService.loginEmployee({ username: 'emp', password: 'wrong' }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('סיסמה נכונה → token + role employee', async () => {
    const hash = await hashPassword('emp-pass');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'e1', business_id: 'b1', role: 'employee', password_hash: hash, is_active: true, failed_login_count: 0, locked_until: null, perm_suppliers: false, perm_inventory: true, perm_recipes: false, perm_finance: false, perm_ai: false, perm_employees: false, perm_export: false, perm_audit: false }] })
      .mockResolvedValueOnce({ rows: [] }); // reset failed count

    const result = await authService.loginEmployee({ username: 'emp', password: 'emp-pass' });
    expect(result.token).toBeDefined();
    expect(result.role).toBe('employee');
  });
});

// ─────────────────────────────────────────────────────────────
describe('authService.forgotPassword', () => {
  const prevSmtpUser = process.env.SMTP_USER;
  const prevSmtpPass = process.env.SMTP_PASSWORD;

  beforeAll(() => {
    process.env.SMTP_USER     = 'test@test.com';
    process.env.SMTP_PASSWORD = 'test-app-password';
  });
  afterAll(() => {
    process.env.SMTP_USER     = prevSmtpUser;
    process.env.SMTP_PASSWORD = prevSmtpPass;
  });
  afterEach(() => { jest.clearAllMocks(); });

  it('מייל לא קיים → לא זורק שגיאה (anti-enumeration)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(authService.forgotPassword({ email: 'ghost@test.com' })).resolves.not.toThrow();
  });

  it('מייל קיים → שולח מייל (לא זורק שגיאה)', async () => {
    // Base value first, then the one call whose result this test actually
    // depends on. Listing an exact number of mockResolvedValueOnce values ties
    // the test to how many queries the implementation happens to make: a third
    // query was added later, ran past the end of the list, received undefined
    // and failed on `.catch` of undefined — a failure about the mock, not about
    // forgotPassword.
    mockQuery.mockResolvedValue({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', phone: '+972501234567' }] });
    await expect(authService.forgotPassword({ email: 'real@test.com' })).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
describe('authService.resetPassword', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('משתמש לא קיים → 400', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(authService.resetPassword({ email: 'x@x.com', code: '123456', newPassword: 'NewPass1!' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('קוד שגוי → 400', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', invite_token: 'CORRECT', invite_expires_at: future }] });
    await expect(authService.resetPassword({ email: 'x@x.com', code: 'WRONG', newPassword: 'NewPass1!' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('קוד פג תוקף → 400', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', invite_token: '123456', invite_expires_at: past }] });
    await expect(authService.resetPassword({ email: 'x@x.com', code: '123456', newPassword: 'NewPass1!' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('קוד נכון → מעדכן סיסמה בהצלחה', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', invite_token: 'VALID123', invite_expires_at: future }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE password_hash

    await expect(authService.resetPassword({ email: 'x@x.com', code: 'VALID123', newPassword: 'NewPass1!' }))
      .resolves.not.toThrow();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1][0];
    expect(updateCall).toMatch(/password_hash/i);
  });
});
