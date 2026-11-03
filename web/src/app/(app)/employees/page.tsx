'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Plus, Search, Mail, Phone, UserCheck, UserX, Pencil, Trash2, Send, Download, ChevronDown, ChevronUp, Loader2, RefreshCw, FileBarChart2, ClipboardList, X } from 'lucide-react';
import { employeesApi, exportApi, posApi, tipsApi } from '@/lib/api';
import api from '@/lib/api/client';
import { formatCurrency, getInitials, getErrorMessage, downloadBlob } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { useAppDialog } from '@/context/AppDialogContext';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Employee } from '@/types';
import { useSyncEvent } from '@/context/SyncContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { todayIL } from '@/lib/dates';

// ── Form 101 helpers ───────────────────────────────────────────────────────────
const f101InputCls = 'w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40 border border-amber-900/30 bg-[#111116] text-[#e8e8e4]';

function SectionTitle({ children, badge }: { children: React.ReactNode; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      {badge && (
        <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ background: 'var(--color-primary)' }}>{badge}</span>
      )}
      <h3 className="text-sm font-bold text-slate-700">{children}</h3>
      <div className="flex-1 h-px bg-slate-100" />
    </div>
  );
}

function F101Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-semibold text-slate-500">{label}</label>
      {children}
    </div>
  );
}

const ROLES = [
  { value: 'manager',     label: 'מנהל',           group: 'ניהול' },
  { value: 'chef',        label: 'שף',              group: 'מטבח' },
  { value: 'sous_chef',   label: 'סו-שף',           group: 'מטבח' },
  { value: 'cook',        label: 'טבח',             group: 'מטבח' },
  { value: 'prep_cook',   label: 'עוזר טבח',        group: 'מטבח' },
  { value: 'pastry',      label: 'קונדיטור',        group: 'מטבח' },
  { value: 'dishwasher',  label: 'שוטף כלים',       group: 'מטבח' },
  { value: 'waiter',      label: 'מלצר',            group: 'שירות' },
  { value: 'head_waiter', label: 'ראש מלצרים',      group: 'שירות' },
  { value: 'bartender',   label: 'ברמן',            group: 'שירות' },
  { value: 'host',        label: 'מארח/ת',          group: 'שירות' },
  { value: 'cashier',     label: 'קופאי',           group: 'שירות' },
  { value: 'delivery',    label: 'שליח',            group: 'לוגיסטיקה' },
  { value: 'cleaner',     label: 'מנקה',            group: 'תפעול' },
  { value: 'employee',    label: 'עובד כללי',       group: 'תפעול' },
] as const;

type RoleValue = typeof ROLES[number]['value'];

const roleLabels: Record<string, string> = Object.fromEntries(
  [...ROLES.map(r => [r.value, r.label]), ['owner', 'בעלים']]
);

// Group roles for the select
const ROLE_GROUPS = [...new Set(ROLES.map(r => r.group))];

const schema = z.object({
  full_name: z.string().min(2, 'שם חייב להכיל לפחות 2 תווים'),
  email: z.string().email('אימייל לא תקין'),
  phone: z.string().optional(),
  role: z.custom<RoleValue>(),
  salary_type: z.enum(['hourly', 'global', 'tips']),
  hourly_rate: z.string().optional(),
  global_salary: z.string().optional(),
  participates_in_tips: z.boolean().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.salary_type === 'hourly') {
    const v = parseFloat(data.hourly_rate || '');
    if (isNaN(v) || v <= 0) ctx.addIssue({ code: 'custom', path: ['hourly_rate'], message: 'הכנס תעריף שעתי תקין' });
  } else if (data.salary_type === 'global') {
    const v = parseFloat(data.global_salary || '');
    if (isNaN(v) || v <= 0) ctx.addIssue({ code: 'custom', path: ['global_salary'], message: 'הכנס שכר חודשי תקין' });
  }
  // שם משתמש וסיסמה — או שניהם או אף אחד
  if ((data.username && !data.password) || (!data.username && data.password)) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'יש למלא גם שם משתמש וגם סיסמה, או להשאיר את שניהם ריקים' });
  }
  if (data.username && !/^[a-z0-9._-]{3,50}$/i.test(data.username)) {
    ctx.addIssue({ code: 'custom', path: ['username'], message: 'שם משתמש: 3-50 תווים, אותיות/מספרים באנגלית בלבד' });
  }
  if (data.password && data.password.length < 8) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: 'סיסמה חייבת להכיל לפחות 8 תווים' });
  }
});

type FormData = z.infer<typeof schema>;

// ── Z Report Employee types ────────────────────────────────────────────────────
interface ZEmployee {
  employee_name: string;
  employee_id: string | null;
  full_name: string | null;
  email: string | null;
  is_active: boolean | null;
  shifts_count: string;
  total_hours: string;
  first_shift: string;
  last_shift: string;
  shifts_log: Array<{ date: string; hours: number }>;
}


// ── Tips types ─────────────────────────────────────────────────────────────────
interface TipDistribution { employee_id: string; employee_name: string; hours_worked: number; amount: number; }
interface TipEntry {
  id: string; entry_date: string; shift_label: string | null;
  shift_start: string | null; shift_end: string | null;
  total_amount: number; notes: string | null;
  distributions: TipDistribution[] | null;
}
interface TipPreview { distributions: TipDistribution[]; totalHours: number; totalAmount: number; }

// ── Form 101 types ─────────────────────────────────────────────────────────────
interface Form101Data {
  idNumber: string; birthDate: string; gender: string; maritalStatus: string; numChildren: string;
  addressCity: string; addressStreet: string; addressNum: string; addressZip: string;
  bankName: string; bankBranch: string; bankAccount: string;
  startDate: string; employmentScope: string; taxCreditPoints: string; notes: string;
}

const BANKS = ['בנק הפועלים','בנק לאומי','בנק דיסקונט','בנק מזרחי טפחות','הבנק הבינלאומי','בנק יהב','בנק מסד','בנק אוצר החייל','בנק אגוד','בנק ירושלים','פאגי','ONE ZERO'];
const MARITAL = ['רווק/ה','נשוי/ה','גרוש/ה','אלמן/ה'];

export default function EmployeesPage() {
  const { confirm, toast } = useAppDialog();
  const [tab, setTab] = useState<'manage' | 'zreport' | 'tips'>('manage');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [filtered, setFiltered] = useState<Employee[]>([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  // ניהול מציג כברירת מחדל רק עובדים פעילים (מי שעובד בפועל היום) — שעות Z
  // ממילא מציג היסטוריה מלאה תמיד (נגזר משיבוצי Z, לא מטבלת המשתמשים).
  // המתג הזה נותן גישה חזרה לעובדים לא-פעילים כשצריך (למשל כדי להפעיל מחדש).
  const [showInactive, setShowInactive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [zEmployees, setZEmployees] = useState<ZEmployee[]>([]);
  const [zLoading, setZLoading] = useState(false);
  const [zSyncing, setZSyncing] = useState(false);
  const [unmatchedShifts, setUnmatchedShifts] = useState(0);
  const [zOpenRow, setZOpenRow] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteMsg, setInviteMsg] = useState('');
  const [exporting, setExporting] = useState(false);

  // Monthly hours
  const now = new Date();
  const [hoursMonth, setHoursMonth] = useState(now.getMonth() + 1);
  const [hoursYear, setHoursYear]   = useState(now.getFullYear());
  const [monthlyHours, setMonthlyHours] = useState<Record<string, number>>({});

  // ── Tips tab state ────────────────────────────────────────────────────────
  const now2 = new Date();
  const [tipsMonth, setTipsMonth] = useState(now2.getMonth() + 1);
  const [tipsYear,  setTipsYear]  = useState(now2.getFullYear());
  const [tipEntries, setTipEntries] = useState<TipEntry[]>([]);
  const [tipsLoading, setTipsLoading] = useState(false);
  const [tipForm, setTipForm] = useState({
    entry_date: todayIL(),
    shift_label: '', shift_start: '', shift_end: '',
    total_amount: '', notes: '',
  });
  const [tipPreview, setTipPreview] = useState<TipPreview | null>(null);
  const [tipPreviewing, setTipPreviewing] = useState(false);
  const [tipSaving, setTipSaving] = useState(false);
  const [showAdvancedTips, setShowAdvancedTips] = useState(false);

  // ── Wizard state ─────────────────────────────────────────────────────────
  interface WizardEmployee { id: string; full_name: string; position: string; }
  const [showWizard, setShowWizard]           = useState(false);
  const [wizardEmployees, setWizardEmployees] = useState<WizardEmployee[]>([]);
  const [wizardSelected, setWizardSelected]   = useState<Set<string>>(new Set());
  const [wizardSaving, setWizardSaving]       = useState(false);

  const openWizardIfNeeded = useCallback(async () => {
    try {
      const { data } = await tipsApi.poolStatus();
      if (!data.configured && data.suggestions?.length > 0) {
        setWizardEmployees(data.suggestions);
        setWizardSelected(new Set(data.suggestions.map((e: WizardEmployee) => e.id)));
        setShowWizard(true);
      }
    } catch { /* silent — wizard is best-effort */ }
  }, []);

  const submitWizard = async () => {
    setWizardSaving(true);
    try {
      await tipsApi.poolSetup([...wizardSelected]);
      setShowWizard(false);
      load(); // refresh employee list to show updated badges
      toast(`${wizardSelected.size} עובדים נוספו ל-pool הטיפים`, 'success');
    } catch (err) {
      toast(getErrorMessage(err) || 'שגיאה בשמירת הגדרות הטיפים', 'error');
    } finally { setWizardSaving(false); }
  };

  const loadTipEntries = useCallback(() => {
    setTipsLoading(true);
    tipsApi.list({ month: tipsMonth, year: tipsYear })
      .then(r => setTipEntries(r.data?.entries || []))
      .catch(() => setTipEntries([]))
      .finally(() => setTipsLoading(false));
  }, [tipsMonth, tipsYear]);

  useEffect(() => {
    if (tab === 'tips') {
      loadTipEntries();
      openWizardIfNeeded();
    }
  }, [tab, tipsMonth, tipsYear, loadTipEntries, openWizardIfNeeded]);

  const previewTips = async () => {
    if (!tipForm.entry_date || !tipForm.total_amount) return;
    setTipPreviewing(true);
    setTipPreview(null);
    try {
      const { data } = await tipsApi.preview({
        entry_date:   tipForm.entry_date,
        shift_start:  tipForm.shift_start || undefined,
        shift_end:    tipForm.shift_end   || undefined,
        total_amount: parseFloat(tipForm.total_amount),
      });
      setTipPreview(data);
    } catch (err) {
      toast(getErrorMessage(err) || 'שגיאה בחישוב חלוקת טיפים', 'error');
    } finally { setTipPreviewing(false); }
  };

  const saveTips = async () => {
    if (!tipPreview || !tipPreview.distributions.length) return;
    setTipSaving(true);
    try {
      await tipsApi.create({
        entry_date:   tipForm.entry_date,
        shift_label:  tipForm.shift_label  || undefined,
        shift_start:  tipForm.shift_start  || undefined,
        shift_end:    tipForm.shift_end    || undefined,
        total_amount: parseFloat(tipForm.total_amount),
        notes:        tipForm.notes        || undefined,
      });
      toast('טיפים נשמרו בהצלחה', 'success');
      setTipPreview(null);
      setTipForm(f => ({ ...f, total_amount: '', notes: '', shift_label: '', shift_start: '', shift_end: '' }));
      loadTipEntries();
    } catch (err) {
      const errData = (err as { response?: { data?: { noEligibleEmployees?: boolean } } })?.response?.data;
      if (errData?.noEligibleEmployees) {
        toast('לא נמצאו עובדים זכאים — ודא שהמשמרות סומנו כ"הסתיימו" ושהעובדים מסומנים כמשתתפים בטיפים', 'error');
      } else {
        toast(getErrorMessage(err) || 'שמירת הטיפים נכשלה', 'error');
      }
    } finally { setTipSaving(false); }
  };

  const deleteTipEntry = async (id: string) => {
    if (!await confirm('למחוק הזנת טיפים זו?', 'מחיקת טיפים')) return;
    try {
      await tipsApi.delete(id);
      loadTipEntries();
      toast('הזנה נמחקה', 'success');
    } catch (err) { toast(getErrorMessage(err) || 'מחיקה נכשלה', 'error'); }
  };

  // Form 101
  const [show101, setShow101] = useState(false);
  const [form101Step, setForm101Step] = useState(1);
  const [form101EmpId, setForm101EmpId] = useState<string | null>(null);
  const [form101Loading, setForm101Loading] = useState(false);
  const [form101Data, setForm101Data] = useState<Form101Data>({
    idNumber: '', birthDate: '', gender: 'זכר', maritalStatus: 'רווק/ה', numChildren: '0',
    addressCity: '', addressStreet: '', addressNum: '', addressZip: '',
    bankName: 'בנק הפועלים', bankBranch: '', bankAccount: '',
    startDate: todayIL(), employmentScope: '100', taxCreditPoints: '2.25', notes: '',
  });
  // Basic info for new employee (step 1)
  const [basicData, setBasicData] = useState({ fullName: '', email: '', phone: '', role: 'employee', salaryType: 'hourly', salaryAmount: '', username: '', password: '' });

  const { register, handleSubmit, watch, reset, setValue, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'employee', salary_type: 'hourly' },
  });

  const salaryType = watch('salary_type');

  const beginRequest = useLatestRequest();

  const load = useCallback(() => {
    // Supersedes the previous isMounted() check: toggling "show inactive"
    // refires this, and the guard now drops a stale response as well as one
    // that arrives after unmount.
    const latest = beginRequest();
    Promise.all([
      employeesApi.list({ activeOnly: !showInactive }),
      api.get('/employees/z-shifts/unmatched').then(r => r.data).catch(() => ({ total: 0 })),
    ]).then(([{ data }, unmatchedData]) => latest(() => {
      setEmployees(data.employees || []);
      setUnmatchedShifts(unmatchedData.total || 0);
      setLoading(false);
    })).catch((err) => latest(() => {
      // No .catch() here used to leave the page stuck on "טוען..." forever
      // whenever the request failed for any reason — a real incident, not
      // a hypothetical.
      setLoading(false);
      toast(getErrorMessage(err) || 'שגיאה בטעינת רשימת העובדים', 'error');
    }));
  }, [showInactive, toast, beginRequest]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['shift_opened', 'shift_closed', 'employee.updated'], load);
  // Selection references rows by id — clear it whenever the visible set
  // could change out from under it (search, filter toggle, reload).
  useEffect(() => { setSelectedIds(new Set()); }, [showInactive, debouncedSearch]);

  useEffect(() => {
    const firstDay = `${hoursYear}-${String(hoursMonth).padStart(2, '0')}-01`;
    const lastDay  = new Date(hoursYear, hoursMonth, 0).getDate();
    const toDate   = `${hoursYear}-${String(hoursMonth).padStart(2, '0')}-${lastDay}`;
    api.get(`/employees/shifts?fromDate=${firstDay}&toDate=${toDate}`)
      .then(r => {
        const map: Record<string, number> = {};
        for (const s of (r.data?.shifts || [])) {
          const h = parseFloat(s.hours_worked) || 0;
          if (h > 0) map[s.employee_id] = (map[s.employee_id] || 0) + h;
        }
        setMonthlyHours(map);
      })
      .catch(() => setMonthlyHours({}));
  }, [hoursYear, hoursMonth]);

  const loadZEmployees = useCallback(() => {
    setZLoading(true);
    posApi.zreportEmployees()
      .then(r => setZEmployees(r.data?.employees || []))
      .catch(() => setZEmployees([]))
      .finally(() => setZLoading(false));
  }, []);

  useEffect(() => { if (tab === 'zreport') loadZEmployees(); }, [tab, loadZEmployees]);
  // Keeps the linked/active status badges correct if an employee is
  // activated/deactivated while this tab is already open, not just on next switch-to.
  useSyncEvent('employee.updated', () => { if (tab === 'zreport') loadZEmployees(); });

  useEffect(() => {
    const q = debouncedSearch.toLowerCase();
    setFiltered(employees.filter(
      (e) => (e.full_name || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)
    ));
  }, [debouncedSearch, employees]);

  const openEdit = (emp: Employee) => {
    setEditingEmp(emp);
    setValue('full_name', emp.full_name);
    setValue('email', emp.email ?? '');
    setValue('phone', emp.phone || '');
    setValue('role', (emp.position || (emp.role === 'owner' ? 'manager' : emp.role)) as RoleValue);
    const st = (emp.salary_type as 'hourly' | 'global' | 'tips') || 'hourly';
    setValue('salary_type', st);
    const amt = (emp.salary_amount ?? emp.hourly_rate ?? emp.global_salary ?? 0).toString();
    setValue('hourly_rate',   st === 'hourly' ? amt : '');
    setValue('global_salary', st === 'global' ? amt : '');
    setValue('participates_in_tips', !!(emp.participates_in_tips) || st === 'tips');
    setShowModal(true);
    setError('');
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingEmp(null);
    reset();
    setError('');
  };

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    setError('');
    try {
      // ממפה hourly_rate/global_salary → salaryAmount לפי salary_type
      // role ב-DB הוא רק דרג הרשאה (employee/manager) — התפקיד המפורט (שף/מלצר/...)
      // נשמר בנפרד בעמודת position
      const isTipsOnly = data.salary_type === 'tips';
      const payload: Record<string, unknown> = {
        fullName:            data.full_name,
        email:               data.email,
        phone:               data.phone,
        role:                data.role === 'manager' ? 'manager' : 'employee',
        position:            data.role,
        salaryType:          data.salary_type,
        salaryAmount:        isTipsOnly ? null : (data.salary_type === 'hourly' ? data.hourly_rate : data.global_salary),
        participatesInTips:  isTipsOnly ? true : (data.participates_in_tips ?? false),
      };
      // שם משתמש וסיסמה נקבעים רק ביצירת עובד חדש — לא בעריכה, כדי לא לדרוס
      // בטעות פרטי התחברות שהעובד כבר קבע לעצמו
      if (!editingEmp && data.username && data.password) {
        payload.username = data.username;
        payload.password = data.password;
      }
      if (editingEmp) {
        await employeesApi.update(editingEmp.id, payload);
      } else {
        await employeesApi.create(payload);
      }
      closeModal();
      toast(
        editingEmp
          ? 'עובד עודכן בהצלחה'
          : (data.username && data.password ? 'עובד נוסף — ניתן להתחבר מיד עם שם המשתמש והסיסמה' : 'עובד נוסף — הזמנה נשלחה למייל'),
        'success'
      );
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (emp: Employee) => {
    const msg = emp.is_active ? `להשבית את הגישה של ${emp.full_name}?` : `להפעיל מחדש את הגישה של ${emp.full_name}?`;
    if (!await confirm(msg, 'סטטוס עובד')) return;
    try {
      await employeesApi.update(emp.id, { is_active: !emp.is_active });
      load();
    } catch (err) { toast(getErrorMessage(err) || 'עדכון סטטוס העובד נכשל', 'error'); }
  };

  // סימון מספר עובדים כלא-פעילים/פעילים בבת אחת — נוגע רק ב-is_active,
  // לא בשכר/שעות, כדי שחישובי שכר לפי היסטוריית שעות Z ימשיכו לעבוד נכון
  // גם לעובדים שכבר לא עובדים בפועל.
  const bulkSetActive = async (isActive: boolean) => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const msg = isActive
      ? `להפעיל מחדש את הגישה של ${ids.length} עובדים?`
      : `להשבית את הגישה של ${ids.length} עובדים? (נתוני השכר וההיסטוריה שלהם לא יימחקו)`;
    if (!await confirm(msg, 'סטטוס עובדים')) return;
    try {
      const { data } = await employeesApi.bulkStatus(ids, isActive);
      setSelectedIds(new Set());
      load();
      toast(`${data.updated} עובדים עודכנו`, 'success');
    } catch (err) { toast(getErrorMessage(err) || 'עדכון הסטטוס נכשל', 'error'); }
  };

  const deleteEmployee = async (emp: Employee) => {
    if (!await confirm(`האם למחוק את ${emp.full_name}?`, 'מחיקת עובד')) return;
    try {
      await employeesApi.delete(emp.id);
      load();
    } catch (err) {
      toast(getErrorMessage(err));
    }
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const { data } = await exportApi.employees();
      downloadBlob(data, 'עובדים.xlsx');
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setExporting(false); }
  };

  const sendInvite = async (emp: Employee) => {
    setInviting(emp.id);
    setInviteMsg('');
    try {
      await employeesApi.invite(emp.id);
      setInviteMsg(`הזמנה נשלחה ל-${emp.email}`);
      setTimeout(() => setInviteMsg(''), 3000);
    } catch (err) {
      setInviteMsg(getErrorMessage(err));
    } finally {
      setInviting(null);
    }
  };

  const open101 = async (emp?: Employee) => {
    setForm101Step(emp ? 2 : 1);
    setForm101EmpId(emp?.id ?? null);
    setBasicData({ fullName: emp?.full_name ?? '', email: emp?.email ?? '', phone: emp?.phone ?? '', role: emp?.position || emp?.role || 'employee', salaryType: emp?.salary_type ?? 'hourly', salaryAmount: String(emp?.salary_amount ?? ''), username: '', password: '' });
    if (emp?.id) {
      try {
        const { data } = await api.get(`/employees/${emp.id}/form101`);
        if (data) {
          setForm101Data({
            idNumber: data.id_number ?? '', birthDate: data.birth_date?.slice(0, 10) ?? '',
            gender: data.gender ?? 'זכר', maritalStatus: data.marital_status ?? 'רווק/ה',
            numChildren: String(data.num_children ?? 0),
            addressCity: data.address_city ?? '', addressStreet: data.address_street ?? '',
            addressNum: data.address_num ?? '', addressZip: data.address_zip ?? '',
            bankName: data.bank_name ?? 'בנק הפועלים', bankBranch: data.bank_branch ?? '',
            bankAccount: data.bank_account ?? '', startDate: data.start_date?.slice(0, 10) ?? todayIL(),
            employmentScope: String(data.employment_scope ?? 100), taxCreditPoints: String(data.tax_credit_points ?? 2.25),
            notes: data.notes ?? '',
          });
        }
      } catch { /* no existing form */ }
    }
    setShow101(true);
  };

  const submit101Step1 = async () => {
    if (!basicData.fullName || !basicData.email || (basicData.salaryType !== 'tips' && !basicData.salaryAmount)) {
      toast('מלא שם, אימייל' + (basicData.salaryType !== 'tips' ? ' ושכר' : ''), 'error'); return;
    }
    if ((basicData.username && !basicData.password) || (!basicData.username && basicData.password)) {
      toast('יש למלא גם שם משתמש וגם סיסמה, או להשאיר את שניהם ריקים', 'error'); return;
    }
    if (basicData.password && basicData.password.length < 8) {
      toast('סיסמה חייבת להכיל לפחות 8 תווים', 'error'); return;
    }
    setForm101Loading(true);
    try {
      const payload: Record<string, unknown> = {
        fullName: basicData.fullName, email: basicData.email, phone: basicData.phone,
        role: basicData.role === 'manager' ? 'manager' : 'employee', position: basicData.role,
        salaryType: basicData.salaryType,
        salaryAmount: basicData.salaryType === 'tips' ? 0 : basicData.salaryAmount,
        participatesInTips: basicData.salaryType === 'tips',
      };
      if (basicData.username && basicData.password) {
        payload.username = basicData.username;
        payload.password = basicData.password;
      }
      const { data } = await employeesApi.create(payload as Parameters<typeof employeesApi.create>[0]);
      setForm101EmpId(data.employeeId);
      setForm101Step(2);
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally { setForm101Loading(false); }
  };

  const submit101Step2 = async () => {
    if (!form101EmpId) return;
    setForm101Loading(true);
    try {
      const taxCreditPoints = parseFloat(form101Data.taxCreditPoints);
      await api.post(`/employees/${form101EmpId}/form101`, {
        ...form101Data,
        numChildren: parseInt(form101Data.numChildren) || 0,
        employmentScope: parseInt(form101Data.employmentScope) || 100,
        taxCreditPoints: Number.isFinite(taxCreditPoints) ? taxCreditPoints : 2.25,
      });
      toast('כרטיס עובד נשמר בהצלחה', 'success');
      setShow101(false);
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally { setForm101Loading(false); }
  };

  const f101Change = (field: keyof Form101Data, val: string) =>
    setForm101Data(p => ({ ...p, [field]: val }));

  const syncZEmployees = async () => {
    setZSyncing(true);
    try {
      const r = await posApi.zreportSyncEmployees();
      toast(r.data.message, 'success');
      // Reload both Z employees and the main employee list (sync may have created new stubs)
      const [r2] = await Promise.all([
        posApi.zreportEmployees(),
        employeesApi.list({ activeOnly: !showInactive }).then(({ data }) => setEmployees(data.employees || [])),
      ]);
      setZEmployees(r2.data?.employees || []);
    } catch { toast('שגיאה בסנכרון', 'error'); }
    finally { setZSyncing(false); }
  };

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#e8e8e4' }}>עובדים</h1>
          <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>{employees.length} עובדים במערכת</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Tabs */}
          <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)', background: '#111116' }}>
            <button onClick={() => setTab('manage')}
              className="px-4 py-2 text-sm font-semibold transition-colors"
              style={tab === 'manage' ? { background: '#60b8e8', color: '#0a0a0e' } : { color: '#9aa0ab' }}>
              ניהול
            </button>
            <button onClick={() => setTab('zreport')}
              className="px-4 py-2 text-sm font-semibold transition-colors flex items-center gap-1.5"
              style={tab === 'zreport' ? { background: '#60b8e8', color: '#0a0a0e', borderRight: '1px solid rgba(201,162,39,0.16)' } : { color: '#9aa0ab', borderRight: '1px solid rgba(201,162,39,0.16)' }}>
              <FileBarChart2 className="w-3.5 h-3.5" /> שעות Z
              {unmatchedShifts > 0 && (
                <span className="text-xs font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: '#ef4444', color: '#fff', fontSize: '10px', lineHeight: 1 }}>
                  {unmatchedShifts}
                </span>
              )}
            </button>
            <button onClick={() => setTab('tips')}
              className="px-4 py-2 text-sm font-semibold transition-colors"
              style={tab === 'tips' ? { background: '#60b8e8', color: '#0a0a0e' } : { color: '#9aa0ab' }}>
              💰 טיפים
            </button>
          </div>
          {/* Action buttons stay visible on both tabs — adding/exporting/syncing
              employees is useful regardless of which view you're looking at */}
          <Button variant="outline" onClick={syncZEmployees} loading={zSyncing}>
            <RefreshCw className="w-4 h-4" /> סנכרן עובדים
          </Button>
          <Button variant="outline" onClick={exportExcel} loading={exporting}>
            <Download className="w-4 h-4" /> ייצוא Excel
          </Button>
          <Button variant="outline" onClick={() => { setEditingEmp(null); reset(); setShowModal(true); }}>
            <Plus className="w-4 h-4" /> הוסף עובד
          </Button>
          <button
            onClick={() => open101()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white"
            style={{ background: 'var(--color-primary)' }}
          >
            <ClipboardList className="w-4 h-4" /> צור עובד | טופס 101
          </button>
        </div>
      </div>

      {inviteMsg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm px-4 py-3 rounded-xl">
          {inviteMsg}
        </div>
      )}

      {/* ── Manage Tab ── */}
      {tab === 'manage' && (
        <>
          {/* Search + active filter */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="relative max-w-sm flex-1 min-w-[220px]">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש עובד..."
                className="w-full pr-9 pl-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
              />
              הצג גם עובדים לא פעילים
            </label>
          </div>

          {/* Bulk-selection toolbar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5">
              <span className="text-sm text-blue-700 font-semibold flex-1">נבחרו {selectedIds.size} עובדים</span>
              <button
                onClick={() => bulkSetActive(false)}
                className="flex items-center gap-1.5 bg-white hover:bg-red-50 text-red-600 font-semibold text-sm px-3 py-1.5 rounded-xl border border-red-200 transition-colors"
              >
                <UserX className="w-3.5 h-3.5" /> השבת נבחרים
              </button>
              <button
                onClick={() => bulkSetActive(true)}
                className="flex items-center gap-1.5 bg-white hover:bg-green-50 text-green-600 font-semibold text-sm px-3 py-1.5 rounded-xl border border-green-200 transition-colors"
              >
                <UserCheck className="w-3.5 h-3.5" /> הפעל נבחרים
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-sm text-gray-400 hover:text-gray-600 px-2"
              >
                נקה בחירה
              </button>
            </div>
          )}

          {/* Table */}
          <Card>
            {loading ? (
              <div className="p-8 text-center text-gray-400">טוען...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-6 py-3 w-10">
                        <input
                          type="checkbox"
                          checked={filtered.length > 0 && selectedIds.size === filtered.length}
                          ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filtered.length; }}
                          onChange={() => {
                            setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map(e => e.id)));
                          }}
                          className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                        />
                      </th>
                      {['עובד', 'תפקיד', 'שכר'].map((h) => (
                        <th key={h} className="text-right text-xs font-medium text-gray-500 px-6 py-3">{h}</th>
                      ))}
                      <th className="text-right text-xs font-medium text-gray-500 px-6 py-3">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span>שעות</span>
                          <select
                            value={hoursMonth}
                            onChange={e => setHoursMonth(Number(e.target.value))}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white cursor-pointer"
                          >
                            {['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'].map((m, i) => (
                              <option key={i+1} value={i+1}>{m}</option>
                            ))}
                          </select>
                          <select
                            value={hoursYear}
                            onChange={e => setHoursYear(Number(e.target.value))}
                            className="text-xs border border-gray-200 rounded px-1 py-0.5 bg-white cursor-pointer"
                          >
                            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
                              <option key={y} value={y}>{y}</option>
                            ))}
                          </select>
                        </div>
                      </th>
                      {['סטטוס', 'פעולות'].map((h) => (
                        <th key={h} className="text-right text-xs font-medium text-gray-500 px-6 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filtered.map((emp) => (
                      <tr key={emp.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(emp.id)}
                            onChange={(e) => {
                              setSelectedIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(emp.id); else next.delete(emp.id);
                                return next;
                              });
                            }}
                            className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                          />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                              {getInitials(emp.full_name)}
                            </div>
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p className="text-sm font-medium text-gray-900">{emp.full_name}</p>
                                {(emp.zreport_hours_total ?? 0) > 0 && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full leading-none" title="מקושר לשעות Z">Z</span>
                                )}
                              </div>
                              {emp.email && (
                                <p className="text-xs text-gray-500 flex items-center gap-1">
                                  <Mail className="w-3 h-3" /> {emp.email}
                                </p>
                              )}
                              {emp.username && (
                                <p className="text-xs flex items-center gap-1" style={{ color: '#c9a227' }}>
                                  @ {emp.username}
                                </p>
                              )}
                              {emp.phone && (
                                <p className="text-xs text-gray-500 flex items-center gap-1">
                                  <Phone className="w-3 h-3" /> {emp.phone}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={(emp.role as string) === 'owner' ? 'purple' : (emp.role as string) === 'manager' ? 'info' : (emp.role as string) === 'chef' || (emp.role as string) === 'sous_chef' ? 'warning' : 'default'}>
                            {roleLabels[emp.position || emp.role] || emp.position || emp.role}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-700">
                          {emp.salary_type === 'hourly'
                            ? `${formatCurrency(emp.salary_amount ?? emp.hourly_rate ?? 0)}/שעה`
                            : emp.salary_type === 'tips'
                            ? <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>טיפים בלבד</span>
                            : `${formatCurrency(emp.salary_amount ?? emp.global_salary ?? 0)}/חודש`}
                          {emp.participates_in_tips && emp.salary_type !== 'tips' && (
                            <span className="mr-1 text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(201,162,39,0.1)', color: '#c9a227' }}>+ טיפים</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="space-y-1">
                            {(monthlyHours[emp.id] ?? 0) > 0 && (
                              <div>
                                <p className="text-sm font-semibold text-blue-600">{(monthlyHours[emp.id]).toFixed(1)}ש'</p>
                                <p className="text-xs text-gray-400">שעות חודש</p>
                              </div>
                            )}
                            {(emp.zreport_hours_30d ?? 0) > 0 && (
                              <div>
                                <p className="text-sm font-semibold text-blue-400">{(emp.zreport_hours_30d ?? 0).toFixed(1)}ש'</p>
                                <p className="text-xs text-gray-400">שעות Z (30י')</p>
                              </div>
                            )}
                            {!(monthlyHours[emp.id] ?? 0) && !(emp.zreport_hours_30d ?? 0) && (
                              <span className="text-xs text-gray-300">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          {emp.pending_invite ? (
                            <Badge variant="warning">ממתין להזמנה</Badge>
                          ) : (
                            <Badge variant={emp.is_active ? 'success' : 'danger'}>
                              {emp.is_active ? 'פעיל' : 'לא פעיל'}
                            </Badge>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => openEdit(emp)}
                              className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors"
                              title="עריכה"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => open101(emp)}
                              className="p-1.5 rounded-lg transition-colors"
                              style={{ color: 'var(--color-primary)' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,92,42,0.08)')}
                              onMouseLeave={e => (e.currentTarget.style.background = '')}
                              title="טופס 101 — כרטיס עובד"
                            >
                              <ClipboardList className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => toggleActive(emp)}
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
                              title={emp.is_active ? 'השבת' : 'הפעל'}
                            >
                              {emp.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                            </button>
                            <button
                              onClick={() => sendInvite(emp)}
                              disabled={inviting === emp.id}
                              className="p-1.5 rounded-lg hover:bg-green-50 text-green-600 transition-colors disabled:opacity-50"
                              title="שלח הזמנה"
                            >
                              <Send className="w-4 h-4" />
                            </button>
                            {emp.role !== 'owner' && (
                              <button
                                onClick={() => deleteEmployee(emp)}
                                className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors"
                                title="מחק"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <div className="py-12 text-center text-gray-400 text-sm">לא נמצאו עובדים</div>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ── Z Report Tab ── */}
      {tab === 'zreport' && (
        <>
          {zLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
            </div>
          ) : zEmployees.length === 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center space-y-3">
              <FileBarChart2 className="w-10 h-10 mx-auto text-amber-400 opacity-70" />
              <div>
                <p className="font-bold text-slate-700">אין נתוני עובדים מהדוחות עדיין</p>
                <p className="text-sm text-slate-500 mt-1">
                  לאחר ייבוא דוח עם גיליון &quot;משמרות&quot;, העובדים יופיעו כאן אוטומטית.
                </p>
              </div>
              <div className="text-sm text-slate-500 bg-white rounded-xl p-4 text-right border border-amber-100 space-y-1">
                <p className="font-semibold text-slate-700">כיצד לסנכרן:</p>
                <p>1. עבור למסך <a href="/pos" className="text-blue-600 underline font-semibold">POS / דוחות</a> וייבא קובץ EML / XLSX מ-BeePort</p>
                <p>2. חזור לכאן ולחץ <strong>סנכרן עם עובדים</strong></p>
                <p>3. שמות העובדים מהמשמרות יתווספו אוטומטית לרשימה</p>
              </div>
            </div>
          ) : (
            <>
              {/* Summary KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {[
                  { label: 'עובדים בדוחות', value: String(zEmployees.length), icon: '👥' },
                  { label: 'סה"כ שעות (שנה)', value: `${zEmployees.reduce((s, e) => s + parseFloat(e.total_hours), 0).toFixed(1)}ש'`, icon: '🕐' },
                  { label: 'מקושרים למערכת', value: String(zEmployees.filter(e => e.employee_id).length), icon: '🔗' },
                ].map(({ label, value, icon }) => (
                  <div key={label} className="rounded-xl p-4 text-center" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
                    <p className="text-2xl mb-1">{icon}</p>
                    <p className="text-lg font-black" style={{ color: '#e8e8e4' }}>{value}</p>
                    <p className="text-xs" style={{ color: '#9aa0ab' }}>{label}</p>
                  </div>
                ))}
              </div>

              {/* Employee rows */}
              <div className="space-y-2">
                {zEmployees.map((emp) => {
                  const isOpen = zOpenRow === emp.employee_name;
                  const totalH = parseFloat(emp.total_hours).toFixed(1);
                  const linked = !!emp.employee_id;
                  return (
                    <div key={emp.employee_name} className="rounded-xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
                      <button className="w-full px-4 py-3 text-right flex items-center gap-3" onClick={() => setZOpenRow(isOpen ? null : emp.employee_name)}>
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 font-bold text-sm text-white"
                          style={{ background: `hsl(${(emp.employee_name.charCodeAt(0) * 43) % 360}, 55%, 50%)` }}>
                          {getInitials(emp.employee_name)}
                        </div>
                        <div className="flex-1 min-w-0 text-right">
                          <div className="flex items-center gap-2">
                            <p className="font-bold" style={{ color: '#e8e8e4' }}>{emp.employee_name}</p>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${linked ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                              {linked ? 'מקושר' : 'לא מקושר'}
                            </span>
                            {/* Reflects the actual employee status set in טאב ניהול — separate
                                from "מקושר" above, which only means "matched to a user account". */}
                            {linked && (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${emp.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                {emp.is_active ? 'פעיל' : 'לא פעיל'}
                              </span>
                            )}
                          </div>
                          {emp.email && <p className="text-xs text-slate-400">{emp.email}</p>}
                        </div>
                        <div className="text-left flex-shrink-0">
                          <p className="text-lg font-black text-blue-600">{totalH}ש'</p>
                          <p className="text-xs text-slate-400">{emp.shifts_count} משמרות</p>
                        </div>
                        {isOpen ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4" style={{ borderTop: '1px solid rgba(201,162,39,0.1)' }}>
                          <p className="text-xs font-semibold mt-3 mb-2" style={{ color: '#9aa0ab' }}>
                            היסטוריית משמרות מלאה — {emp.shifts_log.length} משמרות · {parseFloat(emp.total_hours).toFixed(1)}ש' סה"כ
                          </p>
                          {/* Group by year */}
                          {(() => {
                            const byYear = emp.shifts_log.reduce<Record<string, typeof emp.shifts_log>>((acc, log) => {
                              const y = new Date(log.date).getFullYear().toString();
                              (acc[y] = acc[y] || []).push(log);
                              return acc;
                            }, {});
                            return Object.entries(byYear).sort(([a], [b]) => Number(b) - Number(a)).map(([year, logs]) => (
                              <div key={year} className="mb-3">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-xs font-bold" style={{ color: '#c9a227' }}>{year}</span>
                                  <span className="text-xs" style={{ color: '#6b7280' }}>
                                    {logs.reduce((s, l) => s + parseFloat(String(l.hours)), 0).toFixed(1)}ש' · {logs.length} משמרות
                                  </span>
                                </div>
                                <div className="space-y-1">
                                  {logs.map((log, i) => (
                                    <div key={i} className="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg" style={{ background: '#111116' }}>
                                      <span style={{ color: '#9aa0ab' }}>{new Date(log.date).toLocaleDateString('he-IL')}</span>
                                      <span className="font-bold" style={{ color: '#e8e8e4' }}>{parseFloat(String(log.hours)).toFixed(1)}ש'</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════
           FORM 101 MODAL — כרטיס עובד חדש
          ══════════════════════════════════════════════════════════ */}
      {show101 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} dir="rtl">
          <div className="rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.2)' }}>

            {/* Header */}
            <div className="px-6 py-4 flex items-center justify-between" style={{ background: 'var(--hero-gradient)', borderBottom: '1px solid rgba(201,162,39,0.16)' }}>
              <div>
                <h2 className="text-lg font-black text-white">כרטיס עובד חדש — טופס 101</h2>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {form101Step === 1 ? 'שלב 1 מתוך 2 — פרטי הגדרת עובד' : 'שלב 2 מתוך 2 — פרטים אישיים ובנקאיים'}
                </p>
              </div>
              <button onClick={() => setShow101(false)} className="p-2 rounded-xl" style={{ color: 'rgba(255,255,255,0.7)' }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Step indicators */}
            <div className="flex" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)' }}>
              {[{ n: 1, label: 'פרטי העסקה' }, { n: 2, label: 'כרטיס עובד מלא' }].map(s => (
                <button key={s.n} onClick={() => form101EmpId && setForm101Step(s.n)}
                  className="flex-1 py-3 text-sm font-semibold transition-colors border-b-2"
                  style={form101Step === s.n
                    ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }
                    : { borderColor: 'transparent', color: form101EmpId ? '#6b7280' : '#d1d5db' }}>
                  {s.n}. {s.label}
                </button>
              ))}
            </div>

            <div className="overflow-y-auto flex-1 p-6 space-y-6">

              {/* ── STEP 1: Basic Employment Details ─────────────────── */}
              {form101Step === 1 && (
                <>
                  <SectionTitle>פרטים בסיסיים</SectionTitle>
                  <div className="grid grid-cols-2 gap-4">
                    <F101Field label="שם מלא *">
                      <input value={basicData.fullName} onChange={e => setBasicData(p => ({ ...p, fullName: e.target.value }))}
                        placeholder="ישראל ישראלי" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="אימייל *">
                      <input type="email" value={basicData.email} onChange={e => setBasicData(p => ({ ...p, email: e.target.value }))}
                        placeholder="israel@mail.com" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="טלפון">
                      <input type="tel" value={basicData.phone} onChange={e => setBasicData(p => ({ ...p, phone: e.target.value }))}
                        placeholder="050-0000000" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="תפקיד">
                      <select value={basicData.role} onChange={e => setBasicData(p => ({ ...p, role: e.target.value }))} className={f101InputCls}>
                        {ROLE_GROUPS.map(group => (
                          <optgroup key={group} label={group}>
                            {ROLES.filter(r => r.group === group).map(r => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </F101Field>
                    <F101Field label="סוג שכר">
                      <select value={basicData.salaryType} onChange={e => setBasicData(p => ({ ...p, salaryType: e.target.value }))} className={f101InputCls}>
                        <option value="hourly">שעתי</option>
                        <option value="global">גלובלי (חודשי)</option>
                        <option value="tips">טיפים בלבד</option>
                      </select>
                    </F101Field>
                    {basicData.salaryType !== 'tips' && (
                      <F101Field label={basicData.salaryType === 'hourly' ? 'תעריף לשעה (₪) *' : 'שכר חודשי (₪) *'}>
                        <input type="number" value={basicData.salaryAmount} onChange={e => setBasicData(p => ({ ...p, salaryAmount: e.target.value }))}
                          placeholder={basicData.salaryType === 'hourly' ? '33.87' : '6300'} className={f101InputCls} />
                      </F101Field>
                    )}
                  </div>

                  <SectionTitle>פרטי התחברות (אופציונלי)</SectionTitle>
                  <p className="text-xs text-slate-400 -mt-2">
                    אם תמלא שם משתמש וסיסמה — העובד יוכל להתחבר איתם מיד. אם תשאיר ריק — תישלח הזמנה למייל.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <F101Field label="שם משתמש">
                      <input value={basicData.username} onChange={e => setBasicData(p => ({ ...p, username: e.target.value }))}
                        placeholder="לדוגמה: dani123" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="סיסמה">
                      <input type="password" value={basicData.password} onChange={e => setBasicData(p => ({ ...p, password: e.target.value }))}
                        placeholder="לפחות 8 תווים" className={f101InputCls} />
                    </F101Field>
                  </div>
                </>
              )}

              {/* ── STEP 2: Full Form 101 ─────────────────────────────── */}
              {form101Step === 2 && (
                <>
                  {/* חלק א׳ — פרטים אישיים */}
                  <SectionTitle badge="חלק א׳">פרטים אישיים</SectionTitle>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <F101Field label="מספר תעודת זהות">
                      <input value={form101Data.idNumber} onChange={e => f101Change('idNumber', e.target.value)}
                        placeholder="123456789" maxLength={9} className={f101InputCls} />
                    </F101Field>
                    <F101Field label="תאריך לידה">
                      <DatePicker value={form101Data.birthDate} onChange={v => f101Change('birthDate', v)} max={todayIL()} />
                    </F101Field>
                    <F101Field label="מין">
                      <select value={form101Data.gender} onChange={e => f101Change('gender', e.target.value)} className={f101InputCls}>
                        <option>זכר</option><option>נקבה</option>
                      </select>
                    </F101Field>
                    <F101Field label="מצב משפחתי">
                      <select value={form101Data.maritalStatus} onChange={e => f101Change('maritalStatus', e.target.value)} className={f101InputCls}>
                        {MARITAL.map(m => <option key={m}>{m}</option>)}
                      </select>
                    </F101Field>
                    <F101Field label="מספר ילדים">
                      <input type="number" min="0" max="20" value={form101Data.numChildren} onChange={e => f101Change('numChildren', e.target.value)} className={f101InputCls} />
                    </F101Field>
                  </div>

                  {/* כתובת */}
                  <SectionTitle badge="">כתובת מגורים</SectionTitle>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="col-span-2">
                      <F101Field label="עיר">
                        <input value={form101Data.addressCity} onChange={e => f101Change('addressCity', e.target.value)} placeholder="תל אביב" className={f101InputCls} />
                      </F101Field>
                    </div>
                    <div className="col-span-2">
                      <F101Field label="רחוב">
                        <input value={form101Data.addressStreet} onChange={e => f101Change('addressStreet', e.target.value)} placeholder="דיזנגוף" className={f101InputCls} />
                      </F101Field>
                    </div>
                    <F101Field label="מספר בית">
                      <input value={form101Data.addressNum} onChange={e => f101Change('addressNum', e.target.value)} placeholder="5" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="מיקוד">
                      <input value={form101Data.addressZip} onChange={e => f101Change('addressZip', e.target.value)} placeholder="6120101" className={f101InputCls} />
                    </F101Field>
                  </div>

                  {/* חלק ב׳ — פרטי העסקה */}
                  <SectionTitle badge="חלק ב׳">פרטי העסקה</SectionTitle>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <F101Field label="תאריך תחילת עבודה">
                      <DatePicker value={form101Data.startDate} onChange={v => f101Change('startDate', v)} />
                    </F101Field>
                    <F101Field label="היקף משרה (%)">
                      <input type="number" min="1" max="200" value={form101Data.employmentScope} onChange={e => f101Change('employmentScope', e.target.value)} className={f101InputCls} />
                    </F101Field>
                    <F101Field label="נקודות זיכוי במס">
                      <input type="number" min="0" max="10" step="0.25" value={form101Data.taxCreditPoints} onChange={e => f101Change('taxCreditPoints', e.target.value)} className={f101InputCls} />
                    </F101Field>
                  </div>

                  {/* חלק ג׳ — פרטי בנק */}
                  <SectionTitle badge="חלק ג׳">פרטי חשבון בנק</SectionTitle>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="col-span-1">
                      <F101Field label="שם הבנק">
                        <select value={form101Data.bankName} onChange={e => f101Change('bankName', e.target.value)} className={f101InputCls}>
                          {BANKS.map(b => <option key={b}>{b}</option>)}
                        </select>
                      </F101Field>
                    </div>
                    <F101Field label="מספר סניף">
                      <input value={form101Data.bankBranch} onChange={e => f101Change('bankBranch', e.target.value)} placeholder="012" className={f101InputCls} />
                    </F101Field>
                    <F101Field label="מספר חשבון">
                      <input value={form101Data.bankAccount} onChange={e => f101Change('bankAccount', e.target.value)} placeholder="123456" className={f101InputCls} />
                    </F101Field>
                  </div>

                  {/* הערות */}
                  <SectionTitle badge="">הערות</SectionTitle>
                  <textarea value={form101Data.notes} onChange={e => f101Change('notes', e.target.value)} rows={3}
                    placeholder="הערות נוספות על העובד..."
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 resize-none"
                    style={{ '--tw-ring-color': 'var(--color-primary)' } as React.CSSProperties} />
                </>
              )}
            </div>

            {/* Footer buttons */}
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
              <button onClick={() => setShow101(false)} className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
                ביטול
              </button>
              <div className="flex items-center gap-2">
                {form101Step === 2 && form101EmpId && (
                  <button onClick={() => setForm101Step(1)} className="px-4 py-2 rounded-xl text-sm font-medium border border-slate-200 hover:bg-slate-50 transition-colors">
                    חזרה
                  </button>
                )}
                {form101Step === 1 ? (
                  <button onClick={submit101Step1} disabled={form101Loading}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                    style={{ background: 'var(--color-primary)' }}>
                    {form101Loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {form101EmpId ? 'המשך לטופס' : 'צור עובד ←'}
                  </button>
                ) : (
                  <button onClick={submit101Step2} disabled={form101Loading}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                    style={{ background: 'var(--color-primary)' }}>
                    {form101Loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    שמור כרטיס עובד
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Smart alert — shown whenever at least one employee participates in tips */}
      {employees.some(e => e.participates_in_tips) && tab !== 'tips' && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl text-sm"
          style={{ background: 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.3)', color: '#c9a227' }}>
          <span className="text-base">💡</span>
          <span>
            יש עובדים שמשתתפים ב-pool טיפים.
            האם כל העובדים הרלוונטיים (מלצרים, ברמנים) מוגדרים?{' '}
            <button className="underline font-semibold" onClick={() => setTab('tips')}>עבור לטאב טיפים</button>
          </span>
        </div>
      )}

      {/* ── Tips Tab ── */}
      {tab === 'tips' && (
        <div className="space-y-6">
          {/* Tip entry form */}
          <div className="rounded-2xl p-5 space-y-4" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.16)' }}>
            <h2 className="text-base font-bold" style={{ color: '#e8e8e4' }}>הזנת טיפים</h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>תאריך</label>
                <input type="date" value={tipForm.entry_date}
                  onChange={e => { setTipForm(f => ({ ...f, entry_date: e.target.value })); setTipPreview(null); }}
                  className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>שם משמרת (אופציונלי)</label>
                <input type="text" placeholder='למשל: ערב' value={tipForm.shift_label}
                  onChange={e => setTipForm(f => ({ ...f, shift_label: e.target.value }))}
                  className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>סה"כ טיפים (₪)</label>
                <input type="number" min="0" step="0.01" placeholder="0.00" value={tipForm.total_amount}
                  onChange={e => { setTipForm(f => ({ ...f, total_amount: e.target.value })); setTipPreview(null); }}
                  className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
              </div>
              <div className="col-span-2 sm:col-span-3 space-y-1">
                <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>הערות (אופציונלי)</label>
                <input type="text" value={tipForm.notes}
                  onChange={e => setTipForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
              </div>
            </div>

            {/* Advanced settings — shift time window */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedTips(v => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold transition-colors"
                style={{ color: showAdvancedTips ? '#c9a227' : '#9aa0ab' }}
              >
                <span style={{ fontSize: '10px' }}>{showAdvancedTips ? '▲' : '▼'}</span>
                הגדרות מתקדמות
                <span className="font-normal" style={{ color: '#6b7280' }}>— חלוקה לפי משמרת ספציפית</span>
              </button>

              {showAdvancedTips && (
                <div className="grid grid-cols-2 gap-4 mt-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>שעת התחלת משמרת</label>
                    <input type="time" value={tipForm.shift_start}
                      onChange={e => { setTipForm(f => ({ ...f, shift_start: e.target.value })); setTipPreview(null); }}
                      className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                      style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold" style={{ color: '#9aa0ab' }}>שעת סיום משמרת</label>
                    <input type="time" value={tipForm.shift_end}
                      onChange={e => { setTipForm(f => ({ ...f, shift_end: e.target.value })); setTipPreview(null); }}
                      className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1"
                      style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }} />
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-1">
              <Button variant="outline" onClick={previewTips} loading={tipPreviewing}
                disabled={!tipForm.entry_date || !tipForm.total_amount}>
                חשב חלוקה
              </Button>
              {tipPreview && (
                <Button onClick={saveTips} loading={tipSaving} disabled={!tipPreview.distributions.length}>
                  שמור טיפים
                </Button>
              )}
            </div>

            {/* Preview table */}
            {tipPreview && (
              <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)' }}>
                {tipPreview.distributions.length === 0 ? (
                  <div className="p-4 text-sm text-center" style={{ color: '#9aa0ab' }}>
                    לא נמצאו עובדים עם משמרות מסומנות ל-pool טיפים בתאריך זה
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: 'rgba(201,162,39,0.08)', color: '#9aa0ab' }}>
                        <th className="text-right px-4 py-2 font-semibold">עובד</th>
                        <th className="text-center px-4 py-2 font-semibold">שעות</th>
                        <th className="text-center px-4 py-2 font-semibold">חלק (%)</th>
                        <th className="text-left px-4 py-2 font-semibold">סכום</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tipPreview.distributions.map(d => (
                        <tr key={d.employee_id} style={{ borderTop: '1px solid rgba(201,162,39,0.08)', color: '#e8e8e4' }}>
                          <td className="px-4 py-2">{d.employee_name}</td>
                          <td className="px-4 py-2 text-center">{d.hours_worked.toFixed(1)}</td>
                          <td className="px-4 py-2 text-center" style={{ color: '#9aa0ab' }}>
                            {((d.hours_worked / tipPreview.totalHours) * 100).toFixed(1)}%
                          </td>
                          <td className="px-4 py-2 font-bold" style={{ color: '#c9a227' }}>
                            {formatCurrency(d.amount)}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid rgba(201,162,39,0.2)', color: '#c9a227', fontWeight: 700 }}>
                        <td className="px-4 py-2">סה"כ</td>
                        <td className="px-4 py-2 text-center">{tipPreview.totalHours.toFixed(1)}</td>
                        <td className="px-4 py-2 text-center">100%</td>
                        <td className="px-4 py-2">{formatCurrency(tipPreview.totalAmount)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* History */}
          <div className="rounded-2xl p-5 space-y-4" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.16)' }}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-base font-bold" style={{ color: '#e8e8e4' }}>היסטוריית הזנות</h2>
              <div className="flex items-center gap-2">
                <select value={tipsMonth} onChange={e => setTipsMonth(Number(e.target.value))}
                  className="rounded-lg px-2 py-1.5 text-sm"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i+1} value={i+1}>
                      {new Date(2000, i).toLocaleString('he-IL', { month: 'long' })}
                    </option>
                  ))}
                </select>
                <select value={tipsYear} onChange={e => setTipsYear(Number(e.target.value))}
                  className="rounded-lg px-2 py-1.5 text-sm"
                  style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }}>
                  {[now2.getFullYear() - 1, now2.getFullYear(), now2.getFullYear() + 1].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            {tipsLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin" style={{ color: '#9aa0ab' }} /></div>
            ) : tipEntries.length === 0 ? (
              <p className="text-sm text-center py-4" style={{ color: '#9aa0ab' }}>אין הזנות לתקופה זו</p>
            ) : (
              <div className="space-y-3">
                {tipEntries.map(entry => (
                  <div key={entry.id} className="rounded-xl p-4 space-y-2"
                    style={{ background: '#0a0a0e', border: '1px solid rgba(201,162,39,0.1)' }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm" style={{ color: '#e8e8e4' }}>
                          {new Date(entry.entry_date).toLocaleDateString('he-IL')}
                        </span>
                        {entry.shift_label && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                            style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>
                            {entry.shift_label}
                          </span>
                        )}
                        {entry.shift_start && entry.shift_end && (
                          <span className="text-xs" style={{ color: '#9aa0ab' }}>
                            {entry.shift_start}–{entry.shift_end}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-bold" style={{ color: '#c9a227' }}>
                          {formatCurrency(entry.total_amount)}
                        </span>
                        <button onClick={() => deleteTipEntry(entry.id)}
                          className="p-1 rounded-lg hover:bg-red-900/20 transition-colors">
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    </div>
                    {entry.distributions && entry.distributions.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {entry.distributions.map(d => (
                          <span key={d.employee_id} className="text-xs px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(96,184,232,0.1)', color: '#60b8e8' }}>
                            {d.employee_name} — {formatCurrency(d.amount)}
                          </span>
                        ))}
                      </div>
                    )}
                    {entry.notes && (
                      <p className="text-xs" style={{ color: '#9aa0ab' }}>{entry.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tip Pool Setup Wizard ── */}
      <Modal open={showWizard} onClose={() => setShowWizard(false)} title="הגדרת pool טיפים">
        <div className="p-6 space-y-4">
          <p className="text-sm" style={{ color: '#9aa0ab' }}>
            מצאנו עובדים עם תפקידי שירות שבדרך כלל מקבלים טיפים.
            בחר מי ישתתף ב-pool — ניתן לשנות בכל עת דרך כרטיס העובד.
          </p>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {wizardEmployees.map(emp => (
              <label key={emp.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-colors"
                style={{
                  background: wizardSelected.has(emp.id) ? 'rgba(201,162,39,0.1)' : '#0a0a0e',
                  border: `1px solid ${wizardSelected.has(emp.id) ? 'rgba(201,162,39,0.3)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                <input
                  type="checkbox"
                  checked={wizardSelected.has(emp.id)}
                  onChange={e => {
                    setWizardSelected(prev => {
                      const next = new Set(prev);
                      e.target.checked ? next.add(emp.id) : next.delete(emp.id);
                      return next;
                    });
                  }}
                  className="w-4 h-4 rounded"
                />
                <div className="flex-1">
                  <span className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>{emp.full_name}</span>
                  <span className="text-xs mr-2" style={{ color: '#9aa0ab' }}>{emp.position}</span>
                </div>
                {wizardSelected.has(emp.id) && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                    style={{ background: 'rgba(201,162,39,0.2)', color: '#c9a227' }}>
                    ✓ בpool
                  </span>
                )}
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <button
              onClick={() => { tipsApi.poolSetup([]); setShowWizard(false); }}
              className="text-sm" style={{ color: '#9aa0ab' }}>
              דלג — אגדיר מאוחר יותר
            </button>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setShowWizard(false)}>ביטול</Button>
              <Button onClick={submitWizard} loading={wizardSaving}>
                הוסף {wizardSelected.size} עובדים ל-pool
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Add / Edit Modal */}
      <Modal
        open={showModal}
        onClose={closeModal}
        title={editingEmp ? `עריכת ${editingEmp.full_name}` : 'הוספת עובד חדש'}
      >
        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="שם מלא" error={errors.full_name?.message} {...register('full_name')} />
            <Input label="אימייל" type="email" error={errors.email?.message} {...register('email')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="טלפון" type="tel" {...register('phone')} />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">תפקיד</label>
              <select
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                {...register('role')}
              >
                {ROLE_GROUPS.map(group => (
                  <optgroup key={group} label={group}>
                    {ROLES.filter(r => r.group === group).map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">סוג שכר</label>
              <select
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                {...register('salary_type')}
              >
                <option value="hourly">שעתי</option>
                <option value="global">גלובלי</option>
                <option value="tips">טיפים בלבד (ללא שכר בסיס)</option>
              </select>
            </div>
            {salaryType === 'hourly' ? (
              <Input
                label='תעריף לשעה (₪)'
                type="number"
                step="0.5"
                min="0"
                error={errors.hourly_rate?.message}
                {...register('hourly_rate')}
              />
            ) : salaryType === 'global' ? (
              <Input
                label='שכר חודשי (₪)'
                type="number"
                min="0"
                error={errors.global_salary?.message}
                {...register('global_salary')}
              />
            ) : (
              <div className="space-y-1 flex items-end pb-1">
                <p className="text-sm text-gray-500">העובד יקבל שכר טיפים בלבד — ללא שכר בסיס קבוע</p>
              </div>
            )}
          </div>
          {/* participates_in_tips checkbox — hidden for salary_type=tips (always true) */}
          {salaryType !== 'tips' && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                {...register('participates_in_tips')}
              />
              משתתף ב-pool טיפים (מקבל חלק מהטיפים בנוסף לשכר הבסיס)
            </label>
          )}
          {!editingEmp && (
            <div className="space-y-1 border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-700">פרטי התחברות (אופציונלי)</p>
              <p className="text-xs text-gray-400 mb-2">
                אם תמלא שם משתמש וסיסמה — העובד יוכל להתחבר איתם מיד. אם תשאיר ריק — תישלח הזמנה למייל להשלמת ההרשמה.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Input label="שם משתמש" placeholder="לדוגמה: dani123" error={errors.username?.message} {...register('username')} />
                <Input label="סיסמה" type="password" placeholder="לפחות 8 תווים" error={errors.password?.message} {...register('password')} />
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={closeModal}>ביטול</Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              {editingEmp ? 'עדכן' : 'שמור'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
    </ErrorBoundary>
  );
}
