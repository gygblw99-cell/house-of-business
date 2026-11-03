'use client';

import { useEffect, useState } from 'react';
import { Receipt, RefreshCw, Download } from 'lucide-react';
import { vatApi } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { formatCurrency, getErrorMessage, getBiMonthlyPeriodStartMonth, downloadBlob } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface VatReport {
  period: { year: number; month: number; period: number; month_end: number; start_date: string; end_date: string };
  output: {
    gross_sales: number; net_sales: number; output_vat: number; tx_count: number;
    by_type: { sale_type: string; gross: number; vat: number }[];
  };
  input: {
    gross_purchases: number; net_purchases: number;
    input_vat_invoices: number; input_vat_expenses: number; total_input_vat: number;
    invoice_count: number;
    // Invoices whose VAT was derived from the standard rate because the invoice
    // itself didn't carry one — wrong for anything zero-rated (fresh produce).
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
  is_estimate?: boolean;
}

const SALE_TYPE_LABELS: Record<string, string> = {
  table: 'ישיבה', delivery: 'משלוח', takeaway: 'טייק אווי', bar: 'בר',
};
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

export default function VatTab() {
  const { toast } = useAppDialog();
  const now = new Date();
  const [year, setYear]     = useState(now.getFullYear());
  const [month, setMonth]   = useState(now.getMonth() + 1);
  const [period, setPeriod] = useState<1 | 2>(1);
  const [data, setData]     = useState<VatReport | null>(null);
  const [loading, setLoading] = useState(false);

  const beginRequest = useLatestRequest();

  const load = () => {
    const latest = beginRequest();
    setLoading(true);
    vatApi.report({ year, month, period })
      .then((r) => latest(() => setData(r.data as VatReport)))
      .catch((err) => latest(() => { setData(null); toast(getErrorMessage(err) || 'שגיאה בטעינת צפי המע"מ', 'error'); }))
      .finally(() => latest(() => setLoading(false)));
  };

  const exportExcel = async () => {
    if (!data) return;
    try {
      const res = await vatApi.exportExcel({ year, month, period });
      downloadBlob(new Blob([res.data as BlobPart]), `מעמ-${year}-${String(month).padStart(2, '0')}.xlsx`);
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  useEffect(() => { load(); }, [year, month, period]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bi-monthly periods are fixed legal pairs (Jan-Feb, Mar-Apr, ...) — mirror
  // the backend's normalization so the label always matches the data shown.
  const periodStartMonth = period === 2 ? getBiMonthlyPeriodStartMonth(month) : month;
  const periodLabel = period === 1
    ? `${MONTHS[month - 1]} ${year}`
    : `${MONTHS[periodStartMonth - 1]}–${MONTHS[periodStartMonth]} ${year}`;

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Receipt className="w-5 h-5" style={{ color: '#c9a227' }} />
            צפי מע&quot;מ
          </h2>
          <p className="text-sm opacity-60 mt-0.5">אומדן לתכנון תזרים — והנתונים מוכנים לרואה החשבון</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Was window.print(). The point of this screen is to hand the period
              over to whoever files it, so the button now produces the file. */}
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!data}>
            <Download className="w-4 h-4" /> ייצא לרו&quot;ח
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap p-4 rounded-2xl"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
        <div className="flex items-center gap-2">
          <label className="text-xs opacity-60">שנה:</label>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="px-3 py-1.5 rounded-xl text-sm"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border-color)' }}>
            {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs opacity-60">חודש:</label>
          <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
            className="px-3 py-1.5 rounded-xl text-sm"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border-color)' }}>
            {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs opacity-60">תקופה:</label>
          <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid var(--card-border-color)' }}>
            {([1, 2] as const).map(p => (
              <button key={p} onClick={() => setPeriod(p)}
                className="px-3 py-1.5 text-sm font-semibold transition-all"
                style={{ background: period === p ? 'rgba(201,162,39,0.15)' : 'transparent', color: period === p ? '#c9a227' : undefined }}>
                {p === 1 ? 'חודשי' : 'דו-חודשי'}
              </button>
            ))}
          </div>
        </div>
        <span className="text-sm font-semibold opacity-70 mr-auto">{periodLabel}</span>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <div key={i} className="h-32 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : data && (
        <>
          {/* Net VAT banner */}
          <div className="rounded-2xl p-6 text-center"
            style={{
              background: data.payable ? 'rgba(239,68,68,0.08)' : 'rgba(74,222,128,0.08)',
              border: `1px solid ${data.payable ? 'rgba(239,68,68,0.25)' : 'rgba(74,222,128,0.25)'}`,
            }}>
            {/* Was "מע\"מ לתשלום לרשות המסים" — which reads as the amount to
                file. It's an estimate from this system's data only; the filing
                is the accountant's. Reframed as cash planning, which is the
                part the accountant genuinely can't provide: they tell you what
                you owe after the period, not during it. */}
            <p className="text-xs opacity-60 mb-1">{data.payable ? 'צפי מע"מ לתשלום' : 'צפי מע"מ להחזר'}</p>
            <p className="text-4xl font-black" style={{ color: data.payable ? '#f87171' : '#4ade80' }}>
              {formatCurrency(Math.abs(data.net_vat))}
            </p>
            <p className="text-xs opacity-40 mt-1">
              מע&quot;מ עסקאות {formatCurrency(data.output.output_vat)} — מע&quot;מ תשומות {formatCurrency(data.input.total_input_vat)}
            </p>
            {/* This figure is computed from the data in the system, not filed.
                It was previously presented at 4xl with no caveat at all. */}
            <p className="text-[11px] opacity-40 mt-2 leading-relaxed max-w-lg mx-auto">
              אומדן לתכנון תזרים, לא סכום להגשה. הדיווח בפועל נעשה על ידי רואה החשבון, שרואה גם נתונים
              שאינם במערכת. מע&quot;מ תשומות מקוזז רק מהוצאות שסומנו כמגיעות עם חשבונית מס.
            </p>
          </div>

          {/* Expenses whose VAT status nobody has decided. Deliberately excluded
              from the claim above — over-claiming input VAT is a debt to the Tax
              Authority, under-claiming is only money left on the table — but the
              owner has to be told it's sitting there and how to release it. */}
          {!!data.input.expenses_breakdown?.unknown_count && (
            <div className="rounded-2xl p-4"
              style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.28)' }}>
              <div className="flex items-start gap-3">
                <span className="text-lg leading-none mt-0.5">⚠️</span>
                <div className="text-sm leading-relaxed flex-1 min-w-0">
                  <p className="font-semibold">
                    {formatCurrency(data.input.expenses_breakdown.unknown)} בהוצאות שלא סומן לגביהן אם מגיעה חשבונית מס
                  </p>
                  <p className="opacity-70 text-xs mt-1">
                    לא קיזזנו מהן מע&quot;מ. אם לכולן יש חשבונית מס, יש כאן עוד
                    <strong> {formatCurrency(data.input.expenses_breakdown.potential_extra_vat)} </strong>
                    מע&quot;מ תשומות לקזז. סמן כל הוצאה במסך ההוצאות הקבועות.
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {data.input.expenses_breakdown.unknown_items.map(it => (
                      <span key={it.name} className="text-[11px] px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(245,158,11,0.14)' }}>
                        {it.name} · {formatCurrency(it.amount)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Two more ways the number above can be softer than it looks. */}
          {(!!data.input.unapproved_count || !!data.input.invoices_vat_derived) && (
            <div className="rounded-2xl p-3 text-xs opacity-70 space-y-1"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
              {!!data.input.unapproved_count && (
                <p>
                  {data.input.unapproved_count} חשבוניות ({formatCurrency(data.input.unapproved_amount || 0)}) עדיין לא אושרו
                  ידנית — הן כלולות בחישוב, אך מבוססות על קריאת OCR שלא נבדקה.
                </p>
              )}
              {!!data.input.invoices_vat_derived && (
                <p>
                  ב-{data.input.invoices_vat_derived} חשבוניות לא נקרא סכום מע&quot;מ, והוא חושב לפי {data.vat_rate}% —
                  לא מדויק עבור פריטים בשיעור אפס (למשל פירות וירקות טריים).
                </p>
              )}
            </div>
          )}

          {/* Output / Input */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
              <h3 className="font-bold text-sm opacity-80">מע&quot;מ עסקאות (פלט)</h3>
              <div className="space-y-2">
                {[
                  { label: 'מחזור ברוטו (כולל מע"מ)', value: formatCurrency(data.output.gross_sales) },
                  { label: 'מחזור נטו (ללא מע"מ)',    value: formatCurrency(data.output.net_sales), muted: true },
                  { label: `מע"מ עסקאות (${data.vat_rate}%)`, value: formatCurrency(data.output.output_vat), bold: true, color: '#fbbf24' },
                  { label: 'מספר עסקאות',              value: data.output.tx_count.toLocaleString('he-IL') },
                ].map(({ label, value, muted, bold, color }) => (
                  <div key={label} className="flex justify-between items-center text-sm">
                    <span className={muted ? 'opacity-50 text-xs' : ''}>{label}</span>
                    <span className={bold ? 'font-black text-base' : 'font-semibold'} style={color ? { color } : undefined}>{value}</span>
                  </div>
                ))}
              </div>
              {data.output.by_type.length > 0 && (
                <div className="pt-3 border-t" style={{ borderColor: 'var(--card-border-color)' }}>
                  <p className="text-xs opacity-40 mb-2">פירוט לפי ערוץ</p>
                  {data.output.by_type.map(t => (
                    <div key={t.sale_type} className="flex justify-between text-xs py-1">
                      <span className="opacity-60">{SALE_TYPE_LABELS[t.sale_type] || t.sale_type}</span>
                      <span>{formatCurrency(t.vat)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
              <h3 className="font-bold text-sm opacity-80">מע&quot;מ תשומות (קלט)</h3>
              <div className="space-y-2">
                {[
                  { label: 'חשבוניות ספקים (ברוטו)', value: formatCurrency(data.input.gross_purchases) },
                  { label: 'חשבוניות ספקים (נטו)',   value: formatCurrency(data.input.net_purchases), muted: true },
                  { label: 'מע"מ על חשבוניות',       value: formatCurrency(data.input.input_vat_invoices) },
                  { label: 'מע"מ על הוצאות קבועות',  value: formatCurrency(data.input.input_vat_expenses) },
                  ...(data.input.expenses_breakdown ? [
                    { label: 'מתוך הוצאות עם חשבונית מס', value: formatCurrency(data.input.expenses_breakdown.vat_bearing), muted: true },
                    { label: 'הוצאות ללא מע"מ (ארנונה, ביטוח וכו׳)', value: formatCurrency(data.input.expenses_breakdown.no_vat), muted: true },
                  ] : []),
                  { label: 'סה"כ מע"מ תשומות',       value: formatCurrency(data.input.total_input_vat), bold: true, color: '#4ade80' },
                  { label: 'מספר חשבוניות',           value: data.input.invoice_count.toLocaleString('he-IL') },
                ].map(({ label, value, muted, bold, color }) => (
                  <div key={label} className="flex justify-between items-center text-sm">
                    <span className={muted ? 'opacity-50 text-xs' : ''}>{label}</span>
                    <span className={bold ? 'font-black text-base' : 'font-semibold'} style={color ? { color } : undefined}>{value}</span>
                  </div>
                ))}
              </div>
              <div className="pt-3 border-t text-xs opacity-40" style={{ borderColor: 'var(--card-border-color)' }}>
                * הוצאות קבועות מסומנות עם מע&quot;מ בלבד
              </div>
            </div>
          </div>

          {/* Accountant summary */}
          <div className="rounded-2xl p-4 text-xs space-y-1"
            style={{ background: 'rgba(201,162,39,0.05)', border: '1px solid rgba(201,162,39,0.2)' }}>
            {/* "סיכום לדוח לרשות המסים" implied this block WAS the return.
                It's the handoff to whoever files it. */}
            <p className="font-semibold opacity-60 mb-2">נתונים לרואה החשבון — {periodLabel}</p>
            <p>עסקאות חייבות במע&quot;מ: <strong>{formatCurrency(data.output.gross_sales)}</strong></p>
            <p>מע&quot;מ עסקאות: <strong>{formatCurrency(data.output.output_vat)}</strong></p>
            <p>מע&quot;מ תשומות: <strong>{formatCurrency(data.input.total_input_vat)}</strong></p>
            <p className="font-bold pt-1">
              {data.payable
                ? `צפי מע"מ לתשלום: ${formatCurrency(data.net_vat)}`
                : `צפי מע"מ לקבל: ${formatCurrency(Math.abs(data.net_vat))}`}
            </p>
            <p className="opacity-50 pt-1">
              נתוני המערכת בלבד — לאימות ולהשלמה מול רואה החשבון לפני הגשה.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
