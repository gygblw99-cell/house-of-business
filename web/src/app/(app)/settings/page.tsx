'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Building2, User, Save, Eye, EyeOff, CheckCircle, Shield, Mail, Clock,
  HelpCircle, X, ChevronDown, ChevronUp, Package, ChefHat, Truck, Users,
  DollarSign, Monitor, FlaskConical, ArrowLeft, Circle, CheckCircle2, KeyRound, QrCode,
  Sparkles, Download, Loader2, Lock, ExternalLink, Trash2, FileBarChart2, Bike, Percent } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useAppSelector, useAppDispatch } from '@/hooks/useAppDispatch';
import { businessApi, authApi, exportApi } from '@/lib/api';
import api from '@/lib/api/client';
import { restoreSession } from '@/store/slices/authSlice';
import { getErrorMessage, getInitials, downloadBlob } from '@/lib/utils';
import { useSyncEvent } from '@/context/SyncContext';
import { useAppDialog } from '@/context/AppDialogContext';
import DataHealthCard from '@/components/ui/DataHealthCard';

// Read directly (no module-scope throw) — this page's module is evaluated during
// `next build`'s page-data-collection pass, before Railway's runtime env vars are
// guaranteed available, so throwing here would fail the build itself.
const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL || 'http://localhost:4000';

// ── Support Panel — One-time setup guide ─────────────────────────────────────

const SETUP_SECTIONS = [
  {
    id: 'zreport',
    icon: FileBarChart2,
    color: '#c9a227',
    colorBg: 'rgba(201,162,39,0.1)',
    title: 'העלאת דוחות',
    badge: 'צעד 1',
    why: 'דוחות הקופה הם מקור הנתונים המרכזי של הפלטפורמה — מכירות, מנות, פדיון יומי. ללא דוחות, הדשבורד, הפיננסים והתחזית יהיו ריקים.',
    steps: [
      'עבור ל"דוחות" בתפריט הצד',
      'הכי מהיר: לחץ "התחבר עם Gmail" — הפלטפורמה תזהה ותייבא דוחות אוטומטית',
      'או: לחץ "העלה דוח" ובחר קובץ (EML, XLSX ועוד פורמטים נתמכים) שיצא מהקופה שלך',
      'הפלטפורמה תעבד את הקובץ ותעדכן את הנתונים אוטומטית',
      'חזור על כך לכל חודש שרוצים לנתח (או תן לחיבור Gmail לעשות זאת אוטומטית)',
    ],
    tip: 'מומלץ להתחיל מ-3 חודשים אחורה לפחות — ככה התחזית והמגמות יהיו מדויקים יותר.',
    href: '/zreport',
    linkLabel: 'פתח דוחות',
  },
  {
    id: 'inventory',
    icon: Package,
    color: '#f59e0b',
    colorBg: 'rgba(245,158,11,0.1)',
    title: 'חומרי גלם ומלאי',
    badge: 'צעד 2',
    why: 'הבסיס לכל החישובים — עלות מנה, דליפות רווח, והזמנות אוטומטיות לספקים.',
    steps: [
      'עבור ללשונית מלאי בתפריט הצד',
      'לחץ "פריט חדש" להוספת כל חומר גלם',
      'הגדר שם, יחידת מידה (ק"ג / ליטר / יחידה), כמות מינימום לאזהרה',
      'הזן עלות ליחידה — זה ישמש לחישוב עלות כל מנה',
      'חזור על כך לכל חומרי הגלם שלך',
    ],
    tip: 'מומלץ להתחיל מ-20-30 חומרי הגלם הנפוצים ביותר. ניתן להוסיף עוד בהמשך.',
    href: '/inventory',
    linkLabel: 'פתח מלאי',
  },
  {
    id: 'recipes',
    icon: FlaskConical,
    color: '#8b5cf6',
    colorBg: 'rgba(139,92,246,0.1)',
    title: 'הרכב מתכונים',
    badge: 'צעד 3',
    why: 'זה מה שמאפשר לחשב דליפות רווח — המערכת יודעת כמה עוף / גבינה / שמן כל מנה "אמורה" לצרוך ומשווה לכמות שנצרכה בפועל.',
    steps: [
      'עבור ללשונית מנות בתפריט הצד',
      'לחץ על שם מנה קיימת (מגיעה אוטומטית מהקופה)',
      'לחץ על "הרכב מתכון"',
      'הוסף כל חומר גלם עם הכמות המדויקת למנה (לדוגמה: עוף 200 גרם, שמן 20 מ"ל)',
      'שמור — חזור לכל שאר המנות',
    ],
    tip: 'התחל מהמנות הנמכרות ביותר — הן שמשפיעות הכי הרבה על החישוב.',
    href: '/recipes',
    linkLabel: 'פתח מנות',
  },
  {
    id: 'suppliers',
    icon: Truck,
    color: '#06b6d4',
    colorBg: 'rgba(6,182,212,0.1)',
    title: 'ספקים',
    badge: 'צעד 4',
    why: 'נדרש להזמנות אוטומטיות, השוואת מחירים, ומעקב חשבוניות.',
    steps: [
      'עבור ללשונית ספקים',
      'לחץ "ספק חדש" — הוסף שם, טלפון, ואימייל',
      'קשר לכל ספק את חומרי הגלם שהוא מספק',
      'הגדר שיטת הזמנה (ווצאפ / אימייל / טלפון)',
    ],
    tip: 'לאחר הגדרת הספקים, ניתן לשלוח הזמנות יומיות בלחיצה אחת ישירות מהמערכת.',
    href: '/suppliers',
    linkLabel: 'פתח ספקים',
  },
  {
    id: 'employees',
    icon: Users,
    color: '#10b981',
    colorBg: 'rgba(16,185,129,0.1)',
    title: 'עובדים ושכר',
    badge: 'צעד 5',
    why: 'נדרש לחישוב תלושי שכר, ניהול משמרות, ופורטל העובד.',
    steps: [
      'עבור ללשונית עובדים',
      'לחץ "הוסף עובד" — הזן שם, אימייל, טלפון',
      'הגדר סוג שכר: לפי שעה / גלובלי / לפי יום',
      'הזן שכר בסיס ותפקיד',
      'שלח הזמנה לעובד — הוא יקבל גישה לפורטל העובד',
    ],
    tip: 'עובדים שנרשמו יכולים לראות משמרות, תלושי שכר והודעות מהאפליקציה הנפרדת שלהם.',
    href: '/employees',
    linkLabel: 'פתח עובדים',
  },
  {
    id: 'finance',
    icon: DollarSign,
    color: '#ef4444',
    colorBg: 'rgba(239,68,68,0.1)',
    title: 'הוצאות קבועות',
    badge: 'צעד 6',
    why: 'ללא הגדרת הוצאות קבועות, חישוב הרווח הנקי יהיה חלקי.',
    steps: [
      'עבור ללשונית פיננסים',
      'לחץ "הוסף הוצאה קבועה"',
      'הוסף: שכר דירה, חשמל, מים, ביטוח, שיווק, ועוד',
      'הגדר האם ההוצאה חודשית / שבועית / שנתית',
    ],
    tip: 'ניתן גם לסרוק חשבוניות — המערכת מחלצת את הסכום אוטומטית.',
    href: '/finance',
    linkLabel: 'פתח פיננסים',
  },
  {
    id: 'pos',
    icon: Monitor,
    color: '#3b82f6',
    colorBg: 'rgba(59,130,246,0.1)',
    title: 'חיבור קופה',
    badge: 'צעד 7',
    why: 'לאחר החיבור, כל המכירות נשמרות אוטומטית ומזינות את כל הדוחות, דליפות הרווח, והתחזית.',
    steps: [
      'עבור ללשונית קופה',
      'לחץ "חבר קופה"',
      'בחר ספק קופה (ביקום / אביב / אחר)',
      'הזן את מפתח ה-API שקיבלת מהספק',
      'לחץ חבר — ההיסטוריה תישאב אוטומטית ברקע',
    ],
    tip: 'לאחר החיבור, הקופה מסונכרנת כל 15 דקות אוטומטית — אין צורך לעשות כלום.',
    href: '/pos',
    linkLabel: 'פתח קופה',
  },
  {
    id: 'platforms',
    icon: Bike,
    color: '#60a5fa',
    colorBg: 'rgba(96,165,250,0.1)',
    title: 'חברות שעובדות עם המסעדה',
    badge: 'צעד 8',
    why: 'וולט ותן ביס גובים עמלה מכל הזמנה — גם משלוח וגם תשלום בכרטיס שלהם בתוך המסעדה. בלי להגדיר את האחוזים, הרווח הנקי שמוצג לך מתעלם מהעמלות האלה ונראה גבוה מהאמת.',
    steps: [
      'עבור להגדרות → לשונית "חברות משלוחים"',
      'הזן את אחוז העמלה שוולט גובה ממך',
      'הזן את אחוז העמלה שתן ביס גובה ממך',
      'אם הקופה שלך כבר כוללת את הסכומים האלה בדוח ה-Z — סמן את התיבה המתאימה',
      'שמור',
    ],
    tip: 'אחרי ההגדרה, עמוד "פיננסים" יראה לך גם את הרווח לפני העמלות וגם אחריהן.',
    href: '/settings?tab=platforms',
    linkLabel: 'פתח הגדרות עמלות',
  },
];

const LS_KEY = 'hob_setup_done';

function SupportPanel({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<string | null>('inventory');
  const [done, setDone] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });

  const toggle = (id: string) => setOpen(p => p === id ? null : id);
  const toggleDone = (id: string) => setDone(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch {}
    return next;
  });

  const panel = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'stretch',
      }}
      dir="rtl"
    >
      {/* Backdrop */}
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* Panel — pinned to right edge, full height */}
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: '100%', maxWidth: '480px',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'var(--glass-bg, #141418)',
          borderLeft: '1px solid var(--glass-border, rgba(0,0,0,0.1))',
          boxShadow: '-8px 0 40px rgba(0,0,0,0.2)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-4 flex-shrink-0"
          style={{
            background: 'var(--hero-gradient)',
          }}
        >
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
            <HelpCircle className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <p className="font-bold text-white text-base">מדריך הגדרות ראשוניות</p>
            <p className="text-xs text-white/70">7 שלבים להפעלת הפלטפורמה במלואה</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--glass-border, rgba(0,0,0,0.07))' }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-[rgba(232,232,228,0.6)]">התקדמות ההגדרה</span>
            <span className="text-xs text-[rgba(232,232,228,0.4)]">{done.size} / {SETUP_SECTIONS.length} שלבים הושלמו</span>
          </div>
          <div className="h-2 bg-[#1a1a20] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${(done.size / SETUP_SECTIONS.length) * 100}%`,
                background: 'var(--color-primary, #1a5c2a)',
              }}
            />
          </div>
          {done.size === SETUP_SECTIONS.length && (
            <p className="text-xs text-green-600 font-semibold mt-1.5 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> כל ההגדרות הושלמו — הפלטפורמה פועלת במלואה!
            </p>
          )}
        </div>

        {/* Sections */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {SETUP_SECTIONS.map((sec) => {
            const Icon = sec.icon;
            const isOpen = open === sec.id;
            const isDone = done.has(sec.id);

            return (
              <div
                key={sec.id}
                className="rounded-2xl overflow-hidden transition-all"
                style={{
                  border: `1px solid ${isDone ? 'rgba(34,197,94,0.35)' : isOpen ? sec.color + '40' : 'rgba(0,0,0,0.07)'}`,
                  background: isDone ? 'rgba(34,197,94,0.04)' : isOpen ? sec.colorBg : 'rgba(20,20,24,0.85)',
                }}
              >
                {/* Row header */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-right"
                  onClick={() => toggle(sec.id)}
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: isDone ? 'rgba(34,197,94,0.15)' : sec.colorBg }}
                  >
                    {isDone
                      ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                      : <Icon className="w-5 h-5" style={{ color: sec.color }} />
                    }
                  </div>
                  <div className="flex-1 min-w-0 text-right">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-[rgba(232,232,228,0.75)]">{sec.title}</span>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-full font-semibold"
                        style={{ background: sec.colorBg, color: sec.color }}
                      >
                        {sec.badge}
                      </span>
                      {isDone && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold bg-green-100 text-green-700">
                          ✓ הושלם
                        </span>
                      )}
                    </div>
                  </div>
                  {isOpen
                    ? <ChevronUp className="w-4 h-4 text-[rgba(232,232,228,0.4)] flex-shrink-0" />
                    : <ChevronDown className="w-4 h-4 text-[rgba(232,232,228,0.4)] flex-shrink-0" />
                  }
                </button>

                {/* Expanded content */}
                {isOpen && (
                  <div className="px-4 pb-4 space-y-3" style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                    {/* Why */}
                    <div className="pt-3">
                      <p className="text-xs font-semibold text-[rgba(232,232,228,0.45)] mb-1">למה זה חשוב?</p>
                      <p className="text-sm text-[rgba(232,232,228,0.75)] leading-relaxed">{sec.why}</p>
                    </div>

                    {/* Steps */}
                    <div>
                      <p className="text-xs font-semibold text-[rgba(232,232,228,0.45)] mb-2">איך עושים זאת?</p>
                      <ol className="space-y-2">
                        {sec.steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2.5 text-sm text-[rgba(232,232,228,0.75)]">
                            <span
                              className="w-5 h-5 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 mt-0.5"
                              style={{ background: sec.color, fontSize: '10px' }}
                            >
                              {i + 1}
                            </span>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>

                    {/* Tip */}
                    <div
                      className="rounded-xl px-3 py-2.5 text-xs text-[rgba(232,232,228,0.6)] leading-relaxed"
                      style={{ background: sec.colorBg }}
                    >
                      <span className="font-bold" style={{ color: sec.color }}>💡 טיפ: </span>
                      {sec.tip}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-1">
                      <Link
                        href={sec.href}
                        onClick={onClose}
                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl text-white transition-all hover:opacity-90"
                        style={{ background: sec.color }}
                      >
                        {sec.linkLabel}
                        <ArrowLeft className="w-3.5 h-3.5" />
                      </Link>
                      <button
                        onClick={() => toggleDone(sec.id)}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl transition-all"
                        style={{
                          background: isDone ? 'rgba(34,197,94,0.12)' : 'rgba(0,0,0,0.05)',
                          color: isDone ? '#16a34a' : '#6b7280',
                        }}
                      >
                        {isDone ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                        {isDone ? 'בוצע' : 'סמן כבוצע'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 flex-shrink-0 text-center"
          style={{ borderTop: '1px solid var(--glass-border, rgba(0,0,0,0.07))' }}
        >
          <p className="text-xs text-[rgba(232,232,228,0.4)]">
            כל שאלה? פנה לתמיכה בכתובת{' '}
            <a href="mailto:support@houseofbusiness.co.il" className="text-blue-500 underline">
              support@houseofbusiness.co.il
            </a>
          </p>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

const DAYS_SETUP = [
  { key: 'sun', label: 'ראשון' }, { key: 'mon', label: 'שני' },
  { key: 'tue', label: 'שלישי' }, { key: 'wed', label: 'רביעי' },
  { key: 'thu', label: 'חמישי' }, { key: 'fri', label: 'שישי' },
  { key: 'sat', label: 'שבת' },
];

interface DayConfig { open: boolean; from: string; to: string; }
type OpenDays = Record<string, DayConfig>;

interface BizUser {
  id: string; full_name: string; email: string; role: string;
  pending_invite?: boolean; is_active?: boolean;
  perm_suppliers: boolean; perm_inventory: boolean; perm_recipes: boolean;
  perm_finance: boolean; perm_ai: boolean; perm_employees: boolean;
  perm_export: boolean; perm_audit: boolean;
}

const PERM_LABELS: { key: keyof BizUser; label: string; color: string; icon: React.ElementType; features: string[] }[] = [
  {
    key: 'perm_finance', label: 'פיננסים', color: '#ef4444', icon: DollarSign,
    features: ['רווח יומי ותזרים מזומנים', 'תחזית 30 ו-90 יום', 'הוצאות קבועות', 'דוח מע"מ', 'שכר ותלושים', 'ניתוח P&L', 'חיזוי ביקוש', 'הזמנות חכמות'],
  },
  {
    key: 'perm_employees', label: 'עובדים', color: '#10b981', icon: Users,
    features: ['צפייה וניהול עובדים', 'ניהול משמרות', 'ביצועי עובדים', 'תכנון משמרות חכם AI', 'התראות חוק עבודה'],
  },
  {
    key: 'perm_inventory', label: 'מלאי', color: '#f59e0b', icon: Package,
    features: ['צפייה ועדכון מלאי', 'עסקאות (צריכה / פסולת)', 'אזהרות מלאי נמוך', 'מעקב תאריכי תפוגה', 'הצעות הזמנה חכמה'],
  },
  {
    key: 'perm_suppliers', label: 'ספקים', color: '#06b6d4', icon: Truck,
    features: ['ניהול ספקים', 'שליחת הזמנות (ווצאפ / מייל)', 'השוואת מחירים AI', 'חשבוניות ספקים', 'ספר חשבונות ספקים'],
  },
  {
    key: 'perm_recipes', label: 'מתכונים', color: '#8b5cf6', icon: ChefHat,
    features: ['ניהול מתכונים', 'חישוב עלות מנה', 'קטגוריות ומאגר מנות', 'ניתוח רווחיות מנה'],
  },
  {
    key: 'perm_ai', label: 'יועץ AI', color: '#c9a227', icon: Sparkles,
    features: ['יועץ עסקי AI (שאלות חופשיות)', 'ניתוח מכירות AI', 'תובנות אוטומטיות', 'מצב הישרדות AI'],
  },
  {
    key: 'perm_export', label: 'ייצוא', color: '#3b82f6', icon: Download,
    features: ['ייצוא עובדים ומשמרות Excel', 'ייצוא מלאי', 'ייצוא חשבוניות', 'ייצוא דוחות כספיים ו-P&L'],
  },
  {
    key: 'perm_audit', label: 'ביקורת', color: '#f97316', icon: Shield,
    features: ['ביקורת עסקית AI', 'גילוי חריגות והונאות', 'היסטוריית ביקורות'],
  },
];

export default function SettingsPage() {
  const { toast, confirm } = useAppDialog();
  const dispatch = useAppDispatch();
  const { user, business } = useAppSelector((s) => s.auth);
  const [activeTab, setActiveTab] = useState<'business' | 'hours' | 'platforms' | 'profile' | 'password' | 'permissions' | 'privacy'>('business');

  // Deep-link support (e.g. the quick-setup guide links to ?tab=platforms) —
  // read directly from window.location instead of useSearchParams() so this
  // doesn't force the whole (already very large) page into a Suspense boundary.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'business' || tab === 'hours' || tab === 'platforms' || tab === 'profile' || tab === 'password' || tab === 'permissions' || tab === 'privacy') {
      setActiveTab(tab);
    }
  }, []);
  const [bizUsers, setBizUsers] = useState<BizUser[]>([]);
  const [permSaving, setPermSaving] = useState<string | null>(null);
  const [permSaved,  setPermSaved]  = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [exportingAll, setExportingAll] = useState(false);
  const [deletionSending, setDeletionSending] = useState(false);
  const [deletionRequested, setDeletionRequested] = useState(false);

  // Business hours state
  const [openDays, setOpenDays] = useState<OpenDays>(() =>
    Object.fromEntries(DAYS_SETUP.map(d => [d.key, { open: true, from: '08:00', to: '23:00' }]))
  );
  const [hoursLoading, setHoursLoading] = useState(false);

  // Business form
  const [bizForm, setBizForm] = useState({
    name: '', address: '', phone: '', vat_number: '', primary_email: '',
    wolt_commission_pct: '' as string | number, ten_bis_commission_pct: '' as string | number,
    z_report_includes_delivery_platforms: false,
  });
  const [bizLoading, setBizLoading] = useState(false);
  const [bizError, setBizError] = useState('');
  const [bizLoadError, setBizLoadError] = useState(false);
  const [platformsLoading, setPlatformsLoading] = useState(false);
  const [platformsError, setPlatformsError] = useState('');

  // Profile form
  const [profileForm, setProfileForm] = useState({ fullName: '', email: '' });
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');

  // Password form
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState('');

  // 2FA state
  const [twoFAEnabled, setTwoFAEnabled]   = useState(false);
  const [twoFAQr, setTwoFAQr]             = useState('');
  const [twoFASecret, setTwoFASecret]     = useState('');
  const [twoFACode, setTwoFACode]         = useState('');
  const [twoFAStep, setTwoFAStep]         = useState<'idle' | 'setup' | 'disable'>('idle');
  const [twoFALoading, setTwoFALoading]   = useState(false);
  const [twoFAError, setTwoFAError]       = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showSupport, setShowSupport] = useState(false);

  useEffect(() => {
    if (user) {
      setProfileForm({ fullName: user.fullName || '', email: user.email || '' });
    }
  }, [user]);

  useEffect(() => {
    businessApi.get().then(({ data }) => {
      setBizLoadError(false);
      setBizForm({
        name:          data.name          || '',
        address:       data.address       || '',
        phone:         data.phone         || '',
        vat_number:    data.vat_number    || '',
        primary_email: data.primary_email || '',
        wolt_commission_pct:    data.wolt_commission_pct    ?? '',
        ten_bis_commission_pct: data.ten_bis_commission_pct ?? '',
        z_report_includes_delivery_platforms: !!data.z_report_includes_delivery_platforms,
      });
      if (data.open_hours) {
        setOpenDays(prev => ({ ...prev, ...data.open_hours }));
      }
    }).catch(() => setBizLoadError(true));
    authApi.twoFA.status().then(({ data }) => setTwoFAEnabled(data.enabled)).catch(() => {});
  }, []);

  const loadUsers = useCallback(() => {
    businessApi.users().then(({ data }) => {
      setBizUsers(Array.isArray(data) ? data : []);
    }).catch(() => {});
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useSyncEvent('employee.updated', loadUsers);

  const showSuccess = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(''), 3000);
  };

  const saveBusiness = async () => {
    setBizLoading(true); setBizError('');
    try {
      const { wolt_commission_pct: _w, ten_bis_commission_pct: _t, z_report_includes_delivery_platforms: _z, ...businessFields } = bizForm;
      await businessApi.update(businessFields);
      await dispatch(restoreSession());
      showSuccess('פרטי העסק עודכנו');
    } catch (err) { setBizError(getErrorMessage(err)); }
    finally { setBizLoading(false); }
  };

  const savePlatforms = async () => {
    setPlatformsLoading(true); setPlatformsError('');
    try {
      await businessApi.update({
        wolt_commission_pct:    bizForm.wolt_commission_pct    === '' ? null : parseFloat(String(bizForm.wolt_commission_pct)),
        ten_bis_commission_pct: bizForm.ten_bis_commission_pct === '' ? null : parseFloat(String(bizForm.ten_bis_commission_pct)),
        z_report_includes_delivery_platforms: bizForm.z_report_includes_delivery_platforms,
      });
      await dispatch(restoreSession());
      showSuccess('עמלות הפלטפורמות עודכנו');
    } catch (err) { setPlatformsError(getErrorMessage(err)); }
    finally { setPlatformsLoading(false); }
  };

  const saveProfile = async () => {
    setProfileLoading(true); setProfileError('');
    try {
      await businessApi.updateProfile(profileForm);
      await dispatch(restoreSession());
      showSuccess('הפרופיל עודכן');
    } catch (err) { setProfileError(getErrorMessage(err)); }
    finally { setProfileLoading(false); }
  };

  const savePassword = async () => {
    if (pwForm.newPassword !== pwForm.confirm) { setPwError('הסיסמאות אינן תואמות'); return; }
    if (pwForm.newPassword.length < 6) { setPwError('לפחות 6 תווים'); return; }
    setPwLoading(true); setPwError('');
    try {
      await businessApi.changePassword({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword });
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' });
      showSuccess('הסיסמה שונתה');
    } catch (err) { setPwError(getErrorMessage(err)); }
    finally { setPwLoading(false); }
  };

  const start2FASetup = async () => {
    setTwoFALoading(true); setTwoFAError('');
    try {
      const { data } = await authApi.twoFA.setup();
      setTwoFAQr(data.qrCode); setTwoFASecret(data.secret);
      setTwoFAStep('setup');
    } catch (err) { setTwoFAError(getErrorMessage(err)); }
    finally { setTwoFALoading(false); }
  };

  const confirm2FAEnable = async () => {
    setTwoFALoading(true); setTwoFAError('');
    try {
      await authApi.twoFA.enable(twoFACode);
      setTwoFAEnabled(true); setTwoFAStep('idle'); setTwoFACode('');
      toast('✅ אימות דו-שלבי הופעל');
    } catch (err) { setTwoFAError(getErrorMessage(err)); }
    finally { setTwoFALoading(false); }
  };

  const confirm2FADisable = async () => {
    setTwoFALoading(true); setTwoFAError('');
    try {
      await authApi.twoFA.disable(twoFACode);
      setTwoFAEnabled(false); setTwoFAStep('idle'); setTwoFACode('');
      toast('אימות דו-שלבי כובה');
    } catch (err) { setTwoFAError(getErrorMessage(err)); }
    finally { setTwoFALoading(false); }
  };

  const togglePerm = async (userId: string, key: keyof BizUser, current: boolean) => {
    setPermSaving(userId + key);
    try {
      await businessApi.updatePermissions(userId, { [key]: !current });
      setBizUsers(prev => prev.map(u => u.id === userId ? { ...u, [key]: !current } : u));
      setPermSaved(userId + key);
      setTimeout(() => setPermSaved(null), 1500);
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setPermSaving(null); }
  };

  const saveHours = async () => {
    setHoursLoading(true);
    try {
      await businessApi.completeOnboarding({ open_days: openDays });
      showSuccess('שעות הפעילות עודכנו');
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setHoursLoading(false); }
  };

  const tabs = [
    { id: 'business' as const,     label: 'פרטי העסק',     icon: Building2 },
    { id: 'hours' as const,        label: 'שעות פעילות',   icon: Clock },
    { id: 'platforms' as const,    label: 'חברות משלוחים', icon: Bike },
    { id: 'profile' as const,      label: 'פרופיל אישי',   icon: User },
    { id: 'password' as const,     label: 'שינוי סיסמה',   icon: EyeOff },
    { id: 'permissions' as const,  label: 'הרשאות',         icon: Shield },
    { id: 'privacy' as const,      label: 'פרטיות ונתונים', icon: Lock },
  ];

  const handleExportAllData = async () => {
    setExportingAll(true);
    try {
      const now = new Date();
      const res = await exportApi.all(now.getFullYear(), now.getMonth() + 1);
      downloadBlob(res.data, `כל-הנתונים-שלי-${now.getFullYear()}-${now.getMonth() + 1}.xlsx`);
    } catch (err) {
      toast(getErrorMessage(err) || 'ייצוא הנתונים נכשל', 'error');
    } finally {
      setExportingAll(false);
    }
  };

  const handleRequestDeletion = async () => {
    const ok = await confirm(
      'הבקשה תישלח לצוות התמיכה ותטופל תוך זמן סביר. שימו לב: מסמכים מסוימים (כגון חשבוניות) עשויים להישמר לתקופה הנדרשת על-פי חוק לצרכי מס, גם לאחר מחיקת החשבון.',
      'בקשת מחיקת חשבון',
      'שלח בקשה'
    );
    if (!ok) return;
    setDeletionSending(true);
    try {
      await api.post('/guardian/tickets', {
        issueType: 'gdpr_deletion',
        title: 'בקשת מחיקת חשבון (GDPR)',
        description: `בעל/ת החשבון ${user?.fullName || ''} (${user?.email || ''}) מהעסק "${business?.name || ''}" ביקש/ה למחוק את חשבון העסק ואת כל הנתונים הקשורים אליו.`,
        severity: 'high',
      });
      setDeletionRequested(true);
      toast('הבקשה נשלחה לצוות התמיכה', 'success');
    } catch (err) {
      toast(getErrorMessage(err) || 'שליחת הבקשה נכשלה', 'error');
    } finally {
      setDeletionSending(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">
      {showSupport && <SupportPanel onClose={() => setShowSupport(false)} />}

      <DataHealthCard />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#e8e8e4]">הגדרות</h1>
        <button
          onClick={() => setShowSupport(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
          style={{
            background: 'var(--color-primary, #1a5c2a)',
            color: '#fff',
          }}
        >
          <HelpCircle className="w-4 h-4" />
          הגדרות ראשוניות
        </button>
      </div>

      {saved && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
          <CheckCircle className="w-4 h-4" /> {saved}
        </div>
      )}

      {/* Tabs — overflow-x: auto so all 6 tabs are reachable on mobile */}
      <div className="relative">
        <div className="flex gap-1 bg-[#1a1a20] p-1 rounded-xl overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all flex-shrink-0 ${
                activeTab === id ? 'bg-[#141418] shadow-sm text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.45)] hover:text-[rgba(232,232,228,0.75)]'
              }`}
            >
              <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              {label}
            </button>
          ))}
        </div>
        {/* Left-side fade — indicates more tabs are reachable by swiping left (RTL) */}
        <div
          className="absolute inset-y-0 left-0 w-8 rounded-l-xl pointer-events-none sm:hidden"
          style={{ background: 'linear-gradient(to right, #1a1a20, transparent)' }}
        />
      </div>

      {/* Business */}
      {activeTab === 'business' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-600" /> פרטי העסק
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {bizLoadError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
                לא ניתן לטעון את פרטי העסק — בדוק חיבור ורענן את הדף
              </div>
            )}
            <Input label="שם העסק" value={bizForm.name}
              onChange={e => setBizForm(f => ({ ...f, name: e.target.value }))} />
            <Input label="כתובת" value={bizForm.address} placeholder="רחוב, עיר"
              onChange={e => setBizForm(f => ({ ...f, address: e.target.value }))} />
            <div className="grid grid-cols-2 gap-4">
              <Input label="טלפון" type="tel" value={bizForm.phone}
                onChange={e => setBizForm(f => ({ ...f, phone: e.target.value }))} />
              <Input label='ח"פ / מספר עוסק' value={bizForm.vat_number} placeholder="000000000"
                onChange={e => setBizForm(f => ({ ...f, vat_number: e.target.value }))} />
            </div>

            {/* Primary email */}
            <div className="pt-2 border-t border-[rgba(201,162,39,0.14)]">
              <div className="flex items-center gap-2 mb-3">
                <Mail className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-semibold text-[rgba(232,232,228,0.75)]">מייל ראשי</span>
              </div>
              <Input
                label="כתובת מייל ראשית"
                type="email"
                value={bizForm.primary_email}
                placeholder="business@example.com"
                onChange={e => setBizForm(f => ({ ...f, primary_email: e.target.value }))}
              />
              <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1.5">
                מייל זה ישמש לקבלת כל בקשות השוואת מחירים, הזמנות לספקים ופעילות העסק
              </p>
            </div>

            {bizError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{bizError}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={saveBusiness} loading={bizLoading}>
                <Save className="w-4 h-4" /> שמור שינויים
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hours */}
      {activeTab === 'hours' && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-blue-600" /> שעות פעילות
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {DAYS_SETUP.map(({ key, label }) => (
                <div key={key} className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                  openDays[key]?.open ? 'border-blue-200 bg-blue-950/20' : 'border-[rgba(201,162,39,0.14)] bg-[#1a1a20]'
                }`}>
                  <button
                    type="button"
                    onClick={() => setOpenDays(prev => ({ ...prev, [key]: { ...prev[key], open: !prev[key].open } }))}
                    className={`w-20 h-9 rounded-lg font-semibold text-sm transition-colors flex-shrink-0 ${
                      openDays[key]?.open ? 'bg-blue-600 text-white' : 'bg-[#141418] border border-[rgba(201,162,39,0.14)] text-[rgba(232,232,228,0.4)]'
                    }`}
                  >
                    {label}
                  </button>
                  {openDays[key]?.open ? (
                    <div className="flex items-center gap-2 text-sm">
                      <input type="time" value={openDays[key].from}
                        onChange={e => setOpenDays(prev => ({ ...prev, [key]: { ...prev[key], from: e.target.value } }))}
                        className="border border-[rgba(201,162,39,0.14)] bg-[#141418] rounded-lg px-2 py-1.5 text-[rgba(232,232,228,0.75)] focus:outline-none focus:border-blue-400 text-sm"
                      />
                      <span className="text-[rgba(232,232,228,0.4)]">—</span>
                      <input type="time" value={openDays[key].to}
                        onChange={e => setOpenDays(prev => ({ ...prev, [key]: { ...prev[key], to: e.target.value } }))}
                        className="border border-[rgba(201,162,39,0.14)] bg-[#141418] rounded-lg px-2 py-1.5 text-[rgba(232,232,228,0.75)] focus:outline-none focus:border-blue-400 text-sm"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-[rgba(232,232,228,0.4)]">סגור</span>
                  )}
                </div>
              ))}
              <div className="flex justify-end mt-4">
                <Button onClick={saveHours} loading={hoursLoading}>
                  <Save className="w-4 h-4" /> שמור שינויים
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Platforms — commission rates for companies that work with the restaurant */}
      {activeTab === 'platforms' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bike className="w-5 h-5 text-blue-600" /> חברות שעובדות עם המסעדה
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-[rgba(232,232,228,0.6)]">
              הזן כאן את אחוז העמלה שכל חברה גובה ממך — כדי שהרווח הנקי בעמוד
              &quot;פיננסים&quot; יחושב גם <strong>אחרי</strong> ניכוי העמלות, לא רק לפני.
              זה חל גם על הזמנות משלוח וגם על תשלום בכרטיס של החברה בתוך המסעדה.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-1.5 text-[rgba(232,232,228,0.75)]">
                  עמלת וולט (%)
                </label>
                <div className="relative">
                  <Percent className="w-4 h-4 absolute top-1/2 -translate-y-1/2 left-3 text-[rgba(232,232,228,0.3)]" />
                  <input
                    type="number" min={0} max={100} step={0.1}
                    placeholder="למשל 15"
                    value={bizForm.wolt_commission_pct}
                    onChange={e => setBizForm(f => ({ ...f, wolt_commission_pct: e.target.value }))}
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm bg-[#141418] border border-[rgba(201,162,39,0.14)] text-[rgba(232,232,228,0.9)] focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5 text-[rgba(232,232,228,0.75)]">
                  עמלת תן ביס (%)
                </label>
                <div className="relative">
                  <Percent className="w-4 h-4 absolute top-1/2 -translate-y-1/2 left-3 text-[rgba(232,232,228,0.3)]" />
                  <input
                    type="number" min={0} max={100} step={0.1}
                    placeholder="למשל 12"
                    value={bizForm.ten_bis_commission_pct}
                    onChange={e => setBizForm(f => ({ ...f, ten_bis_commission_pct: e.target.value }))}
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm bg-[#141418] border border-[rgba(201,162,39,0.14)] text-[rgba(232,232,228,0.9)] focus:outline-none focus:border-blue-400"
                  />
                </div>
              </div>
            </div>

            <p className="text-xs text-[rgba(232,232,228,0.4)]">
              סיבוס ומשלוחה עדיין לא נתמכים כאן — הנתונים שלהם לא תמיד נתפסים
              במדויק בדוח ה-Z, ויתווספו בהמשך.
            </p>

            <div className="pt-3 border-t border-[rgba(201,162,39,0.14)]">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bizForm.z_report_includes_delivery_platforms}
                  onChange={e => setBizForm(f => ({ ...f, z_report_includes_delivery_platforms: e.target.checked }))}
                  className="mt-1 w-4 h-4 accent-blue-600 cursor-pointer flex-shrink-0"
                />
                <span className="text-sm text-[rgba(232,232,228,0.75)]">
                  <strong>הקופה שלי כוללת את סכומי וולט/תן ביס בתוך דוח ה-Z</strong>
                  <br />
                  <span className="text-xs text-[rgba(232,232,228,0.45)]">
                    סמן את זה אם הקופה שלך כבר מדווחת בעצמה כמה נכנס מכל חברה —
                    כך נמנע ספירה כפולה של אותה הכנסה. אם המשלוחים שלך מגיעים
                    בדוח נפרד ולא בתוך דוח ה-Z, השאר לא מסומן.
                  </span>
                </span>
              </label>
            </div>

            {platformsError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{platformsError}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={savePlatforms} loading={platformsLoading}>
                <Save className="w-4 h-4" /> שמור שינויים
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Profile */}
      {activeTab === 'profile' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-purple-600" /> פרופיל אישי
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-[#1a1a20] rounded-xl mb-2">
              <div className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center text-white text-xl font-bold">
                {user?.fullName?.charAt(0) || '?'}
              </div>
              <div>
                <p className="font-semibold text-[#e8e8e4]">{user?.fullName}</p>
                <p className="text-sm text-[rgba(232,232,228,0.45)]">{user?.role === 'owner' ? 'בעלים' : user?.role === 'manager' ? 'מנהל' : 'עובד'}</p>
              </div>
            </div>
            <Input label="שם מלא" value={profileForm.fullName}
              onChange={e => setProfileForm(f => ({ ...f, fullName: e.target.value }))} />
            <Input label="אימייל" type="email" value={profileForm.email}
              onChange={e => setProfileForm(f => ({ ...f, email: e.target.value }))} />
            {profileError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{profileError}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={saveProfile} loading={profileLoading}>
                <Save className="w-4 h-4" /> שמור
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Password */}
      {activeTab === 'password' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <EyeOff className="w-5 h-5 text-green-600" /> שינוי סיסמה
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Input label="סיסמה נוכחית" type={showPw ? 'text' : 'password'}
                value={pwForm.currentPassword}
                onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))} />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute left-3 top-8 text-[rgba(232,232,228,0.4)] hover:text-[rgba(232,232,228,0.75)]">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Input label="סיסמה חדשה" type="password" placeholder="לפחות 6 תווים"
              value={pwForm.newPassword}
              onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} />
            <Input label="אימות סיסמה חדשה" type="password"
              value={pwForm.confirm}
              onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))} />
            {pwError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{pwError}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={savePassword} loading={pwLoading}>
                <Save className="w-4 h-4" /> שנה סיסמה
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2FA — shown inside password tab */}
      {activeTab === 'password' && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-indigo-600" /> אימות דו-שלבי (2FA)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {twoFAStep === 'idle' && (
              <>
                <div className="flex items-center justify-between p-4 rounded-xl" style={{ background: twoFAEnabled ? 'rgba(34,197,94,0.08)' : '#1a1a20', border: `1px solid ${twoFAEnabled ? '#86efac' : 'rgba(201,162,39,0.16)'}` }}>
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${twoFAEnabled ? 'bg-green-900/40' : 'bg-[#0f0f14]'}`}>
                      <Shield className={`w-4 h-4 ${twoFAEnabled ? 'text-green-600' : 'text-gray-400'}`} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{twoFAEnabled ? 'מופעל' : 'כבוי'}</p>
                      <p className="text-xs text-[rgba(232,232,228,0.45)]">{twoFAEnabled ? 'הכניסה שלך מאובטחת עם קוד נוסף' : 'הוסף שכבת הגנה נוספת לחשבון'}</p>
                    </div>
                  </div>
                  {twoFAEnabled ? (
                    <Button variant="outline" onClick={() => setTwoFAStep('disable')} className="text-red-600 border-red-200 hover:bg-red-50">
                      כבה
                    </Button>
                  ) : (
                    <Button onClick={start2FASetup} loading={twoFALoading}>
                      <QrCode className="w-4 h-4" /> הפעל
                    </Button>
                  )}
                </div>
                {twoFAError && <p className="text-sm text-red-600">{twoFAError}</p>}
              </>
            )}

            {twoFAStep === 'setup' && (
              <div className="space-y-4">
                <p className="text-sm text-[rgba(232,232,228,0.6)]">סרוק את הקוד עם אפליקציית אימות (Google Authenticator / Authy):</p>
                {twoFAQr && <img src={twoFAQr} alt="QR Code" className="w-40 h-40 mx-auto rounded-xl border" />}
                <p className="text-xs text-[rgba(232,232,228,0.4)] text-center break-all">או הזן ידנית: <span className="font-mono font-bold text-[rgba(232,232,228,0.75)]">{twoFASecret}</span></p>
                <div>
                  <label className="block text-sm font-medium mb-1">הזן את הקוד מהאפליקציה לאימות</label>
                  <input
                    type="text" inputMode="numeric" maxLength={6} placeholder="123456"
                    value={twoFACode} onChange={e => setTwoFACode(e.target.value.replace(/\D/g,''))}
                    className="w-full rounded-xl px-4 py-2.5 text-center text-lg font-mono tracking-widest border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[#e8e8e4] outline-none focus:border-indigo-400"
                  />
                </div>
                {twoFAError && <p className="text-sm text-red-600">{twoFAError}</p>}
                <div className="flex gap-2">
                  <Button onClick={confirm2FAEnable} loading={twoFALoading} disabled={twoFACode.length < 6}>
                    <CheckCircle className="w-4 h-4" /> אמת והפעל
                  </Button>
                  <Button variant="outline" onClick={() => { setTwoFAStep('idle'); setTwoFACode(''); }}>ביטול</Button>
                </div>
              </div>
            )}

            {twoFAStep === 'disable' && (
              <div className="space-y-4">
                <p className="text-sm text-[rgba(232,232,228,0.6)]">כדי לכבות 2FA, הזן קוד מהאפליקציה שלך:</p>
                <input
                  type="text" inputMode="numeric" maxLength={6} placeholder="123456"
                  value={twoFACode} onChange={e => setTwoFACode(e.target.value.replace(/\D/g,''))}
                  className="w-full rounded-xl px-4 py-2.5 text-center text-lg font-mono tracking-widest border border-red-200 outline-none focus:border-red-400"
                />
                {twoFAError && <p className="text-sm text-red-600">{twoFAError}</p>}
                <div className="flex gap-2">
                  <Button onClick={confirm2FADisable} loading={twoFALoading} disabled={twoFACode.length < 6} className="bg-red-600 hover:bg-red-700">
                    כבה 2FA
                  </Button>
                  <Button variant="outline" onClick={() => { setTwoFAStep('idle'); setTwoFACode(''); }}>ביטול</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Permissions */}
      {activeTab === 'permissions' && (
        <div className="space-y-4">

          {/* Legend — all features per permission */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="w-4 h-4" style={{ color: '#c9a227' }} />
                רשימת הפיצ&apos;רים לפי הרשאה
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="grid sm:grid-cols-2 gap-0 divide-y divide-[rgba(201,162,39,0.08)] sm:divide-y-0">
                {PERM_LABELS.map(({ label, color, icon: Icon, features }) => (
                  <div key={label}
                    className="flex gap-3 px-5 py-3.5 border-b border-[rgba(201,162,39,0.08)] last:border-b-0"
                  >
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: color + '18' }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold mb-1" style={{ color }}>{label}</p>
                      <div className="flex flex-wrap gap-1">
                        {features.map(f => (
                          <span key={f} className="text-xs px-2 py-0.5 rounded-full"
                            style={{ background: color + '12', color: color + 'cc' }}>
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Per-user permission toggles */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-orange-500" /> הרשאות לפי עובד
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {bizUsers.filter(u => u.role !== 'owner').length === 0 ? (
                <div className="px-6 py-8 text-center space-y-3">
                  <Shield className="w-10 h-10 text-gray-200 mx-auto" />
                  <p className="text-sm font-medium text-[rgba(232,232,228,0.45)]">אין עובדים במערכת עדיין</p>
                  <p className="text-xs text-[rgba(232,232,228,0.4)] max-w-xs mx-auto leading-relaxed">
                    כדי לנהל הרשאות — קודם הוסף עובדים מלשונית <strong>עובדים</strong>. לאחר ההוספה הם יופיעו כאן אוטומטית.
                  </p>
                  <Link href="/employees"
                    className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors"
                    style={{ background: '#2563eb' }}>
                    <Users className="w-4 h-4" /> עבור ללשונית עובדים
                  </Link>
                </div>
              ) : (
                <div className="divide-y divide-[rgba(201,162,39,0.08)]">
                  {bizUsers.filter(u => u.role !== 'owner').map(u => (
                    <div key={u.id} className="px-6 py-4">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-blue-100 text-blue-700">
                          {getInitials(u.full_name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[#e8e8e4]">{u.full_name}</p>
                          <p className="text-xs text-[rgba(232,232,228,0.4)] truncate">{u.email}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge variant={u.role === 'manager' ? 'info' : 'default'}>
                            {u.role === 'manager' ? 'מנהל' : 'עובד'}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {PERM_LABELS.map(({ key, label, color, icon: Icon }) => {
                          const active  = !!u[key];
                          const loading = permSaving === u.id + key;
                          const saved   = permSaved  === u.id + key;
                          return (
                            <button
                              key={key}
                              onClick={() => togglePerm(u.id, key, active)}
                              disabled={loading}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${loading ? 'opacity-50' : ''}`}
                              style={saved ? {
                                background: 'rgba(34,197,94,0.15)',
                                color: '#22c55e',
                                border: '1px solid rgba(34,197,94,0.4)',
                              } : active ? {
                                background: color + '20',
                                color,
                                border: `1px solid ${color}50`,
                              } : {
                                background: '#141418',
                                color: 'rgba(232,232,228,0.35)',
                                border: '1px solid rgba(201,162,39,0.12)',
                              }}
                            >
                              {saved
                                ? <><CheckCircle2 className="w-3 h-3" /> נשמר ✓</>
                                : loading
                                ? <><Loader2 className="w-3 h-3 animate-spin" /> {label}</>
                                : <><Icon className="w-3 h-3" /> {label}</>
                              }
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Privacy & Data */}
      {activeTab === 'privacy' && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="w-5 h-5" style={{ color: '#c9a227' }} /> מדיניות ותנאי שימוש
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 pt-0">
              <a
                href={`${WEBSITE_URL}/privacy`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium text-[#e8e8e4] hover:bg-[#1a1a20] transition-colors border border-[rgba(201,162,39,0.12)]"
              >
                מדיניות פרטיות
                <ExternalLink className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />
              </a>
              <a
                href={`${WEBSITE_URL}/terms`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium text-[#e8e8e4] hover:bg-[#1a1a20] transition-colors border border-[rgba(201,162,39,0.12)]"
              >
                תנאי שימוש
                <ExternalLink className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Download className="w-5 h-5 text-blue-500" /> ייצוא הנתונים שלי
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <p className="text-sm text-[rgba(232,232,228,0.55)] leading-relaxed">
                הורדת כל הנתונים של העסק (עובדים, משמרות, מלאי, חשבוניות, דוחות כספיים) לקובץ Excel אחד.
              </p>
              <Button onClick={handleExportAllData} disabled={exportingAll} className="flex items-center gap-2">
                {exportingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                ייצוא כל הנתונים
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-500">
                <Trash2 className="w-5 h-5" /> מחיקת חשבון
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <p className="text-sm text-[rgba(232,232,228,0.55)] leading-relaxed">
                בקשה זו תישלח לצוות התמיכה לטיפול. חלק מהמסמכים (כגון חשבוניות) עשויים להישמר לתקופה הנדרשת בחוק לצרכי מס, גם לאחר מחיקת החשבון.
              </p>
              {deletionRequested ? (
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-500">
                  <CheckCircle2 className="w-4 h-4" /> הבקשה נשלחה — ניצור איתך קשר בקרוב
                </div>
              ) : (
                <button
                  onClick={handleRequestDeletion}
                  disabled={deletionSending}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50"
                  style={{ background: '#dc2626' }}
                >
                  {deletionSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  בקשת מחיקת חשבון
                </button>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-xs text-center text-[rgba(232,232,228,0.4)]">House of Business v1.0.0</p>
    </div>
  );
}
