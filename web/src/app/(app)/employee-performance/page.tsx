'use client';

import { useEffect, useState, useCallback } from 'react';
import { TrendingUp, Clock, Users, Wallet, ChevronRight, ChevronLeft } from 'lucide-react';
import { employeesApi } from '@/lib/api';
import { formatCurrency, getInitials, getErrorMessage } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/Card';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const DOW_LABELS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

interface EmpPerf {
  id: string; full_name: string; role: string; salary_type: string; avatar_url?: string;
  shift_count: number; total_hours: number; avg_shift_hours: number; gross_pay: number; cost_per_hour: number;
}
interface DowRow { dow: number; shift_count: number; total_hours: number; }
interface PerfData {
  employees: EmpPerf[]; byDow: DowRow[];
  totals: { total_hours: number; total_shifts: number; total_gross: number; active_employees: number };
}

function KpiCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: color + '18' }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        <div className="min-w-0">
          <p className="text-xs opacity-50 mb-0.5">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function EmployeePerformancePage() {
  const { toast } = useAppDialog();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear]   = useState(now.getFullYear());
  const [data, setData]   = useState<PerfData | null>(null);
  const [loading, setLoading] = useState(true);

  const beginRequest = useLatestRequest();

  const load = useCallback(() => {
    const latest = beginRequest();
    setLoading(true);
    employeesApi.performance(year, month)
      .then(r => latest(() => setData(r.data)))
      .catch(err => latest(() => { setData(null); toast(getErrorMessage(err) || 'שגיאה בטעינת נתוני ביצועים', 'error'); }))
      .finally(() => latest(() => setLoading(false)));
    // `toast` comes from AppDialogContext and is a stable useCallback, so
    // listing it here is honest and doesn't retrigger the load.
  }, [year, month, toast, beginRequest]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['shift_opened', 'shift_closed'], load);

  const shiftMonth = (delta: number) => {
    let m = month + delta, y = year;
    if (m > 12) { m = 1; y++; } else if (m < 1) { m = 12; y--; }
    setMonth(m); setYear(y);
  };

  const maxDowHours = Math.max(1, ...(data?.byDow.map(d => d.total_hours) || [1]));
  const maxEmpHours = Math.max(1, ...(data?.employees.map(e => e.total_hours) || [1]));

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="w-6 h-6" style={{ color: '#c9a227' }} />
            ביצועי עובדים
          </h1>
          <p className="text-sm opacity-60 mt-0.5">שעות עבודה, עלות שכר ודפוסי נוכחות לפי חודש</p>
        </div>
        <div className="flex items-center gap-2 bg-[#1a1a20] rounded-xl p-1">
          <button onClick={() => shiftMonth(1)} className="p-1.5 rounded-lg hover:bg-white/5"><ChevronRight className="w-4 h-4" /></button>
          <span className="text-sm font-semibold px-2 min-w-[110px] text-center">{MONTHS[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded-lg hover:bg-white/5"><ChevronLeft className="w-4 h-4" /></button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : !data || data.employees.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <p>אין נתוני משמרות לחודש זה</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard icon={Clock}   label="סה״כ שעות"     value={data.totals.total_hours.toLocaleString('he-IL')} color="#60b8e8" />
            <KpiCard icon={Users}   label="עובדים פעילים"  value={String(data.totals.active_employees)} color="#22c55e" />
            <KpiCard icon={Wallet}  label="עלות שכר כוללת" value={formatCurrency(data.totals.total_gross)} color="#c9a227" />
            <KpiCard icon={TrendingUp} label="סה״כ משמרות" value={String(data.totals.total_shifts)} color="#a855f7" />
          </div>

          {/* Leaderboard */}
          <Card>
            <CardContent className="p-0">
              <div className="px-5 py-3.5 text-sm font-bold" style={{ borderBottom: '1px solid var(--card-border-color)' }}>
                דירוג לפי שעות עבודה
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--card-border-color)' }}>
                {data.employees.map(e => (
                  <div key={e.id} className="flex items-center gap-3 px-5 py-3.5">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold"
                      style={{ background: 'rgba(201,162,39,0.12)', color: '#c9a227' }}>
                      {getInitials(e.full_name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-sm font-semibold truncate">{e.full_name}</p>
                        <p className="text-xs opacity-50 flex-shrink-0">{e.shift_count} משמרות · {e.total_hours} שעות</p>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(e.total_hours / maxEmpHours) * 100}%`, background: '#c9a227' }} />
                      </div>
                    </div>
                    <div className="text-left flex-shrink-0 w-24">
                      <p className="text-sm font-bold">{formatCurrency(e.gross_pay)}</p>
                      <p className="text-xs opacity-40">₪{e.cost_per_hour}/שעה</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Attendance by day of week */}
          {data.byDow.length > 0 && (
            <Card>
              <CardContent className="p-5">
                <p className="text-sm font-bold mb-4">שעות עבודה לפי יום בשבוע</p>
                <div className="flex items-end gap-2 h-32">
                  {DOW_LABELS.map((label, dow) => {
                    const row = data.byDow.find(d => d.dow === dow);
                    const hours = row?.total_hours || 0;
                    return (
                      <div key={dow} className="flex-1 flex flex-col items-center gap-1.5">
                        <span className="text-xs opacity-50">{hours ? hours.toFixed(0) : ''}</span>
                        <div className="w-full rounded-t-lg" style={{
                          height: `${Math.max(4, (hours / maxDowHours) * 100)}px`,
                          background: hours > 0 ? '#c9a227' : 'rgba(255,255,255,0.06)',
                        }} />
                        <span className="text-xs opacity-40">{label}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
