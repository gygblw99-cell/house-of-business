'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NProgress = require('nprogress') as typeof import('nprogress');

// ── NProgress config ─────────────────────────────────────────
NProgress.configure({
  minimum:   0.15,
  speed:     400,
  trickle:   true,
  trickleSpeed: 120,
  showSpinner: false,
});

// ── Inline styles (no CSS file needed) ───────────────────────
const STYLE = `
  #nprogress {
    pointer-events: none;
  }
  #nprogress .bar {
    background: linear-gradient(90deg, #2563eb, #7c3aed, #06b6d4);
    position: fixed;
    z-index: 9999;
    top: 0;
    left: 0;
    width: 100%;
    height: 3px;
    border-radius: 0 2px 2px 0;
    box-shadow: 0 0 12px rgba(124, 58, 237, 0.6), 0 0 4px rgba(37, 99, 235, 0.4);
  }
  #nprogress .bar::after {
    content: '';
    display: block;
    position: absolute;
    right: 0;
    top: -3px;
    width: 100px;
    height: 9px;
    background: radial-gradient(ellipse at right, rgba(124,58,237,0.5) 0%, transparent 70%);
    border-radius: 50%;
  }
`;

export function NavigationProgress() {
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const prevPath     = useRef<string>('');

  // Inject styles once
  useEffect(() => {
    if (document.getElementById('nprogress-style')) return;
    const tag = document.createElement('style');
    tag.id = 'nprogress-style';
    tag.innerHTML = STYLE;
    document.head.appendChild(tag);
  }, []);

  // Trigger on route change
  useEffect(() => {
    const current = pathname + searchParams.toString();
    if (prevPath.current && prevPath.current !== current) {
      NProgress.start();
      // Short delay so the bar is visible even on fast navigations
      const t = setTimeout(() => NProgress.done(), 400);
      return () => clearTimeout(t);
    }
    prevPath.current = current;
  }, [pathname, searchParams]);

  return null;
}
