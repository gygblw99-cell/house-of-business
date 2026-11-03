/**
 * EventBus — internal event emitter for SSE
 * Usage: eventBus.publish(businessId, 'shift_opened', { employeeName, shiftId })
 *
 * Outbox pattern: every published event is persisted to sync_events_outbox BEFORE
 * being pushed to SSE clients. This guarantees:
 *  1. Events survive process crashes (SSE push is best-effort, DB write is durable).
 *  2. Reconnecting clients can replay recent events they missed.
 */
const EventEmitter = require('events');

let _db = null; // lazy-loaded to avoid circular dependency at startup

function getDb() {
  if (!_db) _db = require('./db');
  return _db;
}

class EventBus extends EventEmitter {
  publish(businessId, eventType, data = {}) {
    // Persist to outbox first (fire-and-forget, non-blocking)
    getDb().query(
      'INSERT INTO sync_events_outbox (business_id, event_type, payload) VALUES ($1, $2, $3)',
      [businessId, eventType, JSON.stringify(data)]
    ).catch(() => {}); // DB failure must not interrupt SSE delivery

    this.emit('*', eventType, businessId, data);
    this.emit(eventType, businessId, data);
  }
}

const eventBus = new EventBus();
eventBus.setMaxListeners(0); // 0 = unlimited — SSE connections each add a listener

// Prune outbox rows older than 5 minutes every 2 minutes
// Keeps the table small; replay window is 60 seconds so 5 min gives safety margin
setInterval(() => {
  try {
    getDb().query(
      "DELETE FROM sync_events_outbox WHERE created_at < NOW() - INTERVAL '5 minutes'"
    ).catch(() => {});
  } catch {
    // getDb() can throw synchronously if the db module fails to load;
    // swallow so the interval keeps running rather than producing an unhandled rejection.
  }
}, 2 * 60_000).unref();

module.exports = eventBus;
