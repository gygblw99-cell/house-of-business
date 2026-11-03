'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { cn } from '@/lib/utils';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { sidebarOpen } = useAppSelector((s) => s.ui);
  const [loading, setLoading]   = useState(false);
  const [visible, setVisible]   = useState(true);
  const prevPath = useRef<string>(pathname);
  const timer    = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;

    setVisible(false);
    setLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(false);
      setVisible(true);
    }, 500);

    return () => clearTimeout(timer.current);
  }, [pathname]);

  return (
    <>
      {/* HOB background during transition — no spinner. Bounded to the content
          area (same right-offset classes `main` itself uses in AppShell) —
          it used to span the full viewport via `inset:0`, so on every single
          page navigation this light overlay visibly rose over the sidebar. */}
      {loading && (
        <div
          className={cn('fixed top-0 bottom-0 left-0 right-0', sidebarOpen ? 'lg:right-64' : 'lg:right-16')}
          style={{
            zIndex: 20,
            backgroundImage: 'url(/hob-bg.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            animation: 'hob-fade-in 150ms ease',
          }}
        >
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(253,252,248,0.18)' }} />
        </div>
      )}

      <style>{`
        @keyframes hob-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>

      <div style={{ opacity: visible ? 1 : 0, transition: 'opacity 280ms ease' }}>
        <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
      </div>
    </>
  );
}
