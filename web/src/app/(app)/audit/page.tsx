'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMounted } from '@/hooks/useMounted';
import { useSyncEvent } from '@/context/SyncContext';
import { RefreshCw, CheckCircle, AlertTriangle, XCircle, Calendar, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { auditApi } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { DateRangePicker } from '@/components/ui/DatePicker';
import { daysAgoIL, todayIL } from '@/lib/dates';

interface AuditIssue {
  type: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
}

interface AuditRec {
  priority?: number;
  type?: string;
  action: string;
  impact?: string;
}

interface AuditData {
  score: number;
  score_profitability: number;
  score_inventory: number;
  score_employees: number;
  score_avg_order: number;
  issues: AuditIssue[];
  recommendations: AuditRec[];
  created_at: string;
  from_date?: string | null;
  to_date?: string | null;
}

const severityConfig = {
  high:   { icon: XCircle,       color: 'text-red-600',   bg: 'bg-red-50',   label: 'גבוהה' },
  medium: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50', label: 'בינונית' },
  low:    { icon: CheckCircle,   color: 'text-green-600', bg: 'bg-green-50', label: 'נמוכה' },
};

const typeLabels: Record<string, string> = {
  profitability: 'רווחיות',
  inventory:     'מלאי',
  employees:     'עובדים',
  avg_order:     'ממוצע הזמנה לסועד',
};

function todayStr() {
  return todayIL();
}

function daysAgoStr(days: number) {
  return daysAgoIL(days);
}

function parseJson(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return [];
}

function normalize(data: Record<string, unknown>): AuditData {
  const scores = data.scores as Record<string, number> | undefined;
  if (scores) {
    return {
      score:               scores.total,
      score_profitability: scores.profitability,
      score_inventory:     scores.inventory,
      score_employees:     scores.employees,
      score_avg_order:     scores.avgOrder,
      issues:              parseJson(data.issues)          as AuditIssue[],
      recommendations:     parseJson(data.recommendations) as AuditRec[],
      created_at:          (data.createdAt as string) ?? new Date().toISOString(),
      from_date:           (data.fromDate as string) ?? null,
      to_date:             (data.toDate   as string) ?? null,
    };
  }
  return {
    score:               data.score as number,
    score_profitability: data.score_profitability as number,
    score_inventory:     data.score_inventory as number,
    score_employees:     data.score_employees as number,
    score_avg_order:     data.score_avg_order as number,
    issues:              parseJson(data.issues)          as AuditIssue[],
    recommendations:     parseJson(data.recommendations) as AuditRec[],
    created_at:          data.created_at as string,
    from_date:           (data.from_date as string) ?? null,
    to_date:             (data.to_date   as string) ?? null,
  };
}

const PRESETS = [
  { label: '7 ימים',  days: 7  },
  { label: '30 ימים', days: 30 },
  { label: '90 ימים', days: 90 },
];

export default function AuditPage() {
  const isMounted = useMounted();
  const [report,   setReport]   = useState<AuditData | null>(null);
  const reportRef = useRef<AuditData | null>(null);
  useEffect(() => { reportRef.current = report; }, [report]);
  const [loading,  setLoading]  = useState(true);
  const [running,  setRunning]  = useState(false);
  const [error,    setError]    = useState('');
  const [noData,   setNoData]   = useState(false);
  const [fresh,    setFresh]    = useState(false);
  const [fromDate, setFromDate] = useState(() => daysAgoStr(30));
  const [toDate,   setToDate]   = useState(() => todayStr());
  const [trend, setTrend] = useState<{ trend: number | null; trendCount: number; change: number | null; direction: 'up' | 'down' | 'same' | null } | null>(null);

  const loadLatest = useCallback(() => {
    auditApi.latest().then(({ data }) => {
      if (!isMounted()) return;
      if (data.hasData) { setReport(normalize(data)); setError(''); }
      setLoading(false);
    }).catch(() => {
      if (!isMounted()) return;
      setLoading(false);
      // Only surface this if we don't already have a report on screen —
      // otherwise a transient refetch failure would blank out real, already-
      // displayed data behind an error banner. Reads via ref (not `report`
      // state) so this callback's identity stays stable and doesn't re-fire
      // the mount effect / sync-event subscription on every successful load.
      if (!reportRef.current) setError('שגיאה בטעינת הביקורת האחרונה — נסה לרענן');
    });
    auditApi.score().then(({ data }) => {
      if (!isMounted()) return;
      if (data.hasData) setTrend(data);
    }).catch(() => {});
  }, [isMounted]);

  useEffect(() => { loadLatest(); }, [loadLatest]);
  // ביקורת שהורצה בטאב/מכשיר אחר תופיע גם כאן — עקביות בין מכשירים
  useSyncEvent(['audit.updated'], loadLatest);

  const runAudit = async () => {
    setRunning(true);
    setError('');
    setNoData(false);
    setFresh(false);
    setReport(null); // clear old report so stale data is never shown during/after new run
    try {
      const { data } = await auditApi.run({ fromDate, toDate });
      if (data.hasData) {
        setReport(normalize(data));
        setFresh(true);
        setTimeout(() => setFresh(false), 8000);
      } else {
        setNoData(true);
      }
    } catch {
      setError('שגיאה בהפקת הביקורת — בדוק שהשרת פעיל ונסה שנית');
    }
    setRunning(false);
  };

  const scoreColor = (s: number) =>
    s >= 80 ? 'text-green-600' : s >= 60 ? 'text-amber-600' : 'text-red-600';
  const scoreBg = (s: number) =>
    s >= 80 ? 'bg-green-500' : s >= 60 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ביקורת עסקית</h1>
          {report && (
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <p className="text-sm text-gray-500">הופק: {formatDateTime(report.created_at)}</p>
              {report.from_date && report.to_date && (
                <span className="text-xs bg-violet-100 text-violet-700 font-semibold px-2.5 py-0.5 rounded-full">
                  {report.from_date} → {report.to_date}
                </span>
              )}
              {fresh && (
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-2.5 py-0.5 rounded-full animate-pulse">
                  ✓ תוצאות עדכניות
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Date range picker */}
      <Card>
        <CardContent className="pt-5 pb-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Calendar className="w-4 h-4 text-violet-600" />
              טווח תאריכים
            </div>

            <div className="flex gap-2 flex-wrap">
              {PRESETS.map(p => (
                <button
                  key={p.days}
                  onClick={() => { setFromDate(daysAgoStr(p.days)); setToDate(todayStr()); }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 transition-colors font-medium"
                >
                  {p.label} אחרונים
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 flex-wrap mr-auto">
              <DateRangePicker
                from={fromDate} to={toDate}
                onFromChange={setFromDate}
                onToChange={v => setToDate(v > todayStr() ? todayStr() : v)}
              />
              <Button onClick={runAudit} loading={running}>
                <RefreshCw className="w-4 h-4" />
                הרץ ביקורת
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl p-4 bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

      {noData && (
        <div className="rounded-xl p-4 bg-blue-50 border border-blue-200 text-blue-700 text-sm">
          אין מספיק נתוני מכירות בטווח שנבחר — יש להעלות דוחות לפחות 7 ימים כדי להפיק ביקורת.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">טוען...</div>
      ) : !report ? (
        <div className="text-center py-12">
          <p className="text-gray-500">בחר טווח תאריכים ולחץ "הרץ ביקורת"</p>
        </div>
      ) : (
        <>
          {/* Scores */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-8 flex-wrap">
                <div className="text-center min-w-24">
                  <div className={`text-5xl font-bold ${scoreColor(report.score)}`}>
                    {report.score}
                  </div>
                  <div className="text-gray-500 text-sm mt-1">ציון כולל</div>
                  <div className="text-xs text-gray-400">/ 100</div>
                  {trend && trend.trend !== null && (
                    <div
                      className="flex items-center justify-center gap-1 mt-2 text-xs font-semibold"
                      title={`ממוצע ${trend.trendCount} הביקורות הקודמות: ${trend.trend}`}
                      style={{ color: trend.direction === 'up' ? '#16a34a' : trend.direction === 'down' ? '#dc2626' : '#9ca3af' }}
                    >
                      {trend.direction === 'up' && <TrendingUp className="w-3.5 h-3.5" />}
                      {trend.direction === 'down' && <TrendingDown className="w-3.5 h-3.5" />}
                      {trend.direction === 'same' && <Minus className="w-3.5 h-3.5" />}
                      {trend.change !== null && trend.change !== 0 ? `${trend.change > 0 ? '+' : ''}${trend.change} ` : ''}
                      מול ממוצע {trend.trendCount} אחרונות
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-64 space-y-3">
                  {([
                    { label: 'רווחיות',      score: report.score_profitability },
                    { label: 'ניהול מלאי',  score: report.score_inventory },
                    { label: 'עובדים',      score: report.score_employees },
                    { label: 'ממוצע הזמנה לסועד', score: report.score_avg_order },
                  ] as { label: string; score: number }[]).map(({ label, score }) => (
                    <div key={label}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-600">{label}</span>
                        <span className={`font-semibold ${scoreColor(score)}`}>{score}/100</span>
                      </div>
                      <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${scoreBg(score)}`}
                          style={{ width: `${score}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Issues */}
          {report.issues.length > 0 && (
            <Card>
              <CardHeader><CardTitle>בעיות שזוהו</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {report.issues.map((issue, i) => {
                  const cfg  = severityConfig[issue.severity] ?? severityConfig.medium;
                  const Icon = cfg.icon;
                  return (
                    <div key={i} className={`flex gap-3 p-4 rounded-xl ${cfg.bg}`}>
                      <Icon className={`w-5 h-5 ${cfg.color} flex-shrink-0 mt-0.5`} />
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <p className="text-sm font-semibold text-gray-800">{issue.title}</p>
                          <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                          {issue.type && (
                            <span className="text-xs text-gray-400">{typeLabels[issue.type] ?? issue.type}</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-600">{issue.description}</p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Recommendations */}
          {report.recommendations.length > 0 && (
            <Card>
              <CardHeader><CardTitle>המלצות לשיפור</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {report.recommendations.map((rec, i) => (
                  <div key={i} className="flex gap-3 p-4 rounded-xl bg-violet-50 border border-violet-100">
                    <div className="w-7 h-7 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-800 mb-1">{rec.action}</p>
                      {rec.impact && (
                        <p className="text-sm text-violet-700 font-medium">השפעה צפויה: {rec.impact}</p>
                      )}
                      {rec.type && (
                        <p className="text-xs text-gray-400 mt-1">{typeLabels[rec.type] ?? rec.type}</p>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
    </ErrorBoundary>
  );
}
