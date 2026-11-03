'use client';

import { useState } from 'react';
import { Loader2, Download, Search, TrendingUp, TrendingDown, Scale, ToggleLeft, ToggleRight, Info, AlertTriangle } from 'lucide-react';
import api from '@/lib/api/client';
import { useAppDialog } from '@/context/AppDialogContext';
import { getBiMonthlyPeriodStartMonth, downloadBlob, getErrorMessage } from '@/lib/utils';

interface VatResult {
  period: { year: number; month: number; period: number; month_end: number; start_date: string; end_date: string };
  output: { gross_sales: number; net_sales: number; output_vat: number; tx_count: number };
  input: {
    gross_purchases: number; net_purchases: number;
    input_vat_invoices: number; input_vat_expenses: number; total_input_vat: number; invoice_count: number;
    invoices_vat_derived?: number;
    unapproved_count?: number; unapproved_amount?: number;
    expenses_breakdown?: {
      total: number; vat_bearing: number; no_vat: number;
      unknown: number; unknown_count: number;
      unknown_items: { name: string; amount: number }[];
      potential_extra_vat: number;
    };
  };
  net_vat: number;
  payable: boolean;
  vat_rate: number;
}

const fmt = (n: number | null | undefined) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(typeof n === 'number' && isFinite(n) ? n : 0);
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

export default function VatReportPage() {
  const { toast } = useAppDialog();
  const [data, setData]     = useState<VatResult | null>(null);
  const [loading, setLoading] = useState(false);
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());
  const [biMonthly, setBiMonthly] = useState(false);

  const calculate = async () => {
    setLoading(true);
    try {
      const { data: res } = await api.get('/finance/vat', {
        params: { year, month, period: biMonthly ? 2 : 1 },
      });
      setData(res);
    } catch (e: unknown) {
      toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בחישוב מע"מ', 'error');
    }
    setLoading(false);
  };

  const exportExcel = async () => {
    if (!data) return;
    try {
      const res = await api.get('/export/vat', {
        params: { year, month, period: biMonthly ? 2 : 1 },
        responseType: 'blob',
      });
      // downloadBlob, not a bare a.click(): an anchor that was never added to
      // the document doesn't fire in Firefox, and revoking the URL in the same
      // tick cancels the download in Safari. Both handled there.
      downloadBlob(new Blob([res.data]), `מעמ-${year}-${String(month).padStart(2, '0')}.xlsx`);
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  // Bi-monthly periods are fixed legal pairs (Jan-Feb, Mar-Apr, ...) — mirror
  // finance/_tabs/VatTab.tsx's normalization instead of trusting data.period.month_end,
  // which the backend now computes from the pair's start month, not the raw selected month.
  // Derived from `data.period` (the last FETCHED query), not the live month/biMonthly
  // selectors — otherwise changing the dropdowns without re-fetching makes the label
  // show a different period than the figures actually displayed below it.
  const dataIsBiMonthly = data?.period.period === 2;
  const periodStartMonth = data
    ? (dataIsBiMonthly ? getBiMonthlyPeriodStartMonth(data.period.month) : data.period.month)
    : month;
  const periodLabel = data
    ? (dataIsBiMonthly
        ? `${MONTHS[periodStartMonth - 1]}–${MONTHS[periodStartMonth]} ${data.period.year}`
        : `${MONTHS[periodStartMonth - 1]} ${data.period.year}`)
    : '';

  return (
    <div className="space-y-6" dir="rtl">
      <div className="rounded-2xl p-6 text-white" style={{ background: 'var(--hero-gradient)' }}>
        {/* "דוח מע\"מ … יתרה לתשלום" read like a filing. It isn't one: it's
            computed from the sales and expenses in this system, which is a
            subset of what a VAT return actually needs (mixed-use inputs, fixed
            assets, imports, self-invoicing). Reframed as a cash-planning
            estimate — the genuinely useful thing the accountant can't give you,
            because they tell you AFTER the period closes. */}
        <h1 className="text-2xl font-black">צפי מע&quot;מ</h1>
        <p className="text-sm mt-1 opacity-60">
          אומדן לתכנון תזרים — מע&quot;מ עסקאות מול תשומות, שיעור {data?.vat_rate ?? 18}%
        </p>
      </div>

      <div className="rounded-2xl p-4 flex items-start gap-3"
        style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.25)' }}>
        <Info className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#c9a227' }} />
        <div className="text-sm leading-relaxed text-[rgba(232,232,228,0.75)]">
          <p className="font-semibold">זהו אומדן, לא דוח להגשה.</p>
          <p className="text-xs mt-1 opacity-80">
            המספר מחושב מהמכירות וההוצאות שבמערכת בלבד. הדיווח בפועל נעשה על ידי רואה החשבון, שרואה גם
            נתונים שאינם כאן. השתמש בזה כדי לדעת מראש כמה כסף להשאיר בצד — ולחץ &quot;ייצא Excel&quot; כדי
            לשלוח לרואה החשבון את הנתונים מוכנים.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm p-4">
        <span className="text-sm font-medium text-[rgba(232,232,228,0.6)]">תקופה:</span>
        <select value={month} onChange={e => setMonth(+e.target.value)}
          className="border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-3 py-2 text-sm focus:outline-none">
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={year} onChange={e => setYear(+e.target.value)}
          className="border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-3 py-2 text-sm focus:outline-none">
          {[2023, 2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={() => setBiMonthly(b => !b)}
          className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-xl border transition-colors"
          style={biMonthly
            ? { borderColor: 'var(--color-primary)', background: 'rgba(26,92,42,0.07)', color: 'var(--color-primary)' }
            : { borderColor: 'rgba(201,162,39,0.16)', color: 'rgba(232,232,228,0.45)' }}>
          {biMonthly ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
          דו-חודשי
        </button>
        <button onClick={calculate} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
          style={{ background: 'var(--color-primary,#1a5c2a)' }}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          חפש
        </button>
        {data && (
          <button onClick={exportExcel}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'var(--color-primary,#1a5c2a)' }}>
            <Download className="w-4 h-4" /> ייצא לרואה החשבון
          </button>
        )}
      </div>

      {!data && !loading && (
        <div className="flex flex-col items-center justify-center py-16 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)]">
          <Search className="w-12 h-12 text-[rgba(232,232,228,0.2)] mb-3" />
          <p className="text-[rgba(232,232,228,0.45)]">בחר תקופה ולחץ &quot;חפש&quot;</p>
        </div>
      )}

      {data && (
        <>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
                <p className="text-sm font-semibold text-[rgba(232,232,228,0.6)]">מע&quot;מ עסקאות (פלט)</p>
              </div>
              <p className="text-xs text-[rgba(232,232,228,0.4)]">מחזור: {fmt(data.output.gross_sales)}</p>
              <p className="text-xs text-[rgba(232,232,228,0.4)]">נטו: {fmt(data.output.net_sales)}</p>
              <p className="text-2xl font-black mt-2" style={{ color: 'var(--color-primary)' }}>{fmt(data.output.output_vat)}</p>
            </div>
            <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingDown className="w-4 h-4 text-amber-600" />
                <p className="text-sm font-semibold text-[rgba(232,232,228,0.6)]">מע&quot;מ תשומות (קלט)</p>
              </div>
              <p className="text-xs text-[rgba(232,232,228,0.4)]">חשבוניות: {fmt(data.input.input_vat_invoices)}</p>
              <p className="text-xs text-[rgba(232,232,228,0.4)]">הוצאות קבועות: {fmt(data.input.input_vat_expenses)}</p>
              <p className="text-2xl font-black mt-2 text-amber-600">{fmt(data.input.total_input_vat)}</p>
            </div>
            <div className={`rounded-2xl border shadow-sm p-5 ${data.payable ? 'bg-red-950/20 border-red-800/40' : 'bg-green-950/20 border-green-800/40'}`}>
              <div className="flex items-center gap-2 mb-3">
                <Scale className={`w-4 h-4 ${data.payable ? 'text-red-400' : 'text-green-400'}`} />
                <p className="text-sm font-semibold text-[rgba(232,232,228,0.6)]">
                  {data.payable ? 'צפי לתשלום' : 'צפי להחזר'}
                </p>
              </div>
              <p className={`text-2xl font-black mt-1 ${data.payable ? 'text-red-600' : 'text-green-600'}`}>
                {fmt(Math.abs(data.net_vat))}
              </p>
              <p className="text-[11px] mt-1 text-[rgba(232,232,228,0.4)]">אומדן — לא סכום להגשה</p>
            </div>
          </div>

          {/* Same two caveats the finance tab shows. A number this prominent has
              to carry what it's resting on, on every screen that renders it. */}
          {!!data.input.expenses_breakdown?.unknown_count && (
            <div className="rounded-2xl p-4 flex items-start gap-3"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)' }}>
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
              <div className="text-sm leading-relaxed text-[rgba(232,232,228,0.75)] flex-1 min-w-0">
                <p className="font-semibold">
                  {fmt(data.input.expenses_breakdown.unknown)} בהוצאות שלא סומן לגביהן אם מגיעה חשבונית מס
                </p>
                <p className="text-xs mt-1 opacity-80">
                  לא קיזזנו מהן מע&quot;מ, ולכן הצפי למעלה גבוה ממה שייתכן שתשלם בפועל. אם לכולן יש חשבונית מס,
                  מדובר בעוד <strong>{fmt(data.input.expenses_breakdown.potential_extra_vat)}</strong> לקיזוז.
                  סמן כל הוצאה במסך הכספים ← הוצאות קבועות.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {data.input.expenses_breakdown.unknown_items.map(it => (
                    <span key={it.name} className="text-[11px] px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(245,158,11,0.14)' }}>
                      {it.name} · {fmt(it.amount)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
          {(!!data.input.unapproved_count || !!data.input.invoices_vat_derived) && (
            <div className="rounded-2xl p-3 text-xs space-y-1 text-[rgba(232,232,228,0.55)]"
              style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
              {!!data.input.unapproved_count && (
                <p>{data.input.unapproved_count} חשבוניות ({fmt(data.input.unapproved_amount || 0)}) עדיין לא אושרו ידנית — כלולות בחישוב, מבוססות על קריאת OCR שלא נבדקה.</p>
              )}
              {!!data.input.invoices_vat_derived && (
                <p>ב-{data.input.invoices_vat_derived} חשבוניות לא נקרא סכום מע&quot;מ והוא חושב לפי {data.vat_rate}% — לא מדויק לפריטים בשיעור אפס (פירות וירקות טריים).</p>
              )}
            </div>
          )}

          <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm p-5">
            <p className="text-xs font-bold text-[rgba(232,232,228,0.45)] uppercase tracking-wide mb-3">
              פירוט תקופה: {periodLabel}
            </p>
            {[
              { label: 'מחזור מכירות (כולל מע"מ)', val: fmt(data.output.gross_sales) },
              { label: 'מחזור נטו (ללא מע"מ)', val: fmt(data.output.net_sales) },
              { label: `מע"מ עסקאות (פלט) ${data.vat_rate}%`, val: fmt(data.output.output_vat), bold: true },
              { label: `סה"כ חשבוניות ספקים (${data.input.invoice_count})`, val: fmt(data.input.gross_purchases) },
              { label: `מע"מ תשומות — חשבוניות`, val: fmt(data.input.input_vat_invoices), bold: true },
              { label: `מע"מ תשומות — הוצאות קבועות`, val: fmt(data.input.input_vat_expenses), bold: true },
              { label: `סה"כ מע"מ תשומות`, val: fmt(data.input.total_input_vat), bold: true },
              {
                label: data.payable ? 'צפי יתרה לתשלום' : 'צפי יתרה להחזר',
                val: fmt(Math.abs(data.net_vat)),
                bold: true, highlight: true,
              },
            ].map((r, i) => (
              <div key={i} className={`flex justify-between py-2 border-b border-[rgba(201,162,39,0.08)] last:border-0`}>
                <span className={`text-sm ${r.highlight ? (data.payable ? 'text-red-400 font-bold' : 'text-green-400 font-bold') : 'text-[rgba(232,232,228,0.6)]'}`}>{r.label}</span>
                <span className={`text-sm ${r.bold ? 'font-bold' : ''} ${r.highlight ? (data.payable ? 'text-red-400' : 'text-green-400') : 'text-[rgba(232,232,228,0.75)]'}`}>{r.val}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
