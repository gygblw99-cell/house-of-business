/**
 * An owner must never be locked out of their own account.
 *
 * The QA finding: POST /api/admin/create-business treated username as optional
 * (`username?.trim()?.toLowerCase() || null`) while loginOwner matched on it
 * exclusively — no email fallback, no phone, no recovery. It happened in
 * production: the owner of "זוקו תל אביב" sat with username = NULL and no way in.
 */

jest.mock('../src/utils/db', () => ({
  query:     jest.fn(),
  migrate:   jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
  pool:      { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  hash:    jest.fn().mockResolvedValue('hashed'),
}));

const db = require('../src/utils/db');
const { loginOwner } = require('../src/services/auth.service');

/** Captures the lookup SQL + params, then reports "no such user" so the test
 *  only exercises the identifier query. */
function captureLookup() {
  const seen = {};
  db.query.mockReset();
  db.query.mockImplementation((sql, params) => {
    if (/FROM users/.test(sql) && /password_hash/.test(sql)) {
      seen.sql = sql;
      seen.params = params;
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  return seen;
}

describe('loginOwner identifier', () => {
  test('matches on username OR email', async () => {
    const seen = captureLookup();
    await expect(loginOwner({ username: 'demo.owner', password: 'x' })).rejects.toThrow();
    // Email is the fallback that makes the lockout impossible. users.email is
    // UNIQUE NOT NULL, so it is a safe second identifier.
    expect(seen.sql).toMatch(/u\.username = \$1/);
    expect(seen.sql).toMatch(/LOWER\(u\.email\) = \$1/);
  });

  test('an email address is accepted as the identifier', async () => {
    const seen = captureLookup();
    await expect(loginOwner({ username: 'demo.owner@example.com', password: 'x' })).rejects.toThrow();
    expect(seen.params[0]).toBe('demo.owner@example.com');
  });

  test('the identifier is lower-cased and trimmed', async () => {
    const seen = captureLookup();
    await expect(loginOwner({ username: '  GUY2003@Gmail.COM  ', password: 'x' })).rejects.toThrow();
    expect(seen.params[0]).toBe('demo.owner@example.com');
  });

  test('an exact username match wins over an email collision', async () => {
    const seen = captureLookup();
    await expect(loginOwner({ username: 'someone', password: 'x' })).rejects.toThrow();
    // Deterministic if a username ever equals another user's email.
    expect(seen.sql).toMatch(/ORDER BY \(u\.username = \$1\) DESC/);
  });

  test('only roles that sign in here are considered', async () => {
    const seen = captureLookup();
    await expect(loginOwner({ username: 'x', password: 'y' })).rejects.toThrow();
    expect(seen.sql).toMatch(/role IN \('owner', 'partner', 'manager'\)/);
  });

  test('a missing identifier does not throw a TypeError', async () => {
    captureLookup();
    // Previously username.trim() on undefined would have thrown before the
    // 401 could be produced.
    await expect(loginOwner({ password: 'x' })).rejects.toThrow('פרטי כניסה שגויים');
  });

  test('an unknown identifier is a 401, not a 500', async () => {
    captureLookup();
    await expect(loginOwner({ username: 'nobody', password: 'x' })).rejects.toMatchObject({ status: 401 });
  });
});
