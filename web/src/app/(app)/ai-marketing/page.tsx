'use client';

import { useState, useRef } from 'react';
import {
  ExternalLink, Instagram, Youtube, Facebook, MessageCircle, Image, BarChart2, CalendarDays, Search, Star, Video, Sparkles, Copy, Check, X, Loader2, Paperclip, FileText,
  Megaphone, Percent, TrendingUp, Flame, Target, Lightbulb,
} from 'lucide-react';
import api from '@/lib/api/client';
import { aiApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';

interface Tool {
  name: string;
  desc: string;
  url: string;
  color: string;
  icon: React.ElementType;
}

// ── AI Marketing Advisor — action types ─────────────────────
interface MarketingAction {
  id: string;
  label: string;
  desc: string;
  icon: React.ElementType;
}

const MARKETING_ACTIONS: MarketingAction[] = [
  { id: 'viral_post',        label: 'פוסט לפרסם עכשיו',      desc: 'המלצה מבוססת נתונים לפוסט הבא שלך',   icon: Megaphone },
  { id: 'marketing_image',   label: 'תמונה שיווקית',          desc: 'כיוון ויזואלי לתמונה שתמכור',          icon: Image },
  { id: 'viral_video',       label: 'וידאו קצר',              desc: 'רעיונות לווידאו שתצלם בסמארטפון',      icon: Video },
  { id: 'smart_promotion',   label: 'מבצע חכם',               desc: 'מבצע שממלא שעות חלשות',                icon: Percent },
  { id: 'analyze_marketing', label: 'ניתוח שיווקי',           desc: 'הזדמנויות שמפוספסות עכשיו',            icon: BarChart2 },
  { id: 'weekly_campaign',   label: 'קמפיין שבועי',           desc: 'תוכנית תוכן לשבוע הקרוב',              icon: CalendarDays },
  { id: 'trending_ideas',    label: 'רעיונות טרנדיים',        desc: 'טרנדים שמתאימים לעסק שלך',             icon: TrendingUp },
  { id: 'viral_content',     label: 'התוכן הכי חזק עכשיו',    desc: 'ההזדמנות הבודדת עם הפוטנציאל הגבוה',   icon: Flame },
];

const PRIORITY_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  high:   { label: 'עדיפות גבוהה', bg: 'rgba(239,68,68,0.15)',  color: '#f87171' },
  medium: { label: 'עדיפות בינונית', bg: 'rgba(245,158,11,0.15)', color: '#fbbf24' },
  low:    { label: 'עדיפות נמוכה', bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
};

const PLATFORM_ICON: Record<string, React.ElementType> = {
  instagram: Instagram, tiktok: Video, facebook: Facebook, whatsapp: MessageCircle, google: Search,
};

interface MarketingRecommendation {
  title: string; why: string; content_idea: string; platform: string;
  posting_time: string; priority: 'high' | 'medium' | 'low';
  tool_name: string; tool_url: string; tool_reason: string;
}
interface MarketingResult {
  campaign_type: string; audience: string; summary: string;
  recommendations: MarketingRecommendation[]; quick_wins: string[]; action: string;
  context_snapshot?: { business_name: string; revenue_30d: number; top_dish: string; peak_hour: string };
}

const TOOLS = [
  {
    category: 'עיצוב ויזואלי',
    items: [
      { name: 'Canva', desc: 'עיצוב פוסטים, סטוריז ופלאיירים — חינם', url: 'https://www.canva.com', color: '#00c4cc', icon: Image },
      { name: 'Adobe Express', desc: 'עיצוב מהיר עם תבניות מוכנות', url: 'https://express.adobe.com', color: '#ff0000', icon: Image },
    ],
  },
  {
    category: 'סושיאל מדיה',
    items: [
      { name: 'Meta Business Suite', desc: 'ניהול פוסטים ב-Facebook ו-Instagram', url: 'https://business.facebook.com', color: '#1877f2', icon: Facebook },
      { name: 'Instagram Creator Studio', desc: 'תזמון תוכן ב-Instagram', url: 'https://www.instagram.com/creator/studio', color: '#e1306c', icon: Instagram },
      { name: 'TikTok for Business', desc: 'העלאת ריילס וטיקטוק לעסקים', url: 'https://www.tiktok.com/business', color: '#010101', icon: Video },
      { name: 'YouTube Studio', desc: 'ניהול ערוץ YouTube', url: 'https://studio.youtube.com', color: '#ff0000', icon: Youtube },
    ],
  },
  {
    category: 'הודעות ותקשורת',
    items: [
      { name: 'WhatsApp Business', desc: 'שליחת הודעות שיווקיות ללקוחות', url: 'https://business.whatsapp.com', color: '#25d366', icon: MessageCircle },
      { name: 'Wix Email Marketing', desc: 'שליחת ניוזלטר ללקוחות', url: 'https://www.wix.com/email-marketing', color: '#faad00', icon: MessageCircle },
    ],
  },
  {
    category: 'ניהול ותזמון תוכן',
    items: [
      { name: 'Buffer', desc: 'תזמון פוסטים לכל הרשתות ממקום אחד', url: 'https://buffer.com', color: '#168eea', icon: CalendarDays },
      { name: 'Later', desc: 'תכנון לוח שנה ויזואלי לתוכן', url: 'https://later.com', color: '#5c6bc0', icon: CalendarDays },
    ],
  },
  {
    category: 'קידום אורגני ותשלום',
    items: [
      { name: 'Google My Business', desc: 'עדכון הפרופיל בגוגל מפות וחיפוש', url: 'https://business.google.com', color: '#4285f4', icon: Search },
      { name: 'Google Ads', desc: 'קמפיין ממומן בגוגל', url: 'https://ads.google.com', color: '#fbbc04', icon: BarChart2 },
      { name: 'Meta Ads Manager', desc: 'קמפיין ממומן ב-Facebook/Instagram', url: 'https://www.facebook.com/adsmanager', color: '#1877f2', icon: BarChart2 },
    ],
  },
  {
    category: 'ביקורות ומוניטין',
    items: [
      { name: 'Google Reviews', desc: 'ניהול ביקורות גוגל של העסק', url: 'https://business.google.com', color: '#34a853', icon: Star },
      { name: 'Wolt for Restaurants', desc: 'ניהול פרופיל Wolt', url: 'https://wolt.com/en/partners', color: '#009de0', icon: Star },
    ],
  },
];

const ACCEPTED = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt';

export default function AIMarketingPage() {
  const { toast } = useAppDialog();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── AI Marketing Advisor state ──
  const [selectedAction, setSelectedAction]     = useState<MarketingAction | null>(null);
  const [extraContext, setExtraContext]         = useState('');
  const [marketingResult, setMarketingResult]   = useState<MarketingResult | null>(null);
  const [marketingGenerating, setMarketingGenerating] = useState(false);
  const [marketingError, setMarketingError]     = useState('');

  const [selectedTool, setSelectedTool]       = useState<Tool | null>(null);
  const [userRequest, setUserRequest]         = useState('');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [generating, setGenerating]           = useState(false);
  const [copied, setCopied]                   = useState(false);
  const [attachedFile, setAttachedFile]       = useState<File | null>(null);
  const [previewUrl, setPreviewUrl]           = useState<string | null>(null);

  const openTool = (tool: Tool) => {
    setSelectedTool(tool);
    setUserRequest('');
    setGeneratedPrompt('');
    setAttachedFile(null);
    // Revoke before dropping the reference — switching straight from one tool
    // to another with an image attached skipped close()/removeFile() and
    // leaked the object URL for the lifetime of the page.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  };

  const close = () => {
    setSelectedTool(null);
    setUserRequest('');
    setGeneratedPrompt('');
    setAttachedFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  };

  const handleFileSelect = (file: File) => {
    setAttachedFile(file);
    if (file.type.startsWith('image/')) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }
  };

  const removeFile = () => {
    setAttachedFile(null);
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const generatePrompt = async () => {
    if (!userRequest.trim() || !selectedTool) return;
    setGenerating(true);
    setGeneratedPrompt('');
    try {
      let data;
      if (attachedFile) {
        const fd = new FormData();
        fd.append('file', attachedFile);
        fd.append('tool', selectedTool.name);
        fd.append('toolDesc', selectedTool.desc);
        fd.append('userRequest', userRequest.trim());
        // Backend allows up to 55s for this (AI_TIMEOUT_MS in ai.routes.js)
        ({ data } = await api.post('/ai/marketing-prompt', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60_000 }));
      } else {
        ({ data } = await api.post('/ai/marketing-prompt', { tool: selectedTool.name, toolDesc: selectedTool.desc, userRequest: userRequest.trim() }, { timeout: 60_000 }));
      }
      setGeneratedPrompt(data.prompt || '');
    } catch (err) {
      // The server sends actionable Hebrew messages here — the daily AI budget
      // being spent, a file whose contents don't match its extension, a
      // timeout. Collapsing them all into one generic string left the user with
      // no idea which of those happened, or whether retrying would help.
      toast(getErrorMessage(err), 'error');
    }
    setGenerating(false);
  };

  const copyPrompt = async () => {
    // writeText rejects on an insecure origin or a denied permission. The
    // rejection was unhandled, and "הועתק!" was shown either way — so a failed
    // copy looked identical to a successful one and the user pasted nothing.
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('העתקה נכשלה — סמן את הטקסט והעתק ידנית', 'error');
    }
  };

  // ── AI Marketing Advisor ──
  const runMarketingAction = async (action: MarketingAction) => {
    setSelectedAction(action);
    setMarketingResult(null);
    setMarketingError('');
    setMarketingGenerating(true);
    try {
      const { data } = await aiApi.marketing(action.id, extraContext.trim() ? { extra: extraContext.trim() } : undefined);
      setMarketingResult(data);
    } catch (err) {
      setMarketingError(getErrorMessage(err));
    } finally {
      setMarketingGenerating(false);
    }
  };

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="rounded-2xl px-6 py-5 text-white"
        style={{ background: 'linear-gradient(145deg,#0a0a0e,#141418)', border: '1px solid rgba(201,162,39,0.2)' }}>
        <h1 className="text-2xl font-black flex items-center gap-2">
          שיווק דיגיטלי
        </h1>
        <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
          בחר כלי ← כתוב מה אתה רוצה ← קבל פרומפט מקצועי מהבינה המלאכותית
        </p>
      </div>

      {/* AI Marketing Advisor */}
      <div className="rounded-2xl p-5" style={{ background: '#141418', border: '1px solid rgba(124,58,237,0.25)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-5 h-5" style={{ color: '#a78bfa' }} />
          <h2 className="text-lg font-black text-[#e8e8e4]">יועץ שיווק AI</h2>
        </div>
        <p className="text-xs mb-4" style={{ color: 'rgba(232,232,228,0.5)' }}>
          המלצות שיווק מבוססות על נתוני העסק שלך בזמן אמת — מכירות, שעות שיא, מנות מובילות ומלאי
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
          {MARKETING_ACTIONS.map(action => {
            const Icon = action.icon;
            const active = selectedAction?.id === action.id;
            return (
              <button
                key={action.id}
                onClick={() => runMarketingAction(action)}
                disabled={marketingGenerating}
                className="flex flex-col items-start gap-1.5 p-3 rounded-xl text-right transition-all disabled:opacity-50"
                style={active
                  ? { background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.5)' }
                  : { background: '#1a1a20', border: '1px solid rgba(201,162,39,0.14)' }}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: active ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)' }}>
                  {marketingGenerating && active
                    ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#a78bfa' }} />
                    : <Icon className="w-4 h-4" style={{ color: '#a78bfa' }} />}
                </div>
                <p className="text-sm font-bold text-[#e8e8e4]">{action.label}</p>
                <p className="text-xs leading-snug" style={{ color: 'rgba(232,232,228,0.45)' }}>{action.desc}</p>
              </button>
            );
          })}
        </div>

        <input
          type="text"
          value={extraContext}
          onChange={e => setExtraContext(e.target.value)}
          maxLength={200}
          placeholder="הקשר נוסף (אופציונלי) — לדוג': יש לי אירוע מיוחד בסוף השבוע..."
          className="w-full border border-[rgba(201,162,39,0.14)] bg-[#1a1a20] text-[#e8e8e4] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 mb-4"
        />

        {marketingError && (
          <div className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl mb-4"
            style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171' }}>
            {marketingError}
          </div>
        )}

        {marketingGenerating && !marketingResult && (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#a78bfa' }} />
            <p className="text-sm" style={{ color: 'rgba(232,232,228,0.5)' }}>מנתח נתוני עסק ובונה המלצות...</p>
          </div>
        )}

        {marketingResult && (
          <div className="space-y-4">
            <div className="rounded-xl p-4" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)' }}>
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4" style={{ color: '#a78bfa' }} />
                <span className="text-xs font-bold" style={{ color: '#a78bfa' }}>{marketingResult.audience || 'קהל היעד'}</span>
              </div>
              <p className="text-sm leading-relaxed text-[#e8e8e4]">{marketingResult.summary}</p>
            </div>

            {marketingResult.quick_wins.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold text-emerald-400">לביצוע מיידי (פחות מ-10 דקות)</span>
                </div>
                <ul className="space-y-1.5">
                  {marketingResult.quick_wins.map((w, i) => (
                    <li key={i} className="text-sm text-[#e8e8e4] flex items-start gap-2">
                      <span className="text-emerald-400 mt-0.5">✓</span> {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2.5">
              {marketingResult.recommendations.map((rec, i) => {
                const PIcon = PLATFORM_ICON[rec.platform?.toLowerCase()] || Sparkles;
                const pr = PRIORITY_STYLE[rec.priority] || PRIORITY_STYLE.medium;
                return (
                  <div key={i} className="rounded-xl p-4" style={{ background: '#1a1a20', border: '1px solid rgba(201,162,39,0.14)' }}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-bold text-sm text-[#e8e8e4]">{rec.title}</p>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: pr.bg, color: pr.color }}>
                        {pr.label}
                      </span>
                    </div>
                    {rec.why && <p className="text-xs mb-2" style={{ color: 'rgba(232,232,228,0.55)' }}>{rec.why}</p>}
                    {rec.content_idea && (
                      <p className="text-sm mb-3 p-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', color: 'rgba(232,232,228,0.85)' }}>
                        {rec.content_idea}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: 'rgba(232,232,228,0.5)' }}>
                      {rec.platform && (
                        <span className="flex items-center gap-1"><PIcon className="w-3.5 h-3.5" /> {rec.platform}</span>
                      )}
                      {rec.posting_time && <span>🕒 {rec.posting_time}</span>}
                      {rec.tool_name && (
                        rec.tool_url ? (
                          <a href={rec.tool_url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-purple-400 hover:text-purple-300" style={{ textDecoration: 'none' }}>
                            <ExternalLink className="w-3.5 h-3.5" /> {rec.tool_name}
                          </a>
                        ) : (
                          <span className="flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> {rec.tool_name}</span>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {marketingResult.context_snapshot && (
              <p className="text-xs text-center pt-1" style={{ color: 'rgba(232,232,228,0.35)' }}>
                מבוסס על נתוני {marketingResult.context_snapshot.business_name} · מחזור 30 יום: ₪{Math.round(marketingResult.context_snapshot.revenue_30d).toLocaleString()}
                {marketingResult.context_snapshot.top_dish !== '—' && ` · מנה מובילה: ${marketingResult.context_snapshot.top_dish}`}
                {marketingResult.context_snapshot.peak_hour !== '—' && ` · שעת שיא: ${marketingResult.context_snapshot.peak_hour}`}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Tool categories */}
      <div className="space-y-6">
        {TOOLS.map(cat => (
          <div key={cat.category}>
            <p className="text-sm font-black uppercase tracking-widest mb-3" style={{ color: 'rgba(201,162,39,0.75)', letterSpacing: '0.1em' }}>{cat.category}</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {cat.items.map(tool => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.name}
                    onClick={() => openTool(tool)}
                    className="flex items-center gap-3 bg-[#141418] rounded-xl p-4 border border-[rgba(201,162,39,0.14)] shadow-sm hover:shadow-md transition-all group text-right"
                  >
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: tool.color + '22' }}>
                      <Icon style={{ width: 22, height: 22, color: tool.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[15px]"
                        style={{ color: '#ffffff', letterSpacing: '0.01em', WebkitFontSmoothing: 'antialiased' }}>{tool.name}</p>
                      <p className="text-xs leading-snug mt-0.5"
                        style={{ color: 'rgba(232,232,228,0.55)' }}>{tool.desc}</p>
                    </div>
                    <Sparkles className="w-4 h-4 text-slate-500 group-hover:text-purple-400 flex-shrink-0 transition-colors" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Prompt Generator Panel */}
      {selectedTool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={close} />
          <div className="relative bg-[#141418] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-[rgba(201,162,39,0.14)]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ background: selectedTool.color + '18' }}>
                  <selectedTool.icon style={{ width: 20, height: 20, color: selectedTool.color }} />
                </div>
                <div>
                  <p className="font-bold text-[#e8e8e4]">{selectedTool.name}</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)]">{selectedTool.desc}</p>
                </div>
              </div>
              <button onClick={close} className="p-1.5 rounded-xl hover:bg-[rgba(201,162,39,0.06)] text-[rgba(232,232,228,0.42)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* User input */}
              <div>
                <label className="text-sm font-semibold text-[rgba(232,232,228,0.72)] mb-2 block">
                  מה אתה רוצה ליצור?
                </label>
                <textarea
                  value={userRequest}
                  onChange={e => setUserRequest(e.target.value)}
                  placeholder={`לדוג': פלאייר לאירוע שישי מיוחד עם הנחה של 20%, שיהיה צבעוני ומזמין...`}
                  rows={3}
                  className="w-full border border-[rgba(201,162,39,0.14)] bg-[#1a1a20] text-[#e8e8e4] rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
                />
              </div>

              {/* File attachment */}
              <div>
                <label className="text-xs font-semibold text-[rgba(232,232,228,0.5)] mb-2 block flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5" />
                  צרף קובץ לפרומפט מדויק יותר
                  <span className="font-normal opacity-70">(תמונה, לוגו, עיצוב, PDF — אופציונלי)</span>
                </label>

                {attachedFile ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[rgba(124,58,237,0.3)] bg-[rgba(124,58,237,0.07)]">
                    {previewUrl ? (
                      <img src={previewUrl} alt="תצוגה מקדימה" className="w-12 h-12 object-cover rounded-lg flex-shrink-0" />
                    ) : (
                      <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 bg-[rgba(124,58,237,0.15)]">
                        <FileText className="w-5 h-5 text-purple-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#e8e8e4] truncate">{attachedFile.name}</p>
                      <p className="text-xs text-[rgba(232,232,228,0.42)]">{(attachedFile.size / 1024).toFixed(0)} KB · הקובץ ישתמש לייצור הפרומפט</p>
                    </div>
                    <button onClick={removeFile} className="p-1.5 rounded-lg hover:bg-red-500/15 transition-colors flex-shrink-0" title="הסר קובץ">
                      <X className="w-4 h-4 text-red-400" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed text-sm text-[rgba(232,232,228,0.45)] hover:text-[rgba(232,232,228,0.75)] hover:border-[rgba(124,58,237,0.5)] transition-colors"
                    style={{ borderColor: 'rgba(201,162,39,0.2)', background: 'rgba(124,58,237,0.04)' }}
                  >
                    <Paperclip className="w-4 h-4" />
                    לחץ לצירוף קובץ (תמונה / PDF / מסמך)
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED}
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
                />
              </div>

              <button
                onClick={generatePrompt}
                disabled={!userRequest.trim() || generating}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#2d1b69)' }}>
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {generating ? 'מייצר פרומפט...' : attachedFile ? 'צור פרומפט עם הקובץ' : 'צור פרומפט מקצועי'}
              </button>

              {/* Generated prompt */}
              {generatedPrompt && (
                <div className="bg-purple-50 border border-purple-100 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-purple-700 flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" /> פרומפט מקצועי — העתק והכנס לתוך {selectedTool.name}
                    </p>
                    <button onClick={copyPrompt} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-semibold"
                      style={{ background: copied ? '#22c55e' : '#7c3aed', color: '#fff' }}>
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'הועתק!' : 'העתק'}
                    </button>
                  </div>
                  <p className="text-sm text-[rgba(232,232,228,0.72)] whitespace-pre-wrap leading-relaxed">{generatedPrompt}</p>
                </div>
              )}

              {/* Open tool button */}
              <a
                href={selectedTool.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold border border-[rgba(201,162,39,0.14)] text-[rgba(232,232,228,0.72)] hover:bg-[rgba(201,162,39,0.06)] transition-colors"
                style={{ textDecoration: 'none' }}>
                <ExternalLink className="w-4 h-4" />
                פתח {selectedTool.name}
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
