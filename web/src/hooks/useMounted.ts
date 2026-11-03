import { useRef, useEffect } from 'react';

/** Returns a stable getter that returns true while the component is mounted. */
export function useMounted(): () => boolean {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = true;
    return () => { ref.current = false; };
  }, []);
  return () => ref.current;
}
