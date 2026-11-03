'use client';
import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import Cookies from 'js-cookie';

type Handler = (data: unknown) => void;

interface SyncCtx {
  connected: boolean;
  lastSync: Date | null;
  subscribe: (event: string, fn: Handler) => () => void;
}

const SyncContext = createContext<SyncCtx>({
  connected: false,
  lastSync: null,
  subscribe: () => () => {},
});

// Global registry - single EventSource for the whole app
const registry = new Map<string, Set<Handler>>();

function dispatchSync(eventName: string, data: unknown) {
  registry.get(eventName)?.forEach(fn => { try { fn(data); } catch {} });
  registry.get('*')?.forEach(fn => { try { fn({ eventName, data }); } catch {} });
}

const SYNC_EVENTS = [
  'dashboard.refresh',
  'inventory.updated',
  'finance.updated',
  'low_inventory',
  'new_message',
  'notification',
  'shift_opened',
  'shift_closed',
  'invoice_approved',
  'invoice_uploaded',
  'order_sent',
  'queue.updated',
  'sync.error',
  'waste_recorded',
  'message_read',
  'task.updated',
  'delivery.imported',
  'review.updated',
  'invoice.updated',
  'recipe.updated',
  'menu.changed',
  'supplier.updated',
  'weekly_report.updated',
  'audit.updated',
  'ai_chat.updated',
  'price_comparison.updated',
  'employee.updated',
  'forecast.updated',
  'ticket.updated',
  'pos.updated',
  'customer.updated',
];

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryCount = useRef(0);
  const lastConnectedAt = useRef<number>(0);
  // Prevents two concurrent connect() calls from both fetching an SSE token.
  // Without this, online + visibilitychange firing simultaneously would consume two tokens.
  const connectingRef = useRef(false);
  // Flipped by the effect's cleanup. connect() awaits a network round-trip
  // before it opens the EventSource, so without this an unmount mid-await would
  // let the continuation build a connection nobody holds a reference to — a
  // leaked stream that keeps receiving events and retrying forever.
  const unmountedRef = useRef(false);

  const connect = useCallback(async () => {
    if (unmountedRef.current) return;
    const jwtToken = Cookies.get('token');
    if (!jwtToken || esRef.current || connectingRef.current) return;
    connectingRef.current = true;

    const API = process.env.NEXT_PUBLIC_API_URL || '/api-proxy';

    // Exchange the long-lived JWT for a short-lived (60s) SSE token so the JWT
    // never appears in server access logs or browser history via the URL.
    let sseToken: string;
    try {
      const r = await fetch(`${API}/auth/sse-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
      if (!r.ok) throw new Error(`sse-token ${r.status}`);
      const { token } = await r.json() as { token: string };
      sseToken = token;
    } catch {
      connectingRef.current = false;
      if (unmountedRef.current) return;
      // Cannot get SSE token — schedule a retry instead of falling back to the
      // long-lived JWT (backend rejects plain JWTs in the query string).
      retryCount.current += 1;
      const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30_000);
      reconnectTimer.current = setTimeout(connect, delay);
      return;
    }

    connectingRef.current = false;
    // Guards: the provider may have unmounted, or connect() may have been
    // called again, while we were awaiting the token above.
    if (unmountedRef.current || esRef.current) return;

    // Send `since=<ms>` on reconnect so the server can replay missed events from the outbox
    const sinceParam = lastConnectedAt.current > 0 ? `&since=${lastConnectedAt.current}` : '';
    const es = new EventSource(`${API}/events?token=${sseToken}${sinceParam}`);
    esRef.current = es;

    es.addEventListener('connected', () => {
      setConnected(true);
      retryCount.current = 0; // reset backoff on successful connection
      lastConnectedAt.current = Date.now();
    });

    // Listen for all sync events
    SYNC_EVENTS.forEach(evt => {
      es.addEventListener(evt, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          setLastSync(new Date());
          dispatchSync(evt, data);
        } catch {}
      });
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      if (unmountedRef.current) return;
      // Exponential backoff: 2s → 4s → 8s → 16s → 30s (cap)
      retryCount.current += 1;
      const delay = Math.min(1000 * Math.pow(2, retryCount.current), 30_000);
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    // Re-arm after a remount (React 18 StrictMode mounts, unmounts, remounts).
    unmountedRef.current = false;
    connect();

    const reconnectNow = () => {
      if (!esRef.current && !connectingRef.current) {
        retryCount.current = 0;
        clearTimeout(reconnectTimer.current);
        connect();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };

    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unmountedRef.current = true;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(reconnectTimer.current);
      esRef.current?.close();
      esRef.current = null;
      connectingRef.current = false;
    };
  }, [connect]);

  const subscribe = useCallback((event: string, fn: Handler) => {
    if (!registry.has(event)) registry.set(event, new Set());
    registry.get(event)!.add(fn);
    return () => {
      const set = registry.get(event);
      if (set) {
        set.delete(fn);
        if (set.size === 0) registry.delete(event);
      }
    };
  }, []);

  return (
    <SyncContext.Provider value={{ connected, lastSync, subscribe }}>
      {children}
    </SyncContext.Provider>
  );
}

export const useSyncContext = () => useContext(SyncContext);

// Convenience hook: auto-call `fn` when any of `events` fires
export function useSyncEvent(events: string | string[], fn: Handler) {
  const { subscribe } = useSyncContext();
  // Written in an effect, not during render: the subscription below captures
  // fnRef once, so the ref must only be updated for renders React commits.
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  // Stable string key — avoids dynamic-length deps array and re-subscribes only
  // when the actual event names change, not on every render
  const eventsKey = Array.isArray(events) ? events.join('\0') : events;

  useEffect(() => {
    const evts = eventsKey.split('\0');
    const unsubs = evts.map(e => subscribe(e, (d) => fnRef.current(d)));
    return () => unsubs.forEach(u => u());
  }, [subscribe, eventsKey]);
}
