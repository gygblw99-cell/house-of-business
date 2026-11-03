const { Pool } = require('pg');
const logger   = require('./logger');

const isSupabase       = (process.env.DATABASE_URL || '').includes('supabase.co');
// Supavisor (Supabase's pooler) presents a cert chain Node's bundled CA store
// can't fully verify, unlike the direct-connection endpoint — needs rejectUnauthorized
// off even in production, or every connection attempt fails at the TLS handshake.
const isSupabasePooler = (process.env.DATABASE_URL || '').includes('pooler.supabase.com');
const isProd     = process.env.NODE_ENV === 'production';

// When a DATABASE_URL is provided it fully describes the target (host, user,
// password, db) — including the Supabase pooler's tenant-qualified user
// (postgres.<ref>). node-postgres lets explicit host/user/password win over the
// connection string, so ALSO passing DB_HOST/DB_USER here silently redirected
// every connection to the direct IPv6 endpoint (db.<ref>.supabase.co) with the
// wrong user. That direct endpoint connects only intermittently, which crashed
// bootstrap on restart. Prefer the connection string when we have one; fall
// back to the discrete DB_* vars only when it's absent.
const connTarget = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME || 'postgres',
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool({
  ...connTarget,
  // Configurable so a diagnostic script can run alongside the live server
  // without exhausting the Supabase pooler's 15-client session limit.
  max: parseInt(process.env.DB_POOL_MAX, 10) || 7,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: isSupabase ? { rejectUnauthorized: isProd && !isSupabasePooler } : false,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { message: err.message, code: err.code });
});

function closePool() {
  return pool.end();
}

// Only retry on connection-refused/reset codes — ETIMEDOUT excluded because the query
// may have already executed server-side and retrying could cause duplicate writes.
const RETRYABLE = new Set(['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// pg's pool-connection-acquisition timeout throws a plain Error with no .code,
// only this message. Safe to retry: no query was ever sent (connection was
// never acquired), so there's no risk of a duplicate write — unlike ETIMEOUT.
const isPoolConnectTimeout = (err) =>
  !err.code && /timeout exceeded when trying to connect/i.test(err.message || '');

const SLOW_QUERY_MS = 500; // log queries slower than this

async function query(text, params) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now(); // reset per-attempt so backoff sleep is not counted as query time
    try {
      // Hand-rolled here rather than via utils/withTimeout because callers and
      // the retry predicate below branch on err.code === 'ETIMEOUT'.
      //
      // The timer MUST be cleared. This is the hottest path in the process —
      // every query in the application goes through it — and the previous
      // version left a 10-second timer armed on every successful query, each
      // holding its reject closure alive. That was the single largest
      // contributor to the process never settling.
      let timeoutId;
      let result;
      try {
        result = await Promise.race([
          pool.query(text, params),
          new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(Object.assign(new Error('DB query timeout'), { code: 'ETIMEOUT' })),
              10_000
            );
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
      const ms = Date.now() - t0;
      if (ms >= SLOW_QUERY_MS) {
        logger.warn('[DB] Slow query', { ms, query: text.trim().slice(0, 120) });
      }
      return result;
    } catch (err) {
      const retryable = (RETRYABLE.has(err.code) || isPoolConnectTimeout(err)) && attempt < MAX_ATTEMPTS - 1;
      if (!retryable) throw err;
      await sleep(400 * Math.pow(2, attempt)); // 400ms then 800ms
    }
  }
}

const getClient = () => pool.connect();

// Fire-and-forget schema migration with logging — use instead of db.query(...).catch(() => {})
function migrate(sql) {
  return pool.query(sql).catch(e => {
    logger.warn('Startup migration failed', { message: e.message, hint: sql.trim().slice(0, 100) });
  });
}

module.exports = { query, getClient, pool, closePool, migrate };
