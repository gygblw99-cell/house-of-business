'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSyncEvent } from '@/context/SyncContext';
import {
  TrendingDown, AlertTriangle, RefreshCw,
  Package, Users, Monitor, Wine, Zap, ShieldAlert, ChevronDown, ChevronUp,
  FlaskConical, Flame, CheckCircle2, Brain, Lightbulb,
  BarChart3, AlertCircle, CircleCheck, Utensils, TrendingUp, CalendarDays } from 'lucide-react';
import { dashboardApi, inventoryApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useAppDialog } from '@/context/AppDialogContext';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Explanation {
  whatHappened: string;
  moneyImpact: string;
  causes: string[];
  actions: string[];
}

interface WeeklyHistoryPoint {
  week: number;        // 0 = this week, 3 = 3 weeks ago
  variancePct: number | null;
}

interface DishBreakdownItem {
  dishName: string;
  qtySold: number;
  qtyPerDish: number;
  contribution: number;
}

interface PriceChange {
  recentPrice: number;
  histPrice: number;
  changePct: number;
}

interface IngredientLeak {
  itemId: string;
  name: string;
  unit: string;
  costPerUnit: number;
  expectedQty: number;
  actualQty: number | null;
  variance: number | null;
  variancePct: number | null;
  lossValue: number;
  wasteQty?: number;
  wasteValue?: number;
  severity: 'ok' | 'warning' | 'critical';
  untracked?: boolean;
  weeklyHistory?: WeeklyHistoryPoint[];
  dishBreakdown?: DishBreakdownItem[];
  priceChange?: PriceChange | null;
  explanation: Explanation;
}

interface LeakSummary {
  headline: string;
  detail: string;
  // 'unknown' = the analysis could not be verified (no counted window, or too
  // little of the menu linked to ingredients). It is NOT a low-risk result.
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  verified?: boolean;
}

// How much of the business this analysis could actually observe, and on what
// evidence. Without it an empty result reads as "nothing is leaking" when the
// truth is often "nothing could be measured".
interface LeakCoverage {
  basis: 'counted' | 'derived';
  verifiable: boolean;
  stocktakeCount: number;
  lastStocktake: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  salesLinkedPct: number;
  unlinkedSaleNames: number;
  recipesWithIngredientsPct: number;
  recipesWithIngredients: number;
  recipesTotal: number;
  itemsCostedPct: number;
  itemsTotal: number;
  duplicateItemNames: string[];
}

interface IngredientLeakageResult {
  items: IngredientLeak[];
  totalLoss: number;
  leakScore: number;
  criticalCount: number;
  warningCount: number;
  totalItems: number;
  mostProblematic: string | null;
  summary: LeakSummary;
  projection?: { monthly: number; annual: number };
  days: number;
  coverage?: LeakCoverage;
}

// Was 'recipe_profit_drop' here while the backend has always emitted
// 'recipe_price_drop' — the union simply never matched the wire format.
interface OldLeak {
  type: 'recipe_price_drop' | 'weak_hour' | 'inventory_waste' | 'below_cost_sale';
  bucket?: 'loss' | 'revenue_gap';
  name: string;
  description: string;
  loss: number;
}

interface OldLeakResult {
  totalLoss: number;
  // Revenue that never arrived (weak hours). Deliberately NOT part of totalLoss:
  // no money left the business, so adding it to discarded stock and negative
  // margin produced a headline figure that measured nothing in particular.
  revenueGap?: number;
  breakdown?: { waste: number; belowCost: number; priceDrop: number };
  leaks: OldLeak[];
  hasLeaks: boolean;
}

interface InventoryItemRow {
  id: string;
  name: string;
  unit: string;
  current_qty: number;
}

// ── Severity config ───────────────────────────────────────────────────────────
const SEVERITY = {
  critical: {
    label: 'קריטי',
    bg: 'rgba(239,68,68,0.1)',
    border: 'rgba(239,68,68,0.35)',
    text: '#dc2626',
    barColor: '#ef4444',
    icon: AlertTriangle,
  },
  warning: {
    label: 'אזהרה',
    bg: 'rgba(245,158,11,0.1)',
    border: 'rgba(245,158,11,0.35)',
    text: '#d97706',
    barColor: '#f59e0b',
    icon: AlertCircle,
  },
  ok: {
    label: 'תקין',
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.3)',
    text: '#16a34a',
    barColor: '#22c55e',
    icon: CircleCheck,
  },
};

const RISK_CATEGORIES = [
  {
    id: 1, icon: Package, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200',
    title: 'ניהול מלאי לא טוב',
    items: [
      { short: 'גניבת סחורה – עובדים לוקחים אלכוהול, בשרים או חומרי גלם בלי רישום', full: 'גניבת סחורה על ידי עובדים היא אחת הדליפות השכיחות ביותר במסעדות ובתי קפה. היא מתרחשת לעיתים קרובות במחסנים ובבר, במיוחד עם מוצרים יקרים כמו בשרים, אלכוהול ומצרכים טריים. הפתרון: ספירת מלאי יומית/שבועית, מצלמות במחסן, גישה מוגבלת לאזורי אחסון ותיעוד כניסה ויציאה של סחורה.' },
      { short: 'פחת וחוסר מעקב – מזון מתקלקל, נוזלים נשפכים, חוסר ספירה של מלאי', full: 'פחת טבעי הוא חלק מהעסק, אך חוסר מעקב הופך אותו לחור כספי גדול. מזון שלא מנוהל נכון מתקלקל לפני שנגמר, נוזלים נשפכים ולא נרשמים, והפרש בין המלאי התיאורטי לבפועל גדל.' },
      { short: 'רכישה מיותרת או בזבוז – קנייה של מלאי שלא צריך או שאין לו שימוש בזמן', full: 'הזמנת יתר היא מלכודת נפוצה — הספק מציע הנחה על כמות גדולה, ואתה מזמין יותר ממה שתצרוך. המוצר מתקלקל, המקום נתפס, וכסף נעלם.' },
    ],
  },
  {
    id: 2, icon: Monitor, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200',
    title: 'תקלות במכירה / קופה',
    items: [
      { short: 'חוסר התאמה בין המערכת לבין מה שנמכר בפועל – עובדים "שוכחים" להקיש הזמנה', full: 'כשעובד מגיש פריט בלי להקיש קופה — בין אם בטעות ובין אם בכוונה — הכסף מגיע לעסק אבל לא מתועד. לאורך זמן, זה יוצר פערים גדולים בין מה שנמכר בפועל לבין מה שמדוּוח.' },
      { short: 'הקלדות שגויות או ביטולי הזמנות שלא מתועדים', full: 'ביטול הזמנה שלא עוּבּד דרך המנהל — או הקלדת מחיר שגוי — מוביל להפסד ישיר. חלק מהעובדים מבטלים הזמנות כדי "להחזיר" לחברים מבלי לעדכן את הרשומות.' },
      { short: 'הנחות או כרטיסי מתנה שלא נרשמו', full: 'הנחות "ידידים" שנותן עובד ללא אישור, ארוחות חינמיות לחברים, או כרטיסי מתנה שנפדו בלי רישום — כל אלה גורמים לפערים בין ההכנסה הצפויה לממשית.' },
    ],
  },
  {
    id: 3, icon: Users, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200',
    title: 'עובדים ושכר',
    items: [
      { short: 'שעות עבודה פיקטיביות – עובדים מסמנים כנוכחים כשהם לא', full: 'עובד שמגיע מאוחר ב-30 דקות כל יום, אבל מסמן נוכחות בזמן — גורם להפסד של שעות שכר לאורך חודש שלם.' },
      { short: 'שוחד או הסתרת הכנסות – חלק מהעובדים גונבים כסף מהקופה', full: 'גניבה מהקופה יכולה להתרחש בדרכים רבות: לקיחת שטרות ישירות, אי-רישום עסקאות מזומן, או "עיגול" סכומים לטובת העובד.' },
      { short: 'שירות עצמי עם גניבה אפשרית – בר חופשי או בופה ללא פיקוח', full: 'בופה פתוח, בר חופשי לעובדים, או "ארוחת עובדים" ללא הגבלה — כל אלה עלולים להפוך לדלת פתוחה להוצאות בלתי מבוקרות.' },
    ],
  },
  {
    id: 4, icon: Wine, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200',
    title: 'ניהול בר / מסעדה',
    items: [
      { short: 'מחיר לא נכון – תפריט לא מעודכן, עלויות גבוהות מדי ביחס למחיר', full: 'כשמחיר חומרי גלם עולה ב-20% אך המחיר בתפריט נשאר אותו דבר — הרווח על כל מנה יורד בלי ששמת לב.' },
      { short: 'בזבוז אנרגיה ומשאבים – שימוש במכונות, חשמל, מים שלא מנוהל', full: 'מכונת קפה שנדלקת שעה לפני הפתיחה, מזגנים שרצים על מקסימום, תנור שנשאר פתוח — כל אלה מצטברים לחשבון גבוה מהצורך.' },
      { short: 'שירות איטי או טעויות בהכנה — הזמנות חוזרות ומובילות להפסד', full: 'מנה שחזרה כי הוכנה לא נכון עולה פעמיים: חומרי הגלם נזרקים, והמנה השנייה מוכנה בחינם.' },
    ],
  },
  {
    id: 5, icon: Zap, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200',
    title: 'מערכת הנהלת חשבונות / ERP',
    items: [
      { short: 'חוסר בקרה על דוחות – דוחות לא מעודכנים, טעויות בסגירת משמרת', full: 'כשסגירת משמרת לא מתבצעת כהלכה, ההפרשים לא מאותרים מיידית ונצברים.' },
      { short: 'איחור בעדכון המחירים או עלויות הספקים → הרווחיות יורדת בלי לדעת', full: 'ספק שהעלה מחיר ב-15% — אבל לא עדכנת את עלות המנה במערכת — מוביל לחישוב רווח שגוי.' },
      { short: 'שילוב לא נכון בין הספקים לבין המלאי בפועל', full: 'כשהזמנות לספקים לא מסונכרנות עם רמות המלאי בפועל, תזמין יותר ממה שצריך.' },
    ],
  },
  {
    id: 6, icon: ShieldAlert, color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200',
    title: 'הונאה חיצונית',
    items: [
      { short: 'ספקים שמספקים פחות מהכמות או מנסים להטעות', full: 'ספק שמספק 18 ק"ג במקום 20 ק"ג, או מוצר באיכות נמוכה מהמוזמן — גורם להפסד ישיר שקשה לאתר.' },
      { short: 'לקוחות שמרמים – משלמים במזומן או מנצלים חורים בתפריט', full: 'לקוח שמשאיר שטר ₪200 על חשבון של ₪180, ולוקח עודף מעצמו לפני שהמלצר חוזר — זו גניבה קלאסית.' },
    ],
  },
];

// ── SparkLine ─────────────────────────────────────────────────────────────────
function SparkLine({ data }: { data: WeeklyHistoryPoint[] }) {
  // Display oldest→newest left to right: week 3, 2, 1, 0
  const sorted = [3, 2, 1, 0].map(wk => data.find(d => d.week === wk) ?? { week: wk, variancePct: null });
  if (!sorted.some(d => d.variancePct !== null)) return null;

  const W = 60, H = 22, PAD = 2;
  const maxVal = 40;
  const usableW = W - PAD * 2;
  const usableH = H - PAD * 2;

  const pts = sorted.map((d, i) => ({
    x: PAD + (i / 3) * usableW,
    y: d.variancePct !== null
      ? PAD + usableH - (Math.min(d.variancePct, maxVal) / maxVal) * usableH
      : null,
  }));

  // Build path segments; break on null points (weeks with no sales data)
  const segs: string[] = [];
  let cur = '';
  for (const p of pts) {
    if (p.y === null) { if (cur) { segs.push(cur); cur = ''; } }
    else cur = cur ? `${cur} L${p.x.toFixed(1)},${p.y.toFixed(1)}` : `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  if (cur) segs.push(cur);

  // Color based on the most recent non-null week
  const latest = [...sorted].reverse().find(d => d.variancePct !== null);
  const stroke = !latest ? '#6b7280'
    : latest.variancePct! > 15 ? '#ef4444'
    : latest.variancePct! > 5  ? '#f59e0b'
    : '#22c55e';

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0">
      {/* Zero baseline */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD}
        stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="2,2" />
      {segs.map((seg, i) => (
        <path key={i} d={seg} fill="none" stroke={stroke} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {/* Dots — iterate pts directly so index 3 (newest week) always gets the larger radius,
           regardless of how many earlier weeks are null and filtered out */}
      {pts.map((p, i) =>
        p.y !== null ? (
          <circle key={i} cx={p.x} cy={p.y} r={i === 3 ? 2.5 : 1.5} fill={stroke} />
        ) : null
      )}
    </svg>
  );
}

// ── Ingredient Card ───────────────────────────────────────────────────────────
function IngredientCard({ item, index }: { item: IngredientLeak; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const cfg = SEVERITY[item.severity];
  const SevIcon = cfg.icon;
  const barWidth = item.variancePct != null
    ? Math.min(100, item.variancePct * (item.severity === 'critical' ? 1 : 2))
    : 0;

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all"
      style={{
        background: 'var(--glass-bg, rgba(255,255,255,0.75))',
        backdropFilter: 'blur(20px)',
        border: `1px solid ${item.untracked ? 'rgba(100,116,139,0.4)' : cfg.border}`,
        boxShadow: 'var(--glass-shadow)',
      }}
    >
      {/* ── Header row ── */}
      <button
        className="w-full flex items-center gap-3 px-5 py-4 text-right"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Rank */}
        <span className="text-xs font-black w-5 text-center flex-shrink-0"
          style={{ color: 'var(--color-primary, #1a5c2a)' }}>
          #{index + 1}
        </span>

        {/* Icon */}
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: item.untracked ? 'rgba(100,116,139,0.12)' : cfg.bg }}>
          <SevIcon className="w-5 h-5" style={{ color: item.untracked ? '#64748b' : cfg.text }} />
        </div>

        {/* Name + bar / untracked label */}
        <div className="flex-1 min-w-0 text-right">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="font-bold text-[#e8e8e4] text-sm">{item.name}</span>
            {item.untracked ? (
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                style={{ background: 'rgba(100,116,139,0.15)', color: '#64748b' }}>
                מלאי לא מעוקב
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                style={{ background: cfg.bg, color: cfg.text }}>
                {cfg.label}
              </span>
            )}
            {/* Price change badge */}
            {item.priceChange && Math.abs(item.priceChange.changePct) >= 3 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold leading-none"
                style={{
                  background: item.priceChange.changePct > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                  color: item.priceChange.changePct > 0 ? '#ef4444' : '#22c55e',
                }}>
                {item.priceChange.changePct > 0 ? '▲' : '▼'} מחיר {Math.abs(item.priceChange.changePct).toFixed(0)}%
              </span>
            )}
          </div>
          {/* Variance bar — dotted for untracked */}
          {item.untracked ? (
            <div className="h-1.5 rounded-full w-full max-w-[180px]"
              style={{ background: 'repeating-linear-gradient(90deg,rgba(100,116,139,0.35) 0,rgba(100,116,139,0.35) 4px,transparent 4px,transparent 8px)' }} />
          ) : (
            <div className="h-1.5 rounded-full bg-[#1a1a20] overflow-hidden w-full max-w-[180px]">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${barWidth}%`, background: cfg.barColor }} />
            </div>
          )}
        </div>

        {/* Sparkline — 4-week trend */}
        {item.weeklyHistory && item.weeklyHistory.some(w => w.variancePct !== null) && (
          <div className="hidden sm:flex flex-col items-center gap-0.5 flex-shrink-0">
            <SparkLine data={item.weeklyHistory} />
            <p className="text-[9px] text-[rgba(232,232,228,0.28)]">4 שבועות</p>
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center gap-4 flex-shrink-0">
          {item.untracked ? (
            <div className="text-right">
              <p className="text-xs text-[rgba(232,232,228,0.42)]">ממתכון</p>
              <p className="text-sm font-black text-[#94a3b8]">
                {item.expectedQty}&nbsp;{item.unit}
              </p>
            </div>
          ) : (
            <>
              <div className="text-right">
                <p className="text-xs text-[rgba(232,232,228,0.42)]">חריגה</p>
                <p className="text-sm font-black" style={{ color: cfg.text }}>
                  +{item.variancePct ?? 0}%
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-[rgba(232,232,228,0.42)]">הפסד</p>
                <p className="text-sm font-black text-red-600">
                  ₪{item.lossValue.toFixed(2)}
                </p>
              </div>
            </>
          )}
          {expanded
            ? <ChevronUp className="w-4 h-4 text-[rgba(232,232,228,0.42)]" />
            : <ChevronDown className="w-4 h-4 text-[rgba(232,232,228,0.42)]" />}
        </div>
      </button>

      {/* ── Expanded details ── */}
      {expanded && (
        <div className="px-5 pb-5 space-y-4"
          style={{ borderTop: '1px solid var(--glass-border, rgba(0,0,0,0.07))' }}>

          {/* Raw numbers grid — tracked items only */}
          {!item.untracked && (
            <div className="grid grid-cols-3 gap-3 pt-4">
              {[
                { label: 'צריכה צפויה', value: `${item.expectedQty} ${item.unit}`, color: 'var(--color-primary, #1a5c2a)' },
                { label: 'צריכה בפועל', value: `${item.actualQty ?? '—'} ${item.unit}`, color: '#dc2626' },
                { label: 'עלות ליחידה', value: `₪${item.costPerUnit}`, color: 'var(--color-accent, #c9a227)' },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl p-3 text-center"
                  style={{ background: 'rgba(0,0,0,0.03)' }}>
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mb-1">{label}</p>
                  <p className="text-sm font-black" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Recipe calc summary — untracked items */}
          {item.untracked && (
            <div className="rounded-xl p-4 mt-4"
              style={{ background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.2)' }}>
              <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="w-4 h-4 flex-shrink-0 text-slate-400" />
                <span className="text-xs font-bold text-slate-400">חישוב לפי מתכון</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                לפי מנות שנמכרו ויחס המרכיב במתכון — צפוי שימוש של{' '}
                <strong className="text-[#e8e8e4]">{item.expectedQty} {item.unit}</strong>.
                לא ניתן לאמת מול המלאי כי לא נמצאו עסקאות מלאי בתקופה זו.
              </p>
            </div>
          )}

          {/* Price change detail — when significant */}
          {item.priceChange && Math.abs(item.priceChange.changePct) >= 3 && (
            <div className="rounded-xl p-4"
              style={{
                background: item.priceChange.changePct > 0 ? 'rgba(239,68,68,0.05)' : 'rgba(34,197,94,0.05)',
                border: `1px solid ${item.priceChange.changePct > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
              }}>
              <div className="flex items-center gap-2 mb-2">
                {item.priceChange.changePct > 0
                  ? <TrendingUp className="w-4 h-4 flex-shrink-0 text-red-500" />
                  : <TrendingDown className="w-4 h-4 flex-shrink-0 text-green-500" />}
                <span className="text-xs font-bold"
                  style={{ color: item.priceChange.changePct > 0 ? '#dc2626' : '#16a34a' }}>
                  {item.priceChange.changePct > 0 ? 'מחיר ספק עלה' : 'מחיר ספק ירד'}
                </span>
              </div>
              <p className="text-sm leading-relaxed"
                style={{ color: item.priceChange.changePct > 0 ? '#dc2626' : '#16a34a' }}>
                מחיר ממוצע בחשבוניות האחרונות:{' '}
                <strong>₪{item.priceChange.recentPrice.toFixed(4)}</strong>{' '}
                לעומת ממוצע קודם:{' '}
                <strong>₪{item.priceChange.histPrice.toFixed(4)}</strong>{' '}
                — שינוי של{' '}
                <strong>{item.priceChange.changePct > 0 ? '+' : ''}{item.priceChange.changePct.toFixed(1)}%</strong>.
                {item.priceChange.changePct > 0 && ' מומלץ לעדכן את מחיר הרכישה בהגדרת הפריט ולבדוק אם מחיר המנה עדכני.'}
              </p>
            </div>
          )}

          {/* 🔍 מה קרה */}
          <div className="rounded-xl p-4"
            style={{ background: 'rgba(0,0,0,0.03)' }}>
            <div className="flex items-center gap-2 mb-2">
              <FlaskConical className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-primary)' }} />
              <span className="text-xs font-bold text-[rgba(232,232,228,0.72)]">מה קרה</span>
            </div>
            <p className="text-sm text-[rgba(232,232,228,0.72)] leading-relaxed">
              {item.explanation.whatHappened}
            </p>
          </div>

          {/* 🍽️ פירוט לפי מנה */}
          {!item.untracked && item.dishBreakdown && item.dishBreakdown.length > 0 && (
            <div className="rounded-xl p-4"
              style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Utensils className="w-4 h-4 flex-shrink-0 text-blue-500" />
                <span className="text-xs font-bold text-blue-600">מנות שצרכו את {item.name}</span>
              </div>
              <div className="space-y-2">
                {item.dishBreakdown.map((dish, i) => {
                  const pct = item.expectedQty > 0
                    ? Math.round(dish.contribution / item.expectedQty * 100)
                    : 0;
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-xs font-medium text-blue-700 truncate">{dish.dishName}</span>
                        <span className="text-xs text-blue-500 whitespace-nowrap flex-shrink-0">
                          {dish.qtySold} מנות × {dish.qtyPerDish}{item.unit} ={' '}
                          <strong>{dish.contribution.toFixed(1)}{item.unit}</strong>
                        </span>
                      </div>
                      <div className="h-1 rounded-full overflow-hidden"
                        style={{ background: 'rgba(59,130,246,0.12)' }}>
                        <div className="h-full rounded-full"
                          style={{ width: `${Math.min(100, pct)}%`, background: '#3b82f6' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 💸 כמה כסף — tracked items only */}
          {!item.untracked && (
            <div className="rounded-xl p-4"
              style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)' }}>
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="w-4 h-4 flex-shrink-0 text-red-500" />
                <span className="text-xs font-bold text-red-700">כמה כסף זה עולה לך</span>
              </div>
              <p className="text-sm text-red-700 leading-relaxed">
                {item.explanation.moneyImpact}
              </p>
            </div>
          )}

          {/* 🧠 למה זה קורה */}
          <div className="rounded-xl p-4"
            style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.15)' }}>
            <div className="flex items-center gap-2 mb-2.5">
              <Brain className="w-4 h-4 flex-shrink-0 text-purple-600" />
              <span className="text-xs font-bold text-purple-700">
                {item.untracked ? 'סיבות אפשריות' : 'למה זה קורה — השערות חכמות'}
              </span>
            </div>
            <ul className="space-y-1.5">
              {item.explanation.causes.map((cause, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-purple-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-2 flex-shrink-0" />
                  {cause}
                </li>
              ))}
            </ul>
          </div>

          {/* ✅ מה לעשות */}
          <div className="rounded-xl p-4"
            style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <div className="flex items-center gap-2 mb-2.5">
              <Lightbulb className="w-4 h-4 flex-shrink-0 text-green-600" />
              <span className="text-xs font-bold text-green-700">מה כדאי לעשות עכשיו</span>
            </div>
            <ul className="space-y-1.5">
              {item.explanation.actions.map((action, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-green-800">
                  <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                  {action}
                </li>
              ))}
            </ul>
          </div>

          {/* ── Quick navigation buttons ── */}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              onClick={() => router.push(`/inventory?q=${encodeURIComponent(item.name)}`)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
              style={{ background: 'rgba(201,162,39,0.12)', color: 'var(--color-accent, #c9a227)' }}>
              <Package className="w-3 h-3" /> עדכן מלאי
            </button>
            {item.dishBreakdown && item.dishBreakdown.length > 0 && (
              <button
                onClick={() => router.push(`/recipes?q=${encodeURIComponent(item.dishBreakdown![0].dishName)}`)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa' }}>
                <Utensils className="w-3 h-3" /> ערוך מתכון
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Coverage panel ────────────────────────────────────────────────────────────
// The most important thing this screen can tell an owner is whether it is able
// to see anything at all. Before this existed, a business with no stock counts
// and two thirds of its sales unlinked from any recipe got a green checkmark
// and the words "אין דליפות" — which reads as "you're fine, stop looking".
function CoveragePanel({
  coverage, onStocktake,
}: { coverage: LeakCoverage; onStocktake: () => void }) {
  const blocked = !coverage.verifiable;
  const partial = coverage.salesLinkedPct < 60 || coverage.recipesWithIngredientsPct < 60;

  const tone = blocked
    ? { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.35)', text: '#d97706' }
    : partial
      ? { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.3)', text: '#2563eb' }
      : { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.3)', text: '#16a34a' };

  const bars = [
    { label: 'מכירות מחוברות למתכון', pct: coverage.salesLinkedPct,
      hint: coverage.unlinkedSaleNames > 0 ? `${coverage.unlinkedSaleNames} מנות ללא מרכיבים` : '' },
    { label: 'מתכונים עם מרכיבים', pct: coverage.recipesWithIngredientsPct,
      hint: `${coverage.recipesWithIngredients} מתוך ${coverage.recipesTotal}` },
    { label: 'פריטי מלאי עם עלות', pct: coverage.itemsCostedPct,
      hint: `${coverage.itemsTotal} פריטים` },
  ];

  return (
    <div className="rounded-2xl p-5" style={{ background: tone.bg, border: `1px solid ${tone.border}` }}>
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(0,0,0,0.15)' }}>
          {blocked ? <AlertTriangle className="w-5 h-5" style={{ color: tone.text }} />
                   : <BarChart3 className="w-5 h-5" style={{ color: tone.text }} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm" style={{ color: tone.text }}>
            {blocked ? 'הבדיקה אינה מאומתת — חסרה ספירת מלאי' : 'הבדיקה מאומתת מול ספירת מלאי'}
          </p>
          <p className="text-xs text-[rgba(232,232,228,0.55)] mt-1 leading-relaxed">
            {blocked
              ? 'הצריכה "בפועל" מחושבת כרגע מתנועות המלאי, שנגזרות מהמתכונים עצמם — כלומר המערכת משווה את '
                + 'החישוב לעצמו. שתי ספירות מלאי פיזיות הופכות את זה למדידה אמיתית.'
              : `החישוב מבוסס על ${coverage.stocktakeCount} ספירות מלאי בתקופה — הפער מול המתכון הוא מדידה, לא הערכה.`}
          </p>
        </div>
        {blocked && (
          <Button variant="outline" onClick={onStocktake} className="flex-shrink-0">
            <Package className="w-4 h-4" /> ספירת מלאי
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {bars.map(({ label, pct, hint }) => (
          <div key={label} className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.15)' }}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[11px] text-[rgba(232,232,228,0.55)]">{label}</span>
              <span className="text-sm font-black"
                style={{ color: pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626' }}>
                {pct}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-[#1a1a20] overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.min(100, pct)}%`,
                         background: pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444' }} />
            </div>
            {hint && <p className="text-[10px] text-[rgba(232,232,228,0.3)] mt-1.5">{hint}</p>}
          </div>
        ))}
      </div>

      {coverage.duplicateItemNames?.length > 0 && (
        <p className="text-[11px] text-amber-500 mt-3 leading-relaxed">
          ⚠️ פריטי מלאי כפולים בשם זהה: {coverage.duplicateItemNames.join(', ')} —
          רכישות נרשמות על פריט אחד והצריכה על השני, מה שיוצר חריגה מדומה בשניהם. מומלץ למזג אותם.
        </p>
      )}
    </div>
  );
}

// ── Stocktake modal ───────────────────────────────────────────────────────────
// Deliberately a flat "type what's on the shelf" list: a count that takes ten
// minutes doesn't get done weekly, and a count that doesn't get done weekly
// leaves leak detection blind. Items left blank are skipped, so a partial count
// of the expensive ingredients is a valid and useful count.
function StocktakeModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useAppDialog();
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    inventoryApi.list()
      .then(res => setItems(res.data?.items || res.data || []))
      .catch(err => toast(getErrorMessage(err) || 'טעינת המלאי נכשלה', 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  const filtered = items.filter(i => !search || i.name.includes(search));
  const filledCount = Object.values(counts).filter(v => v !== '' && !isNaN(Number(v))).length;

  const save = async () => {
    const payload = Object.entries(counts)
      .filter(([, v]) => v !== '' && !isNaN(Number(v)) && Number(v) >= 0)
      .map(([itemId, v]) => ({ itemId, countedQty: Number(v) }));
    if (payload.length === 0) {
      toast('לא הוזנה אף כמות', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await inventoryApi.stocktake(payload, 'ספירת מלאי מדף זיהוי דליפות');
      const delta = res.data?.totalDeltaValue ?? 0;
      toast(
        delta < 0
          ? `נספרו ${payload.length} פריטים. חסר במדף בשווי ₪${Math.abs(delta).toFixed(2)} לעומת הרישום.`
          : `נספרו ${payload.length} פריטים בהצלחה.`,
        'success'
      );
      onSaved();
      onClose();
    } catch (err) {
      toast(getErrorMessage(err) || 'שמירת הספירה נכשלה', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl overflow-hidden"
        style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.2)' }}
        onClick={e => e.stopPropagation()} dir="rtl">

        <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)' }}>
          <h2 className="font-bold text-[#e8e8e4]">ספירת מלאי</h2>
          <p className="text-xs text-[rgba(232,232,228,0.42)] mt-1">
            רשום כמה יש באמת על המדף. אפשר לספור רק חלק מהפריטים — מה שנשאר ריק לא ישתנה.
          </p>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="חיפוש פריט..."
            className="w-full mt-3 px-3 py-2 rounded-lg text-sm text-[#e8e8e4] bg-[#0e0e12]"
            style={{ border: '1px solid rgba(201,162,39,0.14)' }}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <p className="text-sm text-[rgba(232,232,228,0.42)] py-8 text-center">טוען מלאי...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[rgba(232,232,228,0.42)] py-8 text-center">לא נמצאו פריטים</p>
          ) : filtered.map(item => (
            <div key={item.id} className="flex items-center gap-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#e8e8e4] truncate">{item.name}</p>
                <p className="text-[11px] text-[rgba(232,232,228,0.3)]">
                  לפי הרישום: {Number(item.current_qty)} {item.unit}
                </p>
              </div>
              <input
                type="number" min="0" step="0.001" inputMode="decimal"
                value={counts[item.id] ?? ''}
                onChange={e => setCounts(c => ({ ...c, [item.id]: e.target.value }))}
                placeholder={item.unit}
                className="w-24 px-2 py-1.5 rounded-lg text-sm text-left text-[#e8e8e4] bg-[#0e0e12]"
                style={{ border: '1px solid rgba(201,162,39,0.14)' }}
              />
            </div>
          ))}
        </div>

        <div className="px-5 py-4 flex items-center gap-3"
          style={{ borderTop: '1px solid rgba(201,162,39,0.14)' }}>
          <span className="text-xs text-[rgba(232,232,228,0.42)] flex-1">
            {filledCount} פריטים נספרו
          </span>
          <Button variant="outline" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={saving} disabled={filledCount === 0}>שמור ספירה</Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ProfitLeakPage() {
  const { toast } = useAppDialog();
  const [tab, setTab] = useState<'ingredients' | 'risks'>('ingredients');
  const [days, setDays] = useState(7);
  const [data, setData] = useState<IngredientLeakageResult | null>(null);
  const [oldData, setOldData] = useState<OldLeakResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [openCategory, setOpenCategory] = useState<number | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning'>('all');
  const [showStocktake, setShowStocktake] = useState(false);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try {
      const [ingRes, oldRes] = await Promise.allSettled([
        dashboardApi.ingredientLeakage(d),
        dashboardApi.profitLeaks(),
      ]);
      if (ingRes.status === 'fulfilled') setData(ingRes.value.data);
      else toast(getErrorMessage(ingRes.reason) || 'טעינת דליפות מלאי נכשלה', 'error');
      if (oldRes.status === 'fulfilled') setOldData(oldRes.value.data);
      else toast(getErrorMessage(oldRes.reason) || 'טעינת דליפות רווח נכשלה', 'error');
      setLastRun(new Date());
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(days); }, [load, days]);
  useSyncEvent(['inventory.updated', 'recipe.updated', 'menu.changed'], () => load(days));

  const filteredItems = (data?.items || []).filter(item => {
    if (filter === 'all') return true;
    return item.severity === filter;
  });

  // 'unknown' must NOT fall through to the green "מצב תקין" default — that is
  // the exact misreading this screen exists to prevent: an unmeasurable result
  // presented as a clean bill of health.
  const riskColor = data?.summary.riskLevel === 'high'    ? { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.3)',  text: '#dc2626', label: 'סיכון גבוה' }
                  : data?.summary.riskLevel === 'medium'  ? { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', text: '#d97706', label: 'סיכון בינוני' }
                  : data?.summary.riskLevel === 'unknown' ? { bg: 'rgba(100,116,139,0.1)', border: 'rgba(100,116,139,0.4)', text: '#94a3b8', label: 'לא נמדד' }
                  : { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.3)', text: '#16a34a', label: 'מצב תקין' };

  return (
    <div className="space-y-5" dir="rtl">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">זיהוי דליפות רווח</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-0.5">
            {lastRun ? `עודכן ${lastRun.toLocaleTimeString('he-IL')}` : 'טוען...'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period selector */}
          <div className="flex rounded-xl overflow-hidden border"
            style={{ borderColor: 'var(--card-border-color, #e5e7eb)' }}>
            {([7, 14, 30] as const).map(d => (
              <button key={d} onClick={() => setDays(d)}
                className="px-3 py-2 text-sm font-medium transition-all"
                style={{
                  background: days === d ? 'var(--color-primary, #1a5c2a)' : 'transparent',
                  color: days === d ? '#fff' : 'var(--color-primary, #1a5c2a)',
                }}>
                {d} ימים
              </button>
            ))}
          </div>
          <Button variant="outline" onClick={() => load(days)} loading={loading}>
            <RefreshCw className="w-4 h-4" /> רענן
          </Button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex rounded-2xl p-1 gap-1" style={{ background: 'rgba(0,0,0,0.06)' }}>
        {[
          { id: 'ingredients', label: 'ניתוח מרכיבים', icon: FlaskConical },
          { id: 'risks',       label: 'גורמי סיכון',    icon: ShieldAlert },
        ].map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id as typeof tab)}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={tab === id
              ? { background: 'var(--color-primary, #1a5c2a)', color: '#fff' }
              : { color: '#6b7280' }}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-2xl animate-pulse"
              style={{ background: 'var(--glass-bg, rgba(255,255,255,0.6))' }} />
          ))}
        </div>
      ) : tab === 'ingredients' ? (
        <>
          {/* ── Coverage / evidence quality ── */}
          {data?.coverage && (
            <CoveragePanel coverage={data.coverage} onStocktake={() => setShowStocktake(true)} />
          )}

          {/* ── Smart Summary Banner ── */}
          {data && (
            <div className="rounded-2xl p-5 flex items-start gap-4"
              style={{
                background: riskColor.bg,
                border: `1px solid ${riskColor.border}`,
                backdropFilter: 'blur(20px)',
              }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: riskColor.border }}>
                {data.summary.riskLevel === 'low'
                  ? <CheckCircle2 className="w-6 h-6" style={{ color: riskColor.text }} />
                  : data.summary.riskLevel === 'unknown'
                    /* neither an all-clear nor an alarm — the analysis simply
                       couldn't see enough to say either way */
                    ? <ShieldAlert className="w-6 h-6" style={{ color: riskColor.text }} />
                    : <Flame className="w-6 h-6" style={{ color: riskColor.text }} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ background: riskColor.border, color: riskColor.text }}>
                    {riskColor.label}
                  </span>
                </div>
                <p className="font-bold text-[#e8e8e4] mb-1">{data.summary.headline}</p>
                <p className="text-sm text-[rgba(232,232,228,0.55)] leading-relaxed">{data.summary.detail}</p>
              </div>
            </div>
          )}

          {/* ── KPI Row ── */}
          {data && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'הפסד כולל', value: `₪${data.totalLoss.toFixed(2)}`, color: '#dc2626', icon: TrendingDown },
                { label: 'ציון דליפה', value: `${data.leakScore}%`, color: data.leakScore > 15 ? '#dc2626' : data.leakScore > 5 ? '#d97706' : '#16a34a', icon: BarChart3 },
                { label: 'קריטיים', value: String(data.criticalCount), color: '#dc2626', icon: AlertTriangle },
                { label: 'אזהרות', value: String(data.warningCount), color: '#d97706', icon: AlertCircle },
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
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── Financial Projection ── */}
          {/* Show projection only when annual loss is at least ₪1 — avoids
               ₪0 monthly / sub-₪1 annual banners from rounding micro-losses */}
          {data?.projection && data.projection.annual >= 1 && (
            <div className="rounded-2xl p-4 grid grid-cols-2 gap-4"
              style={{
                background: 'rgba(239,68,68,0.05)',
                border: '1px solid rgba(239,68,68,0.18)',
                backdropFilter: 'blur(20px)',
              }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(239,68,68,0.12)' }}>
                  <CalendarDays className="w-4 h-4 text-red-500" />
                </div>
                <div>
                  <p className="text-[10px] text-[rgba(232,232,228,0.42)] leading-none mb-0.5">צפי חודשי</p>
                  <p className="text-lg font-black text-red-500 leading-none">
                    ₪{data.projection.monthly.toLocaleString('he-IL', { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(239,68,68,0.18)' }}>
                  <TrendingDown className="w-4 h-4 text-red-600" />
                </div>
                <div>
                  <p className="text-[10px] text-[rgba(232,232,228,0.42)] leading-none mb-0.5">צפי שנתי</p>
                  <p className="text-lg font-black text-red-600 leading-none">
                    ₪{data.projection.annual.toLocaleString('he-IL', { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
              <p className="col-span-2 text-[10px] text-[rgba(232,232,228,0.3)] text-center -mt-2">
                אם קצב הדליפה ימשיך — על בסיס {data.days} ימים אחרונים
              </p>
            </div>
          )}

          {/* ── Also show old realtime leaks if any ── */}
          {oldData?.hasLeaks && (
            <div className="rounded-2xl overflow-hidden"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.75))',
                border: '1px solid rgba(239,68,68,0.2)',
                boxShadow: 'var(--glass-shadow)',
              }}>
              <div className="px-5 py-3 flex items-center gap-2 flex-wrap"
                style={{ borderBottom: '1px solid var(--glass-border)', background: 'rgba(239,68,68,0.05)' }}>
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <span className="text-sm font-bold text-red-700">דליפות בזמן אמת — היום</span>
                {/* Two separate figures on purpose. Money that left the business
                    and revenue that never arrived are different things, and the
                    single mixed total used to be neither. */}
                <span className="text-xs mr-auto flex items-center gap-3">
                  <span className="text-red-500">הפסד: ₪{oldData.totalLoss.toFixed(2)}</span>
                  {(oldData.revenueGap ?? 0) > 0 && (
                    <span className="text-amber-500">פער הכנסה: ₪{(oldData.revenueGap ?? 0).toFixed(2)}</span>
                  )}
                </span>
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--glass-border)' }}>
                {oldData.leaks.map((leak, i) => {
                  const isGap = leak.bucket === 'revenue_gap';
                  return (
                    <div key={i} className="flex items-start gap-3 px-5 py-3">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-[#e8e8e4]">
                          {leak.name}
                          {isGap && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold mr-2"
                              style={{ background: 'rgba(245,158,11,0.15)', color: '#d97706' }}>
                              הכנסה שלא נכנסה
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-[rgba(232,232,228,0.42)]">{leak.description}</p>
                      </div>
                      <span className={`text-sm font-bold ${isGap ? 'text-amber-600' : 'text-red-600'}`}>
                        −₪{leak.loss.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Ingredient list ── */}
          {data && data.items.length > 0 ? (
            <>
              {/* Filter bar */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-[rgba(232,232,228,0.42)] ml-1">סינון:</span>
                {([
                  { id: 'all',      label: `הכל (${data.totalItems})` },
                  { id: 'critical', label: `קריטיים (${data.criticalCount})` },
                  { id: 'warning',  label: `אזהרות (${data.warningCount})` },
                ] as const).map(({ id, label }) => (
                  <button key={id} onClick={() => setFilter(id)}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                    style={filter === id
                      ? { background: 'var(--color-primary, #1a5c2a)', color: '#fff' }
                      : { background: 'rgba(0,0,0,0.06)', color: '#6b7280' }}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                {filteredItems.map((item, i) => (
                  <IngredientCard key={item.itemId} item={item} index={i} />
                ))}
              </div>
            </>
          ) : data ? (
            <div className="text-center py-16"
              style={{
                background: 'var(--glass-bg, rgba(255,255,255,0.6))',
                backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                borderRadius: '1rem',
              }}>
              {/* The green checkmark is reserved for a result the system can
                  actually stand behind. Without a counted window an empty list
                  means "couldn't measure", and showing it as an all-clear is
                  the single most misleading thing this page could do. */}
              {data.coverage?.verifiable ? (
                <>
                  <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--color-primary, #1a5c2a)' }} />
                  <p className="font-bold text-[#e8e8e4]">אין דליפות ב-{days} הימים האחרונים</p>
                  <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">
                    כל המרכיבים בטווח תקין — מאומת מול ספירת מלאי
                  </p>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-12 h-12 mx-auto mb-3 text-amber-500" />
                  <p className="font-bold text-[#e8e8e4]">אין מספיק נתונים כדי לזהות דליפות</p>
                  <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1 max-w-md mx-auto leading-relaxed">
                    זה לא אומר שאין דליפה — אלא שאי אפשר למדוד אותה. בצע ספירת מלאי,
                    וחזור לכאן אחרי הספירה הבאה.
                  </p>
                  <Button className="mt-4" onClick={() => setShowStocktake(true)}>
                    <Package className="w-4 h-4" /> התחל ספירת מלאי
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </>
      ) : (
        /* ── Risk Categories Tab ── */
        <div className="space-y-2">
          <p className="text-sm text-[rgba(232,232,228,0.42)] pb-1">מדריך מלא לזיהוי גורמי דליפת רווח — לחץ על כל קטגוריה לפירוט</p>
          {RISK_CATEGORIES.map(cat => {
            const Icon = cat.icon;
            const isOpen = openCategory === cat.id;
            return (
              <div key={cat.id} className={`rounded-xl border ${cat.border} overflow-hidden`}>
                <button
                  className={`w-full flex items-center gap-3 px-4 py-3 text-right transition-colors ${isOpen ? cat.bg : 'bg-[#141418] hover:bg-[rgba(201,162,39,0.06)]'}`}
                  onClick={() => { setOpenCategory(isOpen ? null : cat.id); setExpandedItem(null); }}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cat.bg}`}>
                    <Icon className={`w-4 h-4 ${cat.color}`} />
                  </div>
                  <span className="flex-1 text-sm font-semibold text-[#e8e8e4]">
                    {cat.id}. {cat.title}
                  </span>
                  <Badge variant="default" className="text-xs">{cat.items.length} גורמים</Badge>
                  {isOpen
                    ? <ChevronUp className="w-4 h-4 text-[rgba(232,232,228,0.42)] flex-shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-[rgba(232,232,228,0.42)] flex-shrink-0" />}
                </button>
                {isOpen && (
                  <ul className="px-5 pb-4 pt-2 space-y-3 bg-[#141418] border-t border-[rgba(201,162,39,0.14)]">
                    {cat.items.map((item, idx) => {
                      const key = `${cat.id}-${idx}`;
                      const isItemExpanded = expandedItem === key;
                      return (
                        <li key={idx} className="text-sm text-[rgba(232,232,228,0.55)]">
                          <div className="flex items-start gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${cat.color.replace('text-', 'bg-')}`} />
                            <div className="flex-1">
                              <span>{item.short}</span>
                              <button
                                onClick={() => setExpandedItem(isItemExpanded ? null : key)}
                                className={`mr-2 text-xs font-medium underline underline-offset-2 ${cat.color} hover:opacity-70`}
                              >
                                {isItemExpanded ? 'סגור' : 'קרא עוד'}
                              </button>
                              {isItemExpanded && (
                                <p className={`mt-2 text-xs leading-relaxed text-[rgba(232,232,228,0.42)] border-r-2 pr-3 ${cat.border}`}>
                                  {item.full}
                                </p>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showStocktake && (
        <StocktakeModal
          onClose={() => setShowStocktake(false)}
          onSaved={() => load(days)}
        />
      )}
    </div>
  );
}
