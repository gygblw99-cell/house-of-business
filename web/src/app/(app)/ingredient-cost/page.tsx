'use client';

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle, TrendingUp, TrendingDown, Info, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { dishesApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface Ingredient {
  name: string; qty: number; unit: string; manual_cost: number;
  invoice_price: number | null; estimated_line: number; real_line: number | null;
  supplier_name: string | null; invoice_date: string | null; variance_pct: number | null;
}
interface DishCost {
  dish_id: string; dish_name: string; selling_price: number;
  estimated_cost: number; real_cost: number | null;
  cost_difference: number | null; cost_variance_pct: number | null;
  est_margin_pct: number | null; real_margin_pct: number | null;
  has_real_data: boolean; ingredients: Ingredient[];
}

function VarianceBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs opacity-30">אין נתון</span>;
  const positive = pct > 0;
  const color = Math.abs(pct) <= 5 ? '#4ade80' : Math.abs(pct) <= 15 ? '#fbbf24' : '#f87171';
  return (
    <span className="flex items-center gap-0.5 text-xs font-bold" style={{ color }}>
      {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {positive ? '+' : ''}{pct}%
    </span>
  );
}

const PAGE_SIZE = 30;

export default function IngredientCostPage() {
  const { toast } = useAppDialog();
  const [dishes, setDishes]       = useState<DishCost[]>([]);
  const [overpriced, setOverpriced] = useState<{ name: string; dish: string; manual_cost: number; invoice_price: number }[]>([]);
  const [avgVariance, setAvgVariance] = useState(0);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore]     = useState(false);
  const [offset, setOffset]       = useState(0);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [filter, setFilter]       = useState<'all' | 'variance' | 'no_data'>('all');

  const beginRequest = useLatestRequest();

  const load = useCallback((reset = false) => {
    // Also stops a double-click on "load more" from appending the same page
    // twice: both calls read the same `offset` (it only advances in .then),
    // so without this the second response duplicates the first's rows.
    const latest = beginRequest();
    const currentOffset = reset ? 0 : offset;
    if (reset) { setLoading(true); setDishes([]); setOffset(0); }
    else setLoadingMore(true);

    dishesApi.ingredientCost({ limit: PAGE_SIZE, offset: currentOffset })
      .then(r => latest(() => {
        const newDishes = r.data.dishes || [];
        setDishes(prev => reset ? newDishes : [...prev, ...newDishes]);
        setOverpriced(r.data.overpricedIngredients || []);
        setAvgVariance(r.data.avgVariance || 0);
        setHasMore(r.data.pagination?.hasMore ?? false);
        setOffset(currentOffset + PAGE_SIZE);
      }))
      .catch(err => latest(() => toast(getErrorMessage(err) || 'טעינת עלויות המנות נכשלה', 'error')))
      .finally(() => latest(() => { setLoading(false); setLoadingMore(false); }));
  }, [offset, toast, beginRequest]);

  useEffect(() => { load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // תלוי בעלות חשבוניות (אישור חשבונית) ובעריכת מרכיבי מנה
  useSyncEvent(['invoice_approved', 'inventory.updated'], () => load(true));

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const filtered = dishes.filter(d => {
    if (filter === 'variance') return d.has_real_data && Math.abs(d.cost_variance_pct || 0) > 5;
    if (filter === 'no_data')  return !d.has_real_data;
    return true;
  });

  const dishesWithReal   = dishes.filter(d => d.has_real_data);
  const dishesHighVar    = dishes.filter(d => d.has_real_data && Math.abs(d.cost_variance_pct || 0) > 10);

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">עלות מרכיבים ריאלית</h1>
          <p className="text-sm opacity-60 mt-0.5">השוואת עלות מנות מוערכת לעומת מחירי חשבוניות בפועל</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'מנות נותחו', value: dishes.length, color: '#c9a227' },
          { label: 'עם נתוני חשבונית', value: dishesWithReal.length, color: '#4ade80' },
          { label: 'סטיית עלות ממוצעת', value: `${avgVariance > 0 ? '+' : ''}${avgVariance}%`, color: Math.abs(avgVariance) <= 5 ? '#4ade80' : '#f87171' },
          { label: 'מנות עם חריגה >10%', value: dishesHighVar.length, color: dishesHighVar.length > 0 ? '#f87171' : '#4ade80' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl p-4"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
            <p className="text-xs opacity-60 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Overpriced ingredients alert */}
      {overpriced.length > 0 && (
        <div className="rounded-2xl p-4"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
          <p className="font-semibold text-red-400 flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4" />
            {overpriced.length} מרכיבים שהתייקרו מאז עדכון אחרון
          </p>
          <div className="space-y-2">
            {overpriced.map((ing, i) => (
              <div key={i} className="flex items-center justify-between text-sm flex-wrap gap-2">
                <span className="font-medium">{ing.name} <span className="opacity-50 text-xs">({ing.dish})</span></span>
                <div className="flex items-center gap-3 text-xs">
                  <span className="opacity-50">מוגדר: ₪{ing.manual_cost.toFixed(2)}</span>
                  <span className="text-red-400 font-bold">חשבונית: ₪{ing.invoice_price.toFixed(2)}</span>
                  <span className="text-red-300 font-bold">+{(((ing.invoice_price - ing.manual_cost) / ing.manual_cost) * 100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2">
        {[
          { id: 'all',      label: `הכל (${dishes.length})` },
          { id: 'variance', label: `חריגה >5% (${dishes.filter(d => d.has_real_data && Math.abs(d.cost_variance_pct || 0) > 5).length})` },
          { id: 'no_data',  label: `ללא נתונים (${dishes.filter(d => !d.has_real_data).length})` },
        ].map(tab => (
          <button key={tab.id} onClick={() => setFilter(tab.id as typeof filter)}
            className="px-3 py-1.5 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: filter === tab.id ? 'rgba(201,162,39,0.15)' : 'transparent',
              border: `1px solid ${filter === tab.id ? 'rgba(201,162,39,0.4)' : 'var(--card-border-color)'}`,
              color: filter === tab.id ? '#c9a227' : undefined,
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <Info className="w-10 h-10 mx-auto mb-3" />
            <p>אין מנות לתצוגה</p>
            <p className="text-xs mt-1">הגדר מנות עם מרכיבים בדף מנות, ועלויות יסתנכרנו מחשבוניות</p>
          </CardContent>
        </Card>
      ) : (
        <>
        <div className="space-y-2">
          {filtered.map(dish => {
            const isExpanded = expanded.has(dish.dish_id);
            const hasIssue   = dish.has_real_data && Math.abs(dish.cost_variance_pct || 0) > 10;
            const borderColor = hasIssue ? 'rgba(239,68,68,0.3)' : dish.has_real_data ? 'rgba(34,197,94,0.2)' : 'var(--card-border-color)';

            return (
              <div key={dish.dish_id} className="rounded-2xl overflow-hidden"
                style={{ background: 'var(--card-bg)', border: `1px solid ${borderColor}` }}>

                <button className="w-full flex items-center gap-4 p-4 text-right"
                  onClick={() => toggle(dish.dish_id)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{dish.dish_name}</span>
                      {hasIssue && <AlertTriangle className="w-4 h-4 text-red-400" />}
                      {dish.has_real_data && !hasIssue && <CheckCircle className="w-4 h-4 text-green-400" />}
                      {!dish.has_real_data && <span className="text-xs opacity-30">אין חשבוניות</span>}
                    </div>
                    <div className="flex items-center gap-4 mt-0.5 flex-wrap">
                      <span className="text-xs opacity-50">מחיר: {formatCurrency(dish.selling_price)}</span>
                      <span className="text-xs opacity-50">עלות מוערכת: {formatCurrency(dish.estimated_cost)}</span>
                      {dish.real_cost !== null && (
                        <span className="text-xs font-semibold" style={{ color: (dish.cost_difference || 0) > 0 ? '#f87171' : '#4ade80' }}>
                          עלות ריאלית: {formatCurrency(dish.real_cost)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="text-center hidden sm:block">
                      <p className="text-xs opacity-40">מרווח מוערך</p>
                      <p className="text-sm font-bold" style={{ color: (dish.est_margin_pct || 0) >= 60 ? '#4ade80' : '#fbbf24' }}>
                        {dish.est_margin_pct ?? '—'}%
                      </p>
                    </div>
                    {dish.has_real_data && (
                      <div className="text-center hidden sm:block">
                        <p className="text-xs opacity-40">מרווח ריאלי</p>
                        <p className="text-sm font-bold" style={{ color: (dish.real_margin_pct || 0) >= 60 ? '#4ade80' : '#fbbf24' }}>
                          {dish.real_margin_pct ?? '—'}%
                        </p>
                      </div>
                    )}
                    <div className="text-center">
                      <p className="text-xs opacity-40">סטייה</p>
                      <VarianceBadge pct={dish.cost_variance_pct} />
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 opacity-40" /> : <ChevronDown className="w-4 h-4 opacity-40" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 py-3 overflow-x-auto"
                    style={{ borderColor: 'var(--card-border-color)', background: 'rgba(0,0,0,0.15)' }}>
                    <table className="w-full text-xs min-w-[500px]">
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          {['מרכיב','כמות','עלות מוגדרת','מחיר חשבונית','עלות שורה (מוערכת)','עלות שורה (ריאלית)','סטייה'].map(h => (
                            <th key={h} className="py-2 pr-3 text-right opacity-40 font-medium">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dish.ingredients.map((ing, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td className="py-2 pr-3 font-medium">{ing.name}</td>
                            <td className="py-2 pr-3 opacity-60">{ing.qty} {ing.unit}</td>
                            <td className="py-2 pr-3">₪{ing.manual_cost.toFixed(3)}</td>
                            <td className="py-2 pr-3">
                              {ing.invoice_price !== null
                                ? <span style={{ color: (ing.variance_pct || 0) > 10 ? '#f87171' : 'inherit' }}>₪{ing.invoice_price.toFixed(3)}</span>
                                : <span className="opacity-30">—</span>}
                            </td>
                            <td className="py-2 pr-3 opacity-70">₪{ing.estimated_line.toFixed(3)}</td>
                            <td className="py-2 pr-3">
                              {ing.real_line !== null
                                ? <span style={{ color: (ing.variance_pct || 0) > 10 ? '#f87171' : '#4ade80' }}>₪{ing.real_line.toFixed(3)}</span>
                                : <span className="opacity-30">—</span>}
                            </td>
                            <td className="py-2 pr-3"><VarianceBadge pct={ing.variance_pct} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {dish.ingredients[0]?.supplier_name && (
                      <p className="text-xs opacity-30 mt-2">
                        מחירי חשבונית מ: {dish.ingredients.filter(i => i.supplier_name).map(i => i.supplier_name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {hasMore && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" onClick={() => load(false)} disabled={loadingMore}>
              {loadingMore
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : 'טען עוד מנות'}
            </Button>
          </div>
        )}
        </>
      )}
    </div>
  );
}
