'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Upload, Loader2, TrendingUp, Users, CheckCircle, AlertTriangle,
  FileText, Search, CalendarDays, ChevronDown, ChevronUp, Receipt,
  Download, Clock, UserCheck, Trash2, Sparkles, Check, X, Camera } from 'lucide-react';
import api from '@/lib/api/client';
import { businessApi } from '@/lib/api';
import { useAppDialog } from '@/context/AppDialogContext';
import { DateRangePicker } from '@/components/ui/DatePicker';
import { useSyncEvent } from '@/context/SyncContext';
import GmailConnectCard from '@/components/gmail/GmailConnectCard';
import ZCoverageBanner from '@/components/zreport/ZCoverageBanner';

interface ZItem  { name: string; qty: number; unit_price: number; total_price: number; }
interface ZReport { pos_sale_id: string; total_amount: number; sold_at: string; cash_amount: number; credit_amount: number; wolt_amount: number; ten_bis_amount: number; }
interface LastReport extends ZReport { items: ZItem[]; }

interface ShiftLog { date: string; hours: number; }
interface ZEmployee {
  employee_name: string;
  full_name: string | null;
  is_stub: boolean;
  shifts_count: number;
  total_hours: number;
  first_shift: string;
  last_shift: string;
  shifts_log: ShiftLog[];
}

interface ZData {
  total_sales: number;
  total_transactions: number;
  total_vat: number;
  avg_ticket: number;
  top_item: string | null;
  date_from: string | null;
  date_to: string | null;
  total_cash: number;
  total_credit: number;
  total_wolt: number;
  total_ten_bis: number;
  reports: ZReport[];
  lastReport: LastReport | null;
  vatRate?: number;
}

interface ZCoverage {
  hasRevenue:        boolean;
  hasItems:          boolean;
  hasShifts:         boolean;
  hasPaymentDetail:  boolean;
  hasDeliveryData:   boolean;
  revenueDays:         number;
  itemsCount:          number;
  shiftsCount:         number;
  paymentDetailCount:  number;
  deliveryOrdersCount: number;
  // 4 ממדים נוספים
  daysSinceLastReport: number | null;
  isFresh:             boolean;
  coveredDays30:       number;
  expectedDays30:      number;
  coverageRatio:       number | null;
  hasConfirmedFormat:  boolean;
  totalShifts:         number;
  matchedShifts:       number;
  employeeMatchRate:   number | null;
}

interface ZStatus {
  missingDays: string[];
  lastReportDate: string | null;
  imapConfigured: boolean;
  emailConfigured: boolean;
  emailConfig: { email: string; last_fetched_at: string | null; last_result: { imported?: number; emailsScanned?: number } | null } | null;
  openDays: number[];
  totalZDays: number;
  coverage: ZCoverage;
}

const fmt     = (n: number) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
const fmtNum  = (n: number) => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 }).format(n);
const fmtDate     = (d: string) => new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtDateFull = (d: string) => new Date(d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export default function ZReportPage() {
  const { toast, confirm } = useAppDialog();
  const searchParams = useSearchParams();
  const router       = useRouter();
  const [businessName, setBusinessName] = useState<string>('');
  const [data, setData]         = useState<ZData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [uploading, setUploading]   = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [newFormat, setNewFormat] = useState<{ id: string; zCount?: number; hasItems?: boolean; hasShifts?: boolean } | null>(null);
  const [multiZWithItems, setMultiZWithItems] = useState<{ zCount: number } | null>(null);
  const [dateConflicts, setDateConflicts] = useState<Array<{ posId: string; existingDate: string; newDate: string }>>([]);
  const [confirmingFormat, setConfirmingFormat] = useState(false);
  const [showLastItems, setShowLastItems] = useState(true);
  const [status, setStatus]     = useState<ZStatus | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [employees, setEmployees]       = useState<ZEmployee[]>([]);
  const [expandedEmp, setExpandedEmp]   = useState<string | null>(null);
  const [exporting, setExporting]           = useState(false);
  const [editingVat, setEditingVat]         = useState(false);
  const [vatInput, setVatInput]             = useState('');
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [unmatchedEmployees, setUnmatchedEmployees] = useState<{ name: string; shiftCount: number }[]>([]);
  const [existingUsers, setExistingUsers]           = useState<{ id: string; full_name: string }[]>([]);
  const [matchSelections, setMatchSelections]       = useState<Record<string, string>>({});
  const [matchingSaving, setMatchingSaving]         = useState<Record<string, boolean>>({});

  const [statusError, setStatusError] = useState(false);

  const fileRef    = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);
  const revenueRef = useRef<HTMLInputElement>(null);
  const itemsRef   = useRef<HTMLInputElement>(null);
  const shiftsRef  = useRef<HTMLInputElement>(null);

  // ── Search / filter state ──────────────────────────────────────────────────
  const [query, setQuery]       = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  const load = async () => {
    setLoading(true);
    setStatusError(false);
    try {
      const [summaryRes, statusRes, empRes, unmatchedRes] = await Promise.allSettled([
        api.get('/zreport/summary'),
        api.get('/zreport/status'),
        api.get('/zreport/employees'),
        api.get('/zreport/unmatched-employees'),
      ]);
      if (summaryRes.status === 'fulfilled') {
        setData(summaryRes.value.data ?? { total_sales: 0, total_transactions: 0, total_vat: 0, avg_ticket: 0, top_item: null, date_from: null, date_to: null, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0, reports: [], lastReport: null });
      } else {
        setData({ total_sales: 0, total_transactions: 0, total_vat: 0, avg_ticket: 0, top_item: null, date_from: null, date_to: null, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0, reports: [], lastReport: null });
      }
      if (statusRes.status === 'fulfilled') {
        const s = statusRes.value.data;
        setStatus(s);
      } else {
        setStatusError(true);
      }
      if (empRes.status === 'fulfilled')   setEmployees(empRes.value.data.employees ?? []);
      if (unmatchedRes.status === 'fulfilled') {
        setUnmatchedEmployees(unmatchedRes.value.data.unmatchedEmployees ?? []);
        setExistingUsers(unmatchedRes.value.data.existingUsers ?? []);
      }
    } catch {
      setData({ total_sales: 0, total_transactions: 0, total_vat: 0, avg_ticket: 0, top_item: null, date_from: null, date_to: null, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0, reports: [], lastReport: null });
    }
    setLoading(false);
  };

  const onGmailImported = useCallback(() => { load(); setCoverageOpen(true); }, [load]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await api.get('/zreport/export', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a   = document.createElement('a');
      a.href    = url;
      a.download = `דוחות.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast('שגיאה בייצוא הקובץ', 'error');
    }
    setExporting(false);
  };


  const handleDeleteSelected = async () => {
    const ids = [...selectedIds];
    const ok = await confirm(
      `פעולה זו תמחק לצמיתות ${ids.length} דוחות שנבחרו. להמשיך?`,
      `מחיקת ${ids.length} דוחות`,
      'מחק'
    );
    if (!ok) return;
    setDeletingSelected(true);
    try {
      const { data: res } = await api.delete('/zreport/selected', { data: { posIds: ids } });
      toast(res.message || `נמחקו ${ids.length} דוחות`, 'success');
      setSelectedIds(new Set());
      load();
    } catch {
      toast('שגיאה במחיקת הדוחות', 'error');
    }
    setDeletingSelected(false);
  };

  const handleDeleteAll = async () => {
    const ok = await confirm(
      'פעולה זו תמחק לצמיתות את כל הדוחות שנקלטו ואת נתוני המשמרות. לאחר מכן תוכל לייבא מחדש. להמשיך?',
      'מחיקת כל הדוחות',
      'מחק הכל'
    );
    if (!ok) return;
    setDeletingAll(true);
    try {
      const { data: res } = await api.delete('/zreport/all');
      toast(res.message || 'כל דוחות ה-Z נמחקו', 'success');
      load();
    } catch {
      toast('שגיאה במחיקת הדוחות', 'error');
    }
    setDeletingAll(false);
  };

  useEffect(() => {
    load();
    businessApi.get().then(({ data: biz }) => setBusinessName(biz.name || '')).catch(() => {});
  }, []);

  // Auto-open coverage card when data quality is incomplete (score < 3)
  useEffect(() => {
    if (!status) return;
    const cov = status.coverage;
    const score = [cov?.hasRevenue, cov?.hasItems, cov?.hasShifts].filter(Boolean).length;
    if (score < 3) setCoverageOpen(true);
  }, [status]);

  // Handle OAuth callback params
  useEffect(() => {
    const connected = searchParams.get('gmail_connected');
    const email     = searchParams.get('email');
    const error     = searchParams.get('gmail_error');
    if (connected === '1') {
      toast(`Gmail מחובר בהצלחה${email ? ` (${decodeURIComponent(email)})` : ''} — מייבא היסטוריה ברקע...`, 'success');
      router.replace('/zreport');
    } else if (error) {
      toast(decodeURIComponent(error), 'error');
      router.replace('/zreport');
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useSyncEvent(['dashboard.refresh', 'finance.updated'], () => load());

  const showDateRange = () => {
    if (!data?.date_from || !data?.date_to) {
      toast('אין עדיין דוחות במערכת', 'info');
      return;
    }
    toast(
      `טווח הדוחות שנקלטו: ${fmtDate(data.date_from)} עד ${fmtDate(data.date_to)} (${fmtNum(data.total_transactions)} דוחות)`,
      'info'
    );
  };

  const uploadFile = async (file: File, clearRef?: React.RefObject<HTMLInputElement | null>) => {
    setUploading(true);
    setUploadResult(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const { data: res } = await api.post('/zreport/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUploadResult({ imported: res.imported || 0, skipped: res.skipped || 0 });
      setNewFormat(res.newFormatLearned || null);
      setMultiZWithItems(res.multiZWithItems || null);
      setDateConflicts(res.dateConflicts || []);
      if (res.unmatchedEmployees?.length > 0) {
        setUnmatchedEmployees(res.unmatchedEmployees);
        setExistingUsers(res.existingUsers ?? []);
        setMatchSelections({});
      }
      if (res.imported > 0) {
        const unmatchedMsg = res.unmatchedEmployees?.length > 0
          ? ` — ${res.unmatchedEmployees.length} עובדים ממתינים להתאמה`
          : '';
        toast(`יובאו ${res.imported} דוחות בהצלחה!${unmatchedMsg}`, 'success');
      } else if (res.itemsRefreshed) {
        toast('פירוט המנות עודכן בהצלחה לדוח הקיים', 'success');
      } else if (res.skipped > 0) {
        toast(`הדוחות כבר קיימים במערכת`, 'info');
      } else {
        toast('לא נמצאו דוחות בקובץ', 'info');
      }
      load();
    } catch (err: unknown) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בייבוא הקובץ', 'error');
    }
    setUploading(false);
    if (clearRef?.current) clearRef.current.value = '';
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file, fileRef);
    if (cameraRef.current) cameraRef.current.value = '';
  };

  const handleMatchEmployee = async (employeeName: string, userId: string) => {
    if (!userId) { toast('יש לבחור עובד מהרשימה', 'error'); return; }
    setMatchingSaving(prev => ({ ...prev, [employeeName]: true }));
    try {
      await api.post('/zreport/match-employee', { employeeName, userId });
      setUnmatchedEmployees(prev => prev.filter(e => e.name !== employeeName));
      setMatchSelections(prev => { const next = { ...prev }; delete next[employeeName]; return next; });
      toast(`${employeeName} שויך בהצלחה — המשמרות מסונכרנות`, 'success');
      load();
    } catch {
      toast('שגיאה בשיוך העובד', 'error');
    } finally {
      setMatchingSaving(prev => ({ ...prev, [employeeName]: false }));
    }
  };

  const confirmFormat = async () => {
    if (!newFormat) return;
    setConfirmingFormat(true);
    try {
      await api.post(`/zreport/formats/${newFormat.id}/confirm`);
      toast('הפורמט אושר — הוא יזוהה אוטומטית מעכשיו', 'success');
      setNewFormat(null);
    } catch {
      toast('שגיאה באישור הפורמט', 'error');
    } finally { setConfirmingFormat(false); }
  };


  // ── Filtered reports ───────────────────────────────────────────────────────
  const filteredReports = useMemo(() => {
    if (!data?.reports) return [];
    return data.reports.filter(r => {
      const q = query.trim().toLowerCase();
      if (q && !r.pos_sale_id.toLowerCase().includes(q) &&
              !fmtDate(r.sold_at).includes(q) &&
              !String(Math.round(r.total_amount)).includes(q)) return false;
      if (dateFrom && new Date(r.sold_at) < new Date(dateFrom)) return false;
      if (dateTo   && new Date(r.sold_at) > new Date(dateTo + 'T23:59:59')) return false;
      return true;
    });
  }, [data?.reports, query, dateFrom, dateTo]);

  const hasFilter = !!(query || dateFrom || dateTo);
  const clearFilters = () => { setQuery(''); setDateFrom(''); setDateTo(''); };

  const filteredSales = hasFilter ? filteredReports.reduce((s, r) => s + r.total_amount, 0) : (data?.total_sales ?? 0);
  const hasReports    = (data?.total_transactions ?? 0) > 0;

  const KPIS = data ? [
    { label: 'סה"כ מכירות',  val: fmt(hasFilter ? filteredSales : data.total_sales),                                             icon: TrendingUp },
    { label: 'מספר דוחות',   val: hasFilter ? fmtNum(filteredReports.length) : fmtNum(data.total_transactions),                   icon: FileText   },
    { label: 'מע"מ מצטבר',  val: fmt(hasFilter ? (() => { const r = data.vatRate ?? 0.18; return filteredSales * r / (1 + r); })() : data.total_vat), icon: TrendingUp },
    { label: 'ממוצע לדוח',   val: hasFilter && filteredReports.length > 0 ? fmt(filteredSales / filteredReports.length) : fmt(data.avg_ticket), icon: Users },
  ] : [];

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="rounded-2xl p-6 text-white" style={{ background: 'var(--hero-gradient)' }}>
        <h1 className="text-2xl font-black">דוחות</h1>
        <p className="text-sm mt-1 opacity-60">ייבוא ועיון בדוחות מקופה — EML או XLSX</p>
      </div>

      {/* Says outright whether the data for the selected range is actually
          there. Gated on canReportFinancials so a partial month cannot be
          mistaken for a complete one. */}
      <ZCoverageBanner from={dateFrom || undefined} to={dateTo || undefined} />

      {/* Detected open days (auto-synced from Z-reports) */}
      {!loading && status && status.totalZDays > 0 && (
        <div className="rounded-2xl px-5 py-3 flex flex-wrap items-center gap-3"
          style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.18)' }}>
          <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#c9a227' }} />
          <span className="text-sm font-semibold" style={{ color: '#c9a227' }}>ימי פעילות שזוהו מהדוחות:</span>
          <div className="flex gap-1 flex-wrap">
            {['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'].map((name, dow) => {
              const isOpen = (status.openDays ?? []).includes(dow);
              return (
                <span key={dow} className="text-xs px-2 py-1 rounded-lg font-semibold"
                  style={{
                    background: isOpen ? 'rgba(201,162,39,0.2)' : 'rgba(0,0,0,0.25)',
                    color: isOpen ? '#c9a227' : 'rgba(255,255,255,0.3)',
                    border: `1px solid ${isOpen ? 'rgba(201,162,39,0.35)' : 'rgba(255,255,255,0.06)'}`,
                  }}>
                  {name}
                </span>
              );
            })}
          </div>
          <span className="text-xs opacity-40 mr-auto">מבוסס על {status.totalZDays} ימי דיווח · מסונכרן אוטומטית עם חיזוי ביקוש</span>
        </div>
      )}

      {/* ── hidden file inputs for typed uploads ── */}
      <input ref={revenueRef} type="file" className="hidden" accept=".xlsx,.xls,.csv,.eml,.pdf,.txt,.html,.json,.zip"
        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, revenueRef); }} />
      <input ref={itemsRef}   type="file" className="hidden" accept=".xlsx,.xls,.csv,.eml,.pdf,.txt,.html,.json,.zip"
        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, itemsRef); }} />
      <input ref={shiftsRef}  type="file" className="hidden" accept=".xlsx,.xls,.csv,.eml,.pdf,.txt,.html,.json,.zip"
        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, shiftsRef); }} />

      {/* ── כרטיס כיסוי דוחות — מכווץ כברירת מחדל ─────────────── */}
      {!loading && (status?.totalZDays ?? 0) > 0 && (() => {
        const cov   = status?.coverage;
        const score = [cov?.hasRevenue, cov?.hasItems, cov?.hasShifts].filter(Boolean).length;

        const verdict =
          statusError          ? { label: 'שגיאה בטעינת נתוני כיסוי — לחץ רענן', color: '#ef4444', bg: 'rgba(239,68,68,0.08)', icon: '⚠️' } :
          score === 3 && cov?.hasPaymentDetail
                               ? { label: 'הדוחות שלך מושלמים! המערכת עובדת במלוא הכוח', color: '#4ade80', bg: 'rgba(74,222,128,0.08)', icon: '🚀' } :
          score === 3          ? { label: 'הדוחות שלך טובים מאוד — חסר רק פיצול תשלומים (לא קריטי)', color: '#4ade80', bg: 'rgba(74,222,128,0.08)', icon: '✅' } :
          score === 2          ? { label: 'הדוחות טובים — חסר עוד רכיב אחד', color: '#c9a227', bg: 'rgba(201,162,39,0.08)', icon: '📈' } :
                                 { label: 'הדוחות בסיסיים — כדאי לשפר כדי לנצל את המערכת', color: '#f97316', bg: 'rgba(249,115,22,0.08)', icon: '⚠️' };

        const UploadBtn = ({ label, inputRef }: { label: string; inputRef: React.RefObject<HTMLInputElement | null> }) => (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-all"
            style={{
              background: 'rgba(201,162,39,0.12)', color: '#c9a227',
              border: '1px solid rgba(201,162,39,0.25)',
              opacity: uploading ? 0.5 : 1,
              cursor: uploading ? 'not-allowed' : 'pointer',
            }}
          >
            <Upload className="w-3 h-3 flex-shrink-0" />
            {uploading ? 'מעלה...' : label}
          </button>
        );

        return (
        <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.12)' }}>

          {/* Toggle bar — לחצן קטן לפתיחה/סגירה */}
          <button
            type="button"
            onClick={() => setCoverageOpen(o => !o)}
            className="w-full px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
            style={{ borderBottom: coverageOpen ? '1px solid rgba(201,162,39,0.10)' : 'none' }}
          >
            <span className="text-sm leading-none flex-shrink-0">📋</span>
            <div className="flex-1 min-w-0 text-right">
              <span className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>מה יש בדוחות שלך?</span>
              <span className="text-xs mx-2" style={{ color: '#4b5563' }}>·</span>
              <span className="text-xs" style={{ color: '#6b7280' }}>
                {statusError ? 'שגיאה בטעינה' : `${status!.totalZDays} ימי דיווח`}
              </span>
            </div>
            {!statusError && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold flex-shrink-0"
                style={{ background: verdict.bg, color: verdict.color }}>
                <span>{verdict.icon}</span>
                <span>{score}/3</span>
              </div>
            )}
            {statusError && (
              <button onClick={(e) => { e.stopPropagation(); load(); }}
                className="text-xs px-2 py-0.5 rounded flex-shrink-0"
                style={{ color: '#c9a227', background: 'rgba(201,162,39,0.1)' }}>
                רענן
              </button>
            )}
            {/* חץ — בצד שמאל (אחרון ב-RTL flex) */}
            {coverageOpen
              ? <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: '#6b7280' }} />
              : <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: '#6b7280' }} />}
          </button>

          {/* תוכן מורחב */}
          {coverageOpen && (
            <>
              {/* Verdict banner */}
              <div className="px-5 py-2 text-xs font-semibold" style={{ background: verdict.bg, color: verdict.color, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                {verdict.label}
              </div>

              {/* 4 columns */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.05]">

                {/* בלוק 1: הכנסות */}
                {(() => {
                  const ok       = cov?.hasRevenue          ?? false;
                  const payOk    = cov?.hasPaymentDetail    ?? false;
                  const days     = cov?.revenueDays         ?? 0;
                  const payDays  = cov?.paymentDetailCount  ?? 0;
                  return (
                    <div className="p-5 flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl leading-none flex-shrink-0">💰</span>
                        <div className="min-w-0">
                          <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>דוח הכנסות</p>
                          {ok && <p className="text-lg font-black tabular-nums mt-0.5" style={{ color: '#4ade80' }}>{days} ימים</p>}
                          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#6b7280' }}>סכום מכירות יומי — הבסיס של כל ניתוח פיננסי</p>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 ${ok ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-500'}`}>
                          <span>{ok ? '✅' : '⬜'}</span>
                          <span>סכום כולל יומי {ok ? `— ${days} ימי דיווח` : '— חסר'}</span>
                        </div>
                        <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 ${payOk ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-500'}`}>
                          <span>{payOk ? '✅' : '○'}</span>
                          <span>פיצול תשלום {payOk && days > 0 ? `— ${payDays} מתוך ${days} ימים` : payOk ? '— יש!' : '— לא נמצא'}</span>
                        </div>
                      </div>
                      {!ok && <><p className="text-xs" style={{ color: '#ef4444' }}>חסר — זהו הדוח הבסיסי ביותר</p><UploadBtn label="העלה דוח הכנסות" inputRef={revenueRef} /></>}
                    </div>
                  );
                })()}

                {/* בלוק 2: מנות */}
                {(() => {
                  const ok    = cov?.hasItems   ?? false;
                  const count = cov?.itemsCount ?? 0;
                  return (
                    <div className="p-5 flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl leading-none flex-shrink-0">🍽️</span>
                        <div className="min-w-0">
                          <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>דוח פירוט מנות</p>
                          {ok && <p className="text-lg font-black tabular-nums mt-0.5" style={{ color: '#4ade80' }}>{count.toLocaleString('he-IL')} שורות</p>}
                          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#6b7280' }}>פירוט כל מנה שנמכרה — מפעיל ניתוח תפריט ומלאי</p>
                        </div>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} ניתוח תפריט — מה נמכר הכי טוב</p>
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} מלאי יורד אוטומטית</p>
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} יועץ AI יודע מה פופולרי</p>
                      </div>
                      {!ok && <><p className="text-xs" style={{ color: '#c9a227' }}>לפעמים זה גיליון נפרד ב-XLSX</p><UploadBtn label="העלה דוח מנות בנפרד" inputRef={itemsRef} /></>}
                    </div>
                  );
                })()}

                {/* בלוק 3: משמרות */}
                {(() => {
                  const ok    = cov?.hasShifts   ?? false;
                  const count = cov?.shiftsCount ?? 0;
                  return (
                    <div className="p-5 flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl leading-none flex-shrink-0">⏰</span>
                        <div className="min-w-0">
                          <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>דוח משמרות</p>
                          {ok && <p className="text-lg font-black tabular-nums mt-0.5" style={{ color: '#4ade80' }}>{count.toLocaleString('he-IL')} משמרות</p>}
                          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#6b7280' }}>שעות עבודה — שכר, עלות כוח אדם, חיזוי ביקוש</p>
                        </div>
                      </div>
                      <div className="space-y-1 text-xs">
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} תלוש שכר חודשי אוטומטי</p>
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} עלות עבודה בדוח שבועי</p>
                        <p style={{ color: ok ? '#4ade80' : '#374151' }}>{ok ? '✓' : '○'} חיזוי ביקוש — כמה עובדים לכל יום</p>
                      </div>
                      {ok && <a href="/forecast" className="text-xs font-semibold mt-1" style={{ color: '#c9a227' }}>ראה חיזוי עובדים לשבוע הבא ←</a>}
                      {!ok && <><p className="text-xs" style={{ color: '#c9a227' }}>לפעמים זה גיליון נפרד ב-XLSX</p><UploadBtn label="העלה דוח משמרות בנפרד" inputRef={shiftsRef} /></>}
                    </div>
                  );
                })()}

                {/* בלוק 4: דיליברי */}
                {(() => {
                  const ok    = cov?.hasDeliveryData      ?? false;
                  const count = cov?.deliveryOrdersCount  ?? 0;
                  return (
                    <div className="p-5 flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl leading-none flex-shrink-0">🛵</span>
                        <div className="min-w-0">
                          <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>וולט / תן ביס</p>
                          {ok && <p className="text-lg font-black tabular-nums mt-0.5" style={{ color: '#4ade80' }}>{count.toLocaleString('he-IL')} הזמנות</p>}
                          <p className="text-xs mt-1 leading-relaxed" style={{ color: '#6b7280' }}>הזמנות ישירות מהפלטפורמה — ריצ&#x27;וק מסירה מדויק</p>
                        </div>
                      </div>
                      <a href="/deliveries"
                        className="mt-auto w-full flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-all"
                        style={{ background: 'rgba(201,162,39,0.12)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.25)' }}>
                        <span>{ok ? 'ראה דוח דיליברי ←' : 'חבר וולט / תן ביס ←'}</span>
                      </a>
                    </div>
                  );
                })()}
              </div>

              {/* ── 4 ממדים נוספים ───────────────────────────────── */}
              {!statusError && cov && (
                <div className="px-5 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.15)' }}>

                  {/* ממד 1: רעננות */}
                  {(() => {
                    const days = cov.daysSinceLastReport;
                    const fresh = cov.isFresh;
                    const color = days === null ? '#4b5563' : fresh ? '#4ade80' : days <= 14 ? '#c9a227' : '#ef4444';
                    return (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>רעננות נתונים</p>
                        <p className="text-sm font-bold" style={{ color }}>
                          {days === null ? '—' : days === 0 ? 'היום' : `לפני ${days} ימים`}
                        </p>
                        <p className="text-xs" style={{ color: '#4b5563' }}>
                          {days === null ? 'אין דוחות' : fresh ? 'עדכני ✓' : days <= 14 ? 'קצת ישן' : 'דורש טיפול'}
                        </p>
                      </div>
                    );
                  })()}

                  {/* ממד 2: יחס כיסוי 30 יום */}
                  {(() => {
                    const ratio = cov.coverageRatio;
                    const covered = cov.coveredDays30 ?? 0;
                    const expected = cov.expectedDays30 ?? 0;
                    const color = ratio === null ? '#4b5563' : ratio >= 90 ? '#4ade80' : ratio >= 70 ? '#c9a227' : '#ef4444';
                    return (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>כיסוי 30 יום</p>
                        <p className="text-sm font-bold tabular-nums" style={{ color }}>
                          {ratio !== null ? `${ratio}%` : '—'}
                        </p>
                        <p className="text-xs" style={{ color: '#4b5563' }}>
                          {expected > 0 ? `${covered}/${expected} ימי פעילות` : 'לא מוגדרים ימי פעילות'}
                        </p>
                      </div>
                    );
                  })()}

                  {/* ממד 3: פורמט מאושר */}
                  {(() => {
                    const confirmed = cov.hasConfirmedFormat;
                    return (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>זיהוי קופה</p>
                        <p className="text-sm font-bold" style={{ color: confirmed ? '#4ade80' : '#c9a227' }}>
                          {confirmed ? 'פורמט מאושר ✓' : 'בלמידה'}
                        </p>
                        <p className="text-xs" style={{ color: '#4b5563' }}>
                          {confirmed ? 'זיהוי מהיר בכל ייבוא' : 'AI מזהה בכל פעם'}
                        </p>
                      </div>
                    );
                  })()}

                  {/* ממד 4: שיוך עובדים */}
                  {(() => {
                    const rate = cov.employeeMatchRate;
                    const total = cov.totalShifts ?? 0;
                    const matched = cov.matchedShifts ?? 0;
                    const color = total === 0 ? '#4b5563' : rate! >= 90 ? '#4ade80' : rate! >= 60 ? '#c9a227' : '#ef4444';
                    return (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>שיוך עובדים</p>
                        <p className="text-sm font-bold tabular-nums" style={{ color }}>
                          {total === 0 ? '—' : `${rate}%`}
                        </p>
                        <p className="text-xs" style={{ color: '#4b5563' }}>
                          {total === 0 ? 'אין משמרות' : `${matched}/${total} משמרות משויכות`}
                        </p>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Missing days section */}
              {!statusError && status && status.missingDays.length > 0 && (
                <div className="px-5 py-3 flex flex-wrap items-start gap-3"
                  style={{ borderTop: '1px solid rgba(239,68,68,0.15)', background: 'rgba(239,68,68,0.05)' }}>
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold" style={{ color: '#f87171' }}>
                      חסרים {status.missingDays.length} ימי דיווח
                    </p>
                    <p className="text-xs mt-1 leading-relaxed" style={{ color: '#6b7280' }}>
                      {status.missingDays.map(d => {
                        const [y, m, day] = d.split('-');
                        return `${day}/${m}/${y}`;
                      }).join(' · ')}
                    </p>
                  </div>
                </div>
              )}

              {/* Footer */}
              {!statusError && (
                <div className="px-5 py-2.5 flex items-center gap-2 text-xs" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: '#4b5563' }}>
                  <span>💡</span>
                  <span>
                    {score === 3 && cov?.hasPaymentDetail ? 'כל הנתונים נטענו — המערכת עובדת במלוא הכוח.' :
                     score === 3 ? 'כל הנתונים העיקריים נטענו. פיצול תשלומים הוא בונוס.' :
                     score > 0 ? `${3 - score} רכיבים עיקריים חסרים — העלה את הקבצים המתאימים.` :
                     'העלה דוח כדי שהמערכת תתחיל לעבוד.'}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        );
      })()}

      {/* Last Z-report — shown immediately after header so it's the first thing visible */}
      {!loading && !data?.lastReport && (
        <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50 px-6 py-5 flex items-center gap-4">
          <Receipt className="w-8 h-8 text-amber-400 flex-shrink-0" />
          <div>
            <p className="font-semibold text-amber-800 text-sm">אין דוחות עדיין</p>
            <p className="text-xs text-amber-600 mt-0.5">העלה קובץ EML מהמייל של BeePort (או XLSX) — הדוח האחרון יופיע כאן.</p>
          </div>
        </div>
      )}

      {/* ── Gmail OAuth — חיבור חכם אוטומטי ─────────────────────── */}
      {!loading && (
        <GmailConnectCard onImported={onGmailImported} businessName={businessName} />
      )}

      {!loading && data?.lastReport && (
        <div className="rounded-2xl border overflow-hidden shadow-sm"
          style={{ borderColor: 'var(--card-border-color, rgba(201,162,39,0.18))', background: '#141418' }}>

          {/* Card header — gradient banner */}
          <div className="px-5 py-4 flex items-center justify-between"
            style={{ background: 'var(--hero-gradient)', borderBottom: showLastItems ? '1px solid var(--card-border-color, #e5e7ab)' : 'none' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.18)' }}>
                <Receipt className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="font-black text-white text-base leading-tight">
                  הדוח האחרון — {data.lastReport.pos_sale_id}
                </p>
                <p className="text-sm font-semibold mt-1" style={{ color: 'rgba(255,255,255,0.9)' }}>
                  {fmtDateFull(data.lastReport.sold_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xl font-black text-white">{fmt(data.lastReport.total_amount)}</p>
                <p className="text-xs" style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {data.lastReport.items?.length ?? 0} פריטים
                </p>
              </div>
              <button
                onClick={() => setShowLastItems(v => !v)}
                className="p-1.5 rounded-xl transition-colors"
                style={{ background: 'rgba(255,255,255,0.15)' }}
                title={showLastItems ? 'כווץ' : 'הרחב'}
              >
                {showLastItems
                  ? <ChevronUp className="w-4 h-4 text-white" />
                  : <ChevronDown className="w-4 h-4 text-white" />}
              </button>
            </div>
          </div>

          {/* Items table */}
          {showLastItems && (
            data.lastReport.items?.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs" style={{ background: '#111116', color: '#9aa0ab' }}>
                      <th className="text-right px-5 py-2.5 font-semibold">פריט</th>
                      <th className="text-right px-4 py-2.5 font-semibold">כמות</th>
                      <th className="text-right px-4 py-2.5 font-semibold">מחיר יחידה</th>
                      <th className="text-left px-5 py-2.5 font-semibold">סה"כ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lastReport.items.map((item, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#141418' : '#111116' }}>
                        <td className="px-5 py-2.5 font-medium" style={{ color: '#e8e8e4' }}>{item.name}</td>
                        <td className="px-4 py-2.5" style={{ color: '#9aa0ab' }}>{fmtNum(item.qty)}</td>
                        <td className="px-4 py-2.5" style={{ color: '#9aa0ab' }}>{fmt(item.unit_price)}</td>
                        <td className="px-5 py-2.5 text-left font-bold" style={{ color: 'var(--color-primary)' }}>{fmt(item.total_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold text-sm" style={{ background: '#0f0f14' }}>
                      <td className="px-5 py-2.5" style={{ color: '#b8bcc4' }} colSpan={3}>סה"כ</td>
                      <td className="px-5 py-2.5 text-left" style={{ color: 'var(--color-primary)' }}>
                        {fmt(data.lastReport.total_amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="px-5 py-6 text-sm text-center" style={{ color: '#9aa0ab' }}>
                אין פירוט פריטים לדוח זה
              </div>
            )
          )}
        </div>
      )}

      {/* Upload */}
      <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.25)' }}>
        {/* Drop zone */}
        <label htmlFor="zreport-upload"
          className="block px-6 pt-6 pb-5 cursor-pointer transition-colors group"
          style={{ pointerEvents: uploading ? 'none' : 'auto' }}
          onDragOver={e => { e.preventDefault(); e.currentTarget.style.background = 'rgba(201,162,39,0.06)'; }}
          onDragLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          onDrop={e => {
            e.preventDefault();
            e.currentTarget.style.background = 'transparent';
            const file = e.dataTransfer.files?.[0];
            if (file) uploadFile(file);
          }}
        >
          <div className="flex flex-col items-center gap-3 py-4 rounded-xl border-2 border-dashed transition-colors"
            style={{ borderColor: uploading ? 'rgba(201,162,39,0.15)' : 'rgba(201,162,39,0.3)' }}>
            {uploading
              ? <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#c9a227' }} />
              : <Upload className="w-8 h-8 transition-transform group-hover:scale-110" style={{ color: '#c9a227' }} />
            }
            <div className="text-center">
              <p className="font-bold text-sm" style={{ color: '#e8e8e4' }}>
                {uploading ? 'מייבא את הקובץ...' : 'העלה קובץ אחד — המערכת תמצא הכל'}
              </p>
              <p className="text-xs mt-1" style={{ color: '#6b7280' }}>
                {uploading
                  ? 'ממתין לסיום הייבוא'
                  : 'גרור לכאן או לחץ לבחירה · XLSX, EML, CSV, PDF, תמונה'}
              </p>
              {!uploading && (
                <p className="text-xs mt-1.5 px-4" style={{ color: '#4b5563' }}>
                  רוב מערכות הקופה שולחות הכנסות + מנות + משמרות בקובץ אחד.
                  אם משהו חסר — תראה זאת בכרטיס הכיסוי למעלה ותוכל להשלים שם.
                </p>
              )}
            </div>
          </div>
        </label>

        <div className="px-6 pb-5 flex items-center gap-3 flex-wrap" style={{ borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '1rem' }}>
        <input ref={fileRef} type="file" accept=".eml,.xlsx,.xls,.csv,.json,.zip,.xml,.pdf,.jpg,.jpeg,.png,.webp" onChange={handleUpload}
          className="hidden" id="zreport-upload" />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleUpload}
          className="hidden" id="zreport-camera" />
          <label htmlFor="zreport-camera"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold cursor-pointer"
            style={{ background: 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.2)', color: '#c9a227', pointerEvents: uploading ? 'none' : 'auto' }}>
            <Camera className="w-4 h-4" />
            צלם דוח
          </label>
          <button
            type="button"
            onClick={showDateRange}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-colors"
            style={{ background: 'rgba(201,162,39,0.1)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}
          >
            <CalendarDays className="w-4 h-4" />
            טווח תאריכים
          </button>
          {hasReports && (
            <div className="flex items-center gap-2 mr-auto">
              <button
                type="button"
                onClick={() => selectedIds.size === 0 ? toast('סמן דוחות בטבלה למטה תחילה', 'info') : handleDeleteSelected()}
                disabled={deletingSelected}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-colors disabled:opacity-50"
                style={{ background: 'rgba(220,38,38,0.1)', color: '#ef4444', border: '1px solid rgba(220,38,38,0.3)' }}
              >
                {deletingSelected ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {deletingSelected ? 'מוחק...' : selectedIds.size > 0 ? `מחק נבחרים (${selectedIds.size})` : 'מחק נבחרים'}
              </button>
              <button
                type="button"
                onClick={handleDeleteAll}
                disabled={deletingAll}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-colors disabled:opacity-50"
                style={{ background: 'rgba(220,38,38,0.1)', color: '#ef4444', border: '1px solid rgba(220,38,38,0.3)' }}
                title="מחק את כל דוחות ה-Z ואפס מחדש"
              >
                {deletingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {deletingAll ? 'מוחק...' : 'מחק הכל'}
              </button>
            </div>
          )}
        </div>

        {(uploadResult || newFormat) && (
          <div className="px-6 pb-5 space-y-3">
        {uploadResult && uploadResult.imported > 0 && (
          <div className="flex items-center gap-2 text-sm bg-green-50 border border-green-200 rounded-xl px-4 py-3">
            <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
            <span className="text-green-800">
              יובאו <strong>{uploadResult.imported}</strong> רשומות
              {uploadResult.skipped > 0 && ` · ${uploadResult.skipped} דולגו (כפולות)`}
            </span>
          </div>
        )}
        {uploadResult && uploadResult.imported === 0 && uploadResult.skipped > 0 && (
          <div className="flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
            <span className="text-blue-800">
              כל {uploadResult.skipped} הדוחות כבר קיימים במערכת — לא נוספו רשומות חדשות
            </span>
          </div>
        )}

        {multiZWithItems && (
          <div className="mt-4 flex items-start gap-3 text-sm bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <span className="text-blue-900">
              <strong>קובץ עם {multiZWithItems.zCount} ימי דיווח.</strong>{' '}
              הכנסות נקלטו לכל הימים — אבל פירוט מנות שמור רק עבור הדוח האחרון.
              לניתוח תפריט מדויק, המערכת מיועדת לעבוד עם דוח יומי (כל יום = קובץ אחד, בדרך כלל דרך המייל).
            </span>
            <button onClick={() => setMultiZWithItems(null)} className="text-blue-400 hover:text-blue-600 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {dateConflicts.length > 0 && (
          <div className="mt-4 flex items-start gap-3 text-sm bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
            <span className="text-orange-900">
              <strong>זוהה חוסר עקביות במספרי Z:</strong>{' '}
              {dateConflicts.length === 1
                ? `${dateConflicts[0].posId} כבר קיים מתאריך ${dateConflicts[0].existingDate} — הקובץ הנוכחי מדווח על ${dateConflicts[0].newDate}.`
                : `${dateConflicts.length} דוחות Z קיימים בתאריכים שונים מהקובץ שהועלה.`
              }{' '}
              ייתכן שמונה ה-Z אופס בקופה. הדוחות עודכנו בהתאם לקובץ החדש.
            </span>
            <button onClick={() => setDateConflicts([])} className="text-orange-400 hover:text-orange-600 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {newFormat && (
          <div className="mt-4 flex items-center gap-3 text-sm bg-violet-50 border border-violet-200 rounded-xl px-4 py-3">
            <Sparkles className="w-4 h-4 text-violet-600 flex-shrink-0" />
            <span className="text-violet-900 flex-1">
              <strong>פורמט קופה חדש זוהה!</strong>{' '}
              {newFormat.zCount ? `נמצאו ${newFormat.zCount} ימי דיווח` : 'יובאו נתוני דיווח'}
              {newFormat.hasItems ? ', פירוט מנות' : ''}
              {newFormat.hasShifts ? ', משמרות עובדים' : ''}.{' '}
              בדוק שהנתונים למעלה נכונים — לאחר אישור, קבצים מאותה מערכת קופה יזוהו אוטומטית תמיד.
            </span>
            <button onClick={confirmFormat} disabled={confirmingFormat}
              className="flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 flex-shrink-0">
              {confirmingFormat ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              הנתונים נכונים
            </button>
            <button onClick={() => setNewFormat(null)} className="text-violet-400 hover:text-violet-600 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
          </div>
        )}

        {/* ── כרטיס התאמת עובדים ידנית ── */}
        {unmatchedEmployees.length > 0 && (
          <div className="mx-6 mb-5 rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.04)' }}>
            <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(251,191,36,0.2)', background: 'rgba(251,191,36,0.08)' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: '#fbbf24' }} />
              <div className="flex-1">
                <p className="text-sm font-bold" style={{ color: '#fbbf24' }}>
                  {unmatchedEmployees.length} עובדים לא זוהו אוטומטית
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'rgba(251,191,36,0.7)' }}>
                  שייך אותם לחשבונות קיימים כדי שהמשמרות ישוקפו בדוחות
                </p>
              </div>
            </div>
            <div className="divide-y" style={{ borderColor: 'rgba(251,191,36,0.1)' }}>
              {unmatchedEmployees.map(emp => (
                <div key={emp.name} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'rgba(251,191,36,0.15)' }}>
                    <UserCheck className="w-3.5 h-3.5" style={{ color: '#fbbf24' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>{emp.name}</p>
                    <p className="text-xs" style={{ color: '#9aa0ab' }}>{emp.shiftCount} משמרות ממתינות</p>
                  </div>
                  <select
                    value={matchSelections[emp.name] ?? ''}
                    onChange={e => setMatchSelections(prev => ({ ...prev, [emp.name]: e.target.value }))}
                    className="text-sm rounded-xl px-3 py-2 flex-shrink-0"
                    style={{ background: '#1a1a22', border: '1px solid rgba(201,162,39,0.25)', color: matchSelections[emp.name] ? '#e8e8e4' : '#9aa0ab', minWidth: '160px' }}
                  >
                    <option value="">— בחר עובד —</option>
                    {existingUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleMatchEmployee(emp.name, matchSelections[emp.name] ?? '')}
                    disabled={!matchSelections[emp.name] || !!matchingSaving[emp.name]}
                    className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl transition-all disabled:opacity-40 flex-shrink-0"
                    style={{ background: matchSelections[emp.name] ? '#c9a227' : 'rgba(201,162,39,0.15)', color: matchSelections[emp.name] ? '#050507' : '#9aa0ab' }}>
                    {matchingSaving[emp.name] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    שייך
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> טוען נתונים...
        </div>
      ) : (
        <>
          {/* KPI cards — always visible */}
          {hasReports && (
            <>
              {(data?.date_from && !hasFilter) && (
                <p className="text-xs" style={{ color: '#9aa0ab' }}>
                  נתונים מ-{fmtDate(data.date_from)} עד {fmtDate(data.date_to!)}
                </p>
              )}
              {hasFilter && (
                <p className="text-xs" style={{ color: '#9aa0ab' }}>מציג {filteredReports.length} מתוך {data?.reports.length} דוחות</p>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {KPIS.map(k => {
                  const Icon = k.icon;
                  return (
                    <div key={k.label} className="rounded-2xl p-5" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs" style={{ color: '#9aa0ab' }}>{k.label}</p>
                        <Icon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
                      </div>
                      <p className="text-xl font-black" style={{ color: 'var(--color-primary)' }}>{k.val}</p>
                    </div>
                  );
                })}
              </div>


              {/* VAT rate editor */}
              {data && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs" style={{ color: '#9aa0ab' }}>שיעור מע"מ:</span>
                  {editingVat ? (
                    <>
                      <input
                        type="number" min="0" max="100" step="0.1"
                        value={vatInput}
                        onChange={e => setVatInput(e.target.value)}
                        className="w-16 text-center text-xs rounded-lg px-2 py-1 focus:outline-none"
                        style={{ border: '1px solid rgba(201,162,39,0.4)', background: '#111116', color: '#e8e8e4' }}
                        placeholder="%"
                      />
                      <span className="text-xs" style={{ color: '#9aa0ab' }}>%</span>
                      <button
                        onClick={async () => {
                          const pct = parseFloat(vatInput);
                          if (isNaN(pct) || pct < 0 || pct > 100) return;
                          try {
                            await api.put('/zreport/vat-rate', { vatRate: pct / 100 });
                            setData(d => d ? { ...d, vatRate: pct / 100 } : d);
                            setEditingVat(false);
                            toast('שיעור מע"מ עודכן', 'success');
                          } catch { toast('עדכון נכשל', 'error'); }
                        }}
                        className="text-xs px-2 py-0.5 rounded-lg font-semibold"
                        style={{ background: '#f59e0b', color: '#0a0a0e' }}
                      >שמור</button>
                      <button onClick={() => setEditingVat(false)} className="text-xs" style={{ color: '#9aa0ab' }}>ביטול</button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-semibold" style={{ color: '#e8e8e4' }}>{((data.vatRate ?? 0.18) * 100).toFixed(0)}%</span>
                      <button
                        onClick={() => { setVatInput(String(((data.vatRate ?? 0.18) * 100).toFixed(1))); setEditingVat(true); }}
                        className="text-xs px-1.5 py-0.5 rounded-lg"
                        style={{ background: '#1a1a22', color: '#9aa0ab', border: '1px solid rgba(201,162,39,0.2)' }}
                      >שנה</button>
                    </>
                  )}
                </div>
              )}
            </>
          )}


          {/* Search + Table — always rendered */}
          <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
            {/* Search bar */}
            <div className="px-5 py-4 flex flex-wrap items-center gap-3" style={{ borderBottom: '1px solid rgba(201,162,39,0.12)' }}>
              <p className="font-semibold shrink-0" style={{ color: '#e8e8e4' }}>
                {hasReports ? `דוחות (${data?.reports.length})` : 'חיפוש דוחות'}
              </p>
              {selectedIds.size > 0 && (
                <button
                  onClick={handleDeleteSelected}
                  disabled={deletingSelected}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50"
                  style={{ background: 'rgba(220,38,38,0.15)', color: '#ef4444', border: '1px solid rgba(220,38,38,0.35)' }}
                >
                  {deletingSelected ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  {deletingSelected ? 'מוחק...' : `מחק נבחרים (${selectedIds.size})`}
                </button>
              )}

              <div className="relative flex-1 min-w-[160px] max-w-xs">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="חיפוש לפי מספר Z, תאריך, סכום..."
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="w-full pr-9 pl-3 py-2 text-sm rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-600/40"
                  style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                />
              </div>

              <DateRangePicker
                from={dateFrom} to={dateTo}
                onFromChange={setDateFrom}
                onToChange={setDateTo}
              />
            </div>

            {/* Table body */}
            <div className="overflow-x-auto">
              {!hasReports && !hasFilter ? (
                <div className="flex flex-col items-center justify-center py-14" style={{ color: '#9aa0ab' }}>
                  <AlertTriangle className="w-10 h-10 mb-3 text-amber-400" />
                  <p className="font-semibold" style={{ color: '#b8bcc4' }}>אין דוחות עדיין</p>
                  <p className="text-sm mt-1">העלה קובץ EML/XLSX מהקופה</p>
                </div>
              ) : filteredReports.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12" style={{ color: '#9aa0ab' }}>
                  <Search className="w-8 h-8 mb-2 opacity-40" />
                  <p className="text-sm">לא נמצאו דוחות התואמים את החיפוש</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs" style={{ background: '#111116', color: '#9aa0ab' }}>
                      <th className="px-3 py-3 w-8">
                        <input
                          type="checkbox"
                          checked={filteredReports.length > 0 && filteredReports.every(r => selectedIds.has(r.pos_sale_id))}
                          onChange={e => {
                            if (e.target.checked) setSelectedIds(new Set(filteredReports.map(r => r.pos_sale_id)));
                            else setSelectedIds(new Set());
                          }}
                          style={{ accentColor: '#ef4444', width: 14, height: 14, cursor: 'pointer' }}
                        />
                      </th>
                      <th className="text-right px-4 py-3 font-semibold">מספר Z</th>
                      <th className="text-right px-5 py-3 font-semibold">תאריך</th>
                      <th className="text-left px-5 py-3 font-semibold">סכום</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReports.map((r, i) => {
                      const isSelected = selectedIds.has(r.pos_sale_id);
                      return (
                        <tr
                          key={r.pos_sale_id}
                          style={{ background: isSelected ? 'rgba(220,38,38,0.07)' : i % 2 === 0 ? '#141418' : '#111116' }}
                        >
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={e => {
                                const next = new Set(selectedIds);
                                if (e.target.checked) next.add(r.pos_sale_id);
                                else next.delete(r.pos_sale_id);
                                setSelectedIds(next);
                              }}
                              style={{ accentColor: '#ef4444', width: 14, height: 14, cursor: 'pointer' }}
                            />
                          </td>
                          <td className="px-4 py-3 font-mono font-semibold" style={{ color: isSelected ? '#ef4444' : '#e8e8e4' }}>{r.pos_sale_id}</td>
                          <td className="px-5 py-3" style={{ color: '#9aa0ab' }}>{fmtDate(r.sold_at)}</td>
                          <td className="px-5 py-3 text-left font-bold" style={{ color: 'var(--color-primary)' }}>{fmt(r.total_amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {hasFilter && filteredReports.length > 0 && (
                    <tfoot>
                      <tr className="bg-slate-100 font-bold text-sm">
                        <td className="px-3 py-3" />
                        <td className="px-4 py-3 text-slate-600" colSpan={2}>סה"כ ({filteredReports.length} דוחות)</td>
                        <td className="px-5 py-3 text-left" style={{ color: 'var(--color-primary)' }}>{fmt(filteredSales)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              )}
            </div>
          </div>

          {/* ── משמרות עובדים ──────────────────────────────────────────── */}
          <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
            {/* כותרת + כפתור ייצוא */}
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(201,162,39,0.12)' }}>
              <div className="flex items-center gap-3">
                <Users className="w-5 h-5" style={{ color: '#c9a227' }} />
                <p className="font-semibold" style={{ color: '#e8e8e4' }}>
                  משמרות עובדים מהדוחות
                  {employees.length > 0 && <span className="mr-2 text-xs font-normal" style={{ color: '#9aa0ab' }}>({employees.length} עובדים)</span>}
                </p>
              </div>
              <button
                onClick={handleExport}
                disabled={exporting || !hasReports}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                style={{ background: 'rgba(201,162,39,0.12)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.25)' }}
              >
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {exporting ? 'מייצא...' : 'ייצא Excel'}
              </button>
            </div>

            {employees.length === 0 ? (
              /* Fallback — אין נתוני משמרות */
              <div className="px-6 py-10 flex flex-col items-center gap-3 text-center">
                <Clock className="w-10 h-10 opacity-25" style={{ color: '#9aa0ab' }} />
                <p className="font-semibold text-sm" style={{ color: '#b8bcc4' }}>לא נמצאו משמרות עובדים בדוחות</p>
                <p className="text-xs max-w-sm leading-relaxed" style={{ color: '#9aa0ab' }}>
                  המשמרות נקלטות אוטומטית אם קובץ ה-XLSX מהקופה מכיל גיליון בשם <strong>«משמרות»</strong> או <strong>«Shifts»</strong>.
                  אם הקופה אינה מצרפת אותו — ניתן להכניס משמרות ידנית במודול <a href="/employees" className="underline" style={{ color: '#c9a227' }}>העובדים</a>.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs" style={{ background: '#111116', color: '#9aa0ab' }}>
                      <th className="text-right px-5 py-3 font-semibold">שם עובד</th>
                      <th className="text-right px-4 py-3 font-semibold">משמרות</th>
                      <th className="text-right px-4 py-3 font-semibold">סה"כ שעות</th>
                      <th className="text-right px-4 py-3 font-semibold">ממוצע/משמרת</th>
                      <th className="text-right px-4 py-3 font-semibold">אחרון</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp, i) => {
                      const name    = emp.full_name || emp.employee_name;
                      const avg     = emp.shifts_count > 0 ? emp.total_hours / emp.shifts_count : 0;
                      const isOpen  = expandedEmp === emp.employee_name;
                      const rowBg   = i % 2 === 0 ? '#141418' : '#111116';
                      return (
                        <React.Fragment key={emp.employee_name}>
                          <tr style={{ background: rowBg }}>
                            <td className="px-5 py-3 font-semibold" style={{ color: '#e8e8e4' }}>
                              <div className="flex items-center gap-2">
                                <UserCheck className="w-3.5 h-3.5 flex-shrink-0" style={{ color: emp.full_name && !emp.is_stub ? '#4ade80' : '#9aa0ab' }} />
                                {name}
                                {emp.is_stub && (
                                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8' }}>ממתין להזמנה</span>
                                )}
                                {!emp.full_name && !emp.is_stub && (
                                  <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(234,179,8,0.12)', color: '#c9a227' }}>לא מקושר</span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 font-mono" style={{ color: '#c9a227' }}>{emp.shifts_count}</td>
                            <td className="px-4 py-3 font-mono" style={{ color: '#e8e8e4' }}>{emp.total_hours.toFixed(1)}h</td>
                            <td className="px-4 py-3 font-mono" style={{ color: '#9aa0ab' }}>{avg.toFixed(1)}h</td>
                            <td className="px-4 py-3 text-xs" style={{ color: '#9aa0ab' }}>{fmtDate(emp.last_shift)}</td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => setExpandedEmp(isOpen ? null : emp.employee_name)}
                                className="p-1 rounded-lg transition-colors"
                                style={{ color: '#9aa0ab' }}
                              >
                                {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr style={{ background: '#0f0f14' }}>
                              <td colSpan={6} className="px-8 py-3">
                                <p className="text-xs font-semibold mb-2" style={{ color: '#9aa0ab' }}>היסטוריית משמרות:</p>
                                <div className="flex flex-wrap gap-2">
                                  {emp.shifts_log.map((s) => (
                                    <span key={s.date} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-mono"
                                      style={{ background: 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }}>
                                      <span style={{ color: '#9aa0ab' }}>{fmtDate(s.date)}</span>
                                      <span style={{ color: '#c9a227' }}>{Number(s.hours).toFixed(1)}h</span>
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
