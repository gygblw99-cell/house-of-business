'use client';
import { adminFetch } from '@/lib/adminClient';
import { useAdminSyncEvent } from '@/hooks/useAdminSyncEvent';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { LayoutDashboard, Building2, Users, Brain, LogOut, PlusCircle, Keyboard, Activity, ShieldCheck, Ticket, FileBarChart2, CreditCard } from 'lucide-react';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { KeyboardShortcutsModal } from '@/components/ui/KeyboardShortcutsModal';

const NAV = [
  { href: '/admin/dashboard',       icon: LayoutDashboard, label: 'Dashboard',    badge: false },
  { href: '/admin/businesses',      icon: Building2,       label: 'עסקים',         badge: false },
  { href: '/admin/users',           icon: Users,           label: 'משתמשים',       badge: false },
  { href: '/admin/ai-usage',        icon: Brain,           label: 'שימוש AI',      badge: false },
  { href: '/admin/sync',            icon: Activity,        label: 'סנכרון',        badge: false },
  { href: '/admin/guardian',        icon: ShieldCheck,     label: 'Guardian AI',   badge: false },
  { href: '/admin/tickets',         icon: Ticket,          label: 'תקלות',          badge: true  },
  { href: '/admin/zreports',        icon: FileBarChart2,   label: 'דוחות',          badge: false },
  { href: '/admin/payments',        icon: CreditCard,      label: 'תשלומים',       badge: false },
  { href: '/admin/create-business', icon: PlusCircle,      label: 'פתיחת עסק',    badge: false },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [openTickets, setOpenTickets] = useState(0);
  const fetchCountRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const fetchCount = () => {
      adminFetch(`/admin/support-tickets/count`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setOpenTickets(d.count || 0); })
        .catch(() => {});
    };
    fetchCountRef.current = fetchCount;
    fetchCount();
    // Slow safety net only. The live path is the ticket.updated subscription
    // below; this covers a dropped SSE connection without polling the API every
    // single minute the way this used to.
    const interval = setInterval(fetchCount, 10 * 60_000);
    return () => clearInterval(interval);
  }, []);

  // The backend has always published ticket.updated — until the admin stream
  // existed there was simply no way to receive it here.
  useAdminSyncEvent('ticket.updated', () => fetchCountRef.current?.());

  const logout = async () => {
    try { await adminFetch(`/admin/auth/logout`, { method: 'POST' }); } catch {}
    router.replace('/admin/login');
  };

  // The keyboard path asks first. A bare, unconfirmed `L` used to end the
  // session outright — one stray keypress with focus anywhere outside a text
  // field and the admin was thrown back to the login screen.
  const logoutFromShortcut = () => {
    if (window.confirm('להתנתק מפאנל הניהול?')) logout();
  };

  const shortcuts = useMemo(() => [
    { code: 'Digit1', action: () => router.push('/admin/dashboard'),        label: 'Dashboard',      display: '1', group: 'ניווט' },
    { code: 'Digit2', action: () => router.push('/admin/businesses'),       label: 'עסקים',          display: '2', group: 'ניווט' },
    { code: 'Digit3', action: () => router.push('/admin/users'),            label: 'משתמשים',        display: '3', group: 'ניווט' },
    { code: 'Digit4', action: () => router.push('/admin/ai-usage'),         label: 'שימוש AI',       display: '4', group: 'ניווט' },
    { code: 'Digit5', action: () => router.push('/admin/sync'),             label: 'סנכרון',         display: '5', group: 'ניווט' },
    { code: 'Digit6', action: () => router.push('/admin/guardian'),         label: 'Guardian AI',    display: '6', group: 'ניווט' },
    { code: 'Digit7', action: () => router.push('/admin/tickets'),          label: 'תקלות',           display: '7', group: 'ניווט' },
    { code: 'Digit8', action: () => router.push('/admin/create-business'),  label: 'פתיחת עסק',     display: '8', group: 'ניווט' },
    { code: 'Slash', shift: true, action: () => setShowShortcuts(v => !v), label: 'קיצורי מקלדת',  display: '?', group: 'ממשק' },
    { code: 'KeyL', shift: true,  action: logoutFromShortcut,               label: 'התנתק',          display: 'Shift + L', group: 'ממשק' },
    { key:  'Escape',             action: () => setShowShortcuts(false),    label: 'סגור פאנל',      display: 'Esc', group: 'ממשק' },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logoutFromShortcut is stable in practice (only closes over `router`)
  ], [router]);

  useGlobalShortcuts(shortcuts);

  useEffect(() => {
    if (pathname === '/admin/login') { setReady(true); return; }
    adminFetch(`/admin/auth/me`)
      .then(r => { if (r.status === 401 || r.status === 403) router.replace('/admin/login'); else setReady(true); })
      .catch(() => router.replace('/admin/login'));
  }, [pathname, router]);

  if (pathname === '/admin/login') return <>{children}</>;
  if (!ready)
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#050507' }}>
        <div
          className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: 'rgba(201,162,39,0.6)', borderTopColor: 'transparent' }}
        />
      </div>
    );

  return (
    <>
    <KeyboardShortcutsModal
      open={showShortcuts}
      onClose={() => setShowShortcuts(false)}
      shortcuts={shortcuts}
      appName="Admin Panel"
    />
    <div className="min-h-screen flex" dir="rtl" style={{ background: '#0a0a0e' }}>
      {/* Sidebar */}
      <aside
        className="w-56 flex-shrink-0 flex flex-col"
        style={{
          background: '#050507',
          borderLeft: '1px solid rgba(201,162,39,0.12)',
        }}
      >
        {/* Brand */}
        <div className="p-5" style={{ borderBottom: '1px solid rgba(201,162,39,0.1)' }}>
          <div className="flex items-center gap-2.5">
            <img
              src="/logo-login.png"
              alt="HOB"
              className="flex-shrink-0 object-contain"
              style={{
                width: '36px',
                height: '36px',
                filter: 'drop-shadow(0 0 6px rgba(201,162,39,0.35))',
              }}
            />
            <div>
              <p className="font-black text-sm" style={{ color: 'rgba(232,232,228,0.9)' }}>
                Admin Panel
              </p>
              <p className="text-xs" style={{ color: 'rgba(201,162,39,0.5)' }}>
                HOB System
              </p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map(({ href, icon: Icon, label, badge }) => {
            const active = pathname.startsWith(href);
            const badgeNum = badge ? openTickets : 0;
            return (
              <a
                key={href}
                href={href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
                style={
                  active
                    ? {
                        background: 'rgba(201,162,39,0.1)',
                        color: '#c9a227',
                        border: '1px solid rgba(201,162,39,0.2)',
                      }
                    : {
                        color: 'rgba(232,232,228,0.4)',
                        border: '1px solid transparent',
                      }
                }
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.color = 'rgba(232,232,228,0.75)';
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.color = 'rgba(232,232,228,0.4)';
                }}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badgeNum > 0 && (
                  <span
                    className="text-xs font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: '#ef4444', color: 'white', minWidth: '1.25rem', textAlign: 'center' }}
                  >
                    {badgeNum > 99 ? '99+' : badgeNum}
                  </span>
                )}
              </a>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="p-3" style={{ borderTop: '1px solid rgba(201,162,39,0.1)' }}>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm w-full transition-all"
            style={{ color: 'rgba(232,232,228,0.35)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#ef4444')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'rgba(232,232,228,0.35)')}
          >
            <LogOut className="w-4 h-4" />
            התנתק
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto p-6" style={{ background: '#0a0a0e' }}>
        {children}
      </main>
    </div>

    {/* Keyboard shortcut hint */}
    <button
      onClick={() => setShowShortcuts(true)}
      className="fixed bottom-4 left-4 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all"
      style={{
        background: 'rgba(201,162,39,0.08)',
        border: '1px solid rgba(201,162,39,0.18)',
        color: 'rgba(201,162,39,0.55)',
      }}
      title="קיצורי מקלדת"
    >
      <Keyboard className="w-3.5 h-3.5" />
      <kbd className="font-mono font-bold">?</kbd>
    </button>
    </>
  );
}
