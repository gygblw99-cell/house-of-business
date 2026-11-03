/**
 * Backend reactors.
 *
 * The safety rules in services/reactors/index.js are what make this safe to add
 * to a system where events are replayed from an outbox, so each one is pinned
 * by a test: no cycles, no throwing into the publisher, idempotent, and the
 * invalidation set actually covers what the old hand-maintained list missed.
 */

jest.mock('../src/utils/cache', () => ({ del: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/dateIL', () => ({ todayIL: () => '2026-10-01' }));

const cache    = require('../src/utils/cache');
const eventBus = require('../src/utils/eventBus');
const reactors = require('../src/services/reactors');
const derived  = require('../src/services/reactors/derivedData.reactor');

const BIZ = 'biz-1';

/** Lets the setImmediate inside the bus listener and the handler's awaits settle. */
const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

beforeEach(() => {
  jest.clearAllMocks();
  reactors._reset();
  eventBus.removeAllListeners?.('*');
});

afterAll(() => { reactors._reset(); });

describe('reactor registry', () => {
  test('a registered reactor runs when its event is published', async () => {
    const seen = [];
    reactors.on('invoice_approved', 'test', ({ businessId, data }) => { seen.push({ businessId, data }); });
    reactors.startReactors();

    eventBus.publish(BIZ, 'invoice_approved', { invoiceId: 'inv-1' });
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].businessId).toBe(BIZ);
    expect(seen[0].data.invoiceId).toBe('inv-1');
  });

  test('an unrelated event does not run it', async () => {
    const fn = jest.fn();
    reactors.on('invoice_approved', 'test', fn);
    reactors.startReactors();

    eventBus.publish(BIZ, 'something_else', {});
    await settle();

    expect(fn).not.toHaveBeenCalled();
  });

  test('a throwing reactor never reaches the publisher', async () => {
    reactors.on('invoice_approved', 'boom', () => { throw new Error('reactor exploded'); });
    reactors.startReactors();

    // publish() is called from request handlers that have often already sent
    // their response; an escaping rejection is fatal for the whole process.
    expect(() => eventBus.publish(BIZ, 'invoice_approved', {})).not.toThrow();
    await settle();
  });

  test('a rejecting async reactor never reaches the publisher', async () => {
    reactors.on('invoice_approved', 'boom-async', async () => { throw new Error('async boom'); });
    reactors.startReactors();
    expect(() => eventBus.publish(BIZ, 'invoice_approved', {})).not.toThrow();
    await settle();
  });

  test('one failing reactor does not stop the others on the same event', async () => {
    const ok = jest.fn();
    reactors.on('invoice_approved', 'bad',  () => { throw new Error('nope'); });
    reactors.on('invoice_approved', 'good', ok);
    reactors.startReactors();

    eventBus.publish(BIZ, 'invoice_approved', {});
    await settle();

    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('startReactors is idempotent — a double call does not double-run', async () => {
    const fn = jest.fn();
    reactors.on('invoice_approved', 'test', fn);
    reactors.startReactors();
    reactors.startReactors();

    eventBus.publish(BIZ, 'invoice_approved', {});
    await settle();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('stats reports what is registered', () => {
    reactors.on('a', 'r1', jest.fn());
    reactors.on('a', 'r2', jest.fn());
    reactors.on('b', 'r3', jest.fn());
    reactors.startReactors();
    const s = reactors.stats();
    expect(s.started).toBe(true);
    expect(s.count).toBe(3);
    expect(s.events.sort()).toEqual(['a', 'b']);
  });
});

describe('derivedData reactor', () => {
  beforeEach(() => { derived.register(); reactors.startReactors(); });

  /** Every key the reactor cleared, as plain strings. */
  const clearedKeys = () => cache.del.mock.calls.map(c => c[0]);

  test('an approved invoice clears the cost keys the route used to miss', async () => {
    eventBus.publish(BIZ, 'invoice_approved', { invoiceId: 'inv-1' });
    await settle();

    const keys = clearedKeys();
    // These six are computed from ingredient cost and were NOT in the route's
    // hand-maintained bust list — the actual bug this reactor closes.
    for (const missed of [
      `ingredient-cost:${BIZ}:*`,
      `ingredient-leakage:${BIZ}:*`,
      `profit-leaks:${BIZ}`,
      `finance-cashflow:${BIZ}:*`,
      `weekly-report:${BIZ}:*`,
      `survival-mode:${BIZ}`,
    ]) {
      expect(keys).toContain(missed);
    }
  });

  test('it also clears the AI advisor view, which quotes costs back to the owner', async () => {
    eventBus.publish(BIZ, 'invoice_approved', {});
    await settle();
    expect(clearedKeys()).toContain(`ai-context:${BIZ}`);
  });

  test('recorded waste clears the cost keys', async () => {
    eventBus.publish(BIZ, 'waste_recorded', { itemName: 'עגבניות' });
    await settle();
    expect(clearedKeys()).toContain(`ingredient-cost:${BIZ}:*`);
  });

  test('a closed shift clears the labor and statement keys', async () => {
    eventBus.publish(BIZ, 'shift_closed', { shiftId: 's-1' });
    await settle();
    const keys = clearedKeys();
    expect(keys).toContain(`profit-leaks:${BIZ}`);
    expect(keys).toContain(`finance-cashflow:${BIZ}:*`);
  });

  test('finance.updated clears sales-derived keys, with today expanded', async () => {
    eventBus.publish(BIZ, 'finance.updated', { action: 'zreport_import' });
    await settle();
    const keys = clearedKeys();
    expect(keys).toContain(`dashboard:${BIZ}`);
    expect(keys).toContain(`daily-summary:${BIZ}:2026-10-01`);
    expect(keys).toContain(`zreport:missing:${BIZ}`);
  });

  test('full_sync is skipped — fullCacheBust already cleared everything', async () => {
    eventBus.publish(BIZ, 'finance.updated', { source: 'full_sync' });
    await settle();
    expect(cache.del).not.toHaveBeenCalled();
  });

  test('replaying the same event twice changes nothing beyond clearing again', async () => {
    eventBus.publish(BIZ, 'invoice_approved', { invoiceId: 'inv-1' });
    await settle();
    const first = new Set(clearedKeys());

    cache.del.mockClear();
    eventBus.publish(BIZ, 'invoice_approved', { invoiceId: 'inv-1' });
    await settle();
    const second = new Set(clearedKeys());

    // Idempotent: clearing an already-clear key is a no-op, so an outbox replay
    // is indistinguishable from the first delivery.
    expect([...second].sort()).toEqual([...first].sort());
  });

  test('no event without a businessId causes a key with "undefined" in it', async () => {
    eventBus.publish(null, 'invoice_approved', {});
    await settle();
    expect(clearedKeys().some(k => k.includes('undefined') || k.includes('null'))).toBe(false);
  });

  test('a cache failure does not make the reactor throw', async () => {
    cache.del.mockRejectedValue(new Error('redis down'));
    expect(() => eventBus.publish(BIZ, 'invoice_approved', {})).not.toThrow();
    await settle();
  });

  test('no reactor publishes an event — a cycle cannot form', async () => {
    const published = [];
    const spy = (eventType) => published.push(eventType);
    eventBus.on('*', spy);

    eventBus.publish(BIZ, 'invoice_approved', {});
    await settle();
    await settle();

    // Only the event we published ourselves. If a reactor re-emitted, the
    // outbox would persist every iteration of the loop.
    expect(published).toEqual(['invoice_approved']);
    eventBus.off?.('*', spy);
  });
});
