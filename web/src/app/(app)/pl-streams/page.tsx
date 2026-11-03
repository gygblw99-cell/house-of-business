'use client';

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { UtensilsCrossed, Bike, ShoppingBag, RefreshCw, Info } from 'lucide-react';
import { financeApi } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import type { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// Lazy-load recharts (~200 KB) — not needed for initial paint
const RechartsBarChart    = dynamic(() => import('recharts').then(m => m.BarChart),          { ssr: false }) as typeof BarChart;
const RechartsBar         = dynamic(() => import('recharts').then(m => m.Bar),               { ssr: false }) as typeof Bar;
const RechartsXAxis       = dynamic(() => import('recharts').then(m => m.XAxis),             { ssr: false }) as typeof XAxis;
const RechartsYAxis       = dynamic(() => import('recharts').then(m => m.YAxis),             { ssr: false }) as typeof YAxis;
const RechartsTooltip     = dynamic(() => import('recharts').then(m => m.Tooltip),           { ssr: false }) as typeof Tooltip;
const RechartsContainer   = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false }) as typeof ResponsiveContainer;
const RechartsLegend      = dynamic(() => import('recharts').then(m => m.Legend),            { ssr: false }) as typeof Legend;
const RechartsCell        = dynamic(() => import('recharts').then(m => m.Cell),              { ssr: false }) as typeof Cell;

interface StreamData { label: string; revenue: number; tx_count: number; share_pct: number; }
interface PlatformFee { revenue: number; fee: number; pct: number; }
interface MonthData {
  month: string; month_label: string;
  streams: Record<string, { label: string; revenue: number; tx_count: number }>;
  total_revenue: number; total_cogs: number; cogs_is_estimated?: boolean; cogs_config_error?: boolean; total_labor: number;
  delivery_fees: number; platform_fees: { wolt: PlatformFee; ten_bis: PlatformFee; other: PlatformFee };
  total_cost: number; gross_profit_before_fees: number; gross_profit: number; margin_pct: number;
}

const STREAM_COLORS: Record<string, string> = {
  table:    '#4ade80',
  delivery: '#60a5fa',
  takeaway: '#fbbf24',
};
const STREAM_ICONS: Record<string, typeof UtensilsCrossed> = {
  table:    UtensilsCrossed,
  delivery: Bike,
  takeaway: ShoppingBag,
};

export default function PLStreamsPage() {
  const { toast } = useAppDialog();
  const [data, setData]       = useState<{
    byMonth: MonthData[]; streamTotals: Record<string, StreamData>; months: number;
    delivery_fee_pct: number; wolt_commission_pct: number; ten_bis_commission_pct: number;
    z_report_includes_delivery_platforms: boolean;
  } | null>(null);
  const [months, setMonths]   = useState(3);
  const [loading, setLoading] = useState(true);
  const [view, setView]       = useState<'table' | 'chart'>('chart');

  const beginRequest = useLatestRequest();

  const load = useCallback((m = months) => {
    const latest = beginRequest();
    setLoading(true);
    financeApi.plStreams(m)
      .then(r => latest(() => setData(r.data)))
      .catch((err) => latest(() => { setData(null); toast(getErrorMessage(err) || 'שגיאה בטעינת נתוני P&L', 'error'); }))
      .finally(() => latest(() => setLoading(false)));
  }, [months, toast, beginRequest]);

  useEffect(() => { load(); }, [load]);
  // מבוסס מכירות/חשבוניות/שכר — מתעדכן כשמכירה/הוצאה/משמרת משתנה
  useSyncEvent(['dashboard.refresh', 'finance.updated', 'shift_closed'], () => load());

  const chartData = (data?.byMonth || []).map(m => ({
    name: m.month_label.replace(' ', '\n'),
    ישיבה:   m.streams.table?.revenue    || 0,
    משלוחים: m.streams.delivery?.revenue || 0,
    איסוף:   m.streams.takeaway?.revenue || 0,
    רווח:    m.gross_profit,
  }));

  const totalRevenue          = data?.byMonth.reduce((s, m) => s + m.total_revenue, 0) || 0;
  const totalProfit           = data?.byMonth.reduce((s, m) => s + m.gross_profit, 0) || 0;
  const totalProfitBeforeFees = data?.byMonth.reduce((s, m) => s + m.gross_profit_before_fees, 0) || 0;
  const totalWoltFees   = data?.byMonth.reduce((s, m) => s + (m.platform_fees?.wolt.fee || 0), 0) || 0;
  const totalTenBisFees = data?.byMonth.reduce((s, m) => s + (m.platform_fees?.ten_bis.fee || 0), 0) || 0;
  const totalWoltRevenue   = data?.byMonth.reduce((s, m) => s + (m.platform_fees?.wolt.revenue || 0), 0) || 0;
  const totalTenBisRevenue = data?.byMonth.reduce((s, m) => s + (m.platform_fees?.ten_bis.revenue || 0), 0) || 0;
  const avgMargin     = data?.byMonth.length
    ? (data.byMonth.reduce((s, m) => s + m.margin_pct, 0) / data.byMonth.length).toFixed(1)
    : '0';

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">P&L לפי ערוץ מכירה</h1>
          <p className="text-sm opacity-60 mt-0.5">ניתוח רווח והפסד — ישיבה במקום, משלוחים, איסוף עצמי</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[1,3,6,12].map(m => (
            <button key={m} onClick={() => { setMonths(m); load(m); }}
              className="px-3 py-1.5 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: months === m ? 'rgba(201,162,39,0.15)' : 'transparent',
                border: `1px solid ${months === m ? 'rgba(201,162,39,0.4)' : 'var(--card-border-color)'}`,
                color: months === m ? '#c9a227' : undefined,
              }}>
              {m} חודש{m > 1 ? 'ים' : ''}
            </button>
          ))}
          <button onClick={() => setView(v => v === 'chart' ? 'table' : 'chart')}
            className="px-3 py-1.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border-color)' }}>
            {view === 'chart' ? 'טבלה' : 'גרף'}
          </button>
          <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'סה"כ הכנסות', value: formatCurrency(totalRevenue), color: '#4ade80' },
          { label: 'רווח גולמי', value: formatCurrency(totalProfit), color: totalProfit >= 0 ? '#4ade80' : '#f87171' },
          { label: 'מרווח ממוצע', value: `${avgMargin}%`, color: parseFloat(avgMargin) >= 20 ? '#4ade80' : '#f87171' },
          { label: 'ערוצי מכירה', value: Object.keys(data?.streamTotals || {}).length || '—', color: '#c9a227' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl p-4"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
            <p className="text-xs opacity-60 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Stream totals */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(data.streamTotals).map(([key, s]) => {
            const Icon  = STREAM_ICONS[key] || ShoppingBag;
            const color = STREAM_COLORS[key] || '#94a3b8';
            return (
              <div key={key} className="rounded-2xl p-4 flex items-center gap-4"
                style={{ background: 'var(--card-bg)', border: `1px solid ${color}33` }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `${color}20` }}>
                  <Icon className="w-6 h-6" style={{ color }} />
                </div>
                <div>
                  <p className="font-bold">{s.label}</p>
                  <p className="text-xl font-black" style={{ color }}>{formatCurrency(s.revenue)}</p>
                  <p className="text-xs opacity-50">{s.share_pct}% מסה"כ · {s.tx_count} עסקאות</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Platform commissions — before/after the fee each company takes */}
      {data && (totalWoltRevenue > 0 || totalTenBisRevenue > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>עמלות פלטפורמות — רווח לפני ואחרי</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {[
                { label: 'וולט', revenue: totalWoltRevenue, fee: totalWoltFees, pct: data.wolt_commission_pct },
                { label: 'תן ביס', revenue: totalTenBisRevenue, fee: totalTenBisFees, pct: data.ten_bis_commission_pct },
              ].filter(p => p.revenue > 0).map(p => (
                <div key={p.label} className="rounded-xl p-3" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
                  <p className="font-bold text-sm">{p.label}</p>
                  <p className="text-xs opacity-60 mt-1">הכנסה: {formatCurrency(p.revenue)}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#f87171' }}>עמלה ({p.pct}%): −{formatCurrency(p.fee)}</p>
                  <p className="text-sm font-bold mt-1" style={{ color: '#4ade80' }}>נטו: {formatCurrency(p.revenue - p.fee)}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: 'var(--card-border-color)' }}>
              <span className="text-sm opacity-70">רווח לפני עמלות פלטפורמה</span>
              <span className="font-bold">{formatCurrency(totalProfitBeforeFees)}</span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-sm font-bold">רווח נקי אחרי עמלות</span>
              <span className="text-lg font-black" style={{ color: totalProfit >= 0 ? '#4ade80' : '#f87171' }}>{formatCurrency(totalProfit)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="h-64 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />
      ) : !data?.byMonth.length ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <Info className="w-10 h-10 mx-auto mb-3" />
            <p>אין נתוני מכירות לתקופה שנבחרה</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {view === 'chart' && (
            <Card>
              <CardHeader>
                <CardTitle>הכנסות לפי ערוץ — גרף חודשי</CardTitle>
              </CardHeader>
              <CardContent>
                <RechartsContainer width="100%" height={280}>
                  <RechartsBarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <RechartsXAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <RechartsYAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `₪${(v/1000).toFixed(0)}K`} />
                    <RechartsTooltip formatter={(v) => formatCurrency(v as number)} />
                    <RechartsLegend />
                    <RechartsBar dataKey="ישיבה"   fill={STREAM_COLORS.table}    radius={[4,4,0,0]} />
                    <RechartsBar dataKey="משלוחים" fill={STREAM_COLORS.delivery}  radius={[4,4,0,0]} />
                    <RechartsBar dataKey="איסוף"   fill={STREAM_COLORS.takeaway}  radius={[4,4,0,0]} />
                  </RechartsBarChart>
                </RechartsContainer>
              </CardContent>
            </Card>
          )}

          {view === 'table' && (
            <Card>
              <CardHeader><CardTitle>פירוט חודשי מלא</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--card-border-color)' }}>
                      {['חודש','הכנסות','עלות סחורה','שכר עבודה','עמלות משלוח','סה"כ עלויות','רווח גולמי','מרווח %'].map(h => (
                        <th key={h} className="px-4 py-3 text-right text-xs font-semibold opacity-50">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byMonth.map(m => (
                      <tr key={m.month} className="hover:bg-white/5 transition-colors"
                        style={{ borderBottom: '1px solid var(--card-border-color)' }}>
                        <td className="px-4 py-3 font-semibold">{m.month_label}</td>
                        <td className="px-4 py-3 text-green-400 font-bold">{formatCurrency(m.total_revenue)}</td>
                        <td className="px-4 py-3 text-red-400">
                          {m.cogs_config_error ? (
                            <span className="text-amber-400 text-xs" title="עלות מזון תיאורטית חרגה מ-200% מההכנסות — כנראה טעות ביחידות/כמויות במתכון, לא נתון עסקי אמיתי">
                              ⚠️ בדוק הגדרת מתכונים
                            </span>
                          ) : (
                            <>
                              {formatCurrency(m.total_cogs)}
                              {m.cogs_is_estimated && <span className="opacity-50 text-xs mr-1">(הערכה)</span>}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-3 text-orange-400">{formatCurrency(m.total_labor)}</td>
                        <td className="px-4 py-3 text-blue-400">{formatCurrency(m.delivery_fees)}</td>
                        <td className="px-4 py-3 opacity-70">{formatCurrency(m.total_cost)}</td>
                        <td className="px-4 py-3 font-bold" style={{ color: m.gross_profit >= 0 ? '#4ade80' : '#f87171' }}>
                          {formatCurrency(m.gross_profit)}
                        </td>
                        <td className="px-4 py-3 font-bold" style={{ color: m.margin_pct >= 20 ? '#4ade80' : '#f87171' }}>
                          {m.margin_pct}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Delivery fee note */}
          <p className="text-xs opacity-40 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" />
            וולט: {data?.wolt_commission_pct}% · תן ביס: {data?.ten_bis_commission_pct}% · שאר ערוצי המשלוח: {data?.delivery_fee_pct}%
            {' — '}<Link href="/settings?tab=platforms" className="underline hover:opacity-80">עדכן בהגדרות</Link>
          </p>
          {data?.z_report_includes_delivery_platforms && (
            <p className="text-xs opacity-40 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5" />
              הכנסות משלוחים נספרות מדוח ה-Z בלבד (מוגדר בהגדרות שהקופה כבר כוללת אותן) — למניעת ספירה כפולה
            </p>
          )}
        </>
      )}
    </div>
  );
}
