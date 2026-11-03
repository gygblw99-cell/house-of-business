'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api/client';
import { formatCurrency, formatNumber, getErrorMessage } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { daysAgoIL, startOfWeekIL, todayIL } from '@/lib/dates';
import {
  TrendingUp, Sparkles, RefreshCw, Calendar,
  ChevronUp, ChevronDown, AlertTriangle, CheckCircle, Target,
  FileText, Zap, BarChart3, CalendarRange, Trash2 } from 'lucide-react';

interface WeeklyAction {
  priority: 'high' | 'medium';
  title: string;
  action: string;
  expectedImpact: string;
}

interface WeeklyAdvice {
  actions: WeeklyAction[];
  weekScore: number;
  weekScoreLabel: string;
}

interface WeeklyReport {
  id: string;
  week_start: string;
  week_end: string;
  analysis: string;
  report_body: string;
  advice: WeeklyAdvice | string;
  raw_data: {
    sales: { revenue: number; transactions: number | null; avgTicket: number | null; revenueChange: string | null; prevRevenue: number };
    cogs:  {
      total: number; grossProfit: number; grossMargin: string; fixedExpenses: number; laborCost: number; wasteLoss: number; netProfit: number; netMargin: string;
      theoretical?: { isExtrapolated?: boolean; itemDataCoveragePct?: number };
    };
    topDishes: { name: string; qty: number; revenue: number }[];
    inventory: { low_stock: number; expiring_soon: number };
    labor:     { active_employees: number; total_hours: number; missed_shifts: number; labor_cost: number };
    reviews:   { avg_rating: number; review_count: number };
    dataAvailability?: {
      hasInvoices: boolean; hasLaborTracking: boolean; hasFixedExpenses: boolean;
      hasWasteTracking: boolean; hasZReports: boolean; hasTopDishes: boolean; hasReviews: boolean;
      // אמיתי מחשבוניות ספק, או הערכה אמינה מבוססת מתכון — ראה weeklyReportCrew.agent.js
      hasCostData?: boolean;
      hasTheoreticalFoodCost?: boolean;
      hasTheoreticalConfigError?: boolean;
      hasReliableTransactionCount?: boolean;
    };
  };
  created_at: string;
}

function parseAdvice(raw: WeeklyAdvice | string): WeeklyAdvice {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return { actions: [], weekScore: 50, weekScoreLabel: 'בינוני' }; }
  }
  return raw || { actions: [], weekScore: 50, weekScoreLabel: 'בינוני' };
}

function HebrewDatePicker({
  value, onChange, label, min, max, active,
}: {
  value: string; onChange: (v: string) => void; label: string;
  min?: string; max?: string; active?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const heDisplay = value
    ? new Date(value + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  return (
    <div className="flex-1 min-w-[150px]">
      <label className="block text-xs mb-1.5 font-medium" style={{ color: '#9aa0ab' }}>{label}</label>
      <div className="relative">
        <button
          type="button"
          onClick={() => inputRef.current?.showPicker?.() ?? inputRef.current?.click()}
          className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-right transition-all"
          style={{
            background: active ? 'rgba(var(--color-primary-rgb,201,162,39),0.12)' : 'rgba(255,255,255,0.04)',
            border: `1.5px solid ${active ? 'var(--color-primary)' : 'var(--glass-border)'}`,
            color: heDisplay ? '#e8e8e4' : '#6b7280',
          }}
        >
          <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: active ? 'var(--color-primary)' : '#6b7280' }} />
          <span className="flex-1 text-right">{heDisplay ?? 'בחר תאריך'}</span>
        </button>
        <input
          ref={inputRef}
          type="date"
          value={value}
          min={min}
          max={max}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 pointer-events-none w-full"
          tabIndex={-1}
        />
      </div>
    </div>
  );
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const color = score >= 75 ? '#16a34a' : score >= 55 ? '#c9a227' : '#dc2626';
  const r = 42, circ = 2 * Math.PI * r;
  const dash = circ * (score / 100);
  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={104} height={104} viewBox="0 0 104 104">
        <circle cx={52} cy={52} r={r} fill="none" stroke="#e5e7eb" strokeWidth={10} />
        <circle cx={52} cy={52} r={r} fill="none" stroke={color} strokeWidth={10}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 52 52)" />
        <text x={52} y={56} textAnchor="middle" fontSize={22} fontWeight="900" fill={color}>{score}</text>
      </svg>
      <span className="text-sm font-semibold" style={{ color }}>{label}</span>
    </div>
  );
}

export default function WeeklyReportPage() {
  const { confirm, toast } = useAppDialog();
  const [report, setReport]   = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError]     = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/ai/weekly-report');
      setReport(data.report);
    } catch { setError('שגיאה בטעינת הדוח'); }
    finally { setLoading(false); }
  };

  const handleDelete = async () => {
    if (!report?.id) return;
    if (!await confirm('האם למחוק את הדוח השבועי הזה?', 'מחיקת דוח')) return;
    setDeleting(true);
    try {
      await api.delete(`/ai/weekly-report/${report.id}`);
      setReport(null);
      toast('הדוח נמחק', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const body: Record<string, string> = {};
      if (dateFrom) body.dateFrom = dateFrom;
      if (dateTo)   body.dateTo   = dateTo;
      const { data } = await api.post('/ai/weekly-report/generate', body, { timeout: 150_000 });
      // Set directly from the response — do NOT re-fetch via load() here.
      // load() calls GET /ai/weekly-report, which returns whatever report
      // was most recently generated across ALL periods, not necessarily the
      // one just requested; re-fetching after every generate() was silently
      // overwriting the just-generated report with a stale one whenever the
      // user asked for a different date range than their last request.
      setReport({
        ...data,
        advice: data.advice, raw_data: data.data, report_body: data.reportBody, analysis: data.analysis,
        week_start: data.weekStart, week_end: data.weekEnd,
      });
    } catch (err) { setError(getErrorMessage(err) || 'שגיאה בהפקת הדוח'); }
    finally { setGenerating(false); }
  };

  // Track the current report id so the beforeunload handler can read it.
  const reportIdRef = useRef<string | null>(null);
  useEffect(() => { reportIdRef.current = report?.id ?? null; }, [report]);

  useEffect(() => { load(); }, []);

  // Auto-delete when the user exits the platform (closes tab / hard-navigates
  // to an external URL / refreshes). Does NOT fire on in-app navigation (Next.js
  // client-side routing never triggers beforeunload).
  // fetch with keepalive:true survives the page unload; cookies are sent automatically
  // so the Authorization header is populated from the stored session cookie.
  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api-proxy';
    const handleUnload = () => {
      const id = reportIdRef.current;
      if (!id) return;
      const token = document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1];
      fetch(`${apiBase}/ai/weekly-report/${id}`, {
        method: 'DELETE',
        keepalive: true,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  // SSE sync — distinguish delete events (just clear local state) from
  // generate events (re-fetch the new report). Without this check, a delete
  // event triggers load() which re-fetches the previous report from DB,
  // making it look like the delete didn't work.
  useSyncEvent(['weekly_report.updated'], (data: unknown) => {
    const action = (data as Record<string, unknown>)?.action;
    if (action === 'deleted') {
      setReport(null);
    } else {
      load();
    }
  });

  const advice = report ? parseAdvice(report.advice) : null;
  const d = report?.raw_data;

  const PRESETS = [
    { label: '7 ימים',  icon: '📅', days: 7 },
    { label: '14 ימים', icon: '📆', days: 14 },
    { label: 'חודש',    icon: '🗓️', days: 30 },
    { label: 'השבוע',   icon: '⚡', days: 0, thisWeek: true },
  ] as { label: string; icon: string; days: number; thisWeek?: boolean }[];

  const getActivePreset = () => {
    if (!dateFrom) return null;
    for (const p of PRESETS) {
      if (p.thisWeek) {
        if (dateFrom === startOfWeekIL()) return p.label;
      } else if (dateFrom === daysAgoIL(p.days)) {
        return p.label;
      }
    }
    return 'custom';
  };
  const activePreset = getActivePreset();

  return (
    <div className="space-y-5" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-6 h-6" style={{ color: 'var(--color-primary)' }} />
            דוח שבועי AI
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">4 סוכני AI מנתחים את העסק שלך בסוף כל שבוע</p>
        </div>
        {report && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'מוחק...' : 'מחק דוח'}
          </button>
        )}
      </div>

      {/* Date selector card */}
      <div className="rounded-2xl p-5"
        style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <div className="flex items-center gap-2 mb-4">
          <CalendarRange className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
          <span className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>בחר תקופה לדוח</span>
        </div>

        {/* Preset buttons */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {PRESETS.map(p => {
            const isActive = activePreset === p.label;
            return (
              <button
                key={p.label}
                onClick={() => {
                  if (p.thisWeek) {
                    setDateFrom(startOfWeekIL());
                  } else {
                    setDateFrom(daysAgoIL(p.days));
                  }
                  setDateTo(todayIL());
                }}
                className="flex flex-col items-center gap-1 py-3 rounded-xl text-sm font-semibold transition-all"
                style={{
                  background: isActive ? 'var(--color-primary)' : 'rgba(255,255,255,0.04)',
                  color:      isActive ? '#fff' : '#9aa0ab',
                  border:     `1.5px solid ${isActive ? 'var(--color-primary)' : 'var(--glass-border)'}`,
                  boxShadow:  isActive ? '0 2px 12px rgba(var(--color-primary-rgb,201,162,39),0.3)' : 'none',
                }}
              >
                <span className="text-base">{p.icon}</span>
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Custom range row */}
        <div className="flex flex-wrap items-end gap-3">
          <HebrewDatePicker
            label="מתאריך"
            value={dateFrom}
            max={dateTo || todayIL()}
            onChange={setDateFrom}
            active={activePreset === 'custom' && !!dateFrom}
          />
          <HebrewDatePicker
            label="עד תאריך"
            value={dateTo}
            min={dateFrom}
            max={todayIL()}
            onChange={setDateTo}
            active={activePreset === 'custom' && !!dateTo}
          />
          <div className="flex gap-2">
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(''); setDateTo(''); }}
                className="px-4 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid var(--glass-border)', color: '#9aa0ab' }}
              >
                נקה
              </button>
            )}
            <button
              onClick={generate}
              disabled={generating}
              className="flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-semibold text-white shadow-sm disabled:opacity-60 transition-all"
              style={{ background: 'var(--color-primary)' }}
            >
              <RefreshCw className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'מריץ סוכנים...' : dateFrom ? 'הפק לפי טווח' : 'הפק דוח עכשיו'}
            </button>
          </div>
        </div>

        {/* Selected range display */}
        {dateFrom && dateTo && (
          <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: '#9aa0ab' }}>
            <Calendar className="w-3.5 h-3.5" />
            <span>
              {new Date(dateFrom).toLocaleDateString('he-IL')} — {new Date(dateTo).toLocaleDateString('he-IL')}
              <span className="mx-1.5">·</span>
              {Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) + 1} ימים
            </span>
          </div>
        )}
      </div>

      {generating && (
        <div className="rounded-2xl p-6 text-center space-y-3"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex justify-center gap-6 text-sm">
            {['📊 סוכן נתונים', '🔍 סוכן ניתוח', '✍️ סוכן כתיבה', '🎯 סוכן אסטרטגיה'].map((a, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5 opacity-70 animate-pulse" style={{ animationDelay: `${i * 0.3}s` }}>
                <span className="text-2xl">{a.split(' ')[0]}</span>
                <span className="text-xs text-gray-500">{a.split(' ').slice(1).join(' ')}</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-gray-500">4 סוכנים עובדים בסדרה... עשוי לקחת כ-30 שניות</p>
        </div>
      )}

      {error && (
        <div className="rounded-xl p-4 bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

      {loading && !generating && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1,2,3].map(i => <div key={i} className="h-32 rounded-2xl animate-pulse" style={{ background: '#1a1a22' }} />)}
        </div>
      )}

      {!loading && !report && !generating && (
        <div className="rounded-2xl p-12 text-center"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-gray-500 mb-4">אין דוח שבועי עדיין</p>
          <button onClick={generate}
            className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--color-primary)' }}>
            הפק דוח ראשון
          </button>
        </div>
      )}

      {report && d && !loading && (
        <>
          {/* Period & Score */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            <div className="rounded-2xl p-5 flex items-center gap-4 relative"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <button
                onClick={handleDelete}
                disabled={deleting}
                title="מחק דוח"
                className="absolute top-3 left-3 p-1.5 rounded-lg transition-colors disabled:opacity-50"
                style={{ color: '#f87171' }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <Calendar className="w-8 h-8 flex-shrink-0" style={{ color: 'var(--color-primary)' }} />
              <div>
                <p className="text-xs" style={{ color: '#9aa0ab' }}>תקופה</p>
                <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>
                  {new Date(report.week_start).toLocaleDateString('he-IL')} – {new Date(report.week_end).toLocaleDateString('he-IL')}
                </p>
                <p className="text-xs" style={{ color: '#9aa0ab' }}>הופק {new Date(report.created_at).toLocaleString('he-IL', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</p>
              </div>
            </div>

            {/* KPIs */}
            {(() => {
              const da = d.dataAvailability;
              // Older stored reports may not have dataAvailability — default to "available"
              // so we don't hide numbers that were genuinely real when computed.
              // hasCostData = real supplier invoices OR a reliable recipe-based estimate
              // (see weeklyReportCrew.agent.js) — using hasInvoices alone here used to hide
              // real, correctly-computed numbers whenever the business had no invoices.
              const hasCostData = da ? (da.hasCostData ?? da.hasInvoices) : true;
              const hasGross = hasCostData;
              const hasNet   = hasCostData && (da ? da.hasFixedExpenses && da.hasLaborTracking : true);
              const isEstimated = !!d.cogs.theoretical?.isExtrapolated;
              return [
                { label: 'הכנסות', value: formatCurrency(d.sales.revenue), change: d.sales.revenueChange, sub: '', icon: TrendingUp, available: true, unavailableNote: '' },
                { label: 'רווח גולמי', value: formatCurrency(d.cogs.grossProfit), sub: `${d.cogs.grossMargin}% מרווח גולמי${isEstimated ? ' · הערכה' : ''}`, icon: BarChart3, available: hasGross, unavailableNote: 'אין נתוני עלות סחורה (לא חשבוניות ולא עלויות מתכון) לתקופה זו' },
                { label: 'רווח נקי', value: formatCurrency(d.cogs.netProfit ?? d.cogs.grossProfit), sub: `${d.cogs.netMargin ?? d.cogs.grossMargin}% מרווח נקי${isEstimated ? ' · הערכה' : ''}`, netProfit: true, icon: Zap, available: hasNet, unavailableNote: 'חסרים נתוני עלות סחורה / הוצאות / שכר' },
              ];
            })().map((kpi) => {
              const change = kpi.change ? Number(kpi.change) : null;
              const netVal = kpi.netProfit ? (d.cogs.netProfit ?? 0) : null;
              const netColor = netVal !== null ? (netVal >= 0 ? '#16a34a' : '#dc2626') : '#e8e8e4';
              if (!kpi.available) {
                return (
                  <div key={kpi.label} className="rounded-2xl p-5"
                    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
                    <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>{kpi.label}</p>
                    <p className="text-sm font-bold" style={{ color: '#6b7280' }}>אין מספיק נתונים</p>
                    <p className="text-xs mt-1" style={{ color: '#6b7280' }}>{kpi.unavailableNote}</p>
                  </div>
                );
              }
              return (
                <div key={kpi.label} className="rounded-2xl p-5"
                  style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
                  <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>{kpi.label}</p>
                  <p className="text-xl font-black" style={{ color: netVal !== null ? netColor : '#e8e8e4' }}>{kpi.value}</p>
                  {change !== null ? (
                    <span className={`flex items-center gap-0.5 text-xs font-semibold mt-1 ${change >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {change >= 0 ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {Math.abs(change)}% לעומת תקופה קודמת
                    </span>
                  ) : null}
                  {kpi.sub && <p className="text-xs mt-1" style={{ color: '#9aa0ab' }}>{kpi.sub}</p>}
                </div>
              );
            })}
          </div>

          {/* Cost breakdown — matches finance module */}
          {(d.cogs.fixedExpenses !== undefined) && (
            <div className="rounded-2xl p-4"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <p className="text-xs font-semibold mb-3" style={{ color: '#9aa0ab' }}>פירוט עלויות (זהה למודול פיננסים)</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'עלות סחורה', value: d.cogs.total, color: '#f59e0b', available: d.dataAvailability ? (d.dataAvailability.hasCostData ?? d.dataAvailability.hasInvoices) : true },
                  { label: 'הוצאות קבועות', value: d.cogs.fixedExpenses, color: '#8b5cf6', available: d.dataAvailability ? d.dataAvailability.hasFixedExpenses : true },
                  { label: 'עלות שכר', value: d.cogs.laborCost, color: '#3b82f6', available: d.dataAvailability ? d.dataAvailability.hasLaborTracking : true },
                  { label: 'בזבוז מלאי', value: d.cogs.wasteLoss, color: '#ef4444', available: d.dataAvailability ? d.dataAvailability.hasWasteTracking : true },
                ].map(item => (
                  <div key={item.label} className="rounded-xl p-3 text-center"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)' }}>
                    <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>{item.label}</p>
                    {item.available ? (
                      <>
                        <p className="text-sm font-bold" style={{ color: item.color }}>{formatCurrency(item.value)}</p>
                        {d.sales.revenue > 0 && (
                          <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                            {((item.value / d.sales.revenue) * 100).toFixed(1)}%
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs font-medium" style={{ color: '#6b7280' }}>לא הוזן</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Score + Report Body */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Score */}
            {advice && (
              <div className="rounded-2xl p-6 flex flex-col items-center justify-center gap-3"
                style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
                <p className="text-sm font-semibold" style={{ color: '#9aa0ab' }}>ציון השבוע</p>
                <ScoreRing score={advice?.weekScore ?? 50} label={advice?.weekScoreLabel ?? 'בינוני'} />
              </div>
            )}

            {/* Report Body */}
            <div className="lg:col-span-2 rounded-2xl p-6"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <div className="flex items-center gap-2 mb-4">
                <FileText className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
                <h2 className="font-bold" style={{ color: '#e8e8e4' }}>סיכום מנהלים</h2>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--tag-bg)', color: 'var(--color-primary)' }}>AI</span>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: '#b8bcc4' }}>{report.report_body}</p>
            </div>
          </div>

          {/* Actions */}
          {(advice?.actions?.length ?? 0) > 0 && (
            <div className="rounded-2xl p-6"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
                <h2 className="font-bold text-gray-800">3 פעולות לשבוע הבא</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(advice?.actions ?? []).map((action, i) => (
                  <div key={i} className="rounded-xl p-4 border-r-4"
                    style={{
                      background: 'rgba(20,20,28,0.8)',
                      borderRightColor: action.priority === 'high' ? '#dc2626' : 'var(--color-accent, #c9a227)',
                      border: '1px solid var(--card-border-color)',
                      borderRight: `4px solid ${action.priority === 'high' ? '#dc2626' : 'var(--color-accent, #c9a227)'}`,
                    }}>
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                        style={{ background: action.priority === 'high' ? '#fef2f2' : '#fffbeb', color: action.priority === 'high' ? '#dc2626' : '#92400e' }}>
                        {action.priority === 'high' ? '🔴 דחוף' : '🟡 חשוב'}
                      </span>
                      <span className="text-lg">{i === 0 ? '1️⃣' : i === 1 ? '2️⃣' : '3️⃣'}</span>
                    </div>
                    <p className="font-bold text-sm mb-1" style={{ color: '#e8e8e4' }}>{action.title}</p>
                    <p className="text-xs mb-2" style={{ color: '#9aa0ab' }}>{action.action}</p>
                    <p className="text-xs text-green-600 font-medium">📈 {action.expectedImpact}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom row: Top dishes + alerts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top dishes */}
            <div className="rounded-2xl p-5"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <h3 className="font-bold mb-3 flex items-center gap-2" style={{ color: '#e8e8e4' }}>
                <span>🍽️</span> מנות מובילות השבוע
              </h3>
              <div className="space-y-2">
                {d.topDishes.length > 0 ? d.topDishes.map((dish, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-4" style={{ color: '#9aa0ab' }}>{i + 1}</span>
                      <span style={{ color: '#b8bcc4' }}>{dish.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs" style={{ color: '#9aa0ab' }}>{formatNumber(dish.qty)} מנות</span>
                      <span className="font-semibold" style={{ color: '#e8e8e4' }}>{formatCurrency(dish.revenue)}</span>
                    </div>
                  </div>
                )) : <p className="text-sm text-gray-400">אין נתוני מכירות</p>}
              </div>
            </div>

            {/* Alerts */}
            <div className="rounded-2xl p-5"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <h3 className="font-bold mb-3 flex items-center gap-2" style={{ color: '#e8e8e4' }}>
                <span>⚠️</span> התראות
              </h3>
              <div className="space-y-2">
                {d.inventory.low_stock > 0 ? (
                  <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg p-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>{d.inventory.low_stock} פריטי מלאי מתחת למינימום</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg p-2">
                    <CheckCircle className="w-4 h-4" />
                    <span>כל המלאי תקין</span>
                  </div>
                )}
                {d.inventory.expiring_soon > 0 && (
                  <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>{d.inventory.expiring_soon} פריטים בסכנת תפוגה תוך 3 ימים</span>
                  </div>
                )}
                {d.labor.missed_shifts > 0 && (
                  <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>{d.labor.missed_shifts} משמרות שהוחמצו</span>
                  </div>
                )}
                {d.reviews.review_count > 0 && (
                  <div className="flex items-center gap-2 text-sm rounded-lg p-2" style={{ color: '#9aa0ab', background: '#1a1a22' }}>
                    <span>⭐</span>
                    <span>{d.reviews.avg_rating.toFixed(1)}/5 ממוצע ביקורות ({formatNumber(d.reviews.review_count)})</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm rounded-lg p-2" style={{ color: '#9aa0ab', background: '#1a1a22' }}>
                  <span>👥</span>
                  <span>{formatNumber(d.labor.active_employees)} עובדים · {formatNumber(d.labor.total_hours, 1)} שעות השבוע</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
