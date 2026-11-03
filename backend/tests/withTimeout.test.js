/**
 * withTimeout — the property that matters is that the timer is ALWAYS cleared.
 *
 * The leak this replaces: 16 of 20 hand-rolled Promise.race timeouts never
 * cleared theirs, so every AI call, invoice OCR and DB query left a live timer
 * holding its reject closure. Node would not settle, and the orchestrator tests
 * failed intermittently as the timers piled up.
 */

const { withTimeout, TimeoutError } = require('../src/utils/withTimeout');

describe('withTimeout', () => {
  test('resolves with the work result when it finishes first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'fast')).resolves.toBe('ok');
  });

  test('accepts a function so the work starts inside the race', async () => {
    const start = jest.fn().mockResolvedValue('ok');
    await expect(withTimeout(start, 1000, 'fn')).resolves.toBe('ok');
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("propagates the work's own rejection unchanged", async () => {
    const boom = new Error('upstream 500');
    await expect(withTimeout(Promise.reject(boom), 1000, 'x')).rejects.toBe(boom);
  });

  test('rejects with a TimeoutError when the deadline passes first', async () => {
    const never = new Promise(() => {});
    const p = withTimeout(never, 20, 'Haiku');
    await expect(p).rejects.toThrow(TimeoutError);
    await expect(withTimeout(new Promise(() => {}), 20, 'Haiku')).rejects.toThrow(/Haiku timed out after 20ms/);
  });

  test('the TimeoutError is identifiable without string matching', async () => {
    try {
      await withTimeout(new Promise(() => {}), 10, 'label');
      throw new Error('should have timed out');
    } catch (err) {
      expect(err.isTimeout).toBe(true);
      expect(err.name).toBe('TimeoutError');
      expect(err.timeoutMs).toBe(10);
    }
  });

  describe('the timer is cleared', () => {
    // Spying on the real timer functions is the only way to assert the leak is
    // gone — the symptom was an armed timer, not a wrong return value.
    let setSpy, clearSpy;
    beforeEach(() => {
      setSpy   = jest.spyOn(global, 'setTimeout');
      clearSpy = jest.spyOn(global, 'clearTimeout');
    });
    afterEach(() => { setSpy.mockRestore(); clearSpy.mockRestore(); });

    test('after the work resolves', async () => {
      await withTimeout(Promise.resolve(1), 30_000, 'x');
      expect(setSpy).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
    });

    test('after the work rejects', async () => {
      await expect(withTimeout(Promise.reject(new Error('nope')), 30_000, 'x')).rejects.toThrow('nope');
      expect(clearSpy).toHaveBeenCalled();
    });

    test('after the timeout itself fires', async () => {
      await expect(withTimeout(new Promise(() => {}), 10, 'x')).rejects.toThrow(TimeoutError);
      expect(clearSpy).toHaveBeenCalled();
    });

    test('a fast call does not leave a long timer armed', async () => {
      // This is the exact shape of the production leak: a 30s deadline on a
      // call that returns immediately.
      await withTimeout(Promise.resolve('fast'), 30_000, 'Haiku');
      const armed = setSpy.mock.results.map(r => r.value);
      const cleared = clearSpy.mock.calls.map(c => c[0]);
      for (const t of armed) expect(cleared).toContain(t);
    });
  });

  test('a rejection arriving after the timeout does not become unhandled', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    // Work that fails 40ms after a 10ms deadline — nothing is awaiting it by
    // then, and this process treats unhandled rejections as fatal.
    let rejectLater;
    const slowFail = new Promise((_, rej) => { rejectLater = rej; });
    await expect(withTimeout(slowFail, 10, 'late')).rejects.toThrow(TimeoutError);
    rejectLater(new Error('arrived too late'));

    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toHaveLength(0);
  });

  test('works without a label', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow(/timed out after 10ms/);
  });
});
