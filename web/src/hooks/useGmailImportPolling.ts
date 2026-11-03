'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ImportStatusLike {
  importStatus?: string;
  importProgress?: { imported?: number } | null;
}

// Shared "load status, then poll while an import is running" pattern used by
// both GmailConnectCard (Z-report) and DeliveryGmailConnectCard (deliveries) —
// they poll the same shape of status endpoint while importStatus === 'running'
// and stop as soon as it transitions away, firing onImported if anything landed.
export function useGmailImportPolling<T extends ImportStatusLike>(
  fetchStatus: () => Promise<T | null>,
  onImported?: () => void,
  intervalMs = 3000,
) {
  const [status, setStatus] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setStatus(data);
      return data;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetchStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (status?.importStatus === 'running') {
      pollRef.current = setInterval(async () => {
        const s = await load();
        if (s?.importStatus !== 'running') {
          if (pollRef.current) clearInterval(pollRef.current);
          if (s?.importStatus === 'done' && (s.importProgress?.imported ?? 0) > 0) {
            onImported?.();
          }
        }
      }, intervalMs);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.importStatus, load, onImported, intervalMs]);

  return { status, loading, reload: load };
}
