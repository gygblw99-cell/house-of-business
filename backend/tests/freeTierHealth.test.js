/**
 * Free-tier health.
 *
 * The case this exists for: Groq was pinned to a retired model, every call
 * 404-ed, the platform fell through to a paid provider, and nobody noticed for
 * months because nothing read the usage log. The 'dead' verdict is that exact
 * state, so it is pinned hardest.
 */

jest.mock('../src/utils/db', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// Free/paid classification is derived from MODEL_PRICES — free means zero on
// both sides — so a future free provider is classified the moment it is priced.
jest.mock('../src/utils/logTokenUsage', () => ({
  MODEL_PRICES: {
    'llama-free':       { input: 0,          output: 0 },
    'claude-haiku-4-5': { input: 0.000001,   output: 0.000005 },
    'gemini-paid':      { input: 0.00000025, output: 0.0000015 },
  },
}));

const db = require('../src/utils/db');
const { checkFreeTierHealth, getFreeTierIncident, isFreeModel } = require('../src/services/ai/freeTierHealth.service');

/** Rows shaped as the GROUP BY model query returns them. */
function mockModels(rows, { fail = false } = {}) {
  db.query.mockReset();
  if (fail) { db.query.mockRejectedValue(new Error('db down')); return; }
  db.query.mockResolvedValue({ rows });
}
const row = (model, calls, cost_usd = 0) => ({ model, calls, cost_usd });

describe('isFreeModel', () => {
  test('zero on both sides is free', () => expect(isFreeModel('llama-free')).toBe(true));
  test('a priced model is not free', () => expect(isFreeModel('claude-haiku-4-5')).toBe(false));
  test('an unknown model is not assumed free', () => expect(isFreeModel('who-knows')).toBe(false));
});

describe('checkFreeTierHealth', () => {
  test('free tier serving most traffic is healthy', async () => {
    mockModels([row('llama-free', 80), row('claude-haiku-4-5', 20, 0.5)]);
    const h = await checkFreeTierHealth();
    expect(h.verdict).toBe('healthy');
    expect(h.freeShare).toBe(0.8);
    expect(h.freeCalls).toBe(80);
  });

  test('free tier serving nothing is dead — the Groq case', async () => {
    // Exactly the production state: no free call served, everything fell through
    // to paid, and nothing was broken from the owner's point of view.
    mockModels([row('gemini-paid', 60, 0.9), row('claude-haiku-4-5', 40, 6.0)]);
    const h = await checkFreeTierHealth({ windowHours: 24 });
    expect(h.verdict).toBe('dead');
    expect(h.freeCalls).toBe(0);
    expect(h.totalCalls).toBe(100);
    expect(h.reason).toContain('מושבתת');
  });

  test('the dead verdict quantifies what the fallthrough costs', async () => {
    mockModels([row('claude-haiku-4-5', 100, 5.0)]);
    const h = await checkFreeTierHealth({ windowHours: 24 });
    expect(h.paidCostUsd).toBeCloseTo(5, 2);
    // $5 over 24h extended to 30 days — scale, not a forecast.
    expect(h.estimatedMonthlyCostUsd).toBeCloseTo(150, 0);
    expect(h.reason).toContain('150');
  });

  test('under 10% of traffic is degraded, not healthy', async () => {
    mockModels([row('llama-free', 5), row('claude-haiku-4-5', 95, 3.0)]);
    expect((await checkFreeTierHealth()).verdict).toBe('degraded');
  });

  test('just above 10% is healthy', async () => {
    mockModels([row('llama-free', 11), row('claude-haiku-4-5', 89, 1.0)]);
    expect((await checkFreeTierHealth()).verdict).toBe('healthy');
  });

  test('too few calls says so rather than guessing', async () => {
    // A quiet week must not read as an outage.
    mockModels([row('claude-haiku-4-5', 3, 0.1)]);
    expect((await checkFreeTierHealth({ minCalls: 20 })).verdict).toBe('insufficient_data');
  });

  test('no AI traffic at all is insufficient_data, not dead', async () => {
    mockModels([]);
    const h = await checkFreeTierHealth();
    expect(h.verdict).toBe('insufficient_data');
    expect(h.totalCalls).toBe(0);
  });

  test('free-tier cost is excluded from the paid total', async () => {
    mockModels([row('llama-free', 50, 0), row('claude-haiku-4-5', 50, 2.0)]);
    expect((await checkFreeTierHealth()).paidCostUsd).toBeCloseTo(2.0, 4);
  });

  test('an unknown model counts as paid, so a mystery model cannot hide the problem', async () => {
    mockModels([row('who-knows', 100, 4.0)]);
    const h = await checkFreeTierHealth();
    expect(h.verdict).toBe('dead');
    expect(h.byModel['who-knows'].free).toBe(false);
  });

  test('a database failure reports unknown rather than a false alarm', async () => {
    mockModels([], { fail: true });
    expect((await checkFreeTierHealth()).verdict).toBe('unknown');
  });

  test('defaults to a one-week window', async () => {
    mockModels([row('llama-free', 30)]);
    await checkFreeTierHealth();
    // 24h is below the significance floor at this traffic level and would only
    // ever report insufficient_data.
    expect(db.query.mock.calls[0][1]).toEqual([168]);
  });

  test('the window is passed through to the query', async () => {
    mockModels([row('llama-free', 30)]);
    await checkFreeTierHealth({ windowHours: 6 });
    expect(db.query.mock.calls[0][1]).toEqual([6]);
  });

  test('it reads ai_usage_logs, not the near-empty ai_logs', async () => {
    mockModels([row('llama-free', 30)]);
    await checkFreeTierHealth();
    // ai_logs holds one row, last written months ago; querying it would make
    // this check report insufficient_data forever.
    expect(db.query.mock.calls[0][0]).toMatch(/FROM ai_usage_logs/);
  });
});

describe('getFreeTierIncident', () => {
  test('raises a high-severity incident when dead', async () => {
    mockModels([row('claude-haiku-4-5', 100, 4.0)]);
    const inc = await getFreeTierIncident();
    expect(inc).not.toBeNull();
    // High, not critical: nothing is broken for the owner, the platform is just
    // paying for what it should not have to. It still mails the admin.
    expect(inc.severity).toBe('high');
    expect(inc.feature).toBe('ai_free_tier');
  });

  test('raises a medium incident when degraded', async () => {
    mockModels([row('llama-free', 2), row('claude-haiku-4-5', 98, 3.0)]);
    expect((await getFreeTierIncident()).severity).toBe('medium');
  });

  test('stays quiet when healthy', async () => {
    mockModels([row('llama-free', 90), row('claude-haiku-4-5', 10, 0.3)]);
    expect(await getFreeTierIncident()).toBeNull();
  });

  test('stays quiet on insufficient data — no alert from a quiet week', async () => {
    mockModels([row('claude-haiku-4-5', 2, 0.1)]);
    expect(await getFreeTierIncident()).toBeNull();
  });

  test('stays quiet when the check itself could not run', async () => {
    mockModels([], { fail: true });
    expect(await getFreeTierIncident()).toBeNull();
  });
});
