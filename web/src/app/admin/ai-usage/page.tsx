'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, DollarSign, Building2, RefreshCw, ChevronDown, ChevronUp, Trophy, TrendingDown, Calendar } from 'lucide-react';
import { adminFetch } from '@/lib/adminClient';


interface Feature {
  feature: string;
  model: string;
  total_tokens: number;
  cost_usd: number;
  calls: number;
}

interface Business {
  business_id: string;
  business_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_calls: number;
  last_used_at: string | null;
  features: Feature[];
}

interface GrandTotal {
  total_tokens: number;
  total_cost_usd: number;
  total_calls: number;
  total_businesses: number;
}

interface AIUsageData {
  businesses: Business[];
  grand_total: GrandTotal;
  daily: Array<{ day: string; total_tokens: number; total_cost_usd: number }>;
  days: number;
}

function formatNumber(n: number) {
  return n >= 1_000_000
    ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000
    ? (n / 1_000).toFixed(1) + 'K'
    : Math.round(n).toString();
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

const FEATURE_LABELS: Record<string, string> = {
  business_audit:   'ביקורת עסקית',
  invoice_ocr:      'סריקת חשבוניות',
  ai_advisor:       'יועץ AI',
  marketing:        'שיווק דיגיטלי',
  reviews:          'ניתוח ביקורות',
  chef_chat:        'שף AI — שיחה',
  chef_advise:      'שף AI — ייעוץ',
};

function featureLabel(f: string) {
  return FEATURE_LABELS[f] || f;
}

const FEATURE_COLORS: Record<string, string> = {
  business_audit:  '#f59e0b',
  invoice_ocr:     '#3b82f6',
  ai_advisor:      '#8b5cf6',
  marketing:       '#ec4899',
  reviews:         '#10b981',
  chef_chat:       '#f97316',
  chef_advise:     '#06b6d4',
};

function featureColor(f: string) {
  return FEATURE_COLORS[f] || '#94a3b8';
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: color + '20' }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <p className="text-2xl font-black text-slate-800">{value}</p>
      <p className="text-sm font-medium text-slate-500 mt-0.5">{label}</p>
    </div>
  );
}

function BusinessCard({ biz, rank, total }: { biz: Business; rank: number; total: GrandTotal }) {
  const [open, setOpen] = useState(false);
  const pct = total.total_tokens > 0
    ? ((biz.total_tokens / total.total_tokens) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors text-right"
      >
        {/* Rank badge */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-black text-white"
          style={{ background: rank === 1 ? '#f59e0b' : rank === 2 ? '#94a3b8' : rank === 3 ? '#cd7c2f' : '#64748b' }}
        >
          {rank}
        </div>

        {/* Business info */}
        <div className="flex-1 min-w-0 text-right">
          <p className="font-black text-slate-900 truncate">{biz.business_name || 'לא ידוע'}</p>
          <p className="text-xs text-slate-400 mt-0.5">עדכון אחרון: {formatDate(biz.last_used_at)}</p>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-6 flex-shrink-0">
          <div className="text-right hidden sm:block">
            <p className="text-xs text-slate-400">טוקנים</p>
            <p className="font-bold text-amber-600 text-sm font-mono">{formatNumber(biz.total_tokens)}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-slate-400">עלות</p>
            <p className="font-bold text-slate-700 text-sm font-mono">${parseFloat(String(biz.total_cost_usd)).toFixed(4)}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-xs text-slate-400">קריאות</p>
            <p className="font-bold text-slate-700 text-sm">{biz.total_calls}</p>
          </div>
          <div className="text-right hidden md:block">
            <p className="text-xs text-slate-400">חלק מסה״כ</p>
            <p className="font-bold text-slate-500 text-sm">{pct}%</p>
          </div>
          {open ? (
            <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
          )}
        </div>
      </button>

      {/* Expanded feature breakdown */}
      {open && (
        <div className="border-t border-slate-100 px-5 py-4 bg-slate-50">
          <p className="text-xs font-semibold text-slate-500 mb-3">פירוט לפי פיצ׳ר</p>
          {biz.features.length === 0 ? (
            <p className="text-xs text-slate-400">אין נתונים</p>
          ) : (
            <div className="space-y-2">
              {biz.features.map((f, i) => (
                <div key={i} className="bg-white rounded-xl px-4 py-3 flex items-center gap-3">
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: featureColor(f.feature) }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700">{featureLabel(f.feature)}</p>
                    <p className="text-xs text-slate-400 truncate">{f.model}</p>
                  </div>
                  <div className="flex items-center gap-4 text-xs flex-shrink-0">
                    <div className="text-right">
                      <p className="text-slate-400">טוקנים</p>
                      <p className="font-mono font-bold text-amber-600">{formatNumber(f.total_tokens)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400">עלות</p>
                      <p className="font-mono text-slate-600">${parseFloat(String(f.cost_usd)).toFixed(5)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400">קריאות</p>
                      <p className="font-bold text-slate-600">{f.calls}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Input / Output split */}
          <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
            <span>In: {formatNumber(biz.input_tokens)} טוקנים</span>
            <span className="text-slate-300">·</span>
            <span>Out: {formatNumber(biz.output_tokens)} טוקנים</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminAIUsagePage() {
  const router = useRouter();
  const [data, setData] = useState<AIUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);

  const fetchData = async (d = days) => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch(`/admin/ai-usage?days=${d}`);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      let json: Record<string, unknown> = {};
      try { json = await res.json(); } catch { /* empty or non-JSON body */ }
      if (!res.ok) throw new Error((json.error as string) || `שגיאת שרת (${res.status})`);
      setData(json as unknown as AIUsageData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return <div className="text-center text-red-500 py-8 text-sm">{error}</div>;
  }

  if (!data) return null;

  const gt = data.grand_total;
  const sorted = [...(data.businesses ?? [])].sort(
    (a, b) => (parseFloat(String(b.total_cost_usd)) || 0) - (parseFloat(String(a.total_cost_usd)) || 0)
  );
  const topBiz    = sorted[0] || null;
  const bottomBiz = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  return (
    <div className="max-w-4xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">ניהול עלויות AI</h1>
          <p className="text-slate-500 text-sm mt-0.5">{days} ימים אחרונים · {gt.total_businesses} לקוחות</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Days selector */}
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1">
            {[7, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => { setDays(d); fetchData(d); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  days === d ? 'bg-amber-500 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {d}י'
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchData()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            רענן
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard icon={DollarSign} label="סה״כ עלות" value={`$${parseFloat(String(gt.total_cost_usd)).toFixed(4)}`} color="#10b981" />
        <StatCard icon={Zap} label="סה״כ טוקנים" value={formatNumber(parseInt(String(gt.total_tokens)) || 0)} color="#f59e0b" />
        <StatCard icon={Building2} label="לקוחות פעילים" value={String(gt.total_businesses)} color="#3b82f6" />
        <StatCard icon={Calendar} label="קריאות API" value={formatNumber(parseInt(String(gt.total_calls)) || 0)} color="#8b5cf6" />
      </div>

      {/* Top / Bottom */}
      {(topBiz || bottomBiz) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {topBiz && (
            <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: 'linear-gradient(135deg,#fffbeb,#fef3c7)', border: '1px solid #f59e0b' }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
                <Trophy className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-amber-700">הכי גבוה — לחייב יותר</p>
                <p className="text-base font-black truncate" style={{ color: '#000' }}>{topBiz.business_name || 'לא ידוע'}</p>
                <p className="text-xs font-semibold text-amber-800">${parseFloat(String(topBiz.total_cost_usd)).toFixed(4)} · {formatNumber(topBiz.total_tokens)} טוקנים</p>
              </div>
            </div>
          )}
          {bottomBiz && (
            <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', border: '1px solid #10b981' }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#34d399,#059669)' }}>
                <TrendingDown className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-emerald-700">הכי נמוך — הכי זול</p>
                <p className="text-base font-black truncate" style={{ color: '#000' }}>{bottomBiz.business_name || 'לא ידוע'}</p>
                <p className="text-xs font-semibold text-emerald-800">${parseFloat(String(bottomBiz.total_cost_usd)).toFixed(4)} · {formatNumber(bottomBiz.total_tokens)} טוקנים</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Per-business cards */}
      <div className="space-y-3 mb-5">
        <h2 className="font-bold text-slate-700 text-sm px-1">חשבון לכל לקוח</h2>
        {sorted.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center text-slate-400 text-sm border border-slate-100">
            אין נתוני שימוש בטווח הזמן הנבחר
          </div>
        ) : (
          sorted.map((biz, i) => (
            <BusinessCard key={biz.business_id} biz={biz} rank={i + 1} total={gt} />
          ))
        )}
      </div>

      {/* Grand total card */}
      <div
        className="rounded-2xl p-5"
        style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)', border: '1px solid #334155' }}
      >
        <p className="text-xs font-semibold text-slate-400 mb-3">סיכום כולל — כל הלקוחות</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-slate-500">סה״כ עלות</p>
            <p className="text-xl font-black text-emerald-400 font-mono">${parseFloat(String(gt.total_cost_usd)).toFixed(4)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">סה״כ טוקנים</p>
            <p className="text-xl font-black text-amber-400 font-mono">{formatNumber(parseInt(String(gt.total_tokens)) || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">קריאות API</p>
            <p className="text-xl font-black text-blue-400">{formatNumber(parseInt(String(gt.total_calls)) || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">לקוחות פעילים</p>
            <p className="text-xl font-black text-purple-400">{gt.total_businesses}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
