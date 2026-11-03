'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Brain, BarChart3, Megaphone, Package, Users,
  Monitor, Truck, FileText, ChefHat, TrendingUp, Bot,
  Zap, Star, CheckCircle, Sparkles, Lock,
  Globe, PieChart, Cpu, ShieldCheck, RotateCcw,
  CalendarDays, MessageSquare, Wallet, Receipt, Scale,
  UtensilsCrossed, AlarmClock, BrainCircuit, Bike,
  TrendingDown, Activity, AlertTriangle, Layers, Shield,
  Phone, X, User, Building2, ChevronDown, XCircle,
  ShoppingBag,
} from 'lucide-react';

const APP = process.env.NEXT_PUBLIC_PLATFORM_URL || 'http://localhost:3002';

// ── Design tokens ──────────────────────────────────────────────────────────
// Dark, black-ground theme (House of Business's original identity) — modular
// section layout in the spirit of aviv-pos.co.il, but back on the black/gold
// palette rather than the light variant, so the marketing site matches the
// dark-luxury look of the actual product.
const C = {
  bg:          '#050507',
  bgAlt:       '#0d0d14',
  ink:         '#F2F0EA',
  text:        '#A7ABB6',
  textDim:     '#6b7280',
  gold:        '#c9a227',
  goldLight:   '#D4AF37',
  goldDark:    '#e3c15c', // bright gold used for readable accent text on dark surfaces
  goldGrad:    'linear-gradient(135deg, #8F7015, #c9a227, #D4AF37)',
  goldSoft:    'rgba(201,162,39,0.1)',
  goldBorder:  'rgba(201,162,39,0.25)',
  goldBorderH: 'rgba(201,162,39,0.5)',
  border:      'rgba(255,255,255,0.09)',
  cardBg:      '#141418',
  onDarkText:  '#EDEAE2',
};

const CSS = `
  @keyframes fadeUp   { from { opacity:0; transform:translateY(28px) } to { opacity:1; transform:translateY(0) } }
  @keyframes float    { 0%,100% { transform:translateY(0) } 50% { transform:translateY(-10px) } }
  @keyframes shimmer  { from { background-position:200% center } to { background-position:-200% center } }
  @keyframes pulse-dot{ 0%,100% { transform:scale(1);opacity:1 } 50% { transform:scale(1.4);opacity:.6 } }
  @keyframes goldGlow { 0%,100% { box-shadow:0 0 0 rgba(184,148,31,0) } 50% { box-shadow:0 0 32px rgba(184,148,31,0.18) } }
  @keyframes spin { to { transform: rotate(360deg) } }
  @keyframes shine { 0% { transform: translateX(-130%) rotate(8deg) } 100% { transform: translateX(230%) rotate(8deg) } }
  @keyframes clusterPop {
    0%   { opacity: 0; transform: translateY(90px) scale(.8); filter: drop-shadow(0 0 0 rgba(201,162,39,0)); }
    55%  { opacity: 1; transform: translateY(-16px) scale(1.05); filter: drop-shadow(0 20px 40px rgba(201,162,39,0.22)); }
    75%  { transform: translateY(6px) scale(.99); }
    90%  { transform: translateY(-2px) scale(1.005); }
    100% { transform: translateY(0) scale(1); filter: drop-shadow(0 20px 40px rgba(201,162,39,0.14)); }
  }
  .fade-up  { animation: fadeUp .7s ease both }
  .float    { animation: float 4s ease-in-out infinite }
  .cluster-pop { animation: clusterPop .8s cubic-bezier(.22,1,.36,1) .7s both, float 2.6s ease-in-out infinite 1.5s; }
  @media (prefers-reduced-motion: reduce) {
    .cluster-pop { animation: none; }
  }
  .reveal { opacity: 0; transform: translateY(32px); transition: opacity .7s cubic-bezier(.2,.7,.2,1), transform .7s cubic-bezier(.2,.7,.2,1); }
  .reveal-visible { opacity: 1; transform: translateY(0); }
  @media (prefers-reduced-motion: reduce) {
    .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
  }
  .shine-sweep {
    position: absolute; top: -20%; bottom: -20%; width: 40%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.22), transparent);
    animation: shine 4.5s ease-in-out infinite;
    pointer-events: none;
  }
  .shimmer-text {
    background: linear-gradient(90deg, #8F7015 0%, #D4AF37 30%, #B8941F 50%, #8F7015 70%, #D4AF37 100%);
    background-size: 200% auto;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: shimmer 4s linear infinite;
  }
  .card-hover { transition: transform .25s ease, box-shadow .25s ease, border-color .25s ease }
  .card-hover:hover { transform: translateY(-6px); box-shadow: 0 24px 48px rgba(0,0,0,.4), 0 0 0 1px rgba(201,162,39,0.3) !important; border-color: rgba(201,162,39,0.35) !important }
  .btn-gold {
    background: linear-gradient(135deg,#8F7015,#B8941F,#D4AF37);
    color: #1C1B1F;
    font-weight: 700;
    transition: all .2s;
    box-shadow: 0 6px 22px rgba(184,148,31,.28);
  }
  .btn-gold:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(184,148,31,.4) }
  .nav-link { transition: color .15s }
  .nav-link:hover { color: #B8941F !important }
  .gold-glow { animation: goldGlow 3s ease-in-out infinite }
  @media (max-width: 1024px) {
    .steps-grid        { grid-template-columns: repeat(2,1fr) !important }
    .feature-grid      { grid-template-columns: repeat(2,1fr) !important }
  }
  @media (min-width: 769px) and (max-width: 1024px) {
    .device-cluster-scaler { zoom: 0.7 }
  }
  @media (max-width: 768px) {
    .hide-mobile  { display: none !important }
    .feature-grid { grid-template-columns: 1fr !important }
    .module-grid  { grid-template-columns: repeat(2,1fr) !important }
    .steps-grid   { grid-template-columns: 1fr !important }
    .why-grid     { grid-template-columns: 1fr !important }
  }
`;

// Scroll-triggered reveal, matching the fade/rise-in effect used across the
// reference site (aviv-pos.co.il) as the user scrolls — an IntersectionObserver
// flips the element visible once and stays (no re-hide on scroll-up, so it
// doesn't feel jittery on a long page).
function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold: 0.15, rootMargin: '0px 0px -60px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal${visible ? ' reveal-visible' : ''}`} style={{ transitionDelay: `${delay}ms`, height: '100%' }}>
      {children}
    </div>
  );
}

const STATIC_STATS = [
  { value: '24+',   label: 'מודולי ניהול', icon: Layers   },
  { value: '6',     label: 'סוכני AI',     icon: Brain    },
  { value: '99.9%', label: 'זמינות',       icon: Activity },
  { value: '24/7',  label: 'ניטור חכם',   icon: Shield   },
];

const AI_AGENTS = [
  {
    icon: Brain, color: '#7c5cd6', border: 'rgba(124,92,214,0.22)',
    tag: 'RAG Intelligence', title: 'Business Intelligence',
    desc: 'יועץ עסקי AI שניגש לכל נתוני העסק בזמן אמת, מנתח מגמות, מזהה הזדמנויות ומייצר המלצות ברמת CFO.',
    bullets: ['ניתוח P&L אוטומטי', 'זיהוי דליפות רווח', 'חיזוי הכנסות'],
  },
  {
    icon: ChefHat, color: '#d9711f', border: 'rgba(217,113,31,0.22)',
    tag: 'Menu Intelligence', title: 'Menu Engineering AI',
    desc: 'מנתח כל מנה לפי מכירות, רווחיות ועלות חומרי גלם — מזהה כוכבים ומנות שמחכות לקידום.',
    bullets: ['דירוג מנות לפי רווח נקי', 'המלצות תמחור חכמות', 'זיהוי מנות שכדאי להוריד'],
  },
  {
    icon: Megaphone, color: '#c23a7a', border: 'rgba(194,58,122,0.22)',
    tag: 'Growth Engine', title: 'Marketing AI',
    desc: 'מנוע שיווק ויראלי שמנתח את העסק ויוצר פוסטים, תסריטי וידאו, מבצעים חכמים וקמפיינים שבועיים.',
    bullets: ['פוסטים לכל הפלטפורמות', 'תסריטי TikTok/Reels', 'ROI אוטומטי'],
  },
];

const MODULES = [
  { icon: BarChart3, label: 'דשבורד חכם' }, { icon: Monitor, label: 'קופה POS' },
  { icon: Package, label: 'ניהול מלאי' },   { icon: Users, label: 'עובדים ומשמרות' },
  { icon: Truck, label: 'ספקים' },           { icon: FileText, label: 'חשבוניות OCR' },
  { icon: ChefHat, label: 'מנות ומתכונים' }, { icon: UtensilsCrossed, label: 'הנדסת תפריט' },
  { icon: Wallet, label: 'שכר ותלושים' },   { icon: Bike, label: 'משלוחים' },
  { icon: TrendingUp, label: 'פיננסים' },    { icon: Receipt, label: 'דוח מע"מ' },
  { icon: Scale, label: 'השוואת מחירים' },  { icon: RotateCcw, label: 'הזמנה חכמה' },
  { icon: BrainCircuit, label: 'משמרות AI' }, { icon: Star, label: 'ניתוח ביקורות' },
  { icon: Sparkles, label: 'חיזוי ביקוש' }, { icon: TrendingDown, label: 'דליפות רווח' },
  { icon: PieChart, label: 'P&L ערוצים' },   { icon: CalendarDays, label: 'לוח שנה' },
  { icon: MessageSquare, label: 'הודעות' },   { icon: AlarmClock, label: 'תזכורות' },
  { icon: Globe, label: 'דוחות לרו"ח' },      { icon: Cpu, label: 'Orchestrator AI' },
];

const STEPS = [
  { n: '01', icon: Lock,          title: 'פגישת אפיון לעסק',  desc: 'פותחים חשבון ומחברים את מקורות הנתונים — ממשק פשוט, ללא טכנאי.' },
  { n: '02', icon: Zap,           title: 'הנתונים מתחברים',  desc: 'מכירות, מלאי, עובדים וספקים — הכל מסתנכרן אוטומטית. המערכת לומדת את העסק שלכם.' },
  { n: '03', icon: Brain,         title: 'ה-AI עובד בשבילכם', desc: 'סוכני AI מנתחים, מנבאים ומייצרים המלצות עסקיות אסטרטגיות בזמן אמת — 24/7.' },
  { n: '04', icon: MessageSquare, title: 'ליווי מתמיד',      desc: 'הדרכה לכל הצוות על המערכת ופתיחת ערוץ תקשורת אישית.' },
];

const WHY_US = [
  { without: 'אקסלים נפרדים לכל דבר — מלאי, שכר, הזמנות', withUs: 'הכל מסונכרן במקום אחד, בזמן אמת' },
  { without: 'דליפות רווח מתגלות בסוף החודש, אם בכלל',   withUs: 'AI מזהה חריגות ודליפות תוך כדי תנועה' },
  { without: 'שיווק? כשיש זמן — כלומר כמעט אף פעם',       withUs: 'סוכן שיווק AI מייצר תוכן וקמפיינים לבד' },
  { without: 'דוחות לרואה חשבון גוזלים שעות בסוף החודש',  withUs: 'ייצוא מוכן בלחיצה אחת, כל חודש' },
];

const BUSINESS_TYPES = ['מסעדה','בית קפה','בר','קמעונאי','פיצרייה','מאפייה','אוכל מהיר','אחר'];
const CTA_BUSINESS_TYPES = ['בתי קפה','ברים','קמעונאי','פסט פוד','מסעדה','אחר'];

// Bright, vivid duotone tile per industry (a lively counterpoint to the
// otherwise dark page — the same idea aviv-pos.co.il uses on its own
// industry cards) with an animated diagonal shine sweeping across on a
// loop for a bit of life at rest, not just on hover.
const INDUSTRIES = [
  { label: 'מסעדות',       from: '#FF9142', to: '#D9540E' },
  { label: 'בתי קפה',       from: '#C98A52', to: '#7A4A24' },
  { label: 'ברים',          from: '#B65CE8', to: '#6B21A8' },
  { label: 'קמעונאי',       from: '#42A8F0', to: '#155F9E' },
  { label: 'פסט פוד',       from: '#FF6448', to: '#C81E1E' },
  { label: 'קונדיטוריות',   from: '#F268B4', to: '#A81E6C' },
];

// Illustrated per-industry "scene" drawn in CSS/SVG (no stock photography or
// external image hosts are available in this environment) — white line art,
// standing in for a bright tinted photo of that business.
function IndustryScene({ label }: { label: string }) {
  const s = { position: 'absolute' as const, inset: 0, width: '100%', height: '100%' };
  const g = '#fff';
  switch (label) {
    case 'מסעדות':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <circle cx="60" cy="70" r="34" fill="rgba(255,255,255,0.1)" />
          <circle cx="60" cy="70" r="34" fill="none" stroke={g} strokeOpacity="0.4" strokeWidth="1.5" />
          <circle cx="60" cy="70" r="21" fill="none" stroke={g} strokeOpacity="0.28" strokeWidth="1" />
          <g stroke={g} strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round">
            <line x1="30" y1="18" x2="30" y2="46" />
            <line x1="25" y1="18" x2="25" y2="36" />
            <line x1="35" y1="18" x2="35" y2="36" />
            <path d="M88 18 C 88 28 81 30 81 38 L 81 58" fill="none" />
          </g>
        </svg>
      );
    case 'בתי קפה':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <path d="M35 55 h50 v24 a25 25 0 0 1-25 25 25 25 0 0 1-25-25 Z" fill="rgba(255,255,255,0.1)" stroke={g} strokeOpacity="0.4" strokeWidth="1.5" />
          <path d="M85 60 h8 a10 10 0 0 1 0 20 h-6" fill="none" stroke={g} strokeOpacity="0.42" strokeWidth="2.4" />
          <g stroke={g} strokeOpacity="0.48" strokeWidth="1.8" strokeLinecap="round" fill="none">
            <path d="M45 40 c4-6-4-8 0-14" />
            <path d="M60 40 c4-6-4-8 0-14" />
            <path d="M75 40 c4-6-4-8 0-14" />
          </g>
        </svg>
      );
    case 'ברים':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <line x1="16" y1="96" x2="104" y2="96" stroke={g} strokeOpacity="0.32" strokeWidth="1.5" />
          <path d="M40 20 h10 v10 l6 8 v46 h-22 v-46 l6-8 Z" fill="rgba(255,255,255,0.1)" stroke={g} strokeOpacity="0.42" strokeWidth="1.5" />
          <path d="M70 40 h14 v8 l-5 5 v20 h-4 v-20 l-5-5 Z" fill="rgba(255,255,255,0.08)" stroke={g} strokeOpacity="0.36" strokeWidth="1.4" />
          <path d="M88 30 l14 14 -14 14 -14-14 Z" fill="rgba(255,255,255,0.08)" stroke={g} strokeOpacity="0.32" strokeWidth="1.3" />
          <line x1="88" y1="58" x2="88" y2="70" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'קמעונאי':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <rect x="12" y="22" width="96" height="2" fill={g} opacity="0.3" />
          <rect x="12" y="56" width="96" height="2" fill={g} opacity="0.3" />
          <rect x="12" y="90" width="96" height="2" fill={g} opacity="0.3" />
          <g stroke={g} strokeOpacity="0.32" strokeWidth="1.1">
            <rect x="18" y="8"  width="9" height="14" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="31" y="4"  width="9" height="18" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="44" y="10" width="9" height="12" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="57" y="6"  width="9" height="16" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="70" y="9"  width="9" height="13" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="83" y="5"  width="9" height="17" rx="2" fill="rgba(255,255,255,0.08)" />
            <rect x="96" y="11" width="9" height="11" rx="2" fill="rgba(255,255,255,0.08)" />
          </g>
          <g stroke={g} strokeOpacity="0.32" strokeWidth="1.3">
            <rect x="18" y="38" width="22" height="16" rx="3" fill="rgba(255,255,255,0.09)" />
            <rect x="44" y="36" width="18" height="18" rx="3" fill="rgba(255,255,255,0.08)" />
            <rect x="66" y="38" width="20" height="16" rx="3" fill="rgba(255,255,255,0.09)" />
            <rect x="90" y="37" width="16" height="17" rx="3" fill="rgba(255,255,255,0.08)" />
          </g>
        </svg>
      );
    case 'פסט פוד':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <path d="M28 58 a32 20 0 0 1 64 0 Z" fill="rgba(255,255,255,0.09)" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" />
          <rect x="26" y="58" width="68" height="7" fill={g} opacity="0.24" />
          <path d="M26 65 q34 10 68 0 l-4 8 q-30 8-60 0 Z" fill="rgba(255,255,255,0.08)" stroke={g} strokeOpacity="0.32" strokeWidth="1.3" />
          <rect x="28" y="73" width="64" height="9" rx="4.5" fill={g} opacity="0.2" />
          <path d="M30 82 h60 l-5 12 a6 6 0 0 1-6 5 H41 a6 6 0 0 1-6-5 Z" fill="rgba(255,255,255,0.08)" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" />
        </svg>
      );
    case 'קונדיטוריות':
      return (
        <svg viewBox="0 0 120 120" style={s} preserveAspectRatio="xMidYMid slice">
          <rect x="34" y="72" width="52" height="18" rx="3" fill="rgba(255,255,255,0.09)" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" />
          <rect x="41" y="56" width="38" height="16" rx="3" fill="rgba(255,255,255,0.09)" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" />
          <rect x="48" y="40" width="24" height="16" rx="3" fill="rgba(255,255,255,0.1)" stroke={g} strokeOpacity="0.36" strokeWidth="1.5" />
          <circle cx="60" cy="34" r="4.5" fill={g} opacity="0.4" />
        </svg>
      );
    default:
      return null;
  }
}

function LeadModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', business: '', type: '' });
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const valid = form.name.trim().length > 1 && form.phone.trim().length >= 9;

  // Escape closes the modal, and the page behind it stops scrolling while it's
  // open. The page-level Escape handler only ever closed the shortcuts panel,
  // so this dialog could only be dismissed by mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const submit = async () => {
    if (!valid) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, createdAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error('request failed');
      setSent(true);
    } catch {
      setError(true);
    }
    setLoading(false);
  };

  const inp: React.CSSProperties = {
    width: '100%', padding: '13px 16px', borderRadius: 12, boxSizing: 'border-box',
    background: C.bgAlt, border: `1px solid ${C.border}`,
    color: C.ink, fontSize: 15, fontWeight: 500, outline: 'none', transition: 'border-color .2s',
    fontFamily: 'inherit',
  };

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(20,15,10,0.45)', backdropFilter: 'blur(8px)' }}
    >
      <div role="dialog" aria-modal="true" aria-label="השארת פרטים"
        style={{ width: '100%', maxWidth: 460, background: C.cardBg, borderRadius: 24, border: `1px solid ${C.border}`, boxShadow: '0 40px 100px rgba(0,0,0,0.5)', overflow: 'hidden', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 0, insetInline: 0, height: 3, background: C.goldGrad }} />
        <button onClick={onClose} style={{ position: 'absolute', top: 18, left: 18, width: 32, height: 32, borderRadius: 8, background: C.bgAlt, border: `1px solid ${C.border}`, color: C.textDim, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <X style={{ width: 16, height: 16 }} />
        </button>

        {sent ? (
          <div style={{ padding: '56px 36px 44px', textAlign: 'center' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: C.goldSoft, border: `1px solid ${C.goldBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
              <CheckCircle style={{ width: 36, height: 36, color: C.gold }} />
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 800, color: C.ink, margin: '0 0 12px', letterSpacing: '.2px' }}>תודה!</h3>
            <p style={{ fontSize: 16, color: C.text, lineHeight: 1.7, margin: '0 0 28px' }}>
              קיבלנו את הפרטים שלך.<br />
              <strong style={{ color: C.goldDark }}>נציג שלנו יחזור אליך בהקדם.</strong>
            </p>
            <button onClick={onClose} className="btn-gold" style={{ padding: '12px 32px', borderRadius: 12, fontSize: 15, border: 'none', cursor: 'pointer' }}>
              סגור
            </button>
          </div>
        ) : (
          <div style={{ padding: '48px 36px 36px' }} dir="rtl">
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 14px', borderRadius: 999, background: C.goldSoft, border: `1px solid ${C.goldBorder}`, marginBottom: 14 }}>
                <Phone style={{ width: 13, height: 13, color: C.gold }} />
                <span style={{ fontSize: 11, color: C.goldDark, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>נציג יחזור אליך</span>
              </div>
              <h2 style={{ fontSize: 23, fontWeight: 900, color: C.ink, margin: '0 0 8px', letterSpacing: '-.5px' }}>השאר פרטים</h2>
              <p style={{ fontSize: 14, color: C.text, margin: 0, fontWeight: 500 }}>מלא פרטים ונציג שלנו יחזור אליך בהקדם</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 7 }}>שם מלא *</label>
                <div style={{ position: 'relative' }}>
                  <User style={{ position: 'absolute', top: '50%', right: 14, transform: 'translateY(-50%)', width: 16, height: 16, color: C.textDim, pointerEvents: 'none' }} />
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="ישראל ישראלי" style={{ ...inp, paddingRight: 42 }}
                    onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
                    onBlur={e => (e.currentTarget.style.borderColor = C.border)} />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 7 }}>טלפון *</label>
                <div style={{ position: 'relative' }}>
                  <Phone style={{ position: 'absolute', top: '50%', right: 14, transform: 'translateY(-50%)', width: 16, height: 16, color: C.textDim, pointerEvents: 'none' }} />
                  <input type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="050-0000000" style={{ ...inp, paddingRight: 42 }}
                    onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
                    onBlur={e => (e.currentTarget.style.borderColor = C.border)} />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 7 }}>שם העסק</label>
                <div style={{ position: 'relative' }}>
                  <Building2 style={{ position: 'absolute', top: '50%', right: 14, transform: 'translateY(-50%)', width: 16, height: 16, color: C.textDim, pointerEvents: 'none' }} />
                  <input value={form.business} onChange={e => setForm(f => ({ ...f, business: e.target.value }))}
                    placeholder="מסעדת הדגל שלך" style={{ ...inp, paddingRight: 42 }}
                    onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
                    onBlur={e => (e.currentTarget.style.borderColor = C.border)} />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 7 }}>סוג העסק</label>
                <div style={{ position: 'relative' }}>
                  <ChevronDown style={{ position: 'absolute', top: '50%', left: 14, transform: 'translateY(-50%)', width: 16, height: 16, color: C.textDim, pointerEvents: 'none' }} />
                  <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                    style={{ ...inp, paddingLeft: 40, appearance: 'none', cursor: 'pointer' }}
                    onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
                    onBlur={e => (e.currentTarget.style.borderColor = C.border)}>
                    <option value="">בחר סוג עסק...</option>
                    {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>

              <button onClick={submit} disabled={!valid || loading} className={valid ? 'btn-gold' : ''} style={{
                marginTop: 8, padding: '15px 0', borderRadius: 14, width: '100%',
                background: valid ? undefined : '#232329',
                color: valid ? undefined : C.textDim,
                fontWeight: 800, fontSize: 16, border: 'none', cursor: valid ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              }}>
                {loading
                  ? <div style={{ width: 18, height: 18, border: '2px solid #1C1B1F', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  : <><Phone style={{ width: 18, height: 18 }} /> קבל שיחה חזרה</>}
              </button>

              {error && (
                <p style={{ textAlign: 'center', fontSize: 13, color: '#e08a7d', margin: '10px 0 0', fontWeight: 600 }}>
                  משהו השתבש בשליחה — נסה שוב או התקשר אלינו ישירות.
                </p>
              )}

              <p style={{ textAlign: 'center', fontSize: 12, color: C.textDim, margin: '4px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                <Lock style={{ width: 11, height: 11 }} /> הפרטים שלך מאובטחים ולא יועברו לצד שלישי
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Inline signup form for the closing CTA — name + phone + submit, right on
// the page instead of behind the "leave details" button/modal.
function CtaLeadForm() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const valid = name.trim().length > 1 && phone.trim().length >= 9;

  const submit = async () => {
    if (!valid) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, type, createdAt: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error('request failed');
      setSent(true);
    } catch {
      setError(true);
    }
    setLoading(false);
  };

  const inp: React.CSSProperties = {
    flex: '1 1 200px', minWidth: 160, padding: '15px 18px', borderRadius: 12, boxSizing: 'border-box',
    background: C.bgAlt, border: `1px solid ${C.border}`,
    color: C.ink, fontSize: 15, fontWeight: 500, outline: 'none', transition: 'border-color .2s',
    fontFamily: 'inherit',
  };

  if (sent) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '18px 24px', borderRadius: 14, background: C.goldSoft, border: `1px solid ${C.goldBorderH}`, maxWidth: 520, margin: '0 auto 28px' }}>
        <CheckCircle style={{ width: 20, height: 20, color: C.gold, flexShrink: 0 }} />
        <span style={{ color: C.ink, fontWeight: 700, fontSize: 15 }}>קיבלנו את הפרטים — נציג שלנו יחזור אליך בהקדם.</span>
      </div>
    );
  }

  return (
    <form onSubmit={e => { e.preventDefault(); submit(); }} style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', maxWidth: 620, margin: '0 auto 28px' }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="שם מלא"
        style={inp}
        onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
        onBlur={e => (e.currentTarget.style.borderColor = C.border)} />
      <input value={phone} onChange={e => setPhone(e.target.value)} type="tel" placeholder="050-0000000"
        style={inp}
        onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
        onBlur={e => (e.currentTarget.style.borderColor = C.border)} />
      <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
        <ChevronDown style={{ position: 'absolute', top: '50%', left: 14, transform: 'translateY(-50%)', width: 16, height: 16, color: C.textDim, pointerEvents: 'none' }} />
        <select value={type} onChange={e => setType(e.target.value)}
          style={{ ...inp, width: '100%', paddingLeft: 40, appearance: 'none', cursor: 'pointer' }}
          onFocus={e => (e.currentTarget.style.borderColor = C.goldBorderH)}
          onBlur={e => (e.currentTarget.style.borderColor = C.border)}>
          <option value="">סוג העסק</option>
          {CTA_BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <button type="submit" disabled={loading} className="btn-gold" style={{
        flex: '1 1 220px', padding: '15px 24px', borderRadius: 12,
        fontWeight: 800, fontSize: 15, border: 'none', cursor: loading ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, whiteSpace: 'nowrap',
        opacity: !valid && !loading ? 0.85 : 1,
      }}>
        {loading
          ? <div style={{ width: 16, height: 16, border: '2px solid #1C1B1F', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          : <><Phone style={{ width: 16, height: 16 }} /> אני רוצה שנציג יחזור אליי</>}
      </button>
      {error && (
        <p style={{ width: '100%', textAlign: 'center', fontSize: 13, color: '#e08a7d', fontWeight: 600, margin: 0 }}>
          משהו השתבש בשליחה — נסה שוב או התקשר אלינו ישירות.
        </p>
      )}
    </form>
  );
}

// The three screens below all show the same live dashboard data — a single
// product, everywhere the business owner needs it, echoing how the
// reference site photographs its POS hardware alongside its mobile apps.
// Mirrors the real "חיזוי ביקוש" (demand forecast) page: a weather-gradient
// revenue hero above a 7-day predicted-revenue bar chart, colored per the
// app's own WEEK_COLORS palette.
function DesktopScreen() {
  const days = [
    { d: 'א', v: 40, c: '#6366f1' },
    { d: 'ב', v: 32, c: '#3b82f6' },
    { d: 'ג', v: 38, c: '#8b5cf6' },
    { d: 'ד', v: 34, c: '#06b6d4' },
    { d: 'ה', v: 50, c: '#f97316' },
    { d: 'ו', v: 66, c: '#10b981' },
    { d: 'ש', v: 60, c: '#10b981' },
  ];
  return (
    <div style={{ background: '#0a0a0e', width: '100%', height: '100%', fontSize: 11, userSelect: 'none', display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#050507', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid rgba(184,148,31,0.12)', flexShrink: 0 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b' }} />
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
      </div>
      <div style={{ flex: 1, padding: '12px 14px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: '#e8e8e4', marginBottom: 8 }}>חיזוי ביקוש</div>
        <div style={{ background: 'linear-gradient(120deg,#1565c0,#1e88e5,#29b6f6)', borderRadius: 10, padding: '10px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.75)' }}>מחזור צפוי היום</div>
            <div style={{ fontWeight: 800, fontSize: 16, color: '#fff' }}>₪6,140</div>
          </div>
          <div style={{ fontSize: 22 }}>☀️</div>
        </div>
        <div style={{ fontSize: 8.5, color: '#9aa0ab', marginBottom: 6, flexShrink: 0 }}>מחזור יומי צפוי — 7 ימים</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 6, minHeight: 0 }}>
          {days.map(x => (
            <div key={x.d} style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
              <div style={{ width: '100%', height: x.v, background: x.c, borderRadius: '4px 4px 0 0' }} />
              <span style={{ fontSize: 7.5, color: '#6b7280' }}>{x.d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The three device frames below are rendered at their natural size (no
// fixed-size wrapper boxes) and bottom-aligned by the flex row in
// DeviceCluster, with a single `gap` controlling the space between every
// pair — that's what keeps the two gaps visually identical.
function DesktopFrame() {
  return (
    // min(350px, 100%) — unlike PhoneFrame/TabletFrame (hidden on mobile via
    // .hide-mobile), this is the only mockup shown on narrow viewports, so a
    // fixed 350px width overflowed the ~327-342px available on a real phone
    // and got clipped at the page's overflow-x:hidden edge.
    <div style={{ width: 'min(350px, 100%)', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', padding: 13, borderRadius: 19, background: 'linear-gradient(155deg,#2a2a30,#141418)', boxShadow: '0 30px 64px rgba(28,27,31,0.22), 0 0 0 1px rgba(184,148,31,0.15)' }}>
        <div style={{ height: 248, borderRadius: 9, overflow: 'hidden' }}>
          <DesktopScreen />
        </div>
      </div>
      {/* monitor stand */}
      <div style={{ width: 73, height: 25, background: 'linear-gradient(180deg,#2a2a30,#141418)', clipPath: 'polygon(38% 0, 62% 0, 78% 100%, 22% 100%)' }} />
      <div style={{ width: 150, height: 9, borderRadius: 999, background: 'linear-gradient(180deg,#2a2a30,#18181c)' }} />
    </div>
  );
}

// Mirrors the real "מנות" (dishes) page: a dark hero header with live stat
// chips, over the actual light dish-card list (name, price pill, cost/
// profit/margin) exactly as that page renders it.
function TabletScreen() {
  const dishes = [
    { name: 'פילה בקר ברוטב פטריות', price: '₪128', cost: '₪42.50', profit: '₪85.50', margin: '66.8%' },
    { name: 'סלמון צלוי בטריאקי',    price: '₪98',  cost: '₪31.00', profit: '₪67.00', margin: '68.4%' },
  ];
  return (
    <div style={{ background: '#0a0a0e', width: '100%', height: '100%', fontSize: 10, userSelect: 'none', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: 'linear-gradient(135deg,#050507,#0a0a0e 60%,#141418)', padding: '10px 16px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: '#fff' }}>מנות</div>
        <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.55)' }}>חישוב עלות אוטומטי · תמחור מנות</div>
        <div style={{ display: 'flex', gap: 6, marginRight: 'auto' }}>
          <span style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '3px 8px', fontSize: 7.5, color: '#fff', fontWeight: 600 }}>18 מנות</span>
          <span style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '3px 8px', fontSize: 7.5, color: '#fff', fontWeight: 600 }}>מרג׳ין ממוצע 64%</span>
        </div>
      </div>
      <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, minHeight: 0 }}>
        {dishes.map(dish => (
          <div key={dish.name} style={{ background: '#141418', borderRadius: 10, padding: '10px 12px', border: '1px solid rgba(201,162,39,0.16)', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 10, color: '#e8e8e4' }}>{dish.name}</span>
              <span style={{ fontSize: 8.5, fontWeight: 800, color: '#4ade80', background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 999, padding: '1px 7px', flexShrink: 0 }}>{dish.price}</span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
              <div><span style={{ fontSize: 7.5, color: '#6b7280' }}>עלות </span><span style={{ fontSize: 8.5, fontWeight: 700, color: '#e8e8e4' }}>{dish.cost}</span></div>
              <div><span style={{ fontSize: 7.5, color: '#6b7280' }}>רווח </span><span style={{ fontSize: 8.5, fontWeight: 700, color: '#4ade80' }}>{dish.profit}</span></div>
              <div style={{ background: 'rgba(74,222,128,0.1)', borderRadius: 6, padding: '1px 6px', fontSize: 8.5, fontWeight: 800, color: '#4ade80' }}>{dish.margin}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabletFrame() {
  return (
    <div style={{ width: 420, padding: 15, borderRadius: 28, background: 'linear-gradient(155deg,#2a2a30,#141418)', boxShadow: '0 26px 54px rgba(28,27,31,0.24), 0 0 0 1px rgba(184,148,31,0.15)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#3a3a42', flexShrink: 0 }} />
      <div style={{ flex: 1, height: 220, borderRadius: 16, overflow: 'hidden' }}>
        <TabletScreen />
      </div>
    </div>
  );
}

// Mirrors the real main dashboard's own KPI tiles — same gradients
// (--kpi-gradient-1 charcoal, --kpi-gradient-2 gold) and AI insights card.
function PhoneScreen() {
  return (
    <div style={{ background: '#0a0a0e', width: '100%', height: '100%', padding: '18px 12px 12px', fontSize: 9, userSelect: 'none', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ fontWeight: 700, fontSize: 11.5, color: '#e8e8e4', marginBottom: 11 }}>דשבורד ראשי</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ background: 'linear-gradient(135deg,#141418,#1e1e26)', borderRadius: 10, padding: '9px 10px' }}>
          <ShoppingBag style={{ width: 12, height: 12, color: '#fff', opacity: 0.9, marginBottom: 4 }} />
          <div style={{ fontWeight: 800, fontSize: 13, color: '#fff' }}>₪4,820</div>
          <div style={{ fontSize: 7.5, color: 'rgba(255,255,255,0.75)', marginTop: 1 }}>הכנסה היום</div>
          <div style={{ fontSize: 7, color: 'rgba(255,255,255,0.45)' }}>32 מכירות</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg,#a07d10,#c9a227)', borderRadius: 10, padding: '9px 10px' }}>
          <TrendingUp style={{ width: 12, height: 12, color: '#1C1B1F', opacity: 0.85, marginBottom: 4 }} />
          <div style={{ fontWeight: 800, fontSize: 13, color: '#1C1B1F' }}>₪1,940</div>
          <div style={{ fontSize: 7.5, color: 'rgba(28,27,31,0.75)', marginTop: 1 }}>רווח נקי היום</div>
          <div style={{ fontSize: 7, color: 'rgba(28,27,31,0.55)' }}>40% מרווח</div>
        </div>
        <div style={{ background: 'rgba(201,162,39,0.1)', borderRadius: 9, padding: '7px 10px', border: '1px solid rgba(201,162,39,0.22)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
            <Brain style={{ width: 10, height: 10, color: '#D4AF37' }} />
            <span style={{ fontSize: 8, fontWeight: 700, color: '#D4AF37' }}>תובנות AI</span>
          </div>
          <div style={{ fontSize: 7.5, color: '#9aa0ab', lineHeight: 1.4 }}>
            עלות מזון עלתה 4% השבוע — כדאי לבדוק תמחור.
          </div>
        </div>
      </div>
    </div>
  );
}

function PhoneFrame() {
  return (
    <div style={{ width: 200, padding: 13, borderRadius: 41, background: 'linear-gradient(155deg,#2a2a30,#141418)', boxShadow: '0 22px 46px rgba(28,27,31,0.26), 0 0 0 1px rgba(184,148,31,0.18)', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 13, left: '50%', transform: 'translateX(-50%)', width: 63, height: 22, borderRadius: 999, background: '#141418', zIndex: 2 }} />
      <div style={{ width: '100%', height: 330, borderRadius: 30, overflow: 'hidden' }}>
        <PhoneScreen />
      </div>
    </div>
  );
}

function DeviceCluster() {
  return (
    <div className="device-cluster-scaler" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '1cm', paddingBottom: 30 }}>
      <div className="hide-mobile">
        <PhoneFrame />
      </div>
      <DesktopFrame />
      <div className="hide-mobile">
        <TabletFrame />
      </div>
    </div>
  );
}

function WebsiteShortcutsPanel({ onClose }: { onClose: () => void }) {
  const rows = [
    { display: 'J',   label: 'גלול מטה' },
    { display: 'K',   label: 'גלול מעלה' },
    { display: 'G',   label: 'חזרה לראש הדף' },
    { display: '?',   label: 'פאנל קיצורים זה' },
    { display: 'Esc', label: 'סגור פאנל' },
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(20,15,10,0.55)', backdropFilter: 'blur(4px)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 400, margin: '0 16px', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 70px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p style={{ color: C.ink, fontWeight: 700, fontSize: 15 }}>⌨️ קיצורי מקלדת</p>
          <button onClick={onClose} style={{ color: C.textDim, background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: '12px 20px 16px' }}>
          {rows.map(r => (
            <div key={r.display} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.text, fontSize: 14 }}>{r.label}</span>
              <kbd style={{ background: C.bgAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 10px', fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: C.ink, boxShadow: '0 2px 0 rgba(0,0,0,0.2)' }}>{r.display}</kbd>
            </div>
          ))}
          <p style={{ color: C.textDim, fontSize: 11, textAlign: 'center', marginTop: 12 }}>לחץ Esc לסגירה</p>
        </div>
      </div>
    </div>
  );
}

export interface LiveStats {
  sales_last_30d: number;
  ai_calls_last_30d: number;
}

export function LandingClient({ liveStats }: { liveStats?: LiveStats | null }) {
  const [scrolled, setScrolled] = useState(false);
  const [showLead, setShowLead] = useState(false);
  const [showKbd, setShowKbd] = useState(false);
  const F = 'var(--font-heebo), sans-serif';
  const FD = 'var(--font-rubik), var(--font-heebo), sans-serif';

  const displayStats = liveStats
    ? [
        { value: '24+',
          label: 'מודולי ניהול', icon: Layers },
        { value: '6',
          label: 'סוכני AI', icon: Brain },
        { value: liveStats.sales_last_30d > 1000
            ? `${Math.floor(liveStats.sales_last_30d / 1000)}K+`
            : `${liveStats.sales_last_30d}+`,
          label: 'מכירות החודש', icon: TrendingUp },
        { value: '24/7',
          label: 'ניטור חכם', icon: Shield },
      ]
    : STATIC_STATS;

  // Backup for the inline pre-paint script in layout.tsx — makes sure a
  // fresh visit always lands at the top of the page, not wherever the
  // browser's scroll restoration (or an incoming #hash) would otherwise put it.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  useEffect(() => {
    const SCROLL_STEP = 380;
    const isEditable = (el: EventTarget | null) => {
      const e = el as HTMLElement;
      return e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable);
    };
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      if (e.key === 'Escape')  { setShowKbd(false); return; }
      if (e.code === 'KeyJ')   { e.preventDefault(); window.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' }); }
      if (e.code === 'KeyK')   { e.preventDefault(); window.scrollBy({ top: -SCROLL_STEP, behavior: 'smooth' }); }
      if (e.code === 'KeyG')   { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (e.code === 'Slash' && e.shiftKey) { e.preventDefault(); setShowKbd(v => !v); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <>
      <style>{CSS}</style>
      {showLead && <LeadModal onClose={() => setShowLead(false)} />}
      {showKbd  && <WebsiteShortcutsPanel onClose={() => setShowKbd(false)} />}
      <div dir="rtl" style={{ fontFamily: F, color: C.text, background: C.bg, overflowX: 'hidden' }}>

        {/* ── NAVBAR ─────────────────────────────────────────── */}
        <nav style={{
          position: 'fixed', top: 0, insetInline: 0, zIndex: 100,
          transition: 'all .3s',
          background: scrolled ? 'rgba(5,5,7,0.85)' : 'transparent',
          backdropFilter: scrolled ? 'blur(20px)' : 'none',
          borderBottom: scrolled ? `1px solid ${C.border}` : '1px solid transparent',
          boxShadow: scrolled ? '0 4px 24px rgba(0,0,0,0.3)' : 'none',
        }}>
          <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px', height: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 15, color: C.ink, letterSpacing: '.3px', lineHeight: 1.1 }}>
                HOUSE OF <span style={{ color: C.gold }}>BUSINESS</span>
              </div>
              <div style={{ fontSize: 9, color: C.textDim, letterSpacing: '2px', textTransform: 'uppercase', marginTop: 2 }}>AI · FINANCE · GROWTH · FREEDOM</div>
            </div>
            <div className="hide-mobile" style={{ display: 'flex', gap: 32 }}>
              {[["פיצ'רים",'#features'],['AI Agents','#ai'],['אודות','#steps']].map(([l,h]) => (
                <a key={l} href={h} className="nav-link" style={{ fontSize: 14, fontWeight: 600, color: C.text, textDecoration: 'none', letterSpacing: '.2px' }}>{l}</a>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <a href={`${APP}/login`} className="hide-mobile" style={{ padding: '9px 20px', borderRadius: 9, fontSize: 14, fontWeight: 700, color: C.ink, textDecoration: 'none', border: `1px solid ${C.border}`, background: 'transparent', transition: 'all .2s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = C.goldBorderH; (e.currentTarget as HTMLElement).style.color = C.goldDark; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.color = C.ink; }}>
                כניסה
              </a>
              <button onClick={() => setShowLead(true)} className="btn-gold" style={{ padding: '9px 22px', borderRadius: 9, fontSize: 14, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Phone style={{ width: 14, height: 14 }} /> השאר פרטים
              </button>
            </div>
          </div>
        </nav>

        {/* ── HERO ────────────────────────────────────────────── */}
        <section style={{ minHeight: '100vh', background: `linear-gradient(180deg, ${C.bg} 0%, ${C.bg} 55%, ${C.bgAlt} 100%)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '110px 24px 80px', position: 'relative', overflowX: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)`, backgroundSize: '60px 60px', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: '2%', right: '5%', width: 700, height: 700, background: 'radial-gradient(circle,rgba(184,148,31,0.09),transparent 65%)', borderRadius: '50%', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: '5%', left: '5%', width: 500, height: 500, background: 'radial-gradient(circle,rgba(184,148,31,0.06),transparent 65%)', borderRadius: '50%', pointerEvents: 'none' }} />

          <div style={{ position: 'relative', textAlign: 'center', maxWidth: 880, width: '100%' }}>
            <div className="fade-up" style={{ animationDelay: '.1s', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 18px', borderRadius: 999, border: `1px solid ${C.goldBorderH}`, background: C.goldSoft, marginBottom: 32 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', animation: 'pulse-dot 2s infinite' }} />
              <span style={{ fontSize: 12, color: C.goldDark, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>AI Business Operating System — 2026</span>
            </div>

            <div className="fade-up" style={{ animationDelay: '.15s', marginBottom: 8 }}>
              <div style={{ fontFamily: FD, fontWeight: 900, fontSize: 15, letterSpacing: '4px', color: C.gold, textTransform: 'uppercase' }}>House of Business</div>
            </div>

            <h1 className="fade-up" style={{ fontFamily: FD, animationDelay: '.2s', fontSize: 'clamp(36px,6vw,72px)', fontWeight: 900, lineHeight: 1.08, margin: '18px 0 8px', letterSpacing: '-2px', color: C.ink }}>
              מערכת AI שתנהל
            </h1>
            <h1 className="fade-up shimmer-text" style={{ fontFamily: FD, animationDelay: '.25s', fontSize: 'clamp(36px,6vw,72px)', fontWeight: 900, lineHeight: 1.08, margin: '0 0 28px', letterSpacing: '-2px' }}>
              את העסק שלך
            </h1>

            <div className="fade-up" style={{ animationDelay: '.3s', marginBottom: 28 }}>
              <span style={{ fontSize: 11, color: C.textDim, letterSpacing: '3px', fontWeight: 700, textTransform: 'uppercase' }}>AI · FINANCE · GROWTH · FREEDOM</span>
            </div>

            <p className="fade-up" style={{ animationDelay: '.35s', fontSize: 'clamp(15px,1.8vw,18px)', color: C.text, lineHeight: 1.8, maxWidth: 600, margin: '0 auto 48px' }}>
              כל מה שהעסק צריך, במקום אחד.<br className="hide-mobile" />
              סוכני AI, ניתוח עסקי, שיווק אוטומטי ותובנות פיננסיות.
            </p>

            <div className="fade-up" style={{ animationDelay: '.5s', display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={() => setShowLead(true)} className="btn-gold" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '16px 36px', borderRadius: 12, fontSize: 16, border: 'none', cursor: 'pointer' }}>
                <Phone style={{ width: 18, height: 18 }} /> השאר פרטים
              </button>
              <a href={`${APP}/login`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '16px 32px', borderRadius: 12, fontSize: 15, fontWeight: 700, color: C.ink, textDecoration: 'none', border: `1px solid ${C.border}`, background: C.cardBg, transition: 'all .2s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = C.goldBorderH; (e.currentTarget as HTMLElement).style.color = C.goldDark; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.color = C.ink; }}>
                כניסה למערכת
              </a>
            </div>

            <p className="fade-up" style={{ animationDelay: '.6s', fontSize: 12, color: C.textDim, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 72 }}>
              <Lock style={{ width: 11, height: 11 }} /> ללא כרטיס אשראי · מאובטח · מבוסס ענן ישראלי
            </p>

            <div className="cluster-pop" style={{ maxWidth: 1120, margin: '0 auto' }}>
              <DeviceCluster />
            </div>
          </div>
        </section>

        {/* ── STATS ───────────────────────────────────────────── */}
        <section style={{ background: C.bgAlt, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: '48px 24px' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 24 }}>
            {displayStats.map((s, i) => {
              const Icon = s.icon;
              return (
                <Reveal key={s.label} delay={i * 60}>
                  <div style={{ height: '100%', boxSizing: 'border-box', textAlign: 'center', padding: '24px 16px', borderRadius: 16, background: C.cardBg, border: `1px solid ${C.border}`, position: 'relative', overflow: 'hidden', boxShadow: '0 2px 10px rgba(28,27,31,0.04)' }}>
                    <Icon style={{ width: 22, height: 22, color: C.gold, margin: '0 auto 12px', display: 'block' }} />
                    <div style={{ fontFamily: FD, fontSize: 38, fontWeight: 900, letterSpacing: '-1.5px', lineHeight: 1, marginBottom: 8, background: C.goldGrad, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{s.value}</div>
                    <div style={{ fontSize: 13, color: C.text, fontWeight: 600, letterSpacing: '.3px' }}>{s.label}</div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* ── AI AGENTS ───────────────────────────────────────── */}
        <section id="ai" style={{ padding: '100px 24px', background: C.bg }}>
          <div style={{ maxWidth: 1140, margin: '0 auto' }}>
            <Reveal>
              <div style={{ textAlign: 'center', marginBottom: 72 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 16px', borderRadius: 999, background: C.goldSoft, border: `1px solid ${C.goldBorderH}`, marginBottom: 20 }}>
                  <Brain style={{ width: 13, height: 13, color: C.gold }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: C.goldDark, textTransform: 'uppercase', letterSpacing: '1.5px' }}>AI Agents</span>
                </div>
                <h2 style={{ fontFamily: FD, fontSize: 'clamp(28px,4vw,50px)', fontWeight: 900, color: C.ink, margin: '0 0 16px', letterSpacing: '-1px' }}>
                  סוכני AI עובדים<br /><span className="shimmer-text">בשבילכם 24/7</span>
                </h2>
                <p style={{ fontSize: 17, color: C.text, maxWidth: 540, margin: '0 auto', lineHeight: 1.7 }}>כל סוכן מתמחה בתחום אחד — ביחד מרכיבים מנוע ניהול שלא נרדם.</p>
              </div>
            </Reveal>
            <div className="feature-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 24 }}>
              {AI_AGENTS.map((a, i) => {
                const Icon = a.icon;
                return (
                  <Reveal key={i} delay={i * 100}>
                    <div className="card-hover" style={{ height: '100%', boxSizing: 'border-box', padding: 32, borderRadius: 20, background: C.cardBg, border: `1px solid ${C.border}`, boxShadow: '0 4px 20px rgba(28,27,31,0.05)', position: 'relative', overflow: 'hidden' }}>
                      <div className="shine-sweep" style={{ animationDelay: `${i * 0.7}s` }} />
                      <div style={{ position: 'absolute', top: 0, insetInline: 0, height: 3, background: a.color, opacity: 0.7 }} />
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 999, background: `${a.color}12`, border: `1px solid ${a.border}`, marginBottom: 20 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: a.color }} />
                        <span style={{ fontSize: 11, fontWeight: 800, color: a.color, textTransform: 'uppercase', letterSpacing: '.5px' }}>{a.tag}</span>
                      </div>
                      <div style={{ width: 52, height: 52, borderRadius: 14, background: `${a.color}12`, border: `1px solid ${a.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                        <Icon style={{ width: 26, height: 26, color: a.color }} />
                      </div>
                      <h3 style={{ fontFamily: FD, fontSize: 19, fontWeight: 800, color: C.ink, margin: '0 0 12px', letterSpacing: '-.3px' }}>{a.title}</h3>
                      <p style={{ fontSize: 14, color: C.text, lineHeight: 1.75, margin: '0 0 20px' }}>{a.desc}</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {a.bullets.map(b => (
                          <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CheckCircle style={{ width: 14, height: 14, color: a.color, flexShrink: 0 }} />
                            <span style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{b}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── WHY US ──────────────────────────────────────────── */}
        <section style={{ padding: '96px 24px', background: C.bgAlt }}>
          <div style={{ maxWidth: 980, margin: '0 auto' }}>
            <Reveal>
              <div style={{ textAlign: 'center', marginBottom: 56 }}>
                <h2 style={{ fontFamily: FD, fontSize: 'clamp(26px,4vw,46px)', fontWeight: 900, color: C.ink, margin: '0 0 14px', letterSpacing: '-1px' }}>
                  למה <span className="shimmer-text">House of Business</span>
                </h2>
                <p style={{ fontSize: 16, color: C.text, maxWidth: 480, margin: '0 auto' }}>ההבדל בין לנהל עסק לבין שהעסק ינהל אתכם.</p>
              </div>
            </Reveal>
            <div className="why-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Reveal>
                <div style={{ height: '100%', boxSizing: 'border-box', background: C.cardBg, borderRadius: 20, border: `1px solid ${C.border}`, padding: '28px 28px 8px', boxShadow: '0 4px 20px rgba(28,27,31,0.04)' }}>
                  <p style={{ fontSize: 12, fontWeight: 800, color: C.textDim, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 20 }}>הדרך הישנה</p>
                  {WHY_US.map((w, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 22 }}>
                      <XCircle style={{ width: 18, height: 18, color: '#b3564f', flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: 14.5, color: C.text, lineHeight: 1.6 }}>{w.without}</span>
                    </div>
                  ))}
                </div>
              </Reveal>
              <Reveal delay={120}>
                <div style={{ height: '100%', boxSizing: 'border-box', background: 'linear-gradient(155deg, rgba(201,162,39,0.12), #141418 60%)', borderRadius: 20, border: `1px solid ${C.goldBorderH}`, padding: '28px 28px 8px', boxShadow: '0 12px 40px rgba(0,0,0,0.4), 0 0 40px rgba(201,162,39,0.1)' }}>
                  <p style={{ fontSize: 12, fontWeight: 800, color: C.goldLight, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 20 }}>עם House of Business</p>
                  {WHY_US.map((w, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 22 }}>
                      <CheckCircle style={{ width: 18, height: 18, color: C.goldLight, flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: 14.5, color: C.onDarkText, lineHeight: 1.6, fontWeight: 500 }}>{w.withUs}</span>
                    </div>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── MODULES ─────────────────────────────────────────── */}
        <section id="features" style={{ padding: '96px 24px', background: C.bg }}>
          <div style={{ maxWidth: 1140, margin: '0 auto' }}>
            <Reveal>
              <div style={{ textAlign: 'center', marginBottom: 60 }}>
                <h2 style={{ fontFamily: FD, fontSize: 'clamp(26px,4vw,46px)', fontWeight: 900, color: C.ink, margin: '0 0 14px', letterSpacing: '-1px' }}>
                  כל מה שהעסק צריך <span className="shimmer-text">במקום אחד</span>
                </h2>
                <p style={{ fontSize: 16, color: C.text, maxWidth: 480, margin: '0 auto' }}>24 מודולי ניהול מקצועיים, מחוברים ומסונכרנים.</p>
              </div>
            </Reveal>
            <div className="module-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 12 }}>
              {MODULES.map((m, i) => {
                const Icon = m.icon;
                return (
                  <Reveal key={m.label} delay={Math.min(i * 25, 300)}>
                    <div className="card-hover" style={{ height: '100%', boxSizing: 'border-box', padding: '18px 14px', borderRadius: 14, background: C.cardBg, border: `1px solid ${C.border}`, textAlign: 'center', boxShadow: '0 2px 8px rgba(28,27,31,0.04)' }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: C.goldSoft, border: `1px solid ${C.goldBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
                        <Icon style={{ width: 20, height: 20, color: C.gold }} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{m.label}</div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ────────────────────────────────────── */}
        <section id="steps" style={{ padding: '100px 24px', background: C.bgAlt }}>
          <div style={{ maxWidth: 1000, margin: '0 auto' }}>
            <Reveal>
              <div style={{ textAlign: 'center', marginBottom: 72 }}>
                <h2 style={{ fontFamily: FD, fontSize: 'clamp(28px,4vw,50px)', fontWeight: 900, color: C.ink, margin: '0 0 16px', letterSpacing: '-1px' }}>
                  איך <span className="shimmer-text">זה עובד</span>
                </h2>
                <p style={{ fontSize: 16, color: C.text, maxWidth: 480, margin: '0 auto' }}>תהליך הטמעה פשוט, עם ליווי אישי לכל אורך הדרך.</p>
              </div>
            </Reveal>
            <div className="steps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 32, position: 'relative' }}>
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <Reveal key={s.n} delay={i * 100}>
                    <div style={{ textAlign: 'center', position: 'relative', zIndex: 1 }}>
                      <div className="gold-glow" style={{ width: 88, height: 88, borderRadius: '50%', background: C.cardBg, border: `1px solid ${C.goldBorderH}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 28px', boxShadow: '0 4px 16px rgba(28,27,31,0.06)' }}>
                        <Icon style={{ width: 34, height: 34, color: C.gold }} />
                      </div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: C.gold, marginBottom: 10, letterSpacing: '2px' }}>שלב {s.n}</div>
                      <h3 style={{ fontFamily: FD, fontSize: 20, fontWeight: 800, color: C.ink, margin: '0 0 10px' }}>{s.title}</h3>
                      <p style={{ fontSize: 14, color: C.text, lineHeight: 1.8, margin: 0 }}>{s.desc}</p>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── INDUSTRIES ──────────────────────────────────────── */}
        <section style={{ padding: '96px 24px', background: C.bgAlt, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ maxWidth: 1100, margin: '0 auto' }}>
            <Reveal>
              <div style={{ textAlign: 'center', marginBottom: 52 }}>
                <p style={{ fontSize: 11, fontWeight: 800, color: C.gold, textTransform: 'uppercase', letterSpacing: '3px', marginBottom: 14 }}>מותאמים אליכם</p>
                <h2 style={{ fontFamily: FD, fontSize: 'clamp(26px,4vw,44px)', fontWeight: 900, color: C.ink, margin: '0 0 14px', letterSpacing: '-1px' }}>
                  פתרונות לכל סוגי העסק
                </h2>
                <p style={{ fontSize: 16, color: C.text, maxWidth: 480, margin: '0 auto' }}>מסעדת שף ועד קיוסק שכונתי — המערכת מתאימה את עצמה לאופי העסק שלכם.</p>
              </div>
            </Reveal>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18 }}>
              {INDUSTRIES.map((ind, i) => (
                <Reveal key={ind.label} delay={i * 70}>
                  <div className="card-hover" style={{
                    aspectRatio: '1.8', borderRadius: 16, background: `linear-gradient(155deg, ${ind.from}, ${ind.to})`,
                    position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-end',
                    boxShadow: '0 16px 36px rgba(0,0,0,0.35)', padding: 22,
                  }}>
                    <div className="shine-sweep" style={{ animationDelay: `${i * 0.6}s` }} />
                    <IndustryScene label={ind.label} />
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.08)' }} />
                    <span style={{ position: 'relative', fontSize: 19, fontWeight: 800, color: '#fff', textShadow: '0 2px 10px rgba(0,0,0,0.35)' }}>{ind.label}</span>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ─────────────────────────────────────────────── */}
        <section id="pricing" style={{ padding: '120px 24px', background: C.bg, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)`, backgroundSize: '60px 60px', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', width: 800, height: 800, background: 'radial-gradient(circle,rgba(184,148,31,0.08),transparent 60%)', pointerEvents: 'none' }} />
          <Reveal>
            <div style={{ maxWidth: 700, margin: '0 auto', textAlign: 'center', position: 'relative' }}>
              <div style={{ fontFamily: FD, fontWeight: 900, fontSize: 15, letterSpacing: '4px', color: C.gold, textTransform: 'uppercase', marginBottom: 32 }}>House of Business</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderRadius: 999, border: `1px solid ${C.goldBorderH}`, background: C.goldSoft, marginBottom: 32 }}>
                <Sparkles style={{ width: 13, height: 13, color: C.gold }} />
                <span style={{ fontSize: 12, color: C.goldDark, fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>מוכן להתחיל?</span>
              </div>
              <h2 style={{ fontFamily: FD, fontSize: 'clamp(32px,5vw,60px)', fontWeight: 900, color: C.ink, margin: '0 0 16px', letterSpacing: '-1.5px' }}>
                תנו ל AI לנהל
              </h2>
              <h2 className="shimmer-text" style={{ fontFamily: FD, fontSize: 'clamp(32px,5vw,60px)', fontWeight: 900, margin: '0 0 28px', letterSpacing: '-1.5px' }}>
                אתם תצמחו
              </h2>
              <p style={{ fontSize: 17, color: C.text, marginBottom: 48, lineHeight: 1.8 }}>
                הצטרפו לפלטפורמה שמשנה את הדרך שבה עסקים מנוהלים.<br />פשוט, חכם, ומועיל מהיום הראשון.
              </p>
              <CtaLeadForm />
              <div style={{ marginBottom: 28 }}>
                <a href={`${APP}/login`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 30px', borderRadius: 12, fontSize: 14, fontWeight: 700, color: C.textDim, textDecoration: 'none', border: `1px solid ${C.border}`, background: 'transparent', transition: 'all .2s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = C.goldBorderH; (e.currentTarget as HTMLElement).style.color = C.goldDark; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.color = C.textDim; }}>
                  כבר לקוחות? כניסה למערכת
                </a>
              </div>
              <p style={{ fontSize: 12, color: C.textDim, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Lock style={{ width: 11, height: 11 }} /> ללא כרטיס אשראי · הגדרה תוך דקות · תמיכה בעברית
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── FOOTER ──────────────────────────────────────────── */}
        <footer style={{ background: C.bgAlt, borderTop: `1px solid ${C.border}`, padding: '56px 24px 36px' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 40, marginBottom: 48 }}>
              <div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: FD, fontWeight: 900, fontSize: 14, color: C.ink, letterSpacing: '-.2px' }}>HOUSE OF <span style={{ color: C.gold }}>BUSINESS</span></div>
                  <div style={{ fontSize: 9, color: C.textDim, letterSpacing: '2px', textTransform: 'uppercase', marginTop: 2 }}>AI · FINANCE · GROWTH · FREEDOM</div>
                </div>
                <p style={{ fontSize: 13, color: C.textDim, maxWidth: 240, lineHeight: 1.7, margin: 0 }}>מערכת ה-AI לניהול עסקים חכמים בישראל.</p>
              </div>
              <div style={{ display: 'flex', gap: 56, flexWrap: 'wrap' }}>
                {[
                  { title: 'מוצר',   links: [["פיצ'רים",'#features'],['AI Agents','#ai'],['איך זה עובד','#steps']] },
                  { title: 'חשבון',  links: [['כניסה',`${APP}/login`],['הרשמה',`${APP}/register`],['תמיכה','#lead-modal']] },
                  { title: 'משפטי',  links: [['מדיניות פרטיות','/privacy'],['תנאי שימוש','/terms']] },
                ].map(col => (
                  <div key={col.title}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.goldDark, textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: 16 }}>{col.title}</div>
                    {col.links.map(([l,h]) => (
                      <div key={l} style={{ marginBottom: 12 }}>
                        <a
                          href={h === '#lead-modal' ? undefined : h}
                          onClick={h === '#lead-modal' ? (e) => { e.preventDefault(); setShowLead(true); } : undefined}
                          style={{ fontSize: 14, color: C.textDim, textDecoration: 'none', transition: 'color .15s', cursor: 'pointer' }}
                          onMouseEnter={e => (e.currentTarget.style.color = C.goldDark)}
                          onMouseLeave={e => (e.currentTarget.style.color = C.textDim)}>
                          {l}
                        </a>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 24, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <p style={{ fontSize: 12, color: C.textDim, margin: 0 }}>© 2026 House of Business. כל הזכויות שמורות.</p>
              <p style={{ fontSize: 12, color: C.textDim, margin: 0 }}>בנוי בישראל 🇮🇱</p>
            </div>
          </div>
        </footer>

      </div>

      <button
        onClick={() => setShowKbd(true)}
        style={{
          position: 'fixed', bottom: 20, left: 20, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 8,
          background: C.cardBg,
          border: `1px solid ${C.border}`,
          color: C.textDim,
          fontSize: 12, cursor: 'pointer', transition: 'all 0.2s',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}
        title="קיצורי מקלדת"
        onMouseEnter={e => (e.currentTarget.style.color = C.goldDark)}
        onMouseLeave={e => (e.currentTarget.style.color = C.textDim)}
      >
        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>?</span>
        <span>קיצורים</span>
      </button>
    </>
  );
}
