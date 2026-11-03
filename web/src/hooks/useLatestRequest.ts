import { useCallback, useEffect, useRef } from 'react';

/**
 * Guards against out-of-order responses ("last request wins").
 *
 * When a fetch is retriggered by changing state — a month picker, a filter, a
 * search box — two requests can be in flight at once, and the network does not
 * promise they come back in order. Whichever resolves last calls setState last,
 * so a slow response for the *previous* filter can overwrite the current one.
 * Nothing about the resulting screen looks wrong: labels are rendered from
 * local state, so the stale numbers appear under the current heading.
 *
 * Call the returned function once at the start of each request to take a
 * ticket. The ticket wraps state updates and drops them if a newer request has
 * started since — which also covers unmount, so this subsumes
 * useMountedCallback for fetch flows.
 *
 * Usage:
 *   const beginRequest = useLatestRequest();
 *
 *   const load = () => {
 *     const latest = beginRequest();
 *     setLoading(true);
 *     vatApi.report({ year, month })
 *       .then(r  => latest(() => setData(r.data)))
 *       .catch(e => latest(() => { setData(null); toast(getErrorMessage(e)); }))
 *       .finally(() => latest(() => setLoading(false)));
 *   };
 */
export function useLatestRequest() {
  const seq = useRef(0);

  // Bumping the counter on unmount invalidates every outstanding ticket, so no
  // in-flight response can call setState on a torn-down component.
  useEffect(() => () => { seq.current += 1; }, []);

  return useCallback(() => {
    const ticket = ++seq.current;
    return <T,>(fn: () => T): T | undefined => {
      if (ticket === seq.current) return fn();
    };
  }, []);
}
