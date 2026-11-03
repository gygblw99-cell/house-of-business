'use client';

import { useEffect, useState } from 'react';
import {
  Clock, MessageSquare, Bell, Settings, LogOut, User,
  CheckCircle, ChevronRight, Shield,
  MapPin, Loader2, Phone, Mail, Save, CalendarDays, KeyRound, AtSign } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { loginEmployee, logout, restoreSession, cancel2FA } from '@/store/slices/authSlice';
import { shiftsApi, messagesApi, tasksApi, authApi, businessApi } from '@/lib/api';

// ── Types ──────────────────────────────────────────────────────────────────
interface ActiveShift { id: string; actual_start: string; }
interface Message { id: string; sender_name: string; content: string; created_at: string; is_read: boolean; }
interface Task { id: string; title: string; description?: string; priority: string; due_date?: string; status: string; assigned_to?: string; }
interface UserPerms { suppliers: boolean; inventory: boolean; recipes: boolean; finance: boolean; ai: boolean; employees: boolean; export: boolean; audit: boolean; }
interface UserProfile { userId: string; fullName: string; email: string; phone?: string; role: string; username?: string; permissions?: UserPerms; }

// ── Helpers ────────────────────────────────────────────────────────────────
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short' });
}
function elapsed(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins} דק'`;
  const h = Math.floor(mins / 60); const m = mins % 60;
  return `${h}:${m.toString().padStart(2, '0')} שעות`;
}

const PRIMARY = 'var(--color-primary, #1a5c2a)';
const PERM_LABELS: Record<string, string> = {
  suppliers: 'ספקים', inventory: 'מלאי', recipes: 'מתכונים',
  finance: 'פיננסים', ai: 'יועץ AI', employees: 'עובדים',
  export: 'ייצוא', audit: 'ביקורת',
};

interface ShiftSummary { start: string; end: string; totalMin: number; }

// ── Clock Tab ───────────────────────────────────────────────────────────────
function ClockTab({ profile, onClockOut }: { profile: UserProfile; onClockOut: () => void }) {
  const [activeShift, setActiveShift] = useState<ActiveShift | null>(null);
  const [loading, setLoading] = useState(true);
  const [clocking, setClocking] = useState(false);
  const [now, setNow] = useState(new Date());
  const [shiftSummary, setShiftSummary] = useState<ShiftSummary | null>(null);

  useEffect(() => {
    shiftsApi.myActive()
      .then(r => setActiveShift(r.data.shift))
      .catch(() => setActiveShift(null))
      .finally(() => setLoading(false));
  }, []);

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);

  const doClockOut = async () => {
    if (!activeShift) return;
    setClocking(true);
    const endTime = new Date();
    try {
      await shiftsApi.clockOut(activeShift.id, {});
      const totalMin = Math.floor((endTime.getTime() - new Date(activeShift.actual_start).getTime()) / 60000);
      setShiftSummary({ start: activeShift.actual_start, end: endTime.toISOString(), totalMin });
      setActiveShift(null);
      onClockOut();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      alert(e?.response?.data?.error || 'שגיאה ביציאה');
    } finally { setClocking(false); }
  };

  const workedMin = activeShift
    ? Math.floor((now.getTime() - new Date(activeShift.actual_start).getTime()) / 60000)
    : 0;
  const workedH = Math.floor(workedMin / 60);
  const workedM = workedMin % 60;

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Current time */}
      <div className="rounded-2xl p-5 text-center"
        style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
        <p className="text-4xl font-black text-gray-800 tracking-tight">
          {now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
        </p>
        <p className="text-sm text-gray-400 mt-1">
          {now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* Shift summary after clock-out */}
      {shiftSummary && !activeShift && (
        <div className="rounded-2xl p-5 space-y-4"
          style={{ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', border: '2px solid #86efac' }}>
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600" />
            <p className="font-black text-green-800 text-base">סיכום משמרת</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white rounded-2xl p-3 text-center border border-green-100">
              <p className="text-xs text-gray-400 mb-1">כניסה</p>
              <p className="text-lg font-black text-gray-800">{formatTime(shiftSummary.start)}</p>
            </div>
            <div className="bg-white rounded-2xl p-3 text-center border border-green-100">
              <p className="text-xs text-gray-400 mb-1">יציאה</p>
              <p className="text-lg font-black text-gray-800">{formatTime(shiftSummary.end)}</p>
            </div>
            <div className="bg-white rounded-2xl p-3 text-center border border-green-100">
              <p className="text-xs text-gray-400 mb-1">סה״כ</p>
              <p className="text-lg font-black text-green-700">
                {Math.floor(shiftSummary.totalMin / 60)}:{(shiftSummary.totalMin % 60).toString().padStart(2, '0')}
              </p>
            </div>
          </div>
          <p className="text-xs text-green-700 text-center font-medium">
            {Math.floor(shiftSummary.totalMin / 60)} שעות ו-{shiftSummary.totalMin % 60} דקות עבודה — כל הכבוד! 👏
          </p>
          <button
            onClick={() => setShiftSummary(null)}
            className="w-full py-2.5 rounded-xl text-green-700 font-semibold text-sm border border-green-200 bg-white/70 hover:bg-white transition-colors">
            סגור
          </button>
        </div>
      )}

      {/* Status card */}
      {activeShift ? (
        <div className="rounded-2xl p-5 space-y-4"
          style={{ background: '#f0fdf4', border: '2px solid #86efac' }}>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
            <p className="font-bold text-green-800">במשמרת פעילה</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white rounded-xl p-3 text-center border border-green-100">
              <p className="text-xs text-gray-400 mb-1">שעת כניסה</p>
              <p className="font-bold text-gray-800">{formatTime(activeShift.actual_start)}</p>
            </div>
            <div className="bg-white rounded-xl p-3 text-center border border-green-100">
              <p className="text-xs text-gray-400 mb-1">זמן עבודה</p>
              <p className="font-bold text-green-700">{workedH}:{workedM.toString().padStart(2,'0')}</p>
            </div>
          </div>
          <button
            onClick={doClockOut}
            disabled={clocking}
            className="w-full py-4 rounded-2xl text-white font-black text-base flex items-center justify-center gap-2 transition-opacity disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#dc2626,#ef4444)' }}>
            {clocking ? <Loader2 className="w-5 h-5 animate-spin" /> : <Clock className="w-5 h-5" />}
            יציאה מהמשמרת
          </button>
        </div>
      ) : (
        <div className="rounded-2xl p-5 space-y-4"
          style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-gray-300" />
            <p className="font-semibold text-gray-500">לא במשמרת</p>
          </div>
          <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 rounded-xl p-3">
            <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5 text-gray-300" />
            <span>לכניסה למשמרת סרוק את קוד ה-QR המוצב במקום העבודה במצלמת הטלפון</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Messages Tab ──────────────────────────────────────────────────────────
function MessagesTab() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    messagesApi.list()
      .then(r => setMessages(Array.isArray(r.data) ? r.data : []))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, []);

  const markRead = async (id: string) => {
    await messagesApi.markRead(id).catch(() => {});
    setMessages(prev => prev.map(m => m.id === id ? { ...m, is_read: true } : m));
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>;

  if (!messages.length) return (
    <div className="text-center py-16 text-gray-400">
      <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-20" />
      <p className="text-sm">אין הודעות צוות</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {messages.map(m => (
        <div key={m.id}
          className="rounded-2xl p-4 transition-all"
          style={{
            background: m.is_read ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.97)',
            border: `1px solid ${m.is_read ? 'rgba(0,0,0,0.07)' : 'var(--color-accent,#c9a227)'}`,
          }}>
          {/* Header */}
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0"
                style={{ background: PRIMARY }}>
                {m.sender_name?.charAt(0) || '?'}
              </div>
              <p className="text-sm font-bold text-gray-800">{m.sender_name}</p>
            </div>
            {!m.is_read
              ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">חדש</span>
              : <CheckCircle className="w-4 h-4 text-green-500" />
            }
          </div>

          {/* Content */}
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed mt-2">{m.content}</p>

          {/* Footer */}
          <div className="flex items-center justify-between mt-3 gap-2">
            <p className="text-xs text-gray-400">
              {new Date(m.created_at).toLocaleDateString('he-IL', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' })}
            </p>
            {!m.is_read && (
              <button
                onClick={() => markRead(m.id)}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl transition-colors"
                style={{ background: `${PRIMARY}15`, color: PRIMARY }}>
                <CheckCircle className="w-3.5 h-3.5" />
                ההודעה נקראה
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Reminders Tab ─────────────────────────────────────────────────────────
function RemindersTab({ userId }: { userId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tasksApi.list()
      .then(r => {
        const all: Task[] = r.data?.tasks || r.data || [];
        // Show tasks assigned to this user or unassigned, not completed
        const mine = all.filter(t =>
          t.status !== 'approved' &&
          (!t.assigned_to || t.assigned_to === userId)
        );
        setTasks(mine);
      })
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [userId]);

  const priorityColor = (p: string) => ({
    critical: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', label: 'דחוף' },
    high:     { bg: '#fffbeb', border: '#fcd34d', text: '#d97706', label: 'גבוה' },
    medium:   { bg: '#eff6ff', border: '#bfdbfe', text: '#2563eb', label: 'בינוני' },
    low:      { bg: '#f0fdf4', border: '#bbf7d0', text: '#16a34a', label: 'נמוך' },
  }[p] || { bg: '#f9fafb', border: '#e5e7eb', text: '#6b7280', label: p });

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>;

  if (!tasks.length) return (
    <div className="text-center py-16 text-gray-400">
      <Bell className="w-10 h-10 mx-auto mb-3 opacity-20" />
      <p className="text-sm">אין תזכורות פעילות</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {tasks.map(t => {
        const c = priorityColor(t.priority);
        return (
          <div key={t.id} className="rounded-2xl p-4"
            style={{ background: c.bg, border: `1px solid ${c.border}` }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-bold text-gray-800 flex-1">{t.title}</p>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: c.border, color: c.text }}>{c.label}</span>
            </div>
            {t.description && <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{t.description}</p>}
            {t.due_date && (
              <p className="text-xs text-gray-400 mt-2 flex items-center gap-1">
                <Bell className="w-3 h-3" />
                עד {formatDate(t.due_date)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── My Shifts Tab ─────────────────────────────────────────────────────────
interface PastShift { id: string; actual_start: string; actual_end: string; hours_worked: number; }

function MyShiftsTab({ refreshKey }: { refreshKey: number }) {
  const [shifts, setShifts] = useState<PastShift[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    shiftsApi.myHistory()
      .then(r => setShifts(r.data?.shifts || []))
      .catch(() => setShifts([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const totalHours = shifts.reduce((s, sh) => s + (sh.hours_worked || 0), 0);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>;

  if (!shifts.length) return (
    <div className="text-center py-16 text-gray-400">
      <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-20" />
      <p className="text-sm font-medium">אין משמרות בעבר</p>
      <p className="text-xs mt-1">לאחר משמרת ראשונה ההיסטוריה תופיע כאן</p>
    </div>
  );

  // Group by month
  const byMonth: Record<string, PastShift[]> = {};
  for (const sh of shifts) {
    const key = new Date(sh.actual_start).toLocaleDateString('he-IL', { year: 'numeric', month: 'long' });
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(sh);
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="rounded-2xl p-4 flex items-center gap-4"
        style={{ background: `linear-gradient(135deg,${PRIMARY},#2d7a3a)`, color: 'white' }}>
        <CalendarDays className="w-8 h-8 opacity-80 flex-shrink-0" />
        <div>
          <p className="text-2xl font-black">{totalHours.toFixed(1)} שעות</p>
          <p className="text-sm opacity-80">{shifts.length} משמרות בסה״כ</p>
        </div>
      </div>

      {/* Shifts by month */}
      {Object.entries(byMonth).map(([month, monthShifts]) => {
        const monthTotal = monthShifts.reduce((s, sh) => s + (sh.hours_worked || 0), 0);
        return (
          <div key={month} className="rounded-2xl overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
            {/* Month header */}
            <div className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', background: 'rgba(0,0,0,0.02)' }}>
              <p className="font-bold text-gray-800 text-sm">{month}</p>
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                style={{ background: `${PRIMARY}18`, color: PRIMARY }}>
                {monthShifts.length} משמרות · {monthTotal.toFixed(1)}ש׳
              </span>
            </div>
            {/* Shift rows */}
            <div className="divide-y divide-gray-50">
              {monthShifts.map(sh => {
                const start = new Date(sh.actual_start);
                const end   = new Date(sh.actual_end);
                const h = Math.floor(sh.hours_worked);
                const m = Math.round((sh.hours_worked - h) * 60);
                return (
                  <div key={sh.id} className="flex items-center gap-3 px-4 py-3">
                    {/* Date bubble */}
                    <div className="w-10 h-10 rounded-xl flex flex-col items-center justify-center flex-shrink-0"
                      style={{ background: `${PRIMARY}12` }}>
                      <span className="text-xs font-black leading-none" style={{ color: PRIMARY }}>
                        {start.toLocaleDateString('he-IL', { day: 'numeric' })}
                      </span>
                      <span className="text-[10px] leading-none text-gray-400 mt-0.5">
                        {start.toLocaleDateString('he-IL', { weekday: 'short' })}
                      </span>
                    </div>
                    {/* Times */}
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-800">
                        {start.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                        {' — '}
                        {end.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {start.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </p>
                    </div>
                    {/* Duration */}
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black" style={{ color: PRIMARY }}>{h}:{m.toString().padStart(2,'0')}</p>
                      <p className="text-[10px] text-gray-400">שעות</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────
function SettingsTab({ profile }: { profile: UserProfile }) {
  const [name, setName]   = useState(profile.fullName || '');
  const [email, setEmail] = useState(profile.email || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [username, setUsername] = useState(profile.username || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [profileErr, setProfileErr] = useState('');
  const [showPerms, setShowPerms] = useState(false);

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved]   = useState(false);
  const [pwErr, setPwErr]       = useState('');

  const save = async () => {
    setSaving(true); setProfileErr('');
    try {
      await authApi.updateMe({ fullName: name, email, phone, username: username.trim() || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setProfileErr(e?.response?.data?.error || 'שגיאה בשמירה');
    } finally { setSaving(false); }
  };

  const changePassword = async () => {
    setPwErr('');
    if (!currentPassword || !newPassword) { setPwErr('מלא סיסמה נוכחית וסיסמה חדשה'); return; }
    if (newPassword.length < 6) { setPwErr('סיסמה חדשה חייבת להכיל לפחות 6 תווים'); return; }
    if (newPassword !== confirmPassword) { setPwErr('הסיסמאות אינן תואמות'); return; }
    setPwSaving(true);
    try {
      await businessApi.changePassword({ currentPassword, newPassword });
      setPwSaved(true);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setTimeout(() => setPwSaved(false), 2500);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setPwErr(e?.response?.data?.error || 'שגיאה בשינוי הסיסמה');
    } finally { setPwSaving(false); }
  };

  const perms = profile.permissions;
  const activePerms = perms ? Object.entries(PERM_LABELS).filter(([k]) => (perms as unknown as Record<string,boolean>)[k]) : [];

  return (
    <div className="space-y-4">
      {/* Profile form */}
      <div className="rounded-2xl p-5 space-y-4"
        style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
        <p className="font-bold text-gray-800 text-sm">פרטים אישיים</p>
        <div className="space-y-3">
          <div className="relative">
            <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="שם מלא"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          <div className="relative">
            <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="אימייל"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          <div className="relative">
            <Phone className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="מספר טלפון"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          <div className="relative">
            <AtSign className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="שם משתמש להתחברות"
              autoComplete="username"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
        </div>
        {profileErr && <p className="text-sm text-red-600 text-center">{profileErr}</p>}
        <button
          onClick={save}
          disabled={saving || saved}
          className="w-full py-3 rounded-xl text-white font-bold text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-60"
          style={{ background: saved ? '#16a34a' : PRIMARY }}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saved ? 'נשמר!' : 'שמור שינויים'}
        </button>
      </div>

      {/* Password change */}
      <div className="rounded-2xl p-5 space-y-4"
        style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
        <p className="font-bold text-gray-800 text-sm">שינוי סיסמה</p>
        <div className="space-y-3">
          <div className="relative">
            <KeyRound className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="סיסמה נוכחית"
              autoComplete="current-password"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          <div className="relative">
            <KeyRound className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="סיסמה חדשה (לפחות 6 תווים)"
              autoComplete="new-password"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          <div className="relative">
            <KeyRound className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="אימות סיסמה חדשה"
              autoComplete="new-password"
              className="w-full pr-10 pl-4 py-3 rounded-xl text-sm border bg-white focus:outline-none focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
        </div>
        {pwErr && <p className="text-sm text-red-600 text-center">{pwErr}</p>}
        <button
          onClick={changePassword}
          disabled={pwSaving || pwSaved}
          className="w-full py-3 rounded-xl text-white font-bold text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-60"
          style={{ background: pwSaved ? '#16a34a' : PRIMARY }}>
          {pwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : pwSaved ? <CheckCircle className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
          {pwSaved ? 'הסיסמה שונתה!' : 'שנה סיסמה'}
        </button>
      </div>

      {/* Permissions */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid rgba(0,0,0,0.08)' }}>
        <button
          onClick={() => setShowPerms(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-blue-500" />
            <div className="text-right">
              <p className="font-bold text-gray-800 text-sm">הרשאות שלי</p>
              <p className="text-xs text-gray-400">{activePerms.length} הרשאות פעילות</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${showPerms ? '-rotate-90' : ''}`} />
        </button>
        {showPerms && (
          <div className="px-5 pb-4 border-t border-gray-100">
            {activePerms.length === 0 ? (
              <p className="text-sm text-gray-400 py-3 text-center">אין הרשאות מיוחדות</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 pt-3">
                {activePerms.map(([key, label]) => (
                  <div key={key} className="flex items-center gap-2 bg-blue-50 rounded-xl px-3 py-2">
                    <CheckCircle className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-blue-800">{label}</span>
                  </div>
                ))}
              </div>
            )}
            {profile.role === 'owner' && (
              <div className="mt-2 flex items-center gap-2 bg-purple-50 rounded-xl px-3 py-2">
                <Shield className="w-4 h-4 text-purple-500 flex-shrink-0" />
                <span className="text-sm font-medium text-purple-800">בעלים — גישה מלאה</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Portal ────────────────────────────────────────────────────────────
export default function EmployeePortal() {
  const dispatch = useAppDispatch();
  const { user, requires2FA } = useAppSelector(s => s.auth);
  const [checked, setChecked] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // Login form
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [tab, setTab] = useState<'clock' | 'messages' | 'reminders' | 'myshifts' | 'settings'>('clock');
  const [shiftsRefreshKey, setShiftsRefreshKey] = useState(0);

  useEffect(() => {
    dispatch(restoreSession()).finally(() => setChecked(true));
  }, [dispatch]);

  useEffect(() => {
    if (!user) return;
    authApi.me().then(r => setProfile(r.data.user)).catch(() => {});
  }, [user]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true); setLoginErr('');
    const res = await dispatch(loginEmployee({
      username: username.trim().toLowerCase(),
      password,
      totpCode: totpCode.trim() || undefined,
    }));
    // Show what the server actually said. The old blanket "wrong username or
    // password" was wrong for every other failure mode — a bad TOTP code, a
    // locked account, or the server being unreachable all reported as bad
    // credentials, sending people to reset a password that was fine.
    if (loginEmployee.rejected.match(res)) {
      setLoginErr(res.payload ?? 'שם משתמש או סיסמה שגויים');
    }
    setLoggingIn(false);
  };

  const backToPassword = () => { setTotpCode(''); setLoginErr(''); dispatch(cancel2FA()); };

  // ── Loading ──
  if (!checked) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#f9fafb' }}>
      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
    </div>
  );

  // ── Login screen ──
  if (!user) return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #061a0b 0%, #1a5c2a 100%)' }}>
      <div className="w-full max-w-sm rounded-3xl p-8 shadow-2xl"
        style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(24px)' }}>
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: PRIMARY }}>
            <User className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-black text-gray-800">{requires2FA ? 'אימות דו-שלבי' : 'אזור עובד'}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {requires2FA ? 'הזן את הקוד מאפליקציית האימות' : 'כניסה לפורטל העובדים'}
          </p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          {/* Credentials stay mounted (hidden) during the TOTP step — the retry
              submit re-sends username+password, which the server re-checks. */}
          <div className={requires2FA ? 'hidden' : 'space-y-4'}>
            <input type="text" placeholder="שם משתמש" value={username}
              onChange={e => setUsername(e.target.value)} required
              autoComplete="username"
              className="w-full px-4 py-3 rounded-xl text-sm outline-none border focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
            <input type="password" placeholder="סיסמה" value={password}
              onChange={e => setPassword(e.target.value)} required
              className="w-full px-4 py-3 rounded-xl text-sm outline-none border focus:ring-2"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>
          {requires2FA && (
            <>
              <input type="text" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} placeholder="000000" dir="ltr" autoFocus
                value={totpCode} onChange={e => setTotpCode(e.target.value)} required
                className="w-full px-4 py-3 rounded-xl outline-none border focus:ring-2 text-center font-bold"
                style={{ borderColor: 'rgba(0,0,0,0.1)', fontSize: 20, letterSpacing: '0.4em', textIndent: '0.4em' }}
              />
              <button type="button" onClick={backToPassword}
                className="w-full text-xs text-gray-400 hover:text-gray-600 transition-colors">
                חזרה לכניסה רגילה
              </button>
            </>
          )}
          {loginErr && <p className="text-sm text-red-600 text-center">{loginErr}</p>}
          <button type="submit" disabled={loggingIn}
            className="w-full py-3 rounded-xl text-white font-bold text-sm transition-all disabled:opacity-60"
            style={{ background: PRIMARY }}>
            {loggingIn ? 'מתחבר...' : requires2FA ? 'אמת קוד' : 'כניסה'}
          </button>
        </form>
      </div>
    </div>
  );

  // ── Main portal ──
  const tabs = [
    { id: 'clock' as const,     label: 'כניסה/יציאה', icon: Clock },
    { id: 'messages' as const,  label: 'הודעות',       icon: MessageSquare },
    { id: 'reminders' as const, label: 'תזכורות',      icon: Bell },
    { id: 'myshifts' as const,  label: 'המשמרות שלי',  icon: CalendarDays },
    { id: 'settings' as const,  label: 'הגדרות',       icon: Settings },
  ];

  return (
    <div className="min-h-screen pb-24" style={{ background: '#f9fafb' }}>
      {/* Header */}
      <div className="sticky top-0 z-20"
        style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <div className="max-w-lg mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-black"
              style={{ background: PRIMARY }}>
              {user.fullName?.charAt(0) || '?'}
            </div>
            <div>
              <p className="text-sm font-bold text-gray-800">{user.fullName}</p>
              <p className="text-xs text-gray-400">פורטל עובד</p>
            </div>
          </div>
          <button onClick={() => dispatch(logout())}
            className="p-2 rounded-xl text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-lg mx-auto px-4 pt-5">
        {profile ? (
          <>
            {tab === 'clock'     && <ClockTab profile={profile} onClockOut={() => setShiftsRefreshKey(k => k + 1)} />}
            {tab === 'messages'  && <MessagesTab />}
            {tab === 'reminders' && <RemindersTab userId={profile.userId} />}
            {tab === 'myshifts'  && <MyShiftsTab refreshKey={shiftsRefreshKey} />}
            {tab === 'settings'  && <SettingsTab profile={profile} />}
          </>
        ) : (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-300" />
          </div>
        )}
      </div>

      {/* Bottom Tab Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-20"
        style={{ background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(20px)', borderTop: '1px solid rgba(0,0,0,0.07)' }}>
        <div className="max-w-lg mx-auto flex">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className="flex-1 flex flex-col items-center gap-1 py-3 transition-colors"
              style={{ color: tab === id ? PRIMARY : '#9ca3af' }}>
              <Icon className="w-5 h-5" />
              <span className="text-xs font-semibold">{label}</span>
              {tab === id && (
                <div className="w-1 h-1 rounded-full" style={{ background: PRIMARY }} />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
