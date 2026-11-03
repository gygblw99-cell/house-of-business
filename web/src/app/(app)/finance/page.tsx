'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type {
  PosBarChartProps, IncomePieChartProps, MonthlyPieChartProps,
  CashflowChartProps, Forecast90ChartProps, ForecastBarChartProps, SimulatorLineChartProps } from './_charts/FinanceCharts';

const PosBarChart       = dynamic<PosBarChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.PosBarChart })), { ssr: false, loading: () => <div className="h-[220px] bg-gray-50 animate-pulse rounded-lg" /> });
const IncomePieChart    = dynamic<IncomePieChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.IncomePieChart })), { ssr: false, loading: () => <div className="w-[200px] h-[200px] bg-gray-50 animate-pulse rounded-full" /> });
const MonthlyPieChart   = dynamic<MonthlyPieChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.MonthlyPieChart })), { ssr: false, loading: () => <div className="w-[260px] h-[260px] bg-gray-50 animate-pulse rounded-full" /> });
const CashflowChart     = dynamic<CashflowChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.CashflowChart })), { ssr: false, loading: () => <div className="h-[280px] bg-gray-50 animate-pulse rounded-lg" /> });
const Forecast90Chart   = dynamic<Forecast90ChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.Forecast90Chart })), { ssr: false, loading: () => <div className="h-[200px] bg-gray-50 animate-pulse rounded-lg" /> });
const ForecastBarChart  = dynamic<ForecastBarChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.ForecastBarChart })), { ssr: false, loading: () => <div className="h-[220px] bg-gray-50 animate-pulse rounded-lg" /> });
const SimulatorLineChart = dynamic<SimulatorLineChartProps>(() => import('./_charts/FinanceCharts').then(m => ({ default: m.SimulatorLineChart })), { ssr: false, loading: () => <div className="h-[240px] bg-gray-50 animate-pulse rounded-lg" /> });

import {
  TrendingUp, TrendingDown, DollarSign, Target,
  Plus, Pencil, Trash2, ChevronDown, ChevronUp, Sliders,
  ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { financeApi } from '@/lib/api';
import VatTab     from './_tabs/VatTab';
import ReportsTab from './_tabs/ReportsTab';
import { formatCurrency, formatDate, getErrorMessage } from '@/lib/utils';
import { StatCard } from '@/components/ui/StatCard';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Badge } from '@/components/ui/Badge';
import type { CashflowEntry, DailyProfit } from '@/types';
import { useAppDialog } from '@/context/AppDialogContext';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useSyncEvent } from '@/context/SyncContext';

interface Expense {
  id: string; name: string; amount: number;
  frequency: string; category?: string; is_active: boolean; created_at?: string;
  // null = nobody has answered yet. The VAT report treats that as "unknown" and
  // deliberately does NOT deduct VAT for it — see vat.service.js.
  has_tax_invoice?: boolean | null;
}
interface Income {
  id: string; amount: number; description: string; income_date: string;
}

const FREQ_LABELS: Record<string, string> = {
  monthly: 'חודשי', weekly: 'שבועי', yearly: 'שנתי', one_time: 'חד פעמי',
};
const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const EXPENSE_CATEGORIES = ['שכירות', 'חשמל', 'מים', 'גז', 'ביטוח', 'רישיון', 'שיווק', 'תחזוקה', 'אחר'];

export default function FinancePage() {
  const { confirm, toast } = useAppDialog();
  const [daily, setDaily]       = useState<DailyProfit | null>(null);
  const [cashflow, setCashflow] = useState<CashflowEntry[]>([]);
  const [forecast, setForecast] = useState<{ date: string; dow: number; forecastRevenue: number; forecastProfit: number }[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [income, setIncome]     = useState<Income[]>([]);
  const [loading, setLoading]   = useState(true);
  const [monthLoading, setMonthLoading] = useState(true);
  const [forecast90, setForecast90] = useState<{
    days: { date: string; dow: number; forecastRevenue: number; forecastExpenses: number; forecastProfit: number; cumRevenue: number; cumProfit: number; events: { label: string; amount: number; type: string }[] }[];
    months: { month: string; forecastRevenue: number; forecastExpenses: number; forecastProfit: number }[];
    summary: { days: number; forecastRevenue: number; forecastExpenses: number; forecastProfit: number; monthlyFixed: number; monthlySalary: number; monthlyInvoices: number };
  } | null>(null);

  const [posBreakdown, setPosBreakdown] = useState<{
    days: { date: string; day: number; revenue: number; transactions: number; dailyExpense: number; dailyFixed: number; cogs: number; profit: number; isProfitable: boolean; cumRevenue: number }[];
    summary: { monthlyFixed: number; dailyFixed: number; totalRevenue: number; breakevenDay: number | null; daysInMonth: number; remaining: number; breakevenReached: boolean; monthlySalaryCost: number; totalMonthlyCogs: number; cogsIsEstimated?: boolean; deliveryFees?: number };
  } | null>(null);

  // Month selector
  const [selectedYear, setSelectedYear]   = useState(() => new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth() + 1);

  const isCurrentMonth = selectedYear === new Date().getFullYear() && selectedMonth === new Date().getMonth() + 1;

  const prevMonth = useCallback(() => {
    if (selectedMonth === 1) { setSelectedYear(y => y - 1); setSelectedMonth(12); }
    else setSelectedMonth(m => m - 1);
  }, [selectedMonth]);
  const nextMonth = useCallback(() => {
    if (isCurrentMonth) return;
    if (selectedMonth === 12) { setSelectedYear(y => y + 1); setSelectedMonth(1); }
    else setSelectedMonth(m => m + 1);
  }, [isCurrentMonth, selectedMonth]);

  // Sections toggle
  const [showExpenses, setShowExpenses]         = useState(true);
  const [showOneTimeExp, setShowOneTimeExp]     = useState(true);
  const [showIncome, setShowIncome]             = useState(true);

  // Expense modal
  const [expModal, setExpModal]   = useState(false);
  const [editExp, setEditExp]     = useState<Expense | null>(null);
  // hasTaxInvoice: '' = unanswered, 'yes'/'no' = explicit. Held as a string so
  // the three states survive a <select> round-trip instead of collapsing to false.
  const [expForm, setExpForm]     = useState({ name: '', amount: '', frequency: 'monthly', category: '', hasTaxInvoice: '' });
  const [expLoading, setExpLoading] = useState(false);
  const [expError, setExpError]   = useState('');

  // Active tab
  const [activeTab, setActiveTab] = useState<'finance' | 'vat' | 'reports'>('finance');

  // Simulator
  const [revenueAdj, setRevenueAdj] = useState(0);   // % change
  const [expenseAdj, setExpenseAdj] = useState(0);   // % change

  // Income modal
  const [incModal, setIncModal]   = useState(false);
  // Israel calendar date, not UTC (toISOString() rolls over 2-3 hours early relative to Israel midnight)
  const todayILStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const [incForm, setIncForm]     = useState({ amount: '', description: '', income_date: todayILStr() });
  const [incLoading, setIncLoading] = useState(false);
  const [incError, setIncError]   = useState('');

  const loadIncome = useCallback((year: number, month: number) => {
    financeApi.income(year, month)
      .then(({ data }) => setIncome(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const loadBase = useCallback((year: number, month: number) => {
    Promise.allSettled([
      financeApi.daily(),
      financeApi.cashflow({ days: 30 }),
      financeApi.forecast(),
      financeApi.expenses(),
      financeApi.forecast90(),
    ]).then(([d, cf, fc, exp, f90]) => {
      if (d.status  === 'fulfilled') setDaily(d.value.data);
      if (cf.status === 'fulfilled') setCashflow(Array.isArray(cf.value.data) ? cf.value.data : []);
      if (fc.status === 'fulfilled') setForecast(fc.value.data.forecast || []);
      if (exp.status === 'fulfilled') setExpenses(Array.isArray(exp.value.data) ? exp.value.data : []);
      if (f90.status === 'fulfilled') setForecast90(f90.value.data);
      setLoading(false);
    });
    loadIncome(year, month);
  }, [loadIncome]);

  const loadBreakdown = (year: number, month: number) => {
    financeApi.dailyBreakdown(year, month)
      .then(({ data }) => setPosBreakdown(data))
      .catch(() => setPosBreakdown(null));
  };

  const load = () => { loadBase(selectedYear, selectedMonth); loadBreakdown(selectedYear, selectedMonth); };

  useEffect(() => { loadBase(selectedYear, selectedMonth); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  // Batch-load month-specific data so content appears all at once (no stutter)
  useEffect(() => {
    setMonthLoading(true);
    Promise.allSettled([
      financeApi.dailyBreakdown(selectedYear, selectedMonth),
      financeApi.income(selectedYear, selectedMonth),
    ]).then(([bd, inc]) => {
      if (bd.status === 'fulfilled') setPosBreakdown(bd.value.data);
      else setPosBreakdown(null);
      if (inc.status === 'fulfilled') setIncome(Array.isArray(inc.value.data) ? inc.value.data : []);
      else setIncome([]);
    }).finally(() => setMonthLoading(false));
  }, [selectedYear, selectedMonth]);
  useSyncEvent(['finance.updated', 'invoice_approved', 'dashboard.refresh', 'shift_closed'], load);

  // ── Expenses ──────────────────────────────────────────────────
  const openAddExp = () => {
    setEditExp(null);
    setExpForm({ name: '', amount: '', frequency: 'monthly', category: '', hasTaxInvoice: '' });
    setExpError('');
    setExpModal(true);
  };

  const openEditExp = (exp: Expense) => {
    setEditExp(exp);
    setExpForm({ name: exp.name, amount: exp.amount.toString(), frequency: exp.frequency, category: exp.category || '',
      hasTaxInvoice: exp.has_tax_invoice === true ? 'yes' : exp.has_tax_invoice === false ? 'no' : '' });
    setExpError('');
    setExpModal(true);
  };

  const saveExp = async () => {
    if (!expForm.name || !expForm.amount) { setExpError('שם וסכום הם שדות חובה'); return; }
    setExpLoading(true); setExpError('');
    try {
      const { hasTaxInvoice, ...rest } = expForm;
      const payload = {
        ...rest,
        amount: parseFloat(expForm.amount),
        // Only send a boolean once the owner has actually chosen. '' must stay
        // absent so the column keeps NULL and the VAT report can tell "no" from
        // "not answered" — the two lead to different, deliberate behaviour.
        ...(hasTaxInvoice ? { hasTaxInvoice: hasTaxInvoice === 'yes' } : {}),
      };
      if (editExp) {
        await financeApi.updateExpense(editExp.id, payload);
        setExpenses(prev => prev.map(e => e.id === editExp.id
          ? { ...e, name: expForm.name, amount: payload.amount, frequency: expForm.frequency, category: expForm.category,
              has_tax_invoice: hasTaxInvoice === 'yes' ? true : hasTaxInvoice === 'no' ? false : e.has_tax_invoice }
          : e
        ));
      } else {
        const { data } = await financeApi.createExpense(payload);
        setExpenses(prev => [data, ...prev]);
      }
      setExpModal(false);
    } catch (err) { setExpError(getErrorMessage(err)); }
    finally { setExpLoading(false); }
  };

  const deleteExp = async (id: string) => {
    if (!await confirm('האם למחוק הוצאה זו?', 'מחיקת הוצאה')) return;
    try {
      await financeApi.deleteExpense(id);
      setExpenses(prev => prev.filter(e => e.id !== id));
    } catch (err) { toast(getErrorMessage(err)); }
  };

  // ── Income ────────────────────────────────────────────────────
  const saveIncome = async () => {
    if (!incForm.amount || !incForm.description) { setIncError('סכום ותיאור הם שדות חובה'); return; }
    setIncLoading(true); setIncError('');
    try {
      const { data } = await financeApi.createIncome({
        amount: parseFloat(incForm.amount),
        description: incForm.description,
        incomeDate: incForm.income_date,
      });
      setIncModal(false);
      loadIncome(selectedYear, selectedMonth);
    } catch (err) { setIncError(getErrorMessage(err)); }
    finally { setIncLoading(false); }
  };

  // income is already filtered server-side by selectedYear/selectedMonth
  const filteredIncome = income;

  const regularExpenses = useMemo(() => expenses.filter(e => e.frequency !== 'one_time'), [expenses]);
  // Full list — used by the management card below (add/edit/delete) so a
  // one-time expense logged in a past month is still findable and editable
  // when viewing a different month, not just the month it was created in.
  const oneTimeExpenses = useMemo(() => expenses.filter(e => e.frequency === 'one_time'), [expenses]);
  // Month-scoped subset — used ONLY for this month's totals (net profit,
  // breakeven, pie chart). One-time expenses are point-in-time (like manual
  // income), so they should only count toward the month they were logged in —
  // otherwise a one-time expense from any past month keeps getting subtracted
  // from every month's net profit forever.
  const oneTimeExpensesForMonth = useMemo(() => oneTimeExpenses.filter(e => {
    if (!e.created_at) return true;
    const d = new Date(e.created_at);
    return d.getFullYear() === selectedYear && d.getMonth() + 1 === selectedMonth;
  }), [oneTimeExpenses, selectedYear, selectedMonth]);

  const totalMonthlyExpenses = useMemo(() =>
    regularExpenses
      .filter(e => e.is_active)
      .reduce((sum, e) => {
        const amt = Number(e.amount) || 0;
        if (e.frequency === 'monthly')   return sum + amt;
        if (e.frequency === 'weekly')    return sum + amt * (52 / 12);
        if (e.frequency === 'yearly')    return sum + amt / 12;
        if (e.frequency === 'bimonthly') return sum + amt / 2;
        return sum;
      }, 0),
    [regularExpenses]
  );

  // Filtered by is_active, matching totalMonthlyExpenses — an inactive
  // (deactivated) one-time expense shouldn't count toward the current total
  const totalOneTimeExp = useMemo(() => oneTimeExpensesForMonth.filter(e => e.is_active).reduce((s, e) => s + (Number(e.amount) || 0), 0), [oneTimeExpensesForMonth]);
  // Separate from totalOneTimeExp (month-scoped, used in net-profit/breakeven calc
  // below) — this one sums the FULL list shown in the management card, so the
  // card's header caption always matches the rows actually displayed under it.
  const totalOneTimeExpAll = useMemo(() => oneTimeExpenses.filter(e => e.is_active).reduce((s, e) => s + (Number(e.amount) || 0), 0), [oneTimeExpenses]);
  const totalOneTimeInc = useMemo(() => filteredIncome.reduce((s, i)  => s + (Number(i.amount) || 0), 0), [filteredIncome]);

  // מחזור חודשי — מקופה אם זמין, אחרת מתזרים
  const monthlyRevenue = useMemo(() =>
    posBreakdown?.summary.totalRevenue ?? cashflow.reduce((s, e) => s + (e.revenue || 0), 0),
    [posBreakdown, cashflow]
  );

  const { PIE_DATA, totalIncome, totalExpense, netProfit, profitMargin, computedRemaining, monthlyCogs, monthlySalary, deliveryFees, cogsIsEstimated } = useMemo(() => {
    const cogs   = posBreakdown?.summary.totalMonthlyCogs   ?? 0;
    const salary = posBreakdown?.summary.monthlySalaryCost  ?? 0;
    // Wolt/Ten Bis commission — configured in הגדרות → חברות משלוחים.
    // Falls back to 0 (no deduction) until deliveryFees comes back from the
    // API, so this never silently understates cost while data is loading.
    const platformFees = posBreakdown?.summary.deliveryFees ?? 0;
    const ti = monthlyRevenue + totalOneTimeInc;
    const te = totalMonthlyExpenses + totalOneTimeExp + cogs + salary + platformFees;
    const np = ti - te;
    return {
      PIE_DATA: [
        { name: 'מחזור חודשי',      value: Math.round(monthlyRevenue),       color: '#3b82f6' },
        { name: 'הכנסות חד פעמיות', value: Math.round(totalOneTimeInc),      color: '#10b981' },
        { name: 'הוצאות קבועות',    value: Math.round(totalMonthlyExpenses), color: '#f97316' },
        { name: 'הוצאות חד פעמיות', value: Math.round(totalOneTimeExp),      color: '#ef4444' },
        ...(cogs   > 0 ? [{ name: 'עלות סחורה',  value: Math.round(cogs),   color: '#ea580c' }] : []),
        ...(salary > 0 ? [{ name: 'שכר עובדים', value: Math.round(salary), color: '#7c3aed' }] : []),
        ...(platformFees > 0 ? [{ name: 'עמלות פלטפורמות', value: Math.round(platformFees), color: '#60a5fa' }] : []),
      ].filter(d => d.value > 0),
      totalIncome:       ti,
      totalExpense:      te,
      netProfit:         np,
      profitMargin:      ti > 0 ? (np / ti) * 100 : 0,
      computedRemaining: Math.max(0, te - ti),
      monthlyCogs:       cogs,
      monthlySalary:     salary,
      deliveryFees:      platformFees,
      cogsIsEstimated:   !!posBreakdown?.summary.cogsIsEstimated,
    };
  }, [monthlyRevenue, totalOneTimeInc, totalMonthlyExpenses, totalOneTimeExp, posBreakdown]);

  if (loading) return <div className="p-8 text-center text-gray-400">טוען...</div>;

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">

      {/* ── Tab bar ───────────────────────────────────────────── */}
      <div className="flex gap-1 p-1 rounded-2xl w-fit"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
        {([
          { id: 'finance',  label: 'פיננסים' },
          { id: 'vat',      label: 'צפי מע"מ' },
          { id: 'reports',  label: 'ייצוא לרו"ח' },
        ] as const).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition-all"
            style={activeTab === id
              ? { background: 'var(--color-primary,#1a5c2a)', color: '#fff' }
              : { color: 'var(--text-secondary)', opacity: 0.7 }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'vat'      && <VatTab />}
      {activeTab === 'reports'  && <ReportsTab />}
      {activeTab === 'finance' && (<>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">פיננסים</h1>
          <div className="flex items-center gap-2 mt-1">
            <button onClick={prevMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
              <ChevronRight className="w-5 h-5" />
            </button>
            <span className="text-xl font-bold text-gray-700 min-w-[120px] text-center">
              {HEBREW_MONTHS[selectedMonth - 1]} {selectedYear}
            </span>
            <button
              onClick={nextMonth}
              disabled={isCurrentMonth}
              className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => { setIncForm({ amount: '', description: '', income_date: todayILStr() }); setIncError(''); setIncModal(true); }}>
            <Plus className="w-4 h-4" /> הכנסה חד פעמית
          </Button>
          <Button variant="outline" onClick={() => { setEditExp(null); setExpForm({ name: '', amount: '', frequency: 'one_time', category: '', hasTaxInvoice: '' }); setExpError(''); setExpModal(true); }}>
            <Plus className="w-4 h-4" /> הוצאה חד פעמית
          </Button>
          <Button onClick={openAddExp}>
            <Plus className="w-4 h-4" /> הוצאה קבועה
          </Button>
        </div>
      </div>

      {monthLoading ? (
        <div className="flex items-center justify-center py-14">
          <p className="text-gray-400 text-lg font-medium">טוען...</p>
        </div>
      ) : (<>

      {/* Monthly stats */}
      {(posBreakdown || daily) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="הכנסה חודשית"
            value={formatCurrency(monthlyRevenue)}
            subtitle={`${HEBREW_MONTHS[selectedMonth - 1]} ${selectedYear}`}
            icon={DollarSign} iconColor="text-blue-600" iconBg="bg-blue-50" />
          <StatCard
            title="עלות סחורה"
            value={formatCurrency(monthlyCogs)}
            subtitle={cogsIsEstimated ? 'הערכה — אין חשבוניות ספק לחודש זה' : 'חשבוניות ספקים החודש'}
            icon={TrendingDown} iconColor="text-orange-600" iconBg="bg-orange-50" />
          <StatCard
            title="שכר + הוצאות"
            value={formatCurrency(monthlySalary + totalMonthlyExpenses)}
            subtitle="שכר בפועל + הוצאות קבועות"
            icon={TrendingDown} iconColor="text-red-600" iconBg="bg-red-50" />
          <StatCard
            title="רווח נקי"
            value={formatCurrency(netProfit)}
            subtitle={`מרווח ${totalIncome > 0 ? Math.abs(profitMargin).toFixed(1) : '0.0'}%`}
            icon={Target}
            iconColor={netProfit >= 0 ? 'text-green-600' : 'text-red-600'}
            iconBg={netProfit >= 0 ? 'bg-green-50' : 'bg-red-50'} />
        </div>
      )}

      {/* ── סנכרון קופה — מחזור יומי vs הוצאות ─────────────────── */}
      {posBreakdown && posBreakdown.days.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between flex-wrap gap-2">
              <span className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-600" />
                מחזור יומי מהקופה — {HEBREW_MONTHS[selectedMonth - 1]} {selectedYear}
              </span>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-500">
                  מחזור חודשי: <span className="font-bold text-blue-700">{formatCurrency(posBreakdown.summary.totalRevenue)}</span>
                </span>
                {totalExpense > 0 && monthlyRevenue >= totalExpense ? (
                  <span className="px-2 py-1 rounded-full bg-green-100 text-green-700 text-xs font-semibold">
                    ✓ כיסוי הוצאות הושג
                  </span>
                ) : totalExpense > 0 ? (
                  <span className="px-2 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">
                    נותר {formatCurrency(computedRemaining)} לכיסוי הוצאות
                  </span>
                ) : null}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Breakeven progress */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>כיסוי הוצאות חודשיות ({formatCurrency(totalExpense)})</span>
                <span>{totalExpense > 0
                  ? `${Math.min(Math.round((monthlyRevenue / totalExpense) * 100), 100)}%`
                  : '0%'}</span>
              </div>
              <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${monthlyRevenue >= totalExpense ? 'bg-green-500' : 'bg-blue-500'}`}
                  style={{ width: `${Math.min(totalExpense > 0 ? (monthlyRevenue / totalExpense) * 100 : 0, 100)}%` }}
                />
              </div>
            </div>

            {/* גרף עמודות יומי */}
            <PosBarChart days={posBreakdown.days} />

            {/* סיכום יומי */}
            <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs">
              <div className="bg-green-50 rounded-lg p-2">
                <p className="text-gray-500">ימים רווחיים</p>
                <p className="font-bold text-green-700 text-base">
                  {posBreakdown.days.filter(d => d.isProfitable).length}/{posBreakdown.days.length}
                </p>
              </div>
              <div className="bg-blue-50 rounded-lg p-2">
                <p className="text-gray-500">ממוצע יומי</p>
                <p className="font-bold text-blue-700 text-base">
                  {posBreakdown.days.length > 0
                    ? formatCurrency(posBreakdown.summary.totalRevenue / posBreakdown.days.length)
                    : '—'}
                </p>
              </div>
              <div className="bg-orange-50 rounded-lg p-2">
                <p className="text-gray-500">עלות יומית קבועה</p>
                <p className="font-bold text-orange-700 text-base">
                  {formatCurrency(posBreakdown.summary.dailyFixed)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* הוצאות מול הכנסות */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Target className="w-5 h-5 text-purple-600" />הוצאות מול הכנסות — 30 יום</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {/* Progress bars */}
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-green-700 flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> סה״כ הכנסות</span>
                <span className="font-bold text-green-700">{formatCurrency(totalIncome)}</span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: totalIncome > 0 ? '100%' : '0%' }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-red-700 flex items-center gap-1"><TrendingDown className="w-3.5 h-3.5" /> סה״כ הוצאות</span>
                <span className="font-bold text-red-700">{formatCurrency(totalExpense)}</span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-red-500 rounded-full transition-all"
                  style={{ width: totalIncome > 0 ? `${Math.min((totalExpense / totalIncome) * 100, 100)}%` : '0%' }} />
              </div>
            </div>
          </div>

          {/* Breakdown */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-green-50 rounded-xl p-3 space-y-1">
              <p className="text-xs text-gray-500 font-medium">פירוט הכנסות</p>
              <div className="flex justify-between"><span className="text-gray-600">מחזור חודשי</span><span className="font-semibold text-green-700">{formatCurrency(monthlyRevenue)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">הכנסות חד פעמיות</span><span className="font-semibold text-green-700">{formatCurrency(totalOneTimeInc)}</span></div>
            </div>
            <div className="bg-red-50 rounded-xl p-3 space-y-1">
              <p className="text-xs text-gray-500 font-medium">פירוט הוצאות</p>
              <div className="flex justify-between"><span className="text-gray-600">הוצאות קבועות</span><span className="font-semibold text-red-700">{formatCurrency(totalMonthlyExpenses)}</span></div>
              <div className="flex justify-between"><span className="text-gray-600">הוצאות חד פעמיות</span><span className="font-semibold text-red-700">{formatCurrency(totalOneTimeExp)}</span></div>
              {monthlyCogs   > 0 && <div className="flex justify-between"><span className="text-gray-600">עלות סחורה{cogsIsEstimated ? ' (הערכה)' : ''}</span><span className="font-semibold text-orange-700">{formatCurrency(monthlyCogs)}</span></div>}
              {monthlySalary > 0 && <div className="flex justify-between"><span className="text-gray-600">שכר עובדים</span><span className="font-semibold text-purple-700">{formatCurrency(monthlySalary)}</span></div>}
            </div>
          </div>

          {/* Pie + Net profit */}
          <div className="flex flex-col md:flex-row items-center gap-6">
            <IncomePieChart
              totalIncome={totalIncome}
              totalExpense={totalExpense}
              netProfit={netProfit}
              profitMargin={profitMargin}
            />

            <div className="flex-1 space-y-3 w-full">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500 flex-shrink-0" />
                <span className="text-sm text-gray-600 flex-1">הכנסות</span>
                <span className="font-bold text-green-700">{formatCurrency(totalIncome)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500 flex-shrink-0" />
                <span className="text-sm text-gray-600 flex-1">הוצאות</span>
                <span className="font-bold text-red-700">{formatCurrency(totalExpense)}</span>
              </div>
              {netProfit > 0 && (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-indigo-500 flex-shrink-0" />
                  <span className="text-sm text-gray-600 flex-1">רווח</span>
                  <span className="font-bold text-indigo-700">{formatCurrency(netProfit)}</span>
                </div>
              )}
              <div className={`rounded-xl p-3 mt-2 ${netProfit >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                <p className="text-xs text-gray-500 mb-0.5">רווח נקי</p>
                <p className={`text-xl font-black ${netProfit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {netProfit >= 0 ? '+' : ''}{formatCurrency(netProfit)}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pie chart — סיכום חודשי */}
      {PIE_DATA.length > 0 && (
        <Card>
          <CardHeader><CardTitle>סיכום חודשי — תמונה כללית</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row items-center gap-6">
              <MonthlyPieChart pieData={PIE_DATA} />
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                {PIE_DATA.map((d) => (
                  <div key={d.name} className="flex items-center gap-3 p-3 rounded-xl"
                    style={{ background: d.color + '12', border: `1px solid ${d.color}30` }}>
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: d.color }} />
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500">{d.name}</p>
                      <p className="text-sm font-bold" style={{ color: d.color }}>{formatCurrency(d.value)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      </>)}

      {/* Cashflow chart */}
      {cashflow.length > 0 && (
        <Card>
          <CardHeader><CardTitle>תזרים מזומנים — 30 יום</CardTitle></CardHeader>
          <CardContent>
            <CashflowChart cashflow={cashflow} />
          </CardContent>
        </Card>
      )}

      {/* תחזית 90 יום */}
      {forecast90 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-indigo-600" />
              תחזית תזרים מזומנים — 90 יום קדימה
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* סיכום 3 חודשים */}
            <div className="grid grid-cols-3 gap-3">
              {forecast90.months.map((m) => {
                const label = new Date(m.month + '-01').toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
                return (
                  <div key={m.month} className="rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-center">
                    <p className="text-xs text-gray-500 mb-1">{label}</p>
                    <p className="text-sm font-bold text-indigo-700">{formatCurrency(m.forecastRevenue)}</p>
                    <p className={`text-xs font-semibold mt-0.5 ${m.forecastProfit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {m.forecastProfit >= 0 ? '+' : ''}{formatCurrency(m.forecastProfit)} רווח
                    </p>
                  </div>
                );
              })}
            </div>

            {/* KPIs סיכום */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-center text-xs">
              <div className="bg-blue-50 rounded-lg p-3">
                <p className="text-gray-500">הכנסות צפויות</p>
                <p className="font-black text-blue-700 text-base mt-0.5">{formatCurrency(forecast90.summary.forecastRevenue)}</p>
              </div>
              <div className="bg-orange-50 rounded-lg p-3">
                <p className="text-gray-500">הוצאות צפויות</p>
                <p className="font-black text-orange-700 text-base mt-0.5">{formatCurrency(forecast90.summary.forecastExpenses)}</p>
              </div>
              <div className={`rounded-lg p-3 ${forecast90.summary.forecastProfit >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                <p className="text-gray-500">רווח צפוי</p>
                <p className={`font-black text-base mt-0.5 ${forecast90.summary.forecastProfit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {forecast90.summary.forecastProfit >= 0 ? '+' : ''}{formatCurrency(forecast90.summary.forecastProfit)}
                </p>
              </div>
              <div className="bg-purple-50 rounded-lg p-3">
                <p className="text-gray-500">עלות חודשית קבועה</p>
                <p className="font-black text-purple-700 text-base mt-0.5">{formatCurrency(forecast90.summary.monthlyFixed + forecast90.summary.monthlySalary)}</p>
              </div>
            </div>

            {/* גרף הכנסות + מאזן צובר */}
            <div>
              <p className="text-xs font-semibold text-gray-600 mb-2">הכנסות יומיות צפויות (90 יום)</p>
              <Forecast90Chart days={forecast90.days} />
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-400 justify-center">
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> הכנסה יומית</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-500 inline-block" /> רווח מצטבר</span>
              </div>
            </div>

            {/* פירוט עלויות */}
            <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 space-y-1.5">
              <p className="font-semibold text-gray-700 mb-2">הנחות חישוב (לחודש)</p>
              <div className="flex justify-between"><span>הוצאות קבועות</span><span className="font-bold">{formatCurrency(forecast90.summary.monthlyFixed)}</span></div>
              <div className="flex justify-between"><span>עלות שכר</span><span className="font-bold">{formatCurrency(forecast90.summary.monthlySalary)}</span></div>
              <div className="flex justify-between"><span>עלות חשבוניות (ממוצע)</span><span className="font-bold">{formatCurrency(forecast90.summary.monthlyInvoices)}</span></div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* הוצאות קבועות */}
      <Card>
        <CardHeader className="flex-row items-center justify-between cursor-pointer" onClick={() => setShowExpenses(v => !v)}>
          <CardTitle className="flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-orange-500" />
            הוצאות קבועות
            <span className="text-sm font-normal text-gray-500">— {formatCurrency(totalMonthlyExpenses)}/חודש</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); openAddExp(); }}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-blue-600">
              <Plus className="w-4 h-4" />
            </button>
            {showExpenses ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </div>
        </CardHeader>
        {showExpenses && (
          <CardContent className="p-0">
            {regularExpenses.length === 0 ? (
              <p className="text-center py-8 text-gray-400 text-sm">אין הוצאות קבועות — לחץ + להוספה</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {regularExpenses.map(exp => (
                  <div key={exp.id} className={`flex items-center gap-4 px-6 py-3 hover:bg-gray-50 ${!exp.is_active ? 'opacity-50' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{exp.name}</p>
                      {exp.category && <p className="text-xs text-gray-400">{exp.category}</p>}
                    </div>
                    <Badge variant="default">{FREQ_LABELS[exp.frequency]}</Badge>
                    <span className="text-sm font-semibold text-orange-600 w-24 text-left">{formatCurrency(exp.amount)}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEditExp(exp)} className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => deleteExp(exp.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* הוצאות חד פעמיות */}
      <Card style={{ border: '1px solid #fecaca' }}>
        <CardHeader className="flex-row items-center justify-between cursor-pointer" onClick={() => setShowOneTimeExp(v => !v)}>
          <CardTitle className="flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-red-500" />
            הוצאות חד פעמיות
            {totalOneTimeExp > 0 && (
              <span className="text-sm font-normal text-gray-500">— {formatCurrency(totalOneTimeExp)} סה״כ</span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); setEditExp(null); setExpForm({ name: '', amount: '', frequency: 'one_time', category: '', hasTaxInvoice: '' }); setExpError(''); setExpModal(true); }}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-blue-600">
              <Plus className="w-4 h-4" />
            </button>
            {showOneTimeExp ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </div>
        </CardHeader>
        {showOneTimeExp && (
          <CardContent className="p-0">
            {oneTimeExpenses.length === 0 ? (
              <p className="text-center py-8 text-gray-400 text-sm">אין הוצאות חד פעמיות — לחץ + להוספה</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {oneTimeExpenses.map(exp => (
                  <div key={exp.id} className="flex items-center gap-4 px-6 py-3 hover:bg-red-50/40">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{exp.name}</p>
                      {exp.category && <p className="text-xs text-gray-400">{exp.category}</p>}
                    </div>
                    <Badge variant="danger">חד פעמי</Badge>
                    <span className="text-sm font-semibold text-red-600 w-24 text-left">{formatCurrency(exp.amount)}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEditExp(exp)} className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => deleteExp(exp.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Manual Income */}
      <Card>
        <CardHeader className="flex-row items-center justify-between cursor-pointer" onClick={() => setShowIncome(v => !v)}>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-green-500" />
            הכנסות חד פעמיות
          </CardTitle>
          <div className="flex items-center gap-2">
            <button onClick={e => { e.stopPropagation(); setIncForm({ amount: '', description: '', income_date: todayILStr() }); setIncError(''); setIncModal(true); }}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-blue-600">
              <Plus className="w-4 h-4" />
            </button>
            {showIncome ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </div>
        </CardHeader>
        {showIncome && (
          <CardContent className="p-0">
            {income.length === 0 ? (
              <p className="text-center py-8 text-gray-400 text-sm">אין הכנסות חד פעמיות — לחץ + להוספה</p>
            ) : (
              <div className="divide-y divide-gray-50">
                {income.map(inc => (
                  <div key={inc.id} className="flex items-center gap-4 px-6 py-3 hover:bg-gray-50 group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{inc.description}</p>
                      <p className="text-xs text-gray-400">{formatDate(inc.income_date)}</p>
                    </div>
                    <span className="text-sm font-semibold text-green-600">{formatCurrency(inc.amount)}</span>
                    <button
                      onClick={async () => {
                        if (!await confirm('האם למחוק הכנסה זו?', 'מחיקת הכנסה')) return;
                        try {
                          await financeApi.deleteIncome(inc.id);
                          setIncome(prev => prev.filter(i => i.id !== inc.id));
                        } catch (err) { toast(getErrorMessage(err)); }
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-gray-400 hover:text-red-500"
                      title="מחק הכנסה"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Forecast chart */}
      {forecast.length > 0 && (
        <Card>
          <CardHeader><CardTitle>תחזית 7 ימים הבאים</CardTitle></CardHeader>
          <CardContent>
            <ForecastBarChart forecast={forecast} />
          </CardContent>
        </Card>
      )}

      {/* Cashflow Simulator */}
      {cashflow.length > 0 && (() => {
        const simData = cashflow.map(entry => ({
          date: entry.date,
          revenue: entry.revenue,
          profit: entry.estimatedProfit,
          sim_revenue: entry.revenue * (1 + revenueAdj / 100),
          sim_profit: entry.estimatedProfit
            + entry.revenue * (revenueAdj / 100)
            - (entry.revenue - entry.estimatedProfit) * (expenseAdj / 100),
        }));
        const totalRevDiff = simData.reduce((s, e) => s + (e.sim_revenue - e.revenue), 0);
        const totalProfDiff = simData.reduce((s, e) => s + (e.sim_profit - e.profit), 0);
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sliders className="w-5 h-5 text-purple-600" />
                סימולטור תזרים — מה אם?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-700">שינוי בהכנסות</label>
                    <span className={`text-sm font-bold ${revenueAdj >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {revenueAdj > 0 ? '+' : ''}{revenueAdj}%
                    </span>
                  </div>
                  <input type="range" min={-50} max={50} step={1} value={revenueAdj}
                    onChange={e => setRevenueAdj(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>-50%</span><span>0%</span><span>+50%</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-700">שינוי בהוצאות משתנות</label>
                    <span className={`text-sm font-bold ${expenseAdj <= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {expenseAdj > 0 ? '+' : ''}{expenseAdj}%
                    </span>
                  </div>
                  <input type="range" min={-50} max={50} step={1} value={expenseAdj}
                    onChange={e => setExpenseAdj(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-600" />
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>-50%</span><span>0%</span><span>+50%</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className={`rounded-xl px-4 py-3 ${totalRevDiff >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <p className="text-xs text-gray-500 mb-1">השפעה על הכנסות (30 יום)</p>
                  <p className={`text-lg font-bold ${totalRevDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {totalRevDiff >= 0 ? '+' : ''}{formatCurrency(totalRevDiff)}
                  </p>
                </div>
                <div className={`rounded-xl px-4 py-3 ${totalProfDiff >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                  <p className="text-xs text-gray-500 mb-1">השפעה על רווח (30 יום)</p>
                  <p className={`text-lg font-bold ${totalProfDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {totalProfDiff >= 0 ? '+' : ''}{formatCurrency(totalProfDiff)}
                  </p>
                </div>
              </div>

              <SimulatorLineChart simData={simData} />
              <p className="text-xs text-gray-400 text-center">קו מקווקו = בפועל, קו מלא = סימולציה</p>
            </CardContent>
          </Card>
        );
      })()}

      </>)}

      {/* Expense Modal */}
      <Modal open={expModal} onClose={() => setExpModal(false)}
        title={editExp ? `עריכת ${editExp.name}` : expForm.frequency === 'one_time' ? 'הוצאה חד פעמית חדשה' : 'הוצאה קבועה חדשה'}>
        <div className="p-6 space-y-4">
          <Input label="שם ההוצאה" value={expForm.name} placeholder="לדוגמה: שכירות משרד"
            onChange={e => setExpForm(f => ({ ...f, name: e.target.value }))} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="סכום (₪)" type="number" step="0.01" value={expForm.amount}
              onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))} />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">תדירות</label>
              <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                value={expForm.frequency} onChange={e => setExpForm(f => ({ ...f, frequency: e.target.value }))}>
                <option value="monthly">חודשי</option>
                <option value="bimonthly">דו-חודשי</option>
                <option value="weekly">שבועי</option>
                <option value="yearly">שנתי</option>
                <option value="one_time">חד פעמי</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">קטגוריה (אופציונלי)</label>
            <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              value={expForm.category} onChange={e => setExpForm(f => ({ ...f, category: e.target.value }))}>
              <option value="">ללא קטגוריה</option>
              {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {/* Drives whether this expense's VAT may be deducted at all. Left
              unanswered it stays out of the claim — see vat.service.js. */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">מגיעה עם חשבונית מס?</label>
            <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              value={expForm.hasTaxInvoice} onChange={e => setExpForm(f => ({ ...f, hasTaxInvoice: e.target.value }))}>
              <option value="">לא נבדק</option>
              <option value="yes">כן — יש חשבונית מס</option>
              <option value="no">לא — ללא מע&quot;מ</option>
            </select>
            <p className="text-xs text-gray-500 leading-relaxed">
              רק הוצאות עם חשבונית מס נכנסות לקיזוז מע&quot;מ תשומות. ארנונה, ביטוח ושכירות ממשכיר פרטי
              אינן נושאות מע&quot;מ — קיזוז שלהן הוא דיווח חסר מול רשות המסים.
            </p>
          </div>
          {expError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{expError}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setExpModal(false)}>ביטול</Button>
            <Button onClick={saveExp} loading={expLoading}>{editExp ? 'עדכן' : 'הוסף'}</Button>
          </div>
        </div>
      </Modal>

      {/* Income Modal */}
      <Modal open={incModal} onClose={() => setIncModal(false)} title="הכנסה חד פעמית חדשה">
        <div className="p-6 space-y-4">
          <Input label="תיאור" value={incForm.description} placeholder="לדוגמה: קייטרינג אירוע"
            onChange={e => setIncForm(f => ({ ...f, description: e.target.value }))} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="סכום (₪)" type="number" step="0.01" value={incForm.amount}
              onChange={e => setIncForm(f => ({ ...f, amount: e.target.value }))} />
            <DatePicker
              label="תאריך"
              value={incForm.income_date}
              onChange={v => setIncForm(f => ({ ...f, income_date: v }))}
            />
          </div>
          {incError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{incError}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setIncModal(false)}>ביטול</Button>
            <Button onClick={saveIncome} loading={incLoading}>הוסף הכנסה</Button>
          </div>
        </div>
      </Modal>
    </div>
    </ErrorBoundary>
  );
}
