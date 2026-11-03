'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { useMountedCallback } from '@/hooks/useMountedCallback';
import {
  ShoppingBag, TrendingUp, Users, AlertTriangle,
  FileText, Package, BarChart3, Bell, UserCheck, Bike, Plus, X,
  UtensilsCrossed, CheckSquare, Square, Trash2, Send, Percent,
  Sparkles, ChevronDown, ChevronUp, RefreshCw, MessageCircle } from 'lucide-react';
import { useSyncEvent } from '@/context/SyncContext';
import { dashboardApi, auditApi, remindersApi, shiftsApi, deliveriesApi, tablesApi, weeklyTasksApi, insightsApi } from '@/lib/api';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { useAppSelector } from '@/hooks/useAppDispatch';
import type { DashboardData, AuditReport } from '@/types';
import Link from 'next/link';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useAppDialog } from '@/context/AppDialogContext';

export default function DashboardPage() {
  const { user } = useAppSelector((s) => s.auth);
  const { toast } = useAppDialog();
  const [data, setData]       = useState<DashboardData | null>(null);
  const [audit, setAudit]     = useState<AuditReport | null>(null);
  const [reminders, setReminders] = useState<{ id: string; title: string; remind_at: string }[]>([]);
  const [openShifts, setOpenShifts] = useState<{ id: string; employee_name: string; start_time: string }[]>([]);
  const [deliveries, setDeliveries] = useState<{ totals: { total: number; revenue: number; active: number }; byPlatform: { platform: string; total: number; revenue: number; active: number }[] } | null>(null);
  const [showAddDelivery, setShowAddDelivery] = useState(false);
  const [newDelivery, setNewDelivery] = useState({ platform: 'wolt', amount: '' });
  const [openTables, setOpenTables] = useState<{ id: string; table_number: number; total_amount: number; sold_at: string }[]>([]);
  const [weeklyTasks, setWeeklyTasks] = useState<{ id: string; text: string; done: boolean }[]>([]);
  const [newTask, setNewTask] = useState('');
  const [foodCostPct, setFoodCostPct] = useState<number | null>(null);
  const [foodCostHasData, setFoodCostHasData] = useState<boolean>(true);
  const [foodCostHasEstimate, setFoodCostHasEstimate] = useState<boolean>(false);
  const [insights, setInsights] = useState<{ id: string; type: string; title: string; body: string; impact: number | null; severity: string; is_read: boolean; created_at: string }[]>([]);
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const [insightsOpen, setInsightsOpen]             = useState(true);
  const [insightsUpToDate, setInsightsUpToDate]     = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // WhatsApp daily summary
  type DailySummary = { revenue: number; tx_count: number; shift_count: number; open_shifts: string[]; low_stock: { name: string; quantity: number; unit: string }[]; haccp_alerts: number; pending_cleaning: number; wa_link: string; message: string; };
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [showAddReminder, setShowAddReminder] = useState(false);
  const [newReminder, setNewReminder] = useState({ title: '', remind_at: '' });
  const [addingReminder, setAddingReminder] = useState(false);

  const safe = useMountedCallback();

  const load = useCallback(() => {
    Promise.all([
      dashboardApi.get().catch(() => ({ data: null })),
      auditApi.latest().catch(() => ({ data: null })),
      remindersApi.list().catch(() => ({ data: [] })),
      shiftsApi.openShifts().catch(() => ({ data: [] })),
      deliveriesApi.today().catch(() => ({ data: null })),
      tablesApi.list().catch(() => ({ data: { tables: [] } })),
      weeklyTasksApi.list().catch(() => ({ data: [] })),
      dashboardApi.foodCostMonthly().catch(() => ({ data: null })),
      insightsApi.list().catch(() => ({ data: [] })),
    ]).then(([dash, aud, rem, shifts, del, tables, tasks, foodCost, ins]) => {
      safe(() => {
        setData(dash.data);
        setAudit(aud.data?.hasData ? aud.data : null);
        const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const upcoming = (Array.isArray(rem.data) ? rem.data : [])
          .filter((r: { remind_at: string; is_sent: boolean }) => !r.is_sent && new Date(r.remind_at) <= soon);
        setReminders(upcoming);
        setOpenShifts(shifts.data?.shifts || []);
        setDeliveries(del.data);
        setOpenTables(tables.data?.tables || []);
        setWeeklyTasks(Array.isArray(tasks.data) ? tasks.data : []);
        setFoodCostPct(foodCost.data?.hasData ? (foodCost.data?.foodCostPct ?? null) : null);
        setFoodCostHasData(!!foodCost.data?.hasData);
        setFoodCostHasEstimate(!!foodCost.data?.hasAnyEstimate);
        setInsights(Array.isArray(ins.data) ? ins.data : []);
        setLoading(false);
      });
    }).catch(() => safe(() => { setLoading(false); setLoadError(true); }));
  }, [safe]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh when dashboard data changes via real-time events
  useSyncEvent(['dashboard.refresh', 'shift_opened', 'shift_closed', 'task.updated', 'delivery.imported', 'inventory.updated'], load);

  // Must be declared before any early return — hooks cannot be called conditionally
  const [isAddingDelivery, setIsAddingDelivery] = useState(false);
  const handleAddDelivery = useCallback(async () => {
    if (isAddingDelivery) return;
    if (!newDelivery.amount || isNaN(Number(newDelivery.amount)) || Number(newDelivery.amount) <= 0) return;
    setIsAddingDelivery(true);
    try {
      await deliveriesApi.add({ platform: newDelivery.platform, amount: Number(newDelivery.amount) });
      const { data } = await deliveriesApi.today();
      setDeliveries(data);
      setShowAddDelivery(false);
      setNewDelivery({ platform: 'wolt', amount: '' });
    } catch (err) {
      toast(getErrorMessage(err) || 'הוספת המשלוח נכשלה', 'error');
    } finally {
      setIsAddingDelivery(false);
    }
  }, [newDelivery, toast, isAddingDelivery]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse" dir="rtl">
        <div className="h-28 lg:h-36 rounded-2xl" style={{ background: 'var(--hero-gradient, linear-gradient(135deg,#0d3518,#1a5c2a))' }} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-24 lg:h-28 bg-gray-200 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4" dir="rtl">
        <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
          <AlertTriangle className="w-7 h-7 text-red-500" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-bold mb-1">לא ניתן לטעון את הדשבורד</h2>
          <p className="text-sm text-gray-500 mb-4">בדוק את חיבור הרשת ונסה שוב</p>
          <button
            onClick={() => { setLoadError(false); setLoading(true); load(); }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors mx-auto"
          >
            <RefreshCw className="w-4 h-4" />
            נסה שנית
          </button>
        </div>
      </div>
    );
  }

  const today      = data?.todayRevenue;
  const lowStock   = data?.emergencyAlerts || [];
  const totalAlerts = lowStock.length;
  const margin = today?.revenue ? ((today.netProfit / today.revenue) * 100).toFixed(1) : null;

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">

      {/* ── Hero Header ─────────────────────────────────────────── */}
      <div
        className="relative overflow-hidden rounded-2xl px-4 py-5 lg:px-8 lg:py-7"
        style={{ background: 'var(--hero-gradient, linear-gradient(135deg, #061a0b 0%, #1a5c2a 60%, #2e7d32 100%))' }}
      >
        {/* decorative circles */}
        <div className="absolute -top-8 -left-8 w-40 h-40 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, var(--hero-accent, #c9a227), transparent)' }} />
        <div className="absolute -bottom-10 left-1/3 w-56 h-56 rounded-full opacity-5"
          style={{ background: 'radial-gradient(circle, var(--hero-accent, #d4af37), transparent)' }} />

        <div className="relative flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--hero-accent, #c9a227)' }}>
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            <h1 className="text-2xl lg:text-3xl font-bold text-white">
                שלום, {user?.fullName?.split(' ')[0]}
              </h1>
            <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.6)' }}>ברוך הבא לפאנל הניהול</p>
          </div>
          {totalAlerts > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl" style={{ background: 'rgba(201,162,39,0.15)', border: '1px solid rgba(201,162,39,0.3)' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-accent, #c9a227)' }} />
              <div className="flex gap-3 text-xs flex-wrap">
                <Link href="/inventory" className="font-semibold hover:underline" style={{ color: '#e8c84a' }}>
                  {totalAlerts} מלאי נמוך
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI Cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        {[
          {
            label: 'הכנסה היום',
            value: formatCurrency(today?.revenue || 0),
            sub: `${data?.ordersToday?.total || 0} מכירות`,
            icon: ShoppingBag,
            gradient: 'var(--kpi-gradient-1, linear-gradient(135deg,#1a5c2a,#2e7d32))',
            iconBg: 'rgba(255,255,255,0.15)',
          },
          {
            label: 'רווח נקי היום',
            value: formatCurrency(today?.netProfit || 0),
            sub: margin ? `${margin}% מרווח` : 'אין נתונים',
            icon: TrendingUp,
            gradient: 'var(--kpi-gradient-2, linear-gradient(135deg,#a07d10,#c9a227))',
            iconBg: 'rgba(255,255,255,0.15)',
          },
          {
            label: 'עובדים במשמרת',
            value: String(openShifts.length),
            sub: openShifts.length > 0 ? openShifts.slice(0,2).map(s=>s.employee_name).join(', ') : 'אין משמרות פעילות',
            icon: UserCheck,
            gradient: 'linear-gradient(135deg,#312e81,#4f46e5)',
            iconBg: 'rgba(255,255,255,0.15)',
          },
          {
            label: 'ציון ביקורת',
            value: audit ? `${audit.score}` : '—',
            sub: audit ? (audit.score >= 80 ? 'מצוין' : audit.score >= 60 ? 'טוב' : 'דורש שיפור') : 'טרם נבדק',
            icon: BarChart3,
            gradient: audit && audit.score >= 70
              ? 'linear-gradient(135deg,#065f46,#059669)'
              : 'linear-gradient(135deg,#92400e,#d97706)',
            iconBg: 'rgba(255,255,255,0.15)',
            href: '/audit',
          },
        ].map(({ label, value, sub, icon: Icon, gradient, iconBg, href }) => {
          const inner = (
            <>
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: iconBg }}>
                  <Icon className="w-5 h-5 text-white" />
                </div>
              </div>
              <p className="text-3xl font-black tracking-tight">{value}</p>
              <p className="text-xs mt-1 font-medium opacity-80">{label}</p>
              <p className="text-xs mt-0.5 opacity-60 truncate">{sub}</p>
              <div className="absolute -bottom-4 -left-4 w-20 h-20 rounded-full opacity-10"
                style={{ background: 'white' }} />
            </>
          );
          const cls = "relative overflow-hidden rounded-2xl p-5 text-white shadow-lg block";
          return href
            ? <Link key={label} href={href} className={cls} style={{ background: gradient }}>{inner}</Link>
            : <div key={label} className={cls} style={{ background: gradient }}>{inner}</div>;
        })}

        {/* Open Tables KPI */}
        <div className="relative overflow-hidden rounded-2xl p-5 text-white shadow-lg"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#a855f7)' }}>
          <div className="flex items-start justify-between mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(255,255,255,0.15)' }}>
              <UtensilsCrossed className="w-5 h-5 text-white" />
            </div>
          </div>
          <p className="text-3xl font-black tracking-tight">{openTables.length}</p>
          <p className="text-xs mt-1 font-medium opacity-80">שולחנות פתוחים</p>
          {openTables.length > 0 ? (
            <div className="mt-2 space-y-1 max-h-20 overflow-y-auto">
              {openTables.map(t => (
                <div key={t.id} className="flex justify-between text-xs opacity-80">
                  <span>שולחן {t.table_number}</span>
                  <span className="font-bold">{formatCurrency(t.total_amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs mt-0.5 opacity-60">אין שולחנות פתוחים</p>
          )}
          <div className="absolute -bottom-4 -left-4 w-20 h-20 rounded-full opacity-10"
            style={{ background: 'white' }} />
        </div>

        {/* Food Cost % KPI — עלות מזון מצטברת מתחילת החודש הקלנדרי, מתאפסת כל חודש */}
        {(() => {
          const hasFoodCost = foodCostHasData && foodCostPct !== null;
          return (
            <Link href="/menu-engineering"
              className="relative overflow-hidden rounded-2xl p-5 text-white shadow-lg block"
              style={{ background: !hasFoodCost
                ? 'linear-gradient(135deg,#374151,#4b5563)'
                : foodCostPct! <= 30
                ? 'linear-gradient(135deg,#065f46,#059669)'
                : foodCostPct! <= 38
                ? 'linear-gradient(135deg,#92400e,#d97706)'
                : 'linear-gradient(135deg,#7f1d1d,#dc2626)'
              }}>
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(255,255,255,0.15)' }}>
                  <Percent className="w-5 h-5 text-white" />
                </div>
              </div>
              <p className="text-3xl font-black tracking-tight">
                {hasFoodCost ? `${foodCostPct}%` : '—'}
              </p>
              <p className="text-xs mt-1 font-medium opacity-80">עלות מזון (מתחילת החודש)</p>
              <p className="text-xs mt-0.5 opacity-60">
                {!hasFoodCost ? 'אין נתוני מנות' :
                 foodCostPct! <= 30 ? 'מעולה — מתחת ל-30%' :
                 foodCostPct! <= 38 ? 'סביר — יעד: מתחת ל-32%' :
                 'גבוה — בדוק מחירים'}
                {hasFoodCost && foodCostHasEstimate ? ' · כולל הערכה לימים ללא פירוט מנות בדוח' : ''}
              </p>
              <div className="absolute -bottom-4 -left-4 w-20 h-20 rounded-full opacity-10"
                style={{ background: 'white' }} />
            </Link>
          );
        })()}
      </div>

      {/* ── WhatsApp Daily Summary ──────────────────────────────── */}
      <div className="rounded-2xl p-5"
        style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg,#075e54,#128c7e)' }}>
              <MessageCircle className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm" style={{ color: '#e8e8e4' }}>שיתוף WhatsApp יומי</span>
            <span className="text-xs opacity-50">— סיכום יום לשיתוף עם השותפים</span>
          </div>
          <button
            onClick={async () => {
              if (summaryLoaded && dailySummary) {
                window.open(dailySummary.wa_link, '_blank');
                return;
              }
              setSummaryLoading(true);
              try {
                const r = await dashboardApi.dailySummary();
                setDailySummary(r.data);
                setSummaryLoaded(true);
              } catch {}
              finally { setSummaryLoading(false); }
            }}
            disabled={summaryLoading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity"
            style={{ background: 'linear-gradient(135deg,#075e54,#25d366)', opacity: summaryLoading ? 0.6 : 1 }}
          >
            <MessageCircle className="w-4 h-4" />
            {summaryLoading ? 'מכין סיכום...' : summaryLoaded ? 'פתח WhatsApp' : 'הכן סיכום ושתף'}
          </button>
        </div>

        {summaryLoaded && dailySummary && (
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'מכירות היום', value: `₪${(dailySummary.revenue || 0).toLocaleString('he-IL', { maximumFractionDigits: 0 })}`, sub: `${dailySummary.tx_count || 0} עסקאות` },
              { label: 'עובדים', value: String(dailySummary.shift_count || 0), sub: (dailySummary.open_shifts?.length || 0) > 0 ? `${dailySummary.open_shifts.length} משמרות פתוחות!` : 'כולם יצאו' },
              { label: 'מלאי נמוך', value: String(dailySummary.low_stock?.length || 0), sub: (dailySummary.low_stock?.length || 0) > 0 ? dailySummary.low_stock[0].name : 'הכל תקין' },
              { label: 'HACCP', value: (dailySummary.haccp_alerts || 0) > 0 ? `${dailySummary.haccp_alerts} חריגות` : '✓', sub: (dailySummary.pending_cleaning || 0) > 0 ? `${dailySummary.pending_cleaning} ניקיון ממתין` : 'ניקיון הושלם' },
            ].map(({ label, value, sub }) => (
              <div key={label} className="rounded-xl p-3 text-center"
                style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.14)' }}>
                <p className="text-xl font-black" style={{ color: 'var(--color-primary)' }}>{value}</p>
                <p className="text-xs font-medium mt-0.5" style={{ color: '#b8bcc4' }}>{label}</p>
                <p className="text-xs opacity-50 mt-0.5 truncate">{sub}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── AI Insights ─────────────────────────────────────────── */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>

        {/* Header — always visible, click to collapse */}
        <div className="flex items-center justify-between p-4 cursor-pointer select-none"
          onClick={() => setInsightsOpen(v => !v)}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--hero-gradient)' }}>
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm" style={{ color: '#e8e8e4' }}>תובנות AI</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async (e) => {
                e.stopPropagation();
                setInsightsUpToDate(false);
                setGeneratingInsights(true);
                try {
                  const { data } = await insightsApi.generate();
                  const fresh = data.insights || [];
                  if (fresh.length === 0 && insights.length > 0) {
                    setInsightsUpToDate(true);
                  } else {
                    setInsights(fresh);
                    setInsightsOpen(true);
                  }
                } catch {}
                setGeneratingInsights(false);
              }}
              disabled={generatingInsights}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
              style={{ background: 'rgba(201,162,39,0.12)', color: '#c9a227' }}
            >
              <RefreshCw className={`w-3 h-3 ${generatingInsights ? 'animate-spin' : ''}`} />
              {generatingInsights ? 'מנתח...' : 'צור לי תובנות'}
            </button>
            <div className="text-slate-400 pointer-events-none">
              {insightsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </div>
        </div>

        {/* "up to date" banner */}
        {insightsUpToDate && insightsOpen && (
          <div className="mx-4 mb-3 px-3 py-2 rounded-xl text-xs font-medium text-center"
            style={{ background: 'rgba(5,150,105,0.1)', border: '1px solid rgba(5,150,105,0.3)', color: '#34d399' }}>
            ✅ התובנות האחרונות הן החדשות ביותר
          </div>
        )}

        {/* Collapsible body */}
        {insightsOpen && (
          <div className="px-4 pb-4 space-y-2">
            {insights.length === 0 ? (
              <div className="text-center py-6" style={{ color: '#6b7280' }}>
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">לחץ "צור לי תובנות" ליצירת תובנות AI על הנתונים שלך</p>
              </div>
            ) : (
              insights.slice(0, 4).map((ins) => {
                const colors = ins.severity === 'critical'
                  ? { bg: 'rgba(220,38,38,0.1)', border: 'rgba(220,38,38,0.3)', dot: '#f87171', text: '#fca5a5' }
                  : ins.severity === 'warning'
                  ? { bg: 'rgba(217,119,6,0.1)', border: 'rgba(217,119,6,0.3)', dot: '#fbbf24', text: '#fcd34d' }
                  : { bg: 'rgba(37,99,235,0.1)', border: 'rgba(37,99,235,0.3)', dot: '#60a5fa', text: '#93c5fd' };
                return (
                  <div key={ins.id}
                    className="flex gap-3 p-3 rounded-xl border cursor-pointer transition-opacity"
                    style={{ background: colors.bg, borderColor: colors.border, opacity: ins.is_read ? 0.65 : 1 }}
                    onClick={async () => {
                      if (!ins.is_read) {
                        await insightsApi.markRead(ins.id).catch(() => {});
                        setInsights(prev => prev.map(i => i.id === ins.id ? { ...i, is_read: true } : i));
                      }
                    }}
                  >
                    <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5" style={{ background: colors.dot }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold" style={{ color: colors.text }}>{ins.title}</p>
                      <p className="text-xs mt-0.5 line-clamp-2" style={{ color: '#9aa0ab' }}>{ins.body}</p>
                      {ins.impact !== null && ins.impact > 0 && (
                        <p className="text-xs font-bold mt-1" style={{ color: colors.dot }}>השפעה כספית: {formatCurrency(Number(ins.impact))}</p>
                      )}
                    </div>
                    {!ins.is_read && (
                      <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5" style={{ background: colors.dot }} />
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── Deliveries + Reminders row ──────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Deliveries — takes 2 cols */}
        <div className="lg:col-span-2">
          <DeliveriesWidget
            deliveries={deliveries}
            showAdd={showAddDelivery}
            setShowAdd={setShowAddDelivery}
            newDelivery={newDelivery}
            setNewDelivery={setNewDelivery}
            onAdd={handleAddDelivery}
            adding={isAddingDelivery}
          />
        </div>

        {/* Reminders + Weekly Tasks column */}
        <div className="flex flex-col gap-4">
          {/* Reminders card */}
          <div className="rounded-2xl p-5 flex flex-col gap-3"
            style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: 'rgba(201,162,39,0.15)' }}>
                  <Bell className="w-4 h-4" style={{ color: '#c9a227' }} />
                </div>
                <span className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>תזכורות קרובות</span>
              </div>
              <button
                onClick={() => setShowAddReminder(v => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: showAddReminder ? 'var(--color-primary, #1a5c2a)' : 'var(--tag-bg, #e8f5eb)' }}
                title="הוסף תזכורת"
              >
                {showAddReminder
                  ? <X className="w-3.5 h-3.5 text-white" />
                  : <Plus className="w-3.5 h-3.5" style={{ color: 'var(--color-primary, #1a5c2a)' }} />}
              </button>
            </div>

            {/* Add reminder form */}
            {showAddReminder && (
              <div className="rounded-xl p-3 space-y-2" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.16)' }}>
                <input
                  value={newReminder.title}
                  onChange={e => setNewReminder(r => ({ ...r, title: e.target.value }))}
                  placeholder="כותרת התזכורת..."
                  className="w-full text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                  style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418', color: '#e8e8e4' }}
                />
                <input
                  type="datetime-local"
                  value={newReminder.remind_at}
                  onChange={e => setNewReminder(r => ({ ...r, remind_at: e.target.value }))}
                  className="w-full text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                  style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418', color: '#e8e8e4' }}
                />
                <button
                  disabled={!newReminder.title.trim() || !newReminder.remind_at || addingReminder}
                  onClick={async () => {
                    if (!newReminder.title.trim() || !newReminder.remind_at) return;
                    setAddingReminder(true);
                    try {
                      await remindersApi.create({
                        title: newReminder.title.trim(),
                        remindAt: new Date(newReminder.remind_at).toISOString(),
                      });
                      const { data } = await remindersApi.list();
                      const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
                      const upcoming = (Array.isArray(data) ? data : [])
                        .filter((r: { remind_at: string; is_sent: boolean }) => !r.is_sent && new Date(r.remind_at) <= soon);
                      setReminders(upcoming);
                      setNewReminder({ title: '', remind_at: '' });
                      setShowAddReminder(false);
                    } catch (err) {
                      toast(getErrorMessage(err) || 'הוספת התזכורת נכשלה', 'error');
                    } finally {
                      setAddingReminder(false);
                    }
                  }}
                  className="w-full text-xs font-semibold py-1.5 rounded-lg text-white transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-primary, #1a5c2a)' }}
                >
                  {addingReminder ? 'שומר...' : 'הוסף תזכורת'}
                </button>
              </div>
            )}

            {reminders.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">אין תזכורות ל-24 שעות הקרובות</p>
            ) : (
              <div className="space-y-2">
                {reminders.slice(0, 4).map(r => (
                  <div key={r.id} className="flex items-start gap-2 p-2 rounded-lg"
                    style={{ background: '#111116' }}>
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: 'var(--color-accent, #c9a227)' }} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate" style={{ color: '#e8e8e4' }}>{r.title}</p>
                      <p className="text-xs" style={{ color: '#9aa0ab' }}>
                        {new Date(r.remind_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
                {reminders.length > 4 && (
                  <Link href="/reminders" className="text-xs font-medium block text-center pt-1"
                    style={{ color: 'var(--color-primary, #1a5c2a)' }}>
                    + עוד {reminders.length - 4} תזכורות
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Weekly Tasks */}
          <div className="rounded-2xl p-5 flex flex-col gap-3"
            style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--tag-bg, rgba(201,162,39,0.12))' }}>
                <CheckSquare className="w-4 h-4" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
              </div>
              <span className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>משימות לשבוע</span>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {weeklyTasks.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-2">אין משימות עדיין</p>
              )}
              {weeklyTasks.map(task => (
                <div key={task.id} className="flex items-center gap-2 group">
                  <button
                    onClick={async () => {
                      await weeklyTasksApi.toggle(task.id, !task.done);
                      setWeeklyTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: !t.done } : t));
                    }}
                    className="flex-shrink-0"
                  >
                    {task.done
                      ? <CheckSquare className="w-4 h-4" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
                      : <Square className="w-4 h-4 text-gray-300" />}
                  </button>
                  <span className={`flex-1 text-xs ${task.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                    {task.text}
                  </span>
                  <button
                    onClick={async () => {
                      await weeklyTasksApi.delete(task.id);
                      setWeeklyTasks(prev => prev.filter(t => t.id !== task.id));
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-3 h-3 text-red-400" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-1" style={{ borderTop: '1px solid #f0ede4' }}>
              <input
                type="text"
                value={newTask}
                onChange={e => setNewTask(e.target.value)}
                onKeyDown={async e => {
                  if (e.key === 'Enter' && newTask.trim()) {
                    const { data } = await weeklyTasksApi.create(newTask.trim());
                    setWeeklyTasks(prev => [...prev, data]);
                    setNewTask('');
                  }
                }}
                placeholder="הוסף משימה..."
                className="flex-1 text-xs px-2 py-1.5 rounded-lg outline-none"
                style={{ background: '#fdfcf8', border: '1px solid var(--card-border-color, #e8e0cc)' }}
              />
              <button
                onClick={async () => {
                  if (!newTask.trim()) return;
                  const { data } = await weeklyTasksApi.create(newTask.trim());
                  setWeeklyTasks(prev => [...prev, data]);
                  setNewTask('');
                }}
                className="px-2 py-1.5 rounded-lg flex-shrink-0"
                style={{ background: 'var(--color-primary, #1a5c2a)', color: 'white' }}
              >
                <Send className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Bottom: Quick Actions + Audit ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Quick actions */}
        <div className="rounded-2xl p-5"
          style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
          <h3 className="font-bold text-sm mb-4" style={{ color: '#e8e8e4' }}>פעולות מהירות</h3>
          <div className="space-y-1">
            {[
              { href: '/invoices',  icon: FileText, label: 'סרוק חשבונית',   accent: 'var(--color-primary, #1a5c2a)' },
              { href: '/inventory', icon: Package,  label: 'עדכן מלאי',      accent: '#065f46' },
              { href: '/employees', icon: Users,    label: 'נהל עובדים',     accent: '#4f46e5' },
              { href: '/ai',        icon: BarChart3,label: 'שאל את היועץ',   accent: '#a07d10' },
            ].map(({ href, icon: Icon, label, accent }) => (
              <Link key={href} href={href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all hover:scale-[1.01]"
                style={{ background: '#111116' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,162,39,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.background = '#111116')}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: accent + '18' }}>
                  <Icon className="w-4 h-4" style={{ color: accent }} />
                </div>
                <span className="text-sm font-medium" style={{ color: '#e8e8e4' }}>{label}</span>
                <span className="mr-auto text-xs" style={{ color: '#9aa0ab' }}>←</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Audit */}
        <div className="lg:col-span-2 rounded-2xl p-5"
          style={{ background: '#141418', border: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold text-sm" style={{ color: '#e8e8e4' }}>ציון ביקורת עסקית</h3>
            {audit && (
              <span className="text-2xl font-black" style={{ color: audit.score >= 70 ? 'var(--color-primary, #1a5c2a)' : '#d97706' }}>
                {audit.score}<span className="text-sm font-normal" style={{ color: '#9aa0ab' }}>/100</span>
              </span>
            )}
          </div>
          <p className="text-xs mb-5" style={{ color: '#6b7280' }}>
            {audit?.from_date && audit?.to_date
              ? `טווח: ${new Date(audit.from_date).toLocaleDateString('he-IL')} — ${new Date(audit.to_date).toLocaleDateString('he-IL')}`
              : ' '}
          </p>
          {audit ? (
            <>
              <div className="space-y-4">
                {[
                  { label: 'רווחיות', score: audit.score_profitability },
                  { label: 'מלאי',    score: audit.score_inventory },
                  { label: 'עובדים',  score: audit.score_employees },
                ].map(({ label, score }) => (
                  <div key={label}>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="font-medium" style={{ color: '#9aa0ab' }}>{label}</span>
                      <span className="font-bold" style={{ color: score >= 80 ? 'var(--color-primary, #1a5c2a)' : score >= 60 ? '#d97706' : '#dc2626' }}>
                        {score}/100
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: '#1a1a22' }}>
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${score}%`,
                          background: score >= 80
                            ? 'var(--progress-bar, linear-gradient(90deg,#1a5c2a,#2e7d32))'
                            : score >= 60
                            ? 'linear-gradient(90deg,#a07d10,var(--color-accent,#c9a227))'
                            : 'linear-gradient(90deg,#b91c1c,#ef4444)',
                        }} />
                    </div>
                  </div>
                ))}
              </div>
              {audit.recommendations.length > 0 && (
                <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--card-border-color, #e8e0cc)' }}>
                  <p className="text-xs font-semibold mb-1" style={{ color: '#9aa0ab' }}>המלצה עיקרית</p>
                  <p className="text-sm" style={{ color: '#b8bcc4' }}>{audit.recommendations[0].action}</p>
                </div>
              )}
              <Link href="/audit" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold"
                style={{ color: 'var(--color-primary, #1a5c2a)' }}>
                ראה דוח מלא ←
              </Link>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BarChart3 className="w-10 h-10 mb-3 text-gray-200" />
              <p className="text-sm text-gray-400">אין נתוני ביקורת עדיין</p>
            </div>
          )}
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}

// ── Deliveries Widget ────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; color: string; bg: string }> = {
  wolt:     { label: 'Wolt',        color: '#009DE0', bg: '#e0f8fd' },
  tenbis:   { label: 'תן ביס',      color: '#FF6600', bg: '#fff0e0' },
  sibuv:    { label: 'סיבוס',       color: '#7C3AED', bg: '#f0e8ff' },
  mislocha: { label: 'משלוחה',      color: '#E91E8C', bg: '#fde8f4' },
  self:     { label: 'שליח עצמי',  color: 'var(--color-primary, #1a5c2a)', bg: 'var(--tag-bg, #e8f5eb)' },
};

function DeliveryPlatformLogo({ id, size = 32 }: { id: string; size?: number }) {
  const r = size / 2;

  // Wolt — כחול עם "W" bold italic מעוצב
  if (id === 'wolt') return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="50" fill="#009DE0"/>
      <path d="M22 30 L34 70 L50 45 L66 70 L78 30" stroke="white" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );

  // תן ביס — כתום עם "10" גדול ו-"bis" קטן
  if (id === 'tenbis') return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <rect width="100" height="100" rx="20" fill="#FF6600"/>
      <text x="50" y="48" textAnchor="middle" fill="white" fontSize="38" fontWeight="900" fontFamily="Arial Black,Arial,sans-serif">10</text>
      <text x="50" y="72" textAnchor="middle" fill="white" fontSize="22" fontWeight="700" fontFamily="Arial,sans-serif" letterSpacing="2">bis</text>
    </svg>
  );

  // משלוחה — ורוד עם אייקון מנות
  if (id === 'mislocha') return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="50" fill="#E91E8C"/>
      <path d="M28 55 Q28 38 50 38 Q72 38 72 55 L72 62 Q72 65 68 65 L32 65 Q28 65 28 62 Z" fill="white" opacity="0.95"/>
      <rect x="22" y="63" width="56" height="7" rx="3.5" fill="white" opacity="0.7"/>
      <circle cx="36" cy="35" r="5" fill="white" opacity="0.8"/>
      <circle cx="50" cy="32" r="5" fill="white" opacity="0.8"/>
      <circle cx="64" cy="35" r="5" fill="white" opacity="0.8"/>
    </svg>
  );

  // סיבוס — סגול עם S מודרני
  if (id === 'sibuv') return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <rect width="100" height="100" rx="20" fill="#6B21A8"/>
      <path d="M62 38 Q62 28 50 28 Q38 28 38 38 Q38 48 62 50 Q62 60 62 62 Q62 72 50 72 Q38 72 38 62" stroke="white" strokeWidth="10" strokeLinecap="round" fill="none"/>
    </svg>
  );

  // שליח עצמי — ירוק עם אייקון אופנוע
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="50" fill="#1a5c2a"/>
      <circle cx="28" cy="65" r="10" stroke="white" strokeWidth="6" fill="none"/>
      <circle cx="72" cy="65" r="10" stroke="white" strokeWidth="6" fill="none"/>
      <path d="M38 65 L45 45 L62 45 L72 65" stroke="white" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M45 45 L55 30 L68 30 L65 45" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

const DeliveriesWidget = memo(function DeliveriesWidget({
  deliveries, showAdd, setShowAdd, newDelivery, setNewDelivery, onAdd, adding,
}: {
  deliveries: { totals: { total: number; revenue: number; active: number }; byPlatform: { platform: string; total: number; revenue: number; active: number }[] } | null;
  showAdd: boolean;
  setShowAdd: (v: boolean) => void;
  newDelivery: { platform: string; amount: string };
  setNewDelivery: (v: { platform: string; amount: string }) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Bike className="w-5 h-5" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
          <CardTitle>משלוחים היום</CardTitle>
        </div>
        <div className="flex items-center gap-3">
          {deliveries && (
            <span className="text-sm font-medium text-gray-500">
              {deliveries.totals.active > 0 && (
                <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-bold ml-2">
                  {deliveries.totals.active} פעיל כעת
                </span>
              )}
              סה"כ: {deliveries.totals.total} | {formatCurrency(deliveries.totals.revenue)}
            </span>
          )}
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: showAdd ? '#fee2e2' : '#f0fdf4', color: showAdd ? '#dc2626' : 'var(--color-primary, #1a5c2a)' }}
          >
            {showAdd ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            {showAdd ? 'ביטול' : 'הוסף משלוח'}
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Add delivery form */}
        {showAdd && (
          <div className="mb-4 p-4 rounded-xl flex gap-3 items-end flex-wrap" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.16)' }}>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">פלטפורמה</label>
              <select
                value={newDelivery.platform}
                onChange={e => setNewDelivery({ ...newDelivery, platform: e.target.value })}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none"
                style={{ minWidth: 120 }}
              >
                {Object.entries(PLATFORM_META).map(([key, { label }]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">סכום (₪)</label>
              <input
                type="number"
                placeholder="0.00"
                value={newDelivery.amount}
                onChange={e => setNewDelivery({ ...newDelivery, amount: e.target.value })}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none w-28"
              />
            </div>
            <button
              onClick={onAdd}
              disabled={adding}
              className="px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #c9a227, #d4af37)', color: 'var(--color-primary-dark, #0d3518)' }}
            >
              {adding ? '...' : 'הוסף'}
            </button>
          </div>
        )}

        {/* Platform breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(PLATFORM_META).map(([key, meta]) => {
            const p = deliveries?.byPlatform.find(x => x.platform === key);
            return (
              <div key={key} className="rounded-xl p-3 text-center flex flex-col items-center gap-1" style={{ background: meta.bg }}>
                <DeliveryPlatformLogo id={key} size={36} />
                <p className="text-xs font-bold" style={{ color: meta.color }}>{meta.label}</p>
                <p className="text-2xl font-black" style={{ color: meta.color }}>{p?.total || 0}</p>
                <p className="text-xs text-gray-500">{formatCurrency(p?.revenue || 0)}</p>
                {(p?.active || 0) > 0 && (
                  <span className="inline-block text-xs font-bold px-2 py-0.5 rounded-full bg-white" style={{ color: meta.color }}>
                    {p?.active} פעיל
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {!deliveries?.totals.total && (
          <p className="text-center text-sm text-gray-400 mt-4">אין משלוחים היום עדיין</p>
        )}
      </CardContent>
    </Card>
  );
});
