'use client';

import { useEffect, useState } from 'react';
import { Shield, RefreshCw, AlertTriangle, AlertCircle, Info, CheckCircle } from 'lucide-react';
import { fraudApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

interface FraudAlert {
  type: string;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  description: string;
  employee_id?: string;
  employee_name?: string;
  value?: number;
  unit?: string;
}

interface FraudResult {
  alerts: FraudAlert[];
  summary: { total: number; critical: number; high: number; medium: number };
  period_days: number;
  generated_at: string;
  degraded?: boolean;
  failed_checks?: string[];
  checks?: { name: string; label: string; status: 'ran' | 'skipped'; reason: string | null }[];
  checks_ran?: number;
  checks_skipped?: number;
}

const SEVERITY_CONFIG = {
  critical: { color: '#f87171', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', icon: AlertCircle, label: 'קריטי' },
  high:     { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)', icon: AlertTriangle, label: 'גבוה' },
  medium:   { color: '#60a5fa', bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.25)', icon: Info, label: 'בינוני' },
};

const TYPE_LABEL: Record<string, string> = {
  negative_transactions:  'עסקאות שליליות / ביטולים',
  revenue_gap_days:       'ימים עם הכנסה נמוכה מהרגיל',
  sale_type_shift:        'שינוי חריג בהתפלגות סוגי מכירה',
  payment_channel_shift:  'שינוי חריג בערוצי תשלום',
  large_transaction:      'עסקה או יום חריג בגודלו',
  unusual_hour_spike:     'מכירות בשעות חריגות',
};

export default function FraudAlertsPage() {
  const [data, setData]   = useState<FraudResult | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [days, setDays]   = useState(30);

  const load = (d = days) => {
    setLoading(true);
    setError(false);
    fraudApi.alerts(d)
      .then((r) => setData(r.data as FraudResult))
      .catch(() => { setData(null); setError(true); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useSyncEvent(['dashboard.refresh'], () => load());

  const changeDays = (d: number) => {
    setDays(d);
    load(d);
  };

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6" style={{ color: '#c9a227' }} />
            גילוי חריגות
          </h1>
          <p className="text-sm opacity-60 mt-0.5">זיהוי אוטומטי של דפוסים חשודים: ביטולים, הנחות, מכירות מחוץ למשמרת</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Days selector */}
          <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid var(--card-border-color)' }}>
            {[7, 30, 60].map(d => (
              <button key={d} onClick={() => changeDays(d)}
                className="px-3 py-1.5 text-sm font-semibold transition-all"
                style={{
                  background: days === d ? 'rgba(201,162,39,0.15)' : 'transparent',
                  color:      days === d ? '#c9a227' : undefined,
                }}>
                {d} ימים
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Degraded-results notice — some checks failed server-side, so "no
          alerts" below may mean "not all checks ran," not "all clean" */}
      {data?.degraded && (
        <div className="rounded-2xl p-4 flex items-center gap-3"
          style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: '#fbbf24' }} />
          <p className="text-sm" style={{ color: '#fbbf24' }}>
            חלק מבדיקות החריגות נכשלו זמנית ({data.failed_checks?.length ?? 0}) — התוצאות למטה עשויות להיות חלקיות. נסה לרענן בעוד כמה דקות.
          </p>
        </div>
      )}

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'סה"כ התראות', value: data.summary.total, color: '#c9a227' },
            { label: 'קריטי', value: data.summary.critical, color: data.summary.critical > 0 ? '#f87171' : '#4ade80' },
            { label: 'גבוה', value: data.summary.high, color: data.summary.high > 0 ? '#fbbf24' : '#4ade80' },
            { label: 'בינוני', value: data.summary.medium, color: '#60a5fa' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-2xl p-4"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
              <p className="text-2xl font-black" style={{ color }}>{value}</p>
              <p className="text-xs opacity-60 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-400" />
            <p className="font-semibold text-red-400">שגיאה בטעינת הנתונים</p>
            <p className="text-xs opacity-50 mt-1">לא הצלחנו לבדוק חריגות — נסה לרענן</p>
          </CardContent>
        </Card>
      ) : !data || data.alerts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            {/* A green all-clear is only honest when every check actually ran.
                When some were skipped, saying "no anomalies" overstates what
                was examined — so the wording and the icon both change. */}
            {(data?.checks_skipped ?? 0) > 0 ? (
              <>
                <Info className="w-12 h-12 mx-auto mb-3" style={{ color: '#60a5fa' }} />
                <p className="font-semibold" style={{ color: '#60a5fa' }}>לא זוהו חריגות בבדיקות שבוצעו</p>
                <p className="text-xs opacity-60 mt-1">
                  {data?.checks_ran} מתוך {data?.checks?.length} בדיקות רצו ב-{days} הימים האחרונים.
                  היתר לא ניתנות לביצוע על הנתונים הקיימים — הפירוט למטה.
                </p>
              </>
            ) : (
              <>
                <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-400" />
                <p className="font-semibold text-green-400">לא זוהו חריגות</p>
                <p className="text-xs opacity-50 mt-1">כל הבדיקות רצו ולא נמצאו דפוסים חשודים ב-{days} הימים האחרונים</p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.alerts.map((alert, i) => {
            const cfg = SEVERITY_CONFIG[alert.severity];
            const IconComponent = cfg.icon;
            return (
              <div key={i} className="rounded-2xl p-4"
                style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                <div className="flex items-start gap-3">
                  <IconComponent className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: cfg.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm">{alert.title}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{
                          background: `${cfg.color}22`,
                          color: cfg.color,
                          border: `1px solid ${cfg.color}44`,
                        }}>
                        {cfg.label}
                      </span>
                      <span className="text-xs opacity-40 px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
                        {TYPE_LABEL[alert.type] || alert.type}
                      </span>
                    </div>
                    <p className="text-xs opacity-70 mt-1.5 leading-relaxed">{alert.description}</p>
                    {alert.value !== undefined && alert.unit && (
                      <p className="text-xs font-semibold mt-2" style={{ color: cfg.color }}>
                        {alert.value} {alert.unit}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Coverage — which checks actually ran. Without this, a page showing
          zero alerts gives no way to tell thorough scrutiny apart from a
          check that never executed. */}
      {!loading && !error && data?.checks && data.checks.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-bold mb-3">
              כיסוי הבדיקות — {data.checks_ran} מתוך {data.checks.length} בוצעו
            </p>
            <div className="space-y-2">
              {data.checks.map(c => (
                <div key={c.name} className="flex items-start gap-2.5">
                  {c.status === 'ran'
                    ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-green-400" />
                    : <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }} />}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold" style={{ opacity: c.status === 'ran' ? 0.9 : 0.55 }}>
                      {c.label}
                    </p>
                    {c.reason && (
                      <p className="text-xs opacity-45 leading-relaxed mt-0.5">{c.reason}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <p className="text-xs opacity-30 text-center">
          עודכן: {new Date(data.generated_at).toLocaleString('he-IL')} | תקופה: {data.period_days} ימים
        </p>
      )}
    </div>
  );
}
