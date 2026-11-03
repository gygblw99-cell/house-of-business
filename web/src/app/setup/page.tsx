'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api/client';
import {
  Monitor, Package, BookOpen, Truck, Users, DollarSign, ShoppingBag,
  Check, ChevronDown, ChevronUp, ExternalLink, Sparkles, ArrowRight,
  Zap, Star, Circle, Loader, AlertTriangle,
} from 'lucide-react';

const GOLD    = '#c9a227';
const GOLD_10 = 'rgba(201,162,39,0.10)';
const GOLD_18 = 'rgba(201,162,39,0.18)';
const GOLD_25 = 'rgba(201,162,39,0.25)';
const GOLD_35 = 'rgba(201,162,39,0.35)';
const GOLD_50 = 'rgba(201,162,39,0.50)';
const TEXT    = 'rgba(232,232,228,0.90)';
const TEXT_DIM= 'rgba(232,232,228,0.40)';
const CARD_BG = 'rgba(255,255,255,0.025)';
const CARD_BD = 'rgba(255,255,255,0.07)';

type Priority = 'critical' | 'high' | 'medium';

interface Step {
  title: string;
  description: string;
}

interface ConnectionItem {
  id: string;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  priority: Priority;
  why: string;
  unlocks: string[];
  steps: Step[];
  ctaLabel: string;
  ctaHref: string;
}

const CONNECTIONS: ConnectionItem[] = [
  {
    id: 'pos',
    icon: Monitor,
    title: 'קופה ודוחות',
    subtitle: 'הבסיס של כל הפלטפורמה',
    priority: 'critical',
    why: 'הדוחות מהקופה הם מקור האמת של העסק שלך — כמה מכרת, מה מכרת, ומתי. ללא זה, הדשבורד, התחזיות, ו-AI insights לא יוכלו לעבוד.',
    unlocks: ['דשבורד מכירות יומי/שבועי/חודשי', 'תחזית מכירות חכמה', 'הנדסת תפריט וניתוח רווחיות', 'תובנות AI על מגמות ועונתיות', 'ניתוח שעות שיא ויעילות'],
    steps: [
      { title: 'העלה היסטוריה', description: 'לך לדף דוחות ← העלה קובץ (XLSX/CSV). מינימום 3 חודשים, אופטימלי שנה+.' },
      { title: 'חבר Gmail (אוטומטי)', description: 'בדף דוחות לחץ "התחבר עם Gmail" — הפלטפורמה תזהה ותמשוך דוחות חדשים אוטומטית כל 8 שעות.' },
      { title: 'חיבור API ישיר', description: 'אם אתה עובד עם Bikoum, Aviv, Priority, RSD, Iron POS — ניתן לחבר API לסנכרון מלא.' },
    ],
    ctaLabel: 'חבר קופה ודוחות',
    ctaHref: '/zreport',
  },
  {
    id: 'inventory',
    icon: Package,
    title: 'מלאי וחומרי גלם',
    subtitle: 'הבסיס לחישוב עלויות מדויק',
    priority: 'high',
    why: 'בלי עלויות חומרי גלם, הפלטפורמה לא יכולה לחשב מרג\'ין, לזהות דליפות רווח, או להמליץ על איזה מנות הכי כדאי לקדם.',
    unlocks: ['חישוב עלות מנה מדויק', 'מרג\'ין ורווחיות לכל מוצר', 'זיהוי דליפות מלאי', 'התראות כשהמלאי נמוך', 'הזמנות אוטומטיות לספקים'],
    steps: [
      { title: 'הוסף חומרי גלם', description: 'לך לדף מלאי ← הוסף ← הזן שם, יחידת מידה ועלות ליחידה.' },
      { title: 'הגדר כמות ראשונית', description: 'הכנס את הכמות הנוכחית שיש לך — זה נותן את נקודת ההתחלה לניהול המלאי.' },
      { title: 'חבר למתכונים', description: 'לאחר שהוספת מתכונים (שלב הבא), חבר כל מרכיב מתכון לחומר הגלם המתאים.' },
    ],
    ctaLabel: 'נהל מלאי',
    ctaHref: '/inventory',
  },
  {
    id: 'recipes',
    icon: BookOpen,
    title: 'מתכונים ומנות',
    subtitle: 'מחשב עלות מנה בצורה מדויקת',
    priority: 'high',
    why: 'מתכון = הרכב חומרי גלם + כמויות. ברגע שיש מתכון, הפלטפורמה מחשבת אוטומטית כמה עולה לך לייצר כל מנה ומה הרווח שלך.',
    unlocks: ['עלות ייצור לכל מנה', 'הנדסת תפריט מתקדמת (Stars/Plowhorses/Dogs)', 'המלצות AI לשינוי מחירים', 'ניתוח רווחיות לפי קטגוריה', 'השוואת מנות מול מחיר מכירה'],
    steps: [
      { title: 'הוסף מנות', description: 'לך לדף מתכונים ← הוסף מנה ← הכנס שם ומחיר מכירה.' },
      { title: 'הרכב מרכיבים', description: 'לכל מנה, הוסף את חומרי הגלם שלה (מהמלאי) עם הכמויות המדויקות.' },
      { title: 'צפה בהנדסת תפריט', description: 'לאחר חיבור עם דוחות — עבור לדף הנדסת תפריט לראות ניתוח Stars/Plowhorses.' },
    ],
    ctaLabel: 'נהל מתכונים',
    ctaHref: '/recipes',
  },
  {
    id: 'suppliers',
    icon: ShoppingBag,
    title: 'ספקים',
    subtitle: 'מעקב הזמנות ועלויות רכש',
    priority: 'medium',
    why: 'ספקים מחוברים = מעקב אוטומטי על הוצאות רכש, היסטוריית הזמנות, ויכולת לשלוח הזמנות ישירות דרך הפלטפורמה.',
    unlocks: ['שליחת הזמנות ב-WhatsApp/מייל', 'היסטוריית רכישות', 'ניתוח הוצאות רכש', 'השוואת מחירי ספקים', 'התראות על שינויי מחיר'],
    steps: [
      { title: 'הוסף ספקים', description: 'לך לדף ספקים ← הוסף ספק ← הכנס שם, טלפון ושיטת הזמנה מועדפת.' },
      { title: 'חבר לחומרי גלם', description: 'לכל חומר גלם במלאי, הגדר מאיזה ספק הוא מגיע ומה המחיר.' },
      { title: 'שלח הזמנות', description: 'כשהמלאי נמוך, הפלטפורמה תציע לך לשלוח הזמנה ישירות לספק.' },
    ],
    ctaLabel: 'נהל ספקים',
    ctaHref: '/suppliers',
  },
  {
    id: 'employees',
    icon: Users,
    title: 'עובדים ומשמרות',
    subtitle: 'ניהול כוח אדם וחישוב שכר',
    priority: 'medium',
    why: 'שכר הוא אחת ההוצאות הגדולות ביותר בעסק. מעקב על משמרות מאפשר לך לחשב עלות עבודה מדויקת ולראות יחס עלות/הכנסה.',
    unlocks: ['חישוב שכר חודשי אוטומטי', 'מעקב נוכחות ושעות', 'יחס עלות עבודה/מכירות', 'ניהול משמרות', 'מעקב ימי היעדרות'],
    steps: [
      { title: 'הוסף עובדים', description: 'לך לדף עובדים ← הוסף עובד ← הכנס שם, תפקיד ושכר.' },
      { title: 'הגדר סוג שכר', description: 'שכר שעתי (מחושב לפי שעות) או גלובלי (סכום קבוע בחודש).' },
      { title: 'נהל משמרות', description: 'תזמן משמרות, עקוב אחר נוכחות ואשר שעות בסוף החודש.' },
    ],
    ctaLabel: 'נהל עובדים',
    ctaHref: '/employees',
  },
  {
    id: 'expenses',
    icon: DollarSign,
    title: 'הוצאות קבועות',
    subtitle: 'רווח נקי מדויק בסוף החודש',
    priority: 'medium',
    why: 'בלי הוצאות קבועות, הפלטפורמה לא יכולה לחשב את הרווח הנקי האמיתי שלך. שכר דירה, חשמל, ביטוחים — הכל משפיע.',
    unlocks: ['חישוב רווח נקי חודשי מדויק', 'ניתוח נקודת איזון', 'מעקב על שינויי הוצאות', 'תחזית רווחיות', 'דוח P&L חודשי'],
    steps: [
      { title: 'הוסף הוצאות', description: 'לך לדף הוצאות ← הוסף הוצאה ← שם, סכום ותדירות (חודשי/שבועי/שנתי).' },
      { title: 'קטגוריות נפוצות', description: 'שכר דירה, חשמל, גז, מים, ביטוח, שיווק, תוכנות, רואה חשבון, אחזקה.' },
      { title: 'עדכן בשינויים', description: 'עדכן הוצאות כשהן משתנות — הפלטפורמה תחשב מחדש את הרווחיות.' },
    ],
    ctaLabel: 'נהל הוצאות',
    ctaHref: '/finance',
  },
  {
    id: 'deliveries',
    icon: Truck,
    title: 'משלוחים',
    subtitle: 'ניתוח פלטפורמות וסנכרון הזמנות',
    priority: 'medium',
    why: 'אם אתה עובד עם Wolt, Ten Bis, Mishloha — חיבור המייל מאפשר לקבל את כל ההזמנות ולנתח רווחיות לפי פלטפורמה.',
    unlocks: ['היסטוריית הזמנות משלוחים', 'ניתוח עמלות לפי פלטפורמה', 'השוואת רווחיות בין פלטפורמות', 'מעקב תאריכי אספקה', 'סיכום הכנסות נטו מכל ערוץ'],
    steps: [
      { title: 'ייבא היסטוריה', description: 'לך לדף משלוחים ← לחץ "יבא מייל" ← בחר כמה ימים אחורה לייבא.' },
      { title: 'חבר Gmail', description: 'לחץ "התחבר עם Gmail" (אותו חיבור ששימש לדוחות, אם כבר חובר) — הפלטפורמה תזהה ותמשוך הזמנות משלוחים חדשות אוטומטית כל 8 שעות.' },
      { title: 'נתח ביצועים', description: 'אחרי ייבוא, ראה את הניתוח לפי פלטפורמה, ימים ושעות שיא.' },
    ],
    ctaLabel: 'חבר משלוחים',
    ctaHref: '/deliveries',
  },
];

const PRIORITY_CONFIG: Record<Priority, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  critical: { label: 'קריטי', color: '#f87171', bg: 'rgba(248,113,113,0.12)', icon: Zap },
  high:     { label: 'גבוה',  color: GOLD,      bg: GOLD_10,                   icon: Star },
  medium:   { label: 'בינוני', color: TEXT_DIM, bg: 'rgba(255,255,255,0.04)', icon: Circle },
};

export default function SetupPage() {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bizKey, setBizKey]     = useState<string>('setup-done');
  const [done, setDone]         = useState<Set<string>>(new Set());
  const [justDone, setJustDone] = useState<string | null>(null);

  // Load progress keyed by businessId so each account starts fresh
  React.useEffect(() => {
    api.get('/business/me').then(({ data }) => {
      const key = `setup-done-${data.id || data.businessId || 'default'}`;
      setBizKey(key);
      try { setDone(new Set(JSON.parse(localStorage.getItem(key) || '[]'))); } catch {}
    }).catch(() => {
      try { setDone(new Set(JSON.parse(localStorage.getItem('setup-done') || '[]'))); } catch {}
    });
  }, []);

  // "סיימתי — סנכרן הכל"
  const [syncing, setSyncing]   = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; steps: { step: string; ok: boolean; error?: string }[] } | null>(null);

  const STEP_LABELS: Record<string, string> = { pos: 'קופה', cache: 'נתונים מעודכנים', ai_context: 'הקשר AI' };

  async function finishAndSyncAll() {
    setSyncing(true); setSyncResult(null);
    try {
      const { data } = await api.post('/business/finish-setup');
      setSyncResult(data);
      // רק כשכל שלבי הסנכרון הצליחו באמת אנחנו עוברים לדשבורד — אחרת
      // המשתמש נשאר בעמוד ורואה בדיוק מה נכשל, במקום מעבר "עיוור"
      if (data.success) {
        setTimeout(() => router.push('/dashboard'), 900);
      }
    } catch {
      setSyncResult({ success: false, steps: [{ step: 'sync', ok: false, error: 'שגיאה כללית בסנכרון' }] });
    } finally {
      setSyncing(false);
    }
  }

  function toggle(id: string) {
    setExpanded(prev => prev === id ? null : id);
  }

  function markDone(id: string) {
    setDone(prev => {
      const n = new Set(prev);
      n.add(id);
      try { localStorage.setItem(bizKey, JSON.stringify([...n])); } catch {}
      return n;
    });
    setJustDone(id);
    setTimeout(() => setJustDone(null), 2000);
  }

  function markUndone(id: string) {
    setDone(prev => {
      const n = new Set(prev);
      n.delete(id);
      try { localStorage.setItem(bizKey, JSON.stringify([...n])); } catch {}
      return n;
    });
  }

  const completedCount = done.size;
  const criticalDone   = done.has('pos');

  return (
    <div
      dir="rtl"
      style={{
        height: '100vh',
        overflowY: 'auto',
        background: 'linear-gradient(160deg, #06060a 0%, #050507 60%, #07060c 100%)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* ── Header ── */}
      <header style={{
        padding: '18px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid rgba(201,162,39,0.08)`,
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(6,6,10,0.95)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(201,162,39,0.2), rgba(201,162,39,0.06))',
            border: `1px solid ${GOLD_25}`,
          }}>
            <Sparkles style={{ width: 15, height: 15, color: GOLD }} />
          </div>
          <span style={{ fontWeight: 900, fontSize: 13, color: TEXT }}>House of Business</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: TEXT_DIM }}>
            {completedCount}/{CONNECTIONS.length} הושלמו
          </span>
          {completedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setDone(new Set());
                try { localStorage.removeItem(bizKey); } catch {}
              }}
              style={{
                fontSize: 11, color: 'rgba(232,232,228,0.25)', cursor: 'pointer',
                background: 'none', border: 'none', padding: '2px 6px',
                borderRadius: 6, transition: 'color 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget.style.color = 'rgba(232,232,228,0.6)'); }}
              onMouseLeave={e => { (e.currentTarget.style.color = 'rgba(232,232,228,0.25)'); }}
            >
              אפס הכל
            </button>
          )}

          <button
            onClick={() => router.push('/dashboard')}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 18px', borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(201,162,39,0.22), rgba(201,162,39,0.10))',
              border: `1px solid ${GOLD_35}`,
              color: GOLD, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            כנס לדשבורד
            <ArrowRight style={{ width: 13, height: 13 }} />
          </button>
        </div>
      </header>

      {/* ── Progress bar ── */}
      <div style={{ height: 2, background: 'rgba(255,255,255,0.05)' }}>
        <div style={{
          height: '100%', transition: 'width 0.5s ease',
          width: `${(completedCount / CONNECTIONS.length) * 100}%`,
          background: `linear-gradient(90deg, ${GOLD_50}, ${GOLD})`,
        }} />
      </div>

      {/* ── Main content ── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 16px 80px' }}>
        <div style={{ width: '100%', maxWidth: 680 }}>

          {/* Hero */}
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 16px', borderRadius: 20, marginBottom: 20,
              background: GOLD_10, border: `1px solid ${GOLD_18}`,
            }}>
              <Sparkles style={{ width: 12, height: 12, color: GOLD }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: GOLD_50, letterSpacing: '0.08em' }}>מדריך הגדרות</span>
            </div>
            <h1 style={{ fontSize: 32, fontWeight: 900, color: TEXT, marginBottom: 12, lineHeight: 1.2 }}>
              חבר את הפלטפורמה<br />
              <span style={{ color: GOLD }}>לכלים שלך</span>
            </h1>
            <p style={{ fontSize: 15, color: TEXT_DIM, maxWidth: 460, margin: '0 auto', lineHeight: 1.7 }}>
              כל חיבור שתבצע פותח יכולות נוספות ב-AI ובתובנות.<br />
              מומלץ להתחיל מהחיבורים הקריטיים ולהמשיך בסדר.
            </p>

            {!criticalDone && (
              <div style={{
                marginTop: 20, padding: '12px 20px', borderRadius: 14, maxWidth: 400, margin: '20px auto 0',
                background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
                fontSize: 13, color: 'rgba(248,113,113,0.8)', lineHeight: 1.6,
              }}>
                ⚡ התחל מחיבור קופה ודוחות — ללא זה רוב הפיצ׳רים לא יוכלו לפעול
              </div>
            )}
          </div>

          {/* Connection cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {CONNECTIONS.map((conn, idx) => {
              const isExpanded = expanded === conn.id;
              const isDone     = done.has(conn.id);
              const pCfg       = PRIORITY_CONFIG[conn.priority];
              const PIcon      = pCfg.icon;
              const ConnIcon   = conn.icon;

              return (
                <div
                  key={conn.id}
                  style={{
                    borderRadius: 18,
                    background: isDone ? 'rgba(74,222,128,0.04)' : CARD_BG,
                    border: `1px solid ${isDone ? 'rgba(74,222,128,0.25)' : isExpanded ? GOLD_25 : CARD_BD}`,
                    overflow: 'hidden',
                    transition: 'border-color 0.2s',
                  }}
                >
                  {/* Card header (always visible) */}
                  <button
                    type="button"
                    onClick={() => toggle(conn.id)}
                    style={{
                      width: '100%', padding: '16px 20px',
                      display: 'flex', alignItems: 'center', gap: 14,
                      background: 'none', border: 'none', cursor: 'pointer', textAlign: 'right',
                    }}
                  >
                    {/* Step number / done check */}
                    <div style={{
                      width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isDone ? 'rgba(74,222,128,0.15)' : 'rgba(201,162,39,0.1)',
                      border: `1px solid ${isDone ? 'rgba(74,222,128,0.35)' : GOLD_18}`,
                    }}>
                      {isDone
                        ? <Check style={{ width: 14, height: 14, color: '#4ade80' }} />
                        : <ConnIcon style={{ width: 14, height: 14, color: GOLD_50 }} />}
                    </div>

                    {/* Text */}
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: isDone ? 'rgba(74,222,128,0.9)' : TEXT }}>
                          {idx + 1}. {conn.title}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                          background: pCfg.bg, color: pCfg.color,
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          <PIcon style={{ width: 9, height: 9 }} />
                          {pCfg.label}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: TEXT_DIM }}>{conn.subtitle}</span>
                    </div>

                    {/* Chevron */}
                    <div style={{ color: TEXT_DIM, flexShrink: 0 }}>
                      {isExpanded
                        ? <ChevronUp style={{ width: 16, height: 16 }} />
                        : <ChevronDown style={{ width: 16, height: 16 }} />}
                    </div>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
                      <div style={{ height: 1, background: CARD_BD }} />

                      {/* Why */}
                      <div style={{
                        padding: '12px 16px', borderRadius: 12,
                        background: 'rgba(201,162,39,0.06)', border: `1px solid ${GOLD_18}`,
                      }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: GOLD_50, marginBottom: 6, letterSpacing: '0.06em' }}>
                          למה זה חשוב?
                        </p>
                        <p style={{ fontSize: 13, color: TEXT, lineHeight: 1.7 }}>{conn.why}</p>
                      </div>

                      {/* What it unlocks */}
                      <div>
                        <p style={{ fontSize: 11, fontWeight: 700, color: TEXT_DIM, marginBottom: 10, letterSpacing: '0.06em' }}>
                          מה נפתח לאחר החיבור
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {conn.unlocks.map((u, i) => (
                            <span key={i} style={{
                              fontSize: 12, padding: '5px 12px', borderRadius: 8,
                              background: GOLD_10, border: `1px solid ${GOLD_18}`,
                              color: GOLD_50,
                            }}>
                              ✓ {u}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Steps */}
                      <div>
                        <p style={{ fontSize: 11, fontWeight: 700, color: TEXT_DIM, marginBottom: 12, letterSpacing: '0.06em' }}>
                          איך לבצע — שלב אחרי שלב
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {conn.steps.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                              <div style={{
                                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: GOLD_10, border: `1px solid ${GOLD_25}`,
                                fontSize: 10, fontWeight: 800, color: GOLD,
                              }}>
                                {i + 1}
                              </div>
                              <div style={{ flex: 1 }}>
                                <p style={{ fontSize: 13, fontWeight: 700, color: TEXT, marginBottom: 2 }}>{s.title}</p>
                                <p style={{ fontSize: 12, color: TEXT_DIM, lineHeight: 1.6 }}>{s.description}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* CTA */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <a
                          href={conn.ctaHref}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 8,
                            padding: '10px 22px', borderRadius: 12, textDecoration: 'none',
                            background: 'linear-gradient(135deg, rgba(201,162,39,0.22), rgba(201,162,39,0.10))',
                            border: `1px solid ${GOLD_35}`,
                            color: GOLD, fontSize: 13, fontWeight: 700,
                          }}
                        >
                          <ExternalLink style={{ width: 13, height: 13 }} />
                          {conn.ctaLabel}
                        </a>

                        {!isDone && (
                          <button
                            type="button"
                            onClick={() => markDone(conn.id)}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: '10px 18px', borderRadius: 12, cursor: 'pointer',
                              background: 'rgba(74,222,128,0.08)',
                              border: '1px solid rgba(74,222,128,0.2)',
                              color: 'rgba(74,222,128,0.7)', fontSize: 13, fontWeight: 700,
                              transition: 'all 0.15s',
                            }}
                            onMouseEnter={e => { (e.currentTarget.style.background = 'rgba(74,222,128,0.18)'); (e.currentTarget.style.color = '#4ade80'); }}
                            onMouseLeave={e => { (e.currentTarget.style.background = 'rgba(74,222,128,0.08)'); (e.currentTarget.style.color = 'rgba(74,222,128,0.7)'); }}
                          >
                            <Check style={{ width: 13, height: 13 }} />
                            סיימתי שלב זה ✓
                          </button>
                        )}
                        {isDone && justDone === conn.id && (
                          <span style={{
                            fontSize: 13, fontWeight: 700, color: '#4ade80',
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '10px 18px', borderRadius: 12,
                            background: 'rgba(74,222,128,0.18)',
                            border: '1px solid rgba(74,222,128,0.4)',
                            animation: 'fadeIn 0.3s ease',
                          }}>
                            <Check style={{ width: 15, height: 15 }} />
                            ✓ הושלם בהצלחה!
                          </span>
                        )}
                        {isDone && justDone !== conn.id && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, color: 'rgba(74,222,128,0.6)', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Check style={{ width: 12, height: 12 }} />
                              הושלם
                            </span>
                            <button
                              type="button"
                              onClick={() => markUndone(conn.id)}
                              style={{
                                fontSize: 11, color: 'rgba(232,232,228,0.3)', cursor: 'pointer',
                                background: 'none', border: 'none', padding: '2px 6px',
                                borderRadius: 6, transition: 'color 0.15s',
                              }}
                              onMouseEnter={e => { (e.currentTarget.style.color = 'rgba(232,232,228,0.7)'); }}
                              onMouseLeave={e => { (e.currentTarget.style.color = 'rgba(232,232,228,0.3)'); }}
                              title="בטל סימון"
                            >
                              בטל
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Bottom CTA */}
          <div style={{
            marginTop: 40, padding: '24px 28px', borderRadius: 20,
            background: CARD_BG, border: `1px solid ${CARD_BD}`,
            textAlign: 'center',
          }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: TEXT, marginBottom: 6 }}>
              {completedCount >= 3 ? '🎉 כל הכבוד! הפלטפורמה מוכנה לעבוד.' : 'מוכן לצלול פנימה?'}
            </p>
            <p style={{ fontSize: 13, color: TEXT_DIM, marginBottom: 20, lineHeight: 1.6 }}>
              {completedCount >= 3
                ? 'ניתן לחזור לדף זה בכל עת להוסיף חיבורים נוספים.'
                : 'ניתן תמיד לחזור לדף זה ולהשלים את ההגדרות בקצב שלך.'}
            </p>
            <button
              onClick={finishAndSyncAll}
              disabled={syncing}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 10,
                padding: '12px 32px', borderRadius: 14,
                background: syncing ? GOLD_10 : 'linear-gradient(135deg, rgba(201,162,39,0.28), rgba(201,162,39,0.12))',
                border: `1px solid ${syncing ? GOLD_18 : GOLD_35}`,
                color: syncing ? GOLD_35 : GOLD, fontSize: 15, fontWeight: 800,
                cursor: syncing ? 'not-allowed' : 'pointer',
                boxShadow: syncing ? 'none' : `0 0 30px rgba(201,162,39,0.1)`,
              }}
            >
              {syncing
                ? <><Loader style={{ width: 16, height: 16, animation: 'spin 0.8s linear infinite' }} /> מסנכרן...</>
                : <><Sparkles style={{ width: 16, height: 16 }} /> סיימתי — סנכרן הכל <ArrowRight style={{ width: 16, height: 16 }} /></>}
            </button>

            {/* Sync result — success confirmation or honest per-step failure detail */}
            {syncResult && (
              <div style={{ marginTop: 16, textAlign: 'right' }}>
                {syncResult.success ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
                    padding: '10px 16px', borderRadius: 12,
                    background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)',
                    color: '#4ade80', fontSize: 13, fontWeight: 600,
                  }}>
                    <Check style={{ width: 15, height: 15 }} />
                    הסנכרון הושלם בהצלחה — עובר לדשבורד...
                  </div>
                ) : (
                  <div style={{
                    padding: '14px 18px', borderRadius: 12,
                    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f87171', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                      <AlertTriangle style={{ width: 15, height: 15 }} />
                      חלק מהסנכרון נכשל — אפשר לנסות שוב
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {syncResult.steps.filter(s => !s.ok).map(s => (
                        <p key={s.step} style={{ fontSize: 12, color: 'rgba(248,113,113,0.7)' }}>
                          • {STEP_LABELS[s.step] || s.step}{s.error ? `: ${s.error}` : ''}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </main>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        button:focus { outline: none; }
        a:focus { outline: none; }
      `}</style>
    </div>
  );
}
