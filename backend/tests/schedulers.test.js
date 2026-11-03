/**
 * Scheduler Smoke Tests
 *
 * Verifies that:
 * 1. Each scheduler module exports start/check functions without crashing
 * 2. The core business logic functions complete without throwing (with mocked DB)
 * 3. Timers do NOT actually fire during tests (no setTimeout/setInterval side effects)
 *
 * All DB calls are mocked. No real timers run — Jest's fake timers are used
 * to prevent long waits.
 */

// Mock all DB and external dependencies before any require.
//
// getClient must GRANT the advisory lock. Every scheduled run now goes through
// utils/jobLock, which fails closed: if it cannot prove it holds the lock it
// skips the run rather than risk a second replica doing the same work twice. A
// client whose query() returns { rows: [] } reads as "lock refused", so without
// this the schedulers under test silently never execute.
jest.mock('../src/utils/db', () => ({
  query:     jest.fn().mockResolvedValue({ rows: [] }),
  getClient: jest.fn().mockResolvedValue({
    query: jest.fn().mockImplementation((sql) =>
      /pg_try_advisory_lock/.test(sql)
        ? Promise.resolve({ rows: [{ got: true }] })
        : Promise.resolve({ rows: [] })),
    release: jest.fn(),
  }),
  migrate:   jest.fn().mockResolvedValue(undefined),
  pool:      { on: jest.fn(), end: jest.fn(), query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock('../src/utils/cache', () => ({
  get:  jest.fn().mockResolvedValue(null),
  set:  jest.fn().mockResolvedValue(undefined),
  del:  jest.fn().mockResolvedValue(undefined),
  wrap: jest.fn((k, fn) => fn()),
}));

jest.mock('../src/utils/eventBus', () => ({
  publish:   jest.fn(),
  subscribe: jest.fn(),
  on:        jest.fn(),
  off:       jest.fn(),
  emit:      jest.fn(),
}));

jest.mock('../src/agents/businessAudit.agent', () => ({
  runAudit: jest.fn().mockResolvedValue({ score: 85, issues: [] }),
}));

jest.mock('../src/agents/weeklyReportCrew.agent', () => ({
  runWeeklyReport: jest.fn().mockResolvedValue({ report: 'test' }),
}));

jest.mock('../src/agents/autoInsights.agent', () => ({
  runAutoInsights: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/employees/payslip.service', () => ({
  startPayslipScheduler: jest.fn(),
  generatePayslip:       jest.fn().mockResolvedValue({ payslipId: 'p-1', payslipData: {} }),
  sendMonthlyPayslips:   jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/notifications/dailySummary.service', () => ({
  sendDailySummary: jest.fn().mockResolvedValue(undefined),
}));

// Class-based mock (not { default: ... }) — must be directly constructible via
// plain CJS `require('@anthropic-ai/sdk')`, which is how every production
// file in this codebase imports it (not `import Anthropic from ...`).
jest.mock('@anthropic-ai/sdk', () => class {
  messages = {
    create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }], usage: {}, stop_reason: 'end_turn' }),
  };
});

const db = require('../src/utils/db');

beforeAll(() => {
  jest.useFakeTimers();
});
afterAll(() => {
  jest.useRealTimers();
});
beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

// ── Reminder Scheduler ────────────────────────────────────────────────────────
describe('Reminder Scheduler', () => {
  const { checkReminders, startReminderScheduler } = require('../src/services/reminders/reminder.scheduler');

  it('exports startReminderScheduler function', () => {
    expect(typeof startReminderScheduler).toBe('function');
  });

  it('checkReminders: no pending reminders — completes without throwing', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(checkReminders()).resolves.not.toThrow();
  });

  it('checkReminders: sends notifications for due reminders', async () => {
    const eventBus = require('../src/utils/eventBus');
    // checkReminders now runs the mark-sent UPDATE and the notification
    // INSERT inside one withTransaction(client) call — mock the shared
    // client, not db.query, and branch on SQL text since BEGIN/UPDATE/
    // INSERT/COMMIT all go through the same client.query mock in sequence.
    const client = await db.getClient();
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE reminders')) {
        return Promise.resolve({ rows: [
          { id: 'r-1', user_id: 'u-1', business_id: 'b-1', title: 'תזכורת', remind_at: new Date().toISOString() },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    await checkReminders();
    expect(client.query).toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledWith('b-1', 'notification', expect.objectContaining({ type: 'reminder' }));
  });

  it('checkReminders: DB error does not crash the scheduler', async () => {
    const client = await db.getClient();
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE reminders')) {
        return Promise.reject(new Error('DB down'));
      }
      return Promise.resolve({ rows: [] });
    });
    await expect(checkReminders()).resolves.not.toThrow();
  });
});

// ── Expiry Scheduler ──────────────────────────────────────────────────────────
describe('Expiry Scheduler', () => {
  const { startExpiryScheduler } = require('../src/services/inventory/expiry.scheduler');

  it('exports startExpiryScheduler', () => {
    expect(typeof startExpiryScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startExpiryScheduler()).not.toThrow();
  });
});

// ── Guardian Scheduler ────────────────────────────────────────────────────────
// The mock here used to declare runGuardianCheck — a name the service does not
// export — and omitted ensureTables entirely. startGuardianScheduler awaits
// ensureTables() and RETURNS EARLY when it throws, so Guardian never scheduled
// anything under test while the suite still reported green: the assertion was
// `expect(() => startGuardianScheduler()).not.toThrow()`, and that can never
// observe a rejected promise from an async function. The only trace was
// "[Guardian Scheduler] Table init failed: ensureTables is not a function"
// printed on every run.
jest.mock('../src/services/guardian/guardian.service', () => ({
  runGuardianScan:         jest.fn().mockResolvedValue({ status: 'ok', incidents: [] }),
  ensureTables:            jest.fn().mockResolvedValue(undefined),
  getHealthSummary:        jest.fn().mockResolvedValue({ ok: true }),
  analyzeIncidentPatterns: jest.fn().mockResolvedValue([]),
}));

describe('Guardian Scheduler', () => {
  const guardianService = require('../src/services/guardian/guardian.service');
  const { startGuardianScheduler } = require('../src/services/guardian/guardian.scheduler');

  // Each test starts the scheduler, which arms a 60s timeout and then a 30min
  // interval. Without clearing timers between tests the previous test's timers
  // fire inside the next one and the call counts below drift.
  // jest.clearAllMocks() wipes what the module-level db mock set up, so the
  // advisory-lock grant is re-established here. jobLock fails closed: a client
  // that does not answer the lock query reads as refused and the scheduled
  // run is skipped, which would make every assertion below silently vacuous.
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    const lockClient = {
      query: jest.fn().mockImplementation((sql) =>
        /pg_try_advisory_lock/.test(sql)
          ? Promise.resolve({ rows: [{ got: true }] })
          : Promise.resolve({ rows: [] })),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(lockClient);
  });
  // Both the first run and the interval now go through the advisory lock,
  // which awaits getClient() and then the pg_try_advisory_lock query. Advancing
  // time returns before those microtasks settle, so drain the queue after.
  const tick = async (ms) => { await jest.advanceTimersByTimeAsync(ms); for (let i = 0; i < 8; i++) await Promise.resolve(); };
  afterEach(() => { jest.clearAllTimers(); });

  it('exports startGuardianScheduler', () => {
    expect(typeof startGuardianScheduler).toBe('function');
  });

  it('starts without rejecting', async () => {
    await expect(startGuardianScheduler()).resolves.toBeUndefined();
  });

  it('prepares its tables before scheduling', async () => {
    await startGuardianScheduler();
    expect(guardianService.ensureTables).toHaveBeenCalled();
  });

  it('runs a scan on the first tick', async () => {
    await startGuardianScheduler();
    expect(guardianService.runGuardianScan).not.toHaveBeenCalled(); // not until the delay elapses
    await tick(60 * 1000);
    expect(guardianService.runGuardianScan).toHaveBeenCalledTimes(1);
  });

  it('a failing scan does not stop the schedule', async () => {
    guardianService.runGuardianScan.mockRejectedValueOnce(new Error('scan blew up'));
    await startGuardianScheduler();
    await tick(60 * 1000);
    expect(guardianService.runGuardianScan).toHaveBeenCalledTimes(1);

    // The 30-minute interval goes through the advisory lock, which awaits
    // getClient() and then the pg_try_advisory_lock query — two microtask hops
    // after the timer fires. Advancing time alone returns before they settle,
    // so drain the queue before asserting.
    await tick(30 * 60 * 1000);
    expect(guardianService.runGuardianScan).toHaveBeenCalledTimes(2);
  });

  it('does not schedule when table init fails', async () => {
    guardianService.ensureTables.mockRejectedValueOnce(new Error('no db'));
    await startGuardianScheduler();
    await tick(60 * 1000);
    expect(guardianService.runGuardianScan).not.toHaveBeenCalled();
  });
});

// ── Weekly Report Scheduler ───────────────────────────────────────────────────
describe('Weekly Report Scheduler', () => {
  const { startWeeklyReportScheduler } = require('../src/services/finance/weeklyReport.scheduler');

  it('exports startWeeklyReportScheduler', () => {
    expect(typeof startWeeklyReportScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startWeeklyReportScheduler()).not.toThrow();
  });
});

// ── Audit Scheduler ───────────────────────────────────────────────────────────
describe('Audit Scheduler', () => {
  const { startScheduler } = require('../src/services/audit/audit.scheduler');

  it('exports startScheduler', () => {
    expect(typeof startScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startScheduler()).not.toThrow();
  });
});

// ── Insights Scheduler ────────────────────────────────────────────────────────
describe('Insights Scheduler', () => {
  const { startInsightsScheduler } = require('../src/services/insights/insights.scheduler');

  it('exports startInsightsScheduler', () => {
    expect(typeof startInsightsScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startInsightsScheduler()).not.toThrow();
  });
});

// ── Z-Report Scheduler ────────────────────────────────────────────────────────
describe('Z-Report Scheduler', () => {
  const { startZReportScheduler } = require('../src/services/zreport.scheduler');

  it('exports startZReportScheduler', () => {
    expect(typeof startZReportScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startZReportScheduler()).not.toThrow();
  });
});

// ── Standing Order Scheduler ──────────────────────────────────────────────────
describe('Standing Order Scheduler', () => {
  const { startStandingOrderScheduler } = require('../src/services/suppliers/standingOrder.scheduler');

  it('exports startStandingOrderScheduler', () => {
    expect(typeof startStandingOrderScheduler).toBe('function');
  });

  it('calling start does not throw', () => {
    expect(() => startStandingOrderScheduler()).not.toThrow();
  });
});

// ── paginate utility ──────────────────────────────────────────────────────────
describe('paginate utility', () => {
  const { parsePage } = require('../src/utils/paginate');

  it('defaults: limit=50, offset=0, page=1', () => {
    const { limit, offset, page } = parsePage({});
    expect(limit).toBe(50);
    expect(offset).toBe(0);
    expect(page).toBe(1);
  });

  it('page 2 with limit 10 → offset 10', () => {
    const { limit, offset } = parsePage({ page: '2', limit: '10' });
    expect(limit).toBe(10);
    expect(offset).toBe(10);
  });

  it('limit capped at MAX_LIMIT (200)', () => {
    const { limit } = parsePage({ limit: '9999' });
    expect(limit).toBe(200);
  });

  it('paginate() returns correct envelope shape', () => {
    const { paginate } = parsePage({ page: '1', limit: '10' });
    const rows = [{ id: 1, total_count: '25' }, { id: 2, total_count: '25' }];
    const result = paginate(rows, 25);
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('meta');
    expect(result.meta.total).toBe(25);
    expect(result.meta.totalPages).toBe(3);
    expect(result.meta.hasNextPage).toBe(true);
    expect(result.meta.hasPrevPage).toBe(false);
    // total_count stripped from data
    result.data.forEach(row => expect(row).not.toHaveProperty('total_count'));
  });

  it('paginate() last page → hasNextPage false', () => {
    const { paginate } = parsePage({ page: '3', limit: '10' });
    const result = paginate([], 25);
    expect(result.meta.hasNextPage).toBe(false);
    expect(result.meta.hasPrevPage).toBe(true);
  });
});
