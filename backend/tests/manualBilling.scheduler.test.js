/**
 * Manual-billing auto-suspend — decision logic.
 *
 * The regression that motivated these: the scheduler used to decide suspension
 * from a lifetime balance, months_due * monthly_fee - total_paid. monthly_fee
 * is a single mutable column with no history, so raising a long-standing
 * customer's fee re-priced every month they had already paid at the old rate
 * and auto-suspended an account that was fully paid up.
 */

jest.mock('../src/utils/db', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../src/utils/db');
const { checkOverdueBusinesses } = require('../src/services/billing/manualBilling.scheduler');

// 12:00 Israel time on 19 Sep 2026 (IDT = UTC+3) — well clear of any
// midnight/UTC boundary so the test asserts billing logic, not clock skew.
const NOW = new Date('2026-09-19T09:00:00Z');

/** Runs the scheduler against one business row; returns the suspend UPDATE, if any. */
async function runFor(biz) {
  const updates = [];
  db.query.mockReset();
  db.query.mockImplementation((sql, params) => {
    if (/UPDATE businesses/.test(sql)) { updates.push({ sql, params }); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [biz] });
  });
  await checkOverdueBusinesses();
  return updates[0] || null;
}

const BASE = {
  id: 'biz-1',
  name: 'Test Bistro',
  billing_day: 5,
  monthly_fee: 500,
  billing_start_date: '2025-09-05',
  grace_period_days: 7,
  last_payment: '2026-09-05', // paid this cycle, on the due date
  total_paid: 6500,
};

beforeAll(() => { jest.useFakeTimers({ doNotFake: ['nextTick'] }); jest.setSystemTime(NOW); });
afterAll(() => { jest.useRealTimers(); });

describe('checkOverdueBusinesses', () => {
  test('does not suspend when the current cycle is paid', async () => {
    expect(await runFor(BASE)).toBeNull();
  });

  test('does not suspend a paid-up customer after a retroactive fee increase', async () => {
    // Same customer, same payments — the admin only raised the monthly fee.
    // The old lifetime-balance maths made this 13 * 700 - 6500 = ₪2,600 "owed".
    const raised = { ...BASE, monthly_fee: 700 };
    expect(await runFor(raised)).toBeNull();
  });

  test('does not suspend when payment arrived a few days early', async () => {
    // Due 5 Sep, paid 2 Sep — still inside the cycle that opened 5 Aug.
    expect(await runFor({ ...BASE, last_payment: '2026-09-02' })).toBeNull();
  });

  test('suspends when the current cycle is unpaid and grace has expired', async () => {
    // Due 5 Sep + 7 days grace = 12 Sep; today is 19 Sep and the last payment
    // belongs to the previous cycle.
    const upd = await runFor({ ...BASE, last_payment: '2026-08-05' });
    expect(upd).not.toBeNull();
    expect(upd.sql).toMatch(/suspended_at\s*=\s*NOW\(\)/);
    expect(upd.params[0]).toBe('biz-1');
  });

  test('does not suspend while still inside the grace window', async () => {
    // grace 30 days pushes the deadline to 5 Oct, past today.
    expect(await runFor({ ...BASE, last_payment: '2026-08-05', grace_period_days: 30 })).toBeNull();
  });

  test('suspends when no payment was ever recorded', async () => {
    expect(await runFor({ ...BASE, last_payment: null, total_paid: 0 })).not.toBeNull();
  });

  test('does not suspend before the first billing cycle arrives', async () => {
    expect(await runFor({
      ...BASE, billing_start_date: '2026-12-01', last_payment: null, total_paid: 0,
    })).toBeNull();
  });
});
