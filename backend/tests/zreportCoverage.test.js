/**
 * Z-report coverage contract.
 *
 * The behaviour that matters is the one the old code got wrong: an absence of
 * data must be reported as an absence, and a closed business must NOT be
 * reported as a failure. canReportFinancials is the flag consumers gate on, so
 * every verdict's value for it is pinned here.
 */

jest.mock('../src/utils/db', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../src/utils/db');
const { getZReportCoverage } = require('../src/services/zreportCoverage.service');

const BIZ = 'biz-1';

/**
 * The service fires four queries in parallel: present days, open_days, the
 * first-ever report date, and the email config. They're matched by SQL shape so
 * the test doesn't depend on call order.
 */
function mockDb({ presentDays = [], openDays = [0, 1, 2, 3, 4, 5, 6], firstDate = null, emailConfig = null, fail = false }) {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (fail) return Promise.reject(new Error('db down'));
    if (/BETWEEN \$2::date AND \$3::date/.test(sql)) return Promise.resolve({ rows: presentDays.map(d => ({ d })) });
    if (/open_days/.test(sql))                       return Promise.resolve({ rows: [{ open_days: openDays }] });
    if (/MIN\(sold_at\)/.test(sql))                  return Promise.resolve({ rows: [{ first_date: firstDate }] });
    if (/business_email_configs/.test(sql))          return Promise.resolve({ rows: emailConfig ? [emailConfig] : [] });
    return Promise.resolve({ rows: [] });
  });
}

// A fixed "today" so expected-day maths is deterministic. 2026-10-01 is a Thursday.
const NOW = new Date('2026-10-01T09:00:00Z');
beforeAll(() => { jest.useFakeTimers({ doNotFake: ['nextTick'] }); jest.setSystemTime(NOW); });
afterAll(() => { jest.useRealTimers(); });

describe('getZReportCoverage', () => {
  test('a business that never imported anything reports no_data, not zero revenue', () => {
    mockDb({ firstDate: null });
    return getZReportCoverage(BIZ, { from: '2026-09-01', to: '2026-09-30' }).then(c => {
      expect(c.verdict).toBe('no_data');
      expect(c.canReportFinancials).toBe(false);
      expect(c.explanation.join(' ')).toContain('לא יובא אף דוח');
    });
  });

  test('a closed month is closed_period, NOT a failure', async () => {
    // Business trades Sunday–Thursday only; the range is three Fridays/Saturdays.
    mockDb({ firstDate: '2025-01-01', openDays: [0, 1, 2, 3, 4], presentDays: [] });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-04', to: '2026-09-05' }); // Fri + Sat
    expect(c.verdict).toBe('closed_period');
    // This is the distinction the old "missing days" count could not draw: the
    // month looked empty because the business was shut, and that is fine.
    expect(c.canReportFinancials).toBe(true);
    expect(c.missingDays).toEqual([]);
  });

  test('a range entirely before the first report is not blamed on the business', async () => {
    mockDb({ firstDate: '2026-06-01', presentDays: [] });
    const c = await getZReportCoverage(BIZ, { from: '2026-01-01', to: '2026-01-31' });
    expect(c.verdict).toBe('closed_period');
    expect(c.explanation.join(' ')).toContain('2026-06-01');
  });

  test('every open day present reports complete and allows figures', async () => {
    mockDb({
      firstDate: '2026-09-01',
      openDays: [1, 2, 3], // Mon–Wed
      presentDays: ['2026-09-07', '2026-09-08', '2026-09-09'],
    });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-09' });
    expect(c.verdict).toBe('complete');
    expect(c.canReportFinancials).toBe(true);
    expect(c.coverage).toBe(1);
  });

  test('no day imported in a period the business traded reports empty and blocks figures', async () => {
    mockDb({ firstDate: '2026-01-01', openDays: [1, 2, 3], presentDays: [] });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-09' });
    expect(c.verdict).toBe('empty');
    expect(c.canReportFinancials).toBe(false);
    expect(c.missingDays).toHaveLength(3);
  });

  test('some days missing reports partial and still blocks a headline figure', async () => {
    mockDb({ firstDate: '2026-01-01', openDays: [1, 2, 3], presentDays: ['2026-09-07'] });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-09' });
    expect(c.verdict).toBe('partial');
    // A revenue total that silently omits two of three days is worse than none.
    expect(c.canReportFinancials).toBe(false);
    expect(c.coverage).toBeCloseTo(0.333, 2);
  });

  test('consecutive missing days collapse into gaps', async () => {
    mockDb({
      firstDate: '2026-01-01',
      openDays: [0, 1, 2, 3, 4, 5, 6],
      presentDays: ['2026-09-01', '2026-09-05'],
    });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-01', to: '2026-09-05' });
    expect(c.gaps).toEqual([{ from: '2026-09-02', to: '2026-09-04', days: 3 }]);
  });

  test("today is never counted missing — its report isn't due yet", async () => {
    mockDb({ firstDate: '2026-01-01', presentDays: [] });
    const c = await getZReportCoverage(BIZ, { from: '2026-10-01', to: '2026-10-01' });
    expect(c.missingDays).not.toContain('2026-10-01');
    expect(c.expectedDayCount).toBe(0);
  });

  describe('ingestion health', () => {
    test('a Gmail token stale beyond 7 days is called out explicitly', async () => {
      mockDb({
        firstDate: '2026-01-01', openDays: [1], presentDays: [],
        emailConfig: {
          is_active: true,
          last_fetched_at: new Date('2026-09-30T00:00:00Z'),
          last_success_at: new Date('2026-09-10T00:00:00Z'), // 21 days earlier
          last_result: {},
        },
      });
      const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-07' });
      expect(c.ingestion.broken).toBe(true);
      expect(c.ingestion.staleDays).toBeGreaterThan(7);
      // The 7-day Testing-mode expiry is the outage that hid a month of gaps.
      expect(c.ingestion.reason).toContain('Testing');
    });

    test('a failed last scan is reported as broken', async () => {
      mockDb({
        firstDate: '2026-01-01',
        emailConfig: {
          is_active: true,
          last_fetched_at: new Date(NOW),
          last_success_at: new Date(NOW),
          last_result: { _fetchFailed: true },
        },
      });
      const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-07' });
      expect(c.ingestion.broken).toBe(true);
    });

    test('a healthy recent import is not flagged', async () => {
      mockDb({
        firstDate: '2026-01-01', openDays: [1], presentDays: ['2026-09-07'],
        emailConfig: {
          is_active: true,
          last_fetched_at: new Date(NOW),
          last_success_at: new Date(NOW),
          last_result: { imported: 2 },
        },
      });
      const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-07' });
      expect(c.ingestion.broken).toBe(false);
      expect(c.verdict).toBe('complete');
    });

    test('no email config at all is reported but is not a breakage', async () => {
      mockDb({ firstDate: '2026-01-01', openDays: [1], presentDays: ['2026-09-07'], emailConfig: null });
      const c = await getZReportCoverage(BIZ, { from: '2026-09-07', to: '2026-09-07' });
      expect(c.ingestion.configured).toBe(false);
      expect(c.ingestion.broken).toBe(false);
    });
  });

  test('a database failure reports unknown and refuses to vouch for the data', async () => {
    mockDb({ fail: true });
    const c = await getZReportCoverage(BIZ, { from: '2026-09-01', to: '2026-09-30' });
    expect(c.verdict).toBe('unknown');
    // "could not verify" must behave like "we have nothing", never like "fine".
    expect(c.canReportFinancials).toBe(false);
  });

  test('an inverted range is rejected rather than silently returning nothing', async () => {
    mockDb({});
    const c = await getZReportCoverage(BIZ, { from: '2026-09-30', to: '2026-09-01' });
    expect(c.verdict).toBe('unknown');
    expect(c.canReportFinancials).toBe(false);
  });
});
