'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  HelpCircle, Package, Truck, Users, DollarSign,
  Monitor, ArrowLeft, Circle, CheckCircle2, ChevronDown, ChevronUp,
  FlaskConical, FileBarChart2 } from 'lucide-react';

// ── זהה ל-SETUP_SECTIONS ב-settings/page.tsx ──────────────────────────────
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
      'אם אין באפשרותך לחבר קופה ישירות — שלב 1 (העלאת דוחות) מכסה את הכל',
    ],
    tip: 'לאחר החיבור, הקופה מסונכרנת כל 15 דקות אוטומטית — אין צורך לעשות כלום.',
    href: '/pos',
    linkLabel: 'פתח קופה',
  },
] as const;

const LS_KEY = 'hob_setup_done';

export default function QuickstartPage() {
  const router = useRouter();
  const [launching, setLaunching] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });

  const toggle = (id: string) => setOpenId(p => p === id ? null : id);
  const toggleDone = (id: string) => setDone(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch {}
    return next;
  });

  const progress = Math.round((done.size / SETUP_SECTIONS.length) * 100);

  const handleLaunch = () => {
    setLaunching(true);
    setTimeout(() => router.push('/dashboard'), 3000);
  };

  return (
    <div className="max-w-2xl" dir="rtl">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--hero-gradient)', }}>
          <HelpCircle className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#e8e8e4]">מדריך הגדרות ראשוניות</h1>
          <p className="text-xs text-[rgba(232,232,228,0.45)]">7 שלבים להפעלת הפלטפורמה במלואה</p>
        </div>
      </div>

      {/* Progress */}
      <div className="mb-5 p-4 rounded-2xl" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[rgba(232,232,228,0.6)]">התקדמות ההגדרה</span>
          <span className="text-xs text-[rgba(232,232,228,0.4)]">{done.size} / {SETUP_SECTIONS.length} שלבים הושלמו</span>
        </div>
        <div className="h-2 bg-[#1a1a20] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progress}%`, background: 'var(--color-primary, #1a5c2a)' }}
          />
        </div>
        {done.size === SETUP_SECTIONS.length && (
          <p className="text-xs text-green-500 font-semibold mt-2 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> כל ההגדרות הושלמו — הפלטפורמה פועלת במלואה!
          </p>
        )}
      </div>

      {/* Steps accordion */}
      <div className="space-y-2">
        {SETUP_SECTIONS.map((sec) => {
          const Icon = sec.icon;
          const isOpen = openId === sec.id;
          const isDone = done.has(sec.id);

          return (
            <div
              key={sec.id}
              className="rounded-2xl overflow-hidden transition-all"
              style={{
                border: `1px solid ${isDone ? 'rgba(34,197,94,0.35)' : isOpen ? sec.color + '40' : 'rgba(255,255,255,0.07)'}`,
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
                    <span className="text-sm font-bold text-[rgba(232,232,228,0.85)]">{sec.title}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded-full font-semibold"
                      style={{ background: sec.colorBg, color: sec.color }}
                    >
                      {sec.badge}
                    </span>
                    {isDone && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold bg-green-900/40 text-green-400">
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
                <div className="px-4 pb-4 space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
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
                        background: isDone ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.05)',
                        color: isDone ? '#4ade80' : 'rgba(232,232,228,0.45)',
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

      {/* Go to dashboard button */}
      <button
        onClick={handleLaunch}
        disabled={launching}
        className="w-full mt-6 py-4 rounded-2xl font-bold text-base transition-all duration-300 hover:scale-[1.01] active:scale-[0.98]"
        style={{
          background: 'linear-gradient(135deg, #b8911f 0%, #e8c84a 45%, #b8911f 100%)',
          color: '#050508',
          boxShadow: '0 4px 32px rgba(201,162,39,0.3), 0 1px 0 rgba(255,255,255,0.15) inset',
          letterSpacing: '0.01em',
        }}
      >
        <span className="flex items-center justify-center gap-2">
          <ArrowLeft className="w-5 h-5" />
          עבור לדשבורד
        </span>
      </button>

      {/* Footer */}
      <p className="text-xs text-center text-[rgba(232,232,228,0.3)] mt-4">
        ניתן לחזור לדף זה בכל עת דרך כפתור &ldquo;הגדרות ראשוניות&rdquo; בדף ההגדרות
      </p>

      {/* Luxury launch overlay */}
      {launching && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, direction: 'rtl',
          background: 'radial-gradient(ellipse at 50% 35%, #0d200a 0%, #06060a 65%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2.5rem',
        }}>
          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes launchScale { from { opacity: 0; transform: scale(0.88) translateY(12px) } to { opacity: 1; transform: scale(1) translateY(0) } }
            @keyframes goldGlow { 0%,100% { text-shadow: 0 0 24px rgba(201,162,39,0.35) } 50% { text-shadow: 0 0 56px rgba(201,162,39,0.75), 0 0 90px rgba(201,162,39,0.2) } }
            @keyframes fillProgress { from { width: 0% } to { width: 100% } }
            @keyframes orbitStar { 0% { opacity: 0; transform: scale(0) rotate(0deg) } 30% { opacity: 1 } 70% { opacity: 1 } 100% { opacity: 0; transform: scale(1.4) rotate(200deg) } }
            @keyframes subtlePulse { 0%,100% { opacity: 0.35 } 50% { opacity: 0.6 } }
          ` }} />

          {/* Scattered sparkles */}
          {[
            { top: '12%', left: '8%',  delay: '0s',    dur: '2.4s', size: 5 },
            { top: '18%', left: '82%', delay: '0.4s',  dur: '2.1s', size: 4 },
            { top: '72%', left: '14%', delay: '0.8s',  dur: '2.7s', size: 6 },
            { top: '78%', left: '78%', delay: '0.2s',  dur: '2.2s', size: 4 },
            { top: '35%', left: '92%', delay: '1.1s',  dur: '2.5s', size: 3 },
            { top: '62%', left: '4%',  delay: '0.6s',  dur: '2.0s', size: 5 },
            { top: '88%', left: '45%', delay: '0.9s',  dur: '2.3s', size: 3 },
            { top: '8%',  left: '55%', delay: '1.3s',  dur: '2.6s', size: 4 },
          ].map((p, i) => (
            <div key={i} style={{
              position: 'absolute', top: p.top, left: p.left,
              width: p.size, height: p.size, borderRadius: '50%',
              background: '#c9a227',
              boxShadow: '0 0 10px rgba(201,162,39,0.9)',
              animation: `orbitStar ${p.dur} ${p.delay} ease-in-out infinite`,
            }} />
          ))}

          {/* Main card */}
          <div style={{
            animation: 'launchScale 0.75s cubic-bezier(0.34,1.4,0.64,1) forwards',
            textAlign: 'center', padding: '0 2rem',
          }}>
            <div style={{
              fontSize: '3.5rem', lineHeight: 1, marginBottom: '1.5rem',
              animation: 'goldGlow 2s ease infinite',
            }}>
              ✦
            </div>
            <h1 style={{
              fontSize: '2rem', fontWeight: 700, color: '#c9a227',
              animation: 'goldGlow 2s ease infinite',
              marginBottom: '0.75rem', letterSpacing: '-0.01em',
            }}>
              עכשיו כל הקסם קורה
            </h1>
            <p style={{
              color: 'rgba(232,232,228,0.38)', fontSize: '0.8125rem',
              letterSpacing: '0.12em', textTransform: 'uppercase',
              animation: 'subtlePulse 1.8s ease infinite',
            }}>
              מכין את הדשבורד שלך
            </p>
          </div>

          {/* Progress bar */}
          <div style={{ width: '220px', display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
            <div style={{
              width: '100%', height: '2px',
              background: 'rgba(201,162,39,0.12)', borderRadius: '9999px', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, #9a7218, #c9a227, #f0d060, #c9a227)',
                borderRadius: '9999px',
                animation: 'fillProgress 3s cubic-bezier(0.4,0,0.2,1) forwards',
                boxShadow: '0 0 10px rgba(201,162,39,0.7)',
              }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
