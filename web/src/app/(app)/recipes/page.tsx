'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppDialog } from '@/context/AppDialogContext';
import {
  ChefHat, Plus, Search, Trash2, Pencil, X, Check,
  TrendingUp, Package, UtensilsCrossed, RefreshCw,
  AlertTriangle, Info, ArrowRight, Loader2, Sparkles,
  Lightbulb, TrendingDown, Undo2, Archive } from 'lucide-react';
import { recipesApi, dishesApi, inventoryApi, extrasApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import type { Recipe } from '@/types';
import { MarkdownText } from '@/components/ui/MarkdownText';
import {
  UNITS_BY_FAMILY, resolveUnit, pricePerRecipeUnit, lineCost, getDefaultRecipeUnit,
  type UnitFamily } from '@/lib/unitConversion';

// ═══════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════

interface InvoiceIngredient {
  key: string; name: string; unit: string; latest_unit: string;
  latest_price: number; avg_price: number; min_price: number; max_price: number;
  last_invoice_date: string; times_ordered: number;
  current_qty?: number; category_name?: string;
}

interface RecipeIngLine {
  id: string;
  name: string;
  invoiceKey: string;
  invoiceUnit: string;
  invoicePrice: number;
  qty: number;
  unit: string;
  costPerUnit: number | null;
  qtyStr?: string; // transient display string — allows partial typing like "1."
  // Set only when this line came from a "worth X shekels" free-text description
  // with no real matching inventory item — there's no way to know the real
  // per-unit price without knowing the real quantity that money bought, so the
  // qty shown is a guess. Kept attached so that editing qty recomputes
  // costPerUnit = costShekels / qty live, instead of leaving a wrong price
  // frozen at whatever the initial guess produced.
  costShekels?: number;
}

interface DishDetail {
  id: string; name: string; selling_price: number; notes?: string; dish_type?: string;
  recipe_text?: string; category?: string;
  cost: number; profit: number; margin: number; recipe_count: number;
  recipes?: { recipe_id: string; recipe_name: string; qty: number; recipe_cost: number }[];
}

interface SubRecipeLine {
  recipeId: string;
  recipeName: string;
  qty: number;
  unitCost: number;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

const uid = () => crypto.randomUUID();

function marginColor(m: number) {
  if (m >= 65) return 'text-emerald-600';
  if (m >= 45) return 'text-amber-600';
  return 'text-red-500';
}

function marginBg(m: number) {
  if (m >= 65) return 'bg-emerald-100 text-emerald-700';
  if (m >= 45) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-600';
}

// ═══════════════════════════════════════════════════════════
//  FREE-TEXT INGREDIENT PARSER (AI) — shared by recipes + dishes
// ═══════════════════════════════════════════════════════════

interface ParsedIngLine {
  rawText: string;
  name: string;
  matchedItemId: string | null;
  qty: number | null;
  unit: string | null;
  costShekels: number | null;
  isApproximate: boolean;
}

interface ResolvedIngLine {
  name: string;
  invoiceKey: string;
  invoiceUnit: string;
  invoicePrice: number;
  qty: number;
  unit: string;
  costPerUnit: number | null;
  isApproximate: boolean;
  costShekels?: number;
}

function IngredientTextParser({
  catalog, onConfirm,
}: {
  catalog: InvoiceIngredient[];
  onConfirm: (lines: ResolvedIngLine[]) => void;
}) {
  const [open, setOpen]       = useState(false);
  const [text, setText]       = useState('');
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ResolvedIngLine[] | null>(null);
  const [error, setError]     = useState('');

  const resolveLine = useCallback((l: ParsedIngLine): ResolvedIngLine => {
    const item = l.matchedItemId ? catalog.find(c => c.key === l.matchedItemId) : undefined;
    // "בשווי X שקל" בלי כמות, על מרכיב שלא נמצא לו פריט מלאי תואם — אין שום
    // דרך לדעת כמה מוצר X שקל האלה קונים, אז אין להניח "1 גרם" (ברירת המחדל
    // הכללית ליחידת משקל): "בריסקט בשווי 108 שקל" הפך כך ל-108₪ *לגרם* —
    // טעות של פי ~1000 שמנפחת בשקט את עלות המנה. "1 קילוגרם" היא הנחה הגיונית
    // בהרבה לתיאור-לפי-עלות של מצרך מזון (בשר/ירקות/יבש בתפזורת), ותמיד
    // מסומנת isApproximate כדי שהמשתמש יידע לבדוק ולתקן את הכמות בפועל.
    const isUnmatchedCostOnly = !item && l.qty == null && l.costShekels != null;
    const rawUnit = l.unit || (item ? getDefaultRecipeUnit(item.latest_unit || item.unit) : (isUnmatchedCostOnly ? 'קילוגרם' : 'גרם'));
    // מנרמל לתווית הקנונית (גם אם ה-AI/המשתמש כתבו וריאציה כמו "ק״ג") כדי
    // שהערך יתאים בדיוק לאפשרויות ב-<select> ולא "ייעלם" מהתפריט הנפתח.
    const unit = resolveUnit(rawUnit)?.label || rawUnit;
    const qty  = l.qty ?? (item ? 100 : 1);
    const costPerUnit = item
      ? pricePerRecipeUnit(item.latest_price, item.latest_unit || item.unit, unit)
      : (l.costShekels && qty ? l.costShekels / qty : null);
    return {
      name:         item?.name || l.name,
      invoiceKey:   item?.key || l.name.toLowerCase(),
      invoiceUnit:  item?.latest_unit || item?.unit || unit,
      invoicePrice: item?.latest_price || 0,
      qty, unit, costPerUnit,
      isApproximate: !!l.isApproximate || isUnmatchedCostOnly,
      costShekels: isUnmatchedCostOnly ? (l.costShekels ?? undefined) : undefined,
    };
  }, [catalog]);

  const parse = async () => {
    if (!text.trim()) return;
    setParsing(true); setError(''); setPreview(null);
    try {
      const { data } = await recipesApi.parseIngredientsText(text.trim());
      const rawLines: ParsedIngLine[] = data.lines || [];
      if (!rawLines.length) { setError('לא זוהו מרכיבים בטקסט — נסה לנסח אחרת'); return; }
      setPreview(rawLines.map(resolveLine));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally { setParsing(false); }
  };

  const updateQty  = (idx: number, val: string) => {
    const n = parseFloat(val);
    setPreview(prev => prev ? prev.map((l, i) => {
      if (i !== idx) return l;
      const qty = isNaN(n) ? 0 : n;
      // כשהמחיר נגזר מ"בשווי X שקל" (לא מפריט מלאי אמיתי) — הכמות שהוצגה
      // הייתה ניחוש; ברגע שהמשתמש מזין את הכמות האמיתית שקנה, מחשבים מחדש
      // את המחיר ליחידה בפועל במקום להשאיר אותו קפוא על הניחוש הראשוני.
      const costPerUnit = l.costShekels && qty > 0 ? l.costShekels / qty : l.costPerUnit;
      return { ...l, qty, costPerUnit };
    }) : prev);
  };
  const updateUnit = (idx: number, val: string) => {
    setPreview(prev => prev ? prev.map((l, i) => {
      if (i !== idx) return l;
      const cpu = pricePerRecipeUnit(l.invoicePrice, l.invoiceUnit, val);
      return { ...l, unit: val, costPerUnit: l.invoicePrice ? cpu : l.costPerUnit };
    }) : prev);
  };
  const removeLine = (idx: number) => setPreview(prev => prev ? prev.filter((_, i) => i !== idx) : prev);

  const confirmAll = () => {
    if (!preview?.length) return;
    onConfirm(preview);
    setPreview(null); setText(''); setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors"
        style={{ background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}
      >
        <Sparkles className="w-3.5 h-3.5" /> תיאור בטקסט חופשי (AI)
      </button>
    );
  }

  return (
    <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.25)' }}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: '#a78bfa' }}>
          <Sparkles className="w-3.5 h-3.5" /> תאר את המנה במילים חופשיות
        </p>
        <button onClick={() => { setOpen(false); setPreview(null); setError(''); }} className="text-slate-400 hover:text-slate-200">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        placeholder='לדוגמה: חזה עוף 150 גרם, פירורי שניצל בשווי 3 שקל, שמן כ-10 מ"ל'
        className="w-full text-sm rounded-lg px-3 py-2 focus:outline-none resize-none"
        style={{ border: '1px solid rgba(139,92,246,0.3)', background: '#111116', color: '#e8e8e4' }}
      />
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: '#6b7280' }}>אפשר לתאר כמה מרכיבים בבת אחת, מופרדים בפסיקים</p>
        <button
          onClick={parse}
          disabled={parsing || !text.trim()}
          className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
          style={{ background: '#8b5cf6', color: 'white' }}
        >
          {parsing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          פענח עם AI
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {error}</p>
      )}

      {preview && preview.length > 0 && (
        <div className="space-y-2 pt-2" style={{ borderTop: '1px solid rgba(139,92,246,0.2)' }}>
          <p className="text-xs font-semibold" style={{ color: '#b8bcc4' }}>נמצאו {preview.length} מרכיבים — בדוק ואשר:</p>
          {preview.map((l, idx) => {
            return (
              <div key={idx} className="rounded-lg px-3 py-2 space-y-1.5" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{l.name}</p>
                    <p className="text-xs truncate" style={{ color: l.costPerUnit === null ? '#f59e0b' : '#9aa0ab' }}>
                      {l.costPerUnit === null ? 'לא נמצאה התאמה במלאי — יתווסף כידני' : `₪${l.costPerUnit.toFixed(4)}/${l.unit}`}
                      {l.isApproximate && ' · משוער'}
                    </p>
                    {l.costShekels != null && (
                      <p className="text-xs font-semibold" style={{ color: '#f59e0b' }}>
                        ⚠ תואר לפי עלות כוללת (₪{l.costShekels}) בלי כמות — הכמות ({l.qty} {l.unit}) היא הנחה. עדכן לכמות האמיתית כדי לקבל מחיר ליחידה מדויק.
                      </p>
                    )}
                  </div>
                  {l.costPerUnit !== null && (
                    <span className="text-sm font-black px-2.5 py-1 rounded-xl flex-shrink-0" style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}>
                      ₪{lineCost(l.qty ?? 0, l.costPerUnit).toFixed(2)}
                    </span>
                  )}
                  <button onClick={() => removeLine(idx)} className="text-slate-400 hover:text-red-500 flex-shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" step="any"
                    value={l.qty}
                    onChange={e => updateQty(idx, e.target.value)}
                    className="w-20 text-center text-sm font-bold rounded-lg px-2 py-1 focus:outline-none"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
                  />
                  <select
                    value={l.unit}
                    onChange={e => updateUnit(idx, e.target.value)}
                    className="flex-1 text-xs rounded-lg px-1.5 py-1 focus:outline-none"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#9aa0ab' }}
                  >
                    {/* All families always offered — not just the inventory item's own
                        (e.g. an item invoiced by the case still needs to be usable in
                        grams in a recipe). Picking a different family/unit than the
                        invoice's own just means updateUnit can't compute a price and
                        the manual-cost field appears — never a silently wrong number. */}
                    <optgroup label="משקל">{UNITS_BY_FAMILY.weight.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                    <optgroup label="נפח">{UNITS_BY_FAMILY.volume.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                    <optgroup label="יחידות">{UNITS_BY_FAMILY.unit.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                  </select>
                </div>
              </div>
            );
          })}
          <button
            onClick={confirmAll}
            className="w-full flex items-center justify-center gap-2 text-sm font-bold py-2 rounded-lg transition-colors"
            style={{ background: '#8b5cf6', color: 'white' }}
          >
            <Check className="w-4 h-4" /> הוסף {preview.length} מרכיבים לרשימה
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  RECIPE BUILDER PANEL (inline side panel)
// ═══════════════════════════════════════════════════════════

function RecipeBuilderPanel({
  editing, catalog, recipes: allRecipes, onSave, onClose,
}: {
  editing: Recipe | null;
  catalog: InvoiceIngredient[];
  recipes: Recipe[];
  onSave: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name || '');
  const [sellingPrice, setSellingPrice] = useState(editing?.selling_price?.toString() || '');
  const [lines, setLines] = useState<RecipeIngLine[]>([]);
  const [ingSearch, setIngSearch] = useState('');
  // per-line step size for +/- buttons (not saved to DB)
  const [stepSizes, setStepSizes]   = useState<Record<string, number>>({});
  const [stepInputs, setStepInputs] = useState<Record<string, string>>({});
  const getStep = (id: string) => stepSizes[id] ?? 0.1;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load existing ingredients when editing
  useEffect(() => {
    if (!editing) { setLines([]); return; }
    recipesApi.get(editing.id).then(({ data }) => {
      const loaded: RecipeIngLine[] = (data.ingredients || []).map((i: {
        item_name: string; qty: number; unit: string;
        cost_per_unit: number; manual_cost: number; manual_name: string;
      }) => {
        const ingName = i.item_name || i.manual_name || '';
        const catalogItem = catalog.find(c => c.name.toLowerCase() === ingName.toLowerCase());
        const invUnit = catalogItem?.latest_unit || i.unit || '';
        const recUnit = i.unit || 'g';
        return {
          id: uid(), name: ingName,
          invoiceKey: catalogItem?.key || ingName.toLowerCase(),
          invoiceUnit: invUnit,
          invoicePrice: catalogItem?.latest_price || i.cost_per_unit || 0,
          qty: Number(i.qty), unit: recUnit,
          costPerUnit: i.manual_cost != null
            ? Number(i.manual_cost)
            : (i.cost_per_unit != null ? pricePerRecipeUnit(i.cost_per_unit, invUnit, recUnit) : null),
        };
      });
      setLines(loaded);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const filteredCatalog = useMemo(() => {
    const q = ingSearch.toLowerCase();
    return q ? catalog.filter(c => c.name.toLowerCase().includes(q)) : catalog;
  }, [catalog, ingSearch]);

  const addIngredient = (ing: InvoiceIngredient) => {
    const defUnit = getDefaultRecipeUnit(ing.latest_unit || ing.unit);
    const cpu = pricePerRecipeUnit(ing.latest_price, ing.latest_unit || ing.unit, defUnit);
    // smart default qty: for weight/volume use 100, but mark as needing adjustment
    const fam = resolveUnit(defUnit)?.family;
    const defQty = fam === 'unit' ? 1 : 100;
    setLines(prev => [...prev, {
      id: uid(), name: ing.name,
      invoiceKey: ing.key, invoiceUnit: ing.latest_unit || ing.unit,
      invoicePrice: ing.latest_price, qty: defQty, unit: defUnit, costPerUnit: cpu,
    }]);
    setIngSearch('');
  };

  const updateLine = (id: string, field: 'qty' | 'unit' | 'invoicePrice', val: string | number) => {
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (field === 'unit') {
        const cpu = pricePerRecipeUnit(l.invoicePrice, l.invoiceUnit, val as string);
        const fromDef = resolveUnit(l.unit);
        const toDef   = resolveUnit(val as string);
        let newQty = l.qty;
        if (fromDef && toDef && fromDef.family === toDef.family && toDef.factor !== 0) {
          newQty = parseFloat(((l.qty * fromDef.factor) / toDef.factor).toFixed(6));
        }
        return { ...l, unit: val as string, costPerUnit: cpu, qty: newQty };
      }
      if (field === 'invoicePrice') {
        const price = parseFloat(String(val));
        // A genuine ₪0 price (free/complimentary ingredient) must stay 0, not
        // collapse to "not linked" — only an empty/unparseable input means null.
        // parseFloat('') / parseFloat(whitespace) both already yield NaN, so
        // hasValue alone (no separate empty-string check needed) is exact.
        const hasValue = !isNaN(price);
        const newPrice = hasValue ? price : 0;
        const cpu = l.invoiceUnit
          ? pricePerRecipeUnit(newPrice, l.invoiceUnit, l.unit)
          : (hasValue ? newPrice : null);
        return { ...l, invoicePrice: newPrice, costPerUnit: cpu };
      }
      const n = parseFloat(String(val));
      const qty = isNaN(n) ? 0 : n;
      // אותו עיקרון כמו ב-IngredientTextParser: אם המחיר נגזר מ"בשווי X שקל"
      // (אין פריט מלאי תואם), עדכון הכמות לערך האמיתי מחשב מחדש את המחיר
      // ליחידה בפועל — לא משאיר אותו קפוא על הניחוש שהוצג בהתחלה.
      const costPerUnit = l.costShekels && qty > 0 ? l.costShekels / qty : l.costPerUnit;
      return { ...l, qty, costPerUnit };
    }));
  };

  const stepQty = (id: string, delta: number) => {
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      const step = getStep(id);
      const next = Math.max(0, parseFloat((l.qty + delta * step).toFixed(6)));
      const costPerUnit = l.costShekels && next > 0 ? l.costShekels / next : l.costPerUnit;
      return { ...l, qty: next, qtyStr: undefined, costPerUnit };
    }));
  };

  // Quick preset quantities in the current unit
  const qtyPresets = (unit: string): { label: string; val: number }[] => {
    const def = resolveUnit(unit);
    if (!def) return [];
    if (def.family === 'weight') {
      // preset in grams, convert to current unit
      const presetGrams = [50, 100, 250, 500, 1000];
      return presetGrams.map(g => {
        const v = parseFloat((g / def.factor).toFixed(4));
        const label = v >= 1 ? String(v) : v.toString();
        return { label, val: v };
      });
    }
    if (def.family === 'volume') {
      const presetMl = [50, 100, 250, 500, 1000];
      return presetMl.map(ml => {
        const v = parseFloat((ml / def.factor).toFixed(4));
        return { label: String(v), val: v };
      });
    }
    return [0.5, 1, 2, 3, 5].map(v => ({ label: String(v), val: v }));
  };

  const removeLine = (id: string) => setLines(prev => prev.filter(l => l.id !== id));

  const totalCost = lines.reduce((s, l) => s + lineCost(l.qty, l.costPerUnit), 0);
  const sp = parseFloat(sellingPrice) || 0;
  const profit = sp - totalCost;
  const margin = sp > 0 ? (profit / sp) * 100 : 0;

  const handleSave = async () => {
    if (!name.trim()) { setError('שם מתכון נדרש'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        name: name.trim(),
        sellingPrice: sp,
        ingredients: lines.map(l => ({
          // invoiceKey is the real inventory_items.id when the line came from the
          // catalog; on edit-load it can fall back to a lowercased name string if
          // no catalog match was found — only forward it when it's a real UUID.
          inventoryItemId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(l.invoiceKey) ? l.invoiceKey : null,
          name: l.name,
          qty: l.qty,
          unit: l.unit,
          manualCost: l.costPerUnit,
        })),
      };
      if (editing) await recipesApi.update(editing.id, payload);
      else await recipesApi.create(payload);
      onSave();
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setSaving(false); }
  };

  // Returns { primary, all } — primary = matching family first, then the rest
  const availableUnits = (invoiceUnit: string): { primary: string[]; all: Record<string, string[]> } => {
    const fam = resolveUnit(invoiceUnit)?.family;
    // Quick-access pills: preferred family first (up to 4), then 2 from each other family
    const primary: string[] = fam ? [...UNITS_BY_FAMILY[fam].slice(0, 4)] : ['גרם', 'מיליליטר', 'יחידה'];
    (['weight', 'volume', 'unit'] as UnitFamily[]).forEach(f => {
      if (f !== fam) primary.push(...UNITS_BY_FAMILY[f].slice(0, 2));
    });
    return { primary, all: UNITS_BY_FAMILY };
  };

  return (
    <div className="fixed inset-0 z-50 flex" dir="rtl">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative mr-auto h-full w-full max-w-2xl shadow-2xl flex flex-col overflow-hidden" style={{ background: '#141418' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ background: 'var(--hero-gradient)', borderBottom: '1px solid rgba(201,162,39,0.16)' }}>
          <div className="flex items-center gap-2">
            <ChefHat className="w-5 h-5 text-white/80" />
            <h2 className="text-lg font-bold text-white">
              {editing ? `עריכת מתכון — ${editing.name}` : 'מתכון חדש'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/20 text-white/70">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Basic info */}
          <div className="grid grid-cols-2 gap-4">
            <Input label="שם המתכון" value={name} onChange={e => setName(e.target.value)} placeholder="לדוג׳: קרפצ'יו בקר" />
            <Input label="מחיר מכירה (₪)" type="number" value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} placeholder="0" />
          </div>

          {/* Ingredient search */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-semibold" style={{ color: '#b8bcc4' }}>הוסף מרכיב</label>
              <button
                onClick={() => {
                  const n = ingSearch.trim();
                  if (!n) return;
                  setLines(prev => [...prev, {
                    id: uid(), name: n,
                    invoiceKey: n.toLowerCase(), invoiceUnit: 'גרם',
                    invoicePrice: 0, qty: 0, unit: 'גרם', costPerUnit: null,
                  }]);
                  setIngSearch('');
                }}
                className="text-xs text-amber-600 hover:text-amber-700 font-semibold px-2 py-1 rounded-lg hover:bg-amber-50 transition-colors"
              >+ הוסף ידנית</button>
            </div>
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={ingSearch}
                onChange={e => setIngSearch(e.target.value)}
                placeholder="חפש מרכיב מהחשבוניות..."
                className="w-full pr-9 pl-4 py-2.5 text-sm rounded-xl focus:outline-none focus:border-amber-400 transition-colors"
                style={{ border: '2px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }}
              />
            </div>
            {ingSearch && (
              <div className="mt-1 rounded-xl overflow-hidden shadow-lg max-h-52 overflow-y-auto z-10 relative" style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418' }}>
                {filteredCatalog.length === 0 ? (
                  <div className="p-4 text-sm text-center" style={{ color: '#9aa0ab' }}>
                    <p>לא נמצא "{ingSearch}" בחשבוניות</p>
                    <button
                      onClick={() => {
                        setLines(prev => [...prev, {
                          id: uid(), name: ingSearch.trim(),
                          invoiceKey: ingSearch.toLowerCase(), invoiceUnit: 'גרם',
                          invoicePrice: 0, qty: 0, unit: 'גרם', costPerUnit: null,
                        }]);
                        setIngSearch('');
                      }}
                      className="mt-2 text-amber-600 font-semibold hover:underline"
                    >+ הוסף "{ingSearch}" ידנית</button>
                  </div>
                ) : filteredCatalog.slice(0, 12).map(ing => (
                  <button key={ing.key} onClick={() => addIngredient(ing)}
                    className="w-full flex items-center justify-between px-4 py-3 text-right transition-colors"
                    style={{ borderBottom: '1px solid rgba(201,162,39,0.1)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,162,39,0.06)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div>
                      <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>{ing.name}</p>
                      <p className="text-xs" style={{ color: '#9aa0ab' }}>
                        {ing.latest_price ? `₪${ing.latest_price.toFixed(2)}/${ing.latest_unit || ing.unit}` : '—'}
                        {' · '}{ing.times_ordered} הזמנות
                      </p>
                    </div>
                    <Plus className="w-4 h-4 text-amber-500 flex-shrink-0 mr-2" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Free-text AI ingredient parser */}
          <IngredientTextParser
            catalog={catalog}
            onConfirm={(resolvedLines) => {
              setLines(prev => [...prev, ...resolvedLines.map(l => ({ id: uid(), ...l }))]);
            }}
          />

          {/* Ingredient lines */}
          {lines.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-semibold" style={{ color: '#b8bcc4' }}>מרכיבים ({lines.length})</label>
                <span className="text-xs px-2 py-1 rounded-lg" style={{ color: '#9aa0ab', background: '#1a1a22' }}>כמות × מחיר = עלות</span>
              </div>
              <div className="space-y-3">
                {lines.map(l => {
                  const cost = lineCost(l.qty, l.costPerUnit);
                  const canConvert = l.costPerUnit !== null;
                  const { primary: quickUnits, all: allUnits } = availableUnits(l.invoiceUnit);
                  return (
                    <div key={l.id} className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${canConvert ? 'rgba(201,162,39,0.16)' : 'rgba(245,158,11,0.4)'}` }}>
                      {/* Top row: name + cost badge */}
                      <div className="flex items-center justify-between px-4 py-2.5" style={{ background: canConvert ? '#111116' : 'rgba(245,158,11,0.08)' }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{l.name}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-sm font-black px-2.5 py-1 rounded-xl ${canConvert ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                            {canConvert ? `₪${cost.toFixed(2)}` : '—'}
                          </span>
                          <button onClick={() => removeLine(l.id)} className="p-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {/* Bottom row: qty stepper + unit pills */}
                      <div className="px-4 py-3 space-y-2" style={{ background: '#141418' }}>
                        {/* ── Qty picker ── */}
                        <div className="rounded-xl p-3 space-y-3" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.12)' }}>
                          {/* Large +/− + editable number */}
                          <div className="flex items-center justify-between gap-2">
                            <button
                              onClick={() => stepQty(l.id, -1)}
                              className="flex-shrink-0 w-12 h-12 rounded-2xl text-2xl font-black flex items-center justify-center transition-colors select-none"
                              style={{ background: '#1e1e26', color: '#9aa0ab', border: '1px solid rgba(201,162,39,0.18)' }}
                            >−</button>

                            <div className="flex-1 flex flex-col items-center gap-0.5">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="הקלד כמות"
                                value={l.qtyStr !== undefined ? l.qtyStr : (l.qty === 0 ? '' : String(l.qty))}
                                onChange={e => {
                                  const raw = e.target.value;
                                  setLines(prev => prev.map(x => {
                                    if (x.id !== l.id) return x;
                                    const n = parseFloat(raw);
                                    return { ...x, qtyStr: raw, qty: isNaN(n) ? x.qty : n };
                                  }));
                                }}
                                onFocus={e => e.target.select()}
                                onBlur={() => setLines(prev => prev.map(x => {
                                  if (x.id !== l.id) return x;
                                  const n = parseFloat(x.qtyStr ?? '');
                                  return { ...x, qty: isNaN(n) ? x.qty : n, qtyStr: undefined };
                                }))}
                                onWheel={e => { e.preventDefault(); stepQty(l.id, e.deltaY < 0 ? 1 : -1); }}
                                className="w-full text-center text-2xl font-black rounded-xl px-3 py-2 focus:outline-none"
                                style={{ border: '2px solid rgba(201,162,39,0.35)', background: '#0e0e12', color: '#e8e8e4', letterSpacing: '0.02em' }}
                              />
                              <span className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>{l.unit}</span>
                            </div>

                            <button
                              onClick={() => stepQty(l.id, 1)}
                              className="flex-shrink-0 w-12 h-12 rounded-2xl text-2xl font-black flex items-center justify-center transition-colors select-none"
                              style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.35)' }}
                            >+</button>
                          </div>

                          {/* Step selector */}
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-xs font-medium" style={{ color: '#6b7280' }}>קפיצה:</span>
                            {[0.001, 0.01, 0.1, 0.5, 1, 5, 10, 50, 100].map(s => (
                              <button
                                key={s}
                                onClick={() => {
                                  setStepSizes(prev => ({ ...prev, [l.id]: s }));
                                  setStepInputs(prev => ({ ...prev, [l.id]: '' }));
                                }}
                                className="px-2 py-0.5 rounded-lg text-xs font-semibold transition-colors"
                                style={getStep(l.id) === s && !stepInputs[l.id]
                                  ? { background: '#c9a227', color: '#0a0a0e', border: '1px solid #c9a227' }
                                  : { background: '#1a1a22', color: '#9aa0ab', border: '1px solid rgba(201,162,39,0.14)' }}
                              >{s}</button>
                            ))}
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="אחר"
                              value={stepInputs[l.id] ?? ''}
                              onFocus={e => e.target.select()}
                              onChange={e => {
                                const raw = e.target.value;
                                setStepInputs(prev => ({ ...prev, [l.id]: raw }));
                                const n = parseFloat(raw);
                                if (!isNaN(n) && n > 0) setStepSizes(prev => ({ ...prev, [l.id]: n }));
                              }}
                              className="rounded-lg text-xs text-center focus:outline-none"
                              style={{
                                width: 52,
                                background: stepInputs[l.id] ? '#1a1a20' : '#1a1a22',
                                color: stepInputs[l.id] ? '#c9a227' : '#9aa0ab',
                                border: stepInputs[l.id] ? '1px solid #c9a227' : '1px solid rgba(201,162,39,0.14)',
                                padding: '2px 4px',
                              }}
                            />
                          </div>

                          {/* Quick preset chips */}
                          {qtyPresets(l.unit).length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap">
                              <span className="text-xs font-medium" style={{ color: '#6b7280' }}>מהיר:</span>
                              {qtyPresets(l.unit).map(p => (
                                <button
                                  key={p.val}
                                  onClick={() => updateLine(l.id, 'qty', p.val)}
                                  className="px-2.5 py-1 rounded-xl text-xs font-semibold transition-colors"
                                  style={Math.abs(l.qty - p.val) < 0.0001
                                    ? { background: '#f59e0b', color: '#0a0a0e', border: '1px solid #f59e0b' }
                                    : { background: '#1a1a22', color: '#9aa0ab', border: '1px solid rgba(201,162,39,0.14)' }}
                                >{p.label}</button>
                              ))}
                            </div>
                          )}
                        </div>{/* end qty picker */}

                        {/* Unit pills — primary (preferred) row */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {quickUnits.map(u => (
                            <button
                              key={u}
                              onClick={() => updateLine(l.id, 'unit', u)}
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
                            style={l.unit === u
                              ? { background: '#f59e0b', color: '#0a0a0e', border: '1px solid #f59e0b' }
                              : { background: '#1a1a22', color: '#9aa0ab', border: '1px solid rgba(201,162,39,0.2)' }}
                            >{u}</button>
                          ))}
                          {/* Full unit picker grouped by family */}
                          <select
                            value=""
                            onChange={e => e.target.value && updateLine(l.id, 'unit', e.target.value)}
                            className="px-2 py-1 rounded-lg text-xs focus:outline-none focus:border-amber-400"
                            style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#1a1a22', color: '#9aa0ab' }}
                          >
                            <option value="">כל היחידות ▾</option>
                            <optgroup label="⚖️ משקל">
                              {allUnits.weight.map(u => <option key={u} value={u}>{u}</option>)}
                            </optgroup>
                            <optgroup label="🥛 נפח">
                              {allUnits.volume.map(u => <option key={u} value={u}>{u}</option>)}
                            </optgroup>
                            <optgroup label="📦 יחידות">
                              {allUnits.unit.map(u => <option key={u} value={u}>{u}</option>)}
                            </optgroup>
                          </select>
                        </div>
                        {/* Price editor — always visible */}
                        {(() => {
                          const priceLabel = l.invoiceUnit || l.unit;
                          const sliderMax  = Math.max((l.invoicePrice || 1) * 4, 20);
                          return (
                            <div className="mt-1 rounded-xl px-3 py-2.5 space-y-2" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.14)' }}>
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>
                                  💰 מחיר ל-{priceLabel}
                                </span>
                                {!canConvert && (
                                  <span className="text-xs flex items-center gap-1" style={{ color: '#f59e0b' }}>
                                    <AlertTriangle className="w-3 h-3" /> לא מחובר למלאי
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                <input
                                  type="range" min={0} max={sliderMax} step={sliderMax > 50 ? 1 : 0.1}
                                  value={l.invoicePrice || 0}
                                  onChange={e => updateLine(l.id, 'invoicePrice', e.target.value)}
                                  className="flex-1 accent-amber-400"
                                  style={{ cursor: 'pointer' }}
                                />
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <span className="text-xs" style={{ color: '#9aa0ab' }}>₪</span>
                                  <input
                                    type="number" min="0" step="0.01"
                                    value={l.invoicePrice || ''}
                                    onChange={e => updateLine(l.id, 'invoicePrice', e.target.value)}
                                    className="w-20 text-center text-sm font-bold rounded-lg px-2 py-1 focus:outline-none"
                                    style={{ border: '1px solid rgba(201,162,39,0.3)', background: '#1a1a22', color: '#e8e8e4' }}
                                  />
                                </div>
                              </div>
                              {canConvert && l.costPerUnit !== null && (
                                <p className="text-xs" style={{ color: '#6b7280' }}>
                                  = ₪{l.costPerUnit.toFixed(4)} ל-{l.unit} · עלות שורה: <span style={{ color: '#c9a227', fontWeight: 700 }}>₪{lineCost(l.qty, l.costPerUnit).toFixed(2)}</span>
                                </p>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {lines.length === 0 && !ingSearch && (
            <div className="flex flex-col items-center py-10 rounded-2xl" style={{ color: '#9aa0ab', border: '2px dashed rgba(201,162,39,0.16)', background: '#111116' }}>
              <UtensilsCrossed className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">אין מרכיבים עדיין</p>
              <p className="text-xs mt-1" style={{ color: '#9aa0ab' }}>חפש מרכיב מהחשבוניות למעלה, או הוסף ידנית</p>
            </div>
          )}
        </div>

        {/* Footer — cost summary + save */}
        <div className="px-6 py-4 space-y-3" style={{ borderTop: '1px solid rgba(201,162,39,0.14)', background: '#111116' }}>
          {/* Cost breakdown */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl p-3 text-center" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
              <p className="text-xs" style={{ color: '#9aa0ab' }}>עלות חומרי גלם</p>
              <p className="text-lg font-bold mt-0.5" style={{ color: '#e8e8e4' }}>{formatCurrency(totalCost)}</p>
            </div>
            <div className="rounded-xl p-3 text-center" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
              <p className="text-xs" style={{ color: '#9aa0ab' }}>רווח גולמי</p>
              <p className={`text-lg font-bold mt-0.5 ${profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatCurrency(profit)}
              </p>
            </div>
            <div className={`rounded-xl border p-3 text-center ${marginBg(margin)}`}>
              <p className="text-xs opacity-70">מרג׳ין</p>
              <p className="text-lg font-bold mt-0.5">{margin.toFixed(1)}%</p>
            </div>
          </div>

          {/* Optimal price suggestion for recipes */}
          {lines.length > 0 && totalCost > 0 && (() => {
            const TARGET_MARGIN = 0.68;
            const optPrice = Math.ceil(totalCost / (1 - TARGET_MARGIN));
            const diff = sp > 0 ? optPrice - sp : null;
            return (
              <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border ${
                diff !== null && diff > 0 ? 'bg-amber-50 border-amber-200' :
                diff !== null && diff < 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-blue-50 border-blue-200'
              }`}>
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className={`w-4 h-4 flex-shrink-0 ${diff && diff > 0 ? 'text-amber-500' : 'text-emerald-500'}`} />
                  <div>
                    <p className="text-xs font-semibold text-slate-700">
                      מחיר אופטימלי (68%): <span className="font-black">₪{optPrice}</span>
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {diff === null ? 'הגדר מחיר מכירה' :
                       diff > 0 ? `נמוך ב-₪${diff} מהאופטימלי` :
                       diff < 0 ? `מעל האופטימלי — מרג׳ין מצוין` : 'מחיר מושלם'}
                    </p>
                  </div>
                </div>
                {diff !== null && diff > 0 && (
                  <button onClick={() => setSellingPrice(String(optPrice))}
                    className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white hover:bg-amber-600 transition-colors">
                    קבע ₪{optPrice}
                  </button>
                )}
              </div>
            );
          })()}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl border border-red-100">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose}>ביטול</Button>
            <Button onClick={handleSave} loading={saving}
              className="border-0 shadow-md"
              style={{ background: 'var(--hero-gradient)', color: 'white' }}>
              <Check className="w-4 h-4" /> {editing ? 'עדכן מתכון' : 'שמור מתכון'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  DISH BUILDER MODAL
// ═══════════════════════════════════════════════════════════

const DISH_CATEGORIES = ['ראשונות', 'עיקריות', 'צדדים', 'קינוחים', 'משקאות', 'אחר'];

function DishBuilderModal({
  editing, catalog, allRecipes, onSave, onClose,
}: {
  editing: DishDetail | null;
  catalog: InvoiceIngredient[];
  allRecipes: Recipe[];
  onSave: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name || '');
  const [sellingPrice, setSellingPrice] = useState(editing?.selling_price?.toString() || '');
  const [notes, setNotes] = useState(editing?.notes || '');
  const [category, setCategory] = useState(editing?.category || '');
  const [dishType, setDishType] = useState<'dine_in' | 'takeaway' | 'both'>((editing?.dish_type as 'dine_in' | 'takeaway' | 'both') || 'both');
  const [lines, setLines] = useState<RecipeIngLine[]>([]);
  const [subRecipes, setSubRecipes] = useState<SubRecipeLine[]>([]);
  const [accLines, setAccLines] = useState<{ id: string; item_name: string; inventoryItemId: string | null; order_type: 'dine_in' | 'takeaway' | 'both'; qty: number; unit: string; manualCost: number | null; unit_cost?: number | null }[]>([]);
  const [accSearch, setAccSearch] = useState('');
  const [recipeSearch, setRecipeSearch] = useState('');
  const [ingSearch, setIngSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stockItems, setStockItems] = useState<{ id: string; name: string; current_qty: number; unit: string; min_qty: number }[]>([]);
  const [showStock, setShowStock] = useState(false);
  const [stockSearch, setStockSearch] = useState('');
  const { toast } = useAppDialog();

  // טוען נתוני מנה קיימת (מרכיבים + תת-מתכונים + ליווי) — תלוי רק ב-id
  useEffect(() => {
    if (!editing) { setLines([]); setSubRecipes([]); setAccLines([]); return; }
    dishesApi.get(editing.id).then(({ data }) => {
      // sub-recipes
      const sr: SubRecipeLine[] = (data.dish?.recipes || []).map((r: { recipe_id: string; recipe_name: string; qty: number; recipe_cost: number }) => ({
        recipeId: r.recipe_id,
        recipeName: r.recipe_name,
        qty: Number(r.qty) || 1,
        unitCost: Number(r.recipe_cost) || 0,
      }));
      setSubRecipes(sr);
      const loaded: RecipeIngLine[] = (data.dish?.ingredients || []).map((i: {
        ingredient_name: string; qty: number; unit: string; unit_cost: number; inventory_item_id?: string;
      }) => {
        const ingName = i.ingredient_name || '';
        const catalogItem = catalog.find(c => c.key === i.inventory_item_id)
          || catalog.find(c => c.name.toLowerCase() === ingName.toLowerCase());
        return {
          id: uid(), name: ingName,
          invoiceKey: catalogItem?.key || i.inventory_item_id || ingName.toLowerCase(),
          invoiceUnit: catalogItem?.latest_unit || i.unit || '',
          invoicePrice: catalogItem?.latest_price || 0,
          qty: Number(i.qty), unit: i.unit || 'גרם',
          costPerUnit: i.unit_cost ?? null,
        };
      });
      setLines(loaded);
      // accompaniments
      const accLoaded = (data.dish?.accompaniments || []).map((a: {
        item_name: string; inventory_item_id?: string; order_type: string; qty: number; unit: string; manual_cost?: number; unit_cost?: number;
      }) => ({
        id: uid(),
        item_name: a.item_name || '',
        inventoryItemId: a.inventory_item_id || null,
        order_type: (a.order_type || 'both') as 'dine_in' | 'takeaway' | 'both',
        qty: Number(a.qty) || 1,
        unit: a.unit || 'יחידה',
        manualCost: a.manual_cost ?? null,
        unit_cost: a.unit_cost ?? null,
      }));
      setAccLines(accLoaded);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  useEffect(() => {
    inventoryApi.list().then(({ data }) => {
      const items = (data.items || data || []) as { id: string; name: string; current_qty: number; unit: string; min_qty: number }[];
      setStockItems(items.sort((a, b) => a.current_qty - b.current_qty));
    }).catch(() => {});
  }, []);

  const sp = parseFloat(sellingPrice) || 0;
  const ingCost = lines.reduce((s, l) => s + lineCost(l.qty, l.costPerUnit), 0);
  const subRecipeCost = subRecipes.reduce((s, r) => s + r.unitCost * r.qty, 0);
  const accCost = accLines.reduce((s, a) => s + (a.qty * (a.unit_cost ?? a.manualCost ?? 0)), 0);
  const totalCost = ingCost + subRecipeCost + accCost;
  const profit = sp - totalCost;
  const margin = sp > 0 ? (profit / sp) * 100 : 0;

  const filteredAccCatalog = useMemo(() => {
    const q = accSearch.trim().toLowerCase();
    if (!q) return [];
    return catalog.filter(c => c.name.toLowerCase().includes(q)).slice(0, 10);
  }, [catalog, accSearch]);

  const removeLine = (id: string) => setLines(prev => prev.filter(l => l.id !== id));

  // ── הוספת מרכיב ידנית — חיפוש במלאי + לחיצה, או הקלדת שם חדש לגמרי ──
  // דרך נוחה להוסיף מרכיבים בלי לעבור דרך תיאור-בטקסט-חופשי ל-AI, לשימוש כשכבר
  // יודעים בדיוק מה רוצים להוסיף. אין כפתורי חיצים בשום מקום — כמות מוקלדת חופשי.
  const filteredIngCatalog = useMemo(() => {
    const q = ingSearch.trim().toLowerCase();
    if (!q) return [];
    return catalog.filter(c => c.name.toLowerCase().includes(q)).slice(0, 10);
  }, [catalog, ingSearch]);

  const addIngredientFromCatalog = (ing: InvoiceIngredient) => {
    const defUnit = getDefaultRecipeUnit(ing.latest_unit || ing.unit);
    const cpu = pricePerRecipeUnit(ing.latest_price, ing.latest_unit || ing.unit, defUnit);
    const fam = resolveUnit(defUnit)?.family;
    const defQty = fam === 'unit' ? 1 : 100;
    setLines(prev => [...prev, {
      id: uid(), name: ing.name,
      invoiceKey: ing.key, invoiceUnit: ing.latest_unit || ing.unit,
      invoicePrice: ing.latest_price, qty: defQty, unit: defUnit, costPerUnit: cpu,
    }]);
    setIngSearch('');
  };

  const addManualIngredient = (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    // אין מקור מחיר (לא מהמלאי, לא תיאור-עלות מה-AI) — עלות ליחידה נשארת ריקה
    // עד שהמשתמש ימלא אותה בעצמו (יוצג "—" ברשימת המרכיבים, סימן ברור לפעולה).
    setLines(prev => [...prev, {
      id: uid(), name: trimmed,
      invoiceKey: trimmed.toLowerCase(), invoiceUnit: 'גרם',
      invoicePrice: 0, qty: 0, unit: 'גרם', costPerUnit: null,
    }]);
    setIngSearch('');
  };

  const updateQty = (id: string, val: string) => {
    const n = parseFloat(val);
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      const qty = isNaN(n) ? 0 : n;
      // אותו עיקרון כמו ב-IngredientTextParser: אם המחיר נגזר מ"בשווי X שקל"
      // (אין פריט מלאי תואם), עדכון הכמות לערך האמיתי מחשב מחדש את המחיר
      // ליחידה בפועל — לא משאיר אותו קפוא על הניחוש שהוצג בהתחלה.
      const costPerUnit = l.costShekels && qty > 0 ? l.costShekels / qty : l.costPerUnit;
      return { ...l, qty, costPerUnit };
    }));
  };
  const updateUnit = (id: string, val: string) => {
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      const cpu = l.invoiceUnit ? pricePerRecipeUnit(l.invoicePrice, l.invoiceUnit, val) : l.costPerUnit;
      return { ...l, unit: val, costPerUnit: cpu };
    }));
  };
  // רק למרכיבים שלא מקושרים למלאי אמיתי (invoicePrice=0) — עריכה ישירה של
  // מחיר ליחידה, לשימוש כשמוסיפים מרכיב ידני עם שם חופשי ואין מקור מחיר אוטומטי.
  const updateManualCost = (id: string, val: string) => {
    const n = parseFloat(val);
    setLines(prev => prev.map(l => l.id === id ? { ...l, costPerUnit: val === '' ? null : (isNaN(n) ? l.costPerUnit : n) } : l));
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('שם מנה נדרש'); return; }
    setSaving(true); setError('');
    try {
      // תיאור טקסטואלי אוטומטי (לצורך תצוגה/הקשר ל-AI בלבד) — נגזר מרשימת
      // המרכיבים המובנית בפועל, כדי שלא יהיו שני מקורות אמת לא-מסונכרנים.
      const recipeText = lines
        .map(l => `${l.qty % 1 === 0 ? l.qty : l.qty.toFixed(2)} ${l.unit} ${l.name}`)
        .join(', ') || null;
      const payload = {
        name: name.trim(), sellingPrice: sp, notes, dishType, category: category || null, recipeText,
        recipes: subRecipes.map(r => ({ recipeId: r.recipeId, qty: r.qty })),
        ingredients: lines.map(l => ({
          inventoryItemId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(l.invoiceKey) ? l.invoiceKey : null,
          name: l.name,
          qty: l.qty,
          unit: l.unit,
          manualCost: l.costPerUnit,
        })),
        accompaniments: accLines.map(a => ({
          inventoryItemId: a.inventoryItemId,
          item_name: a.item_name,
          order_type: a.order_type,
          qty: a.qty,
          unit: a.unit,
          manualCost: a.manualCost,
        })),
      };
      if (editing) await dishesApi.update(editing.id, payload);
      else await dishesApi.create(payload);
      toast('המנה נשמרה ✓', 'success');
      onSave();
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={editing ? `עריכת מנה — ${editing.name}` : 'מנה חדשה'} size="lg">
      <div className="space-y-5 p-1" dir="rtl">

        <div className="grid grid-cols-2 gap-4">
          <Input label="שם המנה" value={name} onChange={e => setName(e.target.value)} placeholder="לדוג׳: פילה בקר ברוטב פטריות" />
          <Input label="מחיר מכירה (₪)" type="number" value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} />
        </div>
        <Input label="הערות (אופציונלי)" value={notes} onChange={e => setNotes(e.target.value)} placeholder="תיאור, הגשה, אלרגנים..." />

        {/* ── קטגוריה ── */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">קטגוריה בתפריט</label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => setCategory('')}
              className={`px-3 py-1.5 rounded-xl text-sm font-semibold border transition-all ${!category ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
              ללא
            </button>
            {DISH_CATEGORIES.map(cat => (
              <button key={cat} type="button" onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 rounded-xl text-sm font-semibold border transition-all ${category === cat ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-white text-slate-500 border-slate-200 hover:border-amber-300'}`}>
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* ── סוג הזמנה ── */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">סוג הגשה</label>
          <div className="flex gap-2">
            {([
              { val: 'both',     label: 'ישיבה + טייק-אווי' },
              { val: 'dine_in',  label: 'ישיבה במקום' },
              { val: 'takeaway', label: 'טייק-אווי בלבד' },
            ] as { val: typeof dishType; label: string }[]).map(o => (
              <button key={o.val} type="button"
                onClick={() => setDishType(o.val)}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition-all ${
                  dishType === o.val
                    ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
                    : 'bg-white text-slate-500 border-slate-200 hover:border-amber-300'
                }`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── הרכב המנה — תיאור חופשי הופך אוטומטית למרכיבים עם עלות ── */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
            <ChefHat className="w-4 h-4 text-amber-500" />
            הרכב המנה
          </label>
          <p className="text-xs text-slate-400 mb-2">
            תאר את המנה במילים חופשיות — המערכת תזהה את המרכיבים, תתאים אותם למלאי ותחשב את העלות והמרת היחידות אוטומטית. אין צורך לחשב כלום בעצמך.
          </p>
          <IngredientTextParser
            catalog={catalog}
            onConfirm={(resolvedLines) => {
              setLines(prev => [...prev, ...resolvedLines.map(l => ({ id: uid(), ...l }))]);
            }}
          />
        </div>

        {/* ── הוספת מרכיב ידנית — חיפוש מהמלאי ולחיצה, בלי AI ── */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
            <Search className="w-4 h-4 text-amber-500" />
            או הוסף מרכיב ידנית
          </label>
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={ingSearch}
              onChange={e => setIngSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && filteredIngCatalog.length === 0 && ingSearch.trim()) addManualIngredient(ingSearch);
              }}
              placeholder="חפש חומר גלם מהמלאי, או הקלד שם חדש..."
              className="w-full pr-9 pl-4 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
          {ingSearch && (
            <div className="mt-1 rounded-xl overflow-hidden shadow-lg border border-slate-200 max-h-52 overflow-y-auto">
              {filteredIngCatalog.length > 0 ? filteredIngCatalog.map(ing => (
                <button key={ing.key} type="button" onClick={() => addIngredientFromCatalog(ing)}
                  className="w-full text-right px-4 py-2.5 text-sm hover:bg-amber-50 border-b border-slate-50 last:border-0 flex items-center justify-between gap-2 transition-colors"
                >
                  <span className="font-medium text-slate-700">{ing.name}</span>
                  <span className="text-xs text-slate-400 flex-shrink-0">
                    {ing.latest_price ? `₪${ing.latest_price.toFixed(2)}/${ing.latest_unit || ing.unit}` : 'ללא מחיר'}
                  </span>
                </button>
              )) : (
                <div className="p-3 text-sm text-center text-slate-400">
                  <p>לא נמצא &quot;{ingSearch}&quot; במלאי</p>
                  <button type="button" onClick={() => addManualIngredient(ingSearch)}
                    className="mt-1.5 text-amber-600 font-semibold hover:underline">
                    + הוסף &quot;{ingSearch}&quot; ידנית
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── תת-מתכונים ── */}
        {allRecipes.length > 0 && (
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
              <ChefHat className="w-4 h-4 text-violet-500" />
              תת-מתכונים (מתכוני בסיס)
            </label>
            <p className="text-xs text-slate-400 mb-2">הוסף מתכונים שלמים כרכיב במנה (לדוג׳: מתכון רוטב שמשמש כמה מנות)</p>

            {/* בחירת מתכון */}
            <div className="relative mb-2">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={recipeSearch}
                onChange={e => setRecipeSearch(e.target.value)}
                placeholder="חפש מתכון..."
                className="w-full pr-9 pl-4 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-400"
              />
            </div>
            {recipeSearch && (
              <div className="mb-2 rounded-xl overflow-hidden shadow-sm border border-slate-200 max-h-40 overflow-y-auto">
                {allRecipes
                  .filter(r => r.name.toLowerCase().includes(recipeSearch.toLowerCase()) && !subRecipes.some(s => s.recipeId === r.id))
                  .slice(0, 8)
                  .map(r => (
                    <button key={r.id} type="button"
                      onClick={() => {
                        setSubRecipes(prev => [...prev, { recipeId: r.id, recipeName: r.name, qty: 1, unitCost: 0 }]);
                        setRecipeSearch('');
                      }}
                      className="w-full text-right px-4 py-2.5 text-sm hover:bg-violet-50 border-b border-slate-50 last:border-0 flex items-center justify-between gap-2 transition-colors"
                    >
                      <span className="font-medium text-slate-700">{r.name}</span>
                      <Plus className="w-4 h-4 text-violet-500 flex-shrink-0" />
                    </button>
                  ))}
                {allRecipes.filter(r => r.name.toLowerCase().includes(recipeSearch.toLowerCase()) && !subRecipes.some(s => s.recipeId === r.id)).length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-3">לא נמצא מתכון מתאים</p>
                )}
              </div>
            )}

            {/* רשימת תת-מתכונים שנבחרו */}
            {subRecipes.length > 0 && (
              <div className="space-y-2">
                {subRecipes.map((sr, idx) => (
                  <div key={sr.recipeId} className="flex items-center gap-3 bg-violet-50 border border-violet-100 rounded-xl px-3 py-2.5">
                    <ChefHat className="w-4 h-4 text-violet-500 flex-shrink-0" />
                    <span className="flex-1 text-sm font-semibold text-slate-700 truncate">{sr.recipeName}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-xs text-slate-400">×</span>
                      <input
                        type="number" min="0.1" step="0.5"
                        value={sr.qty}
                        onChange={e => {
                          const v = parseFloat(e.target.value) || 1;
                          setSubRecipes(prev => prev.map((r, i) => i === idx ? { ...r, qty: v } : r));
                        }}
                        className="w-16 text-center text-sm font-bold border border-violet-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
                      />
                    </div>
                    {sr.unitCost > 0 && (
                      <span className="text-xs font-semibold text-violet-700 bg-violet-100 px-2 py-0.5 rounded-lg flex-shrink-0">
                        ₪{(sr.unitCost * sr.qty).toFixed(2)}
                      </span>
                    )}
                    <button type="button" onClick={() => setSubRecipes(prev => prev.filter((_, i) => i !== idx))}
                      className="text-slate-300 hover:text-red-500 flex-shrink-0 transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── רשימת המרכיבים שאושרו ── */}
        {lines.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-slate-700">מרכיבים ({lines.length})</label>
              <span className="text-xs text-slate-400">כמות × מחיר = עלות</span>
            </div>
            <div className="space-y-2">
              {lines.map(l => {
                const cost = lineCost(l.qty, l.costPerUnit);
                return (
                  <div key={l.id} className="flex items-center gap-2 rounded-xl px-3 py-2.5 bg-slate-50 border border-slate-100">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{l.name}</p>
                      {l.costPerUnit !== null && (
                        <p className="text-xs text-slate-400">₪{l.costPerUnit.toFixed(4)} ל-{l.unit}</p>
                      )}
                      {l.costShekels != null && (
                        <p className="text-xs font-semibold text-amber-500">
                          ⚠ מבוסס על עלות כוללת (₪{l.costShekels}) שהוזנה — עדכן את הכמות בפועל כדי לקבל מחיר ליחידה מדויק
                        </p>
                      )}
                      {/* אין מחיר מחושב — או שהמרכיב הוזן בשם חופשי בלי מחיר ממלאי/AI,
                          או שנבחרה יחידה שאין לה המרה אמינה מיחידת החשבונית (למשל
                          ארגז מול פחית בודדת — אין יחס אחיד ביניהם). בכל מקרה, עריכת
                          מחיר ישירה כי אין מקור אוטומטי שיוכל למלא אותו. */}
                      {l.costPerUnit === null && l.costShekels == null && (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-slate-400">₪</span>
                          <input
                            type="number" min="0" step="any"
                            placeholder="מחיר ליחידה"
                            value={l.costPerUnit ?? ''}
                            onChange={e => updateManualCost(l.id, e.target.value)}
                            className="w-24 text-xs rounded-lg px-2 py-1 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
                          />
                          <span className="text-xs text-slate-400">ל-{l.unit}</span>
                        </div>
                      )}
                    </div>
                    <input
                      type="number" min="0" step="any"
                      value={l.qty}
                      onChange={e => updateQty(l.id, e.target.value)}
                      className="w-20 text-center text-sm font-bold rounded-lg px-2 py-1.5 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-400"
                    />
                    <select
                      value={l.unit}
                      onChange={e => updateUnit(l.id, e.target.value)}
                      className="text-xs rounded-lg px-1.5 py-1.5 border border-slate-200 text-slate-600 focus:outline-none"
                    >
                      {/* All families always offered, not just the ingredient's own
                          inventory family — an item invoiced by the case still needs
                          to be usable in grams in a recipe. */}
                      <optgroup label="משקל">{UNITS_BY_FAMILY.weight.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                      <optgroup label="נפח">{UNITS_BY_FAMILY.volume.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                      <optgroup label="יחידות">{UNITS_BY_FAMILY.unit.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                    </select>
                    <span className={`text-sm font-black px-2.5 py-1 rounded-xl flex-shrink-0 ${l.costPerUnit !== null ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                      {l.costPerUnit !== null ? `₪${cost.toFixed(2)}` : '—'}
                    </span>
                    <button onClick={() => removeLine(l.id)} className="text-slate-300 hover:text-red-500 flex-shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
            {sp > 0 && (
              <div className="mt-3 flex items-center justify-between px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-100 text-sm">
                <span className="font-semibold text-slate-600">עלות: ₪{totalCost.toFixed(2)} · רווח: ₪{profit.toFixed(2)}</span>
                <span className={`font-bold ${margin >= 65 ? 'text-emerald-600' : margin >= 45 ? 'text-amber-600' : 'text-red-500'}`}>{margin.toFixed(1)}% מרג'ין</span>
              </div>
            )}
          </div>
        )}

        {/* ── ליווי קבוע למנה ── */}
        <div className="border border-teal-100 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-teal-50">
            <span className="text-sm font-semibold text-teal-800 flex items-center gap-2">
              <Package className="w-4 h-4 text-teal-600" />
              ליווי קבוע למנה
              {accLines.length > 0 && <span className="text-xs bg-teal-200 text-teal-700 px-2 py-0.5 rounded-full">{accLines.length}</span>}
            </span>
            <span className="text-xs text-teal-600">
              {accLines.length > 0 ? `עלות: ₪${accCost.toFixed(2)}` : 'לחץ + להוספה'}
            </span>
          </div>
          <div className="p-3 space-y-2">
            <p className="text-xs text-slate-400">
              פריטים שמוגשים תמיד עם המנה (לחם, חומוס, סלט...) — ינוכו מהמלאי בכל מכירה ויחושבו בעלות המנה.
            </p>
            {/* חיפוש מהמלאי */}
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={accSearch}
                onChange={e => setAccSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && filteredAccCatalog.length === 0 && accSearch.trim()) {
                    setAccLines(prev => [...prev, { id: uid(), item_name: accSearch.trim(), inventoryItemId: null, order_type: 'both', qty: 1, unit: 'יחידה', manualCost: null }]);
                    setAccSearch('');
                  }
                }}
                placeholder="חפש פריט מהמלאי, או הקלד שם ולחץ Enter..."
                className="w-full pr-9 pl-4 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
            </div>
            {accSearch && (
              <div className="rounded-xl overflow-hidden shadow-sm border border-slate-200 max-h-40 overflow-y-auto">
                {filteredAccCatalog.length > 0 ? filteredAccCatalog.map(ing => (
                  <button key={ing.key} type="button"
                    onClick={() => {
                      setAccLines(prev => [...prev, {
                        id: uid(),
                        item_name: ing.name,
                        inventoryItemId: /^[0-9a-f-]{36}$/i.test(ing.key) ? ing.key : null,
                        order_type: 'both',
                        qty: 1,
                        unit: ing.latest_unit || ing.unit || 'יחידה',
                        manualCost: ing.latest_price || null,
                        unit_cost: ing.latest_price || null,
                      }]);
                      setAccSearch('');
                    }}
                    className="w-full text-right px-4 py-2 text-sm hover:bg-teal-50 border-b border-slate-50 last:border-0 flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-700">{ing.name}</span>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {ing.latest_price ? `₪${ing.latest_price.toFixed(2)}/${ing.latest_unit || ing.unit}` : 'ללא מחיר'}
                    </span>
                  </button>
                )) : (
                  <div className="p-3 text-sm text-center text-slate-400">
                    <p>לא נמצא &quot;{accSearch}&quot;</p>
                    <button type="button"
                      onClick={() => { setAccLines(prev => [...prev, { id: uid(), item_name: accSearch.trim(), inventoryItemId: null, order_type: 'both', qty: 1, unit: 'יחידה', manualCost: null }]); setAccSearch(''); }}
                      className="mt-1 text-teal-600 font-semibold hover:underline text-xs">
                      + הוסף &quot;{accSearch}&quot; ידנית
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* רשימת ליווי */}
            {accLines.map(a => (
              <div key={a.id} className="rounded-xl px-3 py-2 bg-teal-50 border border-teal-100 space-y-1.5">
                <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{a.item_name}</p>
                  {/* כשאין קישור למלאי ואין עלות — מאפשר הזנת עלות ידנית */}
                  {a.unit_cost == null && a.inventoryItemId == null && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-xs text-slate-400">₪</span>
                      <input
                        type="number" min="0" step="any"
                        placeholder="עלות ליחידה"
                        value={a.manualCost ?? ''}
                        onChange={e => setAccLines(prev => prev.map(x => x.id === a.id ? { ...x, manualCost: e.target.value === '' ? null : parseFloat(e.target.value) } : x))}
                        className="w-24 text-xs rounded-lg px-2 py-1 border border-teal-200 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white"
                      />
                      <span className="text-xs text-slate-400">ל-{a.unit}</span>
                    </div>
                  )}
                </div>
                {/* כמות */}
                <input
                  type="number" min="0.01" step="any"
                  value={a.qty}
                  onChange={e => setAccLines(prev => prev.map(x => x.id === a.id ? { ...x, qty: parseFloat(e.target.value) || 1 } : x))}
                  className="w-16 text-center text-sm font-bold border border-teal-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white"
                />
                {/* יחידה */}
                <select
                  value={a.unit}
                  onChange={e => setAccLines(prev => prev.map(x => x.id === a.id ? { ...x, unit: e.target.value } : x))}
                  className="text-xs rounded-lg px-1.5 py-1.5 border border-teal-200 text-slate-600 focus:outline-none bg-white"
                >
                  <optgroup label="משקל">{UNITS_BY_FAMILY.weight.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                  <optgroup label="נפח">{UNITS_BY_FAMILY.volume.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                  <optgroup label="יחידות">{UNITS_BY_FAMILY.unit.map(u => <option key={u} value={u}>{u}</option>)}</optgroup>
                </select>
                {/* סוג הגשה */}
                <select
                  value={a.order_type}
                  onChange={e => setAccLines(prev => prev.map(x => x.id === a.id ? { ...x, order_type: e.target.value as 'dine_in' | 'takeaway' | 'both' } : x))}
                  className="text-xs rounded-lg px-1.5 py-1.5 border border-teal-200 text-slate-600 focus:outline-none bg-white"
                >
                  <option value="both">ישיבה + טייק</option>
                  <option value="dine_in">ישיבה בלבד</option>
                  <option value="takeaway">טייק-אווי בלבד</option>
                </select>
                {/* עלות */}
                {(a.unit_cost != null || a.manualCost != null) && (
                  <span className="text-xs font-semibold text-teal-700 bg-teal-100 px-2 py-0.5 rounded-lg flex-shrink-0">
                    ₪{(a.qty * (a.unit_cost ?? a.manualCost ?? 0)).toFixed(2)}
                  </span>
                )}
                <button type="button"
                  onClick={() => setAccLines(prev => prev.filter(x => x.id !== a.id))}
                  className="text-slate-300 hover:text-red-500 flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── מלאי זמין ── */}
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowStock(p => !p)}
            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-right"
          >
            <span className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Package className="w-4 h-4 text-amber-500" />
              חומרי גלם במלאי ({stockItems.length})
            </span>
            <span className="text-xs text-slate-400">{showStock ? '▲' : '▼'}</span>
          </button>
          {showStock && (
            <div className="p-3 space-y-2">
              <input
                value={stockSearch}
                onChange={e => setStockSearch(e.target.value)}
                placeholder="חפש חומר גלם..."
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <div className="max-h-48 overflow-y-auto space-y-1">
                {stockItems
                  .filter(i => !stockSearch || i.name.toLowerCase().includes(stockSearch.toLowerCase()))
                  .map(item => {
                    const isLow = item.min_qty > 0 && item.current_qty <= item.min_qty;
                    const isEmpty = item.current_qty <= 0;
                    return (
                      <div key={item.id} className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${isEmpty ? 'bg-red-50' : isLow ? 'bg-amber-50' : 'bg-white border border-slate-100'}`}>
                        <span className={`font-medium truncate ${isEmpty ? 'text-red-700' : isLow ? 'text-amber-700' : 'text-slate-700'}`}>{item.name}</span>
                        <span className={`font-bold flex-shrink-0 mr-3 ${isEmpty ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {item.current_qty % 1 === 0 ? item.current_qty : item.current_qty.toFixed(2)} {item.unit}
                        </span>
                      </div>
                    );
                  })}
                {stockItems.filter(i => !stockSearch || i.name.toLowerCase().includes(stockSearch.toLowerCase())).length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-3">לא נמצאו פריטים</p>
                )}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl border border-red-100">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="outline" onClick={onClose}>ביטול</Button>
          <Button onClick={handleSave} loading={saving}
            className="border-0 shadow-md"
            style={{ background: 'var(--hero-gradient)', color: 'white' }}>
            <Check className="w-4 h-4" /> {editing ? 'עדכן מנה' : 'צור מנה'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════
//  ADD INGREDIENT MODAL
// ═══════════════════════════════════════════════════════════

const ALL_UNITS = [
  'גרם', 'קילוגרם', 'מיליגרם', 'טון',
  'מיליליטר', 'ליטר', 'כוס', 'כף', 'כפית', 'סנטיליטר',
  'יחידה', 'חבילה', 'קרטון', 'ארגז', 'בקבוק', 'פחית',
  'שקית', 'צרור', 'ענף', 'ראש', 'פרוסה', 'כיכר', 'ביצה', 'שן שום', 'עלה',
];

function AddIngredientModal({ onSave, onClose }: { onSave: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('קילוגרם');
  const [costPerUnit, setCostPerUnit] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim()) { setError('שם מרכיב נדרש'); return; }
    setSaving(true); setError('');
    try {
      await inventoryApi.create({
        name: name.trim(),
        unit,
        costPerUnit: parseFloat(costPerUnit) || 0,
        currentQty: 0,
        minQty: 0,
      });
      onSave();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="מרכיב חדש" size="sm">
      <div className="space-y-4 p-1" dir="rtl">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1.5">שם המרכיב</label>
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="לדוג׳: עגבניות, שמן זית, קמח..."
            autoFocus
            className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">יחידת מידה</label>
            <select
              value={unit} onChange={e => setUnit(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
            >
              {ALL_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              מחיר ל{unit} (₪)
            </label>
            <input
              type="number" min="0" step="0.01"
              value={costPerUnit} onChange={e => setCostPerUnit(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
        </div>

        {costPerUnit && parseFloat(costPerUnit) > 0 && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">₪{parseFloat(costPerUnit).toFixed(2)}</span> ל{unit}
            {unit === 'קילוגרם' && (
              <span className="text-amber-600 mr-2">= ₪{(parseFloat(costPerUnit) / 1000).toFixed(4)} לגרם</span>
            )}
            {unit === 'ליטר' && (
              <span className="text-amber-600 mr-2">= ₪{(parseFloat(costPerUnit) / 1000).toFixed(4)} למ"ל</span>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-xl border border-red-100">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="outline" onClick={onClose}>ביטול</Button>
          <Button onClick={handleSave} loading={saving}
            className="border-0 shadow-md"
            style={{ background: 'var(--hero-gradient)', color: 'white' }}>
            <Check className="w-4 h-4" /> הוסף מרכיב
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════
//  FLOATING CHEF CHAT
// ═══════════════════════════════════════════════════════════

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

const QUICK_PROMPTS = [
  { label: 'שפר מנה', prompt: 'יש לי מנה שאני רוצה לשפר. תעזור לי לשדרג אותה מבחינת טעמים והגשה.' },
  { label: 'הגדל רווח', prompt: 'איך אני יכול להגדיל את הרווחיות של המנות שלי?' },
  { label: 'הוזל עלויות', prompt: 'תעזור לי להוריד עלויות חומרי גלם בלי לפגוע בלקוח.' },
  { label: 'רעיונות', prompt: 'תציע לי מנות חדשות רווחיות לתפריט.' },
];

function FloatingChefChat({
  messages, onSend, loading, onClear,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  loading: boolean;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const unread = messages.filter(m => m.role === 'assistant').length - 1; // minus greeting

  React.useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  React.useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-chef-chat', handler);
    return () => window.removeEventListener('open-chef-chat', handler);
  }, []);

  const send = (text: string) => {
    if (!text.trim() || loading) return;
    setInput('');
    onSend(text.trim());
  };

  const renderText = (text: string) => <MarkdownText content={text} className="text-sm leading-relaxed" />;

  const chatWidget = (
    <div className="fixed bottom-6 left-6 z-[9998] flex flex-col items-end gap-3" dir="rtl">
      {/* Chat window */}
      {open && (
        <div className="w-80 sm:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
          style={{ height: '480px' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-l from-violet-600 to-indigo-600 text-white flex-shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span className="font-bold text-sm">טבח יועץ AI</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={e => { e.stopPropagation(); onClear(); }} className="p-1 rounded-lg hover:bg-white/20 text-white/70 hover:text-white text-xs" title="נקה שיחה">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-white/20">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Quick prompts */}
          <div className="flex gap-1.5 px-3 py-2 border-b border-slate-100 overflow-x-auto flex-shrink-0">
            {QUICK_PROMPTS.map(q => (
              <button key={q.label} onClick={() => send(q.prompt)} disabled={loading}
                className="flex-shrink-0 text-xs font-medium px-2.5 py-1 bg-violet-50 text-violet-700 border border-violet-200 rounded-full hover:bg-violet-100 transition-colors disabled:opacity-50">
                {q.label}
              </button>
            ))}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {messages.map((m, i) => (
              <div key={i} className={`flex items-end gap-1.5 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                {m.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-3 h-3 text-white" />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-violet-600 text-white rounded-br-sm'
                    : 'bg-white border border-slate-200 text-slate-800 shadow-sm rounded-bl-sm'
                }`}>
                  {renderText(m.content)}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex items-end gap-1.5">
                <div className="w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center flex-shrink-0">
                  <ChefHat className="w-3 h-3 text-white" />
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-3 py-2 shadow-sm">
                  <div className="flex gap-1 items-center h-4">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2.5 border-t border-slate-100 flex-shrink-0 bg-white">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send(input)}
                placeholder="שאל..."
                disabled={loading}
                className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-400 bg-slate-50 disabled:opacity-50"
              />
              <button onClick={() => send(input)} disabled={loading || !input.trim()}
                className="px-3 py-2 bg-violet-600 text-white rounded-xl disabled:opacity-40 hover:bg-violet-700 transition-colors flex-shrink-0">
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-lg hover:shadow-violet-400/30 transition-all flex items-center justify-center relative border-2 border-white/20"
      >
        {open ? (
          <X className="w-5 h-5" />
        ) : (
          <ChefHat className="w-5 h-5" />
        )}
        {!open && unread > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-xs font-bold flex items-center justify-center border-2 border-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(chatWidget, document.body) : null;
}

// ═══════════════════════════════════════════════════════════
//  CHEF ADVISOR PANEL
// ═══════════════════════════════════════════════════════════

type AdvisorMode = 'improve_dish' | 'increase_profit' | 'reduce_cost';

const ADVISOR_MODES: { id: AdvisorMode; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'improve_dish',    label: 'שפר לי מנה',   icon: <Lightbulb className="w-4 h-4" />,   color: 'bg-amber-500 hover:bg-amber-600 text-white' },
  { id: 'increase_profit', label: 'הגדל רווחיות',  icon: <TrendingUp className="w-4 h-4" />,  color: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
  { id: 'reduce_cost',     label: 'הוזל עלות',     icon: <TrendingDown className="w-4 h-4" />, color: 'bg-blue-500 hover:bg-blue-600 text-white' },
];

function ChefAdvisorPanel({ dish, onClose }: { dish: DishDetail; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [advice, setAdvice] = useState('');
  const [activeMode, setActiveMode] = useState<AdvisorMode | null>(null);
  const [error, setError] = useState('');

  const ask = async (mode: AdvisorMode) => {
    setLoading(true); setError(''); setAdvice(''); setActiveMode(mode);
    try {
      const { data } = await dishesApi.advise(dish.id, mode, dish);
      setAdvice(data.advice || '');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const renderAdvice = (text: string) => <MarkdownText content={text} className="text-sm text-slate-700" />;

  const panelContent = (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center" dir="rtl">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:max-w-2xl max-h-[90vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-l from-violet-600 to-indigo-600 text-white flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            <div>
              <p className="font-bold text-sm">טבח יועץ AI</p>
              <p className="text-white/70 text-xs">{dish.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/20 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode buttons */}
        <div className="flex gap-2 p-4 border-b border-slate-100 flex-shrink-0">
          {ADVISOR_MODES.map(m => (
            <button key={m.id} onClick={() => ask(m.id)} disabled={loading}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50 ${
                activeMode === m.id ? m.color + ' shadow-md scale-105' : m.color + ' opacity-80'
              }`}>
              {loading && activeMode === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : m.icon}
              {m.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {!advice && !loading && !error && (
            <div className="flex flex-col items-center py-12 text-slate-400">
              <Sparkles className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">בחר פעולה למעלה לקבלת ייעוץ מהטבח AI</p>
              <p className="text-xs mt-1 opacity-70">מחיר מנה: {formatCurrency(dish.selling_price || 0)} · עלות: {formatCurrency(dish.cost || 0)}</p>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center py-12 text-slate-400 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
              <p className="text-sm">הטבח היועץ מנתח את המנה...</p>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}

          {advice && !loading && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 mb-3 pb-3 border-b border-slate-100">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                  style={{ background: 'var(--color-primary)', color: '#fff' }}>
                  {ADVISOR_MODES.find(m => m.id === activeMode)?.label}
                </span>
                <span className="text-xs text-slate-400">{dish.name}</span>
              </div>
              {renderAdvice(advice)}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(panelContent, document.body) : null;
}

// ═══════════════════════════════════════════════════════════
//  MAIN PAGE
// ═══════════════════════════════════════════════════════════

type Tab = 'ingredients' | 'dishes' | 'extras';

type Extra = {
  id: string;
  item_name: string;
  unit: string | null;
  is_active: boolean;
  inventory_item_id: string | null;
  inventory_name: string | null;
  current_qty: number;
  cost_per_unit: number;
};

// מנה מחוקה. units_90d/revenue_90d הם מה שהקופה עדיין מוכרת בשם הזה — מנה
// מחוקה שממשיכה להימכר לא מנכה מלאי ולא נכנסת לעלות סחורה, ולכן היא הדבר
// הראשון שצריך להקפיץ לעיני בעל העסק.
type ArchivedDish = {
  id: string;
  name: string;
  selling_price: number;
  category: string | null;
  archived_at: string | null;
  units_90d: number;
  revenue_90d: number;
  reports_90d: number;
  linked_ingredients: number;
};

export default function RecipesPage() {
  const { confirm, toast } = useAppDialog();
  const [tab, setTab] = useState<Tab>('dishes');
  const [catalog, setCatalog] = useState<InvoiceIngredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [dishes, setDishes] = useState<DishDetail[]>([]);
  const [archived, setArchived] = useState<ArchivedDish[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [catSearch, setCatSearch] = useState('');

  // Recipe panel
  const [showRecipePanel, setShowRecipePanel] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);

  // Dish modal
  const [showDishModal, setShowDishModal] = useState(false);
  const [editingDish, setEditingDish] = useState<DishDetail | null>(null);
  const [selectedDishIds, setSelectedDishIds] = useState<Set<string>>(new Set());
  const [showEditPicker, setShowEditPicker] = useState(false);

  // Add ingredient modal
  const [showAddIngredient, setShowAddIngredient] = useState(false);

  // Chef advisor (per-dish)
  const [advisorDish, setAdvisorDish] = useState<DishDetail | null>(null);

  // Extras (אקסטרות)
  const [extras, setExtras] = useState<Extra[]>([]);
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [newExtraName, setNewExtraName] = useState('');
  const [newExtraUnit, setNewExtraUnit] = useState('יחידה');
  const [logQty, setLogQty] = useState<Record<string, string>>({}); // extra.id → qty string
  const [logSaving, setLogSaving] = useState<Record<string, boolean>>({});

  // Inline editing (name / price on card)
  const [inlineEdit, setInlineEdit] = useState<{ dishId: string; field: 'name' | 'price'; value: string } | null>(null);
  const [inlineSaving, setInlineSaving] = useState(false);

  // Floating chef chat (persistent across tabs)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: 'שלום! אני הטבח היועץ שלך 👨‍🍳\nאני כאן לעזור לשפר מנות, להגדיל רווחיות ולהוזיל עלויות. על מה תרצה לדבר?' },
  ]);
  const [chatLoading, setChatLoading] = useState(false);

  const handleChefSend = useCallback(async (text: string) => {
    const newMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: text }];
    setChatMessages(newMessages);
    setChatLoading(true);
    try {
      const history = newMessages.slice(1, -1);
      const { data } = await dishesApi.chefChat(text, history);
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      const msg = getErrorMessage(err);
      setChatMessages(prev => [...prev, { role: 'assistant', content: `שגיאה: ${msg}` }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatMessages]);

  type RawInventoryItem = { id: string; name: string; unit: string; cost_per_unit?: string; updated_at?: string; created_at?: string; current_qty?: string; category?: string; category_name?: string; item_type?: string };
  const mapInventoryToCatalog = (items: RawInventoryItem[]): InvoiceIngredient[] =>
    items.filter(it => !it.item_type || it.item_type === 'מזון').map(it => ({
      key:              it.id,
      name:             it.name,
      unit:             it.unit,
      latest_unit:      it.unit,
      latest_price:     it.cost_per_unit ? parseFloat(it.cost_per_unit) : 0,
      avg_price:        it.cost_per_unit ? parseFloat(it.cost_per_unit) : 0,
      min_price:        it.cost_per_unit ? parseFloat(it.cost_per_unit) : 0,
      max_price:        it.cost_per_unit ? parseFloat(it.cost_per_unit) : 0,
      last_invoice_date: it.updated_at || it.created_at || '',
      times_ordered:    0,
      current_qty:      it.current_qty ? parseFloat(it.current_qty) : 0,
      category_name:    it.category || it.category_name || undefined,
    }));

  const loadExtras = useCallback(() => {
    setExtrasLoading(true);
    extrasApi.list().then(({ data }) => {
      setExtras(data.extras || []);
    }).catch(() => {}).finally(() => setExtrasLoading(false));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      recipesApi.ingredientsFromInvoices(),
      recipesApi.list(),
      dishesApi.list(),
      // הארכיון נטען יחד עם השאר כדי ששחזור ירענן את שתי הרשימות בבת אחת.
      // catch מקומי — ארכיון ריק או endpoint חסר לא צריך להפיל את עמוד המנות.
      dishesApi.listArchived().catch(() => ({ data: { dishes: [] } })),
    ]).then(([cat, rec, dis, arc]) => {
      setCatalog(mapInventoryToCatalog(cat.data.items || []));
      setRecipes(rec.data.recipes || []);
      setDishes(dis.data.dishes || []);
      setArchived(arc.data.dishes || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const restoreDish = useCallback(async (d: ArchivedDish) => {
    setRestoringId(d.id);
    try {
      await dishesApi.restore(d.id);
      toast(`"${d.name}" שוחזרה — הגדר לה מרכיבים כדי שתנכה מלאי`, 'success');
      load();
    } catch (err) {
      toast(getErrorMessage(err) || 'שחזור נכשל', 'error');
    } finally { setRestoringId(null); }
  }, [toast, load]);

  const saveInline = useCallback(async () => {
    if (!inlineEdit) return;
    const val = inlineEdit.value.trim();
    if (!val || inlineSaving) return;
    setInlineSaving(true);
    try {
      const payload = inlineEdit.field === 'name'
        ? { name: val }
        : { sellingPrice: parseFloat(val) || 0 };
      await dishesApi.update(inlineEdit.dishId, payload);
      setInlineEdit(null);
      load();
    } catch (err) { toast(getErrorMessage(err) || 'שמירה נכשלה', 'error'); }
    finally { setInlineSaving(false); }
  }, [inlineEdit, inlineSaving, load, toast]);

  const bulkDeleteDishes = useCallback(async () => {
    const ids = [...selectedDishIds];
    if (!ids.length) return;
    if (!await confirm(`האם למחוק ${ids.length} מנות? פעולה זו אינה ניתנת לביטול.`, 'מחיקה')) return;
    try {
      const res = await dishesApi.bulkDelete(ids);
      setSelectedDishIds(new Set());
      load();
      toast(`${res.data.deleted} מנות נמחקו בהצלחה`, 'success');
    } catch (err) {
      toast(getErrorMessage(err) || 'מחיקה נכשלה', 'error');
    }
  }, [selectedDishIds, confirm, toast, load]);

  const syncCatalog = useCallback(() => {
    setSyncing(true);
    setSyncMsg(null);
    recipesApi.ingredientsFromInvoices()
      .then(res => {
        const mapped = mapInventoryToCatalog(res.data.items || []);
        setCatalog(mapped);
        setSyncMsg(mapped.length > 0 ? `סונכרנו ${mapped.length} מרכיבים מהמלאי` : 'המלאי ריק — הוסף פריטים בלשונית המלאי');
        setTimeout(() => setSyncMsg(null), 4000);
      })
      .catch(err => {
        setSyncMsg(`שגיאה: ${err?.response?.data?.error || err?.message || 'בעיית תקשורת'}`);
      })
      .finally(() => setSyncing(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); loadExtras(); }, [load, loadExtras]);

  // סנכרון חי — מרכיבים/מחירים משתנים כשמלאי מתעדכן (כולל אישור חשבוניות),
  // ומנות/מתכונים משתנים בעריכה מטאב/מכשיר אחר
  useSyncEvent(['inventory.updated', 'recipe.updated', 'menu.changed'], load);

  // גיבוי: רענון כשחוזרים לדף (מכסה גם מקרי קצה שה-SSE פספס)
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load]);

  const filteredCatalog = useMemo(() => {
    const q = catSearch.toLowerCase();
    return q ? catalog.filter(c => c.name.toLowerCase().includes(q)) : catalog;
  }, [catalog, catSearch]);

  // קיבוץ מנות לפי קטגוריה בסדר קבוע
  const CAT_ORDER = ['ראשונות', 'עיקריות', 'צדדים', 'קינוחים', 'משקאות', 'אחר', 'ללא קטגוריה'];
  const groupedDishes = useMemo(() => {
    const map: Record<string, DishDetail[]> = {};
    for (const d of dishes) {
      const cat = d.category || 'ללא קטגוריה';
      if (!map[cat]) map[cat] = [];
      map[cat].push(d);
    }
    return map;
  }, [dishes]);
  const sortedCategories = useMemo(() =>
    Object.keys(groupedDishes).sort((a, b) => {
      const ai = CAT_ORDER.indexOf(a); const bi = CAT_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b, 'he');
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }), [groupedDishes]); // eslint-disable-line react-hooks/exhaustive-deps

  const avgMargin = dishes.length
    ? dishes.reduce((s, d) => s + (d.margin || 0), 0) / dishes.length
    : 0;

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'ingredients', label: 'מרכיבים', count: catalog.length },
    { id: 'dishes',      label: 'מנות',    count: dishes.length },
    { id: 'extras',      label: 'אקסטרות', count: extras.filter(e => e.is_active).length },
  ];

  return (
    <div className="space-y-6" dir="rtl">

      {/* Recipe builder panel */}
      {showRecipePanel && (
        <RecipeBuilderPanel
          editing={editingRecipe}
          catalog={catalog}
          recipes={recipes}
          onSave={() => { setShowRecipePanel(false); load(); }}
          onClose={() => setShowRecipePanel(false)}
        />
      )}

      {/* Add ingredient modal */}
      {showAddIngredient && (
        <AddIngredientModal
          onSave={() => { setShowAddIngredient(false); syncCatalog(); }}
          onClose={() => setShowAddIngredient(false)}
        />
      )}

      {/* Chef advisor (per-dish modal) */}
      {advisorDish && (
        <ChefAdvisorPanel dish={advisorDish} onClose={() => setAdvisorDish(null)} />
      )}

      {/* Floating chef chat */}
      <FloatingChefChat
        messages={chatMessages}
        onSend={handleChefSend}
        loading={chatLoading}
        onClear={() => setChatMessages([{ role: 'assistant', content: 'שיחה חדשה! במה אוכל לעזור?' }])}
      />

      {/* Dish modal */}
      {showDishModal && (
        <DishBuilderModal
          editing={editingDish}
          catalog={catalog}
          allRecipes={recipes}
          onSave={() => { setShowDishModal(false); load(); }}
          onClose={() => setShowDishModal(false)}
        />
      )}

      {/* ── Header ───────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl p-6 text-white shadow-lg" style={{ background: 'var(--hero-gradient)' }}>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-0 left-1/3 w-64 h-64 rounded-full bg-white blur-3xl" />
        </div>
        <div className="relative flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold">מנות</h1>
            <p className="text-white/70 text-sm mt-1">חישוב עלות אוטומטי · המרת יחידות · תמחור מנות</p>
            <div className="flex items-center gap-3 mt-3">
              <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">
                {catalog.length} מרכיבים מהמלאי
              </div>
              <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">
                {dishes.length} מנות
              </div>
              {dishes.length > 0 && (
                <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">
                  מרג׳ין ממוצע {avgMargin.toFixed(1)}%
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('open-chef-chat'));
              }}
              className="font-semibold border-0 shadow-md"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <ChefHat className="w-4 h-4" /> טבח יועץ
            </Button>
            <Button
              onClick={syncCatalog}
              disabled={syncing}
              className="font-semibold border-0 shadow-md disabled:opacity-60"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'מסנכרן...' : 'סנכרן מלאי'}
            </Button>
            <Button
              onClick={() => setShowAddIngredient(true)}
              className="font-semibold border-0 shadow-md"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <Plus className="w-4 h-4" /> מרכיב חדש
            </Button>
            <Button
              onClick={() => { setTab('extras'); setShowAddExtra(true); }}
              className="font-semibold border-0 shadow-md"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <Plus className="w-4 h-4" /> אקסטרה חדשה
            </Button>
            <Button
              onClick={() => setShowEditPicker(true)}
              className="font-semibold border-0 shadow-md"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <Pencil className="w-4 h-4" /> עריכת מנה
            </Button>
            {showEditPicker && typeof document !== 'undefined' && createPortal(
              <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" dir="rtl">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowEditPicker(false)} />
                <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                    <h3 className="font-bold text-slate-800 text-base">בחר מנה לעריכה</h3>
                    <button onClick={() => setShowEditPicker(false)} className="text-slate-400 hover:text-slate-600">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="overflow-y-auto max-h-[60vh]">
                    {dishes.length === 0 ? (
                      <p className="px-5 py-8 text-center text-slate-400 text-sm">אין מנות עדיין</p>
                    ) : dishes.map(d => (
                      <button key={d.id}
                        onClick={() => { setEditingDish(d); setShowDishModal(true); setShowEditPicker(false); }}
                        className="w-full text-right px-5 py-3.5 hover:bg-violet-50 border-b border-slate-50 last:border-0 flex items-center justify-between gap-3 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800 truncate">{d.name}</p>
                          <p className="text-xs text-slate-400 mt-0.5">עלות ₪{(d.cost||0).toFixed(2)} · מרג׳ין {(d.margin||0).toFixed(1)}%</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-sm font-bold text-slate-700">₪{d.selling_price}</span>
                          <Pencil className="w-3.5 h-3.5 text-violet-400" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>,
              document.body
            )}
            <Button
              onClick={() => { setEditingDish(null); setShowDishModal(true); }}
              className="font-semibold border-0 shadow-md"
              style={{ background: 'rgba(255,255,255,0.92)', color: '#1a5c2a' }}
            >
              <UtensilsCrossed className="w-4 h-4" /> מנה חדשה
            </Button>
          </div>
        </div>
      </div>

      {/* ── One-time setup banner ────────────────────────── */}
      <div
        className="rounded-2xl p-4 flex gap-4 items-start"
        style={{
          background: 'linear-gradient(135deg, rgba(15,61,31,0.06) 0%, rgba(26,92,42,0.04) 100%)',
          border: '1px solid rgba(26,92,42,0.25)',
        }}
      >
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: 'rgba(26,92,42,0.12)' }}
        >
          <Lightbulb className="w-5 h-5 text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full">
              הגדרה חד-פעמית
            </span>
          </div>
          <p className="text-sm font-semibold text-gray-800 mb-1">
            קשר חומרי גלם לכל מנה — ואנחנו נעשה את שאר העבודה אוטומטית
          </p>
          <p className="text-sm text-gray-600 leading-relaxed">
            הקופה שואבת מכירות אוטומטית, אבל כדי לזהות <strong>דליפות רווח</strong> ולחשב
            {' '}<strong>עלות אמיתית לכל מנה</strong>, צריך פעם אחת לקשר לכל מנה את חומרי הגלם שלה —
            כמה גרם עוף, כמה מ"ל שמן, כמה גרם גבינה וכו׳.
            לאחר ההגדרה, המערכת תחשב <strong>בכל מכירה</strong> כמה היה צריך לצרוך מכל מרכיב,
            ותשווה לכמות שנצרכה בפועל מהמלאי — כך מזהים בדיוק איפה הכסף הולך.
          </p>
          <div className="flex flex-wrap gap-3 mt-3">
            {[
              { step: '1', text: 'הוסף חומרי גלם (טאב מרכיבים)' },
              { step: '2', text: 'פתח מנה ← לחץ "הרכב מתכון"' },
              { step: '3', text: 'הגדר כמות לכל מרכיב' },
            ].map(({ step, text }) => (
              <div key={step} className="flex items-center gap-2 text-xs text-emerald-800">
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center font-black text-white flex-shrink-0"
                  style={{ background: '#1a5c2a', fontSize: '10px' }}
                >
                  {step}
                </span>
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────── */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-2xl w-fit">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              tab === t.id
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}>
            {t.label}
            {t.count !== undefined && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                tab === t.id ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
              }`}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> טוען...
        </div>
      ) : (
        <>
          {/* ════════════════════════════════════════════════
              TAB 1 — מרכיבים מחשבוניות
          ════════════════════════════════════════════════ */}
          {tab === 'ingredients' && (
            <div className="space-y-4">
              {/* Search */}
              <div className="flex items-center gap-4 flex-wrap">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input value={catSearch} onChange={e => setCatSearch(e.target.value)}
                    placeholder="חפש מרכיב..."
                    className="w-full pr-9 pl-4 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white shadow-sm" />
                </div>
                {catalog.length > 0 && (
                  <div className="bg-emerald-50 border border-emerald-100 text-emerald-700 px-3 py-1.5 rounded-xl text-xs font-medium">
                    {catalog.length} פריטים
                  </div>
                )}
                {syncMsg && (
                  <span className={`text-xs px-2 py-1 rounded-lg font-medium ${
                    syncMsg.startsWith('שגיאה') ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  }`}>{syncMsg}</span>
                )}
              </div>

              {catalog.length === 0 ? (
                <div className="flex flex-col items-center py-20 bg-white rounded-2xl border border-slate-100">
                  <Package className="w-12 h-12 text-slate-200 mb-3" />
                  <p className="text-slate-600 font-semibold">אין מרכיבים מחשבוניות</p>
                  <p className="text-slate-400 text-sm mt-1">לחץ "סנכרן מלאי" — המרכיבים נשאבים ישירות מלשונית המלאי</p>
                </div>
              ) : (
                <>
                  {/* (search already rendered above) */}

                  {/* Info banner */}
                  <div className="flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-700">
                    <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>המרכיבים מסונכרנים עם לשונית המלאי. מחיר ליחידת בסיס (גרם / מ&quot;ל / יח׳) מחושב אוטומטית לחישוב עלות מדויק.</span>
                  </div>

                  {/* Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {filteredCatalog.map(ing => {
                      const invUnit = ing.latest_unit || ing.unit;
                      const uDef = resolveUnit(invUnit);
                      const pricePerBase = uDef && ing.latest_price
                        ? ing.latest_price / uDef.factor
                        : null;
                      const baseUnitLabel = uDef?.family === 'weight' ? 'גרם'
                        : uDef?.family === 'volume' ? 'מ"ל' : "יח'";
                      return (
                        <div key={ing.key} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 hover:shadow-md hover:border-amber-200 transition-all">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <p className="font-semibold text-slate-800 text-sm leading-tight">{ing.name}</p>
                            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full flex-shrink-0 font-medium">{invUnit}</span>
                          </div>
                          {ing.category_name && (
                            <p className="text-xs text-slate-400 mb-2">{ing.category_name}</p>
                          )}
                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center">
                              <span className="text-xs text-slate-400">עלות במלאי</span>
                              <span className="text-sm font-bold text-slate-800">
                                {ing.latest_price ? `₪${ing.latest_price.toFixed(2)}` : <span className="text-slate-400 font-normal text-xs">לא הוגדר</span>}
                                {ing.latest_price && <span className="text-xs font-normal text-slate-400">/{invUnit}</span>}
                              </span>
                            </div>
                            {pricePerBase !== null && uDef?.family !== 'unit' && (
                              <div className="flex justify-between items-center">
                                <span className="text-xs text-slate-400">ל{baseUnitLabel}</span>
                                <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-lg">
                                  ₪{pricePerBase.toFixed(4)}/{baseUnitLabel}
                                </span>
                              </div>
                            )}
                            {ing.current_qty !== undefined && (
                              <div className="flex justify-between items-center pt-1 border-t border-slate-50">
                                <span className="text-xs text-slate-400">כמות במלאי</span>
                                <span className="text-xs text-slate-500">{ing.current_qty} {invUnit}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════════════
              TAB 3 — מנות
          ════════════════════════════════════════════════ */}
          {tab === 'dishes' && (
            <div className="space-y-6">
              {dishes.length === 0 ? (
                <div className="flex flex-col items-center py-20 bg-white rounded-2xl border border-slate-100">
                  <UtensilsCrossed className="w-12 h-12 text-slate-200 mb-3" />
                  <p className="text-slate-600 font-semibold">אין מנות עדיין</p>
                  <p className="text-slate-400 text-sm mt-1">
                    לחץ על "מנה חדשה" כדי לבנות מנה עם מרכיבים מהמלאי
                  </p>
                  <Button className="mt-4 border-0 shadow-md" style={{ background: '#1a5c2a', color: 'white' }} onClick={() => { setEditingDish(null); setShowDishModal(true); }}>
                    <Plus className="w-4 h-4" /> מנה חדשה
                  </Button>
                </div>
              ) : (
                <>
                  {/* Bulk delete bar — visible only when dishes are selected */}
                  {selectedDishIds.size > 0 && (
                    <div className="flex items-center gap-3 bg-red-50 border border-red-100 rounded-2xl px-4 py-2.5">
                      <span className="text-sm text-red-700 font-medium flex-1">נבחרו {selectedDishIds.size} מנות</span>
                      <button
                        onClick={() => setSelectedDishIds(new Set())}
                        className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
                      >
                        ביטול
                      </button>
                      <button
                        onClick={bulkDeleteDishes}
                        className="flex items-center gap-1.5 bg-red-500 hover:bg-red-600 text-white font-semibold text-sm px-3 py-1.5 rounded-xl transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        מחק {selectedDishIds.size} מנות
                      </button>
                    </div>
                  )}

                  {sortedCategories.map(cat => (
                  <div key={cat}>
                    {/* Category header — only if more than one category */}
                    {sortedCategories.length > 1 && (
                      <div className="flex items-center gap-3 mb-3">
                        <h3 className="text-sm font-bold text-slate-600 uppercase tracking-wider">{cat}</h3>
                        <div className="flex-1 h-px bg-slate-100" />
                        <span className="text-xs text-slate-400 font-medium">{groupedDishes[cat].length} מנות</span>
                      </div>
                    )}
                    <div className="space-y-3">
                      {groupedDishes[cat].map(d => {
                        const isEditingName  = inlineEdit?.dishId === d.id && inlineEdit.field === 'name';
                        const isEditingPrice = inlineEdit?.dishId === d.id && inlineEdit.field === 'price';
                        return (
                          <div key={d.id} className={`bg-white rounded-2xl border shadow-sm hover:shadow-md transition-all overflow-hidden ${selectedDishIds.has(d.id) ? 'border-violet-300 bg-violet-50/30' : 'border-slate-100'}`}>
                            <div className="p-4">
                              <div className="flex items-center gap-4">
                                <input
                                  type="checkbox"
                                  checked={selectedDishIds.has(d.id)}
                                  onChange={e => {
                                    setSelectedDishIds(prev => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(d.id); else next.delete(d.id);
                                      return next;
                                    });
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  className="w-4 h-4 cursor-pointer accent-violet-600 flex-shrink-0"
                                />
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center flex-shrink-0">
                                  <UtensilsCrossed className="w-5 h-5 text-violet-600" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  {/* Mobile cost/profit row — desktop shows these in the sibling hidden sm:flex block */}
                                  <div className="flex sm:hidden items-center gap-3 mb-1 text-xs">
                                    <span className="text-slate-500">עלות: <strong className="text-slate-700">{formatCurrency(d.cost || 0)}</strong></span>
                                    <span className="text-slate-500">רווח: <strong className={(d.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-500'}>{formatCurrency(d.profit || 0)}</strong></span>
                                    <span className={`px-2 py-0.5 rounded-lg font-bold ${marginBg(d.margin || 0)}`}>{(d.margin || 0).toFixed(1)}%</span>
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {/* Inline name edit */}
                                    {isEditingName ? (
                                      <input
                                        autoFocus
                                        value={inlineEdit.value}
                                        onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : prev)}
                                        onBlur={saveInline}
                                        onKeyDown={e => { if (e.key === 'Enter') saveInline(); if (e.key === 'Escape') setInlineEdit(null); }}
                                        className="font-bold text-slate-800 border-b-2 border-amber-400 bg-amber-50 rounded px-1 focus:outline-none text-base min-w-0 w-40"
                                      />
                                    ) : (
                                      <button
                                        type="button"
                                        title="לחץ לעריכה"
                                        onClick={() => setInlineEdit({ dishId: d.id, field: 'name', value: d.name })}
                                        className="font-bold text-slate-800 hover:text-amber-700 hover:underline decoration-dashed underline-offset-2 transition-colors text-right"
                                      >
                                        {d.name}
                                      </button>
                                    )}

                                    {/* Inline price edit */}
                                    {isEditingPrice ? (
                                      <div className="flex items-center gap-1">
                                        <span className="text-sm text-slate-400">₪</span>
                                        <input
                                          autoFocus
                                          type="number"
                                          value={inlineEdit.value}
                                          onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : prev)}
                                          onBlur={saveInline}
                                          onKeyDown={e => { if (e.key === 'Enter') saveInline(); if (e.key === 'Escape') setInlineEdit(null); }}
                                          className="w-20 font-bold border-b-2 border-emerald-400 bg-emerald-50 rounded px-1 focus:outline-none text-sm text-center"
                                        />
                                        {inlineSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        title="לחץ לעריכת מחיר"
                                        onClick={() => setInlineEdit({ dishId: d.id, field: 'price', value: String(d.selling_price || 0) })}
                                        className="text-sm font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2.5 py-0.5 rounded-full flex-shrink-0 hover:bg-emerald-100 transition-colors"
                                      >
                                        {formatCurrency(d.selling_price || 0)}
                                      </button>
                                    )}

                                    {d.dish_type && d.dish_type !== 'both' && (
                                      <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full flex-shrink-0">
                                        {d.dish_type === 'dine_in' ? 'ישיבה במקום' : 'טייק-אווי'}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-slate-400 mt-0.5">{d.recipe_count} מתכונים</p>
                                </div>
                                <div className="hidden sm:flex items-center gap-4 text-sm">
                                  <div className="text-center">
                                    <p className="text-xs text-slate-400">עלות</p>
                                    <p className="font-bold text-slate-800">{formatCurrency(d.cost || 0)}</p>
                                  </div>
                                  <div className="text-center">
                                    <p className="text-xs text-slate-400">רווח</p>
                                    <p className={`font-bold ${(d.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                      {formatCurrency(d.profit || 0)}
                                    </p>
                                  </div>
                                  <div className={`px-3 py-1.5 rounded-xl text-sm font-bold ${marginBg(d.margin || 0)}`}>
                                    {(d.margin || 0).toFixed(1)}%
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <button onClick={() => { setEditingDish(d); setShowDishModal(true); }}
                                    className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-violet-50 text-slate-400 hover:text-violet-600 transition-colors"
                                    title="עריכת מנה מלאה">
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                  <button onClick={async () => {
                                    if (!await confirm(`האם למחוק את "${d.name}"?`, 'מחיקה')) return;
                                    try { await dishesApi.delete(d.id); load(); }
                                    catch (err) { toast(getErrorMessage(err) || 'מחיקת המנה נכשלה', 'error'); }
                                  }}
                                    className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors">
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>

                              {/* Recipes breakdown */}
                              {d.recipes && d.recipes.length > 0 && (
                                <div className="mt-3 pt-3 border-t border-slate-50 flex flex-wrap gap-2">
                                  {d.recipes.map(r => (
                                    <div key={r.recipe_id} className="flex items-center gap-1.5 bg-slate-50 border border-slate-100 px-2.5 py-1 rounded-lg text-xs">
                                      <ChefHat className="w-3 h-3 text-amber-500" />
                                      <span className="text-slate-600 font-medium">{r.recipe_name}</span>
                                      {r.qty !== 1 && <span className="text-slate-400">×{r.qty}</span>}
                                      <span className="text-slate-400">·</span>
                                      <span className="font-semibold text-slate-700">{formatCurrency(r.recipe_cost * r.qty)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  ))}
                </>
              )}

              {/* ──────────────────────────────────────────────
                  מנות מחוקות — ארכיון + שחזור
                  מנה מחוקה שעדיין נמכרת בקופה לא מנכה מלאי ולא נכנסת
                  לעלות הסחורה, והשאיבה מדוחות Z לא תיצור אותה מחדש.
                  זה המקום היחיד שממנו אפשר להחזיר אותה.
              ────────────────────────────────────────────── */}
              {archived.length > 0 && (() => {
                const stillSelling = archived.filter(a => a.units_90d > 0);
                const lostRevenue  = stillSelling.reduce((s, a) => s + a.revenue_90d, 0);
                return (
                  <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                    <button
                      onClick={() => setShowArchived(v => !v)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-right"
                    >
                      <Archive className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <span className="text-sm font-bold text-slate-600">
                        מנות מחוקות ({archived.length})
                      </span>
                      {stillSelling.length > 0 && (
                        <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          {stillSelling.length} עדיין נמכרות · {formatCurrency(lostRevenue)} ב-90 יום ללא ניכוי מלאי
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="text-xs text-slate-400">{showArchived ? 'הסתר' : 'הצג'}</span>
                    </button>

                    {showArchived && (
                      <div className="border-t border-slate-100 divide-y divide-slate-50">
                        {stillSelling.length > 0 && (
                          <div className="flex items-start gap-2 px-4 py-3 bg-amber-50/60 text-xs text-amber-800">
                            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>
                              המנות המסומנות נמכרות בקופה אבל מחוקות כאן — לכן הן לא מנכות מלאי ולא נכנסות לעלות הסחורה.
                              שחזר אותן והגדר להן מרכיבים כדי שהניכוי יעבוד.
                            </span>
                          </div>
                        )}
                        {archived.map(a => (
                          <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-slate-700 truncate">{a.name}</span>
                                {a.units_90d > 0 && (
                                  <span className="text-[11px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                                    נמכרה {a.units_90d} יח׳ · {formatCurrency(a.revenue_90d)}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {formatCurrency(a.selling_price || 0)}
                                {a.archived_at && ` · נמחקה ב-${new Date(a.archived_at).toLocaleDateString('he-IL')}`}
                                {a.linked_ingredients > 0
                                  ? ` · ${a.linked_ingredients} מרכיבים מוגדרים`
                                  : ' · ללא מרכיבים'}
                              </p>
                            </div>
                            <button
                              onClick={() => restoreDish(a)}
                              disabled={restoringId === a.id}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-50 flex-shrink-0"
                            >
                              {restoringId === a.id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Undo2 className="w-3.5 h-3.5" />}
                              שחזר
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          {/* ════════════════════════════════════════════════
              TAB 3 — אקסטרות
          ════════════════════════════════════════════════ */}
          {tab === 'extras' && (
            <div className="space-y-4 max-w-2xl">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-sm text-slate-500">
                    פריטים שמוצאים לשולחן בנפרד מהמנות (חריפים, לחם, שמן, ירקות...) — רשום צריכה יומית כדי לנכות מהמלאי.
                  </p>
                </div>
                <button
                  onClick={() => setShowAddExtra(p => !p)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white shadow-sm flex-shrink-0"
                  style={{ background: 'var(--hero-gradient)' }}>
                  <Plus className="w-4 h-4" /> הוסף פריט
                </button>
              </div>

              {/* טופס הוספת אקסטרה */}
              {showAddExtra && (
                <div className="border border-teal-200 rounded-xl p-4 bg-teal-50 space-y-3">
                  <p className="text-sm font-semibold text-teal-800">פריט חדש</p>
                  <div className="flex gap-3 flex-wrap">
                    <input
                      value={newExtraName}
                      onChange={e => setNewExtraName(e.target.value)}
                      placeholder="שם הפריט, לדוג׳: חציל, לחם, חריפים..."
                      className="flex-1 min-w-40 px-3 py-2 text-sm border border-teal-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white"
                    />
                    <input
                      value={newExtraUnit}
                      onChange={e => setNewExtraUnit(e.target.value)}
                      placeholder="יחידה (יחידה / ק״ג...)"
                      className="w-32 px-3 py-2 text-sm border border-teal-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white"
                    />
                    <button
                      onClick={async () => {
                        if (!newExtraName.trim()) return;
                        try {
                          await extrasApi.create({ itemName: newExtraName.trim(), unit: newExtraUnit.trim() || 'יחידה' });
                          setNewExtraName(''); setNewExtraUnit('יחידה');
                          setShowAddExtra(false);
                          loadExtras();
                        } catch (err) { toast(getErrorMessage(err) || 'שמירה נכשלה', 'error'); }
                      }}
                      className="px-4 py-2 rounded-xl bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700 transition-colors">
                      שמור
                    </button>
                    <button onClick={() => setShowAddExtra(false)}
                      className="px-3 py-2 rounded-xl border border-teal-200 text-sm text-slate-500 hover:bg-white transition-colors">
                      ביטול
                    </button>
                  </div>
                </div>
              )}

              {/* רשימת אקסטרות */}
              {extrasLoading ? (
                <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
                  <Loader2 className="w-5 h-5 animate-spin" /> טוען...
                </div>
              ) : extras.length === 0 ? (
                <div className="text-center py-16 text-slate-400">
                  <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm font-medium">אין אקסטרות מוגדרות עדיין</p>
                  <p className="text-xs mt-1">לחץ על ״הוסף פריט״ להתחיל</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {extras.map(ex => {
                    const saving = logSaving[ex.id] || false;
                    const qty = logQty[ex.id] || '';
                    return (
                      <div key={ex.id} className={`border rounded-xl p-4 transition-all ${ex.is_active ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-slate-800 truncate">{ex.item_name}</p>
                              {ex.unit && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{ex.unit}</span>}
                              {!ex.is_active && <span className="text-xs text-slate-400 bg-slate-200 px-2 py-0.5 rounded-full">לא פעיל</span>}
                            </div>
                            {ex.inventory_name && (
                              <p className="text-xs text-slate-400 mt-0.5">
                                מלאי: {ex.inventory_name} — {ex.current_qty % 1 === 0 ? ex.current_qty : ex.current_qty.toFixed(2)} {ex.unit || ''}
                              </p>
                            )}
                          </div>

                          {/* רישום צריכה יומית */}
                          {ex.is_active && (
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <input
                                type="number" min="0.01" step="any"
                                value={qty}
                                onChange={e => setLogQty(prev => ({ ...prev, [ex.id]: e.target.value }))}
                                onKeyDown={async e => {
                                  if (e.key !== 'Enter' || !qty || saving) return;
                                  setLogSaving(prev => ({ ...prev, [ex.id]: true }));
                                  try {
                                    await extrasApi.log(ex.id, { qty: parseFloat(qty) });
                                    setLogQty(prev => ({ ...prev, [ex.id]: '' }));
                                    loadExtras();
                                    toast(`נרשם: ${qty} ${ex.unit || ''} ${ex.item_name}`, 'success');
                                  } catch (err) { toast(getErrorMessage(err) || 'רישום נכשל', 'error'); }
                                  finally { setLogSaving(prev => ({ ...prev, [ex.id]: false })); }
                                }}
                                placeholder="כמות"
                                className="w-20 text-center text-sm border border-slate-200 rounded-xl px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-400"
                              />
                              <button
                                disabled={!qty || saving}
                                onClick={async () => {
                                  if (!qty || saving) return;
                                  setLogSaving(prev => ({ ...prev, [ex.id]: true }));
                                  try {
                                    await extrasApi.log(ex.id, { qty: parseFloat(qty) });
                                    setLogQty(prev => ({ ...prev, [ex.id]: '' }));
                                    loadExtras();
                                    toast(`נרשם: ${qty} ${ex.unit || ''} ${ex.item_name}`, 'success');
                                  } catch (err) { toast(getErrorMessage(err) || 'רישום נכשל', 'error'); }
                                  finally { setLogSaving(prev => ({ ...prev, [ex.id]: false })); }
                                }}
                                className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
                                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                רשום
                              </button>
                            </div>
                          )}

                          {/* פעולות */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              title={ex.is_active ? 'השבת' : 'הפעל'}
                              onClick={async () => {
                                try {
                                  await extrasApi.update(ex.id, { isActive: !ex.is_active });
                                  loadExtras();
                                } catch (err) { toast(getErrorMessage(err) || 'עדכון נכשל', 'error'); }
                              }}
                              className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${ex.is_active ? 'hover:bg-amber-50 text-slate-400 hover:text-amber-600' : 'hover:bg-emerald-50 text-slate-400 hover:text-emerald-600'}`}>
                              {ex.is_active ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                            </button>
                            <button
                              title="מחק"
                              onClick={async () => {
                                if (!await confirm(`למחוק את "${ex.item_name}"?`, 'מחיקה')) return;
                                try {
                                  await extrasApi.delete(ex.id);
                                  loadExtras();
                                } catch (err) { toast(getErrorMessage(err) || 'מחיקה נכשלה', 'error'); }
                              }}
                              className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
