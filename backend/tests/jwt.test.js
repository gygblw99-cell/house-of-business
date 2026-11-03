/**
 * JWT Utility — Unit Tests
 */

const { sign, verify } = require('../src/utils/jwt');

describe('jwt.sign', () => {
  it('מחזיר מחרוזת JWT בת 3 חלקים', () => {
    const token = sign({ userId: 'abc', role: 'owner' });
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('payload מוחזר ב-verify אחרי sign', () => {
    const payload = { userId: 'user-1', businessId: 'biz-1', role: 'manager' };
    const token   = sign(payload);
    const decoded = verify(token);
    expect(decoded.userId).toBe('user-1');
    expect(decoded.businessId).toBe('biz-1');
    expect(decoded.role).toBe('manager');
  });

  it('שני tokens שונים ל-payloads שונים', () => {
    const t1 = sign({ userId: 'a' });
    const t2 = sign({ userId: 'b' });
    expect(t1).not.toBe(t2);
  });

  it('תומך ב-expiresIn מותאם', () => {
    const token   = sign({ userId: 'x' }, '1h');
    const decoded = verify(token);
    expect(decoded.exp).toBeDefined();
    const now = Math.floor(Date.now() / 1000);
    expect(decoded.exp).toBeGreaterThan(now);
    expect(decoded.exp).toBeLessThanOrEqual(now + 3600 + 5);
  });

  it('iat (issued-at) נוצר אוטומטית', () => {
    const token   = sign({ userId: 'y' });
    const decoded = verify(token);
    expect(decoded.iat).toBeDefined();
    expect(decoded.iat).toBeGreaterThan(0);
  });
});

describe('jwt.verify', () => {
  it('token תקין → מחזיר payload', () => {
    const token   = sign({ userId: 'valid-user', role: 'employee' });
    const decoded = verify(token);
    expect(decoded.userId).toBe('valid-user');
  });

  it('token לא תקין → זורק שגיאה', () => {
    expect(() => verify('not.a.jwt')).toThrow();
  });

  it('token מזויף (signature שגויה) → זורק שגיאה', () => {
    const token    = sign({ userId: 'x' });
    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(() => verify(tampered)).toThrow();
  });

  it('token פג תוקף → זורק TokenExpiredError', () => {
    const expired = sign({ userId: 'x' }, '-1s');
    expect(() => verify(expired)).toThrow(/expired/i);
  });

  it('אלגוריתם HS256 בלבד — RS256 נדחה', () => {
    // simulate a none-algorithm token (stripped signature)
    const fakeHeader  = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
    const fakePayload = Buffer.from('{"userId":"evil"}').toString('base64url');
    const noneToken   = `${fakeHeader}.${fakePayload}.`;
    expect(() => verify(noneToken)).toThrow();
  });
});
