'use client';
import { adminFetch } from '@/lib/adminClient';
import { Fragment, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import {
  FileText, AlertTriangle, CheckCircle, RefreshCw, ChevronDown, ChevronUp,
  Building2, TrendingUp, Users, Utensils, AlertCircle, Info,
} from 'lucide-react';


const DARK = {
  card:    '#141418',
  row:     '#0d0d12',
  border:  'rgba(201,162,39,0.14)',
  text:    '#e8e8e4',
  muted:   '#9aa0ab',
  gold:    '#c9a227',
} as const;

interface Alert { level: 'critical' | 'warning' | 'info'; msg: string; }

interface ZReportDetail {
  pos_sale_id: string;
  report_date: string;
  total_amount: number;
  cash_amount: number;
  credit_amount: number;
  wolt_amount: number;
  ten_bis_amount: number;
  items_count: number;
  shifts_count: number;
  completeness: number;
}

interface BusinessQuality {
  business_id: string;
  business_name: string;
  zreports_count: number;
  total_revenue: number;
  has_revenue: boolean;
  has_items: boolean;
  has_shifts: boolean;
  shifts_count: number;
  matched_employees: number;
  last_report_date: string | null;
  completeness_score: number;
  alerts: Alert[];
  reports: ZReportDetail[];
}

interface QualityData {
  businesses: BusinessQuality[];
  days: number;
  generated_at: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';
  const bg    = score >= 80 ? 'rgba(34,197,94,0.15)' : score >= 50 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)';
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold"
      style={{ background: bg, color }}
    >
      {score}%
    </span>
  );
}

function AlertBadge({ alert }: { alert: Alert }) {
  const cfg = {
    critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.15)',  Icon: AlertTriangle },
    warning:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', Icon: AlertCircle },
    info:     { color: '#60a5fa', bg: 'rgba(96,165,250,0.15)', Icon: Info },
  }[alert.level];
  const { Icon } = cfg;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-medium"
      style={{ background: cfg.bg, color: cfg.color }}
    >
      <Icon className="w-3 h-3 flex-shrink-0" />
      {alert.msg}
    </span>
  );
}

function CheckIcon({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle className="w-4 h-4 text-green-500" />
    : <AlertTriangle className="w-4 h-4 text-amber-400" />;
}

export default function AdminZReportsPage() {
  const router = useRouter();
  const [data, setData]       = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [days, setDays]       = useState(180);
  const [expanded, setExpanded] = useState<string | null>(null);

  const beginRequest = useLatestRequest();

  const load = useCallback(async () => {
    const latest = beginRequest();
    setLoading(true);
    setError(false);
    try {
      const r = await adminFetch(`/admin/zreport-quality?days=${days}`);
      if (r.status === 401 || r.status === 403) { router.replace('/admin/login'); return; }
      if (r.ok) { const json = await r.json(); latest(() => setData(json)); }
      else latest(() => setError(true));
    } catch {
      latest(() => setError(true));
    } finally {
      latest(() => setLoading(false));
    }
  }, [days, router, beginRequest]);

  useEffect(() => { load(); }, [load]);

  const criticalCount = data?.businesses.filter(b => b.alerts.some(a => a.level === 'critical')).length ?? 0;
  const warningCount  = data?.businesses.filter(b => b.alerts.some(a => a.level === 'warning') && !b.alerts.some(a => a.level === 'critical')).length ?? 0;
  const okCount       = data?.businesses.filter(b => b.alerts.length === 0).length ?? 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black" style={{ color: DARK.text }}>מעקב דוחות</h1>
          <p className="text-sm mt-0.5" style={{ color: DARK.muted }}>
            ביקורת איכות ייבוא דוחות — {days} ימים אחרונים
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="text-sm rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
            style={{ background: DARK.card, color: DARK.text, border: `1px solid ${DARK.border}` }}
          >
            <option value={7}>7 ימים</option>
            <option value={30}>30 ימים</option>
            <option value={60}>60 ימים</option>
            <option value={90}>90 ימים</option>
            <option value={180}>6 חודשים</option>
            <option value={365}>שנה</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            style={{ background: 'rgba(201,162,39,0.12)', color: DARK.gold, border: `1px solid rgba(201,162,39,0.25)` }}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            רענן
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl p-5" style={{ background: DARK.card, border: `1px solid ${DARK.border}` }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.12)' }}>
              <AlertTriangle className="w-4 h-4 text-red-500" />
            </div>
            <p className="text-sm" style={{ color: DARK.muted }}>חסר קריטי</p>
          </div>
          <p className="text-3xl font-black text-red-500">{criticalCount}</p>
          <p className="text-xs mt-0.5" style={{ color: DARK.muted }}>עסקים ללא הכנסות בדוח</p>
        </div>
        <div className="rounded-2xl p-5" style={{ background: DARK.card, border: `1px solid ${DARK.border}` }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.12)' }}>
              <AlertCircle className="w-4 h-4 text-amber-500" />
            </div>
            <p className="text-sm" style={{ color: DARK.muted }}>נתונים חסרים</p>
          </div>
          <p className="text-3xl font-black text-amber-500">{warningCount}</p>
          <p className="text-xs mt-0.5" style={{ color: DARK.muted }}>עסקים חסרי משמרות/מנות</p>
        </div>
        <div className="rounded-2xl p-5" style={{ background: DARK.card, border: `1px solid ${DARK.border}` }}>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.12)' }}>
              <CheckCircle className="w-4 h-4 text-green-500" />
            </div>
            <p className="text-sm" style={{ color: DARK.muted }}>מלא</p>
          </div>
          <p className="text-3xl font-black text-green-500">{okCount}</p>
          <p className="text-xs mt-0.5" style={{ color: DARK.muted }}>עסקים עם כל הנתונים</p>
        </div>
      </div>

      {/* Table */}
      {loading && !data ? (
        <div className="rounded-2xl p-12 flex items-center justify-center" style={{ background: DARK.card, border: `1px solid ${DARK.border}` }}>
          <RefreshCw className="w-6 h-6 animate-spin" style={{ color: DARK.muted }} />
        </div>
      ) : error ? (
        <div className="rounded-2xl p-12 text-center" style={{ background: DARK.card, border: `1px solid ${DARK.border}`, color: '#f87171' }}>
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-70" />
          <p>שגיאה בטעינת נתוני דוחות — נסה שוב</p>
          <button onClick={load} className="mt-3 text-sm underline" style={{ color: DARK.muted }}>רענן</button>
        </div>
      ) : !data?.businesses.length ? (
        <div className="rounded-2xl p-12 text-center" style={{ background: DARK.card, border: `1px solid ${DARK.border}`, color: DARK.muted }}>
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>לא נמצאו דוחות ב-{days} הימים האחרונים</p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: DARK.card, border: `1px solid ${DARK.border}` }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: DARK.row, borderBottom: `1px solid ${DARK.border}` }}>
                <th className="text-right px-4 py-3 font-semibold" style={{ color: DARK.muted }}>עסק</th>
                <th className="text-center px-4 py-3 font-semibold" style={{ color: DARK.muted }}>דוחות</th>
                <th className="text-center px-4 py-3 font-semibold w-10" title="הכנסות" style={{ color: DARK.muted }}><TrendingUp className="w-4 h-4 mx-auto" /></th>
                <th className="text-center px-4 py-3 font-semibold w-10" title="עובדים" style={{ color: DARK.muted }}><Users className="w-4 h-4 mx-auto" /></th>
                <th className="text-center px-4 py-3 font-semibold w-10" title="מנות" style={{ color: DARK.muted }}><Utensils className="w-4 h-4 mx-auto" /></th>
                <th className="text-center px-4 py-3 font-semibold" style={{ color: DARK.muted }}>ציון</th>
                <th className="text-right px-4 py-3 font-semibold" style={{ color: DARK.muted }}>התראות</th>
                <th className="text-center px-4 py-3 font-semibold" style={{ color: DARK.muted }}>דוח אחרון</th>
                <th className="px-4 py-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {data.businesses.map((b) => {
                const isExpanded = expanded === b.business_id;
                const rowBg = b.alerts.some(a => a.level === 'critical')
                  ? 'rgba(239,68,68,0.06)'
                  : b.alerts.some(a => a.level === 'warning')
                  ? 'rgba(245,158,11,0.05)'
                  : 'transparent';
                return (
                  <Fragment key={b.business_id}>
                    <tr
                      style={{ background: rowBg, borderBottom: `1px solid rgba(201,162,39,0.07)`, cursor: 'pointer' }}
                      onClick={() => setExpanded(isExpanded ? null : b.business_id)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-4 h-4 flex-shrink-0" style={{ color: DARK.muted }} />
                          <span className="font-medium" style={{ color: DARK.text }}>{b.business_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center font-bold" style={{ color: DARK.text }}>{b.zreports_count}</td>
                      <td className="px-4 py-3 text-center"><CheckIcon ok={b.has_revenue} /></td>
                      <td className="px-4 py-3 text-center"><CheckIcon ok={b.has_shifts} /></td>
                      <td className="px-4 py-3 text-center"><CheckIcon ok={b.has_items} /></td>
                      <td className="px-4 py-3 text-center"><ScoreBadge score={b.completeness_score} /></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {b.alerts.length === 0
                            ? <span className="text-xs text-green-500 font-medium">✓ הכל תקין</span>
                            : b.alerts.map((a, i) => <AlertBadge key={i} alert={a} />)
                          }
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center text-sm" style={{ color: DARK.muted }}>{fmtDate(b.last_report_date)}</td>
                      <td className="px-4 py-3 text-center">
                        {isExpanded
                          ? <ChevronUp className="w-4 h-4 mx-auto" style={{ color: DARK.muted }} />
                          : <ChevronDown className="w-4 h-4 mx-auto" style={{ color: DARK.muted }} />
                        }
                      </td>
                    </tr>

                    {/* Expanded detail rows */}
                    {isExpanded && (
                      <tr key={`${b.business_id}-detail`} style={{ background: DARK.row, borderBottom: `2px solid ${DARK.border}` }}>
                        <td colSpan={10} className="px-6 py-4">
                          <div className="space-y-3">
                            {/* Business summary */}
                            <div className="flex items-center gap-6 text-xs" style={{ color: DARK.muted }}>
                              <span>סה&quot;כ הכנסות: <strong style={{ color: DARK.text }}>{fmt(b.total_revenue)}</strong></span>
                              <span>משמרות: <strong style={{ color: DARK.text }}>{b.shifts_count}</strong></span>
                              <span>עובדים שזוהו: <strong style={{ color: DARK.text }}>{b.matched_employees}</strong></span>
                            </div>

                            {/* Per-report table */}
                            <div className="overflow-x-auto rounded-xl" style={{ border: `1px solid rgba(201,162,39,0.12)` }}>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr style={{ background: '#0a0a0e', borderBottom: `1px solid rgba(201,162,39,0.12)` }}>
                                    <th className="text-right px-3 py-2 font-semibold" style={{ color: DARK.muted }}>מספר Z</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>תאריך</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>סה&quot;כ</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>מזומן</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>אשראי</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>וולט</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>תן-ביס</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>מנות</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>משמרות</th>
                                    <th className="text-center px-3 py-2 font-semibold" style={{ color: DARK.muted }}>ציון</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {b.reports.map(r => (
                                    <tr
                                      key={r.pos_sale_id}
                                      style={{
                                        borderTop: `1px solid rgba(201,162,39,0.07)`,
                                        background: r.completeness < 40 ? 'rgba(239,68,68,0.06)' : 'transparent',
                                      }}
                                    >
                                      <td className="px-3 py-2 font-mono font-bold" style={{ color: DARK.gold }}>{r.pos_sale_id}</td>
                                      <td className="px-3 py-2 text-center" style={{ color: DARK.muted }}>{fmtDate(r.report_date)}</td>
                                      <td className="px-3 py-2 text-center font-medium" style={{ color: DARK.text }}>{r.total_amount > 0 ? fmt(r.total_amount) : <span className="text-red-400">חסר</span>}</td>
                                      <td className="px-3 py-2 text-center" style={{ color: DARK.muted }}>{r.cash_amount > 0 ? fmt(r.cash_amount) : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center" style={{ color: DARK.muted }}>{r.credit_amount > 0 ? fmt(r.credit_amount) : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center" style={{ color: DARK.muted }}>{r.wolt_amount > 0 ? fmt(r.wolt_amount) : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center" style={{ color: DARK.muted }}>{r.ten_bis_amount > 0 ? fmt(r.ten_bis_amount) : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center">{r.items_count > 0 ? <span className="text-green-500 font-medium">{r.items_count}</span> : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center">{r.shifts_count > 0 ? <span className="text-blue-400 font-medium">{r.shifts_count}</span> : <span style={{ color: 'rgba(228,228,228,0.18)' }}>—</span>}</td>
                                      <td className="px-3 py-2 text-center"><ScoreBadge score={r.completeness} /></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <p className="text-xs text-left" style={{ color: DARK.muted }}>
          עודכן: {new Date(data.generated_at).toLocaleString('he-IL')}
        </p>
      )}
    </div>
  );
}
