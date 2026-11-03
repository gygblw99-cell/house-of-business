const Redis = require('ioredis');
const logger = require('./logger');

let client = null;

// ── In-memory fallback (used when Redis is unavailable) ───────────────────────
const MEM_MAX      = 500;
const memStore     = new Map(); // key → { value, expiresAt }
const memPrefixIdx = new Map(); // 'type:businessId' → Set<fullKey> — O(1) wildcard deletes

function _prefixKey(fullKey) {
  const parts = fullKey.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0];
}

// Returns undefined (not null) for a miss/expiry — null is a legitimate
// value some callers cache (e.g. "this user no longer exists"), and using
// null as the miss sentinel made wrap() re-fetch on every call for exactly
// that value instead of ever serving it from cache.
function memGet(key) {
  const entry = memStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memStore.delete(key);
    memPrefixIdx.get(_prefixKey(key))?.delete(key);
    return undefined;
  }
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  if (memStore.size >= MEM_MAX) {
    const oldKey = memStore.keys().next().value;
    memStore.delete(oldKey);
    memPrefixIdx.get(_prefixKey(oldKey))?.delete(oldKey);
  }
  memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
  const pKey = _prefixKey(key);
  if (!memPrefixIdx.has(pKey)) memPrefixIdx.set(pKey, new Set());
  memPrefixIdx.get(pKey).add(key);
}

function memDel(keyOrPattern) {
  if (keyOrPattern.includes('*')) {
    // Fast path: a single TRAILING wildcard (e.g. 'context:UUID:*') can use the
    // O(1) prefix index. Any other wildcard shape (leading/middle, e.g.
    // '*:businessId*') must NOT be treated as a prefix — reducing it to a
    // prefix by stripping from the first '*' onward previously produced an
    // empty prefix for leading-wildcard patterns, matching (and deleting)
    // every key in the store.
    const isSimpleTrailingWildcard = keyOrPattern.indexOf('*') === keyOrPattern.length - 1;
    if (isSimpleTrailingWildcard) {
      const rawPrefix = keyOrPattern.slice(0, -1);
      const lookupKey = rawPrefix.endsWith(':')
        ? rawPrefix.slice(0, -1)                                  // 'context:UUID'
        : rawPrefix;
      const indexed = memPrefixIdx.get(lookupKey);
      if (indexed) {
        for (const k of indexed) memStore.delete(k);
        memPrefixIdx.delete(lookupKey);
        return;
      }
    }
    // General case: match the pattern as a real glob (wildcard anywhere).
    const regex = new RegExp('^' + keyOrPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const k of Array.from(memStore.keys())) {
      if (regex.test(k)) {
        memStore.delete(k);
        memPrefixIdx.get(_prefixKey(k))?.delete(k);
      }
    }
  } else {
    memStore.delete(keyOrPattern);
    memPrefixIdx.get(_prefixKey(keyOrPattern))?.delete(keyOrPattern);
  }
}

// ── Redis client ──────────────────────────────────────────────────────────────
function getRedisClient() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    logger.warn('Redis error — falling back to in-memory cache', { message: err.message });
    const stale = client;
    client = null;
    stale.disconnect();
  });

  client.on('connect', () => logger.info('Redis connected'));
  return client;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function get(key) {
  try {
    const c = getRedisClient();
    if (c) {
      const raw = await c.get(key);
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch (e) { logger.warn('[Cache] JSON parse error', { key, err: e.message }); return undefined; }
    }
  } catch (err) { logger.warn('[Cache] Redis get error', { key, err: err.message }); }
  return memGet(key);
}

async function set(key, value, ttl = 120) {
  try {
    const c = getRedisClient();
    if (c) {
      await c.set(key, JSON.stringify(value), 'EX', ttl);
      return;
    }
  } catch (err) { logger.warn('[Cache] Redis set error', { key, err: err.message }); }
  memSet(key, value, ttl);
}

async function del(keyOrPattern) {
  try {
    const c = getRedisClient();
    if (c) {
      if (keyOrPattern.includes('*')) {
        let cursor = '0';
        do {
          const [next, keys] = await c.scan(cursor, 'MATCH', keyOrPattern, 'COUNT', 100);
          cursor = next;
          if (keys.length) await c.del(...keys);
        } while (cursor !== '0');
      } else {
        await c.del(keyOrPattern);
      }
      return;
    }
  } catch (err) { logger.warn('[Cache] Redis del error', { key: keyOrPattern, err: err.message }); }
  memDel(keyOrPattern);
}

async function wrap(key, fn, ttl = 120) {
  const cached = await get(key);
  if (cached !== undefined) return cached;
  const data = await fn();
  await set(key, data, ttl);
  return data;
}

// In-flight lock map for in-memory stampede protection (used when Redis is unavailable)
const _inFlight = new Map();

// wrapWithLock — prevents cache stampede by serializing concurrent cache-miss rebuilds.
// Only one caller rebuilds; all others wait for the same promise.
// Uses Redis SETNX lock when available, falls back to in-memory promise dedup.
async function wrapWithLock(key, fn, ttl = 120, lockTtlSeconds = 30) {
  const cached = await get(key);
  if (cached !== undefined) return cached;

  // Try Redis lock
  const lockKey = `lock:${key}`;
  const c = getRedisClient();
  if (c) {
    try {
      const acquired = await c.set(lockKey, '1', 'EX', lockTtlSeconds, 'NX');
      if (acquired) {
        try {
          // Double-check after lock acquisition (another process may have filled it)
          const fresh = await get(key);
          if (fresh !== undefined) return fresh;
          const data = await fn();
          await set(key, data, ttl);
          return data;
        } finally {
          c.del(lockKey).catch(() => {});
        }
      } else {
        // Another process holds the lock — poll briefly for its result
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 200));
          const polled = await get(key);
          if (polled !== undefined) return polled;
        }
        // Lock holder appears to have died (no result after 2s).
        // Fall through to the in-memory dedup path below so all waiters in THIS
        // process share one rebuild instead of all calling fn() independently.
      }
    } catch (redisErr) {
      // Only fall through to in-memory dedup when Redis itself is unavailable.
      // Re-throw application errors (thrown by fn()) so callers see real failures.
      // Accept any error whose origin is the Redis client itself — identified by constructor
      // name (covers ioredis ReplyError, AbortError, MaxRetriesPerRequestError) or by the
      // low-level TCP error codes that the underlying net socket emits.
      const ctorName = redisErr?.constructor?.name || '';
      const isRedisErr = redisErr && (
        redisErr.code === 'ECONNREFUSED' ||
        redisErr.code === 'ENOTCONN' ||
        redisErr.code === 'NR_CLOSED' ||
        redisErr.code === 'EPIPE' ||
        ctorName === 'ReplyError' ||
        ctorName === 'AbortError' ||
        ctorName === 'MaxRetriesPerRequestError' ||
        redisErr.message?.includes('Redis') ||
        redisErr.message?.includes('max retries')
      );
      if (!isRedisErr) throw redisErr;
      // Redis is down — fall through to in-memory dedup below
    }
  }

  // In-memory dedup (single-process, no Redis)
  if (_inFlight.has(key)) return _inFlight.get(key);
  const promise = fn().then(async data => {
    // Await set() before deleting the in-flight entry so no concurrent caller sees
    // a gap where neither cache nor in-flight exists (stampede window).
    await set(key, data, ttl).catch(() => {});
    _inFlight.delete(key);
    return data;
  }).catch(err => {
    _inFlight.delete(key);
    throw err;
  });
  _inFlight.set(key, promise);
  return promise;
}

module.exports = { get, set, del, wrap, wrapWithLock };
