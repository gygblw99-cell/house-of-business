'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle, Loader2, Mail, RefreshCw, Shield, Trash2,
  Wifi, WifiOff, ChevronDown, ChevronUp, Clock, Plus, RotateCcw,
  AlertCircle, Search } from 'lucide-react';
import { gmailApi } from '@/lib/api/content';
import { useAppDialog } from '@/context/AppDialogContext';
import { useGmailImportPolling } from '@/hooks/useGmailImportPolling';
import GoogleGIcon from './GoogleGIcon';

interface GmailStatus {
  connected: boolean;
  googleEmail?: string;
  lastSyncAt?: string;
  lastSyncResult?: { scanned?: number; imported?: number; errors?: string[] } | null;
  importStatus?: 'idle' | 'running' | 'done' | 'error' | 'awaiting_confirmation';
  importProgress?: {
    phase?: string;
    found?: number;
    processed?: number;
    imported?: number;
    error?: string;
  } | null;
  detectedSubjects?: { subject: string; count: number }[] | null;
  confirmedSubjects?: string[] | null;
  connectedAt?: string;
  tokensBroken?: boolean;
}

interface Props {
  onImported?: () => void;
  businessName?: string;
}

export default function GmailConnectCard({ onImported, businessName }: Props) {
  const { toast, confirm } = useAppDialog();
  const [connecting, setConnecting] = useState(false);
  const [fetching, setFetching]   = useState(false);
  const [fetchingWide, setFetchingWide] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState<{
    connected?: boolean; query?: string; confirmedSubjects?: string[] | null;
    usingDefaults?: boolean; emailsFound?: number;
    sampleSubjects?: { subject: string; date: string }[]; error?: string;
  } | null>(null);
  const [expanded, setExpanded]   = useState(false);

  const fetchStatus = useCallback(async () => (await gmailApi.getStatus()).data as GmailStatus, []);
  const { status, loading, reload: loadStatus } = useGmailImportPolling(fetchStatus, onImported, 2000);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { data } = await gmailApi.getAuthUrl();
      window.location.href = data.url;
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast(msg || 'שגיאה ביצירת קישור ההתחברות', 'error');
      setConnecting(false);
    }
  };

  const handleFetchNow = async (days = 14) => {
    if (days > 14) { setFetchingWide(true); } else { setFetching(true); }
    try {
      const { data: res } = await gmailApi.fetchNow(days);
      if (res.imported > 0) {
        toast(`יובאו ${res.imported} דוחות חדשים (נסרקו ${res.scanned} מיילים מ-${res.daysBack} ימים אחורה)`, 'success');
        await loadStatus(); onImported?.();
      } else if (res.scanned === 0) {
        toast(`לא נמצאו מיילים תואמים ב-${res.daysBack} ימים האחרונים — לחץ "אבחן" לפרטים`, 'warning' as 'error');
        await loadStatus();
      } else {
        toast(`נסרקו ${res.scanned} מיילים — לא נמצאו דוחות חדשים`, 'info');
        await loadStatus();
      }
    } catch (err: unknown) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בשליפה', 'error');
    }
    setFetching(false); setFetchingWide(false);
  };

  const handleResetSubjects = async () => {
    if (!await confirm('אפס את נושאי החיפוש לברירת המחדל? הסריקה הבאה תחפש לפי כל הנושאים המוגדרים מראש.', 'איפוס נושאי חיפוש', 'אפס')) return;
    setResetting(true);
    try {
      await gmailApi.resetSubjects();
      toast('נושאי החיפוש אופסו — הסריקה הבאה תשתמש בברירת המחדל', 'success');
      setDiagnoseResult(null);
      await loadStatus();
    } catch {
      toast('שגיאה באיפוס הנושאים', 'error');
    }
    setResetting(false);
  };

  const handleDiagnose = async () => {
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const { data } = await gmailApi.diagnose();
      setDiagnoseResult(data);
    } catch {
      toast('שגיאה באבחון', 'error');
    }
    setDiagnosing(false);
  };

  const handleDisconnect = async () => {
    if (!await confirm('לנתק את חשבון Gmail? הסריקה האוטומטית תיפסק.', 'ניתוק Gmail', 'נתק')) return;
    try {
      await gmailApi.disconnect();
      toast('חשבון Gmail נותק', 'success');
      await loadStatus();
    } catch {
      toast('שגיאה בניתוק', 'error');
    }
  };

  const isAwaiting    = status?.importStatus === 'awaiting_confirmation';
  const isImporting   = status?.importStatus === 'running';
  const isTokensBroken = status?.tokensBroken === true;
  const prog = status?.importProgress;

  // Estimated time remaining
  const rateRef = useRef<{ time: number; processed: number } | null>(null);
  const [estMinutes, setEstMinutes] = useState<number | null>(null);

  useEffect(() => {
    if (!isImporting || !prog?.processed || prog.phase === 'searching') {
      rateRef.current = null;
      setEstMinutes(null);
      return;
    }
    const now = Date.now();
    if (!rateRef.current) {
      rateRef.current = { time: now, processed: prog.processed };
      return;
    }
    const elapsed = (now - rateRef.current.time) / 1000;
    const delta = prog.processed - rateRef.current.processed;
    if (elapsed < 5 || delta < 1) return;
    const rate = delta / elapsed; // messages per second
    const remaining = ((prog.found ?? 0) - prog.processed) / rate;
    setEstMinutes(remaining > 0 ? Math.ceil(remaining / 60) : 0);
  }, [prog?.processed, isImporting, prog?.phase, prog?.found]);

  // Subject confirmation state
  const [checkedSubjects, setCheckedSubjects] = useState<string[]>([]);
  const [customSubject, setCustomSubject]     = useState('');
  const [confirming, setConfirming]           = useState(false);

  useEffect(() => {
    if (isAwaiting && status?.detectedSubjects?.length) {
      setCheckedSubjects(status.detectedSubjects.map(d => d.subject));
    }
  }, [isAwaiting, status?.detectedSubjects]);

  const handleConfirmSubjects = async () => {
    const all = [...checkedSubjects, ...(customSubject.trim() ? [customSubject.trim()] : [])];
    if (!all.length) { toast('יש לבחור לפחות נושא אחד', 'error'); return; }
    setConfirming(true);
    try {
      await gmailApi.confirmSubjects(all);
      toast('הנושאים אושרו — הייבוא מתחיל ברקע', 'success');
      await loadStatus();
    } catch {
      toast('שגיאה באישור הנושאים', 'error');
    }
    setConfirming(false);
  };
  const importPct = isImporting && prog?.found
    ? Math.round(((prog.processed ?? 0) / prog.found) * 100)
    : null;

  const fmtSyncTime = (ts?: string) => {
    if (!ts) return null;
    return new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(66,133,244,0.2)' }}>

      {/* Header — clickable toggle */}
      <button
        type="button"
        onClick={() => setExpanded(o => !o)}
        className="w-full px-5 py-4 flex items-center justify-between transition-colors hover:bg-white/[0.02]"
        style={{ borderBottom: expanded ? '1px solid rgba(66,133,244,0.12)' : 'none' }}
      >
        <div className="flex items-center gap-3">
          {/* Gmail-colored icon */}
          <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(66,133,244,0.12)' }}>
            <Mail className="w-4 h-4" style={{ color: '#4285f4' }} />
          </div>
          <div className="text-right">
            <p className="font-semibold text-sm" style={{ color: isTokensBroken ? '#f87171' : '#e8e8e4' }}>
              {loading ? 'Gmail חכם — ייבוא אוטומטי' :
               isTokensBroken ? `Gmail פגוע — נדרש חיבור מחדש` :
               status?.connected ? `Gmail מחובר — ${status.googleEmail}` :
               'חבר Gmail — ייבוא אוטומטי של דוחות'}
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
              {loading ? '...' :
               isTokensBroken ? 'טוקן לא קריא — דוחות Z לא נסרקים' :
               isAwaiting  ? 'זיהינו נושאי מייל — אשר כדי להתחיל ייבוא' :
               isImporting ? `מייבא היסטוריה... ${prog?.processed ?? 0}/${prog?.found ?? '?'} מיילים` :
               status?.connected
                 ? (status.lastSyncAt
                     ? `סריקה אחרונה: ${fmtSyncTime(status.lastSyncAt)}`
                     : 'ממתין לסריקה ראשונה')
                 : 'חיבור חד-פעמי — ייבוא 24 חודשים + סריקה לילית אוטומטית'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#9aa0ab' }} />}
          {!loading && status?.connected && !isImporting && !isTokensBroken && <Wifi className="w-4 h-4" style={{ color: '#4ade80' }} />}
          {!loading && status?.connected && isTokensBroken && <AlertCircle className="w-4 h-4" style={{ color: '#ef4444' }} />}
          {!loading && !status?.connected && <WifiOff className="w-4 h-4" style={{ color: '#6b7280' }} />}
          {isImporting && <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#4285f4' }} />}
          {expanded
            ? <ChevronUp className="w-4 h-4" style={{ color: '#9aa0ab' }} />
            : <ChevronDown className="w-4 h-4" style={{ color: '#9aa0ab' }} />}
        </div>
      </button>

      {expanded && (
        <div className="p-5 space-y-5">

          {businessName && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
              <span className="text-amber-400 text-xs">🏢</span>
              <span className="text-xs text-amber-200">מגדיר עבור: <strong className="text-amber-100 font-semibold">{businessName}</strong></span>
            </div>
          )}

          {/* ── NOT CONNECTED — full onboarding explanation ── */}
          {!loading && !status?.connected && (
            <>
              {/* What is this? */}
              <div className="space-y-3">
                <p className="text-sm font-bold" style={{ color: '#e8e8e4' }}>
                  איך זה עובד?
                </p>

                <div className="grid grid-cols-1 gap-2">
                  {[
                    { icon: '🔗', title: 'חיבור חד-פעמי', body: 'לוחצים "חבר Gmail" — מגיעים למסך הרשאות של Google — מאשרים גישה קריאה בלבד.' },
                    { icon: '📬', title: 'ייבוא 24 חודשים אחורה', body: 'מיד לאחר החיבור, המערכת סורקת את תיבת הדואר ומייבאת אוטומטית כל הדוחות מ-24 החודשים האחרונים.' },
                    { icon: '🌙', title: 'סריקה לילית אוטומטית', body: 'בכל לילה ב-02:00 המערכת מחפשת דוחות חדשים ומייבאת אותם — בלי שתצטרך לעשות כלום.' },
                    { icon: '📊', title: 'דשבורד תמיד מעודכן', body: 'ייבוא מוצלח מרענן אוטומטית את כל הנתונים — רווח גולמי, תחזית ביקוש, דוח שבועי.' },
                  ].map(step => (
                    <div key={step.icon} className="flex gap-3 px-4 py-3 rounded-xl"
                      style={{ background: 'rgba(66,133,244,0.05)', border: '1px solid rgba(66,133,244,0.1)' }}>
                      <span className="text-lg flex-shrink-0">{step.icon}</span>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>{step.title}</p>
                        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: '#9aa0ab' }}>{step.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Security / what we access */}
              <div className="rounded-xl px-4 py-3 space-y-2"
                style={{ background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.15)' }}>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 flex-shrink-0" style={{ color: '#4ade80' }} />
                  <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>מה הגישה כוללת — ומה לא</p>
                </div>
                <ul className="space-y-1 text-xs" style={{ color: '#9aa0ab' }}>
                  <li className="flex items-start gap-2">
                    <span className="text-green-400 flex-shrink-0">✓</span>
                    <span>גישה לקריאה בלבד — אנחנו <strong>לא יכולים</strong> לשלוח מיילים בשמך</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-green-400 flex-shrink-0">✓</span>
                    <span>מחפשים רק מיילים עם נושאים כמו "Z Report", "BeePort" — ולא קוראים שאר המיילים שלך</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-green-400 flex-shrink-0">✓</span>
                    <span>טוקן הגישה מוצפן AES-256 — גם אם המסד נפגע, הטוקן לא קריא</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-green-400 flex-shrink-0">✓</span>
                    <span>ניתן לנתק בכל עת מכאן — ומ-<a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" style={{ color: '#4285f4', textDecoration: 'underline' }}>הגדרות החשבון של Google</a></span>
                  </li>
                </ul>
              </div>

              {/* Google shows an "unverified app" interstitial for the
                  gmail.readonly scope until the app clears Google's security
                  review. It is bright red and says "unsafe", and a restaurant
                  owner who meets it with no warning will simply back out at the
                  last step. Saying it here first — before they click, in our own
                  voice — turns a scare into an expected step. */}
              <div
                className="rounded-xl p-3.5 mb-3 text-xs leading-relaxed"
                style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.28)', color: 'rgba(232,232,228,0.8)' }}
              >
                <p className="font-bold mb-1.5" style={{ color: '#f59e0b' }}>
                  שנייה לפני — Google יציג לך מסך אזהרה. זה תקין.
                </p>
                <p>
                  יופיע &quot;Google hasn&apos;t verified this app&quot;. האזהרה הזו מוצגת לכל אפליקציה שעדיין
                  בתהליך האימות של Google, והיא לא אומרת שמשהו לא בסדר.
                </p>
                <p className="mt-2">
                  פשוט לחץ <strong>Advanced</strong> ואז <strong>Go to… (unsafe)</strong> כדי להמשיך.
                </p>
                <p className="mt-2 opacity-75">
                  זו המערכת שלך שמבקשת לקרוא <strong>רק</strong> את מיילי דוחות ה-Z בתיבה שלך — הרשאת קריאה
                  בלבד, בלי אפשרות לשלוח, למחוק או לשנות דבר.
                </p>
              </div>

              {/* Connect button */}
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="w-full flex items-center justify-center gap-3 py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-60"
                style={{
                  background: connecting ? '#4b5563' : 'rgba(66,133,244,0.15)',
                  color: '#4285f4',
                  border: '1px solid rgba(66,133,244,0.35)',
                }}
              >
                {connecting
                  ? <><Loader2 className="w-5 h-5 animate-spin" /> מעביר לGoogle...</>
                  : <>
                      <GoogleGIcon />
                      חבר Gmail
                    </>}
              </button>

              <p className="text-xs text-center" style={{ color: '#4b5563' }}>
                כבר משתמש בסיסמת אפליקציה (IMAP)?&nbsp;
                <span style={{ color: '#9aa0ab' }}>שיטת Gmail OAuth היא עדיפה — בטוחה יותר ולא דורשת ניהול סיסמאות.</span>
              </p>
            </>
          )}

          {/* ── AWAITING CONFIRMATION — subject detection ── */}
          {!loading && status?.connected && isAwaiting && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl"
                style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.2)' }}>
                <span className="text-xl flex-shrink-0">🔍</span>
                <div>
                  <p className="text-sm font-bold" style={{ color: '#e8e8e4' }}>זיהינו נושאי מייל — אשר שזה נכון</p>
                  <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                    סרקנו את תיבת הדואר שלך ומצאנו מיילים שנראים כמו דוחות. בחר את הנושאים הנכונים — אחרי האישור נתחיל לייבא 24 חודשים אחורה.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {(status.detectedSubjects || []).map(({ subject, count }) => (
                  <label key={subject} className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all"
                    style={{
                      background: checkedSubjects.includes(subject) ? 'rgba(66,133,244,0.1)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${checkedSubjects.includes(subject) ? 'rgba(66,133,244,0.3)' : 'rgba(255,255,255,0.07)'}`,
                    }}>
                    <input
                      type="checkbox"
                      checked={checkedSubjects.includes(subject)}
                      onChange={e => setCheckedSubjects(prev =>
                        e.target.checked ? [...prev, subject] : prev.filter(s => s !== subject)
                      )}
                      className="w-4 h-4 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{subject}</p>
                      <p className="text-xs" style={{ color: '#9aa0ab' }}>{count} מיילים נמצאו</p>
                    </div>
                    {checkedSubjects.includes(subject) && <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#4285f4' }} />}
                  </label>
                ))}
              </div>

              {/* Add custom subject */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customSubject}
                  onChange={e => setCustomSubject(e.target.value)}
                  placeholder="הוסף נושא ידנית (אופציונלי)"
                  className="flex-1 px-3 py-2 rounded-xl text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e8e8e4' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && customSubject.trim()) {
                      setCheckedSubjects(p => [...p, customSubject.trim()]);
                      setCustomSubject('');
                    }
                  }}
                />
                <button
                  onClick={() => { if (customSubject.trim()) { setCheckedSubjects(p => [...p, customSubject.trim()]); setCustomSubject(''); } }}
                  className="px-3 py-2 rounded-xl text-sm font-semibold"
                  style={{ background: 'rgba(255,255,255,0.08)', color: '#9aa0ab' }}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <button
                onClick={handleConfirmSubjects}
                disabled={confirming || checkedSubjects.length === 0}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold disabled:opacity-50 transition-all"
                style={{ background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.35)' }}
              >
                {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {confirming ? 'מאשר...' : `אשר והתחל ייבוא (${checkedSubjects.length} נושאים)`}
              </button>
            </div>
          )}

          {/* ── IMPORTING — progress ── */}
          {isImporting && (
            <div className="space-y-3">
              {prog?.phase === 'searching' ? (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{ background: 'rgba(66,133,244,0.08)', border: '1px solid rgba(66,133,244,0.2)' }}>
                  <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: '#4285f4' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>
                      🔍 מחפש מיילים — זה עלול לקחת כמה דקות...
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                      סורק את תיבת הדואר לפי הנושאים שבחרת — אל תסגור את הדף
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Main progress block */}
                  <div className="px-4 py-3 rounded-xl space-y-2"
                    style={{ background: 'rgba(66,133,244,0.08)', border: '1px solid rgba(66,133,244,0.2)' }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: '#4285f4' }} />
                        <span className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>מייבא דוחות</span>
                      </div>
                      {importPct !== null && (
                        <span className="text-sm font-bold tabular-nums" style={{ color: '#4285f4' }}>
                          {importPct}%
                        </span>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(66,133,244,0.15)' }}>
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${importPct ?? 0}%`, background: '#4285f4' }}
                      />
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center justify-between text-xs" style={{ color: '#9aa0ab' }}>
                      <span>
                        בדק <span className="font-semibold tabular-nums" style={{ color: '#e8e8e4' }}>{prog?.processed ?? 0}</span>
                        {' '}מתוך{' '}
                        <span className="font-semibold tabular-nums" style={{ color: '#e8e8e4' }}>{prog?.found ?? '?'}</span>
                        {' '}מיילים
                        {(prog?.found ?? 0) > (prog?.processed ?? 0) && (
                          <span style={{ color: '#6b7280' }}>
                            {' '}· נשארו{' '}
                            <span className="font-semibold tabular-nums" style={{ color: '#9aa0ab' }}>
                              {(prog!.found! - prog!.processed!)}
                            </span>
                          </span>
                        )}
                      </span>
                      {estMinutes !== null && (
                        <span className="flex items-center gap-1" style={{ color: '#6b7280' }}>
                          <Clock className="w-3 h-3 flex-shrink-0" />
                          {estMinutes === 0
                            ? 'פחות מדקה'
                            : `~${estMinutes} דק׳`}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Imported so far */}
                  {(prog?.imported ?? 0) > 0 && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
                      style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', color: '#4ade80' }}>
                      <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>
                        יובאו עד כה{' '}
                        <span className="font-bold tabular-nums">{prog!.imported}</span>
                        {' '}דוחות
                      </span>
                    </div>
                  )}
                </>
              )}

              <p className="text-xs" style={{ color: '#6b7280' }}>
                הייבוא רץ ברקע — תוכל לסגור את הדף. הוא יסתיים אוטומטית ויעדכן את הדשבורד.
              </p>
            </div>
          )}

          {/* ── TOKENS BROKEN — reconnect required ── */}
          {!loading && status?.connected && isTokensBroken && (
            <div className="space-y-3">
              <div className="rounded-xl px-4 py-4 space-y-3"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#ef4444' }} />
                  <div>
                    <p className="text-sm font-bold" style={{ color: '#f87171' }}>
                      חיבור Gmail פגוע — נדרש חיבור מחדש
                    </p>
                    <p className="text-xs mt-1 leading-relaxed" style={{ color: '#9aa0ab' }}>
                      מפתח ההצפנה שונה מאז החיבור המקורי, ולכן הטוקן לא קריא. דוחות Z לא נסרקים.
                      <br />
                      יש <strong style={{ color: '#e8e8e4' }}>לנתק ולחבר מחדש</strong> — פעולה של 30 שניות.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleDisconnect}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold transition-all"
                  style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.35)' }}
                >
                  <Trash2 className="w-4 h-4" />
                  נתק Gmail (ואז חבר מחדש)
                </button>
              </div>
            </div>
          )}

          {/* ── CONNECTED + DONE ── */}
          {!loading && status?.connected && !isImporting && !isAwaiting && !isTokensBroken && (
            <div className="space-y-4">

              {/* Status badge */}
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{ background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.2)' }}>
                <Wifi className="w-4 h-4 flex-shrink-0" style={{ color: '#4ade80' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>
                    מחובר — {status.googleEmail}
                  </p>
                  {status.lastSyncAt && (
                    <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                      סריקה אחרונה: {fmtSyncTime(status.lastSyncAt)}
                      {status.lastSyncResult?.imported != null && ` · יובאו ${status.lastSyncResult.imported} דוחות`}
                      {status.lastSyncResult?.scanned != null && ` (${status.lastSyncResult.scanned} מיילים נסרקו)`}
                    </p>
                  )}
                </div>
              </div>

              {/* Import done result */}
              {status.importStatus === 'done' && status.importProgress && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-xs"
                  style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', color: '#9aa0ab' }}>
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#4ade80' }} />
                  <span>
                    ייבוא היסטוריה הושלם —&nbsp;
                    {status.importProgress.imported ?? 0} דוחות יובאו מתוך {status.importProgress.found ?? 0} מיילים שנמצאו
                  </span>
                </div>
              )}

              {/* Import error */}
              {status.importStatus === 'error' && status.importProgress?.error && (
                <div className="px-3 py-2.5 rounded-xl text-xs"
                  style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                  שגיאה בייבוא: {status.importProgress.error}
                </div>
              )}

              {/* Confirmed subjects — visible when set, with reset option */}
              {status.confirmedSubjects?.length ? (
                <div className="rounded-xl px-4 py-3 space-y-2"
                  style={{ background: 'rgba(66,133,244,0.05)', border: '1px solid rgba(66,133,244,0.15)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>נושאים מאושרים לחיפוש:</p>
                    <button
                      onClick={handleResetSubjects}
                      disabled={resetting}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                      style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' }}
                    >
                      {resetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                      {resetting ? 'מאפס...' : 'אפס לברירת מחדל'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {status.confirmedSubjects.map(s => (
                      <span key={s} className="px-2 py-0.5 rounded-md text-xs font-medium"
                        style={{ background: 'rgba(66,133,244,0.12)', color: '#93c5fd' }}>
                        {s}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs" style={{ color: '#6b7280' }}>
                    הסריקה מחפשת <strong>רק</strong> מיילים עם נושאים אלה. אם לא נמצאים דוחות — לחץ &quot;אפס&quot; ונסה שוב.
                  </p>
                </div>
              ) : (
                <div className="text-xs px-1" style={{ color: '#6b7280' }}>
                  חיפוש לפי ברירת מחדל — כל נושאי Z-Report המוכרים
                </div>
              )}

              {/* Nightly schedule note */}
              <div className="flex items-center gap-2 text-xs" style={{ color: '#6b7280' }}>
                <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                <span>סריקה אוטומטית מתבצעת בכל לילה ב-02:00 — הדשבורד מתעדכן בבוקר</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleFetchNow(14)}
                  disabled={fetching || fetchingWide}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(66,133,244,0.1)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.25)' }}
                >
                  {fetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {fetching ? 'סורק...' : 'שלוף עכשיו (14 ימים)'}
                </button>
                <button
                  onClick={() => handleFetchNow(90)}
                  disabled={fetching || fetchingWide}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(201,162,39,0.08)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.2)' }}
                >
                  {fetchingWide ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {fetchingWide ? 'סורק...' : '90 יום'}
                </button>
                <button
                  onClick={handleDiagnose}
                  disabled={diagnosing}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)', color: '#9aa0ab', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {diagnosing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  {diagnosing ? 'בודק...' : 'אבחן'}
                </button>
                <button
                  onClick={handleDisconnect}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all mr-auto"
                  style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <Trash2 className="w-4 h-4" />
                  נתק
                </button>
              </div>

              {/* Diagnose result */}
              {diagnoseResult && (
                <div className="rounded-xl overflow-hidden"
                  style={{ border: `1px solid ${diagnoseResult.emailsFound === 0 ? 'rgba(239,68,68,0.25)' : 'rgba(74,222,128,0.2)'}` }}>
                  <div className="px-4 py-2.5 flex items-center gap-2"
                    style={{ background: diagnoseResult.emailsFound === 0 ? 'rgba(239,68,68,0.08)' : 'rgba(74,222,128,0.06)' }}>
                    {diagnoseResult.emailsFound === 0
                      ? <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#ef4444' }} />
                      : <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#4ade80' }} />}
                    <p className="text-sm font-semibold"
                      style={{ color: diagnoseResult.emailsFound === 0 ? '#f87171' : '#4ade80' }}>
                      {diagnoseResult.emailsFound === 0
                        ? 'לא נמצאו מיילים תואמים ב-14 ימים האחרונים'
                        : `נמצאו ${diagnoseResult.emailsFound} מיילים תואמים ב-14 ימים האחרונים`}
                    </p>
                  </div>
                  <div className="px-4 py-3 space-y-2" style={{ background: 'rgba(0,0,0,0.2)' }}>
                    <p className="text-xs" style={{ color: '#6b7280' }}>
                      <span className="font-semibold" style={{ color: '#9aa0ab' }}>שאילתה:</span>{' '}
                      <code className="text-xs" style={{ color: '#c9a227' }}>{diagnoseResult.query}</code>
                    </p>
                    {diagnoseResult.confirmedSubjects?.length ? (
                      <p className="text-xs" style={{ color: '#6b7280' }}>
                        <span className="font-semibold" style={{ color: '#9aa0ab' }}>נושאים נעולים:</span>{' '}
                        {diagnoseResult.confirmedSubjects.join(', ')}{' '}
                        <button onClick={handleResetSubjects} className="underline" style={{ color: '#f59e0b' }}>אפס</button>
                      </p>
                    ) : (
                      <p className="text-xs" style={{ color: '#6b7280' }}>משתמש בברירת מחדל (כל נושאי Z-Report)</p>
                    )}
                    {diagnoseResult.sampleSubjects && diagnoseResult.sampleSubjects.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>דוגמאות מיילים שנמצאו:</p>
                        {diagnoseResult.sampleSubjects.map((s, i) => (
                          <p key={i} className="text-xs" style={{ color: '#6b7280' }}>• {s.subject}</p>
                        ))}
                      </div>
                    )}
                    {diagnoseResult.error && (
                      <p className="text-xs" style={{ color: '#f87171' }}>שגיאה: {diagnoseResult.error}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
