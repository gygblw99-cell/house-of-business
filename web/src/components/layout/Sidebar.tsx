'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Users, CalendarDays, Truck, FileText,
  Package, ChefHat, TrendingUp, Bot, BarChart3,
  Settings, ChevronLeft, LogOut, Monitor,
  MessageSquare, AlarmClock, Scale, TrendingDown, ClipboardList, Sparkles,
  Moon, Sun, CalendarRange, UtensilsCrossed, Bike, History,
  ListOrdered, Megaphone, LifeBuoy, Newspaper,
  FileBarChart, Download, Printer, Images, ShieldAlert, Bell } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { logout } from '@/store/slices/authSlice';
import { toggleSidebar, setMobileSidebar, toggleTheme } from '@/store/slices/uiSlice';
import { getInitials } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  adminOnly?: boolean;
  children?: NavItem[];
}

const navItems: NavItem[] = [
  { href: '/dashboard',        label: 'דשבורד',          icon: LayoutDashboard },
  { href: '/weekly-report',    label: 'דוח שבועי AI',     icon: Newspaper },
  { href: '/audit',            label: 'ביקורת',           icon: BarChart3 },
  { href: '/activity',         label: 'יומן פעילות',      icon: History },
  { href: '/ai',               label: 'יועץ AI',          icon: Bot },
  { href: '/inventory',        label: 'מלאי',             icon: Package },
  { href: '/price-comparison', label: 'השוואת מחירים',   icon: Scale },
  { href: '/tasks',            label: 'משימות',            icon: ClipboardList },
  { href: '/deliveries',       label: 'משלוחים',          icon: Bike },
  { href: '/shifts',           label: 'משמרות',           icon: CalendarDays },
  { href: '/employees',        label: 'עובדים',            icon: Users },

  { href: '/suppliers',        label: 'ספקים והזמנות',    icon: Truck },
  { href: '/invoices',         label: 'חשבוניות',         icon: FileText },
  { href: '/recipes',          label: 'מנות',             icon: ChefHat },
  { href: '/menu-engineering', label: 'הנדסת תפריט',      icon: UtensilsCrossed },
  { href: '/messages',         label: 'הודעות צוות',      icon: MessageSquare },
  { href: '/notifications',    label: 'התראות',           icon: Bell },
  { href: '/reminders',        label: 'תזכורות',          icon: AlarmClock },
  { href: '/forecast',         label: 'חיזוי ביקוש',      icon: Sparkles },
  { href: '/table-queue',      label: 'תור שולחנות',       icon: ListOrdered },
  { href: '/ai-marketing',     label: 'AI שיווק דיגיטלי', icon: Megaphone },
  { href: '/profit-leak',      label: 'דליפות רווח',      icon: TrendingDown },
  {
    href: '/finance', label: 'פיננסים', icon: TrendingUp,
    children: [
      { href: '/finance',    label: 'סקירה פיננסית',  icon: TrendingUp },
      { href: '/vat-report', label: 'צפי מע"מ',       icon: FileBarChart },
      { href: '/reports',    label: 'ייצוא לרו"ח',    icon: Download },
    ],
  },
  { href: '/zreport',        label: 'דוחות',            icon: Printer },
  { href: '/settings',         label: 'הגדרות',           icon: Settings },
  { href: '/pos',              label: 'קופה',             icon: Monitor },
  { href: '/calendar',         label: 'לוח שנה',          icon: CalendarRange },
  { href: '/gallery',          label: 'גלריה',             icon: Images },
  { href: '/fraud-alerts',      label: 'זיהוי הונאה',      icon: ShieldAlert },
  // The page behind this is the support-ticket form titled "פניות ותקלות" —
  // the Guardian AI monitoring panel is admin-only and lives at /admin/guardian.
  // Labelling it "Guardian AI" here promised owners a protection feature and
  // opened a bug-report form instead.
  { href: '/guardian',         label: 'תמיכה',            icon: LifeBuoy },
];

export const Sidebar = React.memo(function Sidebar() {
  const pathname  = usePathname();
  const dispatch  = useAppDispatch();
  const [logoErr, setLogoErr] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const { user, business }    = useAppSelector((s) => s.auth);
  const { sidebarOpen, mobileSidebarOpen, theme } = useAppSelector((s) => s.ui);
  const unreadMessages        = useAppSelector((s) => s.messages.unreadCount);

  const [isMobile, setIsMobile] = useState(true);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Auto-open group when a child route is active
  useEffect(() => {
    navItems.forEach(item => {
      if (item.children?.some(c => pathname === c.href || pathname.startsWith(c.href + '/'))) {
        setOpenGroups(prev => new Set([...prev, item.href]));
      }
    });
  }, [pathname]);

  // Auto-close the mobile drawer on navigation — desktop's collapsed/expanded
  // width preference (sidebarOpen) is untouched by this.
  useEffect(() => {
    dispatch(setMobileSidebar(false));
  }, [pathname, dispatch]);

  return (
    <>
      <aside
        dir="rtl"
        className="fixed right-0 z-40 overflow-hidden"
        style={{
          background: 'var(--sb-bg)',
          top: '3.5rem',
          height: 'calc(100dvh - 3.5rem)',
          display: 'flex',
          flexDirection: 'column',
          width: (!isMobile || mobileSidebarOpen)
            ? (sidebarOpen ? '15rem' : '4rem')
            : '0px',
          transition: 'width 300ms ease',
        }}
      >
      {/* Top accent line */}
      <div className="absolute top-0 inset-x-0 h-0.5"
        style={{ background: 'linear-gradient(90deg, transparent, var(--sb-accent), transparent)' }} />

      {/* ── Logo / Header ──────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-4"
        style={{ borderBottom: '1px solid var(--sb-divider)' }}>

        {sidebarOpen && (
          <div className="flex items-center gap-2.5 min-w-0">
            {!logoErr ? (
              <Image
                src="/logo-login.png"
                alt="HOB"
                width={44}
                height={44}
                className="rounded-lg object-contain flex-shrink-0"
                style={{ filter: 'drop-shadow(0 2px 6px color-mix(in srgb, var(--sb-accent) 40%, transparent))' }}
                onError={() => setLogoErr(true)}
              />
            ) : (
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--sb-avatar-bg)' }}>
                <span className="text-xs font-black" style={{ color: 'var(--sb-avatar-text)' }}>HB</span>
              </div>
            )}
            <div className="min-w-0">
              <p className="font-bold text-sm leading-tight truncate" style={{ color: 'var(--sb-accent)' }}>
                {business?.name || 'House of Business'}
              </p>
              <p className="text-xs leading-tight" style={{ color: 'var(--sb-text-muted)' }}>פלטפורמת ניהול</p>
            </div>
          </div>
        )}

        {!sidebarOpen && (
          <div className="mx-auto">
            {!logoErr ? (
              <Image src="/logo-login.png" alt="HOB" width={34} height={34}
                className="rounded-md object-contain"
                style={{ filter: 'drop-shadow(0 1px 4px color-mix(in srgb, var(--sb-accent) 50%, transparent))' }}
                onError={() => setLogoErr(true)} />
            ) : (
              <div className="w-7 h-7 rounded-md flex items-center justify-center"
                style={{ background: 'var(--sb-avatar-bg)' }}>
                <span className="text-xs font-black" style={{ color: 'var(--sb-avatar-text)' }}>HB</span>
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => dispatch(toggleSidebar())}
          className="p-1.5 rounded-lg transition-colors flex-shrink-0"
          style={{ color: 'var(--sb-text-muted)' }}
          onMouseEnter={e => { (e.currentTarget.style.background = 'var(--sb-accent-hover)'); (e.currentTarget.style.color = 'var(--sb-accent)'); }}
          onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--sb-text-muted)'); }}
        >
          <ChevronLeft className={cn('w-4 h-4 transition-transform', !sidebarOpen && 'rotate-180')} />
        </button>
      </div>

      {/* ── Nav ────────────────────────────────────────────────── */}
      {/* direction:ltr on the scroll container moves the scrollbar to the right edge of the sidebar */}
      <nav className="flex-1 overflow-y-auto min-h-0" style={{ overscrollBehavior: 'contain', direction: 'ltr' }}>
      <div className="py-3 px-2 space-y-0.5" dir="rtl">
        {navItems.filter(item => !item.adminOnly || user?.role === 'owner').map((item) => {
          const { href, label, icon: Icon, children } = item;

          // ── Group item ──
          if (children) {
            const isGroupOpen  = openGroups.has(href);
            const groupActive  = children.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));
            return (
              <div key={href}>
                <button
                  onClick={() => setOpenGroups(prev => {
                    const next = new Set(prev);
                    isGroupOpen ? next.delete(href) : next.add(href);
                    return next;
                  })}
                  title={!sidebarOpen ? label : undefined}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium relative transition-all"
                  style={groupActive ? {
                    background: 'var(--sb-accent-dim)',
                    color: 'var(--sb-accent)',
                    borderTop: '1px solid var(--sb-accent-border)',
                    borderBottom: '1px solid var(--sb-accent-border)',
                    borderRight: '1px solid var(--sb-accent-border)',
                    borderLeft: '1px solid transparent',
                  } : {
                    color: 'var(--sb-text)',
                    border: '1px solid transparent',
                  }}
                >
                  <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                  {sidebarOpen && (
                    <>
                      <span className="truncate flex-1 text-right">{label}</span>
                      <ChevronLeft className={cn('w-3.5 h-3.5 flex-shrink-0 transition-transform', isGroupOpen && '-rotate-90')} />
                    </>
                  )}
                </button>
                {(isGroupOpen || groupActive) && sidebarOpen && (
                  <div className="mr-3 mt-0.5 space-y-0.5">
                    {children.map(child => {
                      const childActive = pathname === child.href;
                      const CIcon = child.icon;
                      return (
                        <Link key={child.href} href={child.href}
                          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all mr-1"
                          style={childActive ? {
                            background: 'var(--sb-accent-dim)',
                            color: 'var(--sb-accent)',
                          } : { color: 'var(--sb-text)' }}
                        >
                          <CIcon className="w-[15px] h-[15px] flex-shrink-0" />
                          <span className="truncate">{child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
                {/* Collapsed: show group icon only, clicking navigates to main href */}
                {!sidebarOpen && (isGroupOpen || groupActive) && (
                  <div className="space-y-0.5 mt-0.5">
                    {children.map(child => {
                      const childActive = pathname === child.href;
                      const CIcon = child.icon;
                      return (
                        <Link key={child.href} href={child.href} title={child.label}
                          className="flex items-center justify-center py-2 rounded-xl transition-all"
                          style={childActive ? { color: 'var(--sb-accent)', background: 'var(--sb-accent-dim)' } : { color: 'var(--sb-text)' }}
                        >
                          <CIcon className="w-[15px] h-[15px]" />
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          // ── Regular item ──
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'));
          const badge  = href === '/messages' ? unreadMessages : 0;
          return (
            <Link
              key={href}
              href={href}
              title={!sidebarOpen ? label : undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium relative transition-all',
                active ? 'gold-active' : ''
              )}
              style={active ? {
                background: 'var(--sb-accent-dim)',
                color: 'var(--sb-accent)',
                borderTop: '1px solid var(--sb-accent-border)',
                borderBottom: '1px solid var(--sb-accent-border)',
                borderRight: '1px solid var(--sb-accent-border)',
                borderLeft: '1px solid transparent',
              } : {
                color: 'var(--sb-text)',
                border: '1px solid transparent',
              }}
            >
              <Icon className="w-[18px] h-[18px] flex-shrink-0" />
              {sidebarOpen && <span className="truncate">{label}</span>}
              {badge > 0 && (
                <span className={cn(
                  'text-xs rounded-full font-bold flex-shrink-0 flex items-center justify-center',
                  sidebarOpen ? 'mr-auto px-1.5 min-w-[20px] h-5' : 'absolute top-1.5 right-1.5 w-3.5 h-3.5'
                )} style={{ background: 'var(--sb-accent)', color: 'var(--sb-avatar-text)', fontSize: '10px' }}>
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      </nav>

      {/* ── User ───────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-3 py-4" style={{ borderTop: '1px solid var(--sb-divider)' }}>
        <div className={cn('flex items-center gap-3', !sidebarOpen && 'justify-center')}>
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black flex-shrink-0"
            style={{ background: 'var(--sb-avatar-bg)', color: 'var(--sb-avatar-text)' }}
          >
            {user ? getInitials(user.fullName) : '?'}
          </div>
          {sidebarOpen ? (
            <>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate text-white">{user?.fullName}</p>
                <p className="text-xs truncate" style={{ color: 'var(--sb-text-muted)' }}>{user?.email}</p>
              </div>
              <button
                onClick={() => dispatch(toggleTheme())}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--sb-text-muted)' }}
                title={theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
                onMouseEnter={e => { (e.currentTarget.style.background = 'var(--sb-accent-hover)'); (e.currentTarget.style.color = 'var(--sb-accent)'); }}
                onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--sb-text-muted)'); }}
              >
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                onClick={() => dispatch(logout())}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--sb-text-muted)' }}
                title="יציאה"
                onMouseEnter={e => { (e.currentTarget.style.background = 'rgba(239,68,68,0.15)'); (e.currentTarget.style.color = '#f87171'); }}
                onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--sb-text-muted)'); }}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1 mt-1">
              <button
                onClick={() => dispatch(toggleTheme())}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--sb-text-muted)' }}
                title={theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
                onMouseEnter={e => { (e.currentTarget.style.background = 'var(--sb-accent-hover)'); (e.currentTarget.style.color = 'var(--sb-accent)'); }}
                onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--sb-text-muted)'); }}
              >
                {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => dispatch(logout())}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--sb-text-muted)' }}
                title="יציאה"
                onMouseEnter={e => { (e.currentTarget.style.background = 'rgba(239,68,68,0.15)'); (e.currentTarget.style.color = '#f87171'); }}
                onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'var(--sb-text-muted)'); }}
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 inset-x-0 h-0.5"
        style={{ background: 'linear-gradient(90deg, transparent, var(--sb-accent), transparent)' }} />
      </aside>
    </>
  );
});
