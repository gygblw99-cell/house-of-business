'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Siren, AlertTriangle,
  CheckCircle, ChevronDown, ChevronUp, Loader2,
  Flame, ShieldAlert, Scissors, Star } from 'lucide-react';
import { dashboardApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { formatCurrency } from '@/lib/utils';
import Link from 'next/link';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ── Types ──────────────────────────────────────────────────────────────────────
interface SurvivalData {
  score: number;
  // 'unverified' = the score itself looks healthy, but it rests on an estimated
  // cost of goods (few or no supplier invoices for the period). Missing invoices
  // always push the score UP, so the business that enters the least data scores
  // the highest — this state exists so the screen can say that out loud.
  status: 'healthy' | 'warning' | 'critical' | 'no_data' | 'unverified';
  days: number;
  dataQuality?: {
    zDaysInPeriod: number;
    reliable: boolean;
    warning: string | null;
    cogsBasis?: string | null;
    cogsReliable?: boolean;
  };
  financial: {
    revenue: number; foodCost: number; grossProfit: number;
    grossMargin: number; netProfit: number; totalExpenses: number;
  };
  profitableDishes: { id: string; name: string; margin_pct: number; qty_sold: number; profit_contribution: number; selling_price: number; dataWarning?: string | null }[];
  damagingDishes:   { id: string; name: string; margin_pct: number; qty_sold: number; profit_contribution: number; selling_price: number; dataWarning?: string | null }[];
  actions: { priority: 'critical' | 'high' | 'medium' | 'low'; icon: string; title: string; detail: string }[];
  potentialSaving: number;
}

// ── Score Ring ─────────────────────────────────────────────────────────────────
function ScoreRing({ score, status }: { score: number; status: string }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const noData = status === 'no_data';
  // A brand-new business with zero sales history gets a neutral empty ring
  // and a dash instead of "100/100" — a full green ring reads as "perfect
  // health," which is just as misleading as a red "critical" 0 would be.
  const dash = noData ? 0 : circ * (score / 100);

  // 'unverified' must be handled explicitly. Falling through to the final
  // branch painted it red "קריטי" while the surrounding card stayed green —
  // and neither is right: the number isn't alarming, it's unconfirmed.
  const unverified = status === 'unverified';
  const color = status === 'healthy' ? '#22c55e'
              : status === 'warning' ? '#f59e0b'
              : unverified ? '#94a3b8'
              : noData ? '#94a3b8' : '#ef4444';
  const label = status === 'healthy' ? 'בריא'
              : status === 'warning' ? 'דורש תשומת לב'
              : unverified ? 'לא מאומת'
              : noData ? 'אין עדיין נתונים' : 'קריטי';

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-36 h-36">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="#e5e7eb" strokeWidth="10" />
          <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 1s ease' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-black" style={{ color }}>{noData ? '–' : score}</span>
          <span className="text-xs text-slate-500 font-medium">/ 100</span>
        </div>
      </div>
      <span className="mt-2 text-sm font-bold px-3 py-1 rounded-full"
        style={{ background: `${color}20`, color }}>
        {label}
      </span>
    </div>
  );
}

// ── Action Card ────────────────────────────────────────────────────────────────
function ActionCard({ action }: { action: SurvivalData['actions'][0] }) {
  const [open, setOpen] = useState(false);

  const colors = {
    critical: { bg: '#fef2f2', border: '#fca5a5', badge: '#dc2626', text: '#7f1d1d' },
    high:     { bg: '#fffbeb', border: '#fcd34d', badge: '#d97706', text: '#78350f' },
    medium:   { bg: '#eff6ff', border: '#bfdbfe', badge: '#2563eb', text: '#1e3a8a' },
    low:      { bg: '#f0fdf4', border: '#bbf7d0', badge: '#16a34a', text: '#14532d' },
  };
  const c = colors[action.priority] || colors.low;
  const priorityLabel = { critical: 'דחוף מאוד', high: 'דחוף', medium: 'בינוני', low: 'מומלץ' };

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: c.bg, borderColor: c.border }}>
      <button className="w-full flex items-center gap-3 p-4 text-right" onClick={() => setOpen(v => !v)}>
        <span className="text-2xl flex-shrink-0">{action.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-sm" style={{ color: c.text }}>{action.title}</p>
            <span className="text-xs px-2 py-0.5 rounded-full font-bold text-white flex-shrink-0"
              style={{ background: c.badge }}>
              {priorityLabel[action.priority]}
            </span>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 flex-shrink-0 text-slate-400" />
               : <ChevronDown className="w-4 h-4 flex-shrink-0 text-slate-400" />}
      </button>
      {open && (
        <div className="px-4 pb-4">
          <p className="text-sm text-slate-700 leading-relaxed border-t pt-3"
            style={{ borderColor: c.border }}>{action.detail}</p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function SurvivalModePage() {
  const [data, setData]     = useState<SurvivalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays]     = useState(30);

  const beginRequest = useLatestRequest();

  const load = useCallback(() => {
    const latest = beginRequest();
    setLoading(true);
    dashboardApi.survivalMode(days)
      .then(r => latest(() => setData(r.data)))
      .catch(() => latest(() => setData(null)))
      .finally(() => latest(() => setLoading(false)));
  }, [days, beginRequest]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['dashboard.refresh', 'inventory.updated'], load);

  return (
    <div className="space-y-6" dir="rtl">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg,#dc2626,#ef4444)' }}>
            <Siren className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">מצב הישרדות</h1>
            <p className="text-xs text-slate-500">ניתוח בריאות עסקית + תוכנית פעולה דחופה</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 60].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={days === d
                ? { background: '#dc2626', color: 'white' }
                : { background: '#fef2f2', color: '#dc2626' }}>
              {d} ימים
            </button>
          ))}
        </div>
      </div>


      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-red-400" />
        </div>
      )}

      {!loading && !data && (
        <div className="text-center py-16 text-slate-400">
          <ShieldAlert className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">לא ניתן לטעון נתונים</p>
        </div>
      )}

      {!loading && data && (
        <>
          {/* ── Data Quality Warning ── */}
          {data.dataQuality?.warning && (
            <div className="rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#b91c1c' }}>
              <span>⚠️</span>
              <span>{data.dataQuality.warning}</span>
              <span className="opacity-60 text-xs mr-auto">מבוסס על {data.dataQuality.zDaysInPeriod} ימי Z-report</span>
            </div>
          )}

          {/* ── Score + Financial KPIs ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

            {/* Score card */}
            <div className="rounded-2xl p-6 flex items-center gap-6"
              /* 'unverified' shares the neutral grey of 'no_data' rather than
                 the green default — a green card around a "לא מאומת" ring is
                 the reassuring reading this state exists to avoid. */
              style={{ background: data.status === 'critical' ? '#fef2f2' : data.status === 'warning' ? '#fffbeb' : (data.status === 'no_data' || data.status === 'unverified') ? '#f8fafc' : '#f0fdf4',
                       border: `1px solid ${data.status === 'critical' ? '#fca5a5' : data.status === 'warning' ? '#fcd34d' : (data.status === 'no_data' || data.status === 'unverified') ? '#e2e8f0' : '#bbf7d0'}` }}>
              <ScoreRing score={data.score} status={data.status} />
              <div>
                <p className="text-sm font-semibold text-slate-600 mb-3">סיכום {days} ימים</p>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">הכנסות</span>
                    <span className="font-bold text-slate-800">{formatCurrency(data.financial.revenue)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">עלות מזון</span>
                    <span className="font-bold text-orange-600">{formatCurrency(data.financial.foodCost)}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-500">רווח גולמי</span>
                    <span className={`font-bold ${data.financial.grossProfit >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                      {formatCurrency(data.financial.grossProfit)} ({data.financial.grossMargin}%)
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 border-t pt-1.5">
                    <span className="text-slate-500">רווח נקי</span>
                    <span className={`font-black text-base ${data.financial.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {formatCurrency(data.financial.netProfit)}
                    </span>
                  </div>
                </div>
                {data.potentialSaving > 0 && (
                  <p className="mt-3 text-xs font-semibold text-emerald-700 bg-emerald-100 px-3 py-1.5 rounded-lg">
                    💡 חיסכון פוטנציאלי: {formatCurrency(data.potentialSaving)}
                  </p>
                )}
              </div>
            </div>

            {/* Action plan */}
            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
              <div className="flex items-center gap-2 mb-1">
                <Flame className="w-5 h-5 text-red-500" />
                <h2 className="font-bold" style={{ color: '#e8e8e4' }}>תוכנית פעולה דחופה</h2>
              </div>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {data.actions.map((action, i) => (
                  <ActionCard key={i} action={action} />
                ))}
              </div>
            </div>
          </div>

          {/* ── Dishes ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

            {/* Profitable dishes */}
            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <div className="flex items-center gap-2">
                <Star className="w-5 h-5 text-emerald-600" />
                <h2 className="font-bold text-emerald-800">מנות מצילות — התמקד בהן</h2>
              </div>
              {data.profitableDishes.length === 0 ? (
                <p className="text-sm text-emerald-700 opacity-70">אין נתוני מנות — קשר מרכיבים למנות</p>
              ) : (
                <div className="space-y-2">
                  {data.profitableDishes.map((d, i) => (
                    <div key={d.id} className="rounded-xl px-4 py-2.5" style={{ background: 'rgba(22,163,74,0.1)', border: '1px solid rgba(22,163,74,0.25)' }}>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-black text-emerald-500 w-5 flex-shrink-0">#{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{d.name}</p>
                          <p className="text-xs" style={{ color: '#9aa0ab' }}>{d.qty_sold} מכירות · ₪{d.selling_price}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-black text-emerald-400">{d.margin_pct?.toFixed(0)}%</p>
                          <p className="text-xs" style={{ color: '#9aa0ab' }}>מרג'ין</p>
                        </div>
                      </div>
                      {/* Fake-100%-margin warning (zero cost data) — the exact
                          issue that must never be shown as a real high-margin
                          opportunity to "focus on this dish." */}
                      {d.dataWarning && (
                        <p className="text-xs mt-1.5 pt-1.5 border-t" style={{ color: '#fbbf24', borderColor: 'rgba(251,191,36,0.25)' }}>
                          ⚠️ {d.dataWarning}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Damaging dishes */}
            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: '#fef2f2', border: '1px solid #fca5a5' }}>
              <div className="flex items-center gap-2">
                <Scissors className="w-5 h-5 text-red-500" />
                <h2 className="font-bold text-red-800">מנות מזיקות — שקול להסיר</h2>
              </div>
              {data.damagingDishes.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle className="w-4 h-4" />
                  <span>אין מנות בעייתיות — מצוין!</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.damagingDishes.map((d) => (
                    <div key={d.id} className="rounded-xl px-4 py-2.5" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' }}>
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{d.name}</p>
                          <p className="text-xs" style={{ color: '#9aa0ab' }}>{d.qty_sold} מכירות · ₪{d.selling_price}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-black text-red-400">{d.margin_pct?.toFixed(0)}%</p>
                          <p className="text-xs" style={{ color: '#9aa0ab' }}>מרג'ין</p>
                        </div>
                      </div>
                      {d.dataWarning && (
                        <p className="text-xs mt-1.5 pt-1.5 border-t" style={{ color: '#fbbf24', borderColor: 'rgba(251,191,36,0.25)' }}>
                          ⚠️ {d.dataWarning}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Quick links ── */}
          <div className="flex flex-wrap gap-3">
            <Link href="/menu-engineering"
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#a855f7)' }}>
              🍽️ הנדסת תפריט מלאה
            </Link>
            <Link href="/profit-leak"
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#dc2626,#ef4444)' }}>
              💧 דליפות רווח
            </Link>
            <Link href="/recipes"
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#d97706,#f59e0b)' }}>
              📋 עריכת מחירים
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
