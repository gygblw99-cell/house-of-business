'use client';

import { useEffect, useState, useRef } from 'react';
import {
  Download, Mail, FileText, TrendingUp, DollarSign, Users,
  Printer, ChevronRight, ChevronLeft, Package } from 'lucide-react';
import { financeApi, exportApi, employeesApi, invoicesApi, inventoryApi } from '@/lib/api';
import { downloadBlob, formatCurrency, getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useAppDialog } from '@/context/AppDialogContext';

const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

type SectionId = 'pl' | 'employees' | 'inventory' | 'invoices' | 'finance';

interface SectionDef {
  id: SectionId;
  label: string;
  Icon: React.ElementType;
  color: string;
}

const SECTIONS: SectionDef[] = [
  { id: 'pl',        label: 'דוח רווח והפסד',  Icon: TrendingUp,   color: 'var(--color-primary,#1a5c2a)' },
  { id: 'employees', label: 'עובדים ומשמרות',   Icon: Users,         color: '#7c3aed' },
  { id: 'invoices',  label: 'חשבוניות ספקים',   Icon: FileText,      color: '#f97316' },
  { id: 'inventory', label: 'מלאי',              Icon: Package,       color: '#0ea5e9' },
  { id: 'finance',   label: 'הוצאות והכנסות',   Icon: DollarSign,    color: '#dc2626' },
];

function exportToCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(','), ...rows.map(r =>
    keys.map(k => {
      const v = String(r[k] ?? '').replace(/"/g, '""');
      return v.includes(',') || v.includes('\n') ? `"${v}"` : v;
    }).join(',')
  )];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename + '.csv'; a.click();
  URL.revokeObjectURL(url);
}

interface PlData {
  revenue: number; cogs: number; grossProfit: number;
  fixedExpenses: number; salaryCost: number; netProfit: number;
  expenseItems: { description: string; amount: number; category: string }[];
  incomeItems:  { description: string; amount: number }[];
  margin?: number;
}

interface EmpRow {
  full_name: string; role: string; salary_type: string;
  total_hours: number; gross_pay: number; shift_count: number;
}

interface InvRow {
  name: string; current_qty: number; unit: string; cost_per_unit?: number; min_qty: number;
}

interface InvItem { name: string; items?: InvRow[] }

interface InvoiceRow {
  invoice_number?: string; total_amount: number; invoice_date: string; is_paid: boolean;
  supplier_name?: string;
}

interface ExpRow { name: string; amount: number; frequency: string; category?: string; is_active: boolean; }
interface IncRow { description: string; amount: number; income_date: string; }

type SectionData = PlData | EmpRow[] | InvRow[] | InvoiceRow[] | { expenses: ExpRow[]; income: IncRow[] };

export default function ReportsTab() {
  const { business } = useAppSelector(s => s.auth);
  const { toast } = useAppDialog();
  const now   = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [selected, setSelected] = useState<Set<SectionId>>(new Set(['pl']));
  const [sectionData, setSectionData] = useState<Partial<Record<SectionId, SectionData>>>({});
  const [sectionLoading, setSectionLoading] = useState<Partial<Record<SectionId, boolean>>>({});

  const [emailTo, setEmailTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const prevMonth = () => { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); };

  const ym = `${year}-${String(month).padStart(2, '0')}`;

  const loadSection = async (id: SectionId) => {
    setSectionLoading(p => ({ ...p, [id]: true }));
    try {
      let data: SectionData;
      if (id === 'pl') {
        const [monthly] = await Promise.all([financeApi.monthly({ year, month }).catch(() => ({ data: null }))]);
        data = monthly.data as PlData ?? { revenue: 0, cogs: 0, grossProfit: 0, fixedExpenses: 0, salaryCost: 0, netProfit: 0, expenseItems: [], incomeItems: [] };
      } else if (id === 'employees') {
        const res = await employeesApi.performance(year, month).catch(() => ({ data: { employees: [] } }));
        data = ((res.data as { employees: EmpRow[] }).employees ?? []) as EmpRow[];
      } else if (id === 'invoices') {
        const res = await invoicesApi.list({ year, month, limit: 200 }).catch(() => ({ data: { invoices: [] } }));
        data = ((res.data as { invoices: InvoiceRow[] }).invoices ?? []) as InvoiceRow[];
      } else if (id === 'inventory') {
        const res = await inventoryApi.list().catch(() => ({ data: [] }));
        data = (Array.isArray(res.data) ? res.data : ((res.data as InvItem).items ?? [])) as InvRow[];
      } else {
        const [expRes, incRes] = await Promise.all([
          financeApi.expenses().catch(() => ({ data: [] })),
          financeApi.income().catch(() => ({ data: [] })),
        ]);
        data = {
          expenses: (Array.isArray(expRes.data) ? expRes.data : []) as ExpRow[],
          income:   (Array.isArray(incRes.data) ? incRes.data : []) as IncRow[],
        };
      }
      setSectionData(p => ({ ...p, [id]: data }));
    } catch (err) {
      toast(getErrorMessage(err) || `שגיאה בטעינת ${id}`, 'error');
    } finally {
      setSectionLoading(p => ({ ...p, [id]: false }));
    }
  };

  const toggleSection = (id: SectionId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); return next; }
      next.add(id);
      if (!sectionData[id]) loadSection(id);
      return next;
    });
  };

  // Load default selected sections when month changes
  useEffect(() => {
    setSectionData({});
    selected.forEach(id => loadSection(id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  // Load PL on first mount
  useEffect(() => { loadSection('pl'); }, []); // eslint-disable-line

  const handleExportAll = async () => {
    setExporting(true);
    try {
      const res = await exportApi.all(year, month);
      downloadBlob(res.data, `דוח-מלא-לרוח-${HE_MONTHS[month - 1]}-${year}.xlsx`);
    } catch (err) { toast(getErrorMessage(err) || 'ייצוא נכשל', 'error'); }
    finally { setExporting(false); }
  };

  const handleSectionExcel = async (id: SectionId) => {
    try {
      let res;
      if (id === 'pl')        res = await exportApi.pl(year, month);
      else if (id === 'employees') res = await exportApi.shifts(ym);
      else if (id === 'invoices')  res = await exportApi.invoices();
      else if (id === 'inventory') res = await exportApi.inventory();
      else                         res = await exportApi.finance(String(year), String(month));
      const label = SECTIONS.find(s => s.id === id)?.label ?? id;
      downloadBlob(res.data, `${label}-${HE_MONTHS[month - 1]}-${year}.xlsx`);
    } catch (err) { toast(getErrorMessage(err) || 'ייצוא נכשל', 'error'); }
  };

  const handleSectionCsv = (id: SectionId) => {
    const data = sectionData[id];
    if (!data) return;
    const label = SECTIONS.find(s => s.id === id)?.label ?? id;
    const filename = `${label}-${HE_MONTHS[month - 1]}-${year}`;

    if (id === 'pl') {
      const d = data as PlData;
      exportToCsv(filename, [
        { 'סעיף': 'הכנסות',        'סכום': d.revenue },
        { 'סעיף': 'עלות סחורה',    'סכום': -d.cogs },
        { 'סעיף': 'רווח גולמי',     'סכום': d.grossProfit },
        { 'סעיף': 'הוצאות קבועות', 'סכום': -d.fixedExpenses },
        { 'סעיף': 'שכר עובדים',    'סכום': -d.salaryCost },
        { 'סעיף': 'רווח נקי',       'סכום': d.netProfit },
      ]);
    } else if (id === 'employees') {
      exportToCsv(filename, (data as EmpRow[]).map(e => ({
        'שם': e.full_name, 'תפקיד': e.role,
        'סוג שכר': e.salary_type, 'שעות': e.total_hours,
        'שכר גולמי': e.gross_pay, 'משמרות': e.shift_count,
      })));
    } else if (id === 'invoices') {
      exportToCsv(filename, (data as InvoiceRow[]).map(i => ({
        'ספק': i.supplier_name ?? '',
        'מספר חשבונית': i.invoice_number ?? '',
        'תאריך': i.invoice_date?.slice(0, 10) ?? '',
        'סכום': i.total_amount,
        'תשלום': i.is_paid ? 'שולם' : 'לא שולם',
      })));
    } else if (id === 'inventory') {
      exportToCsv(filename, (data as InvRow[]).map(i => ({
        'שם פריט': i.name, 'כמות': i.current_qty, 'יחידה': i.unit,
        'מינימום': i.min_qty, 'עלות ליחידה': i.cost_per_unit ?? 0,
      })));
    } else if (id === 'finance') {
      const d = data as { expenses: ExpRow[]; income: IncRow[] };
      exportToCsv(filename, [
        ...d.expenses.map(e => ({ 'סוג': 'הוצאה', 'תיאור': e.name, 'סכום': e.amount, 'תדירות': e.frequency })),
        ...d.income.map(i => ({ 'סוג': 'הכנסה', 'תיאור': i.description, 'סכום': i.amount, 'תאריך': i.income_date })),
      ]);
    }
  };

  const handleEmail = async () => {
    if (!emailTo.trim()) return;
    setSending(true);
    try {
      await financeApi.sendReport(emailTo, year, month);
      setSent(true); setTimeout(() => setSent(false), 3000);
    } catch (err) {
      const pl = sectionData.pl as PlData | undefined;
      const subject = encodeURIComponent(`דוח רווח והפסד – ${HE_MONTHS[month - 1]} ${year}`);
      const body = encodeURIComponent(
        `דוח רווח והפסד לחודש ${HE_MONTHS[month - 1]} ${year}:\n\n` +
        `הכנסות: ${formatCurrency(pl?.revenue || 0)}\n` +
        `עלות סחורה: (${formatCurrency(pl?.cogs || 0)})\n` +
        `רווח גולמי: ${formatCurrency(pl?.grossProfit || 0)}\n` +
        `הוצאות קבועות: (${formatCurrency(pl?.fixedExpenses || 0)})\n` +
        `עלויות שכר: (${formatCurrency(pl?.salaryCost || 0)})\n` +
        `רווח נקי: ${formatCurrency(pl?.netProfit || 0)}\n\nבברכה,\n${business?.name}`
      );
      window.open(`mailto:${emailTo}?subject=${subject}&body=${body}`);
      toast(getErrorMessage(err) || 'שליחה אוטומטית נכשלה — נפתח לקוח המייל', 'error');
    } finally { setSending(false); }
  };

  const profitColor = ((sectionData.pl as PlData | undefined)?.netProfit ?? 0) >= 0
    ? 'var(--color-primary,#1a5c2a)' : '#dc2626';

  return (
    <div className="space-y-6 max-w-5xl" dir="rtl">
      {/* Header + month picker */}
      <div className="flex items-center justify-between flex-wrap gap-3 no-print">
        <div>
          <h2 className="text-xl font-bold text-[#e8e8e4]">ייצוא לרואה חשבון</h2>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-0.5">בחר סעיפים, צפה בנתונים, ייצא</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-2 rounded-xl hover:bg-[rgba(201,162,39,0.06)] transition-colors">
            <ChevronRight className="w-4 h-4 text-[rgba(232,232,228,0.72)]" />
          </button>
          <span className="font-bold text-[rgba(232,232,228,0.72)] min-w-[140px] text-center">
            {HE_MONTHS[month - 1]} {year}
          </span>
          <button onClick={nextMonth} className="p-2 rounded-xl hover:bg-[rgba(201,162,39,0.06)] transition-colors">
            <ChevronLeft className="w-4 h-4 text-[rgba(232,232,228,0.72)]" />
          </button>
        </div>
      </div>

      {/* Section selector + preview button */}
      <div className="no-print rounded-2xl p-4 space-y-4"
        style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <p className="text-sm font-semibold text-[rgba(232,232,228,0.72)]">בחר סעיפים לדוח:</p>
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map(({ id, label, Icon, color }) => {
            const active = selected.has(id);
            return (
              <button
                key={id}
                onClick={() => toggleSection(id)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
                style={active
                  ? { background: color, color: '#fff', boxShadow: `0 2px 8px ${color}40` }
                  : { background: 'rgba(255,255,255,0.05)', color: 'rgba(232,232,228,0.55)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Preview + quick export row */}
        <div className="flex items-center gap-3 pt-1 flex-wrap" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button
            onClick={() => setShowPreview(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all"
            style={{ background: 'var(--color-primary,#1a5c2a)', color: '#fff', boxShadow: '0 2px 12px rgba(26,92,42,0.4)' }}
          >
            <FileText className="w-4 h-4" />
            צפה בדוח לפני הורדה
          </button>
          <button
            onClick={handleExportAll}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(232,232,228,0.75)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <Download className="w-4 h-4" />
            {exporting ? 'מוריד...' : 'הורד Excel מלא'}
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(232,232,228,0.75)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <Printer className="w-4 h-4" />
            הדפסה / PDF
          </button>
        </div>
      </div>

      {/* Section preview cards */}
      <div ref={printRef} id="report-print" className="space-y-5">
        {/* Print header */}
        <div className="hidden print-show mb-6 text-center">
          <h2 className="text-xl font-black">{business?.name}</h2>
          <p>דוח לרואה חשבון — {HE_MONTHS[month - 1]} {year}</p>
        </div>

        {SECTIONS.filter(s => selected.has(s.id)).map(({ id, label, Icon, color }) => {
          const loading = sectionLoading[id];
          const data = sectionData[id];

          return (
            <div key={id} className="rounded-2xl overflow-hidden"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
              {/* Section header */}
              <div className="px-6 py-4 flex items-center justify-between"
                style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--glass-border)' }}>
                <h3 className="font-bold text-[#e8e8e4] flex items-center gap-2">
                  <Icon className="w-4 h-4" style={{ color }} />
                  {label}
                </h3>
                {!loading && data && (
                  <div className="flex items-center gap-2 no-print">
                    <button
                      onClick={() => handleSectionCsv(id)}
                      className="px-3 py-1.5 text-xs rounded-lg font-medium transition-all"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(232,232,228,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
                    >CSV</button>
                    <button
                      onClick={() => handleSectionExcel(id)}
                      className="px-3 py-1.5 text-xs rounded-lg font-medium transition-all"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(232,232,228,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
                    >Excel</button>
                  </div>
                )}
              </div>

              {/* Section content */}
              {loading ? (
                <div className="p-6 space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-8 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
                  ))}
                </div>
              ) : !data ? (
                <div className="p-6 text-center text-[rgba(232,232,228,0.35)] text-sm">לא נטענו נתונים</div>
              ) : (
                <div className="overflow-x-auto">
                  {id === 'pl' && <PlSection data={data as PlData} />}
                  {id === 'employees' && <EmployeesSection data={data as EmpRow[]} />}
                  {id === 'invoices' && <InvoicesSection data={data as InvoiceRow[]} />}
                  {id === 'inventory' && <InventorySection data={data as InvRow[]} />}
                  {id === 'finance' && <FinanceSection data={data as { expenses: ExpRow[]; income: IncRow[] }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Master actions */}
      <div className="rounded-2xl p-5 no-print space-y-4"
        style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
        {/* Email */}
        <div>
          <h3 className="font-bold text-[#e8e8e4] mb-3 flex items-center gap-2">
            <Mail className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
            שלח לרואה חשבון
          </h3>
          <div className="flex gap-3 flex-wrap">
            <input
              type="email" placeholder="אימייל רואה החשבון..." value={emailTo}
              onChange={e => setEmailTo(e.target.value)}
              className="flex-1 min-w-[220px] text-sm px-4 py-2.5 rounded-xl outline-none"
              style={{ background: 'rgba(20,20,24,0.8)', border: '1px solid var(--glass-border)', color: '#e8e8e4' }}
            />
            <Button onClick={handleEmail} loading={sending} disabled={!emailTo.trim()}>
              <Mail className="w-4 h-4" />
              {sent ? '✓ נשלח!' : 'שלח דוח'}
            </Button>
          </div>
          <p className="text-xs text-[rgba(232,232,228,0.42)] mt-2">ישלח דוח רווח והפסד של {HE_MONTHS[month - 1]} {year}</p>
        </div>

        {/* Export buttons */}
        <div>
          <h3 className="font-bold text-[#e8e8e4] mb-3 flex items-center gap-2">
            <Download className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
            ייצוא מסמכים
          </h3>
          <div className="flex gap-3 flex-wrap">
            <Button onClick={() => setShowPreview(true)} style={{ background: 'var(--color-primary,#1a5c2a)', color: '#fff' }}>
              <FileText className="w-4 h-4" />
              צפה בדוח לפני הורדה
            </Button>
            <Button variant="outline" onClick={handleExportAll} loading={exporting}>
              <Download className="w-4 h-4" />
              Excel — דוח מלא
            </Button>
            <Button variant="outline" onClick={() => exportApi.pl(year, month).then(r => downloadBlob(r.data, `דוח-רווח-והפסד-${HE_MONTHS[month - 1]}-${year}.xlsx`)).catch(() => toast('ייצוא נכשל', 'error'))}>
              <FileText className="w-4 h-4" />
              Excel — רווח והפסד
            </Button>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="w-4 h-4" />
              הדפסה / PDF
            </Button>
          </div>
          <p className="text-xs text-[rgba(232,232,228,0.42)] mt-2">
            "דוח מלא" כולל: רווח והפסד, עובדים, משמרות, מלאי, חשבוניות, הוצאות והכנסות — כולם בגיליון Excel אחד
          </p>
        </div>
      </div>

      {/* ── Preview Modal ── */}
      {showPreview && (
        <div className="fixed inset-0 z-[200] overflow-auto" style={{ background: 'rgba(0,0,0,0.88)' }}>
          {/* Sticky action bar */}
          <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 gap-3 flex-wrap"
            style={{ background: '#111', borderBottom: '1px solid #333' }}>
            <div>
              <span className="text-white font-bold text-sm">{business?.name} — {HE_MONTHS[month - 1]} {year}</span>
              <p className="text-white/40 text-xs mt-0.5">תצוגה מקדימה — לחץ הורד לאחר אישור</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handleExportAll}
                disabled={exporting}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
                style={{ background: '#1a5c2a', color: '#fff' }}
              >
                <Download className="w-4 h-4" />
                {exporting ? 'מוריד...' : 'הורד Excel מלא'}
              </button>
              <button
                onClick={() => { setShowPreview(false); setTimeout(() => window.print(), 100); }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
                style={{ background: '#1e40af', color: '#fff' }}
              >
                <Printer className="w-4 h-4" />
                הדפס / PDF
              </button>
              <button
                onClick={() => setShowPreview(false)}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white/60 hover:text-white transition-colors"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                ✕ סגור
              </button>
            </div>
          </div>

          {/* White paper document */}
          <div className="mx-auto my-8 max-w-3xl px-4 pb-16">
            <div dir="rtl" style={{
              background: '#fff', color: '#111',
              borderRadius: 12, padding: '48px 56px',
              boxShadow: '0 8px 60px rgba(0,0,0,0.6)',
              fontFamily: 'Arial, Helvetica, sans-serif',
            }}>
              {/* Document header */}
              <div style={{ textAlign: 'center', marginBottom: 36, paddingBottom: 24, borderBottom: '2px solid #e5e7eb' }}>
                <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0, color: '#111' }}>{business?.name}</h1>
                <p style={{ color: '#6b7280', margin: '6px 0 0', fontSize: 14 }}>
                  דוח לרואה חשבון — {HE_MONTHS[month - 1]} {year}
                </p>
              </div>

              {/* Sections */}
              {SECTIONS.filter(s => selected.has(s.id)).map(({ id, label, color }) => {
                const data = sectionData[id];
                const loading = sectionLoading[id];
                return (
                  <div key={id} style={{ marginBottom: 36 }}>
                    <h2 style={{
                      fontSize: 15, fontWeight: 700, margin: '0 0 12px',
                      paddingBottom: 8, borderBottom: `2px solid ${color}30`,
                      color: id === 'pl' ? '#1a5c2a' : color,
                    }}>{label}</h2>
                    {loading ? (
                      <p style={{ color: '#9ca3af', fontSize: 13 }}>טוען...</p>
                    ) : !data ? (
                      <p style={{ color: '#9ca3af', fontSize: 13 }}>לא נטענו נתונים</p>
                    ) : (
                      <>
                        {id === 'pl'        && <PreviewPl data={data as PlData} />}
                        {id === 'employees' && <PreviewEmployees data={data as EmpRow[]} />}
                        {id === 'invoices'  && <PreviewInvoices data={data as InvoiceRow[]} />}
                        {id === 'inventory' && <PreviewInventory data={data as InvRow[]} />}
                        {id === 'finance'   && <PreviewFinance data={data as { expenses: ExpRow[]; income: IncRow[] }} />}
                      </>
                    )}
                  </div>
                );
              })}

              {/* Footer */}
              <div style={{ marginTop: 40, paddingTop: 16, borderTop: '1px solid #e5e7eb', textAlign: 'center', color: '#9ca3af', fontSize: 11 }}>
                הופק ב-{new Date().toLocaleDateString('he-IL')} | {business?.name}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-show { display: block !important; }
          body { background: white !important; color: #111 !important; }
          #report-print { padding: 20px; }
          * { color: #111 !important; border-color: #ccc !important; }
        }
        .print-show { display: none; }
      `}</style>
    </div>
  );
}

/* ── Section renderers ─────────────────────────────────────────── */

function TblRow({ cells }: { cells: React.ReactNode[] }) {
  return (
    <tr className="border-b" style={{ borderColor: 'var(--glass-border)' }}>
      {cells.map((c, i) => (
        <td key={i} className="px-5 py-2.5 text-sm text-[rgba(232,232,228,0.72)]">{c}</td>
      ))}
    </tr>
  );
}

function TblHead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
        {cols.map(c => (
          <th key={c} className="px-5 py-2.5 text-xs font-semibold text-[rgba(232,232,228,0.45)] text-right">{c}</th>
        ))}
      </tr>
    </thead>
  );
}

function PlSection({ data }: { data: PlData }) {
  const rows = [
    { label: 'הכנסות',        value: data.revenue,       color: 'var(--color-primary,#1a5c2a)', prefix: '' },
    { label: 'עלות סחורה',    value: data.cogs,          color: '#f97316',                       prefix: '(' },
    { label: 'רווח גולמי',     value: data.grossProfit,   color: data.grossProfit >= 0 ? 'var(--color-primary)' : '#dc2626', prefix: '' },
    { label: 'הוצאות קבועות', value: data.fixedExpenses, color: '#dc2626',                       prefix: '(' },
    { label: 'עלויות שכר',    value: data.salaryCost,    color: '#7c3aed',                       prefix: '(' },
    { label: 'רווח נקי',       value: data.netProfit,     color: data.netProfit >= 0 ? 'var(--color-primary)' : '#dc2626', prefix: '' },
  ];
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(({ label, value, color, prefix }) => (
          <tr key={label} className="border-b" style={{ borderColor: 'var(--glass-border)' }}>
            <td className="px-5 py-2.5 text-[rgba(232,232,228,0.72)]">{label}</td>
            <td className="px-5 py-2.5 font-semibold text-left" style={{ color }}>
              {prefix}{formatCurrency(value)}{prefix ? ')' : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmployeesSection({ data }: { data: EmpRow[] }) {
  if (!data.length) return <div className="p-6 text-center text-[rgba(232,232,228,0.35)] text-sm">אין עובדים</div>;
  return (
    <table className="w-full">
      <TblHead cols={['שם', 'תפקיד', 'סוג שכר', 'משמרות', 'שעות', 'שכר גולמי']} />
      <tbody>
        {data.map((e, i) => (
          <TblRow key={i} cells={[
            e.full_name,
            e.role === 'manager' ? 'מנהל' : 'עובד',
            e.salary_type === 'hourly' ? 'שעתי' : e.salary_type === 'global' ? 'גלובלי' : e.salary_type,
            e.shift_count,
            e.total_hours.toFixed(1),
            <span key="pay" className="font-semibold text-purple-400">{formatCurrency(e.gross_pay)}</span>,
          ]} />
        ))}
        <tr style={{ background: 'rgba(124,58,237,0.06)' }}>
          <td className="px-5 py-2.5 font-bold text-[#e8e8e4]" colSpan={5}>סה"כ</td>
          <td className="px-5 py-2.5 font-bold text-purple-400">
            {formatCurrency(data.reduce((s, e) => s + e.gross_pay, 0))}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function InvoicesSection({ data }: { data: InvoiceRow[] }) {
  if (!data.length) return <div className="p-6 text-center text-[rgba(232,232,228,0.35)] text-sm">אין חשבוניות לחודש זה</div>;
  const total = data.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
  return (
    <table className="w-full">
      <TblHead cols={['ספק', 'מספר חשבונית', 'תאריך', 'סכום', 'תשלום']} />
      <tbody>
        {data.slice(0, 50).map((inv, i) => (
          <TblRow key={i} cells={[
            inv.supplier_name ?? '—',
            inv.invoice_number ?? '—',
            inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—',
            <span key="amt" className="font-semibold text-orange-400">{formatCurrency(inv.total_amount)}</span>,
            <span key="paid" className={inv.is_paid ? 'text-green-400' : 'text-red-400'}>{inv.is_paid ? 'שולם' : 'לא שולם'}</span>,
          ]} />
        ))}
        {data.length > 50 && (
          <tr><td className="px-5 py-2 text-xs text-[rgba(232,232,228,0.35)]" colSpan={5}>מוצגות 50 מתוך {data.length} חשבוניות</td></tr>
        )}
        <tr style={{ background: 'rgba(249,115,22,0.06)' }}>
          <td className="px-5 py-2.5 font-bold text-[#e8e8e4]" colSpan={3}>סה"כ</td>
          <td className="px-5 py-2.5 font-bold text-orange-400">{formatCurrency(total)}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

function InventorySection({ data }: { data: InvRow[] }) {
  if (!data.length) return <div className="p-6 text-center text-[rgba(232,232,228,0.35)] text-sm">אין פריטי מלאי</div>;
  const totalValue = data.reduce((s, i) => s + i.current_qty * (i.cost_per_unit ?? 0), 0);
  return (
    <table className="w-full">
      <TblHead cols={['שם פריט', 'כמות', 'יחידה', 'מינימום', 'עלות ליחידה', 'שווי']} />
      <tbody>
        {data.slice(0, 50).map((item, i) => {
          const val = item.current_qty * (item.cost_per_unit ?? 0);
          const low = item.current_qty <= item.min_qty;
          return (
            <TblRow key={i} cells={[
              <span key="n" className={low ? 'text-red-400' : undefined}>{item.name}</span>,
              item.current_qty,
              item.unit,
              item.min_qty,
              formatCurrency(item.cost_per_unit ?? 0),
              formatCurrency(val),
            ]} />
          );
        })}
        {data.length > 50 && (
          <tr><td className="px-5 py-2 text-xs text-[rgba(232,232,228,0.35)]" colSpan={6}>מוצגים 50 מתוך {data.length} פריטים</td></tr>
        )}
        <tr style={{ background: 'rgba(14,165,233,0.06)' }}>
          <td className="px-5 py-2.5 font-bold text-[#e8e8e4]" colSpan={5}>שווי מלאי כולל</td>
          <td className="px-5 py-2.5 font-bold text-sky-400">{formatCurrency(totalValue)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function FinanceSection({ data }: { data: { expenses: ExpRow[]; income: IncRow[] } }) {
  const FREQ: Record<string, string> = { monthly: 'חודשי', weekly: 'שבועי', yearly: 'שנתי', one_time: 'חד פעמי' };
  const totalExp = data.expenses.filter(e => e.is_active).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalInc = data.income.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  return (
    <div>
      {/* Fixed expenses */}
      {data.expenses.length > 0 && (
        <>
          <div className="px-5 py-2.5 text-xs font-semibold text-[rgba(232,232,228,0.45)]" style={{ background: 'rgba(220,38,38,0.06)' }}>הוצאות קבועות</div>
          <table className="w-full">
            <TblHead cols={['תיאור', 'קטגוריה', 'תדירות', 'סכום']} />
            <tbody>
              {data.expenses.map((e, i) => (
                <TblRow key={i} cells={[e.name, e.category ?? '—', FREQ[e.frequency] ?? e.frequency, <span key="a" className="font-semibold text-red-400">{formatCurrency(e.amount)}</span>]} />
              ))}
              <tr style={{ background: 'rgba(220,38,38,0.06)' }}>
                <td className="px-5 py-2.5 font-bold text-[#e8e8e4]" colSpan={3}>סה"כ הוצאות</td>
                <td className="px-5 py-2.5 font-bold text-red-400">{formatCurrency(totalExp)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
      {/* Income */}
      {data.income.length > 0 && (
        <>
          <div className="px-5 py-2.5 text-xs font-semibold text-[rgba(232,232,228,0.45)]" style={{ background: 'rgba(34,197,94,0.06)' }}>הכנסות נוספות</div>
          <table className="w-full">
            <TblHead cols={['תיאור', 'תאריך', 'סכום']} />
            <tbody>
              {data.income.map((inc, i) => (
                <TblRow key={i} cells={[inc.description, inc.income_date?.slice(0, 10) ?? '—', <span key="a" className="font-semibold text-green-400">{formatCurrency(inc.amount)}</span>]} />
              ))}
              <tr style={{ background: 'rgba(34,197,94,0.06)' }}>
                <td className="px-5 py-2.5 font-bold text-[#e8e8e4]" colSpan={2}>סה"כ הכנסות נוספות</td>
                <td className="px-5 py-2.5 font-bold text-green-400">{formatCurrency(totalInc)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ── Preview renderers (white paper, print-friendly) ───────────── */

const pvTh: React.CSSProperties = { padding: '8px 14px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: '#374151', background: '#f3f4f6', borderBottom: '1px solid #e5e7eb' };
const pvTd: React.CSSProperties = { padding: '7px 14px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6' };

function PvTable({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{cols.map(c => <th key={c} style={pvTh}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={pvTd}>{cell}</td>)}</tr>)}</tbody>
    </table>
  );
}

function PreviewPl({ data }: { data: PlData }) {
  const rows = [
    ['הכנסות',        formatCurrency(data.revenue),      '#15803d'],
    ['עלות סחורה',    `(${formatCurrency(data.cogs)})`,  '#ea580c'],
    ['רווח גולמי',    formatCurrency(data.grossProfit),  data.grossProfit >= 0 ? '#15803d' : '#dc2626'],
    ['הוצאות קבועות', `(${formatCurrency(data.fixedExpenses)})`, '#dc2626'],
    ['עלויות שכר',    `(${formatCurrency(data.salaryCost)})`,    '#7c3aed'],
  ];
  const npColor = data.netProfit >= 0 ? '#15803d' : '#dc2626';
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>
        {rows.map(([label, value, color]) => (
          <tr key={label} style={{ borderBottom: '1px solid #f3f4f6' }}>
            <td style={{ ...pvTd, color: '#374151' }}>{label}</td>
            <td style={{ ...pvTd, color: color as string, fontWeight: 600, textAlign: 'left' }}>{value}</td>
          </tr>
        ))}
        <tr style={{ background: data.netProfit >= 0 ? '#f0fdf4' : '#fef2f2' }}>
          <td style={{ ...pvTd, fontWeight: 700, fontSize: 14, color: npColor, borderBottom: 'none' }}>רווח נקי</td>
          <td style={{ ...pvTd, fontWeight: 700, fontSize: 14, color: npColor, textAlign: 'left', borderBottom: 'none' }}>{formatCurrency(data.netProfit)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function PreviewEmployees({ data }: { data: EmpRow[] }) {
  if (!data.length) return <p style={{ color: '#9ca3af', fontSize: 13 }}>אין עובדים</p>;
  const total = data.reduce((s, e) => s + e.gross_pay, 0);
  return (
    <>
      <PvTable
        cols={['שם עובד', 'תפקיד', 'סוג שכר', 'משמרות', 'שעות', 'שכר גולמי']}
        rows={data.map(e => [
          e.full_name,
          e.role === 'manager' ? 'מנהל' : 'עובד',
          e.salary_type === 'hourly' ? 'שעתי' : 'גלובלי',
          e.shift_count,
          e.total_hours.toFixed(1),
          <span key="g" style={{ color: '#7c3aed', fontWeight: 600 }}>{formatCurrency(e.gross_pay)}</span>,
        ])}
      />
      <div style={{ marginTop: 8, textAlign: 'left', fontWeight: 700, color: '#7c3aed', fontSize: 13 }}>
        סה"כ שכר: {formatCurrency(total)}
      </div>
    </>
  );
}

function PreviewInvoices({ data }: { data: InvoiceRow[] }) {
  if (!data.length) return <p style={{ color: '#9ca3af', fontSize: 13 }}>אין חשבוניות לחודש זה</p>;
  const total = data.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
  return (
    <>
      <PvTable
        cols={['ספק', 'מספר חשבונית', 'תאריך', 'סכום', 'תשלום']}
        rows={data.slice(0, 50).map(inv => [
          inv.supplier_name ?? '—',
          inv.invoice_number ?? '—',
          inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—',
          <span key="a" style={{ color: '#ea580c', fontWeight: 600 }}>{formatCurrency(inv.total_amount)}</span>,
          <span key="p" style={{ color: inv.is_paid ? '#15803d' : '#dc2626' }}>{inv.is_paid ? 'שולם' : 'לא שולם'}</span>,
        ])}
      />
      {data.length > 50 && <p style={{ color: '#9ca3af', fontSize: 11, marginTop: 4 }}>מוצגות 50 מתוך {data.length} חשבוניות</p>}
      <div style={{ marginTop: 8, textAlign: 'left', fontWeight: 700, color: '#ea580c', fontSize: 13 }}>
        סה"כ חשבוניות: {formatCurrency(total)}
      </div>
    </>
  );
}

function PreviewInventory({ data }: { data: InvRow[] }) {
  if (!data.length) return <p style={{ color: '#9ca3af', fontSize: 13 }}>אין פריטי מלאי</p>;
  const totalVal = data.reduce((s, i) => s + i.current_qty * (i.cost_per_unit ?? 0), 0);
  return (
    <>
      <PvTable
        cols={['שם פריט', 'כמות', 'יחידה', 'מינימום', 'עלות ליחידה', 'שווי']}
        rows={data.slice(0, 50).map(item => {
          const low = item.current_qty <= item.min_qty;
          return [
            <span key="n" style={{ color: low ? '#dc2626' : '#374151' }}>{item.name}{low ? ' ⚠' : ''}</span>,
            item.current_qty, item.unit, item.min_qty,
            formatCurrency(item.cost_per_unit ?? 0),
            formatCurrency(item.current_qty * (item.cost_per_unit ?? 0)),
          ];
        })}
      />
      {data.length > 50 && <p style={{ color: '#9ca3af', fontSize: 11, marginTop: 4 }}>מוצגים 50 מתוך {data.length} פריטים</p>}
      <div style={{ marginTop: 8, textAlign: 'left', fontWeight: 700, color: '#0ea5e9', fontSize: 13 }}>
        שווי מלאי כולל: {formatCurrency(totalVal)}
      </div>
    </>
  );
}

function PreviewFinance({ data }: { data: { expenses: ExpRow[]; income: IncRow[] } }) {
  const FREQ: Record<string, string> = { monthly: 'חודשי', weekly: 'שבועי', yearly: 'שנתי', one_time: 'חד פעמי' };
  const totalExp = data.expenses.filter(e => e.is_active).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalInc = data.income.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.expenses.length > 0 && (
        <div>
          <p style={{ fontWeight: 600, fontSize: 13, color: '#dc2626', marginBottom: 6 }}>הוצאות קבועות</p>
          <PvTable
            cols={['תיאור', 'קטגוריה', 'תדירות', 'סכום']}
            rows={data.expenses.map(e => [e.name, e.category ?? '—', FREQ[e.frequency] ?? e.frequency,
              <span key="a" style={{ color: '#dc2626', fontWeight: 600 }}>{formatCurrency(e.amount)}</span>])}
          />
          <div style={{ marginTop: 6, textAlign: 'left', fontWeight: 700, color: '#dc2626', fontSize: 13 }}>
            סה"כ: {formatCurrency(totalExp)}
          </div>
        </div>
      )}
      {data.income.length > 0 && (
        <div>
          <p style={{ fontWeight: 600, fontSize: 13, color: '#15803d', marginBottom: 6 }}>הכנסות נוספות</p>
          <PvTable
            cols={['תיאור', 'תאריך', 'סכום']}
            rows={data.income.map(inc => [inc.description, inc.income_date?.slice(0, 10) ?? '—',
              <span key="a" style={{ color: '#15803d', fontWeight: 600 }}>{formatCurrency(inc.amount)}</span>])}
          />
          <div style={{ marginTop: 6, textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 13 }}>
            סה"כ: {formatCurrency(totalInc)}
          </div>
        </div>
      )}
    </div>
  );
}
