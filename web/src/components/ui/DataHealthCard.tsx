'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api/client';
import Link from 'next/link';

interface DataHealth {
  hasZReports: boolean;
  hasInvoices: boolean;
  hasFixedExpenses: boolean;
  hasRecipes: boolean;
  hasLaborData: boolean;
  hasInventory: boolean;
  hasDeliveryData: boolean;
}

const CATEGORIES = [
  {
    key: 'hasZReports'      as keyof DataHealth,
    label: 'דוחות קופה',
    icon: '📊',
    why: 'מקור כל נתוני המכירות — ללא זה הדשבורד, תחזיות ו-AI לא יוכלו לפעול',
    href: '/zreport',
    linkLabel: 'העלה דוח',
    critical: true,
  },
  {
    key: 'hasInvoices'      as keyof DataHealth,
    label: 'חשבוניות ספקים',
    icon: '🧾',
    why: 'מאפשר חישוב עלות סחורה (COGS) ורווח גולמי מדויק',
    href: '/invoices',
    linkLabel: 'הוסף חשבונית',
    critical: true,
  },
  {
    key: 'hasInventory'     as keyof DataHealth,
    label: 'מלאי וחומרי גלם',
    icon: '📦',
    why: 'בסיס לחישוב עלות מנה, התראות חוסרים, ומעקב מלאי',
    href: '/inventory',
    linkLabel: 'נהל מלאי',
    critical: false,
  },
  {
    key: 'hasRecipes'       as keyof DataHealth,
    label: 'מתכונים',
    icon: '🍽️',
    why: 'מחשב עלות תיאורטית לכל מנה ומזהה דליפות רווח',
    href: '/recipes',
    linkLabel: 'הגדר מתכונים',
    critical: false,
  },
  {
    key: 'hasLaborData'     as keyof DataHealth,
    label: 'עובדים ומשמרות',
    icon: '👥',
    why: 'מאפשר חישוב עלות עבודה, שכר חודשי ודוח שבועי מלא',
    href: '/employees',
    linkLabel: 'נהל עובדים',
    critical: false,
  },
  {
    key: 'hasFixedExpenses' as keyof DataHealth,
    label: 'הוצאות קבועות',
    icon: '💳',
    why: 'חיוני לחישוב רווח נקי אמיתי — שכ"ד, חשמל, ביטוחים',
    href: '/finance',
    linkLabel: 'הוסף הוצאות',
    critical: false,
  },
  {
    key: 'hasDeliveryData'  as keyof DataHealth,
    label: 'משלוחים',
    icon: '🛵',
    why: 'ניתוח ביצועי Wolt / תן ביס ורווחיות לפי ערוץ',
    href: '/deliveries',
    linkLabel: 'חבר משלוחים',
    critical: false,
  },
] as const;

export default function DataHealthCard() {
  const [health, setHealth]     = useState<DataHealth | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.get('/business/data-health');
      setHealth(data);
    } catch {
      setError(true);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const present = health ? CATEGORIES.filter(c => health[c.key]).length : 0;
  const total   = CATEGORIES.length;
  const missing = health ? CATEGORIES.filter(c => !health[c.key]) : [];
  const criticalMissing = missing.filter(c => c.critical);

  const verdict =
    error                      ? { label: 'שגיאה בטעינה', color: '#ef4444', bg: 'rgba(239,68,68,0.08)', icon: '⚠️' } :
    loading                    ? { label: 'טוען...', color: '#9aa0ab', bg: 'transparent', icon: '…' } :
    criticalMissing.length > 0 ? { label: `${criticalMissing.length} קטגוריות קריטיות חסרות`, color: '#ef4444', bg: 'rgba(239,68,68,0.08)', icon: '🔴' } :
    missing.length === 0       ? { label: 'כל הנתונים הוגדרו — המערכת עובדת במלוא הכוח', color: '#4ade80', bg: 'rgba(74,222,128,0.08)', icon: '🚀' } :
    missing.length <= 2        ? { label: `${missing.length} קטגוריות לשיפור`, color: '#c9a227', bg: 'rgba(201,162,39,0.08)', icon: '📈' } :
                                 { label: `${missing.length} קטגוריות עדיין חסרות`, color: '#f97316', bg: 'rgba(249,115,22,0.08)', icon: '⚠️' };

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.15)' }}>

      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setExpanded(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
        style={{ borderBottom: expanded ? '1px solid rgba(201,162,39,0.10)' : 'none' }}
      >
        <span className="text-lg flex-shrink-0">🔍</span>
        <div className="flex-1 min-w-0 text-right">
          <span className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>בריאות נתונים — מה המערכת צריכה?</span>
          {!loading && !error && (
            <>
              <span className="text-xs mx-2" style={{ color: '#4b5563' }}>·</span>
              <span className="text-xs" style={{ color: '#6b7280' }}>{present}/{total} קטגוריות מוגדרות</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!loading && !error && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold"
              style={{ background: verdict.bg, color: verdict.color }}>
              <span>{verdict.icon}</span>
              <span>{present}/{total}</span>
            </div>
          )}
          {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#9aa0ab' }} />}
          {error && (
            <button onClick={(e) => { e.stopPropagation(); load(); }} className="text-xs px-2 py-0.5 rounded"
              style={{ color: '#c9a227', background: 'rgba(201,162,39,0.1)' }}>
              רענן
            </button>
          )}
          {expanded
            ? <ChevronUp className="w-4 h-4" style={{ color: '#6b7280' }} />
            : <ChevronDown className="w-4 h-4" style={{ color: '#6b7280' }} />}
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <>
          {/* Verdict banner */}
          {!loading && (
            <div className="px-5 py-2 text-xs font-semibold flex items-center justify-between gap-2"
              style={{ background: verdict.bg, color: verdict.color, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span>{verdict.label}</span>
              <button onClick={(e) => { e.stopPropagation(); load(); }}
                className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity text-xs">
                <RefreshCw className="w-3 h-3" />
                רענן
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#9aa0ab' }} />
            </div>
          ) : error ? (
            <div className="px-5 py-6 text-center text-sm" style={{ color: '#9aa0ab' }}>
              שגיאה בטעינת בריאות הנתונים — לחץ רענן לניסיון נוסף
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
              {CATEGORIES.map(cat => {
                const ok = health![cat.key];
                return (
                  <div key={cat.key} className="px-5 py-3.5 flex items-center gap-4">
                    <span className="text-xl flex-shrink-0 w-7 text-center">{cat.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold" style={{ color: ok ? '#e8e8e4' : '#9aa0ab' }}>
                          {cat.label}
                          {cat.critical && !ok && (
                            <span className="mr-2 text-xs px-1.5 py-0.5 rounded font-normal"
                              style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}>קריטי</span>
                          )}
                        </p>
                      </div>
                      {!ok && (
                        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: '#6b7280' }}>{cat.why}</p>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {ok ? (
                        <span className="text-xs px-2.5 py-1 rounded-lg font-semibold"
                          style={{ background: 'rgba(74,222,128,0.1)', color: '#4ade80' }}>✓ מוגדר</span>
                      ) : (
                        <Link href={cat.href}
                          className="text-xs px-2.5 py-1.5 rounded-lg font-semibold transition-all hover:opacity-90"
                          style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}>
                          {cat.linkLabel} ←
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer */}
          {!loading && !error && missing.length > 0 && (
            <div className="px-5 py-2.5 text-xs flex items-center gap-2"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: '#4b5563' }}>
              <span>💡</span>
              <span>
                {criticalMissing.length > 0
                  ? `התחל מ-${criticalMissing.map(c => c.label).join(' ו-')} — הם הבסיס שכל שאר הפיצ'רים נשענים עליהם.`
                  : `${missing.length} פיצ'רים נוספים יהיו זמינים לאחר הגדרת הקטגוריות החסרות.`}
              </span>
            </div>
          )}
          {!loading && !error && missing.length === 0 && (
            <div className="px-5 py-2.5 text-xs" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: '#4ade80' }}>
              🎉 כל הקטגוריות מוגדרות — המערכת עובדת במלוא הכוח שלה.
            </div>
          )}
        </>
      )}
    </div>
  );
}
