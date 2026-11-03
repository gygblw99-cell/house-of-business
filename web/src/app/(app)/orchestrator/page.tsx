'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAppSelector } from '@/hooks/useAppDispatch';
import {
  Cpu, Zap, Send, RotateCcw, TrendingDown, BarChart3,
  ChevronDown, ChevronUp, Clock, Layers, CheckCircle2,
  AlertTriangle } from 'lucide-react';
import api from '@/lib/api/client';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Stats {
  totalRequests: number;
  totalCostUsd:  string;
  costSavedUsd:  string;
  freeCount:     number;
  lowCostCount:  number;
  premiumCount:  number;
  fallbackCount: number;
  freePercent:   number;
  avgResponseMs: number;
  avgScore:      number;
  totalTokens:   number;
}

interface LogEntry {
  id:                string;
  provider_used:     string;
  tier:              string;
  score:             number;
  tokens_used:       number;
  cost_usd:          string;
  response_time_ms:  number;
  fallback_triggered: boolean;
  response:          string;
  created_at:        string;
}

interface ChatMessage {
  role:    'user' | 'assistant';
  content: string;
  meta?: {
    provider: string;
    tier: string;
    score: number;
    tokens: number;
    ms: number;
    costUsd: number;
    routing: { breakdown: Record<string, number>; reason: string };
    fallback: boolean;
  };
}

interface ModelInfo {
  id: string; name: string; provider: string; tier: string;
  costPer1kTokens: number; maxTokens: number; strengths: string[];
  color: string; icon: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const TIER_CFG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  free:      { label: 'חינם',      color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: '⚡' },
  low_cost:  { label: 'זול',       color: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200',       icon: '🔷' },
  premium:   { label: 'פרמיום',   color: 'text-violet-700',  bg: 'bg-violet-50 border-violet-200',   icon: '👑' },
};

const PROVIDER_NAME: Record<string, string> = {
  groq:   'Llama 3.3 70B',
  gemini: 'Gemini 2.0 Flash',
  claude: 'Claude Sonnet',
};

function ScoreBar({ label, val, max }: { label: string; val: number; max: number }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-xs text-[rgba(232,232,228,0.42)]">
        <span>{label}</span><span className="font-semibold text-[rgba(232,232,228,0.72)]">{val}</span>
      </div>
      <div className="h-1.5 bg-[#1a1a20] rounded-full overflow-hidden">
        <div className="h-full bg-violet-400 rounded-full transition-all" style={{ width: `${(val / max) * 100}%` }} />
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }: { icon: React.ElementType; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-4 flex items-start gap-3 shadow-sm">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-xs text-[rgba(232,232,228,0.4)]">{label}</p>
        <p className="text-xl font-bold text-[#e8e8e4] leading-tight">{value}</p>
        {sub && <p className="text-xs text-[rgba(232,232,228,0.4)] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function OrchestratorPage() {
  const router = useRouter();
  const { user } = useAppSelector((s) => s.auth);

  useEffect(() => {
    if (user && user.role !== 'owner') router.replace('/dashboard');
  }, [user, router]);

  const [stats,   setStats]   = useState<Stats | null>(null);
  const [logs,    setLogs]    = useState<LogEntry[]>([]);
  const [models,  setModels]  = useState<ModelInfo[]>([]);
  const [days,    setDays]    = useState(30);
  const [loading, setLoading] = useState(true);

  const [messages,  setMessages]  = useState<ChatMessage[]>([]);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [lastMeta,  setLastMeta]  = useState<ChatMessage['meta'] | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const beginRequest = useLatestRequest();

  const load = useCallback(async () => {
    const latest = beginRequest();
    setLoading(true);
    try {
      const [s, l, m] = await Promise.all([
        api.get(`/orchestrator/stats?days=${days}`),
        api.get('/orchestrator/logs?limit=15'),
        api.get('/orchestrator/models'),
      ]);
      latest(() => {
        setStats(s.data);
        setLogs(l.data.logs || []);
        setModels(m.data.models || []);
      });
    } catch {}
    latest(() => setLoading(false));
  }, [days, beginRequest]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setMessages(p => [...p, { role: 'user', content: text }]);

    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const { data } = await api.post('/orchestrator/execute', { message: text, history });

      const meta: ChatMessage['meta'] = {
        provider: data.provider,
        tier:     data.tier,
        score:    data.score,
        tokens:   data.tokensUsed,
        ms:       data.responseTimeMs,
        costUsd:  data.costUsd,
        routing:  data.routing,
        fallback: data.fallbackTriggered,
      };
      setLastMeta(meta);
      setMessages(p => [...p, { role: 'assistant', content: data.text, meta }]);
      // Refresh logs silently
      api.get('/orchestrator/logs?limit=15').then(r => setLogs(r.data.logs || [])).catch(() => {});
      api.get(`/orchestrator/stats?days=${days}`).then(r => setStats(r.data)).catch(() => {});
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: 'שגיאה — נסה שנית.' }]);
    }
    setSending(false);
  };

  const tierTotal = (stats?.freeCount || 0) + (stats?.lowCostCount || 0) + (stats?.premiumCount || 0) || 1;

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg">
            <Cpu className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8e4]">Orchestrator AI</h1>
            <p className="text-sm text-[rgba(232,232,228,0.4)]">ניתוב חכם — מקסימום ביצועים, מינימום עלות</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="text-sm border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400 bg-[#141418] text-[#e8e8e4]">
            <option value={7}>7 ימים</option>
            <option value={30}>30 ימים</option>
            <option value={90}>90 ימים</option>
          </select>
          <button onClick={load} className="p-2 rounded-xl border border-[rgba(201,162,39,0.14)] hover:bg-[rgba(201,162,39,0.06)] text-[rgba(232,232,228,0.42)] transition-colors">
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={BarChart3}    label="סה״כ בקשות"    value={String(stats?.totalRequests || 0)}                   color="bg-violet-100 text-violet-600" />
        <StatCard icon={TrendingDown} label="חסכון מול Claude" value={`$${parseFloat(stats?.costSavedUsd || '0').toFixed(4)}`} color="bg-emerald-100 text-emerald-600" />
        <StatCard icon={Zap}          label="בחינם"          value={`${stats?.freePercent || 0}%`}                       sub={`${stats?.freeCount || 0} בקשות`} color="bg-amber-100 text-amber-600" />
        <StatCard icon={Clock}        label="מהירות ממוצעת"  value={`${stats?.avgResponseMs || 0}ms`}                    sub={`ציון ממוצע: ${stats?.avgScore || 0}`} color="bg-blue-100 text-blue-600" />
      </div>

      {/* Model Tiers Bar */}
      <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-5 shadow-sm">
        <h2 className="text-sm font-bold text-[rgba(232,232,228,0.72)] mb-4">פילוח שימוש במודלים</h2>
        <div className="flex h-8 rounded-xl overflow-hidden gap-0.5">
          {[
            { count: stats?.freeCount || 0,     label: `⚡ Groq (Free) — ${Math.round((stats?.freeCount || 0)/tierTotal*100)}%`,     color: 'bg-emerald-400' },
            { count: stats?.lowCostCount || 0,  label: `🔷 Gemini (זול) — ${Math.round((stats?.lowCostCount || 0)/tierTotal*100)}%`, color: 'bg-blue-400'    },
            { count: stats?.premiumCount || 0,  label: `👑 Claude (פרמיום) — ${Math.round((stats?.premiumCount || 0)/tierTotal*100)}%`, color: 'bg-violet-400' },
          ].map(({ count, label, color }) => (
            <div key={label} className={`${color} flex items-center justify-center text-white text-xs font-semibold transition-all`}
              style={{ width: `${(count / tierTotal) * 100}%`, minWidth: count > 0 ? '32px' : 0 }}
              title={label}>
              {(count / tierTotal) > 0.12 && label.split(' — ')[0]}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-6 mt-3 flex-wrap">
          {[
            { icon: '⚡', label: 'Groq — חינם',       color: 'text-emerald-600', count: stats?.freeCount || 0 },
            { icon: '🔷', label: 'Gemini — זול',       color: 'text-blue-600',    count: stats?.lowCostCount || 0 },
            { icon: '👑', label: 'Claude — פרמיום',    color: 'text-violet-600',  count: stats?.premiumCount || 0 },
          ].map(({ icon, label, color, count }) => (
            <div key={label} className="flex items-center gap-1.5 text-sm">
              <span>{icon}</span>
              <span className={`font-semibold ${color}`}>{label}</span>
              <span className="text-[rgba(232,232,228,0.4)]">({count})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main: Chat + Routing Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* Chat */}
        <div className="lg:col-span-3 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm flex flex-col" style={{ height: '520px' }}>
          <div className="px-4 py-3 border-b border-[rgba(201,162,39,0.14)] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-violet-400" />
            <span className="font-semibold text-sm text-[rgba(232,232,228,0.72)]">נסה את המנוע</span>
            <span className="text-xs text-[rgba(232,232,228,0.4)] mr-auto">ניתוב אוטומטי למודל הזול ביותר המתאים</span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-900/40 to-indigo-900/40 flex items-center justify-center">
                  <Cpu className="w-7 h-7 text-violet-500" />
                </div>
                <div>
                  <p className="font-semibold text-[rgba(232,232,228,0.72)]">Orchestrator AI מוכן</p>
                  <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1">כתוב כל שאלה — המנוע יחליט באיזה מודל להשתמש</p>
                </div>
                <div className="flex flex-wrap gap-2 justify-center mt-2">
                  {['מה הרווח הממוצע שלי?', 'כתוב לי תפריט ל-10 מנות', 'תנתח את ביצועי המשמרות'].map(q => (
                    <button key={q} onClick={() => setInput(q)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors border border-violet-100">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-[#1a1a20] border border-[rgba(201,162,39,0.14)] text-[#e8e8e4]'
                    : 'bg-gradient-to-br from-violet-500 to-indigo-500 text-white'
                }`}>
                  <p className="whitespace-pre-wrap">{m.content}</p>
                  {m.meta && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/20 text-xs opacity-80">
                      <span>{TIER_CFG[m.meta.tier]?.icon} {PROVIDER_NAME[m.meta.provider] || m.meta.provider}</span>
                      <span>·</span>
                      <span>{m.meta.ms}ms</span>
                      <span>·</span>
                      <span>${m.meta.costUsd.toFixed(6)}</span>
                      {m.meta.fallback && <span className="text-yellow-200">⚠ fallback</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-end">
                <div className="bg-gradient-to-br from-violet-500 to-indigo-500 text-white rounded-2xl px-4 py-2.5 text-sm">
                  <span className="animate-pulse">המנוע חושב...</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="p-3 border-t border-[rgba(201,162,39,0.14)] flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
              placeholder="שאל כל שאלה..."
              className="flex-1 border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-[#0f0f14] text-[#e8e8e4]"
            />
            <button onClick={send} disabled={sending || !input.trim()}
              className="w-9 h-9 rounded-xl bg-violet-600 hover:bg-violet-700 text-white flex items-center justify-center disabled:opacity-40 transition-colors flex-shrink-0">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Routing Decision Panel */}
        <div className="lg:col-span-2 space-y-3">

          {/* Last routing decision */}
          <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-4 shadow-sm">
            <h3 className="text-sm font-bold text-[rgba(232,232,228,0.72)] mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-violet-400" /> החלטת ניתוב אחרונה
            </h3>
            {lastMeta ? (
              <div className="space-y-3">
                <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${TIER_CFG[lastMeta.tier]?.bg}`}>
                  <span className="text-xl">{TIER_CFG[lastMeta.tier]?.icon}</span>
                  <div>
                    <p className={`font-bold text-sm ${TIER_CFG[lastMeta.tier]?.color}`}>{PROVIDER_NAME[lastMeta.provider] || lastMeta.provider}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.4)]">{TIER_CFG[lastMeta.tier]?.label} · ציון {lastMeta.score}/100</p>
                  </div>
                  {lastMeta.fallback && (
                    <span className="mr-auto text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">fallback</span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: 'זמן', value: `${lastMeta.ms}ms` },
                    { label: 'טוקנים', value: String(lastMeta.tokens) },
                    { label: 'עלות', value: `$${lastMeta.costUsd.toFixed(5)}` },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-[#1a1a20] rounded-xl p-2">
                      <p className="text-xs text-[rgba(232,232,228,0.4)]">{label}</p>
                      <p className="text-sm font-bold text-[#e8e8e4]">{value}</p>
                    </div>
                  ))}
                </div>

                <button onClick={() => setShowBreakdown(v => !v)}
                  className="w-full flex items-center justify-between text-xs text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.7)] px-1">
                  <span>פירוט ניקוד</span>
                  {showBreakdown ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>

                {showBreakdown && lastMeta.routing?.breakdown && (
                  <div className="space-y-2 pt-1">
                    {Object.entries(lastMeta.routing.breakdown).map(([k, v]) => (
                      <ScoreBar key={k} label={k.replace(/([A-Z])/g,' $1').toLowerCase()} val={Number(v)} max={25} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-6 text-[rgba(232,232,228,0.4)] text-sm">שלח הודעה כדי לראות ניתוב</div>
            )}
          </div>

          {/* Models */}
          <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] p-4 shadow-sm">
            <h3 className="text-sm font-bold text-[rgba(232,232,228,0.72)] mb-3">מודלים זמינים</h3>
            <div className="space-y-2">
              {models.map(m => (
                <div key={m.id} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-[#1a1a20]">
                  <span className="text-lg">{m.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-[rgba(232,232,228,0.72)]">{m.name}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.4)]">{m.provider}</p>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TIER_CFG[m.tier]?.bg} ${TIER_CFG[m.tier]?.color}`}>
                    {m.costPer1kTokens === 0 ? 'חינם' : `$${m.costPer1kTokens}/1k`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Recent Logs Table */}
      <div className="bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)] shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-[rgba(201,162,39,0.14)] flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-violet-400" />
          <h2 className="font-bold text-sm text-[rgba(232,232,228,0.72)]">היסטוריית ניתובים</h2>
        </div>
        {loading ? (
          <div className="text-center py-8 text-[rgba(232,232,228,0.4)] text-sm">טוען...</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-[rgba(232,232,228,0.4)]">
            <Cpu className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>עדיין אין ניתובים — שלח את הבקשה הראשונה</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#111116] text-xs text-[rgba(232,232,228,0.42)]">
                  <th className="px-4 py-2.5 text-right font-semibold">מודל</th>
                  <th className="px-4 py-2.5 text-right font-semibold">שכבה</th>
                  <th className="px-4 py-2.5 text-right font-semibold">ציון</th>
                  <th className="px-4 py-2.5 text-right font-semibold">טוקנים</th>
                  <th className="px-4 py-2.5 text-right font-semibold">עלות</th>
                  <th className="px-4 py-2.5 text-right font-semibold">זמן</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Fallback</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                {logs.map(log => {
                  const tc = TIER_CFG[log.tier] || TIER_CFG.free;
                  return (
                    <tr key={log.id} className="hover:bg-[rgba(201,162,39,0.04)] transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 font-semibold text-[rgba(232,232,228,0.72)]">
                          <span>{tc.icon}</span>
                          {PROVIDER_NAME[log.provider_used] || log.provider_used}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${tc.bg} ${tc.color}`}>{tc.label}</span>
                      </td>
                      <td className="px-4 py-2.5 text-[rgba(232,232,228,0.6)] font-mono">{log.score}</td>
                      <td className="px-4 py-2.5 text-[rgba(232,232,228,0.6)] font-mono">{log.tokens_used}</td>
                      <td className="px-4 py-2.5 text-[rgba(232,232,228,0.6)] font-mono">${parseFloat(log.cost_usd).toFixed(6)}</td>
                      <td className="px-4 py-2.5 text-[rgba(232,232,228,0.6)]">{log.response_time_ms}ms</td>
                      <td className="px-4 py-2.5">
                        {log.fallback_triggered
                          ? <AlertTriangle className="w-4 h-4 text-amber-500" />
                          : <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
