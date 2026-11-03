'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { restoreSession } from '@/store/slices/authSlice';
import { fetchUnreadCount } from '@/store/slices/notificationsSlice';
import { fetchMessagesUnread } from '@/store/slices/messagesSlice';
import { AppShell } from '@/components/layout/AppShell';
import { SyncProvider, useSyncContext, useSyncEvent } from '@/context/SyncContext';
import { AppDialogProvider } from '@/context/AppDialogContext';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { usePushNotifications } from '@/hooks/usePushNotifications';

// Inner component — runs inside SyncProvider so useSyncEvent/useSyncContext have context
function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const { connected } = useSyncContext();
  const { user } = useAppSelector((s) => s.auth);

  usePushNotifications(!!user);

  useSyncEvent('notification',     () => { dispatch(fetchUnreadCount()); });
  useSyncEvent('new_message',      () => { dispatch(fetchMessagesUnread()); });
  useSyncEvent('invoice_uploaded', () => { dispatch(fetchUnreadCount()); });
  useSyncEvent('sync.error',       () => { /* שגיאת סנכרון — SyncBadge כבר מציג למשתמש */ });

  // Fallback polling — fires only when SSE is disconnected so there's no duplication
  useEffect(() => {
    if (connected) return;
    const poll = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      dispatch(fetchUnreadCount());
      dispatch(fetchMessagesUnread());
    };
    const interval = setInterval(poll, 120_000);
    return () => clearInterval(interval);
  }, [connected, dispatch]);

  return <AppShell>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const dispatch = useAppDispatch();
  const { user, business } = useAppSelector((s) => s.auth);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [networkError, setNetworkError] = useState(false);

  const checkSession = () => {
    setNetworkError(false);
    dispatch(restoreSession()).then((action) => {
      setSessionChecked(true);
      if (action.type.endsWith('/rejected')) {
        // Only bounce to /login when the session is genuinely invalid/missing.
        // A transient network/server error leaves the token cookie in place,
        // so redirecting anyway just gets bounced straight back here by
        // middleware.ts (token still present → /login redirects to /dashboard),
        // producing an infinite loop between the two pages.
        if (action.payload === 'network error') {
          setNetworkError(true);
        } else {
          router.replace('/login');
        }
      }
    });
  };

  useEffect(() => {
    if (user) { setSessionChecked(true); return; }
    checkSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, router, user]);

  useEffect(() => {
    if (!user || !business) return;
    // Guide new users to onboarding only when they land on the dashboard root.
    // All other pages remain accessible so users can upload Z-reports, browse features, etc.
    if (business.onboarding_completed === false && pathname === '/dashboard') {
      router.replace('/onboarding');
    }
  }, [user, business, router, pathname]);

  useEffect(() => {
    if (!user || !business) return;
    // Unlike onboarding above, this fires from ANY path — a suspended
    // business shouldn't be able to reach the app from anywhere, not just
    // the dashboard root.
    if (business.is_suspended && pathname !== '/suspended') {
      router.replace('/suspended');
    }
  }, [user, business, router, pathname]);

  // Initial fetch — interval is managed in AppLayoutInner (inside SyncProvider)
  useEffect(() => {
    if (!user) return;
    dispatch(fetchUnreadCount());
    dispatch(fetchMessagesUnread());
  }, [user, dispatch]);

  if (!user) {
    if (networkError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0f0f14]">
          <div className="text-center max-w-sm px-6">
            <p className="text-sm text-gray-400 mb-4">לא ניתן להתחבר לשרת כרגע. בדוק את החיבור לאינטרנט ונסה שוב.</p>
            <button
              onClick={() => { setSessionChecked(false); checkSession(); }}
              className="px-5 py-2 rounded-lg text-sm font-semibold"
              style={{ background: 'var(--color-primary, #c9a227)', color: '#0f0f14' }}
            >
              נסה שוב
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0f0f14]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">{sessionChecked ? 'מפנה לכניסה...' : 'טוען...'}</p>
        </div>
      </div>
    );
  }

  if (business?.is_suspended && pathname !== '/suspended') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0f0f14]">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <AppDialogProvider>
        <SyncProvider>
          <AppLayoutInner>{children}</AppLayoutInner>
        </SyncProvider>
      </AppDialogProvider>
    </ErrorBoundary>
  );
}
