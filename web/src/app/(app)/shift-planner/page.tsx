'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  CalendarDays, TrendingUp, MessageCircle,
  CheckCircle, AlertTriangle, XCircle, RefreshCw,
  ChevronDown, ChevronUp, UserMinus, ShoppingCart, Info } from 'lucide-react';
import { shiftPlannerApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/utils';

interface InviteSuggestion {
  employee_id: string;
  employee_name: string;
  phone: string | null;
  wa_link: string | null;
  message: string;
}

interface QueueSignal {
  avg_covers: number;
  avg_entries: number;
  sample_days: number;
}

interface AbsenceRisk {
  rate: number;
  rate_label: string;
  total: number;
  absent: number;
}

interface DaySuggestion {
  date: string;
  date_label: string;
  dow: number;
  dow_name: string;
  is_weekend: boolean;
  forecast_revenue: number;
  recommended_staff: number;
  recommended_base: number;
  absence_buffer: number;
  queue_boost: number;
  scheduled_count: number;
  gap: number;
  status: 'ok' | 'warning' | 'critical';
  invite_suggestions: InviteSuggestion[];
  queue_signal: QueueSignal | null;
  absence_risk: AbsenceRisk | null;
  history_reason: string;
}

interface SuggestionsResponse {
  suggestions: DaySuggestion[];
  total_gap: number;
  revenue_per_staff: number;
  calibrated_from_history: boolean;
}

const STATUS_STYLES = {
  ok:       { bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.25)',  text: '#4ade80', icon: CheckCircle,   label: 'מאויש' },
  warning:  { bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.25)', text: '#fbbf24', icon: AlertTriangle, label: 'חסר עובד' },
  critical: { bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.25)',  text: '#f87171', icon: XCircle,       label: 'חסרים עובדים' },
};

function AbsencePill({ risk }: { risk: AbsenceRisk }) {
  const high = risk.rate > 0.25;
  const med  = risk.rate > 0.1;
  if (risk.rate === 0) return null;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-semibold flex items-center gap-1"
      style={{
        background: high ? 'rgba(239,68,68,0.15)' : med ? 'rgba(245,158,11,0.15)' : 'rgba(148,163,184,0.15)',
        color:      high ? '#f87171' : med ? '#fbbf24' : '#94a3b8',
      }}
    >
      <UserMinus className="w-3 h-3" />
      {risk.rate_label} היעדרות
    </span>
  );
}

function QueuePill({ signal }: { signal: QueueSignal }) {
  if (!signal || signal.avg_covers === 0) return null;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-semibold flex items-center gap-1"
      style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc' }}
    >
      <ShoppingCart className="w-3 h-3" />
      ~{signal.avg_covers} סועדים
    </span>
  );
}

export default function ShiftPlannerPage() {
  const [data, setData]           = useState<SuggestionsResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [expandedDay, setExpanded] = useState<string | null>(null);
  const [sentLinks, setSentLinks]  = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    shiftPlannerApi.suggestions()
      .then(r => {
        const res: SuggestionsResponse = r.data;
        setData(res);
        const firstGap = (res.suggestions || []).find(d => d.gap > 0);
        if (firstGap) setExpanded(firstGap.date);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  // תלוי בנתוני משמרות ומכירות — מתעדכן כשמישהו פותח/סוגר/מתכנן משמרת או שיש מכירה חדשה
  useSyncEvent(['shift_opened', 'shift_closed', 'employee.updated', 'dashboard.refresh'], load);

  const suggestions   = data?.suggestions || [];
  const totalGap      = suggestions.reduce((s, d) => s + d.gap, 0);
  const criticalDays  = suggestions.filter(d => d.status === 'critical').length;
  const okDays        = suggestions.filter(d => d.status === 'ok').length;

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">תכנון משמרות חכם</h1>
          <p className="text-sm opacity-60 mt-0.5">
            המלצות איוש לשבוע הבא — מבוסס על היסטוריית מכירות, תורים והיעדרויות
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'סה״כ חסרים',    value: totalGap,     color: totalGap > 0     ? '#f87171' : '#4ade80' },
          { label: 'ימים קריטיים',  value: criticalDays, color: criticalDays > 0 ? '#f87171' : '#4ade80' },
          { label: 'ימים מאוישים',  value: okDays,       color: '#4ade80' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl p-4 text-center"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
            <p className="text-xs opacity-60 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Calibration notice */}
      {data?.calibrated_from_history && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 text-xs"
          style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', color: '#a5b4fc' }}>
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            יחס ₪{data.revenue_per_staff.toLocaleString('he')} לעובד — מחושב מנתוני משמרות ומכירות אמיתיות (לא הערכה קבועה)
          </span>
        </div>
      )}

      {/* Day cards */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <CalendarDays className="w-10 h-10 mx-auto mb-3" />
            <p>אין נתוני תחזית</p>
            <p className="text-xs mt-1">הפק מכירות כדי שהמערכת תבנה תחזית ביקוש</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {suggestions.map(day => {
            const st         = STATUS_STYLES[day.status];
            const StatusIcon = st.icon;
            const isExpanded = expandedDay === day.date;

            return (
              <div key={day.date} className="rounded-2xl overflow-hidden"
                style={{ background: st.bg, border: `1px solid ${st.border}` }}>

                {/* Header row */}
                <button
                  className="w-full flex items-center gap-4 p-4 text-right"
                  onClick={() => setExpanded(isExpanded ? null : day.date)}>

                  <div className="flex-1 min-w-0">
                    {/* Title line */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusIcon className="w-4 h-4 flex-shrink-0" style={{ color: st.text }} />
                      <span className="font-bold">{day.date_label}</span>
                      {day.is_weekend && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                          style={{ background: 'rgba(245,158,11,0.2)', color: '#fbbf24' }}>סוף שבוע</span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ background: `${st.text}22`, color: st.text }}>{st.label}</span>

                      {/* Queue signal pill */}
                      {day.queue_signal && <QueuePill signal={day.queue_signal} />}

                      {/* Absence risk pill */}
                      {day.absence_risk && <AbsencePill risk={day.absence_risk} />}
                    </div>

                    {/* Revenue + staffing line */}
                    <p className="text-xs opacity-50 mt-0.5">
                      תחזית: {formatCurrency(day.forecast_revenue)}
                      {' · '}מומלץ {day.recommended_staff} עובדים
                      {day.absence_buffer > 0 && (
                        <span style={{ color: '#fbbf24' }}> (+{day.absence_buffer} חיץ)</span>
                      )}
                      {day.queue_boost > 0 && (
                        <span style={{ color: '#a5b4fc' }}> (+{day.queue_boost} תורים)</span>
                      )}
                      {' · '}מתוכנן {day.scheduled_count}
                      {day.gap > 0 && <span style={{ color: '#f87171' }}> · חסרים {day.gap}</span>}
                    </p>

                    {/* History reason */}
                    <p className="text-xs mt-1 opacity-40 truncate">{day.history_reason}</p>
                  </div>

                  {/* Staff dots */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex gap-1">
                      {Array.from({ length: Math.min(day.recommended_staff, 10) }).map((_, i) => (
                        <div key={i} className="w-3 h-3 rounded-full"
                          style={{ background: i < day.scheduled_count ? '#4ade80' : 'rgba(255,255,255,0.15)' }} />
                      ))}
                    </div>
                    {isExpanded
                      ? <ChevronUp className="w-4 h-4 opacity-40" />
                      : <ChevronDown className="w-4 h-4 opacity-40" />}
                  </div>
                </button>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="border-t px-4 py-3 space-y-3"
                    style={{ borderColor: st.border, background: 'rgba(0,0,0,0.2)' }}>

                    {/* Intelligence breakdown */}
                    {(day.queue_signal || day.absence_risk) && (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {day.queue_signal && day.queue_signal.avg_covers > 0 && (
                          <div className="rounded-lg px-3 py-2"
                            style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
                            <p className="font-semibold mb-0.5" style={{ color: '#a5b4fc' }}>
                              <ShoppingCart className="w-3 h-3 inline ml-1" />
                              סיגנל תורים
                            </p>
                            <p className="opacity-70">
                              ממוצע {day.queue_signal.avg_covers} סועדים ביום זה
                              {day.queue_signal.sample_days > 0 && ` (${day.queue_signal.sample_days} שבועות)`}
                            </p>
                          </div>
                        )}
                        {day.absence_risk && day.absence_risk.rate > 0 && (
                          <div className="rounded-lg px-3 py-2"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
                            <p className="font-semibold mb-0.5" style={{ color: '#f87171' }}>
                              <UserMinus className="w-3 h-3 inline ml-1" />
                              סיכון היעדרות
                            </p>
                            <p className="opacity-70">
                              {day.absence_risk.absent}/{day.absence_risk.total} משמרות היו היעדרות ביום זה
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Invite suggestions */}
                    {day.gap > 0 && day.invite_suggestions.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold opacity-60 mb-2">הזמן עובדים למשמרת:</p>
                        <div className="space-y-2">
                          {day.invite_suggestions.map(emp => {
                            const sent = sentLinks.has(`${day.date}-${emp.employee_id}`);
                            return (
                              <div key={emp.employee_id}
                                className="flex items-center justify-between gap-3 flex-wrap">
                                <div>
                                  <p className="font-semibold text-sm">{emp.employee_name}</p>
                                  <p className="text-xs opacity-40">{emp.phone || 'אין טלפון'}</p>
                                </div>
                                {emp.wa_link ? (
                                  <a
                                    href={emp.wa_link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setSentLinks(s => new Set([...s, `${day.date}-${emp.employee_id}`]))}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-white"
                                    style={{
                                      background: sent
                                        ? 'rgba(34,197,94,0.3)'
                                        : 'linear-gradient(135deg,#075e54,#25d366)',
                                      border: sent ? '1px solid #22c55e' : 'none',
                                    }}>
                                    {sent
                                      ? <><CheckCircle className="w-3.5 h-3.5 text-green-400" /> נשלח</>
                                      : <><MessageCircle className="w-3.5 h-3.5" /> שלח WhatsApp</>}
                                  </a>
                                ) : (
                                  <span className="text-xs opacity-30">אין מספר</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Fully staffed */}
                    {day.gap <= 0 && (
                      <p className="text-xs text-green-400 flex items-center gap-1.5">
                        <CheckCircle className="w-3.5 h-3.5" />
                        המשמרת מאוישת — {day.scheduled_count} עובדים מתוכננים
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* How it works */}
      <div className="rounded-xl p-4 text-sm"
        style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}>
        <p className="font-semibold mb-2 flex items-center gap-2" style={{ color: '#a5b4fc' }}>
          <TrendingUp className="w-4 h-4" /> איך המערכת מחשבת?
        </p>
        <ul className="text-xs opacity-60 space-y-1 list-disc list-inside">
          <li>מנתחת ממוצע מכירות לפי יום בשבוע (8 שבועות אחרונים)</li>
          <li>מחשבת יחס הכנסה/עובד מנתוני משמרות ומכירות אמיתיות</li>
          <li>מוסיפה עובד חיץ כאשר ביום זה יש היסטוריה של היעדרויות גבוהה (מעל 15%)</li>
          <li>בודקת היסטוריית תורים — אם ממוצע הסועדים גבוה, מוסיפה עובד נוסף</li>
          <li>לחיצה על "שלח WhatsApp" פותחת שיחה עם הודעת הזמנה מוכנה</li>
        </ul>
      </div>
    </div>
  );
}
