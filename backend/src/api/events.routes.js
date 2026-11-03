/**
 * SSE — Server-Sent Events
 * GET /api/events?token=<sse-token>&since=<unix-ms>
 *
 * Reconnect replay: if `since` query param is provided, events from the outbox
 * that arrived after that timestamp are sent before the live stream begins.
 * This bridges the gap clients experience during a brief disconnect.
 */
const express  = require('express');
const router   = express.Router();
const { requireAuthSSE } = require('../middleware/auth');
const { requireAdmin }   = require('../middleware/requireAdmin');
const eventBus = require('../utils/eventBus');
const db       = require('../utils/db');

// Map: businessId → Set of response objects
const clients = new Map();

// ── GET /api/events — connects SSE client ─────────────────────
router.get('/', requireAuthSSE, async (req, res) => {
  const businessId = req.user.businessId;

  // A client that aborts the connection between requireAuthSSE resolving and
  // this handler running can make flushHeaders() throw (socket already
  // destroyed). Uncaught inside this async handler that becomes an unhandled
  // rejection, and index.js's global handler kills the whole process for
  // every tenant 5s later — so this must never escape uncaught.
  try {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  } catch {
    return;
  }

  // ── Replay missed events from outbox ─────────────────────────
  // Client sends `since=<unix-ms>` on reconnect so we can deliver events missed during disconnect.
  // Cap at the outbox retention window (5 minutes — outbox rows older than that are pruned by
  // eventBus.js). Capping beyond the retention window would query rows that no longer exist.
  const OUTBOX_RETENTION_MS = 5 * 60_000;
  const sinceRaw = parseInt(req.query.since, 10);
  if (sinceRaw && !isNaN(sinceRaw) && sinceRaw > 0) {
    const sinceDate = new Date(Math.max(sinceRaw, Date.now() - OUTBOX_RETENTION_MS));
    try {
      const { rows } = await db.query(
        `SELECT event_type, payload, created_at
         FROM sync_events_outbox
         WHERE business_id = $1 AND created_at > $2
         ORDER BY id ASC
         LIMIT 100`,
        [businessId, sinceDate.toISOString()]
      );
      for (const row of rows) {
        const data = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const payload = `event: ${row.event_type}\ndata: ${JSON.stringify({ ...data, ts: new Date(row.created_at).getTime(), replayed: true })}\n\n`;
        try { res.write(payload); } catch { break; }
      }
    } catch { /* replay failure must not block the live stream */ }
  }

  // Send initial connected ping
  try {
    res.write(`event: connected\ndata: ${JSON.stringify({ businessId, ts: Date.now() })}\n\n`);
  } catch { return; }

  // Register client
  if (!clients.has(businessId)) clients.set(businessId, new Set());
  const businessClients = clients.get(businessId);
  if (businessClients.size >= 20) {
    // Evict the oldest connection to prevent unbounded growth per business
    const [oldest] = businessClients;
    try { oldest.end(); } catch {}
    businessClients.delete(oldest);
  }
  businessClients.add(res);

  // Heartbeat every 30s to prevent timeout
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // On first connection (no `since` param) push initial data-load triggers.
  // SSE is purely reactive — components that wait for events never fire on a
  // fresh session or new account unless we seed the stream immediately.
  if (!sinceRaw || isNaN(sinceRaw) || sinceRaw <= 0) {
    const initTs = Date.now();
    for (const evt of ['dashboard.refresh', 'inventory.updated', 'finance.updated']) {
      try { res.write(`event: ${evt}\ndata: ${JSON.stringify({ reason: 'initial_connect', ts: initTs })}\n\n`); }
      catch { break; }
    }
  }

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.get(businessId)?.delete(res);
    if (clients.get(businessId)?.size === 0) clients.delete(businessId);
  });
});

// ── emit — called internally to push event to all clients of a business ──
function emit(businessId, eventType, data) {
  const businessClients = clients.get(businessId);
  if (!businessClients?.size) return;

  const safeEventType = (eventType || 'message').replace(/[\r\n]/g, '_');
  const payload = `event: ${safeEventType}\ndata: ${JSON.stringify({ ...data, ts: Date.now() })}\n\n`;
  for (const res of businessClients) {
    try { res.write(payload); } catch { businessClients.delete(res); }
  }
}

// ── Admin stream ────────────────────────────────────────────────────────────
// The tenant stream above is keyed by businessId and gated by tenant auth, so an
// admin — who has no businessId — could not subscribe to anything. Every admin
// page therefore polled on a 60-second timer, including the tickets page, while
// the backend was already publishing ticket.updated.
//
// This is a separate connection set fanned out across ALL businesses, carrying
// only the events an operator acts on. It deliberately does not forward the
// tenant firehose: an admin does not need every inventory edit in every
// business, and the payload already includes business_id where it matters.
const adminClients = new Set();

const ADMIN_EVENTS = new Set([
  'ticket.updated',   // support queue
  'sync.error',       // a business's POS/Gmail sync broke
  'business.updated', // created / suspended / billing changed
]);

function emitAdmin(eventType, businessId, data) {
  if (!adminClients.size) return;
  const safeEventType = (eventType || 'message').replace(/[\r\n]/g, '_');
  const payload = `event: ${safeEventType}\ndata: ${JSON.stringify({ ...data, businessId, ts: Date.now() })}\n\n`;
  for (const res of adminClients) {
    try { res.write(payload); } catch { adminClients.delete(res); }
  }
}

// GET /api/events/admin — SSE for the admin panel.
router.get('/admin', requireAdmin, (req, res) => {
  try {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ admin: true, ts: Date.now() })}\n\n`);
  } catch {
    // Client aborted between requireAdmin resolving and here — the socket is
    // already gone. Must not escape: an unhandled rejection here takes the
    // process down for every tenant (see the tenant handler above).
    return;
  }

  if (adminClients.size >= 20) {
    const [oldest] = adminClients;
    try { oldest.end(); } catch {}
    adminClients.delete(oldest);
  }
  adminClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    adminClients.delete(res);
  });
});

const DATA_CHANGE_EVENTS = new Set([
  'dashboard.refresh', 'inventory.updated', 'finance.updated',
  'invoice_approved', 'waste_recorded', 'recipe.updated',
  'menu.changed', 'supplier.updated',
]);

// Rate-limit public:stats busting — max once per 30 s across all businesses.
// sync.service.js busts per-business caches (dashboard, daily-summary) synchronously
// before publishing events, so we only need to handle the shared global key here.
let _lastPublicStatsBust = 0;
const PUBLIC_STATS_BUST_COOLDOWN_MS = 30_000;

// Listen to eventBus
eventBus.on('*', (eventType, businessId, data) => {
  emit(businessId, eventType, data);
  if (ADMIN_EVENTS.has(eventType)) emitAdmin(eventType, businessId, data);
  if (DATA_CHANGE_EVENTS.has(eventType)) {
    const now = Date.now();
    if (now - _lastPublicStatsBust > PUBLIC_STATS_BUST_COOLDOWN_MS) {
      _lastPublicStatsBust = now;
      setImmediate(() => {
        const cacheUtil = require('../utils/cache');
        cacheUtil.del('public:stats').catch(() => {});
      });
    }
  }
});

function getConnectionCounts() {
  const result = {};
  for (const [bizId, set] of clients.entries()) {
    if (set.size > 0) result[bizId] = set.size;
  }
  return result;
}

module.exports = router;
module.exports.emit = emit;
module.exports.getConnectionCounts = getConnectionCounts;
