'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Clock, CheckCircle, Calendar, Pencil, Trash2, Download, LogOut, ChevronRight, ChevronLeft, QrCode, RefreshCw, AlertTriangle, Info, X, ShieldAlert, Upload, UserCheck, UserX } from 'lucide-react';
import { shiftsApi, employeesApi, exportApi } from '@/lib/api';
import { formatCurrency, getErrorMessage, downloadBlob } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { StatCard } from '@/components/ui/StatCard';
import type { Shift } from '@/types';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface Employee { id: string; full_name: string; role?: string; }

// ── Month helpers ──────────────────────────────────────────────────────────────
function monthStart(y: number, m: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function monthEnd(y: number, m: number) {
  const last = new Date(y, m + 1, 0);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}
function monthLabel(y: number, m: number) {
  return new Date(y, m, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

export default function ShiftsPage() {
  const { confirm, toast } = useAppDialog();
  const now = new Date();
  const [monthYear, setMonthYear] = useState({ y: now.getFullYear(), m: now.getMonth() });

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [openShifts, setOpenShifts] = useState<Shift[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [allUsers, setAllUsers] = useState<Employee[]>([]); // includes owner
  const [salaryPreview, setSalaryPreview] = useState<{
    total_gross: number;
    breakdown: { employee_name: string; hours: number; gross: number }[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Labor law alerts
  type LaborAlert = { type: string; severity: 'error' | 'warning' | 'info'; employee_name: string; date: string; message: string; };
  const [laborAlerts, setLaborAlerts]   = useState<LaborAlert[]>([]);
  const [showAlerts, setShowAlerts]     = useState(true);
  const [alertsLoading, setAlertsLoading] = useState(false);

  // Open shift modal
  const [showModal, setShowModal] = useState(false);
  const [shiftForm, setShiftForm] = useState({ employeeId: '', startTime: '', notes: '' });
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState('');

  // Clock-out modal
  const [showClockOut, setShowClockOut] = useState(false);
  const [clockOutId, setClockOutId] = useState('');

  // Edit shift modal
  const [editShift, setEditShift] = useState<Shift | null>(null);
  const [editForm, setEditForm] = useState({ endTime: '' });
  const [editLoading, setEditLoading] = useState(false);

  // Summary after clock-out
  const [shiftSummary, setShiftSummary] = useState<{
    employee_name: string; start_time: string; end_time: string; hours: number;
  } | null>(null);

  // Upload shift report
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  // Israel calendar date, not UTC — toISOString() rolls over 2-3 hours early
  // relative to Israel midnight, so a manager uploading "today's" report in
  // the early morning would otherwise see yesterday's date pre-filled.
  const [uploadDate, setUploadDate]   = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    imported: number; skipped: number;
    unmatched: string[]; details: { name: string; hours: number; date: string }[];
  } | null>(null);

  // QR Clock-in
  const [qrData, setQrData]       = useState<{ clockInUrl: string; expiresAt: string } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [showQr, setShowQr]       = useState(false);

  const loadQr = async () => {
    setQrLoading(true);
    try {
      const res = await shiftsApi.getQR();
      setQrData(res.data);
    } catch { setQrData(null); }
    finally { setQrLoading(false); }
  };

  // רענן QR כל 4.5 דקות (תוקפו 5 דקות)
  useEffect(() => {
    if (!showQr) return;
    loadQr();
    const interval = setInterval(loadQr, 4.5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [showQr]);

  const beginRequest = useLatestRequest();

  const load = (y = monthYear.y, m = monthYear.m) => {
    const latest = beginRequest();
    const from = monthStart(y, m);
    const to   = monthEnd(y, m);
    Promise.all([
      shiftsApi.list({ fromDate: from, toDate: to }),
      shiftsApi.openShifts(),
      shiftsApi.salaryPreview({ year: y, month: m + 1 }),
      employeesApi.list(),
    ]).then(([s, o, sp, emp]) => latest(() => {
      setShifts(s.data.shifts || []);
      setOpenShifts(o.data.shifts || []);
      setSalaryPreview(sp.data || null);
      const active = (emp.data.employees || []).filter((e: Employee & { is_active: boolean }) => e.is_active);
      setEmployees(active);
      // allUsers = all roles (including owner/manager) for open-shift selector
      setAllUsers(emp.data.employees || []);
      setLoading(false);
    })).catch(() => latest(() => setLoading(false)));
  };

  useEffect(() => { load(); }, [monthYear]);
  useSyncEvent(['shift_opened', 'shift_closed', 'employee.updated'], () => load());

  // Load labor law alerts once on mount
  useEffect(() => {
    setAlertsLoading(true);
    employeesApi.laborAlerts()
      .then(r => setLaborAlerts(r.data.alerts || []))
      .catch(() => {})
      .finally(() => setAlertsLoading(false));
  }, []);

  // ── Month navigation ──
  const prevMonth = () => setMonthYear(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 });
  const nextMonth = () => {
    const n = new Date(); n.setDate(1);
    const cur = new Date(monthYear.y, monthYear.m, 1);
    if (cur >= n) return; // don't go to future
    setMonthYear(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 });
  };
  const isCurrentMonth = monthYear.y === now.getFullYear() && monthYear.m === now.getMonth();

  // ── Open shift ──
  const openNewShift = () => {
    const d = new Date(); d.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const localNow = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setShiftForm({ employeeId: allUsers[0]?.id || '', startTime: localNow, notes: '' });
    setShiftError('');
    setShowModal(true);
  };

  const createShift = async () => {
    if (!shiftForm.employeeId) { setShiftError('יש לבחור עובד'); return; }
    setShiftLoading(true); setShiftError('');
    try {
      await shiftsApi.openForEmployee({ employeeId: shiftForm.employeeId, startTime: shiftForm.startTime });
      setShowModal(false);
      load();
    } catch (err) { setShiftError(getErrorMessage(err)); }
    finally { setShiftLoading(false); }
  };

  // ── Clock out ──
  const openClockOutModal = () => {
    if (openShifts.length === 0) return;
    setClockOutId(openShifts[0].id);
    setShowClockOut(true);
  };

  const clockOut = async (shiftId: string) => {
    try {
      const shift = openShifts.find(s => s.id === shiftId);
      const endTime = new Date();
      // סוגר משמרת ספציפית לפי ID (מנהל) — לא את המשמרת של המשתמש המחובר
      const { data: updated } = await shiftsApi.update(shiftId, { actualEnd: endTime.toISOString() });
      setShowClockOut(false);
      if (shift) {
        setShiftSummary({
          employee_name: shift.employee_name ?? '',
          start_time: shift.start_time,
          end_time: updated?.actual_end || endTime.toISOString(),
          hours: (endTime.getTime() - new Date(shift.start_time).getTime()) / 3600000,
        });
      }
      load();
    } catch (err) { toast(getErrorMessage(err)); }
  };

  // ── Edit shift ──
  const openEdit = (shift: Shift) => {
    setEditShift(shift);
    setEditForm({
      endTime: shift.end_time ? new Date(shift.end_time).toISOString().slice(0, 16) : '',
    });
  };

  const saveEdit = async () => {
    if (!editShift) return;
    setEditLoading(true);
    try {
      await shiftsApi.update(editShift.id, {
        endTime: editForm.endTime || null,
      });
      setEditShift(null);
      load();
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setEditLoading(false); }
  };

  const deleteShift = async (shift: Shift) => {
    if (!await confirm(`האם למחוק משמרת של ${shift.employee_name}?`, 'מחיקת משמרת')) return;
    try { await shiftsApi.delete(shift.id); load(); }
    catch (err) { toast(getErrorMessage(err)); }
  };

  const openUploadModal = () => {
    setUploadFile(null);
    setUploadDate(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
    setUploadResult(null);
    setShowUploadModal(true);
  };

  const handleUploadShifts = async () => {
    if (!uploadFile) return;
    setUploadLoading(true);
    setUploadResult(null);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('reportDate', uploadDate);
      const { data } = await shiftsApi.uploadReport(fd);
      setUploadResult(data);
      if (data.imported > 0) load();
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setUploadLoading(false); }
  };

  // Group shifts by employee for the month — keyed by employee_id (not name),
  // so two employees sharing a full name don't get their hours merged together.
  const byEmployee: Record<string, { name: string; shifts: Shift[]; totalHours: number }> = {};
  for (const sh of shifts) {
    const key = sh.employee_id ?? sh.employee_name ?? 'unknown';
    const empName = sh.employee_name ?? 'unknown';
    if (!byEmployee[key]) byEmployee[key] = { name: empName, shifts: [], totalHours: 0 };
    const h = sh.hours_worked != null
      ? Number(sh.hours_worked)
      : sh.end_time
        ? (new Date(sh.end_time).getTime() - new Date(sh.start_time).getTime()) / 3600000
        : 0;
    byEmployee[key].shifts.push(sh);
    byEmployee[key].totalHours += h;
  }
  const totalMonthHours = Object.values(byEmployee).reduce((s, e) => s + e.totalHours, 0);

  const errorAlerts   = laborAlerts.filter(a => a.severity === 'error');
  const warningAlerts = laborAlerts.filter(a => a.severity === 'warning');
  const infoAlerts    = laborAlerts.filter(a => a.severity === 'info');

  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Labor Law Alert Banner ── */}
      {!alertsLoading && laborAlerts.length > 0 && showAlerts && (
        <div className="rounded-2xl border overflow-hidden"
          style={{ borderColor: errorAlerts.length ? '#ef4444' : warningAlerts.length ? '#f59e0b' : '#3b82f6',
                   background: errorAlerts.length ? 'rgba(239,68,68,0.08)' : warningAlerts.length ? 'rgba(245,158,11,0.08)' : 'rgba(59,130,246,0.08)' }}>
          <div className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" style={{ color: errorAlerts.length ? '#ef4444' : warningAlerts.length ? '#f59e0b' : '#3b82f6' }} />
              <span className="font-semibold text-sm">
                {errorAlerts.length > 0
                  ? `${errorAlerts.length} הפרות חוק עבודה חמורות`
                  : warningAlerts.length > 0
                  ? `${warningAlerts.length} אזהרות חוק עבודה`
                  : `${infoAlerts.length} תזכורות חוק עבודה`}
              </span>
              <span className="text-xs opacity-60">— 14 הימים האחרונים</span>
            </div>
            <button onClick={() => setShowAlerts(false)} className="p-1 rounded-lg opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-4 py-3 space-y-2 max-h-48 overflow-y-auto">
            {laborAlerts.slice(0, 10).map((alert, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {alert.severity === 'error'   && <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                {alert.severity === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />}
                {alert.severity === 'info'    && <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />}
                <span className="opacity-80">{alert.message}</span>
              </div>
            ))}
            {laborAlerts.length > 10 && (
              <p className="text-xs opacity-50 text-center">ועוד {laborAlerts.length - 10} התראות נוספות...</p>
            )}
          </div>
        </div>
      )}
      {!alertsLoading && laborAlerts.length === 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm"
          style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80' }}>
          <CheckCircle className="w-4 h-4" />
          <span>לא נמצאו הפרות חוק עבודה ב-14 הימים האחרונים</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">משמרות</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">{monthLabel(monthYear.y, monthYear.m)}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={async () => {
            try { const { data } = await exportApi.shifts(); downloadBlob(data, 'משמרות.xlsx'); }
            catch (err) { toast(getErrorMessage(err)); }
          }}>
            <Download className="w-4 h-4" /> ייצוא Excel
          </Button>
          <Button variant="outline" onClick={openUploadModal}>
            <Upload className="w-4 h-4" /> העלה דוח משמרות
          </Button>
          <Button variant="outline" onClick={openClockOutModal}>
            <LogOut className="w-4 h-4" /> יציאה ממשמרת
            {openShifts.length > 0 && (
              <span className="mr-1 bg-green-600 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">{openShifts.length}</span>
            )}
          </Button>
          <Button variant="outline" onClick={() => setShowQr(v => !v)}>
            <QrCode className="w-4 h-4" /> כניסה ב-QR
          </Button>
          <Button onClick={openNewShift}>
            <Plus className="w-4 h-4" /> פתח משמרת
          </Button>
        </div>
      </div>

      {/* QR Clock-in panel */}
      {showQr && (
        <div className="rounded-2xl p-5 flex flex-col sm:flex-row items-center gap-5"
          style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
          <div className="flex-shrink-0">
            {qrLoading || !qrData ? (
              <div className="w-36 h-36 rounded-xl flex items-center justify-center bg-[#1a1a20]">
                <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
              </div>
            ) : (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=144x144&data=${encodeURIComponent(qrData.clockInUrl)}`}
                alt="QR כניסה למשמרת"
                className="w-36 h-36 rounded-xl border-4 border-white shadow"
              />
            )}
          </div>
          <div className="text-center sm:text-right">
            <h3 className="font-bold text-[#e8e8e4] text-lg flex items-center gap-2 justify-center sm:justify-start">
              <QrCode className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
              כניסה ל-QR
            </h3>
            <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">העובד סורק עם הטלפון ונכנס בלחיצה אחת — ללא GPS</p>
            {qrData && (
              <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1">
                תוקף עד: {new Date(qrData.expiresAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <button onClick={loadQr} disabled={qrLoading}
              className="mt-3 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: 'var(--tag-bg)', color: 'var(--color-primary)' }}>
              <RefreshCw className={`w-3.5 h-3.5 ${qrLoading ? 'animate-spin' : ''}`} />
              רענן QR
            </button>
          </div>
        </div>
      )}

      {/* Month navigator */}
      <div className="flex items-center gap-3">
        <button onClick={prevMonth}
          className="p-2 rounded-xl border border-[rgba(201,162,39,0.16)] hover:bg-[rgba(201,162,39,0.06)] transition-colors">
          <ChevronRight className="w-4 h-4 text-[rgba(232,232,228,0.55)]" />
        </button>
        <div className="flex-1 text-center">
          <p className="font-bold text-[#e8e8e4]">{monthLabel(monthYear.y, monthYear.m)}</p>
        </div>
        <button onClick={nextMonth} disabled={isCurrentMonth}
          className="p-2 rounded-xl border border-[rgba(201,162,39,0.16)] hover:bg-[rgba(201,162,39,0.06)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronLeft className="w-4 h-4 text-[rgba(232,232,228,0.55)]" />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title="משמרות פעילות" value={openShifts.length} icon={Clock}
          iconColor="text-blue-600" iconBg="bg-blue-50" />
        <StatCard title={`משמרות — ${monthLabel(monthYear.y, monthYear.m)}`} value={shifts.length} icon={Calendar}
          iconColor="text-purple-600" iconBg="bg-purple-50" />
        <StatCard title="שכר צפוי החודש" value={formatCurrency(salaryPreview?.total_gross || 0)}
          icon={CheckCircle} iconColor="text-green-600" iconBg="bg-green-50" />
      </div>

      {/* Open shifts */}
      {openShifts.length > 0 && (
        <Card>
          <CardHeader><CardTitle>משמרות פתוחות כעת</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {openShifts.map(shift => (
              <div key={shift.id} className="flex items-center justify-between p-3 bg-green-900/15 rounded-xl">
                <div>
                  <p className="text-sm font-medium text-[#e8e8e4]">{shift.employee_name}</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)]">
                    התחיל: {new Date(shift.start_time).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} {new Date(shift.start_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ·{' '}
                    {((Date.now() - new Date(shift.start_time).getTime()) / 3600000).toFixed(1)} שעות
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => clockOut(shift.id)}>
                  <LogOut className="w-4 h-4" /> סיים
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Shifts table grouped by employee */}
      <Card>
        {loading ? (
          <div className="p-8 text-center text-gray-400">טוען...</div>
        ) : shifts.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            אין משמרות ב{monthLabel(monthYear.y, monthYear.m)}
          </div>
        ) : (
          <div className="divide-y divide-[rgba(201,162,39,0.14)]">
            {Object.entries(byEmployee).map(([empKey, { name, shifts: empShifts, totalHours }]) => (
              <details key={empKey} className="group">
                <summary className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-[rgba(201,162,39,0.06)] list-none">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {name.charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#e8e8e4]">{name}</p>
                      <p className="text-xs text-[rgba(232,232,228,0.42)]">{empShifts.length} משמרות</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-bold text-green-400">{totalHours.toFixed(1)} שעות</span>
                    <ChevronRight className="w-4 h-4 text-[rgba(232,232,228,0.42)] group-open:-rotate-90 transition-transform" />
                  </div>
                </summary>
                <div className="overflow-x-auto border-t border-[rgba(201,162,39,0.08)]">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-[#1a1a20]">
                        {['תאריך', 'כניסה', 'יציאה', 'שעות', 'תשלום', 'סטטוס', ''].map(h => (
                          <th key={h} className="text-right text-xs font-medium text-[rgba(232,232,228,0.42)] px-6 py-2">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                      {empShifts.map(shift => {
                        const h = shift.hours_worked != null
                          ? Number(shift.hours_worked).toFixed(1)
                          : shift.end_time
                            ? ((new Date(shift.end_time).getTime() - new Date(shift.start_time).getTime()) / 3600000).toFixed(1)
                            : '—';
                        return (
                          <tr key={shift.id} className="hover:bg-[rgba(201,162,39,0.06)]">
                            <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.72)]">
                              {new Date(shift.start_time).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', weekday: 'short' })}
                            </td>
                            <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.55)]">
                              {new Date(shift.start_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </td>
                            <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.55)]">
                              {shift.end_time
                                ? new Date(shift.end_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                                : '—'}
                            </td>
                            <td className="px-6 py-3 text-sm font-medium text-[rgba(232,232,228,0.72)]">{h}</td>
                            <td className="px-6 py-3 text-sm font-medium">
                              {shift.gross_pay ? formatCurrency(shift.gross_pay) : '—'}
                            </td>
                            <td className="px-6 py-3">
                              <Badge variant={shift.is_open ? 'success' : 'default'}>
                                {shift.is_open ? 'פעיל' : 'סגור'}
                              </Badge>
                            </td>
                            <td className="px-6 py-3">
                              <div className="flex items-center gap-1">
                                <button onClick={() => openEdit(shift)}
                                  className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors">
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button onClick={() => deleteShift(shift)}
                                  className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>

      {/* Salary breakdown */}
      {salaryPreview && salaryPreview.breakdown.length > 0 && (
        <Card>
          <CardHeader><CardTitle>פירוט שכר — {monthLabel(monthYear.y, monthYear.m)}</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {salaryPreview.breakdown.map(emp => (
                <div key={emp.employee_name} className="flex items-center justify-between py-2 border-b border-[rgba(201,162,39,0.08)] last:border-0">
                  <div>
                    <p className="text-sm font-medium text-[#e8e8e4]">{emp.employee_name}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.42)]">{emp.hours.toFixed(1)} שעות</p>
                  </div>
                  <span className="text-sm font-semibold text-[#e8e8e4]">{formatCurrency(emp.gross)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 font-semibold">
                <span className="text-sm">סה״כ</span>
                <span className="text-sm">{formatCurrency(salaryPreview.total_gross)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Modal: פתח משמרת ── */}
      <Modal open={showModal} onClose={() => setShowModal(false)} title="פתיחת משמרת לעובד">
        <div className="p-6 space-y-4" dir="rtl">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)]">עובד</label>
            <select
              className="block w-full rounded-xl border border-[rgba(201,162,39,0.16)] bg-[#1a1a20] text-[#e8e8e4] px-3 py-2.5 text-sm focus:border-[rgba(201,162,39,0.4)] focus:outline-none"
              value={shiftForm.employeeId}
              onChange={e => setShiftForm(f => ({ ...f, employeeId: e.target.value }))}
            >
              <option value="">בחר עובד</option>
              {allUsers.map(e => (
                <option key={e.id} value={e.id}>{e.full_name}</option>
              ))}
            </select>
          </div>
          <Input
            label="שעת התחלה"
            type="datetime-local"
            value={shiftForm.startTime}
            onChange={e => setShiftForm(f => ({ ...f, startTime: e.target.value }))}
          />
          <Input
            label="הערות (אופציונלי)"
            value={shiftForm.notes}
            onChange={e => setShiftForm(f => ({ ...f, notes: e.target.value }))}
          />
          {shiftError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{shiftError}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowModal(false)}>ביטול</Button>
            <Button onClick={createShift} loading={shiftLoading}>
              <Plus className="w-4 h-4" /> פתח משמרת
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Modal: יציאה ממשמרת ── */}
      <Modal open={showClockOut} onClose={() => setShowClockOut(false)} title="סיום משמרת" size="sm">
        <div className="p-6 space-y-4" dir="rtl">
          {openShifts.length === 0 ? (
            <p className="text-sm text-[rgba(232,232,228,0.42)] text-center py-4">אין משמרות פתוחות כעת</p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)]">בחר עובד לסיום משמרת</label>
                <select
                  className="block w-full rounded-xl border border-[rgba(201,162,39,0.16)] bg-[#1a1a20] text-[#e8e8e4] px-3 py-2.5 text-sm focus:border-[rgba(201,162,39,0.4)] focus:outline-none"
                  value={clockOutId}
                  onChange={e => setClockOutId(e.target.value)}
                >
                  {openShifts.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.employee_name} — התחיל {new Date(s.start_time).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </option>
                  ))}
                </select>
              </div>
              {clockOutId && (() => {
                const s = openShifts.find(s => s.id === clockOutId);
                if (!s) return null;
                const hours = ((Date.now() - new Date(s.start_time).getTime()) / 3600000).toFixed(1);
                return (
                  <div className="bg-green-50 rounded-xl px-4 py-3 text-sm text-green-800">
                    <p className="font-semibold">{s.employee_name}</p>
                    <p className="text-xs text-green-600 mt-0.5">כניסה: {new Date(s.start_time).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {hours} שעות</p>
                  </div>
                );
              })()}
              <div className="flex justify-end gap-3 pt-1">
                <Button variant="outline" onClick={() => setShowClockOut(false)}>ביטול</Button>
                <Button onClick={() => clockOut(clockOutId)} disabled={!clockOutId}>
                  <LogOut className="w-4 h-4" /> סיים משמרת
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── Modal: עריכת משמרת ── */}
      <Modal open={!!editShift} onClose={() => setEditShift(null)}
        title={`עריכת משמרת — ${editShift?.employee_name}`}>
        <div className="p-6 space-y-4">
          <Input
            label="זמן סיום"
            type="datetime-local"
            value={editForm.endTime}
            onChange={e => setEditForm(f => ({ ...f, endTime: e.target.value }))}
          />
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setEditShift(null)}>ביטול</Button>
            <Button onClick={saveEdit} loading={editLoading}>שמור</Button>
          </div>
        </div>
      </Modal>

      {/* ── Modal: העלאת דוח משמרות ── */}
      <Modal open={showUploadModal} onClose={() => setShowUploadModal(false)} title="העלאת דוח משמרות ידני">
        <div className="p-6 space-y-5" dir="rtl">

          {!uploadResult ? (
            <>
              {/* Explainer */}
              <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.18)', color: 'rgba(147,197,253,0.9)' }}>
                <p className="font-medium mb-1">מתי להשתמש בכלי זה?</p>
                <p className="text-xs opacity-80">כשדוחות ה-Z שהועלו לא הכילו גיליון משמרות, ניתן לייבא קובץ Excel/CSV נפרד שמוצא מחברת הקופה ומכיל את שמות העובדים ושעות העבודה. המשמרות ייוספו אוטומטית לחישובי שכר ודוחות.</p>
              </div>

              {/* File picker */}
              <div>
                <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)] mb-2">קובץ משמרות (Excel / CSV)</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv,.txt"
                  className="hidden"
                  onChange={e => setUploadFile(e.target.files?.[0] || null)}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed rounded-xl px-4 py-6 text-center transition-colors"
                  style={{ borderColor: uploadFile ? 'rgba(201,162,39,0.5)' : 'rgba(201,162,39,0.2)', background: uploadFile ? 'rgba(201,162,39,0.06)' : 'transparent' }}
                >
                  {uploadFile ? (
                    <div className="flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--color-primary)' }}>
                      <CheckCircle className="w-5 h-5" />
                      <span className="font-medium">{uploadFile.name}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-[rgba(232,232,228,0.42)]">
                      <Upload className="w-8 h-8" />
                      <span className="text-sm">לחץ לבחירת קובץ xlsx / xls / csv</span>
                    </div>
                  )}
                </button>
              </div>

              {/* Fallback date */}
              <div>
                <Input
                  label="תאריך דוח (ישמש כשהקובץ לא מכיל תאריכים)"
                  type="date"
                  value={uploadDate}
                  onChange={e => setUploadDate(e.target.value)}
                />
                <p className="text-xs text-[rgba(232,232,228,0.35)] mt-1">אם בכל שורה בקובץ יש תאריך — הוא ישמש. תאריך זה הוא גיבוי בלבד.</p>
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <Button variant="outline" onClick={() => setShowUploadModal(false)}>ביטול</Button>
                <Button onClick={handleUploadShifts} disabled={!uploadFile} loading={uploadLoading}>
                  <Upload className="w-4 h-4" /> ייבא משמרות
                </Button>
              </div>
            </>
          ) : (
            /* Results */
            <div className="space-y-4">
              {/* Summary pills */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'יובאו', value: uploadResult.imported, color: '#4ade80', bg: 'rgba(74,222,128,0.1)' },
                  { label: 'כפולות', value: uploadResult.skipped, color: 'rgba(232,232,228,0.5)', bg: 'rgba(232,232,228,0.06)' },
                  { label: 'לא זוהו', value: uploadResult.unmatched.length, color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
                ].map(({ label, value, color, bg }) => (
                  <div key={label} className="rounded-xl px-3 py-3 text-center" style={{ background: bg }}>
                    <p className="text-2xl font-black" style={{ color }}>{value}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'rgba(232,232,228,0.5)' }}>{label}</p>
                  </div>
                ))}
              </div>

              {/* Matched details */}
              {uploadResult.details.length > 0 && (
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(74,222,128,0.15)' }}>
                  <div className="px-4 py-2 text-xs font-semibold" style={{ background: 'rgba(74,222,128,0.08)', color: '#4ade80' }}>
                    <UserCheck className="w-3.5 h-3.5 inline ml-1" />משמרות שיובאו
                  </div>
                  <div className="divide-y divide-[rgba(201,162,39,0.08)] max-h-48 overflow-y-auto">
                    {uploadResult.details.map((d, i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                        <span className="text-[rgba(232,232,228,0.72)]">{d.name}</span>
                        <span className="text-[rgba(232,232,228,0.42)] text-xs">{new Date(d.date).toLocaleDateString('he-IL')} · {d.hours.toFixed(1)} שעות</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Unmatched */}
              {uploadResult.unmatched.length > 0 && (
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(248,113,113,0.2)' }}>
                  <div className="px-4 py-2 text-xs font-semibold" style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
                    <UserX className="w-3.5 h-3.5 inline ml-1" />עובדים שלא זוהו — בדוק שמות בהגדרות עובדים
                  </div>
                  <div className="divide-y divide-[rgba(201,162,39,0.08)]">
                    {uploadResult.unmatched.map((name, i) => (
                      <div key={i} className="px-4 py-2 text-sm text-[rgba(232,232,228,0.55)]">{name}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <Button variant="outline" onClick={() => setUploadResult(null)}>העלה קובץ נוסף</Button>
                <Button onClick={() => setShowUploadModal(false)}>סגור</Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* ── Modal: סיכום משמרת ── */}
      <Modal open={!!shiftSummary} onClose={() => setShiftSummary(null)} title="סיכום משמרת" size="sm">
        {shiftSummary && (
          <div className="p-6 space-y-4" dir="rtl">
            <div className="flex items-center justify-center">
              <div className="w-16 h-16 rounded-full flex items-center justify-center bg-green-100">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
            </div>
            <p className="text-center text-lg font-bold text-[#e8e8e4]">{shiftSummary.employee_name}</p>
            <div className="bg-[#1a1a20] rounded-xl divide-y divide-[rgba(201,162,39,0.08)]">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-[rgba(232,232,228,0.42)]">כניסה</span>
                <span className="text-sm font-semibold">{new Date(shiftSummary.start_time).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-[rgba(232,232,228,0.42)]">יציאה</span>
                <span className="text-sm font-semibold">{new Date(shiftSummary.end_time).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-[rgba(232,232,228,0.42)]">סה״כ</span>
                <span className="text-base font-bold text-green-700">{shiftSummary.hours.toFixed(2)} שעות</span>
              </div>
            </div>
            <div className="flex justify-center pt-1">
              <Button onClick={() => setShiftSummary(null)}>סגור</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
