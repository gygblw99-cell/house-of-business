'use strict';

/**
 * Backend reactors — the event bus as an actual bus.
 *
 * Until now `eventBus` had exactly one consumer: events.routes.js, which pushes
 * everything to the browser over SSE. Nothing on the server reacted to anything.
 * That is why cross-feature work is wired as direct calls, and why finance and
 * forecast each touch 34-35 tables: a module that must update everything
 * downstream has to know about everything downstream.
 *
 * A reactor inverts that. A module publishes what happened; whoever cares
 * subscribes. Adding a consequence stops meaning editing the publisher.
 *
 * ── Rules every reactor here follows ────────────────────────────────────────
 *
 * 1. DERIVED WORK ONLY. A reactor may recompute, invalidate a cache, or raise a
 *    notification. It must never mutate stock, money, or anything a user typed.
 *    Inventory deduction stays exactly where it is, inside the transaction that
 *    owns it — a reactor that deducted stock on an event would double-count the
 *    moment an event was replayed from the outbox.
 *
 * 2. NO PUBLISHING FROM A REACTOR. Events are not re-emitted here, so a cycle
 *    cannot form. A reactor that published would be one bad pair away from an
 *    infinite loop, and the outbox would happily persist every iteration.
 *
 * 3. IDEMPOTENT AND SELF-CONTAINED. The SSE layer replays recent outbox events
 *    to reconnecting clients, and schedulers retry. Running a reactor twice for
 *    the same event must be indistinguishable from running it once.
 *
 * 4. NEVER THROW INTO THE PUBLISHER. eventBus.publish is called inside request
 *    handlers, often after the response is already sent. A reactor that threw
 *    would surface as an unhandled rejection, which this process treats as fatal.
 *    Every handler is wrapped.
 */

const eventBus = require('../../utils/eventBus');
const logger   = require('../../utils/logger');

/** Registry: event name -> [{ name, handler }] */
const reactors = new Map();

/**
 * Registers a reactor. `name` appears in logs so a slow or failing one is
 * identifiable without guessing.
 */
function on(eventName, name, handler) {
  if (!reactors.has(eventName)) reactors.set(eventName, []);
  reactors.get(eventName).push({ name, handler });
}

let started = false;
let inFlight = 0;

/** Highest number of reactors running at once — surfaced by stats() for ops. */
let peakInFlight = 0;

async function _run({ name, handler }, eventType, businessId, data) {
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  const t0 = Date.now();
  try {
    await handler({ businessId, data, eventType });
    const ms = Date.now() - t0;
    if (ms > 2000) logger.warn('[Reactor] slow', { reactor: name, eventType, ms });
  } catch (err) {
    // Rule 4: swallow. The publisher is usually a request handler that has
    // already responded; letting this escape would become an unhandled
    // rejection and index.js treats those as fatal for the whole process.
    logger.error('[Reactor] failed', { reactor: name, eventType, businessId, err: err.message });
  } finally {
    inFlight--;
  }
}

/**
 * Subscribes the registry to the bus. Call once at startup, after the reactors
 * have registered themselves.
 */
function startReactors() {
  if (started) return;
  started = true;

  eventBus.on('*', (eventType, businessId, data) => {
    const list = reactors.get(eventType);
    if (!list?.length) return;

    // setImmediate so a reactor never delays the response the publisher is in
    // the middle of sending, and never runs inside the publisher's transaction.
    setImmediate(() => { for (const r of list) _run(r, eventType, businessId, data); });
  });

  const summary = [...reactors.entries()].map(([evt, l]) => `${evt}:${l.length}`).join(', ');
  logger.info(`[Reactors] active — ${reactors.size} event(s) subscribed [${summary}]`);
}

function stats() {
  return {
    started,
    events: [...reactors.keys()],
    count: [...reactors.values()].reduce((n, l) => n + l.length, 0),
    inFlight,
    peakInFlight,
  };
}

/** Test seam — drops every registration. */
function _reset() {
  reactors.clear();
  started = false;
  inFlight = 0;
  peakInFlight = 0;
}

module.exports = { on, startReactors, stats, _reset };
