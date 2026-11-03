'use client';
import { adminFetch } from '@/lib/adminClient';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  ShieldCheck, ShieldAlert, ShieldX, RefreshCw, CheckCircle2,
  XCircle, AlertTriangle, Server, Zap,
  ChevronDown, ChevronUp, Eye, Play, X, Wrench, Loader2,
} from 'lucide-react';
import type { GuardianIncident, HealthSummary, FixResult } from '@/lib/api/guardian';
import { useLatestRequest } from '@/hooks/useLatestRequest';


function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Config ──────────────────────────────────────────────────────────────────────

const SEVERITY_CONFIG = {
  critical: { icon: XCircle,       color: 'text-red-600',    bg: 'bg-red-50',    border: 'border-red-200',   label: 'קריטי',  dot: 'bg-red-500'    },
  high:     { icon: AlertTriangle, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200',label: 'גבוה',   dot: 'bg-orange-500' },
  medium:   { icon: AlertTriangle, color: 'text-yellow-600', bg: 'bg-yellow-50', border: 'border-yellow-200',label: 'בינוני', dot: 'bg-yellow-500' },
  low:      { icon: CheckCircle2,  color: 'text-blue-600',   bg: 'bg-blue-50',   border: 'border-blue-200',  label: 'נמוך',   dot: 'bg-blue-400'   },
} as const;

// מפתחות ה-KPI (קריטי/גבוה/בינוני/נמוך) חייבים להתאים בדיוק לערכי severity באנגלית
// שהשרת מצפה להם ב-GET /guardian/incidents?severity= — לא לתווית העברית עצמה.
const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

const STATUS_SERVICE = {
  healthy:  { color: 'text-emerald-600', bg: 'bg-emerald-100', label: 'תקין',  dot: 'bg-emerald-500' },
  degraded: { color: 'text-yellow-600',  bg: 'bg-yellow-100',  label: 'מושפע', dot: 'bg-yellow-500'  },
  down:     { color: 'text-red-600',     bg: 'bg-red-100',     label: 'מושבת', dot: 'bg-red-500'     },
} as const;

const INCIDENT_FILTER_TABS = [
  { key: 'open',         label: 'פתוחים' },
  { key: 'acknowledged', label: 'בטיפול' },
  { key: 'resolved',     label: 'נפתרו'  },
  { key: 'all',          label: 'הכל'    },
];

// ── Sub-components ──────────────────────────────────────────────────────────────

function OverallStatusBadge({ status }: { status: string }) {
  if (status === 'healthy')  return <span className="flex items-center gap-1.5 text-emerald-600 font-semibold text-sm"><span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />מערכת תקינה</span>;
  if (status === 'degraded') return <span className="flex items-center gap-1.5 text-yellow-600 font-semibold text-sm"><span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />ביצועים מושפעים</span>;
  if (status === 'unknown')  return <span className="flex items-center gap-1.5 text-[rgba(232,232,228,0.4)] font-semibold text-sm"><span className="w-2 h-2 rounded-full bg-gray-500" />לא ניתן לבדוק מצב</span>;
  return <span className="flex items-center gap-1.5 text-red-600 font-bold text-sm"><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />מערכת מושבתת</span>;
}

function FixModal({ result, onClose }: { result: FixResult; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-[#141418] rounded-2xl shadow-2xl w-full max-w-md border border-[rgba(201,162,39,0.16)]" dir="rtl">
        <div className="flex items-center justify-between p-4 border-b border-[rgba(201,162,39,0.14)]">
          <div className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-emerald-400" />
            <span className="font-bold text-[#e8e8e4]">תוצאות טיפול בתקלה</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[rgba(201,162,39,0.06)]"><X className="w-4 h-4 text-[rgba(232,232,228,0.4)]" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className={`p-3 rounded-xl text-sm font-medium ${result.auto_resolved ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-blue-50 text-blue-800 border border-blue-200'}`}>
            {result.auto_resolved ? '✅ ' : 'ℹ️ '}{result.summary}
          </div>
          <div className="space-y-2">
            {result.steps.map((step, i) => (
              <div key={i} className={`flex gap-3 p-3 rounded-xl border text-sm ${
                step.status === 'done'    ? 'bg-emerald-900/20 border-emerald-700/40' :
                step.status === 'failed'  ? 'bg-red-900/20 border-red-700/40' :
                                            'bg-[#1a1a20] border-[rgba(201,162,39,0.14)]'
              }`}>
                <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold text-white mt-0.5"
                  style={{ background: step.status === 'done' ? '#059669' : step.status === 'failed' ? '#dc2626' : '#4a5568' }}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-[rgba(232,232,228,0.72)]">{step.action}</p>
                  {step.result && <p className="text-xs text-[rgba(232,232,228,0.4)] mt-0.5">{step.result}</p>}
                  {step.status === 'pending' && <p className="text-xs text-[rgba(232,232,228,0.4)] mt-0.5">⏳ דרוש טיפול ידני</p>}
                  {step.command && (
                    <code className="text-xs bg-slate-800 text-green-400 px-2 py-0.5 rounded mt-1 block font-mono">{step.command}</code>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-[rgba(232,232,228,0.4)] pt-1">
            <span>רמת סיכון: <span className={result.risk_level === 'high' ? 'text-red-500 font-semibold' : result.risk_level === 'medium' ? 'text-amber-500 font-semibold' : 'text-emerald-500 font-semibold'}>{result.risk_level === 'high' ? 'גבוה' : result.risk_level === 'medium' ? 'בינוני' : 'נמוך'}</span></span>
            {result.auto_resolved && <span className="text-emerald-600 font-semibold">התקלה סומנה כמטופלת</span>}
          </div>
        </div>
        <div className="p-4 border-t border-[rgba(201,162,39,0.14)]">
          <button onClick={onClose} className="w-full py-2 rounded-xl bg-[#1a1a20] text-[rgba(232,232,228,0.72)] font-medium text-sm hover:bg-[rgba(201,162,39,0.06)]">סגור</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function IncidentCard({ incident, onAck, onResolve }: {
  incident:  GuardianIncident;
  onAck:     (id: string) => void;
  onResolve: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fixing,   setFixing]   = useState(false);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fixError,  setFixError]  = useState('');
  const cfg  = SEVERITY_CONFIG[incident.severity] ?? SEVERITY_CONFIG.medium;
  const Icon = cfg.icon;

  const handleFix = async () => {
    if (!confirm('להריץ תיקון אוטומטי לתקלה זו? הפעולה עשויה לשנות נתונים בעסק החי.')) return;
    setFixing(true);
    setFixError('');
    try {
      const res = await adminFetch(`/guardian/incidents/${incident.id}/fix`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'שגיאה בטיפול בתקלה');
      const data = await res.json();
      setFixResult(data);
      if (data.auto_resolved) onAck(incident.id);
    } catch (err) { setFixError(err instanceof Error ? err.message : 'שגיאה בטיפול בתקלה'); }
    setFixing(false);
  };

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} transition-all`}>
      <div className="flex items-start gap-3 p-4">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 bg-[#1a1a20]">
          <Icon className={`w-4 h-4 ${cfg.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${cfg.dot}`}>{cfg.label}</span>
            {incident.feature && <span className="text-xs text-[rgba(232,232,228,0.4)] bg-[rgba(201,162,39,0.08)] px-2 py-0.5 rounded-full">{incident.feature}</span>}
            {incident.occurrence_count > 1 && (
              <span className="text-xs text-[rgba(232,232,228,0.4)] bg-[rgba(201,162,39,0.08)] px-2 py-0.5 rounded-full">×{incident.occurrence_count}</span>
            )}
            <span className="text-xs text-[rgba(232,232,228,0.4)] mr-auto">{formatDateTime(incident.last_seen_at)}</span>
          </div>
          <p className="text-sm font-semibold text-[#e8e8e4] break-words">{incident.issue_summary}</p>
          {incident.root_cause_analysis && (
            <p className="text-xs text-[rgba(232,232,228,0.6)] mt-1 line-clamp-2">{incident.root_cause_analysis}</p>
          )}
        </div>
        <button onClick={() => setExpanded(v => !v)} className="p-1 rounded text-[rgba(232,232,228,0.4)] hover:text-[rgba(232,232,228,0.7)] flex-shrink-0">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-[rgba(201,162,39,0.14)] pt-3">
          {incident.technical_details && (
            <div>
              <p className="text-xs font-semibold text-[rgba(232,232,228,0.4)] mb-1">פרטים טכניים</p>
              <pre className="text-xs text-[rgba(232,232,228,0.6)] bg-[#0f0f14] p-2 rounded-lg overflow-x-auto whitespace-pre-wrap">{incident.technical_details}</pre>
            </div>
          )}
          {incident.user_impact && (
            <div>
              <p className="text-xs font-semibold text-[rgba(232,232,228,0.4)] mb-1">השפעה על משתמשים</p>
              <p className="text-sm text-[rgba(232,232,228,0.72)]">{incident.user_impact}</p>
            </div>
          )}
          {incident.recommended_fix && (
            <div>
              <p className="text-xs font-semibold text-[rgba(232,232,228,0.4)] mb-1">תיקון מומלץ</p>
              <p className="text-sm text-[rgba(232,232,228,0.72)]">{incident.recommended_fix}</p>
            </div>
          )}
          {(incident.recovery_actions?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs font-semibold text-[rgba(232,232,228,0.4)] mb-1">פעולות שחזור</p>
              <ol className="list-decimal list-inside space-y-1">
                {incident.recovery_actions!.map((a, i) => (
                  <li key={i} className="text-sm text-[rgba(232,232,228,0.72)]">{a}</li>
                ))}
              </ol>
            </div>
          )}
          {incident.confidence_score != null && (
            <p className="text-xs text-[rgba(232,232,228,0.4)]">ביטחון ניתוח AI: {Math.round(incident.confidence_score * 100)}%</p>
          )}
          {fixError && (
            <p className="text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">{fixError}</p>
          )}
          {(incident.status === 'open' || incident.status === 'acknowledged') && (
            <div className="flex gap-2 pt-1 flex-wrap">
              <button
                onClick={handleFix}
                disabled={fixing}
                className="text-xs px-3 py-1.5 rounded-lg font-medium flex items-center gap-1 text-white disabled:opacity-60"
                style={{ background: fixing ? '#6b7280' : 'linear-gradient(135deg,#1a5c2a,#2e7d32)' }}
              >
                {fixing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                {fixing ? 'מטפל בתקלה...' : 'טפל בתקלה'}
              </button>
              {incident.status === 'open' && (
                <>
                  <button onClick={() => onAck(incident.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[#1a1a20] border border-[rgba(201,162,39,0.14)] text-[rgba(232,232,228,0.72)] hover:bg-[rgba(201,162,39,0.06)] font-medium flex items-center gap-1">
                    <Eye className="w-3 h-3" /> טופל
                  </button>
                  <button onClick={() => onResolve(incident.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> נפתר
                  </button>
                </>
              )}
              {incident.status === 'acknowledged' && (
                <button onClick={() => onResolve(incident.id)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> סמן כנפתר
                </button>
              )}
            </div>
          )}
          {fixResult && <FixModal result={fixResult} onClose={() => setFixResult(null)} />}
        </div>
      )}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────────

export default function AdminGuardianPage() {
  const router = useRouter();
  const [health,     setHealth]     = useState<HealthSummary | null>(null);
  const [incidents,  setIncidents]  = useState<GuardianIncident[]>([]);
  const [total,      setTotal]      = useState(0);
  const [scanning,   setScanning]   = useState(false);
  const [incFilter,  setIncFilter]  = useState('open');
  const [sevFilter,  setSevFilter]  = useState('');
  const [lastRefresh,setLastRefresh]= useState<Date | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [actionError,setActionError]= useState('');

  const beginRequest = useLatestRequest();

  const load = useCallback(async () => {
    const latest = beginRequest();
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ status: incFilter, limit: '100' });
      if (sevFilter) params.set('severity', sevFilter);
      const [hRes, iRes] = await Promise.all([
        adminFetch(`/guardian/health`),
        adminFetch(`/guardian/incidents?${params.toString()}`),
      ]);
      if (hRes.status === 401 || hRes.status === 403 || iRes.status === 401 || iRes.status === 403) {
        router.replace('/admin/login');
        return;
      }
      if (!hRes.ok || !iRes.ok) throw new Error('שגיאה בטעינת נתוני הניטור');
      const hData = await hRes.json();
      const iData = await iRes.json();
      latest(() => {
        setHealth(hData);
        setIncidents(iData.incidents || []);
        setTotal(iData.total || 0);
        setLastRefresh(new Date());
      });
    } catch (err) {
      latest(() => {
        setHealth(null);
        setIncidents([]);
        setError(err instanceof Error ? err.message : 'שגיאה בטעינת נתוני הניטור');
      });
    } finally {
      latest(() => setLoading(false));
    }
  }, [incFilter, sevFilter, router, beginRequest]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const handleScan = async () => {
    setScanning(true);
    setActionError('');
    try {
      const res = await adminFetch(`/guardian/run`, { method: 'POST' });
      if (!res.ok) throw new Error('שגיאה בהרצת הסריקה');
      await load();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'שגיאה בהרצת הסריקה'); }
    setScanning(false);
  };
  const handleAck = async (id: string) => {
    setActionError('');
    try {
      const res = await adminFetch(`/guardian/incidents/${id}/acknowledge`, { method: 'PATCH' });
      if (!res.ok) throw new Error('שגיאה בעדכון האירוע');
      await load();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'שגיאה בעדכון האירוע'); }
  };
  const handleResolve = async (id: string) => {
    setActionError('');
    try {
      const res = await adminFetch(`/guardian/incidents/${id}/resolve`, { method: 'PATCH' });
      if (!res.ok) throw new Error('שגיאה בסגירת האירוע');
      await load();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'שגיאה בסגירת האירוע'); }
  };

  const openIncidents = (health?.openBySeverity?.critical ?? 0)
                      + (health?.openBySeverity?.high      ?? 0)
                      + (health?.openBySeverity?.medium    ?? 0)
                      + (health?.openBySeverity?.low       ?? 0);

  // status אמיתי רק אם באמת הצלחנו לטעון נתונים — כשל ברשת לא אמור להיראות כמו "תקין"
  const overallStatus = error ? 'unknown' : (health?.overallStatus ?? 'healthy');
  const StatusIcon    = overallStatus === 'healthy' ? ShieldCheck
                      : overallStatus === 'degraded' ? ShieldAlert
                      : overallStatus === 'unknown'  ? ShieldAlert : ShieldX;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            overallStatus === 'healthy' ? 'bg-emerald-100' : overallStatus === 'degraded' ? 'bg-yellow-100' : overallStatus === 'unknown' ? 'bg-gray-100' : 'bg-red-100'
          }`}>
            <StatusIcon className={`w-5 h-5 ${
              overallStatus === 'healthy' ? 'text-emerald-600' : overallStatus === 'degraded' ? 'text-yellow-600' : overallStatus === 'unknown' ? 'text-gray-500' : 'text-red-600'
            }`} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8e4]">Guardian AI — ניטור מערכת</h1>
            <OverallStatusBadge status={overallStatus} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-[rgba(232,232,228,0.4)] hidden sm:block">עודכן: {lastRefresh.toLocaleTimeString('he-IL')}</span>
          )}
          <button onClick={load} className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-[rgba(232,232,228,0.72)] bg-[#141418] border border-[rgba(201,162,39,0.14)] hover:bg-[rgba(201,162,39,0.06)] transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> רענן
          </button>
          <button onClick={handleScan} disabled={scanning}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 transition-colors">
            <Play className="w-4 h-4" /> {scanning ? 'סורק...' : 'הפעל סריקה'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl text-sm font-medium bg-red-500/10 border border-red-500/20 text-red-500">
          שגיאה בטעינת נתוני הניטור — {error}. ייתכן שאין חיבור לשרת או שההרשאה פגה.
        </div>
      )}
      {actionError && (
        <div className="p-3 rounded-xl text-sm font-medium bg-red-500/10 border border-red-500/20 text-red-500">
          {actionError}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {SEVERITY_KEYS.map(key => {
          const cfg = SEVERITY_CONFIG[key];
          const count = health?.openBySeverity?.[key] ?? 0;
          return (
            <button key={key} onClick={() => setSevFilter(key === sevFilter ? '' : key)}
              className={`text-right rounded-2xl border transition-all ${cfg.bg} ${sevFilter === key ? 'ring-2 ring-violet-400' : ''}`}>
              <div className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[rgba(15,15,20,0.5)] font-medium">{cfg.label}</p>
                  <p className={`text-3xl font-bold ${cfg.color}`}>{count}</p>
                </div>
                <cfg.icon className={`w-6 h-6 ${cfg.color} opacity-60`} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Service Health Grid */}
      {health?.services && health.services.length > 0 && (
        <div className="rounded-2xl bg-[#141418] border border-[rgba(201,162,39,0.14)] p-5">
          <h2 className="flex items-center gap-2 font-bold text-[#e8e8e4] mb-4"><Server className="w-4 h-4" /> מצב שירותים</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {health.services.map(svc => {
              const cfg = STATUS_SERVICE[svc.status] ?? STATUS_SERVICE.healthy;
              // A stale service must not read as its last-known status — that
              // last check may be months old and says nothing about now.
              if (svc.stale) {
                return (
                  <div key={svc.service} className="flex items-center gap-2 p-3 rounded-xl bg-gray-200/70">
                    <span className="w-2 h-2 rounded-full flex-shrink-0 bg-gray-500" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-[rgba(15,15,20,0.8)] truncate">{svc.service}</p>
                      <p className="text-xs text-gray-600" title="השירות לא נבדק בסריקות האחרונות">
                        לא נבדק לאחרונה
                      </p>
                    </div>
                  </div>
                );
              }
              return (
                <div key={svc.service} className={`flex items-center gap-2 p-3 rounded-xl ${cfg.bg}`}>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-[rgba(15,15,20,0.8)] truncate">{svc.service}</p>
                    <p className={`text-xs ${cfg.color}`}>
                      {cfg.label}{svc.response_time_ms != null ? ` · ${svc.response_time_ms}ms` : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          {health.lastScanAt && (
            <p className="text-xs text-[rgba(232,232,228,0.4)] mt-3">סריקה אחרונה: {formatDateTime(health.lastScanAt)}</p>
          )}
        </div>
      )}

      {/* Incident Feed */}
      <div className="rounded-2xl bg-[#141418] border border-[rgba(201,162,39,0.14)] p-5">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <h2 className="flex items-center gap-2 font-bold text-[#e8e8e4]">
            <Zap className="w-4 h-4" />
            אירועים שזוהו אוטומטית
            {openIncidents > 0 && <span className="text-xs bg-red-500 text-white rounded-full px-2 py-0.5">{openIncidents}</span>}
          </h2>
          <div className="flex rounded-xl bg-[#111116] p-1 gap-0.5 border border-[rgba(201,162,39,0.1)]">
            {INCIDENT_FILTER_TABS.map(t => (
              <button key={t.key} onClick={() => setIncFilter(t.key)}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                  incFilter === t.key ? 'bg-[#1a1a20] text-[#e8e8e4] shadow-sm border border-[rgba(201,162,39,0.2)]' : 'text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.7)]'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-[rgba(232,232,228,0.4)]">טוען…</div>
        ) : error ? (
          <div className="text-center py-12">
            <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <p className="text-[rgba(232,232,228,0.42)] font-medium">לא הצלחנו לטעון את האירועים</p>
          </div>
        ) : incidents.length === 0 ? (
          <div className="text-center py-12">
            <ShieldCheck className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
            <p className="text-[rgba(232,232,228,0.42)] font-medium">
              {incFilter === 'open' ? 'אין תקלות פתוחות — המערכת תקינה' : 'אין אירועים'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.map(inc => (
              <IncidentCard key={inc.id} incident={inc} onAck={handleAck} onResolve={handleResolve} />
            ))}
            {total > incidents.length && (
              <p className="text-xs text-center text-[rgba(232,232,228,0.4)] pt-2">מוצגים {incidents.length} מתוך {total}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
