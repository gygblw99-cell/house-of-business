/**
 * Advisory-lock behaviour for scheduled jobs.
 *
 * The property that matters: with two replicas ticking the same job at the same
 * time, exactly one runs. Everything else here guards the ways that could fail
 * open — a lock that is never released, or a database error that lets the job
 * through anyway.
 */

const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../src/utils/db', () => ({ getClient: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../src/utils/db');
const { withJobLock, locked } = require('../src/utils/jobLock');

/** Makes the next getClient() hand back a client whose lock attempt returns `got`. */
function clientThatGrants(got) {
  const client = {
    query: jest.fn().mockImplementation((sql) => {
      if (/pg_try_advisory_lock/.test(sql)) return Promise.resolve({ rows: [{ got }] });
      if (/pg_advisory_unlock/.test(sql))   return Promise.resolve({ rows: [{}] });
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  db.getClient.mockResolvedValueOnce(client);
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.release.mockReset();
});

describe('withJobLock', () => {
  test('runs the job when the lock is granted', async () => {
    clientThatGrants(true);
    const job = jest.fn().mockResolvedValue('done');
    const out = await withJobLock('my-job', job);
    expect(out).toEqual({ ran: true, result: 'done' });
    expect(job).toHaveBeenCalledTimes(1);
  });

  test('skips the job when another instance holds the lock', async () => {
    clientThatGrants(false);
    const job = jest.fn();
    const out = await withJobLock('my-job', job);
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('locked_elsewhere');
    expect(job).not.toHaveBeenCalled();
  });

  test('two concurrent instances run the job exactly once', async () => {
    // First caller wins the lock, second is refused — what Postgres does.
    clientThatGrants(true);
    clientThatGrants(false);
    const job = jest.fn().mockResolvedValue(null);

    const [a, b] = await Promise.all([
      withJobLock('nightly', job),
      withJobLock('nightly', job),
    ]);

    expect(job).toHaveBeenCalledTimes(1);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
  });

  test('releases the lock after a successful run', async () => {
    const client = clientThatGrants(true);
    await withJobLock('my-job', async () => 'ok');
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /pg_advisory_unlock/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('releases the lock even when the job throws, and rethrows', async () => {
    const client = clientThatGrants(true);
    await expect(
      withJobLock('my-job', async () => { throw new Error('job failed'); }),
    ).rejects.toThrow('job failed');

    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /pg_advisory_unlock/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('does not try to unlock a lock it never took', async () => {
    const client = clientThatGrants(false);
    await withJobLock('my-job', jest.fn());
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /pg_advisory_unlock/.test(s))).toBe(false);
  });

  test('skips rather than runs when no connection is available', async () => {
    db.getClient.mockRejectedValueOnce(new Error('pool exhausted'));
    const job = jest.fn();
    const out = await withJobLock('my-job', job);
    // Failing open would be the dangerous choice — a double-charge is worse
    // than a missed tick, and the next tick retries.
    expect(out.ran).toBe(false);
    expect(job).not.toHaveBeenCalled();
  });

  test('different job names do not block each other', async () => {
    clientThatGrants(true);
    clientThatGrants(true);
    const a = jest.fn().mockResolvedValue(1);
    const b = jest.fn().mockResolvedValue(2);
    await Promise.all([withJobLock('job-a', a), withJobLock('job-b', b)]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('locked()', () => {
  test('passes arguments through and returns the job result', async () => {
    clientThatGrants(true);
    const fn = jest.fn().mockResolvedValue('result');
    const wrapped = locked('wrapped-job', fn);
    const out = await wrapped('a', 2);
    expect(fn).toHaveBeenCalledWith('a', 2);
    expect(out).toBe('result');
  });

  test('returns undefined when the run was skipped', async () => {
    clientThatGrants(false);
    const fn = jest.fn();
    const out = await locked('wrapped-job', fn)();
    expect(out).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  test('still throws when the job throws, so scheduler error handling applies', async () => {
    clientThatGrants(true);
    const wrapped = locked('wrapped-job', async () => { throw new Error('boom'); });
    await expect(wrapped()).rejects.toThrow('boom');
  });
});
