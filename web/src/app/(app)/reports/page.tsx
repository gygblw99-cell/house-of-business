'use client';

import { useState } from 'react';
import {
  Download, FileSpreadsheet, Users, Package, FileText,
  TrendingUp, BarChart2, Loader2, Search, Eye, X, Printer,
  LayoutGrid,
} from 'lucide-react';
import api from '@/lib/api/client';
import { financeApi, employeesApi, inventoryApi, invoicesApi } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useAppDialog } from '@/context/AppDialogContext';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

const EXPORTS = [
  { key: 'employees', label: 'עובדים',        desc: 'רשימת עובדים + שכר',      icon: Users,          needsDate: false },
  { key: 'shifts',    label: 'משמרות',        desc: 'דוח משמרות ושעות',         icon: BarChart2,      needsDate: true  },
  { key: 'invoices',  label: 'חשבוניות',      desc: 'כל החשבוניות לתקופה',      icon: FileText,       needsDate: false },
  { key: 'inventory', label: 'מלאי',          desc: 'מצב המלאי הנוכחי',         icon: Package,        needsDate: false },
  { key: 'finance',   label: 'פיננסים',       desc: 'הכנסות והוצאות',           icon: TrendingUp,     needsDate: true  },
  { key: 'pl',        label: 'דוח רווח/הפסד', desc: 'P&L מלא לייצוא',           icon: BarChart2,      needsDate: true  },
  { key: 'all',       label: 'דוח מלא',       desc: 'כל הגיליונות בקובץ אחד',   icon: FileSpreadsheet, needsDate: true },
];

type PreviewTab = 'all' | 'pl' | 'employees' | 'invoices' | 'inventory';

const PREVIEW_TABS: { id: PreviewTab; label: string; color: string }[] = [
  { id: 'all',       label: 'כל הדוחות',    color: '#374151' },
  { id: 'pl',        label: 'רווח והפסד',   color: '#15803d' },
  { id: 'employees', label: 'עובדים',        color: '#7c3aed' },
  { id: 'invoices',  label: 'חשבוניות',      color: '#ea580c' },
  { id: 'inventory', label: 'מלאי',          color: '#0ea5e9' },
];

interface PlData { revenue: number; cogs: number; grossProfit: number; fixedExpenses: number; salaryCost: number; netProfit: number; }
interface EmpRow { full_name: string; role: string; salary_type: string; total_hours: number; gross_pay: number; shift_count: number; }
interface InvRow { name: string; current_qty: number; unit: string; cost_per_unit?: number; min_qty: number; }
interface InvoiceRow { invoice_number?: string; total_amount: number; invoice_date: string; is_paid: boolean; supplier_name?: string; }
interface PreviewData { pl: PlData | null; employees: EmpRow[]; inventory: InvRow[]; invoices: InvoiceRow[]; }

/* ── dark-theme style helpers ── */
const pvTh: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 12,
  color: 'rgba(232,232,228,0.9)', background: 'rgba(255,255,255,0.06)',
  borderBottom: '1px solid rgba(255,255,255,0.1)',
};
const pvTd: React.CSSProperties = {
  padding: '9px 14px', fontSize: 13, color: 'rgba(232,232,228,0.85)',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
};

function PvTable({ cols, rows }: { cols: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{cols.map(c => <th key={c} style={pvTh}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => (
          <tr key={i} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.045)' }}>
            {row.map((cell, j) => <td key={j} style={pvTd}>{cell}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/* ── Section title helper ── */
function SectionTitle({ children, color, border }: { children: React.ReactNode; color: string; border: string }) {
  return (
    <h2 style={{ fontSize: 16, fontWeight: 800, color, borderBottom: `2px solid ${border}`, paddingBottom: 10, marginBottom: 16, lineHeight: 1.4 }}>
      {children}
    </h2>
  );
}

function SummaryBar({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ marginTop: 12, padding: '11px 16px', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: `${color}22`, border: `1px solid ${color}44` }}>
      <span style={{ fontWeight: 700, color, fontSize: 14 }}>{label}</span>
      <span style={{ fontWeight: 800, color, fontSize: 15 }}>{value}</span>
    </div>
  );
}

/* ── Section renderers (dark theme) ── */
function PlSection({ pl, month, year }: { pl: PlData; month: number; year: number }) {
  const isProfit = pl.netProfit >= 0;
  const rows: [string, string, string][] = [
    ['הכנסות',        formatCurrency(pl.revenue),                                '#4ade80'],
    ['עלות סחורה',    `(${formatCurrency(pl.cogs)})`,                            '#fb923c'],
    ['רווח גולמי',    formatCurrency(pl.grossProfit),                             pl.grossProfit >= 0 ? '#34d399' : '#f87171'],
    ['הוצאות קבועות', `(${formatCurrency(pl.fixedExpenses)})`,                   '#f87171'],
    ['עלויות שכר',    `(${formatCurrency(pl.salaryCost)})`,                      '#c084fc'],
  ];
  return (
    <section>
      <SectionTitle color="#4ade80" border="rgba(74,222,128,0.3)">
        דוח רווח והפסד — {MONTHS[month - 1]} {year}
      </SectionTitle>
      <div style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        {rows.map(([label, value, color], i) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 16px', background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.045)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <span style={{ color: 'rgba(232,232,228,0.75)', fontSize: 14 }}>{label}</span>
            <span style={{ color, fontWeight: 700, fontSize: 14, direction: 'ltr' }}>{value}</span>
          </div>
        ))}
        {/* Net profit — high contrast */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: isProfit ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)', borderTop: `2px solid ${isProfit ? '#22c55e' : '#ef4444'}` }}>
          <span style={{ color: isProfit ? '#86efac' : '#fca5a5', fontWeight: 800, fontSize: 16 }}>רווח נקי</span>
          <span style={{ color: isProfit ? '#86efac' : '#fca5a5', fontWeight: 800, fontSize: 17, direction: 'ltr' }}>{formatCurrency(pl.netProfit)}</span>
        </div>
      </div>
      <p style={{ marginTop: 8, fontSize: 12, color: 'rgba(232,232,228,0.4)', textAlign: 'right' }}>
        מרווח: {pl.revenue > 0 ? ((pl.netProfit / pl.revenue) * 100).toFixed(1) : '0'}%
      </p>
    </section>
  );
}

function EmployeesSection({ employees, month, year }: { employees: EmpRow[]; month: number; year: number }) {
  const total = employees.reduce((s, e) => s + e.gross_pay, 0);
  return (
    <section>
      <SectionTitle color="#c084fc" border="rgba(192,132,252,0.3)">
        עובדים ומשמרות — {MONTHS[month - 1]} {year}
      </SectionTitle>
      <PvTable
        cols={['שם עובד', 'תפקיד', 'סוג שכר', 'משמרות', 'שעות', 'שכר גולמי']}
        rows={employees.map(e => [
          <strong key="n" style={{ color: '#e8e8e4' }}>{e.full_name}</strong>,
          e.role === 'manager' ? 'מנהל' : 'עובד',
          e.salary_type === 'hourly' ? 'שעתי' : 'גלובלי',
          e.shift_count,
          <span key="h">{e.total_hours.toFixed(1)}</span>,
          <strong key="g" style={{ color: '#c084fc' }}>{formatCurrency(e.gross_pay)}</strong>,
        ])}
      />
      <SummaryBar label="סה&quot;כ שכר לחודש" value={formatCurrency(total)} color="#c084fc" />
    </section>
  );
}

function InvoicesSection({ invoices, month, year }: { invoices: InvoiceRow[]; month: number; year: number }) {
  const total = invoices.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
  return (
    <section>
      <SectionTitle color="#fb923c" border="rgba(251,146,60,0.3)">
        חשבוניות ספקים — {MONTHS[month - 1]} {year}
      </SectionTitle>
      <PvTable
        cols={['ספק', 'מספר חשבונית', 'תאריך', 'סכום', 'תשלום']}
        rows={invoices.slice(0, 50).map(inv => [
          inv.supplier_name ?? '—',
          inv.invoice_number ?? '—',
          inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—',
          <strong key="a" style={{ color: '#fb923c' }}>{formatCurrency(inv.total_amount)}</strong>,
          <span key="p" style={{ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: inv.is_paid ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)', color: inv.is_paid ? '#86efac' : '#fca5a5' }}>
            {inv.is_paid ? 'שולם' : 'לא שולם'}
          </span>,
        ])}
      />
      {invoices.length > 50 && <p style={{ color: 'rgba(232,232,228,0.35)', fontSize: 11, marginTop: 4 }}>מוצגות 50 מתוך {invoices.length}</p>}
      <SummaryBar label="סה&quot;כ חשבוניות" value={formatCurrency(total)} color="#fb923c" />
    </section>
  );
}

function InventorySection({ inventory }: { inventory: InvRow[] }) {
  const totalValue = inventory.reduce((s, i) => s + i.current_qty * (i.cost_per_unit ?? 0), 0);
  const lowItems   = inventory.filter(i => i.current_qty <= i.min_qty);
  return (
    <section>
      <SectionTitle color="#38bdf8" border="rgba(56,189,248,0.3)">
        מצב מלאי נוכחי
      </SectionTitle>
      {lowItems.length > 0 && (
        <div style={{ padding: '9px 14px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, marginBottom: 14, fontSize: 12, color: '#fca5a5', fontWeight: 600 }}>
          ⚠ {lowItems.length} פריטים מתחת למינימום: {lowItems.map(i => i.name).join(', ')}
        </div>
      )}
      <PvTable
        cols={['שם פריט', 'כמות', 'יחידה', 'מינימום', 'עלות ליחידה', 'שווי']}
        rows={inventory.slice(0, 50).map(item => {
          const low = item.current_qty <= item.min_qty;
          const val = item.current_qty * (item.cost_per_unit ?? 0);
          return [
            <span key="n" style={{ color: low ? '#fca5a5' : '#e8e8e4', fontWeight: low ? 700 : 400 }}>{item.name}{low ? ' ⚠' : ''}</span>,
            <span key="q" style={{ color: low ? '#fca5a5' : 'inherit' }}>{item.current_qty}</span>,
            item.unit, item.min_qty,
            formatCurrency(item.cost_per_unit ?? 0),
            <strong key="v" style={{ color: '#38bdf8' }}>{formatCurrency(val)}</strong>,
          ];
        })}
      />
      {inventory.length > 50 && <p style={{ color: 'rgba(232,232,228,0.35)', fontSize: 11, marginTop: 4 }}>מוצגים 50 מתוך {inventory.length}</p>}
      <SummaryBar label="שווי מלאי כולל" value={formatCurrency(totalValue)} color="#38bdf8" />
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════ */

export default function ReportsPage() {
  const { toast }    = useAppDialog();
  const { business } = useAppSelector(s => s.auth);
  const [loading, setLoading]         = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());

  const [showPreview, setShowPreview]         = useState(false);
  const [activeTab,   setActiveTab]           = useState<PreviewTab>('all');
  const [previewData, setPreviewData]         = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading]   = useState(false);

  const search = () => setHasSearched(true);

  const download = async (key: string, label: string, needsDate: boolean) => {
    setLoading(key);
    try {
      const monthStr = String(month).padStart(2, '0');
      const params: Record<string, string | number> = {};
      if (needsDate) { params.year = year; params.month = month; }
      if (key === 'shifts') { params.month = `${year}-${monthStr}`; }
      const res = await api.get(`/export/${key}`, { params, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${label}-${year}-${monthStr}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`${label} יוצא בהצלחה`, 'success');
    } catch { toast(`שגיאה בייצוא ${label}`, 'error'); }
    setLoading(null);
  };

  const openPreview = async () => {
    setShowPreview(true);
    setActiveTab('all');
    if (previewData) return;
    setPreviewLoading(true);
    try {
      const [plRes, empRes, invRes, invocRes] = await Promise.allSettled([
        financeApi.monthly({ year, month }),
        employeesApi.performance(year, month),
        inventoryApi.list(),
        invoicesApi.list({ year, month, limit: 200 }),
      ]);
      setPreviewData({
        pl:        plRes.status    === 'fulfilled' ? (plRes.value.data as PlData) : null,
        employees: empRes.status   === 'fulfilled' ? ((empRes.value.data as { employees: EmpRow[] }).employees ?? []) : [],
        inventory: invRes.status   === 'fulfilled' ? (((invRes.value.data as { items: InvRow[] }).items) ?? (Array.isArray(invRes.value.data) ? invRes.value.data as InvRow[] : [])) : [],
        invoices:  invocRes.status === 'fulfilled' ? ((invocRes.value.data as { invoices: InvoiceRow[] }).invoices ?? []) : [],
      });
    } catch {
      toast('שגיאה בטעינת נתוני תצוגה מקדימה', 'error');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleMonthChange = (v: number) => { setMonth(v); setHasSearched(false); setPreviewData(null); };
  const handleYearChange  = (v: number) => { setYear(v);  setHasSearched(false); setPreviewData(null); };

  const activeTabMeta = PREVIEW_TABS.find(t => t.id === activeTab)!;

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">
      <div className="rounded-2xl p-6 text-white" style={{ background: 'var(--hero-gradient)' }}>
        <h1 className="text-2xl font-black">ייצוא לרו&quot;ח</h1>
        <p className="text-sm mt-1 opacity-60">הורדת קבצי Excel — תצוגה מקדימה לפני הורדה</p>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-3 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-4 flex-wrap">
        <span className="text-sm font-medium text-[rgba(232,232,228,0.6)]">תקופה:</span>
        <select value={month} onChange={e => handleMonthChange(+e.target.value)}
          className="border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-3 py-2 text-sm focus:outline-none">
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={year} onChange={e => handleYearChange(+e.target.value)}
          className="border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-3 py-2 text-sm focus:outline-none">
          {[2023, 2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={search}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
          style={{ background: 'var(--color-primary,#1a5c2a)' }}>
          <Search className="w-4 h-4" /> חפש
        </button>
      </div>

      {!hasSearched ? (
        <div className="flex flex-col items-center justify-center py-20 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)]">
          <Search className="w-12 h-12 text-[rgba(232,232,228,0.2)] mb-3" />
          <p className="text-[rgba(232,232,228,0.45)] font-semibold">בחר תקופה ולחץ &quot;חפש&quot;</p>
          <p className="text-[rgba(232,232,228,0.4)] text-sm mt-1">יוצגו אפשרויות הייצוא לתקופה שנבחרה</p>
        </div>
      ) : (
        <>
          {/* Preview CTA */}
          <button onClick={openPreview}
            className="w-full flex items-center justify-between gap-4 rounded-2xl p-5 transition-all"
            style={{
              background: 'linear-gradient(135deg, #1a5c2a 0%, #2d7a42 100%)',
              border: '1px solid rgba(255,255,255,0.15)',
              boxShadow: '0 4px 24px rgba(26,92,42,0.5)',
            }}>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.15)' }}>
                <Eye className="w-6 h-6 text-white" />
              </div>
              <div className="text-right">
                <p className="font-black text-white text-base">צפה בדוח לפני הורדה</p>
                <p className="text-white/60 text-sm mt-0.5">
                  תצוגה מקדימה מפורטת — {MONTHS[month - 1]} {year}
                </p>
              </div>
            </div>
            <Eye className="w-6 h-6 text-white/40 flex-shrink-0" />
          </button>

          {/* Download cards */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {EXPORTS.map(ex => {
              const Icon = ex.icon;
              const isLoading = loading === ex.key;
              return (
                <button key={ex.key} onClick={() => download(ex.key, ex.label, ex.needsDate)}
                  disabled={!!loading}
                  className="flex items-center gap-4 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-5 text-right hover:bg-[rgba(201,162,39,0.06)] transition-all disabled:opacity-60">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(26,92,42,0.1)' }}>
                    {isLoading
                      ? <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
                      : <Icon className="w-6 h-6" style={{ color: 'var(--color-primary)' }} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-[#e8e8e4]">{ex.label}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.4)] mt-0.5">{ex.desc}</p>
                    <p className="text-xs mt-1 font-semibold" style={{ color: '#c9a227' }}>
                      {MONTHS[month - 1]} {year}
                    </p>
                  </div>
                  <FileSpreadsheet className="w-5 h-5 text-[rgba(232,232,228,0.2)] flex-shrink-0" />
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* ══ Preview Modal ══ */}
      {showPreview && (
        <div className="fixed inset-0 z-[200] flex flex-col" style={{ background: 'rgba(0,0,0,0.94)' }} dir="rtl">

          {/* ── Top bar ── */}
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5"
            style={{ background: '#111', borderBottom: '1px solid #1e1e1e', minHeight: 52 }}>

            {/* Title — right side in RTL (first in DOM) */}
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm leading-tight truncate">{business?.name}</p>
              <p className="text-white/35 text-xs leading-tight">{MONTHS[month - 1]} {year}</p>
            </div>

            {/* Actions */}
            <button onClick={() => download('all', 'דוח-מלא', true)} disabled={!!loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold flex-shrink-0"
              style={{ background: '#1a5c2a', color: '#fff' }}
              title="הורד Excel מלא">
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{loading === 'all' ? 'מוריד...' : 'Excel'}</span>
            </button>

            <button onClick={() => { setShowPreview(false); setTimeout(() => window.print(), 100); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold flex-shrink-0"
              style={{ background: '#1e40af', color: '#fff' }}
              title="הדפס / PDF">
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">PDF</span>
            </button>

            {/* X — last in DOM = visual LEFT in RTL */}
            <button onClick={() => setShowPreview(false)}
              className="flex items-center justify-center w-8 h-8 rounded-xl flex-shrink-0 transition-colors hover:bg-white/10"
              style={{ color: 'rgba(255,255,255,0.6)' }}
              title="סגור">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Tab navigation bar — wraps to 2 rows on small screens ── */}
          <div className="flex-shrink-0 px-4 pt-3 pb-2"
            style={{ background: '#0d0d10', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>

            {/* Back to "all" breadcrumb — shown when inside a specific section */}
            {activeTab !== 'all' && (
              <button
                onClick={() => setActiveTab('all')}
                className="flex items-center gap-1.5 mb-2 text-xs font-semibold transition-colors hover:opacity-80"
                style={{ color: 'rgba(232,232,228,0.45)' }}
              >
                <LayoutGrid className="w-3 h-3" />
                ← חזרה לכל הדוחות
              </button>
            )}

            {/* Tab chips — scrollable row so they never wrap/clip */}
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ flexWrap: 'nowrap', scrollbarWidth: 'none' }}>
              {PREVIEW_TABS.map(tab => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all"
                    style={{
                      background:  isActive ? tab.color          : 'rgba(255,255,255,0.06)',
                      color:       isActive ? '#fff'             : 'rgba(232,232,228,0.55)',
                      border:      isActive ? `1px solid ${tab.color}` : '1px solid rgba(255,255,255,0.09)',
                      boxShadow:   isActive ? `0 2px 10px ${tab.color}44` : 'none',
                    }}
                  >
                    {tab.id === 'all' && <LayoutGrid className="w-3 h-3" />}
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Scrollable content ── */}
          <div className="flex-1 overflow-y-auto py-6 px-4" style={{ background: 'var(--app-bg, #0f0f12)' }}>
            <div className="mx-auto max-w-3xl" dir="rtl">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center py-28">
                  <Loader2 className="w-10 h-10 animate-spin mb-4" style={{ color: 'var(--color-primary,#1a5c2a)' }} />
                  <p style={{ color: 'rgba(232,232,228,0.4)', fontSize: 14 }}>טוען נתונים...</p>
                </div>
              ) : previewData ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 28, fontFamily: 'var(--font-sans, Arial, Helvetica, sans-serif)' }}>

                  {/* ── Document header card ── */}
                  <div style={{ padding: '24px 28px', borderRadius: 16, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', textAlign: 'center' }}>
                    <h1 style={{ fontSize: 22, fontWeight: 900, margin: '0 0 4px', color: '#e8e8e4', lineHeight: 1.3 }}>
                      {business?.name}
                    </h1>
                    <p style={{ color: 'rgba(232,232,228,0.5)', margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                      דוח לרואה חשבון — {MONTHS[month - 1]} {year}
                    </p>
                    {activeTab !== 'all' && (
                      <div style={{ display: 'inline-block', marginTop: 10, padding: '4px 16px', borderRadius: 99,
                        background: `${activeTabMeta.color}33`, border: `1px solid ${activeTabMeta.color}66`,
                        color: activeTabMeta.color, fontSize: 12, fontWeight: 700 }}>
                        {activeTabMeta.label}
                      </div>
                    )}
                  </div>

                  {/* ── Sections — filtered by active tab ── */}

                  {(activeTab === 'all' || activeTab === 'pl') && (
                    previewData.pl
                      ? <SectionCard><PlSection pl={previewData.pl} month={month} year={year} /></SectionCard>
                      : activeTab === 'pl' && <EmptyState label="אין נתוני רווח והפסד לחודש זה" />
                  )}

                  {(activeTab === 'all' || activeTab === 'employees') && (
                    previewData.employees.length > 0
                      ? <SectionCard><EmployeesSection employees={previewData.employees} month={month} year={year} /></SectionCard>
                      : activeTab === 'employees' && <EmptyState label="אין נתוני עובדים לחודש זה" />
                  )}

                  {(activeTab === 'all' || activeTab === 'invoices') && (
                    previewData.invoices.length > 0
                      ? <SectionCard><InvoicesSection invoices={previewData.invoices} month={month} year={year} /></SectionCard>
                      : activeTab === 'invoices' && <EmptyState label="אין חשבוניות לחודש זה" />
                  )}

                  {(activeTab === 'all' || activeTab === 'inventory') && (
                    previewData.inventory.length > 0
                      ? <SectionCard><InventorySection inventory={previewData.inventory} /></SectionCard>
                      : activeTab === 'inventory' && <EmptyState label="אין פריטי מלאי" />
                  )}

                  {/* Footer */}
                  <p style={{ textAlign: 'center', color: 'rgba(232,232,228,0.25)', fontSize: 11, paddingBottom: 8 }}>
                    הופק ב-{new Date().toLocaleDateString('he-IL')} | {business?.name}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center py-28">
                  <p style={{ color: 'rgba(232,232,228,0.3)' }}>לא ניתן לטעון נתונים</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '24px 24px 20px', borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {children}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '36px 0', color: 'rgba(232,232,228,0.35)', fontSize: 14 }}>
      <Package style={{ width: 36, height: 36, margin: '0 auto 10px', color: 'rgba(232,232,228,0.2)' }} />
      <p>{label}</p>
    </div>
  );
}
