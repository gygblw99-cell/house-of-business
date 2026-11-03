import { useCallback, useEffect, useRef } from 'react';

/**
 * Returns a wrapper that only calls fn() if the component is still mounted.
 * Use it to guard async callbacks that update state, preventing
 * "Can't perform a state update on an unmounted component" errors.
 *
 * Usage:
 *   const safe = useMountedCallback();
 *   useEffect(() => {
 *     fetchData().then(data => safe(() => setData(data)));
 *   }, []);
 */
export function useMountedCallback() {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return useCallback(<T>(fn: () => T): T | undefined => {
    if (mounted.current) return fn();
  }, []);
}
