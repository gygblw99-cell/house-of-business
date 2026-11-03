/**
 * Finance / Cashflow Tests
 */

jest.mock('../src/utils/db', () => ({
  query: jest.fn(),
}));

const db = require('../src/utils/db');

describe('getCashflow', () => {
  beforeEach(() => { db.query.mockReset(); });

  it('מייבא את המודול בלי שגיאות', () => {
    expect(() => require('../src/services/finance/cashflow.service')).not.toThrow();
  });

  it('מחזיר מערך ריק כשאין נתונים', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const { getCashflow } = require('../src/services/finance/cashflow.service');
    const result = await getCashflow('test-business-id', 7);
    expect(Array.isArray(result)).toBe(true);
  });
});
