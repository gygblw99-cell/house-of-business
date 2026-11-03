'use client';

import { Bell, Search, Menu, CheckCheck, X, AlertTriangle, AlertCircle, Info, ChevronRight, HelpCircle, Send, Zap } from 'lucide-react';
import { memo, useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { toggleSidebar } from '@/store/slices/uiSlice';
import { fetchNotifications, markRead, markAllRead, deleteNotification } from '@/store/slices/notificationsSlice';
import { useSyncEvent } from '@/context/SyncContext';
import { timeAgo, getErrorMessage } from '@/lib/utils';
import { SyncBadge } from '@/components/ui/SyncBadge';
import api from '@/lib/api/client';
import { useAppDialog } from '@/context/AppDialogContext';

// ── Searchable nav items ───────────────────────────────────────────────────
const SEARCH_ITEMS = [
  { label: 'דשבורד',            href: '/dashboard' },
  { label: 'דוח שבועי AI',      href: '/weekly-report' },
  { label: 'ביקורת',            href: '/audit' },
  { label: 'יומן פעילות',       href: '/activity' },
  { label: 'יועץ AI',           href: '/ai' },
  { label: 'מלאי',              href: '/inventory' },
  { label: 'השוואת מחירים',     href: '/price-comparison' },
  { label: 'משימות',            href: '/tasks' },
  { label: 'משלוחים',           href: '/deliveries' },
  { label: 'משמרות',            href: '/shifts' },
  { label: 'עובדים',            href: '/employees' },
  { label: 'ספקים והזמנות',     href: '/suppliers' },
  { label: 'חשבוניות',          href: '/invoices' },
  { label: 'מנות',              href: '/recipes' },
  { label: 'הנדסת תפריט',       href: '/menu-engineering' },
  { label: 'הודעות צוות',       href: '/messages' },
  { label: 'התראות',            href: '/notifications' },
  { label: 'תזכורות',           href: '/reminders' },
  { label: 'חיזוי ביקוש',       href: '/forecast' },
  { label: 'תור שולחנות',       href: '/table-queue' },
  { label: 'שיווק דיגיטלי AI',  href: '/ai-marketing' },
  { label: 'דליפות רווח',       href: '/profit-leak' },
  { label: 'פיננסים',           href: '/finance' },
  { label: 'צפי מע"מ',          href: '/vat-report' },
  { label: 'ייצוא לרו"ח',       href: '/reports' },
  { label: 'דוחות Z',           href: '/zreport' },
  { label: 'הגדרות',            href: '/settings' },
  { label: 'קופה',              href: '/pos' },
  { label: 'לוח שנה',           href: '/calendar' },
  { label: 'גלריה',             href: '/gallery' },
  { label: 'זיהוי הונאה',       href: '/fraud-alerts' },
  { label: 'תמיכה',             href: '/guardian' },
];

// ── Data-quality issue type ────────────────────────────────────────────────
interface DQIssue {
  id:          string;
  severity:    'critical' | 'high' | 'medium';
  title:       string;
  description: string;
  fix_hint:    string;
  fix_route:   string;
  count:       number;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#d97706',
};

const SEVERITY_BG: Record<string, string> = {
  critical: 'rgba(254,226,226,0.6)',
  high:     'rgba(255,237,213,0.6)',
  medium:   'rgba(254,249,195,0.6)',
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'קריטי',
  high:     'גבוה',
  medium:   'בינוני',
};

function SeverityIcon({ severity, size = 14 }: { severity: string; size?: number }) {
  const color = SEVERITY_COLOR[severity] ?? '#6b7280';
  if (severity === 'critical') return <AlertCircle   style={{ width: size, height: size, color, flexShrink: 0 }} />;
  if (severity === 'high')     return <AlertTriangle style={{ width: size, height: size, color, flexShrink: 0 }} />;
  return <Info style={{ width: size, height: size, color, flexShrink: 0 }} />;
}

// ── Component ──────────────────────────────────────────────────────────────
export const Header = memo(function Header() {
  const dispatch    = useAppDispatch();
  const { toast }   = useAppDialog();
  const router      = useRouter();
  const unreadCount = useAppSelector((s) => s.notifications.unreadCount);
  const { items }   = useAppSelector((s) => s.notifications);
  const { sidebarOpen, theme } = useAppSelector((s) => s.ui);
  const dark = theme === 'dark';
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // ── Report issue modal ──────────────────────────────────────────────────
  const [reportOpen,  setReportOpen]  = useState(false);
  const [reportTitle, setReportTitle] = useState('');
  const [reportDesc,  setReportDesc]  = useState('');
  const [reportSending, setReportSending] = useState(false);
  const [reportSent,    setReportSent]    = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (reportRef.current && !reportRef.current.contains(e.target as Node)) {
        setReportOpen(false);
      }
    }
    if (reportOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [reportOpen]);

  // ── Search autocomplete ─────────────────────────────────────────────────
  const [searchQuery,     setSearchQuery]     = useState('');
  const [searchFocused,   setSearchFocused]   = useState(false);
  const [searchHighlight, setSearchHighlight] = useState(0);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const searchResults = searchQuery.trim().length > 0
    ? SEARCH_ITEMS.filter(item => item.label.includes(searchQuery.trim())).slice(0, 8)
    : [];

  useEffect(() => { setSearchHighlight(0); }, [searchQuery]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    }
    if (searchFocused) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [searchFocused]);

  const goToResult = useCallback((href: string) => {
    router.push(href);
    setSearchQuery('');
    setSearchFocused(false);
  }, [router]);

  const onSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchHighlight(h => Math.min(h + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (searchResults[searchHighlight]) goToResult(searchResults[searchHighlight].href);
    } else if (e.key === 'Escape') {
      setSearchFocused(false);
    }
  }, [searchResults, searchHighlight, goToResult]);

  const submitReport = async () => {
    if (!reportTitle.trim()) return;
    setReportSending(true);
    try {
      await api.post('/guardian/tickets', {
        issueType:   'platform',
        title:       reportTitle.trim(),
        description: reportDesc.trim() || undefined,
        severity:    'medium',
      });
      setReportSent(true);
      setTimeout(() => {
        setReportOpen(false);
        setReportSent(false);
        setReportTitle('');
        setReportDesc('');
      }, 2000);
    } catch {
      // fail silently — toast not critical here
    }
    setReportSending(false);
  };

  // סנכרון אוטומטי — כשמשתמש אחר/מסך אחר עושה פעולה על התראה, הפאנל מתעדכן
  useSyncEvent('notification', () => dispatch(fetchNotifications()));

  // ── Data quality state ──────────────────────────────────────────────────
  const [dqIssues, setDqIssues] = useState<DQIssue[]>([]);
  const [dismissedDQ, setDismissedDQ] = useState<Set<string>>(new Set());
  const dqFetchedRef = useRef(false);

  const fetchDQ = useCallback(async () => {
    try {
      const data = await api.get('/data-quality');
      setDqIssues(data.data?.issues ?? []);
    } catch {
      // fail silently
    }
  }, []);

  useEffect(() => {
    if (!dqFetchedRef.current) {
      dqFetchedRef.current = true;
      fetchDQ();
    }
    const interval = setInterval(fetchDQ, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchDQ]);

  // Badge = visible DQ issues + unread notifications (must match panel exactly)
  const visibleDqIssues = dqIssues.filter(i => !dismissedDQ.has(i.id));
  const dqBadgeCount    = visibleDqIssues.length;
  const totalBadge      = unreadCount + dqBadgeCount;

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) dispatch(fetchNotifications());
  }, [open, dispatch]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <header
      className="fixed top-0 left-0 right-0 z-30 h-14 transition-all duration-300"
      dir="rtl"
      style={{
        background: dark
          ? 'rgba(20,24,36,0.85)'
          : 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: `1px solid ${dark ? 'rgba(45,49,72,0.8)' : 'var(--glass-border, rgba(201,162,39,0.15))'}`,
        boxShadow: '0 1px 20px rgba(0,0,0,0.06)',
      }}
    >
      <div
        className="flex items-center justify-between h-full px-4 transition-all duration-300"
        style={{ paddingRight: isMobile ? '1rem' : `calc(${sidebarOpen ? '15rem' : '4rem'} + 1rem)` }}
      >
        {/* Mobile hamburger */}
        <button
          onClick={() => dispatch(toggleSidebar())}
          className="hidden md:flex p-2 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors flex-shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Search with autocomplete */}
        <div ref={searchContainerRef} className="hidden lg:block relative flex-none w-72">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none z-10" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={onSearchKeyDown}
            placeholder="חיפוש פיצ'ר..."
            autoComplete="off"
            className="w-full pr-9 pl-4 py-1.5 text-sm rounded-xl focus:outline-none focus:ring-2"
            style={{
              background: dark ? 'rgba(30,34,53,0.8)' : 'rgba(255,255,255,0.6)',
              backdropFilter: 'blur(10px)',
              border: `1px solid ${dark ? 'rgba(55,65,81,0.8)' : 'var(--glass-border, rgba(201,162,39,0.15))'}`,
              color: dark ? '#f3f4f6' : '#111827',
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            }}
          />
          {searchFocused && searchResults.length > 0 && (
            <div
              className="absolute top-full right-0 mt-1.5 w-full rounded-xl overflow-hidden z-50"
              style={{
                background: dark ? 'rgba(15,17,23,0.98)' : 'rgba(255,255,255,0.98)',
                border: `1px solid ${dark ? 'rgba(55,65,81,0.9)' : 'rgba(201,162,39,0.25)'}`,
                boxShadow: dark
                  ? '0 8px 32px rgba(0,0,0,0.6)'
                  : '0 8px 32px rgba(0,0,0,0.12)',
                backdropFilter: 'blur(20px)',
              }}
            >
              {searchResults.map((item, i) => (
                <button
                  key={item.href}
                  onMouseDown={e => { e.preventDefault(); goToResult(item.href); }}
                  onMouseEnter={() => setSearchHighlight(i)}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-right transition-colors"
                  style={{
                    background: i === searchHighlight
                      ? (dark ? 'rgba(201,162,39,0.15)' : 'rgba(201,162,39,0.1)')
                      : 'transparent',
                    color: i === searchHighlight
                      ? '#c9a227'
                      : (dark ? '#d1d5db' : '#374151'),
                    borderBottom: i < searchResults.length - 1
                      ? `1px solid ${dark ? 'rgba(55,65,81,0.4)' : 'rgba(0,0,0,0.05)'}`
                      : 'none',
                  }}
                >
                  <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mobile title */}
        <div className="md:hidden flex items-center gap-2">
          <span className="font-bold text-sm" style={{ color: dark ? '#f3f4f6' : '#111827' }}>House of Business</span>
        </div>

        {/* Action buttons group: quick start + report issue + bell + connection status */}
        <div className="flex items-center gap-0.5">

        {/* Quick start guide button */}
        <button
          onClick={() => router.push('/quickstart')}
          className="relative p-2 rounded-xl transition-all"
          title="מדריך התחלה מהירה"
          style={{ color: dark ? '#9ca3af' : 'var(--color-primary, #1a5c2a)' }}
          onMouseEnter={e => { (e.currentTarget.style.background = 'var(--color-accent-light, rgba(201,162,39,0.1))'); }}
          onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); }}
        >
          <Zap className="w-5 h-5" />
        </button>

        {/* Report issue button + modal */}
        <div className="relative" ref={reportRef}>
          <button
            onClick={() => { setReportOpen(v => !v); setOpen(false); }}
            className="relative p-2 rounded-xl transition-all"
            title="דווח על תקלה"
            style={{
              color: dark ? '#9ca3af' : 'var(--color-primary, #1a5c2a)',
              background: reportOpen ? 'var(--color-accent-light, rgba(201,162,39,0.1))' : 'transparent',
            }}
          >
            <HelpCircle className="w-5 h-5" />
          </button>

          {reportOpen && (
            <div
              className="absolute top-11 left-0 w-80 max-w-[calc(100vw-2rem)] rounded-2xl z-50 overflow-hidden"
              style={{
                background: dark ? 'rgba(26,29,39,0.98)' : 'rgba(255,255,255,0.97)',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                border: `1px solid ${dark ? 'rgba(45,49,72,0.8)' : 'var(--glass-border, rgba(201,162,39,0.2))'}`,
                boxShadow: 'var(--glass-shadow-lg, 0 20px 60px rgba(0,0,0,0.15))',
              }}
              dir="rtl"
            >
              <div className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom: `1px solid ${dark ? 'rgba(45,49,72,0.6)' : 'var(--glass-border, rgba(201,162,39,0.15))'}`,
                  background: dark ? 'rgba(30,34,53,0.5)' : 'var(--card-header-bg, rgba(253,252,248,0.9))',
                }}>
                <div className="flex items-center gap-2">
                  <HelpCircle className="w-4 h-4" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
                  <span className="font-bold text-sm" style={{ color: 'var(--color-primary-dark, #0d3518)' }}>דווח על תקלה</span>
                </div>
                <button onClick={() => setReportOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 space-y-3">
                {reportSent ? (
                  <div className="text-center py-4">
                    <p className="text-green-600 font-semibold text-sm">הדיווח נשלח בהצלחה!</p>
                    <p className="text-xs text-gray-400 mt-1">נטפל בקרוב</p>
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-semibold mb-1"
                        style={{ color: dark ? '#9ca3af' : '#4b5563' }}>כותרת התקלה *</label>
                      <input
                        type="text"
                        value={reportTitle}
                        onChange={e => setReportTitle(e.target.value)}
                        placeholder="תאר בקצרה את הבעיה..."
                        className="w-full px-3 py-2 rounded-xl text-sm"
                        style={{
                          background: dark ? 'rgba(30,34,53,0.8)' : 'rgba(255,255,255,0.8)',
                          border: `1px solid ${dark ? 'rgba(55,65,81,0.8)' : 'var(--glass-border, rgba(201,162,39,0.2))'}`,
                          color: dark ? '#f3f4f6' : '#111827',
                          outline: 'none',
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1"
                        style={{ color: dark ? '#9ca3af' : '#4b5563' }}>פירוט (אופציונלי)</label>
                      <textarea
                        rows={3}
                        value={reportDesc}
                        onChange={e => setReportDesc(e.target.value)}
                        placeholder="מה קרה? באיזה מסך? מה ניסית לעשות?"
                        className="w-full px-3 py-2 rounded-xl text-sm resize-none"
                        style={{
                          background: dark ? 'rgba(30,34,53,0.8)' : 'rgba(255,255,255,0.8)',
                          border: `1px solid ${dark ? 'rgba(55,65,81,0.8)' : 'var(--glass-border, rgba(201,162,39,0.2))'}`,
                          color: dark ? '#f3f4f6' : '#111827',
                          outline: 'none',
                        }}
                      />
                    </div>
                    <button
                      onClick={submitReport}
                      disabled={!reportTitle.trim() || reportSending}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all"
                      style={{
                        background: reportTitle.trim() && !reportSending
                          ? 'var(--color-primary, #1a5c2a)'
                          : 'rgba(0,0,0,0.08)',
                        color: reportTitle.trim() && !reportSending ? 'white' : '#9ca3af',
                        cursor: !reportTitle.trim() || reportSending ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Send className="w-4 h-4" />
                      {reportSending ? 'שולח...' : 'שלח דיווח'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bell + dropdown */}
        <div className="flex items-center gap-2 relative" ref={panelRef} style={{ marginRight: 0 }}>
          <button
            onClick={() => setOpen(v => !v)}
            className="relative p-2 rounded-xl transition-all"
            style={{
              color: dark ? '#9ca3af' : 'var(--color-primary, #1a5c2a)',
              background: open ? 'var(--color-accent-light, rgba(201,162,39,0.1))' : 'transparent',
            }}
          >
            <Bell className="w-5 h-5" />
            {totalBadge > 0 && (
              <span
                className="absolute top-1 right-1 w-4 h-4 text-white text-xs rounded-full flex items-center justify-center font-bold"
                style={{ background: '#ef4444' }}
              >
                {totalBadge > 9 ? '9+' : totalBadge}
              </span>
            )}
          </button>

          {open && (
            <div
              className="absolute top-11 left-0 w-96 max-w-[calc(100vw-2rem)] rounded-2xl z-50 overflow-hidden"
              style={{
                right: 'auto',
                background: dark ? 'rgba(26,29,39,0.98)' : 'rgba(255,255,255,0.97)',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                border: `1px solid ${dark ? 'rgba(45,49,72,0.8)' : 'var(--glass-border, rgba(201,162,39,0.2))'}`,
                boxShadow: 'var(--glass-shadow-lg, 0 20px 60px rgba(0,0,0,0.15))',
              }}
              dir="rtl"
            >
              {/* Panel header */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom: `1px solid ${dark ? 'rgba(45,49,72,0.6)' : 'var(--glass-border, rgba(201,162,39,0.15))'}`,
                  background: dark ? 'rgba(30,34,53,0.5)' : 'var(--card-header-bg, rgba(253,252,248,0.9))',
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm" style={{ color: 'var(--color-primary-dark, #0d3518)' }}>התראות</span>
                  {visibleDqIssues.length > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold"
                      style={{ background: '#fee2e2', color: '#dc2626' }}>
                      {visibleDqIssues.length} בעיות נתונים
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {items.some(n => !n.is_read) && (
                    <button
                      onClick={() => dispatch(markAllRead()).unwrap().catch((err) => toast(getErrorMessage(err) || 'סימון הכל כנקרא נכשל', 'error'))}
                      className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg"
                      style={{ color: 'var(--color-primary, #1a5c2a)', background: 'var(--tag-bg, #e8f5eb)' }}
                    >
                      <CheckCheck className="w-3 h-3" />
                      סמן הכל
                    </button>
                  )}
                  <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="max-h-[520px] overflow-y-auto" dir="rtl">

                {/* ── Data Quality Section ─────────────────────────────── */}
                {visibleDqIssues.length > 0 && (
                  <div>
                    {/* DQ section label */}
                    <div className="px-4 py-2 flex items-center gap-2"
                      style={{
                        background: dark ? 'rgba(127,29,29,0.25)' : 'rgba(254,242,242,0.9)',
                        borderBottom: `1px solid ${dark ? 'rgba(127,29,29,0.4)' : 'rgba(254,202,202,0.8)'}`,
                      }}>
                      <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                      <span className="text-xs font-semibold text-red-600">בעיות אמינות נתונים — דורשות תיקון</span>
                    </div>

                    {visibleDqIssues.map((issue) => (
                      <div
                        key={issue.id}
                        className="flex items-start gap-3 px-4 py-3 cursor-pointer transition-all group"
                        style={{
                          background: dark ? 'rgba(0,0,0,0.15)' : SEVERITY_BG[issue.severity] ?? 'transparent',
                          borderBottom: `1px solid ${dark ? 'rgba(45,49,72,0.35)' : 'rgba(0,0,0,0.04)'}`,
                          borderRight: `3px solid ${SEVERITY_COLOR[issue.severity] ?? '#6b7280'}`,
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.background = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = dark ? 'rgba(0,0,0,0.15)' : (SEVERITY_BG[issue.severity] ?? 'transparent');
                        }}
                        onClick={() => {
                          setOpen(false);
                          router.push(issue.fix_route);
                        }}
                      >
                        <div className="mt-0.5 flex-shrink-0">
                          <SeverityIcon severity={issue.severity} size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                            <p className="text-sm font-bold leading-tight" style={{ color: SEVERITY_COLOR[issue.severity] }}>
                              {issue.title}
                            </p>
                            <span
                              className="text-xs px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0"
                              style={{
                                background: SEVERITY_COLOR[issue.severity] + '22',
                                color:      SEVERITY_COLOR[issue.severity],
                              }}
                            >
                              {SEVERITY_LABEL[issue.severity]}
                            </span>
                          </div>
                          <p className="text-xs leading-relaxed mb-1.5" style={{ color: dark ? '#9ca3af' : '#4b5563' }}>
                            {issue.description}
                          </p>
                          <div
                            className="flex items-center gap-0.5 text-xs font-semibold"
                            style={{ color: SEVERITY_COLOR[issue.severity] }}
                          >
                            <span>{issue.fix_hint}</span>
                            <ChevronRight className="w-3 h-3 flex-shrink-0" />
                          </div>
                        </div>
                        {/* X — dismiss locally (DQ issues re-appear on next load if not fixed) */}
                        <button
                          className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded-lg transition-opacity hover:bg-black/10"
                          onClick={e => {
                            e.stopPropagation();
                            setDismissedDQ(s => new Set([...s, issue.id]));
                          }}
                          title="הסתר"
                        >
                          <X className="w-3.5 h-3.5 text-gray-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Regular Notifications Section ────────────────────── */}
                <div>
                  {visibleDqIssues.length > 0 && items.length > 0 && (
                    <div className="px-4 py-2"
                      style={{
                        background: dark ? 'rgba(30,34,53,0.6)' : 'rgba(248,250,252,0.95)',
                        borderBottom: `1px solid ${dark ? 'rgba(45,49,72,0.4)' : 'rgba(0,0,0,0.05)'}`,
                      }}>
                      <span className="text-xs font-semibold" style={{ color: dark ? '#6b7280' : '#9ca3af' }}>
                        התראות מערכת
                      </span>
                    </div>
                  )}

                  <div className="divide-y" style={{ borderColor: dark ? 'rgba(45,49,72,0.4)' : 'rgba(0,0,0,0.04)' }}>
                    {items.length === 0 && visibleDqIssues.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Bell className="w-8 h-8 text-gray-200 mb-2" />
                        <p className="text-sm text-gray-400">אין התראות חדשות</p>
                      </div>
                    ) : items.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-5 text-center">
                        <Bell className="w-6 h-6 text-gray-200 mb-1.5" />
                        <p className="text-xs text-gray-400">אין התראות מערכת נוספות</p>
                      </div>
                    ) : (
                      items.map(notif => {
                        const isCritical = notif.type === 'missing_ingredients';
                        return (
                          <div
                            key={notif.id}
                            className="flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors group"
                            style={{
                              background: isCritical && !notif.is_read
                                ? 'rgba(254,226,226,0.6)'
                                : !notif.is_read ? 'rgba(219,234,254,0.4)' : 'transparent',
                              borderRight: isCritical ? '3px solid #ef4444' : '3px solid transparent',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')}
                            onMouseLeave={e => (e.currentTarget.style.background =
                              isCritical && !notif.is_read ? 'rgba(254,226,226,0.6)' :
                              !notif.is_read ? 'rgba(219,234,254,0.4)' : 'transparent')}
                            onClick={() => !notif.is_read && dispatch(markRead(notif.id)).unwrap().catch((err) => toast(getErrorMessage(err) || 'סימון כנקרא נכשל', 'error'))}
                          >
                            <div className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0"
                              style={{ background: !notif.is_read ? (isCritical ? '#ef4444' : 'var(--color-accent, #c9a227)') : 'transparent' }} />
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm ${!notif.is_read ? 'font-semibold' : 'font-medium text-gray-600'}`}
                                style={{ color: isCritical && !notif.is_read ? '#dc2626' : undefined }}>
                                {notif.title}
                              </p>
                              {notif.body && (
                                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                                  {notif.body}
                                </p>
                              )}
                              <p className="text-xs text-gray-400 mt-0.5">{timeAgo(notif.created_at)}</p>
                            </div>
                            {/* X — מחיקה מהמסד */}
                            <button
                              className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded-lg transition-opacity hover:bg-black/10"
                              onClick={e => {
                                e.stopPropagation();
                                dispatch(deleteNotification(notif.id)).unwrap().catch(() => {});
                              }}
                              title="מחק התראה"
                            >
                              <X className="w-3.5 h-3.5 text-gray-400" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Connection status */}
        <div className="hidden lg:flex items-center px-1">
          <SyncBadge />
        </div>

        </div> {/* end action buttons group */}
      </div>
    </header>
  );
});
