'use client';

import { useEffect, useRef } from 'react';
import { ADMIN_API_BASE } from '@/lib/adminClient';

type Handler = (data: Record<string, unknown>) => void;

/**
 * Live updates for the admin panel.
 *
 * The tenant SSE stream is keyed by businessId and gated by tenant auth, so an
 * admin could not subscribe to it at all — which is why every admin page polled
 * on a 60-second timer even though the backend was already publishing
 * ticket.updated. GET /api/events/admin is the admin-side stream; it carries
 * only operator-relevant events across all businesses.
 *
 * One EventSource is shared by every caller in the page, because a browser
 * allows only ~6 connections per origin and each admin screen subscribes to
 * more than one event.
 */

let source: EventSource | null = null;
let refCount = 0;
const listeners = new Map<string, Set<Handler>>();

function ensureSource() {
  if (source || typeof window === 'undefined') return;
  source = new EventSource(`${ADMIN_API_BASE}/events/admin`, { withCredentials: true });

  // The browser reconnects an EventSource on its own after a transient drop, so
  // there is nothing to do on error beyond not tearing the shared source down —
  // doing that would silently stop every subscriber on the page.
  source.onerror = () => {};
}

function attach(event: string) {
  if (!source) return;
  source.addEventListener(event, (e: MessageEvent) => {
    let data: Record<string, unknown> = {};
    try { data = e.data ? JSON.parse(e.data) : {}; } catch { /* keep {} */ }
    for (const fn of listeners.get(event) ?? []) fn(data);
  });
}

export function useAdminSyncEvent(events: string | string[], fn: Handler) {
  // Held in a ref so a caller passing an inline arrow doesn't resubscribe on
  // every render. Updated in an effect, not during render.
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  const key = Array.isArray(events) ? events.join('\0') : events;

  useEffect(() => {
    const names = key.split('\0').filter(Boolean);
    if (!names.length) return;

    ensureSource();
    refCount++;

    const wrapped: Handler = (data) => fnRef.current(data);
    for (const name of names) {
      if (!listeners.has(name)) {
        listeners.set(name, new Set());
        attach(name); // first subscriber for this event wires the DOM listener
      }
      listeners.get(name)!.add(wrapped);
    }

    return () => {
      for (const name of names) {
        const set = listeners.get(name);
        set?.delete(wrapped);
      }
      refCount--;
      // Close only when the last subscriber on the page goes away, so navigating
      // between admin screens doesn't churn the connection.
      if (refCount <= 0) {
        source?.close();
        source = null;
        listeners.clear();
        refCount = 0;
      }
    };
  }, [key]);
}
