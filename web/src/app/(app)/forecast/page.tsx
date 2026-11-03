'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LineChart, Line } from 'recharts';
import {
  TrendingUp, Users, ShoppingCart, Cloud, Sun, CloudRain,
  Thermometer, Star, AlertTriangle, RefreshCw, ChevronDown, ChevronUp,
  Settings, X, Plus, Trash2, Info } from 'lucide-react';
import { forecastApi, ForecastSettings, DEFAULT_FORECAST_SETTINGS } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { useAppDialog } from '@/context/AppDialogContext';
import { formatCurrency } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

// ── Types ───────────────────────────────────────────────────
interface ForecastDay {
  date: string;
  dayName: string;
  dow: number;
  isClosed?: boolean;
  predictedRevenue: number;
  predictedCovers: number;
  recommendedStaff: number;
  cogsTotal: number;
  holidayLabel: string;
  weatherLabel: string;
  weatherSeverity: 'normal' | 'warning' | 'severe';
  weatherEmoji: string;
  weatherCode: number | null;
  temperature: number | null;
  precipitation: number | null;
  weatherMult: number;
  holidayMult: number;
  confidence: 'high' | 'medium' | 'low';
  lastYearDate?: string;
  lastYearRevenue?: number | null;
  lastYearCovers?: number | null;
}

interface ForecastData {
  forecast: ForecastDay[];
  summary: {
    weekRevenue: number;
    weekCogs: number;
    totalCovers: number;
    avgStaff: number;
    peakDay: ForecastDay;
    quietDay: ForecastDay;
  };
  orderSuggestion: {
    meat: number; fish: number; produce: number;
    dairy: number; dry: number; beverages: number;
  };
  orderSuggestionSource?: 'invoices' | 'unavailable';
  orderSuggestionWeeks?: number;
  histWeeklyRevenue?: number;
  lowStock: { name: string; quantity: string; unit: string; category: string }[];
  hasHistoricalData: boolean;
  cogsRatio: number;
  weatherSource?: string;
  weatherFetchedAt?: string;
  weatherFromCache?: boolean;
  weatherCity?: string | null;
  staffSource?: 'shifts' | 'z_shifts' | 'ratio';
  calibratedRps?: number | null;
}

interface SmartOrderItem {
  name: string; unit: string; category: string;
  currentStock: number; neededForForecast: number;
  minQty: number; maxQty: number;
  orderQty: number; estimatedCost: number; hasPrice: boolean;
  urgency: 'critical' | 'high' | 'normal';
}
interface DishTrend {
  name: string; recentQty: number; previousQty: number;
  changePct: number; trend: 'rising' | 'falling' | 'stable';
}
interface SmartInsight { type: string; icon: string; title: string; text: string; }
interface SmartOrderData {
  horizon: number;
  dishes: { name: string; predicted: number }[];
  orderList: SmartOrderItem[];
  dishTrends: DishTrend[];
  insights: SmartInsight[];
  totalOrderCost: number; itemsToOrder: number; criticalCount: number;
}

// ── Weather Dynamic Background ───────────────────────────────

type WeatherBgType = 'sunny' | 'hot' | 'cold' | 'partly-cloudy' | 'cloudy' | 'foggy' | 'drizzle' | 'rainy' | 'stormy' | 'snowy';

function getWeatherBgType(code: number | null, temp: number | null): WeatherBgType {
  if (code === null) return temp && temp >= 34 ? 'hot' : 'sunny';
  if (code >= 95) return 'stormy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code >= 85 && code <= 86) return 'snowy';
  if (code >= 80 && code <= 82) return 'rainy';
  if (code >= 63 && code <= 67) return 'rainy';
  if (code >= 61) return 'drizzle';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 45 && code <= 48) return 'foggy';
  if (code === 3) return 'cloudy';
  if (code === 2) return 'partly-cloudy';
  if (temp !== null && temp >= 34) return 'hot';
  if (temp !== null && temp <= 8) return 'cold';
  return 'sunny';
}

const WEATHER_BG: Record<WeatherBgType, { gradient: string; }> = {
  sunny:          { gradient: 'linear-gradient(170deg,#1565c0 0%,#1e88e5 35%,#29b6f6 60%,#f9a825 85%,#f57c00 100%)' },
  hot:            { gradient: 'linear-gradient(170deg,#b71c1c 0%,#e53935 25%,#fb8c00 55%,#fdd835 80%,#1565c0 100%)' },
  cold:           { gradient: 'linear-gradient(170deg,#0a1628 0%,#0d47a1 40%,#1976d2 65%,#81d4fa 90%,#e1f5fe 100%)' },
  'partly-cloudy':{ gradient: 'linear-gradient(170deg,#1565c0 0%,#42a5f5 40%,#90caf9 65%,#b0bec5 100%)' },
  cloudy:         { gradient: 'linear-gradient(170deg,#37474f 0%,#546e7a 40%,#78909c 70%,#90a4ae 100%)' },
  foggy:          { gradient: 'linear-gradient(170deg,#455a64 0%,#78909c 40%,#b0bec5 70%,#cfd8dc 100%)' },
  drizzle:        { gradient: 'linear-gradient(170deg,#1a3a5c 0%,#2e6da4 45%,#4a90d4 75%,#5ba3e0 100%)' },
  rainy:          { gradient: 'linear-gradient(170deg,#0d1b2e 0%,#1a3a5c 35%,#1e5082 65%,#2979b5 100%)' },
  stormy:         { gradient: 'linear-gradient(170deg,#0a0e1a 0%,#1a1f3a 30%,#23204d 60%,#2d2762 100%)' },
  snowy:          { gradient: 'linear-gradient(170deg,#0d2f5c 0%,#1565c0 35%,#64b5f6 65%,#e3f2fd 100%)' },
};

const WEATHER_KEYFRAMES = `
@keyframes wRainDrop {
  0%   { transform: translateY(-60px) rotate(20deg); opacity: 0; }
  8%   { opacity: 0.55; }
  92%  { opacity: 0.55; }
  100% { transform: translateY(340px) rotate(20deg); opacity: 0; }
}
@keyframes wSnowFlake {
  0%   { transform: translateY(-40px) translateX(0) rotate(0deg); opacity: 0; }
  8%   { opacity: 0.75; }
  92%  { opacity: 0.75; }
  100% { transform: translateY(340px) translateX(40px) rotate(420deg); opacity: 0; }
}
@keyframes wCloudDrift {
  0%,100% { transform: translateX(0) translateY(0); }
  33%     { transform: translateX(22px) translateY(-6px); }
  66%     { transform: translateX(-12px) translateY(4px); }
}
@keyframes wSunRay {
  0%,100% { transform: scale(1) rotate(0deg); opacity: 0.22; }
  50%     { transform: scale(1.14) rotate(180deg); opacity: 0.44; }
}
@keyframes wSunGlow {
  0%,100% { box-shadow: 0 0 60px 30px rgba(255,224,100,0.30); transform: scale(1); }
  50%     { box-shadow: 0 0 110px 60px rgba(255,200,50,0.50); transform: scale(1.06); }
}
@keyframes wLightning {
  0%,100%  { opacity: 0; }
  3%,7%    { opacity: 1; }
  5%       { opacity: 0.25; }
  70%,74%  { opacity: 0.8; }
  72%      { opacity: 0.1; }
}
@keyframes wFogDrift {
  0%,100% { transform: translateX(-25px); opacity: 0.28; }
  50%     { transform: translateX(25px);  opacity: 0.48; }
}
@keyframes wHotShimmer {
  0%,100% { transform: scaleX(1) translateY(0); opacity: 0.12; }
  50%     { transform: scaleX(1.04) translateY(-10px); opacity: 0.24; }
}
`;

// ── Particle components ──────────────────────────────────────

function RainParticles({ heavy }: { heavy: boolean }) {
  const drops = useMemo(() => {
    const count = heavy ? 28 : 14;
    return Array.from({ length: count }, (_, i) => ({
      left: `${(i * 100 / count + (i * 7.3) % 6) % 100}%`,
      width: heavy ? '1.5px' : '1px',
      height: heavy ? '18px' : '12px',
      dur: heavy ? 0.55 + (i % 7) * 0.07 : 0.7 + (i % 5) * 0.1,
      delay: (i * 97) % 600,
    }));
  }, [heavy]);
  return (
    <>
      {drops.map((d, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0,
          left: d.left, width: d.width, height: d.height,
          background: 'rgba(200,230,255,0.55)',
          borderRadius: '2px',
          animation: `wRainDrop ${d.dur}s linear ${d.delay}ms infinite`,
        }} />
      ))}
    </>
  );
}

function SnowParticles() {
  const flakes = useMemo(() =>
    Array.from({ length: 20 }, (_, i) => ({
      left: `${(i * 100 / 20 + i * 3.7) % 100}%`,
      fontSize: i % 3 === 0 ? '14px' : '10px',
      dur: 1.4 + (i % 9) * 0.2,
      delay: (i * 130) % 900,
    })), []);
  return (
    <>
      {flakes.map((f, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0,
          left: f.left,
          fontSize: f.fontSize,
          animation: `wSnowFlake ${f.dur}s linear ${f.delay}ms infinite`,
          userSelect: 'none',
        }}>❄</div>
      ))}
    </>
  );
}

function CloudLayers({ count = 4, opacity = 1 }: { count?: number; opacity?: number }) {
  const clouds = [
    { top: '12%', left: '8%',  scale: 1.2, delay: 0,    dur: 8 },
    { top: '28%', left: '55%', scale: 0.9, delay: 2000, dur: 11 },
    { top: '8%',  left: '72%', scale: 0.7, delay: 1000, dur: 9 },
    { top: '42%', left: '30%', scale: 1.0, delay: 3000, dur: 13 },
  ].slice(0, count);
  return (
    <>
      {clouds.map((c, i) => (
        <svg key={i} viewBox="0 0 120 60" style={{
          position: 'absolute', top: c.top, left: c.left,
          width: `${c.scale * 110}px`, opacity: opacity * 0.35,
          animation: `wCloudDrift ${c.dur}s ease-in-out ${c.delay}ms infinite`,
          filter: 'blur(1px)',
        }}>
          <ellipse cx="60" cy="40" rx="55" ry="20" fill="white" />
          <ellipse cx="40" cy="30" rx="30" ry="22" fill="white" />
          <ellipse cx="75" cy="28" rx="25" ry="18" fill="white" />
        </svg>
      ))}
    </>
  );
}

function SunLayer({ hot }: { hot: boolean }) {
  return (
    <>
      {/* Sun glow circle */}
      <div style={{
        position: 'absolute', top: '18%', right: '12%',
        width: '90px', height: '90px',
        background: hot ? 'radial-gradient(circle,rgba(255,160,50,0.9),rgba(255,100,20,0.4))' : 'radial-gradient(circle,rgba(255,224,100,0.9),rgba(255,180,50,0.3))',
        borderRadius: '50%',
        animation: 'wSunGlow 3.5s ease-in-out infinite',
      }} />
      {/* Rotating rays */}
      <div style={{
        position: 'absolute', top: 'calc(18% - 25px)', right: 'calc(12% - 25px)',
        width: '140px', height: '140px',
        background: `conic-gradient(from 0deg, transparent 0deg, ${hot ? 'rgba(255,100,30,0.18)' : 'rgba(255,220,80,0.2)'} 18deg, transparent 36deg)`,
        borderRadius: '50%',
        animation: 'wSunRay 8s linear infinite',
      }} />
    </>
  );
}

function LightningLayer() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'radial-gradient(ellipse at 45% 30%, rgba(200,180,255,0.25), transparent 60%)',
      animation: 'wLightning 4s ease-in-out infinite',
      pointerEvents: 'none',
    }} />
  );
}

function FogLayers() {
  return (
    <>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: 'absolute',
          top: `${25 + i * 22}%`, left: '-10%',
          width: '120%', height: '55px',
          background: 'linear-gradient(90deg,transparent,rgba(200,215,220,0.5),transparent)',
          borderRadius: '50%',
          animation: `wFogDrift ${5 + i * 2}s ease-in-out ${i * 1400}ms infinite`,
          filter: 'blur(8px)',
        }} />
      ))}
    </>
  );
}

function HotShimmer() {
  return (
    <>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: 'absolute',
          bottom: `${10 + i * 15}%`, left: `${i * 30}%`,
          width: '40%', height: '80px',
          background: 'linear-gradient(0deg,rgba(255,150,50,0.15),transparent)',
          animation: `wHotShimmer ${2 + i * 0.7}s ease-in-out ${i * 500}ms infinite`,
        }} />
      ))}
    </>
  );
}

function WeatherAnimatedBg({ type, children, fullPage }: { type: WeatherBgType; children: React.ReactNode; fullPage?: boolean }) {
  const cfg = WEATHER_BG[type];
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: WEATHER_KEYFRAMES }} />
      <div style={{
        position: 'relative',
        ...(fullPage ? { minHeight: '100vh' } : { overflow: 'hidden', borderRadius: '24px' }),
        background: cfg.gradient,
        transition: 'background 1.2s ease',
      }}>
        {/* Animated particles */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {(type === 'rainy' || type === 'drizzle') && <RainParticles heavy={type === 'rainy'} />}
          {type === 'stormy' && <><RainParticles heavy /><LightningLayer /></>}
          {type === 'snowy' && <SnowParticles />}
          {(type === 'sunny' || type === 'hot') && <SunLayer hot={type === 'hot'} />}
          {type === 'hot' && <HotShimmer />}
          {(type === 'cloudy' || type === 'partly-cloudy') && <CloudLayers count={type === 'partly-cloudy' ? 2 : 4} />}
          {(type === 'partly-cloudy' || type === 'cold') && <SunLayer hot={false} />}
          {type === 'cold' && <CloudLayers count={2} opacity={0.5} />}
          {type === 'foggy' && <FogLayers />}
          {/* Subtle radial overlay for depth */}
          <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse at 30% 0%, rgba(255,255,255,0.08), transparent 60%)',
          }} />
        </div>
        {/* Content */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          {children}
        </div>
      </div>
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────
const WEEK_COLORS = ['#6366f1','#3b82f6','#8b5cf6','#06b6d4','#f97316','#ef4444','#a855f7'];

function WeatherIcon({ label }: { label: string }) {
  if (label.includes('גשום')) return <CloudRain className="w-4 h-4 text-blue-400" />;
  if (label.includes('גשמי')) return <Cloud className="w-4 h-4 text-gray-400" />;
  if (label.includes('חם'))   return <Thermometer className="w-4 h-4 text-red-500" />;
  if (label.includes('קר'))   return <Thermometer className="w-4 h-4 text-blue-300" />;
  return <Sun className="w-4 h-4 text-yellow-400" />;
}

// ── Settings Panel ───────────────────────────────────────────
function SettingsPanel({ onClose, onSave, initialSettings }: { onClose: () => void; onSave: (s: ForecastSettings) => void; initialSettings: ForecastSettings }) {
  const [s, setS] = useState<ForecastSettings>(initialSettings);
  const [newEvent, setNewEvent] = useState({ date: '', label: '', multiplier: 1.5 });

  const cogsSum = Object.values(s.cogsBreakdown).reduce((a, b) => a + b, 0);
  const cogsOk  = Math.abs(cogsSum - 100) < 1;

  function setCogs(key: keyof ForecastSettings['cogsBreakdown'], val: number) {
    setS(prev => ({ ...prev, cogsBreakdown: { ...prev.cogsBreakdown, [key]: val } }));
  }

  function addEvent() {
    if (!newEvent.date || !newEvent.label) return;
    setS(prev => ({ ...prev, customEvents: [...prev.customEvents, { ...newEvent }] }));
    setNewEvent({ date: '', label: '', multiplier: 1.5 });
  }

  function removeEvent(i: number) {
    setS(prev => ({ ...prev, customEvents: prev.customEvents.filter((_, idx) => idx !== i) }));
  }

  function handleSave() {
    onSave(s);
    onClose();
  }

  const COGS_LABELS: Record<keyof ForecastSettings['cogsBreakdown'], string> = {
    meat: 'בשר ועוף', fish: 'דגים', produce: 'ירקות ופירות',
    dairy: 'מוצרי חלב', dry: 'יבש ומשומר', beverages: 'שתייה ובר',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end" dir="rtl">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="relative h-full w-full max-w-xl shadow-2xl overflow-y-auto flex flex-col" style={{ background: '#141418', borderLeft: '1px solid rgba(201,162,39,0.2)' }}>
        {/* Header */}
        <div className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between" style={{ background: '#111116', borderBottom: '1px solid rgba(201,162,39,0.14)' }}>
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5" style={{ color: '#60b8e8' }} />
            <h2 className="text-lg font-bold" style={{ color: '#e8e8e4' }}>הגדרות חיזוי ביקוש</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg" style={{ color: '#9aa0ab' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 p-6 space-y-8">

          {/* ── 0. מיקום אוטומטי ────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Cloud className="w-4 h-4 text-sky-500" />
              <h3 className="font-bold" style={{ color: '#e8e8e4' }}>מיקום לחיזוי מזג האוויר</h3>
            </div>
            <div className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm"
              style={{ border: '1px solid rgba(14,165,233,0.25)', background: 'rgba(14,165,233,0.07)', color: '#7dd3fc' }}>
              <span>📍</span>
              <span>המיקום נקבע אוטומטית לפי כתובת העסק בהגדרות</span>
            </div>
          </section>

          <hr style={{ borderColor: 'rgba(201,162,39,0.12)' }} />

          {/* ── 1. יחס עובד:סועד ───────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-4 h-4 text-purple-600" />
              <h3 className="font-bold" style={{ color: '#e8e8e4' }}>חיזוי עובדים</h3>
            </div>
            <p className="text-xs mb-4" style={{ color: '#9aa0ab' }}>
              המערכת לומדת אוטומטית מנתוני המשמרות שלך — כמה עובדים עבדו ביחס למחזור של אותו יום — וממליצה בהתאם.
            </p>

            <div className="space-y-4">
              {/* Auto-calibration info */}
              <div className="rounded-lg px-3 py-3 text-xs space-y-1" style={{ background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)' }}>
                <p style={{ color: '#a78bfa' }} className="font-semibold">חישוב אוטומטי לפי היסטוריה</p>
                <p style={{ color: '#9aa0ab' }}>המערכת בוחנת כמה עובדים עבדו בימים דומים בעבר, ומחשבת את המחזור הממוצע לעובד. לדוגמה: אם בימי חמישי עם מחזור ₪7,000 עבדו 3 עובדים — כשצפוי מחזור של ₪7,000 תוצג המלצה של 3 עובדים.</p>
                <p className="mt-1" style={{ color: 'rgba(167,139,250,0.6)' }}>לעסקים ללא נתוני משמרות — ייעשה שימוש בברירת מחדל.</p>
              </div>

              {/* Min staff */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <label className="font-medium" style={{ color: '#b8bcc4' }}>מינימום עובדים ביום</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setS(prev => ({ ...prev, minStaff: Math.max(1, prev.minStaff - 1) }))}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold" style={{ background: '#1a1a22', color: '#9aa0ab' }}
                    >−</button>
                    <span className="font-bold w-6 text-center" style={{ color: '#e8e8e4' }}>{s.minStaff}</span>
                    <button
                      onClick={() => setS(prev => ({ ...prev, minStaff: Math.min(20, prev.minStaff + 1) }))}
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold" style={{ background: '#1a1a22', color: '#9aa0ab' }}
                    >+</button>
                  </div>
                </div>
                <p className="text-xs" style={{ color: '#9aa0ab' }}>גם בימי שקט — לא ירד מ-{s.minStaff} עובדים</p>
              </div>
            </div>
          </section>

          <hr style={{ borderColor: 'rgba(201,162,39,0.12)' }} />

          {/* ── 2. חלוקת COGS לקטגוריות ────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <ShoppingCart className="w-4 h-4 text-orange-600" />
              <h3 className="font-bold" style={{ color: '#e8e8e4' }}>חלוקת הזמנות לפי קטגוריה</h3>
            </div>
            <p className="text-xs mb-4" style={{ color: '#9aa0ab' }}>
              כמה אחוז מסך ה-COGS מוקצה לכל קטגוריה. הסך חייב להיות 100%.
            </p>

            <div className="space-y-3">
              {(Object.keys(s.cogsBreakdown) as (keyof ForecastSettings['cogsBreakdown'])[]).map(key => (
                <div key={key}>
                  <div className="flex justify-between text-sm mb-1">
                    <label style={{ color: '#b8bcc4' }}>{COGS_LABELS[key]}</label>
                    <span className="font-bold" style={{ color: '#e8e8e4' }}>{s.cogsBreakdown[key]}%</span>
                  </div>
                  <input
                    type="range" min={0} max={80} step={1}
                    value={s.cogsBreakdown[key]}
                    onChange={e => setCogs(key, +e.target.value)}
                    className="w-full accent-orange-500"
                  />
                </div>
              ))}

              {/* Sum indicator */}
              <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-semibold ${
                cogsOk ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>
                <span>סה"כ</span>
                <span className="text-base font-bold">{Math.round(cogsSum)}%</span>
                {!cogsOk && <span className="text-xs font-normal">חייב להיות 100%</span>}
                {cogsOk  && <span className="text-xs font-normal">✓ תקין</span>}
              </div>

              {/* Quick normalize button */}
              {!cogsOk && (
                <button
                  onClick={() => {
                    const keys = Object.keys(s.cogsBreakdown) as (keyof ForecastSettings['cogsBreakdown'])[];
                    const total = Object.values(s.cogsBreakdown).reduce((a, b) => a + b, 0);
                    if (total === 0) return;
                    const norm = {} as ForecastSettings['cogsBreakdown'];
                    keys.forEach(k => { norm[k] = Math.round(s.cogsBreakdown[k] / total * 100); });
                    // Fix rounding
                    const diff = 100 - Object.values(norm).reduce((a, b) => a + b, 0);
                    norm[keys[0]] += diff;
                    setS(prev => ({ ...prev, cogsBreakdown: norm }));
                  }}
                  className="w-full text-xs text-blue-600 underline text-center py-1"
                >נרמל ל-100% אוטומטית</button>
              )}
            </div>
          </section>

          <hr style={{ borderColor: 'rgba(201,162,39,0.12)' }} />

          {/* ── 3. אירועים מותאמים ──────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <Star className="w-4 h-4 text-amber-500" />
              <h3 className="font-bold" style={{ color: '#e8e8e4' }}>אירועים מותאמים</h3>
            </div>
            <p className="text-xs mb-4" style={{ color: '#9aa0ab' }}>
              הוסף ימים מיוחדים — אירוע, מסיבה, סגירה. המכפיל יחליף את חישוב החג אוטומטית.
            </p>

            {/* Existing events */}
            {s.customEvents.length > 0 && (
              <div className="space-y-2 mb-4">
                {s.customEvents.map((ev, i) => (
                  <div key={ev.date} className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{ev.label}</p>
                      <p className="text-xs" style={{ color: '#9aa0ab' }}>
                        {new Date(ev.date).toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit', year:'numeric' })}
                        {' · '}
                        <span className={ev.multiplier >= 1 ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>
                          ×{ev.multiplier}
                          {ev.multiplier === 0 ? ' (סגור)' : ev.multiplier >= 1.5 ? ' (אירוע גדול)' : ev.multiplier >= 1 ? ' (עלייה)' : ' (ירידה)'}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() => removeEvent(i)}
                      className="p-1.5 rounded-lg flex-shrink-0" style={{ color: '#9aa0ab' }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new event */}
            <div className="rounded-xl p-4 space-y-3" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.14)' }}>
              <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>הוסף אירוע חדש</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: '#9aa0ab' }}>תאריך</label>
                  <input
                    type="date"
                    value={newEvent.date}
                    onChange={e => setNewEvent(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418', color: '#e8e8e4' }}
                  />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: '#9aa0ab' }}>שם האירוע</label>
                  <input
                    type="text"
                    placeholder="סילבסטר, ברית, אירוע VIP..."
                    value={newEvent.label}
                    onChange={e => setNewEvent(prev => ({ ...prev, label: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-600/40"
                    style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418', color: '#e8e8e4' }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <label style={{ color: '#9aa0ab' }}>מכפיל ביקוש</label>
                  <span className="font-bold" style={{ color: '#e8e8e4' }}>×{newEvent.multiplier.toFixed(1)}</span>
                </div>
                <input
                  type="range" min={0} max={3} step={0.1}
                  value={newEvent.multiplier}
                  onChange={e => setNewEvent(prev => ({ ...prev, multiplier: +e.target.value }))}
                  className="w-full accent-amber-500"
                />
                <div className="flex justify-between text-xs mt-1" style={{ color: '#9aa0ab' }}>
                  <span>סגור (0)</span>
                  <span>רגיל (1.0)</span>
                  <span>אירוע גדול (3.0)</span>
                </div>
              </div>
              {/* Presets */}
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'סילבסטר', mult: 1.8 },
                  { label: 'ל"ג בעומר', mult: 1.4 },
                  { label: 'יום הולדת/מסיבה', mult: 1.6 },
                  { label: 'סגור', mult: 0 },
                ].map(p => (
                  <button
                    key={p.label}
                    onClick={() => setNewEvent(prev => ({ ...prev, label: prev.label || p.label, multiplier: p.mult }))}
                    className="text-xs rounded-full px-2.5 py-1 transition-colors" style={{ background: '#1a1a22', border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab' }}
                  >
                    {p.label} ×{p.mult}
                  </button>
                ))}
              </div>
              <button
                onClick={addEvent}
                disabled={!newEvent.date || !newEvent.label}
                className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white rounded-xl py-2 text-sm font-semibold transition-colors"
              >
                <Plus className="w-4 h-4" /> הוסף אירוע
              </button>
            </div>
          </section>

          {/* Info note */}
          <div className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(96,184,232,0.1)', color: '#60b8e8' }}>
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>ההגדרות נשמרות במכשיר זה. לאחר שמירה החיזוי יחושב מחדש עם הנתונים החדשים.</span>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 px-6 py-4 flex gap-3" style={{ background: '#111116', borderTop: '1px solid rgba(201,162,39,0.14)' }}>
          <button
            onClick={() => { setS(DEFAULT_FORECAST_SETTINGS); }}
            className="flex-1 rounded-xl py-2.5 text-sm font-medium transition-colors" style={{ border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab' }}
          >
            איפוס לברירת מחדל
          </button>
          <button
            onClick={handleSave}
            disabled={!cogsOk}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl py-2.5 text-sm font-bold transition-colors"
          >
            שמור ועדכן חיזוי
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────
const AUTO_REFRESH_MS = 30 * 60 * 1000; // 30 דקות

function useWeatherAge(fetchedAt?: string): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!fetchedAt) return;
    function update() {
      const ageMin = Math.round((Date.now() - new Date(fetchedAt!).getTime()) / 60000);
      if (ageMin < 1)  setLabel('עכשיו');
      else if (ageMin < 60) setLabel(`לפני ${ageMin} דק׳`);
      else setLabel(`לפני ${Math.floor(ageMin / 60)} ש׳`);
    }
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, [fetchedAt]);
  return label;
}

export default function ForecastPage() {
  const { toast } = useAppDialog();
  const [data, setData]           = useState<ForecastData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [bgRefreshing, setBgRefreshing] = useState(false);
  const [days, setDays]           = useState(14);
  const [showAll, setShowAll]     = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Lazy init from localStorage — runs synchronously on first render, so the
  // very first forecast fetch below already uses the user's saved settings
  // Settings are loaded from DB on mount; defaults used for the initial forecast call.
  const [settings, setSettings]   = useState<ForecastSettings>(DEFAULT_FORECAST_SETTINGS);
  const [smartOrder, setSmartOrder]     = useState<SmartOrderData | null>(null);
  const [smartLoading, setSmartLoading] = useState(true);
  const [smartHorizon, setSmartHorizon] = useState(7);

  const weatherAge = useWeatherAge(data?.weatherFetchedAt);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (d = days, s = settings, silent = false) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (silent) setBgRefreshing(true); else setLoading(true);
    try {
      const { data: res } = await forecastApi.demand(d, s, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setData(res);
      if (res?.forecast?.[0]) {
        const wType = getWeatherBgType(res.forecast[0].weatherCode ?? null, res.forecast[0].temperature ?? null);
        try { localStorage.setItem('hob-weather-type', wType); } catch {}
      }
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'ERR_CANCELED' || ctrl.signal.aborted) return;
    }
    finally { if (silent) setBgRefreshing(false); else setLoading(false); }
  }, [days, settings]);

  // Initial load: getSettings + demand fired in parallel — saves 80-150ms
  useEffect(() => {
    setLoading(true);
    Promise.all([
      forecastApi.getSettings().catch(() => ({ data: null })),
      forecastApi.demand(days, DEFAULT_FORECAST_SETTINGS),
    ]).then(([settingsRes, demandRes]) => {
      const loaded: ForecastSettings = { ...DEFAULT_FORECAST_SETTINGS, ...(settingsRes?.data ?? {}) };
      setSettings(loaded);
      setData(demandRes.data);
      setLoading(false);
      // If real settings differ from defaults, re-fetch silently with actual settings
      if (JSON.stringify(loaded) !== JSON.stringify(DEFAULT_FORECAST_SETTINGS)) {
        forecastApi.demand(days, loaded).then(r => setData(r.data)).catch(() => {});
      }
    }).catch(() => setLoading(false));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30 min in the background (silent — no spinner)
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(days, settings, true); }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [days, settings, load]);

  // הגדרות שונו בטאב/מכשיר אחר — טען מחדש הגדרות + תחזית
  useSyncEvent(['forecast.updated'], useCallback(() => {
    forecastApi.getSettings()
      .then(({ data }) => {
        const loaded: ForecastSettings = { ...DEFAULT_FORECAST_SETTINGS, ...data };
        setSettings(loaded);
        load(days, loaded, true);
      })
      .catch(() => load(days, settings, true));
  }, [days, settings, load]));

  // מלאי השתנה — משפיע על המלצת הזמנה ורשימת מלאי נמוך בתחזית
  useSyncEvent(['inventory.updated'], useCallback(() => load(days, settings, true), [days, settings, load]));

  const loadSmartOrder = useCallback(() => {
    forecastApi.smartOrder(smartHorizon)
      .then(r => setSmartOrder(r.data))
      .catch(() => setSmartOrder(null));
  }, [smartHorizon]);

  useEffect(() => {
    setSmartLoading(true);
    forecastApi.smartOrder(smartHorizon)
      .then(r => setSmartOrder(r.data))
      .catch(() => setSmartOrder(null))
      .finally(() => setSmartLoading(false));
  }, [smartHorizon]);

  // מלאי השתנה — רשימת ההזמנה החכמה (orderList/urgency) תלויה ברמות מלאי עדכניות
  useSyncEvent(['inventory.updated'], loadSmartOrder);

  const handleSaveSettings = (newSettings: ForecastSettings) => {
    setSettings(newSettings);
    forecastApi.saveSettings(newSettings).catch(() => {
      toast('שמירת ההגדרות נכשלה — ההגדרות עשויות לחזור לקודמות בטעינה הבאה', 'error');
    });
    load(days, newSettings);
  };

  const displayDays = data
    ? (showAll ? data.forecast : data.forecast.slice(0, 7))
    : [];

  const customEventDates = new Set(settings.customEvents.map(e => e.date));

  const pageBgType: WeatherBgType = data?.forecast?.[0]
    ? getWeatherBgType(data.forecast[0].weatherCode ?? null, data.forecast[0].temperature ?? null)
    : 'partly-cloudy';

  return (
    <div dir="rtl">
    <div className="space-y-6 pt-5">

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
          initialSettings={settings}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'white', textShadow: '0 1px 10px rgba(0,0,0,0.35)' }}>חיזוי ביקוש</h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => { setDays(+e.target.value); load(+e.target.value); }}
            className="text-sm rounded-lg px-3 py-2 focus:outline-none font-medium"
            style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', color: 'white', backdropFilter: 'blur(8px)' }}
          >
            <option value={7} style={{ color: '#111' }}>שבוע קדימה</option>
            <option value={14} style={{ color: '#111' }}>14 ימים</option>
            <option value={30} style={{ color: '#111' }}>30 ימים</option>
          </select>
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors relative"
            style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', color: 'white', backdropFilter: 'blur(8px)' }}
          >
            <Settings className="w-4 h-4" />
            הגדרות
            {settings.customEvents.length > 0 && (
              <span className="absolute -top-1.5 -left-1.5 w-4 h-4 bg-amber-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
                {settings.customEvents.length}
              </span>
            )}
          </button>
          <button
            onClick={() => load()}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
            style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', color: 'white', backdropFilter: 'blur(8px)' }}
          >
            <RefreshCw className={`w-4 h-4 ${loading || bgRefreshing ? 'animate-spin' : ''}`} /> רענן
          </button>
        </div>
      </div>

      {/* Active settings summary */}
      {(settings.minStaff !== 2 || settings.customEvents.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span style={{ color: 'rgba(255,255,255,0.7)' }}>הגדרות פעילות:</span>
          {settings.minStaff !== 2 && (
            <span style={{ background: 'rgba(255,255,255,0.2)', color: 'white', backdropFilter: 'blur(4px)' }} className="px-2 py-0.5 rounded-full">
              מינימום {settings.minStaff} עובדים
            </span>
          )}
          {settings.customEvents.map((ev) => (
            <span key={`${ev.date}_${ev.label}`} style={{ background: 'rgba(255,255,255,0.2)', color: 'white', backdropFilter: 'blur(4px)' }} className="px-2 py-0.5 rounded-full">
              {ev.label} ×{ev.multiplier}
            </span>
          ))}
        </div>
      )}

      {/* ── Weather Hero ─────────────────────────────────── */}
      {!loading && data && data.forecast.length > 0 && (() => {
        const today = data.forecast[0];
        return (
          <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(255,255,255,0.7)', boxShadow: '0 4px 24px rgba(0,0,0,0.12)' }}>
            {/* Top bar */}
            <div className="flex items-center justify-between px-5 pt-3 pb-2 flex-wrap gap-2" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <Cloud className="w-4 h-4 text-sky-500" />
                <span className="text-sm font-bold text-slate-700">תחזית מזג האוויר</span>
                {data.weatherCity && (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-sky-50 text-sky-600">
                    📍 {data.weatherCity}
                  </span>
                )}
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500">
                  {data.weatherSource === 'openweathermap' ? '⚡ OpenWeatherMap' : 'Open-Meteo'}
                </span>
                {weatherAge && (
                  <span className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1 bg-slate-100 text-slate-500">
                    {bgRefreshing ? <RefreshCw className="w-2.5 h-2.5 animate-spin inline" /> : '🕒'}
                    {bgRefreshing ? ' מעדכן...' : weatherAge}
                  </span>
                )}
              </div>
              {data.forecast.some((d: ForecastDay) => d.weatherSeverity === 'severe') && (
                <div className="flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full bg-red-50 text-red-600 border border-red-200">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {data.forecast.filter((d: ForecastDay) => d.weatherSeverity === 'severe').length} ימי מזג אוויר קיצוני
                </div>
              )}
            </div>

            {/* Today hero */}
            <div className="flex items-center gap-5 px-6 py-4">
              <div>
                <p className="text-6xl leading-none">{today.weatherEmoji || '🌡️'}</p>
              </div>
              <div>
                {today.temperature !== null && (
                  <p className="text-5xl font-black leading-none text-slate-800">
                    {Math.round(today.temperature)}°
                  </p>
                )}
                <p className="text-sm font-semibold mt-1 text-slate-600">
                  {today.dayName} · {today.weatherLabel}
                </p>
                {today.precipitation !== null && today.precipitation > 0 && (
                  <p className="text-xs mt-0.5 text-blue-500 font-medium">
                    🌧️ {today.precipitation.toFixed(1)} מ&quot;מ
                  </p>
                )}
              </div>
              <div className="mr-auto text-left" dir="ltr">
                <p className="text-xs font-medium text-slate-400">מחזור צפוי היום</p>
                <p className="text-2xl font-black text-slate-800">{formatCurrency(today.predictedRevenue)}</p>
                {today.weatherMult !== 1 && (
                  <p className="text-xs font-bold mt-0.5" style={{ color: today.weatherMult > 1 ? '#059669' : '#dc2626' }}>
                    {today.weatherMult > 1 ? '▲' : '▼'} {Math.abs(Math.round((today.weatherMult - 1) * 100))}% ממזג האוויר
                  </p>
                )}
              </div>
            </div>

            {/* 7-day strip */}
            <div className="grid grid-cols-7 gap-2 px-4 pb-4 pt-1">
              {data.forecast.slice(0, 7).map((d: ForecastDay, i: number) => {
                const isToday = i === 0;
                return (
                  <div key={d.date} className="flex flex-col items-center gap-1 py-3 px-1 rounded-2xl transition-all"
                    style={{
                      background: isToday ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.28)',
                      border: isToday ? '2px solid rgba(255,255,255,0.8)' : '1px solid rgba(255,255,255,0.15)',
                      boxShadow: d.weatherSeverity === 'severe'
                        ? '0 0 0 2px rgba(239,68,68,0.7)'
                        : undefined,
                    }}>
                    <span className="text-[11px] font-bold" style={{ color: 'rgba(255,255,255,0.95)' }}>{d.dayName}</span>
                    <span className="text-[10px] font-medium" style={{ color: 'rgba(255,255,255,0.6)' }}>
                      {new Date(d.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
                    </span>
                    <span className="text-xl leading-tight">{d.weatherEmoji || '🌡️'}</span>
                    <span className="text-sm font-black" style={{ color: 'white' }}>
                      {d.temperature !== null ? `${Math.round(d.temperature)}°` : '—'}
                    </span>
                    {d.precipitation !== null && d.precipitation > 0 && (
                      <span className="text-[10px] font-medium" style={{ color: 'rgba(147,210,255,0.9)' }}>{d.precipitation.toFixed(1)}מ&quot;מ</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* No data warning */}
      {!loading && data && !data.hasHistoricalData && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">אין עדיין נתוני מכירות היסטוריים</p>
            <p className="text-xs mt-0.5 text-amber-600">החיזוי מבוסס על ממוצעים כלליים. לאחר שתחברו קופה ותצברו נתונים, הדיוק ישתפר משמעותית.</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-6 animate-pulse">
          {/* KPI cards skeleton */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => (
              <div key={i} className="rounded-2xl p-5 flex items-center gap-4" style={{ background: '#1a1a22' }}>
                <div className="w-11 h-11 rounded-xl flex-shrink-0" style={{ background: '#252530' }} />
                <div className="flex-1 space-y-2">
                  <div className="h-3 rounded" style={{ background: '#252530', width: '60%' }} />
                  <div className="h-5 rounded" style={{ background: '#252530', width: '80%' }} />
                </div>
              </div>
            ))}
          </div>
          {/* Day cards skeleton */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[0,1,2,3,4,5,6].map(i => (
              <div key={i} className="rounded-2xl p-5 space-y-3" style={{ background: '#1a1a22' }}>
                <div className="flex justify-between">
                  <div className="h-4 rounded" style={{ background: '#252530', width: '40%' }} />
                  <div className="h-4 rounded" style={{ background: '#252530', width: '25%' }} />
                </div>
                <div className="h-7 rounded" style={{ background: '#252530', width: '55%' }} />
                <div className="space-y-1">
                  <div className="h-3 rounded" style={{ background: '#252530', width: '70%' }} />
                  <div className="h-3 rounded" style={{ background: '#252530', width: '50%' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !data ? (
        <div className="text-center py-20 text-gray-400">שגיאה בטעינת הנתונים</div>
      ) : (
        <>
          {/* ── Summary KPIs ──────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: 'מחזור צפוי (7 ימים)', value: formatCurrency(data.summary.weekRevenue), icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50' },
              { label: 'סועדים צפויים', value: data.summary.totalCovers.toLocaleString('he-IL'), icon: Users, color: 'text-green-600', bg: 'bg-green-50' },
              { label: 'עובדים ממוצע ליום', value: `${data.summary.avgStaff} עובדים`, icon: Users, color: 'text-purple-600', bg: 'bg-purple-50' },
            ].map(({ label, value, icon: Icon, color, bg }) => (
              <Card key={label}>
                <CardContent className="p-5 flex items-center gap-4">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${bg}`}>
                    <Icon className={`w-5 h-5 ${color}`} />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{label}</p>
                    <p className="text-xl font-bold text-gray-900 mt-0.5">{value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ── Peak / Quiet ─────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="border-green-200">
              <CardContent className="p-4 flex items-center gap-3">
                <Star className="w-6 h-6 text-green-500 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500">יום השיא השבועי</p>
                  <p className="text-base font-bold text-gray-900">
                    {data.summary.peakDay.dayName} ({new Date(data.summary.peakDay.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })})
                  </p>
                  <p className="text-sm text-green-600 font-semibold">{formatCurrency(data.summary.peakDay.predictedRevenue)}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-gray-200">
              <CardContent className="p-4 flex items-center gap-3">
                <TrendingUp className="w-6 h-6 text-gray-400 flex-shrink-0 rotate-180" />
                <div>
                  <p className="text-xs text-gray-500">יום השקט</p>
                  <p className="text-base font-bold text-gray-900">
                    {data.summary.quietDay.dayName} ({new Date(data.summary.quietDay.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })})
                  </p>
                  <p className="text-sm text-gray-500 font-semibold">{formatCurrency(data.summary.quietDay.predictedRevenue)}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Revenue Bar Chart ─────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-600" />
                מחזור יומי צפוי
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={displayDays} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                  <XAxis
                    dataKey="dayName"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v, i) => {
                      const d = displayDays[i];
                      return `${v}\n${new Date(d?.date || '').toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}`;
                    }}
                  />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₪${(v/1000).toFixed(0)}k`} width={42} />
                  <Tooltip
                    formatter={(val) => [formatCurrency(Number(val)), 'מחזור צפוי']}
                    labelFormatter={(_, payload) => {
                      const d = payload?.[0]?.payload as ForecastDay;
                      return d ? `${d.dayName} ${new Date(d.date).toLocaleDateString('he-IL')}` : '';
                    }}
                  />
                  <Bar dataKey="predictedRevenue" radius={[5, 5, 0, 0]}>
                    {displayDays.map((d, i) => (
                      <Cell
                        key={d.date}
                        fill={
                          d.isClosed ? '#9ca3af' :
                          customEventDates.has(d.date) ? '#f59e0b' :
                          d.holidayLabel === 'חג' ? '#d1d5db' :
                          d.holidayLabel === 'ערב חג' ? '#f59e0b' :
                          d.dow === 5 || d.dow === 6 ? '#10b981' :
                          WEEK_COLORS[i % WEEK_COLORS.length]
                        }
                        fillOpacity={d.isClosed ? 0.45 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-3 text-xs text-gray-400 justify-center flex-wrap">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> סוף שבוע</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-400 inline-block" /> ערב חג / אירוע</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-gray-300 inline-block" /> חג</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#9ca3af', opacity: 0.45 }} /> סגור</span>
              </div>
            </CardContent>
          </Card>

          {/* ── Daily Detail Table ────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>פירוט יומי — עובדים, סועדים ומזג אוויר</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['יום', 'תאריך', 'מחזור צפוי', 'סועדים', 'עובדים', 'מזג אוויר', 'הערות'].map(h => (
                        <th key={h} className="text-right text-xs font-medium text-gray-500 px-4 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {displayDays.map((d, i) => (
                      <tr key={d.date} className={`hover:bg-gray-50 ${d.isClosed ? 'opacity-50 bg-gray-50/50' : ''} ${!d.isClosed && d.holidayLabel === 'חג' && !customEventDates.has(d.date) ? 'opacity-60' : ''} ${customEventDates.has(d.date) ? 'bg-amber-50/50' : ''}`}>
                        <td className="px-4 py-3 font-semibold text-gray-800">
                          <span style={{ color: d.isClosed ? '#9ca3af' : WEEK_COLORS[i % WEEK_COLORS.length] }}>●</span>{' '}
                          {d.dayName}
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {new Date(d.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
                        </td>
                        <td className="px-4 py-3 font-bold text-gray-900">
                          {d.isClosed ? <span className="text-gray-400 font-normal">—</span> : (
                            <div>
                              <div>{formatCurrency(d.predictedRevenue)}</div>
                              {d.lastYearRevenue != null && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className="text-xs text-gray-400">אשתקד {formatCurrency(d.lastYearRevenue)}</span>
                                  {d.lastYearRevenue === 0 ? null : d.predictedRevenue > d.lastYearRevenue
                                    ? <span className="text-xs font-semibold text-green-600">▲{Math.round((d.predictedRevenue / d.lastYearRevenue - 1) * 100)}%</span>
                                    : <span className="text-xs font-semibold text-red-500">▼{Math.round((1 - d.predictedRevenue / d.lastYearRevenue) * 100)}%</span>
                                  }
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {d.isClosed ? '—' : `~${d.predictedCovers}`}
                        </td>
                        <td className="px-4 py-3">
                          {d.isClosed ? <span className="text-gray-400 text-xs">—</span> : (
                            <div className="flex items-center gap-1">
                              {Array.from({ length: Math.min(d.recommendedStaff, 8) }).map((_, j) => (
                                <div key={j} className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold" />
                              ))}
                              {d.recommendedStaff > 8 && <span className="text-xs text-gray-400">+{d.recommendedStaff - 8}</span>}
                              <span className="text-xs text-gray-500 mr-1">{d.recommendedStaff}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <WeatherIcon label={d.weatherLabel} />
                            <span className="text-xs text-gray-600">{d.weatherLabel || '—'}</span>
                            {d.temperature !== null && (
                              <span className="text-xs text-gray-400">{Math.round(d.temperature)}°</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1 flex-wrap">
                            {d.isClosed && (
                              <Badge variant="default">🔒 סגור</Badge>
                            )}
                            {!d.isClosed && d.holidayLabel && (
                              <Badge variant={customEventDates.has(d.date) ? 'warning' : d.holidayLabel === 'חג' ? 'default' : 'warning'}>
                                {d.holidayLabel}
                              </Badge>
                            )}
                            {!d.isClosed && d.weatherMult < 0.9 && (
                              <Badge variant="danger">↓{Math.round((1 - d.weatherMult) * 100)}%</Badge>
                            )}
                            {!d.isClosed && d.weatherMult > 1.05 && (
                              <Badge variant="success">↑{Math.round((d.weatherMult - 1) * 100)}%</Badge>
                            )}
                            {!d.isClosed && d.holidayMult > 1.1 && !customEventDates.has(d.date) && (
                              <Badge variant="warning">↑{Math.round((d.holidayMult - 1) * 100)}% ביקוש</Badge>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.forecast.length > 7 && (
                <div className="px-4 py-3 border-t border-gray-100">
                  <button
                    onClick={() => setShowAll(v => !v)}
                    className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                  >
                    {showAll
                      ? <><ChevronUp className="w-4 h-4" /> הצג פחות</>
                      : <><ChevronDown className="w-4 h-4" /> הצג {data.forecast.length - 7} ימים נוספים</>}
                  </button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Low Stock Alert ───────────────────────────── */}
          {data.lowStock.length > 0 && (
            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-700">
                  <AlertTriangle className="w-5 h-5" />
                  מלאי נמוך — דורש הזמנה דחופה ({data.lowStock.length} פריטים)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-red-50">
                  {data.lowStock.map((item) => (
                    <div key={item.name} className="flex items-center justify-between px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{item.name}</p>
                        <p className="text-xs text-gray-400">{item.category || 'כללי'}</p>
                      </div>
                      <Badge variant="danger">
                        {parseFloat(item.quantity).toFixed(1)} {item.unit} בלבד
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Staff Chart ───────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-purple-600" />
                עובדים מומלצים לפי יום
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={displayDays}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                  <XAxis dataKey="dayName" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 10 }} domain={[0, 'dataMax + 2']} />
                  <Tooltip
                    formatter={(val) => [`${Number(val)} עובדים`, 'מומלץ']}
                    labelFormatter={(_, p) => {
                      const d = p?.[0]?.payload as ForecastDay;
                      return d ? `${d.dayName} ${new Date(d.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}` : '';
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="recommendedStaff"
                    stroke="#8b5cf6"
                    strokeWidth={2.5}
                    dot={{ fill: '#8b5cf6', r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-xs text-center mt-2" style={{ color: '#9aa0ab' }}>
                {data?.calibratedRps
                  ? `חישוב לפי היסטוריית משמרות · ₪${data.calibratedRps.toLocaleString('he-IL')} מחזור לעובד · מינימום ${settings.minStaff} ביום`
                  : data?.staffSource === 'z_shifts'
                    ? `חישוב לפי דוחות Z היסטוריים · מינימום ${settings.minStaff} עובדים ביום`
                    : `חישוב לפי יחס סועדים · מינימום ${settings.minStaff} עובדים ביום`
                }
              </p>
            </CardContent>
          </Card>

          {/* ── Smart Order Section ──────────────────────── */}
          <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(201,162,39,0.12)' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: '#c9a227' }}>
                  <ShoppingCart className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="font-bold" style={{ color: '#e8e8e4' }}>הזמנות חכמות — לפי תחזית מנות</h2>
                  <p className="text-xs" style={{ color: '#9aa0ab' }}>כמות מדויקת לפי מתכונים, מלאי קיים ו-10% מרווח בטיחות</p>
                </div>
              </div>
              <div className="flex gap-2">
                {[3, 7, 14].map(h => (
                  <button key={h} onClick={() => setSmartHorizon(h)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                    style={smartHorizon === h ? { background: '#c9a227', color: '#0a0a0e' } : { background: '#1a1a22', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}>
                    {h} ימים
                  </button>
                ))}
              </div>
            </div>

            {smartLoading ? (
              <div className="flex items-center justify-center py-12 text-indigo-400">
                <RefreshCw className="w-6 h-6 animate-spin" />
              </div>
            ) : !smartOrder || smartOrder.orderList.length === 0 && smartOrder.insights.length <= 1 ? (
              <div className="text-center py-10" style={{ color: '#9aa0ab' }}>
                <ShoppingCart className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">אין מנות מקושרות למרכיבים — קשר מתכונים לחומרי גלם</p>
              </div>
            ) : (
              <div className="p-5 space-y-5">

                {/* AI Insights */}
                {smartOrder.insights.length > 0 && (
                  <div className="space-y-2">
                    {smartOrder.insights.map((ins, i) => {
                      const bgColor = ins.type === 'critical' ? 'rgba(239,68,68,0.08)' : ins.type === 'rising' ? 'rgba(34,197,94,0.08)' : ins.type === 'falling' ? 'rgba(245,158,11,0.08)' : ins.type === 'stock_ok' ? 'rgba(34,197,94,0.06)' : 'rgba(79,70,229,0.06)';
                      const borderColor = ins.type === 'critical' ? 'rgba(239,68,68,0.3)' : ins.type === 'rising' ? 'rgba(34,197,94,0.3)' : ins.type === 'falling' ? 'rgba(245,158,11,0.3)' : ins.type === 'stock_ok' ? 'rgba(34,197,94,0.25)' : 'rgba(79,70,229,0.15)';
                      const textColor = ins.type === 'critical' ? '#991b1b' : ins.type === 'rising' ? '#166534' : ins.type === 'falling' ? '#92400e' : ins.type === 'stock_ok' ? '#166534' : '#312e81';
                      return (
                        <div key={`${ins.type}_${ins.title}`} className="flex items-start gap-3 rounded-xl px-4 py-3"
                          style={{ background: bgColor, border: `1px solid ${borderColor}` }}>
                          <span className="text-xl flex-shrink-0">{ins.icon}</span>
                          <div>
                            <p className="text-sm font-bold" style={{ color: textColor }}>{ins.title}</p>
                            <p className="text-sm text-gray-700 mt-0.5 leading-relaxed">{ins.text}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}


                {/* Order List */}
                {smartOrder.orderList.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-bold text-gray-700">רשימת הזמנה — {smartOrder.itemsToOrder} פריטים</p>
                      {smartOrder.totalOrderCost > 0 && (
                        <span className="text-sm font-black text-indigo-700 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">
                          סה״כ ~₪{smartOrder.totalOrderCost.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      {smartOrder.orderList.map((item) => {
                        const urgencyColor = item.urgency === 'critical' ? '#dc2626' : item.urgency === 'high' ? '#d97706' : '#4f46e5';
                        const urgencyBg    = item.urgency === 'critical' ? 'rgba(239,68,68,0.06)' : item.urgency === 'high' ? 'rgba(245,158,11,0.06)' : 'white';
                        return (
                          <div key={item.name} className="flex items-center gap-3 px-4 py-3 rounded-xl"
                            style={{ background: urgencyBg, border: `1px solid ${urgencyColor}25` }}>
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: urgencyColor }} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-bold text-gray-800 truncate">{item.name}</p>
                                {item.urgency === 'critical' && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-bold flex-shrink-0">אפסי!</span>}
                                {item.urgency === 'high' && <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-bold flex-shrink-0">נמוך</span>}
                              </div>
                              <p className="text-xs text-gray-400 mt-0.5">
                                במלאי: {item.currentStock} {item.unit} · צפוי לצריכה: {item.neededForForecast.toFixed(1)} {item.unit}
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-sm font-black" style={{ color: urgencyColor }}>
                                {item.orderQty.toFixed(1)} {item.unit}
                              </p>
                              {item.estimatedCost > 0 && (
                                <p className="text-xs text-gray-400">~₪{item.estimatedCost.toFixed(0)}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Methodology note ─────────────────────────── */}
          <div className="rounded-xl p-4 text-xs leading-relaxed" style={{ background: 'rgba(255,255,255,0.12)', backdropFilter: 'blur(8px)', color: 'rgba(255,255,255,0.75)' }}>
            <p className="font-semibold mb-2" style={{ color: 'rgba(255,255,255,0.9)' }}>כיצד נבנה החיזוי?</p>
            <ul className="space-y-1">
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>היסטוריית קופה:</strong> ממוצע מכירות יומי לפי יום בשבוע — 12 חודשים אחרונים</span></li>
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>עונתיות:</strong> מכפיל חודשי לפי ביצועי כל חודש ביחס לממוצע השנתי</span></li>
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>חגים:</strong> ערב חג ×1.28 | יום חג ×0.45 — לפי לוח החגים הישראלי</span></li>
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-sky-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>מזג אוויר:</strong> גשם כבד ×0.80 | חם מאוד ×0.88 | מזג אוויר נעים ×1.08 — Open-Meteo API</span></li>
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-pink-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>סועדים:</strong> נגזר מתור שולחנות היסטורי → פירוט מנות → ₪75 לסועד (ברירת מחדל)</span></li>
              <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>עובדים:</strong> {data?.staffSource === 'shifts' ? `למידה מהיסטוריית משמרות — חציון מחזור לעובד לפי יום בשבוע${data?.calibratedRps ? ` (כ-₪${data.calibratedRps.toLocaleString('he-IL')} לעובד)` : ''}` : data?.staffSource === 'z_shifts' ? 'לפי כמות עובדים בדוחות Z היסטוריים, מתואמת למחזור הצפוי' : `1 עובד לכל ${settings.staffRatio} סועדים (ברירת מחדל — אין נתוני משמרות)`} | מינימום {settings.minStaff} ביום</span></li>
              {settings.customEvents.length > 0 && (
                <li className="flex items-start gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" /><span><strong style={{ color: 'rgba(255,255,255,0.9)' }}>אירועים מותאמים:</strong> {settings.customEvents.map(e => `${e.label} ×${e.multiplier}`).join(' | ')}</span></li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
    </div>
  );
}
