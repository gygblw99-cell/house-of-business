'use client';

import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { setMobileSidebar, toggleSidebar } from '@/store/slices/uiSlice';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ToastProvider } from '@/components/ui/Toast';
import { ThemeTransition } from '@/components/ui/ThemeTransition';
import { FloatingAI } from '@/components/ui/FloatingAI';
import { PageTransition } from './PageTransition';
import { NavigationProgress } from './NavigationProgress';
import { FeatureBackground } from './FeatureBackground';
import { MobileBottomNav } from './MobileBottomNav';
import { KeyboardShortcutsModal } from '@/components/ui/KeyboardShortcutsModal';
import { useGlobalShortcuts, ShortcutDef } from '@/hooks/useGlobalShortcuts';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api/client';

function useBackendHealth() {
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let failStreak = 0;
    // check() reschedules itself only *after* awaiting the request. Cleanup can
    // therefore run while a check is in flight, at which point clearTimeout
    // cancels a timer that has already fired — the continuation then arms a
    // fresh one, and the loop (plus its setDegraded calls) outlives the
    // component forever. This flag stops the continuation instead.
    let cancelled = false;

    async function check() {
      try {
        await api.get('/guardian/ping', { timeout: 4000 });
        if (cancelled) return;
        setDegraded(false);
        failStreak = 0;
        timer = setTimeout(check, 60_000); // healthy — check every 60s
      } catch {
        if (cancelled) return;
        setDegraded(true);
        failStreak++;
        // exponential backoff: 30s → 60s → 120s → cap at 120s
        const delay = Math.min(30_000 * Math.pow(2, failStreak - 1), 120_000);
        timer = setTimeout(check, delay);
      }
    }

    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return degraded;
}

export const AppShell = memo(function AppShell({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const router   = useRouter();
  const { sidebarOpen, mobileSidebarOpen, theme } = useAppSelector((s) => s.ui);
  const dark = theme === 'dark';
  const degraded = useBackendHealth();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sidebarMargin, setSidebarMargin] = useState('15rem');

  useEffect(() => {
    function update() {
      const wide = window.innerWidth >= 768;
      setSidebarMargin(wide || mobileSidebarOpen ? (sidebarOpen ? '15rem' : '4rem') : '0px');
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [sidebarOpen, mobileSidebarOpen]);

  // ── Custom proxy scrollbar — React-controlled thumb with fixed pixel height ──
  const mainScrollRef    = useRef<HTMLElement>(null);
  const proxyRef         = useRef<HTMLDivElement>(null);
  const thumbRef         = useRef<HTMLDivElement>(null);
  const isDragging       = useRef(false);
  const dragStartY       = useRef(0);
  const dragStartScroll  = useRef(0);

  const THUMB_PX = 50;

  const syncThumb = useCallback(() => {
    const main  = mainScrollRef.current;
    const thumb = thumbRef.current;
    const proxy = proxyRef.current;
    if (!main || !thumb || !proxy) return;
    const maxScroll   = main.scrollHeight - main.clientHeight;
    const trackHeight = proxy.clientHeight - THUMB_PX;
    thumb.style.top   = maxScroll <= 0 ? '0px' : `${(main.scrollTop / maxScroll) * trackHeight}px`;
  }, []);

  // syncThumb is already a stable useCallback — wrapping it again added a
  // memo layer over a value that never changes.
  const onMainScroll = syncThumb;

  const onProxyWheel = useCallback((e: React.WheelEvent) => {
    const main = mainScrollRef.current;
    if (main) main.scrollTop += e.deltaY;
  }, []);

  const onTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const proxy = proxyRef.current;
    const main  = mainScrollRef.current;
    if (!proxy || !main) return;
    const rect       = proxy.getBoundingClientRect();
    const clickRatio = Math.max(0, Math.min(1, (e.clientY - rect.top - THUMB_PX / 2) / (proxy.clientHeight - THUMB_PX)));
    main.scrollTop   = clickRatio * (main.scrollHeight - main.clientHeight);
  }, []);

  const onThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging.current      = true;
    dragStartY.current      = e.clientY;
    dragStartScroll.current = mainScrollRef.current?.scrollTop ?? 0;
    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current || !mainScrollRef.current || !proxyRef.current) return;
      const delta     = ev.clientY - dragStartY.current;
      const maxScroll = mainScrollRef.current.scrollHeight - mainScrollRef.current.clientHeight;
      mainScrollRef.current.scrollTop = Math.max(0, Math.min(
        maxScroll,
        dragStartScroll.current + (delta / (proxyRef.current.clientHeight - THUMB_PX)) * maxScroll
      ));
    };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }, []);

  // syncThumb is stable, so mounting alone would sync the thumb exactly once
  // and then let it drift — the track position stayed frozen as pages changed
  // height, content loaded in, or the window resized. Observe the scroll
  // container instead, so every layout change re-runs it.
  useEffect(() => {
    syncThumb();
    const main = mainScrollRef.current;
    if (!main) return;
    const ro = new ResizeObserver(syncThumb);
    ro.observe(main);
    // The <main> box itself rarely resizes — its *content* does — so watch the
    // inner wrapper too.
    if (main.firstElementChild) ro.observe(main.firstElementChild);
    window.addEventListener('resize', syncThumb);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncThumb);
    };
  }, [syncThumb]);

  const shortcuts = useMemo<ShortcutDef[]>(() => {
    const nav = (path: string) => () => router.push(path);
    return [
      // ── ניווט (G → אות) ────────────────────────────────────
      { gSeq: 'KeyD', action: nav('/dashboard'),        label: 'דשבורד',             display: 'G → D', group: 'ניווט' },
      { gSeq: 'KeyA', action: nav('/ai'),               label: 'יועץ AI',             display: 'G → A', group: 'ניווט' },
      { gSeq: 'KeyI', action: nav('/inventory'),        label: 'מלאי',               display: 'G → I', group: 'ניווט' },
      { gSeq: 'KeyS', action: nav('/suppliers'),        label: 'ספקים',              display: 'G → S', group: 'ניווט' },
      { gSeq: 'KeyE', action: nav('/employees'),        label: 'עובדים',             display: 'G → E', group: 'ניווט' },
      { gSeq: 'KeyF', action: nav('/finance'),          label: 'פיננסים',            display: 'G → F', group: 'ניווט' },
      { gSeq: 'KeyT', action: nav('/tasks'),            label: 'משימות',             display: 'G → T', group: 'ניווט' },
      { gSeq: 'KeyR', action: nav('/recipes'),          label: 'מנות',               display: 'G → R', group: 'ניווט' },
      { gSeq: 'KeyP', action: nav('/pos'),              label: 'קופה',               display: 'G → P', group: 'ניווט' },
      { gSeq: 'KeyM', action: nav('/messages'),         label: 'הודעות צוות',        display: 'G → M', group: 'ניווט' },
      { gSeq: 'KeyW', action: nav('/weekly-report'),    label: 'דוח שבועי AI',       display: 'G → W', group: 'ניווט' },
      { gSeq: 'KeyC', action: nav('/calendar'),         label: 'לוח שנה',            display: 'G → C', group: 'ניווט' },
      { gSeq: 'KeyN', action: nav('/notifications'),    label: 'התראות',             display: 'G → N', group: 'ניווט' },
      { gSeq: 'KeyB', action: nav('/audit'),            label: 'ביקורת',             display: 'G → B', group: 'ניווט' },
      { gSeq: 'KeyH', action: nav('/shifts'),           label: 'משמרות',             display: 'G → H', group: 'ניווט' },
      { gSeq: 'KeyV', action: nav('/invoices'),         label: 'חשבוניות',           display: 'G → V', group: 'ניווט' },
      { gSeq: 'KeyL', action: nav('/forecast'),         label: 'חיזוי ביקוש',        display: 'G → L', group: 'ניווט' },
      // ── ממשק ────────────────────────────────────────────────
      { code: 'BracketLeft',  action: () => dispatch(toggleSidebar()), label: 'פתיחה/סגירה Sidebar', display: '[',       group: 'ממשק' },
      { code: 'Slash', shift: true, action: () => setShowShortcuts(v => !v), label: 'קיצורי מקלדת',       display: '?',       group: 'ממשק' },
      { key:  'Escape',             action: () => setShowShortcuts(false),   label: 'סגור פאנל',           display: 'Esc',     group: 'ממשק' },
    ];
  }, [router, dispatch]);

  useGlobalShortcuts(shortcuts);

  return (
    <ToastProvider>
      <KeyboardShortcutsModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        shortcuts={shortcuts}
        appName="פלטפורמה"
      />
      <div
        className="h-screen relative"
        dir="rtl"
        style={{
          background: dark ? '#0f1117' : 'var(--page-gradient, #f9fafb)',
          transition: 'background 0.5s ease',
        }}
      >
        {/* ── HOB background illustration (transition-only — opacity 0 here) ── */}
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            backgroundImage: 'url(/hob-bg.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: 0,
            zIndex: 0,
            transition: 'opacity 0.5s ease',
          }}
        />

        {/* ── Thin top progress bar on navigation ─────────────────── */}
        <NavigationProgress />

        {/* ── Dynamic per-feature background ───────────────────────── */}
        <FeatureBackground />

        {/* ── Decorative background blobs ─────────────────────── */}
        {!dark && (
          <>
            <div
              className="fixed pointer-events-none"
              style={{
                top: '-10%', right: '15%',
                width: '500px', height: '500px',
                borderRadius: '50%',
                background: 'var(--blob-1, rgba(26,92,42,0.08))',
                filter: 'blur(80px)',
                zIndex: 0,
                transition: 'background 0.5s ease',
              }}
            />
            <div
              className="fixed pointer-events-none"
              style={{
                bottom: '10%', left: '5%',
                width: '600px', height: '600px',
                borderRadius: '50%',
                background: 'var(--blob-2, rgba(201,162,39,0.06))',
                filter: 'blur(100px)',
                zIndex: 0,
                transition: 'background 0.5s ease',
              }}
            />
            <div
              className="fixed pointer-events-none"
              style={{
                top: '40%', left: '35%',
                width: '350px', height: '350px',
                borderRadius: '50%',
                background: 'var(--blob-3, rgba(46,125,50,0.04))',
                filter: 'blur(70px)',
                zIndex: 0,
                transition: 'background 0.5s ease',
              }}
            />
          </>
        )}

        {degraded && (
          <div
            className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 py-1.5 text-xs font-semibold"
            style={{ background: '#ef4444', color: '#fff' }}
            dir="rtl"
          >
            <span>⚠️</span>
            <span>השרת אינו מגיב — חלק מהתכונות עשויות לא לעבוד. בודק חיבור מחדש...</span>
          </div>
        )}

        <Sidebar />

        {mobileSidebarOpen && (
          <div
            className="fixed top-14 inset-x-0 bottom-0 bg-black/40 z-30 md:hidden"
            onClick={() => dispatch(setMobileSidebar(false))}
          />
        )}

        <Header />

        <main
          ref={mainScrollRef}
          onScroll={onMainScroll}
          className="min-w-0 pt-14 relative"
          style={{
            zIndex: 1,
            height: '100dvh',
            overflowY: 'auto',
            overflowX: 'hidden',
            marginRight: sidebarMargin,
            transition: 'margin-right 300ms ease',
          }}
        >
          <div dir="rtl" className="p-3 lg:p-6 pb-20 lg:pb-6">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>

        {/* ── Proxy page scrollbar — custom thumb, fixed 50px height ── */}
        {/* A flush right offset (matching the sidebar's width exactly) turned out to
            still overlap the sidebar in practice, and lowering this element's z-index
            below the sidebar's then let the sidebar block clicks on the scrollbar
            entirely. Kept above the sidebar (see z-index in globals.css) so it stays
            usable, with a real 16px buffer past the sidebar's edge as breathing room. */}
        <div
          ref={proxyRef}
          onClick={onTrackClick}
          onWheel={onProxyWheel}
          className="page-scroll-proxy"
          style={{
            right: sidebarOpen ? 240 : 64,
            width: 10,
            borderRadius: 99,
            background: 'rgba(0,0,0,0.06)',
            cursor: 'pointer',
            overflow: 'hidden',
          }}
        >
          <div
            ref={thumbRef}
            onMouseDown={onThumbMouseDown}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(201,162,39,0.85)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(201,162,39,0.55)'; }}
            style={{
              position: 'absolute',
              top: 0,
              left: 1,
              right: 1,
              height: THUMB_PX,
              borderRadius: 99,
              background: 'rgba(201,162,39,0.55)',
              cursor: 'grab',
              userSelect: 'none',
            }}
          />
        </div>

        <MobileBottomNav />

        {/* ── AI advisor + page-help buttons — hidden on small phones, visible on tablets and up ── */}
        <div className="hidden md:block">
          <FloatingAI />
        </div>

        <ThemeTransition />
      </div>
    </ToastProvider>
  );
});
