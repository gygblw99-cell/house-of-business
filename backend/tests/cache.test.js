/**
 * Cache Utility — Unit Tests (in-memory path, no Redis)
 */

// Ensure no Redis URL so we always hit the in-memory path
delete process.env.REDIS_URL;

const cache = require('../src/utils/cache');

// Helper to wait (for TTL expiry tests)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  // Clear all keys between tests by deleting known prefixes
  await cache.del('test:*');
});

describe('cache.set / cache.get', () => {
  it('שומר וקורא ערך', async () => {
    await cache.set('test:key1', { hello: 'world' }, 60);
    const val = await cache.get('test:key1');
    expect(val).toEqual({ hello: 'world' });
  });

  it('ערך לא קיים → null', async () => {
    const val = await cache.get('test:nonexistent');
    expect(val).toBeUndefined();
  });

  it('TTL פג → מחזיר null', async () => {
    await cache.set('test:ttl', 'expires-soon', 0.001); // 1ms TTL
    await sleep(10);
    const val = await cache.get('test:ttl');
    expect(val).toBeUndefined();
  });

  it('עדכון ערך קיים', async () => {
    await cache.set('test:update', 'original', 60);
    await cache.set('test:update', 'updated', 60);
    const val = await cache.get('test:update');
    expect(val).toBe('updated');
  });

  it('שומר מספרים', async () => {
    await cache.set('test:num', 42, 60);
    const val = await cache.get('test:num');
    expect(val).toBe(42);
  });

  it('שומר arrays', async () => {
    await cache.set('test:arr', [1, 2, 3], 60);
    const val = await cache.get('test:arr');
    expect(val).toEqual([1, 2, 3]);
  });

  it('שומר null כערך (object עם null)', async () => {
    await cache.set('test:obj', { value: null }, 60);
    const val = await cache.get('test:obj');
    expect(val).toEqual({ value: null });
  });
});

describe('cache.del', () => {
  it('מוחק key ספציפי', async () => {
    await cache.set('test:del1', 'x', 60);
    await cache.del('test:del1');
    expect(await cache.get('test:del1')).toBeUndefined();
  });

  it('מחיקת key לא קיים — לא זורק שגיאה', async () => {
    await expect(cache.del('test:ghost')).resolves.toBeUndefined();
  });

  it('wildcard מוחק כל ה-keys עם prefix', async () => {
    await cache.set('test:biz1:a', 'v1', 60);
    await cache.set('test:biz1:b', 'v2', 60);
    await cache.set('test:biz2:a', 'v3', 60);
    await cache.del('test:biz1:*');
    expect(await cache.get('test:biz1:a')).toBeUndefined();
    expect(await cache.get('test:biz1:b')).toBeUndefined();
    // biz2 לא נמחק
    expect(await cache.get('test:biz2:a')).toBe('v3');
  });

  it('wildcard עם prefix מדויק מוחק את כל הkeys', async () => {
    await cache.set('dash:abc123:30',  'v1', 60);
    await cache.set('dash:abc123:60',  'v2', 60);
    await cache.set('dash:abc123:365', 'v3', 60);
    await cache.del('dash:abc123:*');
    expect(await cache.get('dash:abc123:30')).toBeUndefined();
    expect(await cache.get('dash:abc123:60')).toBeUndefined();
    expect(await cache.get('dash:abc123:365')).toBeUndefined();
  });
});

describe('cache.wrap', () => {
  it('מריץ fn פעם אחת גם אם נקרא פעמיים', async () => {
    const fn = jest.fn().mockResolvedValue({ data: 'expensive' });
    const r1 = await cache.wrap('test:wrap1', fn, 60);
    const r2 = await cache.wrap('test:wrap1', fn, 60);
    expect(r1).toEqual({ data: 'expensive' });
    expect(r2).toEqual({ data: 'expensive' });
    expect(fn).toHaveBeenCalledTimes(1); // cached on second call
  });

  it('אחרי מחיקה — מריץ fn שוב', async () => {
    const fn = jest.fn().mockResolvedValue('fresh');
    await cache.wrap('test:wrap2', fn, 60);
    await cache.del('test:wrap2');
    await cache.wrap('test:wrap2', fn, 60);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('שגיאה ב-fn → מועברת למעלה', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('DB error'));
    await expect(cache.wrap('test:wrap3', fn, 60)).rejects.toThrow('DB error');
  });

  it('null הוא ערך תקין בקאש — לא נחשב כ-miss', async () => {
    // Regression test: wrap() used to treat a cached `null` the same as "not
    // cached" (both used the `null` sentinel), so fn() re-ran on every call
    // for exactly this value instead of ever being served from cache.
    const fn = jest.fn().mockResolvedValue(null);
    const r1 = await cache.wrap('test:wrap-null', fn, 60);
    const r2 = await cache.wrap('test:wrap-null', fn, 60);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
