'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Star, TrendingUp, TrendingDown, AlertTriangle, RefreshCw,
  ChevronDown, ChevronUp, Tag, ArrowUpRight, Trash2, Megaphone,
  BarChart3, DollarSign, UtensilsCrossed, Lightbulb, CheckCircle2,
  HelpCircle, Scale, PackagePlus } from 'lucide-react';
import { dashboardApi, dishesApi, recipesApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { useSyncEvent } from '@/context/SyncContext';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Recommendation { action: string; detail: string; priority: string; icon: string; }

interface Dish {
  recipe_id: string; name: string; selling_price: number;
  source_type: 'recipe' | 'dish';
  qty_sold: number; total_revenue: number; cost_per_dish: number;
  margin_pct: number; quadrant: 'star' | 'plowhorse' | 'puzzle' | 'dog' | 'unclassified';
  isPopular: boolean; isProfitable: boolean | null;
  // Why a dish landed in the unclassified bucket: it hasn't sold yet, or it has
  // sold but has no ingredient cost — so its margin is unknown, not 100%.
  unclassifiedReason?: 'no_sales' | 'no_cost';
  optimalPrice: number | null; priceDiff: number;
  revenueContribution: number; recommendation: Recommendation;
  dataWarning: string | null;
  first_sold?: string | null;
  last_sold?: string | null;
}

interface TopAction { type: string; dish: string; impact: number; label: string; dataWarning: string | null; }

interface Summary {
  totalDishes: number; avgFoodCostPct: number;
  totalRevenue: number; totalFoodCost: number;
  medianSales: number; medianMargin: number;
  topActions: TopAction[];
  starCount: number; plowhorseCount: number; puzzleCount: number; dogCount: number;
  unclassifiedCount?: number; noCostCount?: number; noSalesCount?: number;
  // false ⇒ not a single dish has an ingredient cost, so avgFoodCostPct is 0
  // because nothing was measured — never because food cost is genuinely zero.
  hasCostData?: boolean;
  // Share of period revenue that carried per-dish detail. A low number means
  // avgFoodCostPct was computed from a small slice of the real trade.
  itemDataCoveragePct?: number;
}

interface EngResult {
  dishes: Dish[]; summary: Summary; days: number;
  medianSales: number; medianMargin: number;
  noItemSales?: boolean;
  itemDataCoveragePct?: number;
}

interface BundleSuggestion {
  anchor: string; add: string; bundlePrice: number; saving: number; reason: string;
}
type ElasticitySignal = 'inelastic' | 'elastic' | 'moderate' | 'uncertain' | 'weight_based';
interface ElasticityItem {
  name: string; avgPrice: number; minPrice: number; maxPrice: number;
  priceVariationPct: number; totalQty: number; daysWithSales: number;
  elasticitySignal: ElasticitySignal;
  // Measured demand response: %change in units per day ÷ %change in price.
  // null when the data couldn't support the comparison.
  elasticity: number | null;
  cheapPrice: number | null; dearPrice: number | null;
  cheapQtyPerDay: number | null; dearQtyPerDay: number | null;
}
interface ElasticityResult {
  elasticityData: ElasticityItem[];
  bundles: BundleSuggestion[];
  analyzedAt: string;
}

// ── Quadrant Config ───────────────────────────────────────────────────────────
const Q_CONFIG = {
  star: {
    label: 'כוכבים',       emoji: '🏆', color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)',
    text: '#92400e', desc: 'נמכר הרבה + רווחי — שמור ותחזק',
  },
  plowhorse: {
    label: 'סוסי עבודה',   emoji: '💪', color: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.3)',
    text: '#1e40af', desc: 'נמכר הרבה + מרג\'ין נמוך — העלה מחיר',
  },
  puzzle: {
    label: 'פוטנציאל',     emoji: '🎯', color: '#8b5cf6',
    bg: 'rgba(139,92,246,0.08)', border: 'rgba(139,92,246,0.3)',
    text: '#5b21b6', desc: 'רווחי + לא נמכר מספיק — קדם אותו',
  },
  dog: {
    label: 'דורשים שיפור', emoji: '📉', color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)',
    text: '#991b1b', desc: 'לא נמכר + לא רווחי — שפר או הסר',
  },
} as const;

type QKey = keyof typeof Q_CONFIG;

// ── Elasticity Config ─────────────────────────────────────────────────────────
// Four outcomes instead of the old two. The old pair was "inelastic" (green,
// meaning "go ahead and raise the price") or "uncertain", decided purely by
// whether the item had sold on 30+ days — so "demand fell hard when you raised
// the price" had no way to be expressed at all, and the safe-looking green was
// the default. These map to a measured ratio; see the backend for the bands.
const E_CONFIG: Record<ElasticitySignal, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  inelastic:    { label: 'לא רגיש למחיר', color: '#16a34a', bg: 'rgba(22,163,74,0.1)',   icon: CheckCircle2 },
  moderate:     { label: 'רגישות בינונית', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: TrendingUp },
  elastic:      { label: 'רגיש למחיר',    color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   icon: TrendingDown },
  uncertain:    { label: 'לא ודאי',       color: '#6b7280', bg: 'rgba(107,114,128,0.1)', icon: HelpCircle },
  weight_based: { label: 'נמכר במשקל',    color: '#6b7280', bg: 'rgba(107,114,128,0.1)', icon: Scale },
};

// ── Dish Row ──────────────────────────────────────────────────────────────────
function DishRow({ dish, days, onPriceUpdate }: { dish: Dish; days: number; onPriceUpdate: (id: string, price: number, type: 'recipe' | 'dish') => void }) {
  const { toast } = useAppDialog();
  const [expanded, setExpanded]     = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState(String(dish.selling_price));
  const [saving, setSaving]         = useState(false);
  const cfg = dish.quadrant !== 'unclassified' ? Q_CONFIG[dish.quadrant]
    : dish.unclassifiedReason === 'no_cost' ? {
      // Amber, not grey: this one is waiting on the owner, not on time.
      label: 'חסרה עלות', emoji: '💸', color: '#b45309',
      bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.28)',
      text: '#78350f', desc: '',
    } : {
      label: 'ממתינות לנתונים', emoji: '⏳', color: '#6b7280',
      bg: 'rgba(107,114,128,0.06)', border: 'rgba(107,114,128,0.2)',
      text: '#374151', desc: '',
    };
  const priorityColor = dish.recommendation.priority === 'high'   ? '#ef4444'
                      : dish.recommendation.priority === 'medium' ? '#f59e0b'
                      : '#16a34a';

  const savePrice = async (newPrice: number) => {
    if (saving) return;
    if (newPrice <= 0 || newPrice === dish.selling_price) { setEditingPrice(false); return; }
    setSaving(true);
    try {
      if (dish.source_type === 'dish') {
        await dishesApi.update(dish.recipe_id, { sellingPrice: newPrice });
      } else {
        await recipesApi.update(dish.recipe_id, { sellingPrice: newPrice });
      }
      onPriceUpdate(dish.recipe_id, newPrice, dish.source_type);
    } catch (err) { toast(getErrorMessage(err) || 'עדכון המחיר נכשל', 'error'); }
    finally { setSaving(false); setEditingPrice(false); }
  };

  return (
    <div
      className="rounded-xl overflow-hidden transition-all"
      style={{ border: `1px solid ${cfg.border}`, background: cfg.bg }}
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-right"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-lg flex-shrink-0">{cfg.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-gray-800 truncate">{dish.name}</p>
            {dish.dataWarning && (
              <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0 flex items-center gap-0.5"
                style={{ background: 'rgba(234,179,8,0.15)', color: '#92400e' }}
                title={dish.dataWarning}>
                ⚠️ בדוק עלות
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {dish.qty_sold > 0
              ? <>
                  <span className="font-semibold text-blue-600">נמכר {Math.round(dish.qty_sold)} יח׳</span>
                  <span className="text-gray-400 mr-1">ב-{days} ימים</span>
                  <span className="mr-1">· ₪{dish.selling_price}</span>
                </>
              : <span>אין נתוני מכירות · ₪{dish.selling_price}</span>
            }
          </p>
        </div>

        {/* Margin bar */}
        <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0 w-28">
          {dish.cost_per_dish === 0 ? (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold"
              style={{ background: 'rgba(245,158,11,0.15)', color: '#b45309' }}>
              ⚠️ עלות לא ידועה
            </span>
          ) : (
            <>
              <span className="text-xs text-gray-500">מרג׳ין {dish.margin_pct.toFixed(1)}%</span>
              <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, dish.margin_pct)}%`, background: cfg.color }} />
              </div>
            </>
          )}
        </div>

        <div className="text-left flex-shrink-0 mr-2">
          <p className="text-sm font-black" style={{ color: cfg.color }}>
            {dish.revenueContribution.toFixed(1)}%
          </p>
          <p className="text-xs text-gray-400">מהכנסות</p>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3" style={{ borderTop: `1px solid ${cfg.border}` }}>
          {/* Stats grid */}
          <div className="grid grid-cols-4 gap-2 pt-3">
            {[
              { label: 'עלות מנה', value: dish.cost_per_dish > 0 ? `₪${dish.cost_per_dish.toFixed(2)}` : '⚠️ לא ידוע', color: dish.cost_per_dish > 0 ? '#ef4444' : '#f59e0b' },
              { label: 'מחיר מכירה', value: `₪${dish.selling_price}`, color: '#e8e8e4', editable: true },
              { label: 'מחיר מומלץ', value: dish.optimalPrice ? `₪${dish.optimalPrice}` : '—', color: '#8b5cf6' },
              { label: 'הכנסה כוללת', value: `₪${Math.round(dish.total_revenue)}`, color: '#16a34a' },
            ].map(({ label, value, color, editable }) => (
              <div key={label} className="rounded-xl p-2.5 text-center" style={{ background: 'rgba(20,20,28,0.8)' }}>
                <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>{label}</p>
                {editable && editingPrice ? (
                  <div className="flex items-center gap-1 justify-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="number" min="0" step="1"
                      value={priceInput}
                      onChange={e => setPriceInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') savePrice(parseFloat(priceInput)); if (e.key === 'Escape') setEditingPrice(false); }}
                      className="w-16 text-center text-sm font-bold border-2 border-purple-400 rounded-lg px-1 py-0.5 focus:outline-none"
                      autoFocus
                    />
                    <button onClick={() => savePrice(parseFloat(priceInput))} disabled={saving}
                      className="text-xs bg-purple-500 text-white px-1.5 py-0.5 rounded-lg">✓</button>
                  </div>
                ) : (
                  <p className="text-sm font-black cursor-pointer hover:underline" style={{ color }}
                     onClick={editable ? (e) => { e.stopPropagation(); setPriceInput(String(dish.selling_price)); setEditingPrice(true); } : undefined}>
                    {value}{editable && <span className="text-xs text-gray-400 mr-1">✎</span>}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Price diff alert + quick-set button */}
          {dish.priceDiff > 1 && dish.optimalPrice && (
            <div className="rounded-xl p-3 flex items-center justify-between gap-3"
              style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)' }}>
              <div className="flex items-start gap-2.5 min-w-0">
                <ArrowUpRight className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-purple-800">
                  <strong>מחיר מומלץ: ₪{dish.optimalPrice}</strong> — +₪{dish.priceDiff.toFixed(0)} למרג׳ין 68%
                </p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); savePrice(dish.optimalPrice!); }}
                disabled={saving}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-500 text-white hover:bg-purple-600 transition-colors disabled:opacity-50"
              >
                {saving ? '...' : 'קבע ₪' + dish.optimalPrice}
              </button>
            </div>
          )}

          {/* Data-quality warning */}
          {dish.dataWarning && (
            <div className="rounded-xl px-3 py-2.5 flex items-start gap-2"
              style={{ background: 'rgba(234,179,8,0.10)', border: '1.5px solid rgba(234,179,8,0.45)' }}>
              <span className="text-sm flex-shrink-0 mt-0.5">⚠️</span>
              <p className="text-xs text-yellow-800 leading-snug">{dish.dataWarning}</p>
            </div>
          )}

          {/* Recommendation */}
          <div className="rounded-xl p-3 flex items-start gap-2.5"
            style={{ background: 'rgba(255,255,255,0.8)', border: `1px solid ${cfg.border}` }}>
            <span className="text-base flex-shrink-0">{dish.recommendation.icon}</span>
            <div>
              <p className="text-xs font-bold mb-1" style={{ color: priorityColor }}>
                {dish.recommendation.action}
              </p>
              <p className="text-sm text-gray-700 leading-relaxed">
                {dish.recommendation.detail}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Quadrant Section ──────────────────────────────────────────────────────────
function QuadrantSection({ qkey, dishes, days, onPriceUpdate }: { qkey: QKey; dishes: Dish[]; days: number; onPriceUpdate: (id: string, price: number, type: 'recipe' | 'dish') => void }) {
  const [open, setOpen] = useState(true);
  const cfg = Q_CONFIG[qkey];
  if (dishes.length === 0) return null;

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        background: 'var(--glass-bg, rgba(255,255,255,0.75))',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--glass-shadow)',
      }}>
      <button
        className="w-full flex items-center gap-3 px-5 py-4 text-right"
        style={{ borderBottom: open ? `1px solid ${cfg.border}` : 'none' }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-xl">{cfg.emoji}</span>
        <div className="flex-1 text-right">
          <p className="font-bold text-gray-800">{cfg.label}</p>
          <p className="text-xs mt-0.5" style={{ color: cfg.color }}>{cfg.desc}</p>
        </div>
        <span className="text-sm font-black px-2.5 py-1 rounded-full flex-shrink-0"
          style={{ background: cfg.bg, color: cfg.color }}>
          {dishes.length} מנות
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>
      {open && (
        <div className="px-4 py-3 space-y-2">
          {dishes.map(d => <DishRow key={d.recipe_id} dish={d} days={days} onPriceUpdate={onPriceUpdate} />)}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MenuEngineeringPage() {
  const { toast } = useAppDialog();
  const [data, setData]       = useState<EngResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays]       = useState(180);
  const [view, setView]       = useState<'list' | 'matrix'>('list');
  const [lastRun, setLastRun] = useState<Date | null>(null);

  const [elasticity, setElasticity]       = useState<ElasticityResult | null>(null);
  const [elasticityLoading, setElasticityLoading] = useState(true);

  const beginRequest = useLatestRequest();

  const load = useCallback(async (d: number) => {
    const latest = beginRequest();
    setLoading(true);
    try {
      const { data: res } = await dashboardApi.menuEngineering(d);
      latest(() => { setData(res); setLastRun(new Date()); });
    } catch (err) { latest(() => toast(getErrorMessage(err) || 'שגיאה בטעינת ניתוח הנדסת התפריט', 'error')); }
    finally { latest(() => setLoading(false)); }
  }, [toast, beginRequest]);

  const loadElasticity = useCallback(async () => {
    setElasticityLoading(true);
    try {
      const { data: res } = await dashboardApi.priceElasticity();
      setElasticity(res);
    } catch { /* non-critical section — fail silently, main analysis above still works */ }
    finally { setElasticityLoading(false); }
  }, []);

  // Optimistic price update — re-run analysis after save
  const handlePriceUpdate = useCallback((_id: string, _price: number, _type: 'recipe' | 'dish') => {
    load(days);
    loadElasticity();
  }, [load, loadElasticity, days]);

  useEffect(() => { load(days); }, [load, days]);
  useEffect(() => { loadElasticity(); }, [loadElasticity]);

  // Auto-refresh when a dish/recipe cost changes elsewhere (e.g. another tab, or the recipes page)
  useSyncEvent(['inventory.updated', 'recipe.updated', 'menu.changed'], () => { load(days); loadElasticity(); });

  const s = data?.summary;

  return (
    <div className="space-y-5" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">הנדסת תפריט</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {lastRun ? `עודכן ${lastRun.toLocaleTimeString('he-IL')}` : 'טוען...'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period */}
          <div className="flex rounded-xl overflow-hidden border"
            style={{ borderColor: 'var(--card-border-color, #e5e7eb)' }}>
            {([30, 90, 180] as const).map(d => (
              <button key={d} onClick={() => setDays(d)}
                data-days={d}
                className="px-3 py-2 text-sm font-medium transition-all"
                style={{
                  background: days === d ? 'var(--color-primary, #1a5c2a)' : 'transparent',
                  color: days === d ? '#fff' : 'var(--color-primary, #1a5c2a)',
                }}>
                {d} ימים
              </button>
            ))}
          </div>
          {/* View toggle */}
          <div className="flex rounded-xl overflow-hidden border"
            style={{ borderColor: 'var(--card-border-color, #e5e7eb)' }}>
            {([
              { id: 'list',   label: 'רשימה' },
              { id: 'matrix', label: 'מטריצה' },
            ] as const).map(({ id, label }) => (
              <button key={id} onClick={() => setView(id)}
                className="px-3 py-2 text-sm font-medium transition-all"
                style={{
                  background: view === id ? 'var(--color-primary, #1a5c2a)' : 'transparent',
                  color: view === id ? '#fff' : 'var(--color-primary, #1a5c2a)',
                }}>
                {label}
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => load(days)} loading={loading}>
            <RefreshCw className="w-4 h-4" /> רענן
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse"
              style={{ background: 'var(--glass-bg, rgba(255,255,255,0.6))' }} />
          ))}
        </div>
      ) : !s ? (
        <div className="text-center py-20 rounded-2xl"
          style={{ background: 'var(--glass-bg, rgba(255,255,255,0.6))', border: '1px solid var(--glass-border)' }}>
          <UtensilsCrossed className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-bold text-gray-700">אין נתונים לניתוח</p>
          <p className="text-sm text-gray-500 mt-1">חבר קופה ועדכן מתכונים עם חומרי גלם</p>
        </div>
      ) : data?.noItemSales ? (
        <div className="rounded-2xl p-8 text-center"
          style={{ background: 'var(--glass-bg, rgba(255,255,255,0.6))', border: '1px solid var(--glass-border)' }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }}>
            <BarChart3 className="w-7 h-7" style={{ color: '#f59e0b' }} />
          </div>
          <p className="font-bold text-gray-800 text-lg mb-2">אין נתוני פירוט מנות בטווח זה</p>
          <p className="text-sm text-gray-500 leading-relaxed max-w-md mx-auto mb-5">
            דוחות ה-Z שהועלו עבור {days} הימים האחרונים מכילים סיכום יומי בלבד — סכום הכנסות כולל ללא פירוט לפי מנה.<br />
            הנדסת תפריט דורשת נתונים ברמת מנה (כמות שנמכרה לכל מנה).
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <button
              onClick={() => { (document.querySelector('[data-days="180"]') as HTMLButtonElement)?.click(); }}
              className="px-5 py-2.5 rounded-xl text-sm font-bold transition-all"
              style={{ background: 'var(--color-primary,#1a5c2a)', color: '#fff' }}
            >
              עבור ל-180 ימים ←
            </button>
            <a href="/zreport"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ border: '1px solid var(--card-border-color,#e5e7eb)', color: 'var(--color-primary,#1a5c2a)' }}>
              העלה דוח עם פירוט מנות
            </a>
          </div>
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'מנות מסווגות',   value: String(s.starCount + s.plowhorseCount + s.puzzleCount + s.dogCount), color: 'var(--color-primary,#1a5c2a)', icon: UtensilsCrossed },
              // A business with no ingredient costs at all computes 0%, and the
              // plain "below 35% is good" rule painted that bright green — the
              // screen congratulated the owner on a food cost nobody had measured.
              // hasCostData distinguishes "measured 0%" from "measured nothing".
              s.hasCostData === false
                ? { label: 'Food Cost %', value: '—', color: '#9ca3af', icon: DollarSign }
                : { label: 'Food Cost %', value: `${s.avgFoodCostPct}%`, color: s.avgFoodCostPct > 35 ? '#ef4444' : '#16a34a', icon: DollarSign },
              { label: 'כוכבים',        value: String(s.starCount),             color: '#f59e0b', icon: Star },
              { label: 'דורשים תשומת לב', value: String(s.plowhorseCount + s.dogCount), color: '#ef4444', icon: AlertTriangle },
            ].map(({ label, value, color, icon: Icon }) => (
              <div key={label} className="rounded-2xl p-4"
                style={{
                  background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid var(--glass-border)',
                  boxShadow: 'var(--glass-shadow)',
                }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-2"
                  style={{ background: color + '18' }}>
                  <Icon className="w-4 h-4" style={{ color }} />
                </div>
                <p className="text-xl font-black" style={{ color }}>{value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Why the numbers above may be thin. The backend has always sent both
              of these signals; nothing in the app read them, so a business with
              no cost data got a confident-looking screen with nothing behind it. */}
          {(s.hasCostData === false || (s.noCostCount ?? 0) > 0 ||
            (s.itemDataCoveragePct !== undefined && s.itemDataCoveragePct < 50)) && (
            <div className="rounded-2xl p-4 flex items-start gap-3"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}>
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
              <div className="text-sm leading-relaxed" style={{ color: '#78350f' }}>
                {s.hasCostData === false ? (
                  <p><strong>אין נתוני עלות לאף מנה.</strong> בלי עלות חומרי גלם אי אפשר לחשב רווחיות, ולכן אף מנה לא סווגה
                    ל"כוכב" או "דורש שיפור" ואחוז ה-Food Cost מוצג כ-—. הגדר מרכיבים למנות והניתוח ייפתח אוטומטית.</p>
                ) : (s.noCostCount ?? 0) > 0 ? (
                  <p><strong>{s.noCostCount} מנות נמכרו אך אין להן נתוני עלות.</strong> הן לא סווגו — מנה בלי עלות מקבלת מרג׳ין
                    מדומה של 100%, שהיה מסווג אותה כ"כוכב" ומטה את החציון לרעת המנות האמיתיות. הן ממתינות למטה.</p>
                ) : null}
                {s.itemDataCoveragePct !== undefined && s.itemDataCoveragePct < 50 && (
                  <p className={s.hasCostData === false || (s.noCostCount ?? 0) > 0 ? 'mt-2' : ''}>
                    <strong>רק {s.itemDataCoveragePct}% מההכנסות בטווח זה כוללות פירוט לפי מנה.</strong> השאר הגיע מדוחות Z
                    עם סכום יומי בלבד, ולכן ה-Food Cost והסיווג מבוססים על חלק קטן מהפעילות האמיתית.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Top Actions */}
          {s.topActions.length > 0 && (
            <div className="rounded-2xl p-5"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--glass-shadow)',
              }}>
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb className="w-5 h-5" style={{ color: 'var(--color-accent, #c9a227)' }} />
                <p className="font-bold text-gray-800">הפעולות שישפיעו הכי הרבה עכשיו</p>
              </div>
              <div className="space-y-2.5">
                {s.topActions.map((action, i) => {
                  const icon = action.type === 'raise_price' ? <ArrowUpRight className="w-4 h-4 text-blue-600" />
                              : action.type === 'remove'    ? <Trash2 className="w-4 h-4 text-red-500" />
                              : <Megaphone className="w-4 h-4 text-purple-600" />;
                  const bg   = action.type === 'raise_price' ? 'rgba(59,130,246,0.08)'
                              : action.type === 'remove'    ? 'rgba(239,68,68,0.08)'
                              : 'rgba(139,92,246,0.08)';
                  return (
                    <div key={i} className="flex items-start gap-3 rounded-xl p-3"
                      style={{ background: bg }}>
                      <div className="w-7 h-7 rounded-lg bg-white/80 flex items-center justify-center flex-shrink-0">
                        {icon}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm text-gray-800">{action.label}</p>
                        {action.impact > 0 && (
                          <p className="text-xs text-green-600 font-semibold mt-0.5">
                            פוטנציאל שנתי: +₪{action.impact.toLocaleString()}
                          </p>
                        )}
                        {action.dataWarning && (
                          <p className="text-xs text-yellow-700 font-medium mt-1 flex items-center gap-1">
                            <span>⚠️</span> {action.dataWarning}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bundle Suggestions */}
          {!elasticityLoading && elasticity && elasticity.bundles.length > 0 && (
            <div className="rounded-2xl p-5"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--glass-shadow)',
              }}>
              <div className="flex items-center gap-2 mb-3">
                <PackagePlus className="w-5 h-5" style={{ color: '#8b5cf6' }} />
                <p className="font-bold text-gray-800">הצעות חבילה</p>
                <span className="text-xs text-gray-400">שלב מנה עם חשיפה נמוכה עם מנה פופולרית</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {elasticity.bundles.map((b, i) => (
                  <div key={i} className="rounded-xl p-3" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.18)' }}>
                    <p className="text-sm font-semibold text-gray-800">{b.anchor} + {b.add}</p>
                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">{b.reason}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-sm font-black" style={{ color: '#8b5cf6' }}>מחיר חבילה: ₪{b.bundlePrice}</span>
                      {b.saving > 0 && (
                        <span className="text-xs font-semibold text-green-600">חיסכון ללקוח: ₪{b.saving}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Price Elasticity — dishes whose price changed recently and how demand responded */}
          {!elasticityLoading && elasticity && elasticity.elasticityData.length > 0 && (
            <div className="rounded-2xl p-5"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--glass-shadow)',
              }}>
              <div className="flex items-center gap-2 mb-3">
                <Tag className="w-5 h-5" style={{ color: '#0891b2' }} />
                <p className="font-bold text-gray-800">רגישות מחיר — איך הביקוש הגיב לשינויי מחיר ב-90 יום האחרונים</p>
              </div>
              <div className="space-y-2">
                {elasticity.elasticityData.map((el, i) => {
                  const cfg = E_CONFIG[el.elasticitySignal] ?? E_CONFIG.uncertain;
                  const EIcon = cfg.icon;
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-xl p-3" style={{ background: 'rgba(8,145,178,0.05)' }}>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{el.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          ₪{el.minPrice}–₪{el.maxPrice} (שינוי של {el.priceVariationPct}%) · {el.totalQty} יח׳ נמכרו ב-{el.daysWithSales} ימים
                        </p>
                        {/* The actual comparison behind the label. Previously the
                            panel asserted "sales stayed stable" without ever
                            comparing quantity across price levels — now the two
                            sides of that comparison are shown outright. */}
                        {el.cheapPrice !== null && el.dearPrice !== null && (
                          <p className="text-xs mt-1" style={{ color: '#0e7490' }}>
                            בימים הזולים (₪{el.cheapPrice}) נמכרו {el.cheapQtyPerDay} ליום · ביקרים (₪{el.dearPrice}) {el.dearQtyPerDay} ליום
                            {el.elasticity !== null && <span className="text-gray-400"> · מדד {el.elasticity}</span>}
                          </p>
                        )}
                      </div>
                      <span className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full"
                        style={{ background: cfg.bg, color: cfg.color }}>
                        <EIcon className="w-3.5 h-3.5" /> {cfg.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-400 mt-3 leading-relaxed">
                המדד = אחוז השינוי בכמות ליום חלקי אחוז השינוי במחיר. קרוב ל-0 → הביקוש כמעט לא הגיב (יש מקום להעלות מחיר
                בזהירות); מתחת ל-1- → הכמות ירדה מהר יותר מהעלייה במחיר. נדרשים לפחות 3 ימים בכל רמת מחיר; פריטים
                שנמכרים במשקל מסומנים בנפרד כי ה"מחיר ליחידה" שלהם משתנה לפי המשקל ולא לפי החלטת תמחור.
              </p>
            </div>
          )}

          {view === 'list' ? (
            /* ── LIST VIEW ── */
            <div className="space-y-4">
              {(['star', 'plowhorse', 'puzzle', 'dog'] as QKey[]).map(qk => (
                <QuadrantSection
                  key={qk}
                  qkey={qk}
                  dishes={(data?.dishes || []).filter(d => d.quadrant === qk)}
                  days={days}
                  onPriceUpdate={handlePriceUpdate}
                />
              ))}
              {/* Unclassified, split by reason. "Sold but has no cost" is a
                  fixable config gap that blocks the whole profitability axis;
                  "hasn't sold yet" is nothing to act on. Merging them under
                  "waiting for sales data" told owners the wrong thing about
                  dishes that were, in fact, selling. */}
              {([
                { reason: 'no_cost'  as const, emoji: '💸', border: 'rgba(245,158,11,0.35)', chipBg: 'rgba(245,158,11,0.1)', chipColor: '#b45309',
                  title: 'נמכרות אך חסרות נתוני עלות',
                  sub: 'המנות נמכרות, אבל בלי עלות חומרי גלם אי אפשר לדעת אם הן רווחיות — הגדר מרכיבים והן יסווגו אוטומטית' },
                { reason: 'no_sales' as const, emoji: '⏳', border: 'rgba(107,114,128,0.2)', chipBg: 'rgba(107,114,128,0.08)', chipColor: '#6b7280',
                  title: 'ממתינות לנתוני מכירות',
                  sub: 'מנות אלו טרם נמכרו — לאחר מכירה ראשונה יסווגו אוטומטית' },
              ]).map(g => {
                // Older cached payloads have no unclassifiedReason; treat those
                // as "no sales", which is what the single old bucket meant.
                const items = (data?.dishes || []).filter(d => d.quadrant === 'unclassified' &&
                  (d.unclassifiedReason ?? 'no_sales') === g.reason);
                if (items.length === 0) return null;
                return (
                  <div key={g.reason} className="rounded-2xl overflow-hidden"
                    style={{
                      background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                      backdropFilter: 'blur(20px)',
                      border: `1px solid ${g.border}`,
                      boxShadow: 'var(--glass-shadow)',
                    }}>
                    <div className="flex items-center gap-3 px-5 py-4">
                      <span className="text-xl">{g.emoji}</span>
                      <div className="flex-1 text-right">
                        <p className="font-bold text-gray-700">{g.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{g.sub}</p>
                      </div>
                      <span className="text-sm font-black px-2.5 py-1 rounded-full flex-shrink-0"
                        style={{ background: g.chipBg, color: g.chipColor }}>
                        {items.length} מנות
                      </span>
                    </div>
                    <div className="px-4 pb-3 space-y-2 border-t border-gray-100">
                      {items.map(d => (
                        <DishRow key={d.recipe_id} dish={d} days={days} onPriceUpdate={handlePriceUpdate} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── MATRIX VIEW ── */
            <div className="rounded-2xl overflow-hidden"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--glass-shadow)',
              }}>
              {/* Axis labels */}
              <div className="px-5 pt-4 pb-2 flex justify-between text-xs text-gray-400 font-semibold">
                <span>↑ רווחיות</span>
                <span>פופולריות →</span>
              </div>
              <div className="grid grid-cols-2 gap-px p-4 pt-1"
                style={{ background: 'var(--glass-border)' }}>
                {/* Puzzle: low sales, high margin */}
                <div className="p-4 rounded-tl-xl" style={{ background: Q_CONFIG.puzzle.bg }}>
                  <p className="text-sm font-bold mb-2" style={{ color: Q_CONFIG.puzzle.color }}>
                    {Q_CONFIG.puzzle.emoji} {Q_CONFIG.puzzle.label}
                  </p>
                  <p className="text-xs text-gray-500 mb-2">{Q_CONFIG.puzzle.desc}</p>
                  <div className="space-y-1">
                    {(data?.dishes || []).filter(d => d.quadrant === 'puzzle').map(d => (
                      <p key={d.recipe_id} className="text-xs font-medium text-gray-700 truncate">· {d.name}</p>
                    ))}
                    {(data?.dishes || []).filter(d => d.quadrant === 'puzzle').length === 0 &&
                      <p className="text-xs text-gray-400 italic">אין מנות</p>}
                  </div>
                </div>
                {/* Star: high sales, high margin */}
                <div className="p-4 rounded-tr-xl" style={{ background: Q_CONFIG.star.bg }}>
                  <p className="text-sm font-bold mb-2" style={{ color: Q_CONFIG.star.color }}>
                    {Q_CONFIG.star.emoji} {Q_CONFIG.star.label}
                  </p>
                  <p className="text-xs text-gray-500 mb-2">{Q_CONFIG.star.desc}</p>
                  <div className="space-y-1">
                    {(data?.dishes || []).filter(d => d.quadrant === 'star').map(d => (
                      <p key={d.recipe_id} className="text-xs font-medium text-gray-700 truncate">· {d.name}</p>
                    ))}
                    {(data?.dishes || []).filter(d => d.quadrant === 'star').length === 0 &&
                      <p className="text-xs text-gray-400 italic">אין מנות</p>}
                  </div>
                </div>
                {/* Dog: low sales, low margin */}
                <div className="p-4 rounded-bl-xl" style={{ background: Q_CONFIG.dog.bg }}>
                  <p className="text-sm font-bold mb-2" style={{ color: Q_CONFIG.dog.color }}>
                    {Q_CONFIG.dog.emoji} {Q_CONFIG.dog.label}
                  </p>
                  <p className="text-xs text-gray-500 mb-2">{Q_CONFIG.dog.desc}</p>
                  <div className="space-y-1">
                    {(data?.dishes || []).filter(d => d.quadrant === 'dog').map(d => (
                      <p key={d.recipe_id} className="text-xs font-medium text-gray-700 truncate">· {d.name}</p>
                    ))}
                    {(data?.dishes || []).filter(d => d.quadrant === 'dog').length === 0 &&
                      <p className="text-xs text-gray-400 italic">אין מנות</p>}
                  </div>
                </div>
                {/* Plowhorse: high sales, low margin */}
                <div className="p-4 rounded-br-xl" style={{ background: Q_CONFIG.plowhorse.bg }}>
                  <p className="text-sm font-bold mb-2" style={{ color: Q_CONFIG.plowhorse.color }}>
                    {Q_CONFIG.plowhorse.emoji} {Q_CONFIG.plowhorse.label}
                  </p>
                  <p className="text-xs text-gray-500 mb-2">{Q_CONFIG.plowhorse.desc}</p>
                  <div className="space-y-1">
                    {(data?.dishes || []).filter(d => d.quadrant === 'plowhorse').map(d => (
                      <p key={d.recipe_id} className="text-xs font-medium text-gray-700 truncate">· {d.name}</p>
                    ))}
                    {(data?.dishes || []).filter(d => d.quadrant === 'plowhorse').length === 0 &&
                      <p className="text-xs text-gray-400 italic">אין מנות</p>}
                  </div>
                </div>
              </div>
              {/* Legend */}
              <div className="px-5 pb-4 pt-2 text-xs text-gray-400 text-center">
                ← מכירות נמוכות | מכירות גבוהות →
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
