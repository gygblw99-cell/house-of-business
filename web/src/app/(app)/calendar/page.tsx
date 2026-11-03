'use client';

import { useEffect, useState, useCallback } from 'react';
import { ChevronRight, ChevronLeft, Calendar, Clock, User, Grid3x3, AlignJustify, Plus, X, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Trophy, Sparkles } from 'lucide-react';
import { shiftsApi, remindersApi, calendarApi } from '@/lib/api';
import { DatePicker } from '@/components/ui/DatePicker';
import { useAppDialog } from '@/context/AppDialogContext';
import { getErrorMessage } from '@/lib/utils';
import { useSyncEvent } from '@/context/SyncContext';

type View = 'week' | 'month';

interface Insight {
  type:  string;
  icon:  string;
  title: string;
  body:  string;
  color: 'green' | 'amber' | 'red' | 'gold';
}

interface CalEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  type: 'shift' | 'reminder';
  sub?: string;
}

interface AddForm {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
}

const HE_DAYS   = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 7);

function startOfWeek(d: Date) {
  const day = new Date(d); day.setHours(0,0,0,0);
  day.setDate(day.getDate() - day.getDay());
  return day;
}
function addDays(d: Date, n: number) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export default function CalendarPage() {
  const { toast } = useAppDialog();
  const [view, setView]         = useState<View>('week');
  const [anchor, setAnchor]     = useState(new Date());
  const [events, setEvents]     = useState<CalEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [showAdd, setShowAdd]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [upcomingBusy, setUpcomingBusy] = useState<string[]>([]);
  const [form, setForm]         = useState<AddForm>({
    title: '', date: toLocalDateStr(new Date()),
    startTime: '09:00', endTime: '10:00',
  });

  const weekStart = startOfWeek(anchor);
  const weekDays  = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const firstCell  = new Date(monthStart); firstCell.setDate(firstCell.getDate() - firstCell.getDay());
  const monthCells = Array.from({ length: 42 }, (_, i) => addDays(firstCell, i));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [shiftsRes, remRes, insightsRes] = await Promise.all([
        shiftsApi.list({}).catch(() => ({ data: { shifts: [] } })),
        remindersApi.list().catch(() => ({ data: [] })),
        calendarApi.smartInsights().catch(() => ({ data: { insights: [], upcoming_busy_dates: [] } })),
      ]);
      setInsights(insightsRes.data?.insights || []);
      setUpcomingBusy(insightsRes.data?.upcoming_busy_dates || []);

      const shiftEvents: CalEvent[] = (shiftsRes.data?.shifts || []).map((s: {
        id: string; employee_name: string; start_time: string;
        end_time?: string; actual_start?: string; actual_end?: string;
      }) => ({
        id: s.id,
        title: s.employee_name,
        start: new Date(s.actual_start || s.start_time),
        end:   new Date(s.actual_end || s.end_time || new Date(new Date(s.actual_start || s.start_time).getTime() + 8*3600000)),
        type:  'shift' as const,
        sub:   s.actual_end ? 'הושלמה' : s.actual_start ? 'פעילה' : 'מתוכננת',
      }));

      const reminderEvents: CalEvent[] = (Array.isArray(remRes.data) ? remRes.data : []).map((r: {
        id: string; title: string; remind_at: string; end_at?: string | null;
      }) => ({
        id: r.id,
        title: r.title,
        start: new Date(r.remind_at),
        end:   new Date(r.end_at || new Date(r.remind_at).getTime() + 60*60000),
        type:  'reminder' as const,
      }));

      setEvents([...shiftEvents, ...reminderEvents]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['shift_opened', 'shift_closed', 'employee.updated', 'notification'], load);

  const prev = () => {
    const d = new Date(anchor);
    if (view === 'week') d.setDate(d.getDate() - 7);
    else d.setMonth(d.getMonth() - 1);
    setAnchor(d);
  };
  const next = () => {
    const d = new Date(anchor);
    if (view === 'week') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    setAnchor(d);
  };

  const openAdd = (day?: Date) => {
    setForm({
      title: '',
      date: toLocalDateStr(day || new Date()),
      startTime: '09:00',
      endTime: '10:00',
    });
    setShowAdd(true);
  };

  const handleSave = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const remindAt = new Date(`${form.date}T${form.startTime}:00`).toISOString();
      // endAt was collected by the form but never sent — every event silently
      // rendered as a hard-coded 1-hour block regardless of the chosen end time.
      const endAt = form.endTime ? new Date(`${form.date}T${form.endTime}:00`).toISOString() : undefined;
      await remindersApi.create({ title: form.title, remindAt, endAt });
      setShowAdd(false);
      await load();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const eventsForDay = (day: Date) => events.filter(e => sameDay(e.start, day));

  const titleLabel = view === 'week'
    ? `${weekDays[0].getDate()} – ${weekDays[6].getDate()} ${HE_MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
    : `${HE_MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  return (
    <div className="space-y-4" dir="rtl">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">לוח שנה</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-0.5">משמרות ותזכורות בתצוגה חזותית</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Add button */}
          <button
            onClick={() => openAdd()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm"
            style={{ background: 'var(--color-primary,#1a5c2a)', color: '#fff' }}
          >
            <Plus className="w-4 h-4" />
            הוספה
          </button>

          {/* View toggle */}
          <div className="flex rounded-xl overflow-hidden border" style={{ borderColor: 'var(--card-border-color, #e5e7eb)' }}>
            {(['week','month'] as View[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className="px-4 py-2 text-sm font-medium flex items-center gap-1.5 transition-all"
                style={{
                  background: view === v ? 'var(--color-primary, #1a5c2a)' : 'transparent',
                  color: view === v ? '#fff' : 'var(--color-primary, #1a5c2a)',
                }}>
                {v === 'week' ? <AlignJustify className="w-3.5 h-3.5" /> : <Grid3x3 className="w-3.5 h-3.5" />}
                {v === 'week' ? 'שבועי' : 'חודשי'}
              </button>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-1">
            <button onClick={prev} className="p-2 rounded-xl transition-colors hover:bg-[rgba(201,162,39,0.06)]">
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold px-2 min-w-[180px] text-center">{titleLabel}</span>
            <button onClick={next} className="p-2 rounded-xl transition-colors hover:bg-[rgba(201,162,39,0.06)]">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
          <button onClick={() => setAnchor(new Date())}
            className="px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            style={{ background: 'var(--tag-bg,#e8f5eb)', color: 'var(--color-primary,#1a5c2a)' }}>
            היום
          </button>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 text-xs text-[rgba(232,232,228,0.42)]">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded" style={{ background: 'var(--color-primary,#1a5c2a)' }} />
          משמרות
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded" style={{ background: '#c9a227' }} />
          תזכורות ואירועים
        </span>
      </div>

      {/* ── Smart Insights ── */}
      {insights.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {insights.map((ins, i) => {
            const colorMap = {
              green: { bg: 'rgba(26,92,42,0.12)', border: 'rgba(26,92,42,0.22)', icon: '#1a5c2a', text: '#1a5c2a' },
              amber: { bg: 'rgba(201,162,39,0.08)', border: 'rgba(201,162,39,0.22)', icon: '#c9a227', text: '#c9a227' },
              red:   { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.22)',  icon: '#ef4444', text: '#ef4444' },
              gold:  { bg: 'rgba(201,162,39,0.12)', border: 'rgba(201,162,39,0.3)',  icon: '#c9a227', text: '#c9a227' },
            };
            const c = colorMap[ins.color] || colorMap.green;
            const IconComp = ins.icon === 'TrendingUp' ? TrendingUp
              : ins.icon === 'TrendingDown' ? TrendingDown
              : ins.icon === 'ArrowUpRight' ? ArrowUpRight
              : ins.icon === 'ArrowDownRight' ? ArrowDownRight
              : ins.icon === 'Trophy' ? Trophy
              : Sparkles;
            return (
              <div key={i} className="rounded-xl p-3 flex items-start gap-3"
                style={{ background: c.bg, border: `1px solid ${c.border}` }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: `${c.icon}22` }}>
                  <IconComp className="w-4 h-4" style={{ color: c.icon }} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug" style={{ color: c.text }}>{ins.title}</p>
                  <p className="text-xs mt-0.5 text-[rgba(232,232,228,0.5)] leading-relaxed">{ins.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="h-96 rounded-2xl animate-pulse" style={{ background: 'var(--glass-bg,rgba(255,255,255,0.6))' }} />
      ) : view === 'week' ? (
        /* ── WEEK VIEW ── */
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--glass-bg,rgba(255,255,255,0.75))', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
          {/* Day headers */}
          <div className="grid border-b" style={{ gridTemplateColumns: '60px repeat(7, 1fr)', borderColor: 'var(--glass-border)' }}>
            <div />
            {weekDays.map((d, i) => {
              const isToday = sameDay(d, new Date());
              return (
                <div key={i} className="text-center py-3 text-sm font-medium border-r last:border-r-0 cursor-pointer group"
                  style={{ borderColor: 'var(--glass-border)' }}
                  onClick={() => openAdd(d)}
                  title="לחץ להוספת אירוע ביום זה">
                  <p className="text-[rgba(232,232,228,0.42)] text-xs">{HE_DAYS[d.getDay()]}</p>
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold mt-0.5 ${isToday ? 'text-white' : 'text-[rgba(232,232,228,0.72)] group-hover:bg-[rgba(201,162,39,0.06)]'}`}
                    style={isToday ? { background: 'var(--color-primary,#1a5c2a)' } : {}}>
                    {d.getDate()}
                  </span>
                </div>
              );
            })}
          </div>
          {/* Time grid */}
          <div className="overflow-y-auto" style={{ maxHeight: '65vh' }}>
            {HOURS.map(hour => (
              <div key={hour} className="grid border-b" style={{ gridTemplateColumns: '60px repeat(7, 1fr)', borderColor: 'var(--glass-border,rgba(0,0,0,0.06))', minHeight: '60px' }}>
                <div className="text-xs text-gray-400 px-2 py-1 text-left">{String(hour).padStart(2,'0')}:00</div>
                {weekDays.map((day, di) => {
                  const slotEvents = events.filter(e => {
                    if (!sameDay(e.start, day)) return false;
                    return e.start.getHours() === hour;
                  });
                  return (
                    <div key={di} className="relative border-r last:border-r-0 p-0.5 hover:bg-[rgba(201,162,39,0.04)] cursor-pointer"
                      style={{ borderColor: 'var(--glass-border,rgba(0,0,0,0.06))' }}
                      onClick={() => { if (slotEvents.length === 0) { const d = new Date(day); d.setHours(hour,0,0,0); openAdd(d); } }}>
                      {slotEvents.map(e => (
                        <button key={e.id} onClick={ev => { ev.stopPropagation(); setSelected(e); }}
                          className="w-full text-right px-2 py-1 rounded-lg text-xs font-medium text-white mb-0.5 truncate hover:brightness-110 transition-all"
                          style={{ background: e.type === 'shift' ? 'var(--color-primary,#1a5c2a)' : '#c9a227' }}>
                          {e.title}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* ── MONTH VIEW ── */
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--glass-bg,rgba(255,255,255,0.75))', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
          <div className="grid grid-cols-7 border-b" style={{ borderColor: 'var(--glass-border)' }}>
            {HE_DAYS.map(d => (
              <div key={d} className="text-center py-3 text-xs font-semibold text-[rgba(232,232,228,0.42)] border-r last:border-r-0"
                style={{ borderColor: 'var(--glass-border)' }}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {monthCells.map((cell, idx) => {
              const inMonth  = cell.getMonth() === anchor.getMonth();
              const isToday  = sameDay(cell, new Date());
              const dayEvts  = eventsForDay(cell);
              const isBusy   = upcomingBusy.includes(toLocalDateStr(cell));
              return (
                <div key={idx}
                  className="border-b border-r last:border-r-0 p-2 min-h-[90px] cursor-pointer hover:bg-[rgba(201,162,39,0.04)] transition-colors relative"
                  style={{ borderColor: 'var(--glass-border,rgba(0,0,0,0.06))', opacity: inMonth ? 1 : 0.3, background: isBusy ? 'rgba(201,162,39,0.04)' : undefined }}
                  onClick={() => openAdd(cell)}>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-semibold ${isToday ? 'text-white' : 'text-[rgba(232,232,228,0.72)]'}`}
                      style={isToday ? { background: 'var(--color-primary,#1a5c2a)' } : {}}>
                      {cell.getDate()}
                    </span>
                    {isBusy && !isToday && (
                      <span className="text-[9px] font-bold px-1 rounded" style={{ background: 'rgba(201,162,39,0.18)', color: '#c9a227' }}>עמוס</span>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {dayEvts.slice(0,3).map(e => (
                      <button key={e.id} onClick={ev => { ev.stopPropagation(); setSelected(e); }}
                        className="w-full text-right px-1.5 py-0.5 rounded text-xs text-white truncate hover:brightness-110"
                        style={{ background: e.type === 'shift' ? 'var(--color-primary,#1a5c2a)' : '#c9a227', fontSize: '10px' }}>
                        {e.title}
                      </button>
                    ))}
                    {dayEvts.length > 3 && (
                      <p className="text-xs text-[rgba(232,232,228,0.4)] pr-1">+{dayEvts.length - 3} עוד</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Add Event Modal ── */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={() => setShowAdd(false)}>
          <div className="rounded-2xl p-6 w-96 shadow-2xl"
            style={{ background: 'var(--glass-bg,rgba(255,255,255,0.97))', backdropFilter: 'blur(24px)', border: '1px solid var(--glass-border)' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                  style={{ background: 'var(--tag-bg,#e8f5eb)' }}>
                  <Plus className="w-5 h-5" style={{ color: 'var(--color-primary,#1a5c2a)' }} />
                </div>
                <h2 className="text-lg font-bold text-[#e8e8e4]">הוספת אירוע</h2>
              </div>
              <button onClick={() => setShowAdd(false)}
                className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.06)] transition-colors text-[rgba(232,232,228,0.42)]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)] mb-1.5">כותרת האירוע</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="לדוגמה: ישיבת צוות, אירוע מיוחד..."
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all"
                  style={{ borderColor: 'var(--card-border-color,#e5e7eb)' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary,#1a5c2a)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--card-border-color,#e5e7eb)'}
                  autoFocus
                />
              </div>

              {/* Date */}
              <div>
                <DatePicker
                  label="תאריך"
                  value={form.date}
                  onChange={v => setForm(f => ({ ...f, date: v }))}
                  className="w-full"
                />
              </div>

              {/* Times */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)] mb-1.5">שעת התחלה</label>
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all"
                    style={{ borderColor: 'var(--card-border-color,#e5e7eb)' }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary,#1a5c2a)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--card-border-color,#e5e7eb)'}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)] mb-1.5">שעת סיום</label>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all"
                    style={{ borderColor: 'var(--card-border-color,#e5e7eb)' }}
                    onFocus={e => e.currentTarget.style.borderColor = 'var(--color-primary,#1a5c2a)'}
                    onBlur={e => e.currentTarget.style.borderColor = 'var(--card-border-color,#e5e7eb)'}
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowAdd(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors hover:bg-[rgba(201,162,39,0.06)]"
                style={{ borderColor: 'rgba(201,162,39,0.16)', color: 'rgba(232,232,228,0.55)' }}>
                ביטול
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.title.trim()}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: 'var(--color-primary,#1a5c2a)' }}>
                {saving ? 'שומר...' : 'הוסף אירוע'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Event detail popup ── */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={() => setSelected(null)}>
          <div className="rounded-2xl p-6 w-80 shadow-2xl"
            style={{ background: 'var(--glass-bg,rgba(255,255,255,0.95))', backdropFilter: 'blur(24px)', border: '1px solid var(--glass-border)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: selected.type === 'shift' ? 'var(--tag-bg,#e8f5eb)' : '#fdf5d3' }}>
                {selected.type === 'shift'
                  ? <User className="w-5 h-5" style={{ color: 'var(--color-primary,#1a5c2a)' }} />
                  : <Calendar className="w-5 h-5" style={{ color: '#c9a227' }} />}
              </div>
              <div>
                <p className="font-bold text-[#e8e8e4]">{selected.title}</p>
                <p className="text-xs text-[rgba(232,232,228,0.42)]">{selected.type === 'shift' ? 'משמרת' : 'אירוע / תזכורת'}</p>
              </div>
            </div>
            <div className="space-y-2 text-sm text-[rgba(232,232,228,0.55)]">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />
                <span>{selected.start.toLocaleDateString('he-IL', { weekday:'long', day:'numeric', month:'long' })}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />
                <span>
                  {selected.start.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})} –{' '}
                  {selected.end.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}
                </span>
              </div>
              {selected.sub && (
                <p className="text-xs px-2 py-1 rounded-lg inline-block"
                  style={{ background: 'var(--tag-bg,#e8f5eb)', color: 'var(--color-primary,#1a5c2a)' }}>
                  {selected.sub}
                </p>
              )}
            </div>
            <button onClick={() => setSelected(null)}
              className="mt-4 w-full py-2 rounded-xl text-sm font-medium text-white"
              style={{ background: 'var(--color-primary,#1a5c2a)' }}>
              סגור
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
