'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Loader2, Mail, RefreshCw, Shield, Trash2,
  Wifi, WifiOff, ChevronDown, ChevronUp, Clock, AlertTriangle,
} from 'lucide-react';
import { gmailApi, deliveryGmailApi } from '@/lib/api/content';
import { useAppDialog } from '@/context/AppDialogContext';
import { useGmailImportPolling } from '@/hooks/useGmailImportPolling';
import GoogleGIcon from '@/components/gmail/GoogleGIcon';

interface DeliveryGmailStatus {
  connected: boolean;
  googleEmail?: string;
  importStatus?: 'idle' | 'running' | 'done' | 'error';
  importProgress?: {
    phase?: string;
    found?: number;
    processed?: number;
    imported?: number;
    error?: string;
  } | null;
  lastSyncAt?: string | null;
  lastSyncResult?: { scanned?: number; imported?: number; skipped?: number; errors?: string[] } | null;
  // True when the SAME shared Gmail connection detected candidate Z-report
  // subjects that still need confirming on /zreport — that flow lives on
  // the other page, so surface a pointer here rather than leave it invisible.
  zreportAwaitingConfirmation?: boolean;
}

interface Props {
  onImported?: () => void;
}

const MONTH_OPTIONS = [3, 6, 12, 24];

export default function DeliveryGmailConnectCard({ onImported }: Props) {
  const { toast, confirm } = useAppDialog();
  const [connecting, setConnecting] = useState(false);
  const [fetching, setFetching]     = useState(false);
  const [importing, setImporting]   = useState(false);
  const [months, setMonths]         = useState(12);
  const [expanded, setExpanded]     = useState(false);

  const fetchStatus = useCallback(async () => (await deliveryGmailApi.getStatus()).data as DeliveryGmailStatus, []);
  const { status, loading, reload: loadStatus } = useGmailImportPolling(fetchStatus, onImported, 3000);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { data } = await gmailApi.getAuthUrl('/deliveries');
      window.location.href = data.url;
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast(msg || 'שגיאה ביצירת קישור ההתחברות', 'error');
      setConnecting(false);
    }
  };

  const handleFetchNow = async () => {
    setFetching(true);
    try {
      const { data: res } = await deliveryGmailApi.fetchNow();
      toast(
        res.imported > 0
          ? `יובאו ${res.imported} משלוחים חדשים (נסרקו ${res.scanned} מיילים)`
          : `לא נמצאו משלוחים חדשים (נסרקו ${res.scanned} מיילים)`,
        res.imported > 0 ? 'success' : 'info'
      );
      await loadStatus();
      if (res.imported > 0) onImported?.();
    } catch (err: unknown) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בשליפה', 'error');
    }
    setFetching(false);
  };

  const handleImportHistory = async () => {
    setImporting(true);
    try {
      await deliveryGmailApi.importHistory(months);
      toast('הייבוא התחיל ברקע', 'success');
      await loadStatus();
    } catch (err: unknown) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בהתחלת הייבוא', 'error');
    }
    setImporting(false);
  };

  const handleDisconnect = async () => {
    if (!await confirm('לנתק את חשבון Gmail? הפעולה תפסיק גם את ייבוא הדוחות, מכיוון שזה אותו חיבור.', 'ניתוק Gmail', 'נתק')) return;
    try {
      await gmailApi.disconnect();
      toast('חשבון Gmail נותק', 'success');
      await loadStatus();
    } catch {
      toast('שגיאה בניתוק', 'error');
    }
  };

  const isImporting = status?.importStatus === 'running';
  const prog = status?.importProgress;
  const importPct = isImporting && prog?.found
    ? Math.round(((prog.processed ?? 0) / prog.found) * 100)
    : null;

  const fmtSyncTime = (ts?: string | null) => {
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
          <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(66,133,244,0.12)' }}>
            <Mail className="w-4 h-4" style={{ color: '#4285f4' }} />
          </div>
          <div className="text-right">
            <p className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>
              {loading ? 'Gmail חכם — ייבוא משלוחים אוטומטי' :
               status?.connected ? `Gmail מחובר — ${status.googleEmail}` :
               'חבר Gmail — ייבוא אוטומטי של משלוחים'}
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
              {loading ? '...' :
               isImporting ? `מייבא היסטוריה... ${prog?.processed ?? 0}/${prog?.found ?? '?'} מיילים` :
               status?.connected
                 ? (status.lastSyncAt
                     ? `סריקה אחרונה: ${fmtSyncTime(status.lastSyncAt)}`
                     : 'מחובר — טרם בוצעה סריקה, לחץ לייבוא היסטוריה')
                 : 'אותו חיבור המשמש לייבוא הדוחות — אם כבר חיברת שם, הוא כבר פעיל כאן'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#9aa0ab' }} />}
          {!loading && status?.connected && !isImporting && <Wifi className="w-4 h-4" style={{ color: '#4ade80' }} />}
          {!loading && !status?.connected && <WifiOff className="w-4 h-4" style={{ color: '#6b7280' }} />}
          {isImporting && <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#4285f4' }} />}
          {expanded
            ? <ChevronUp className="w-4 h-4" style={{ color: '#9aa0ab' }} />
            : <ChevronDown className="w-4 h-4" style={{ color: '#9aa0ab' }} />}
        </div>
      </button>

      {expanded && (
        <div className="p-5 space-y-5">

          {/* ── NOT CONNECTED ── */}
          {!loading && !status?.connected && (
            <>
              <div className="rounded-xl px-4 py-3 space-y-2"
                style={{ background: 'rgba(66,133,244,0.05)', border: '1px solid rgba(66,133,244,0.1)' }}>
                <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>איך זה עובד?</p>
                <p className="text-xs leading-relaxed" style={{ color: '#9aa0ab' }}>
                  מתחברים פעם אחת עם Gmail (או משתמשים בחיבור הקיים מ&quot;דוחות&quot;) — המערכת מזהה
                  אוטומטית מיילי קבלה מ-Wolt / 10bis / סיבוס / משלוחה, ואפשר לבקש ייבוא של היסטוריית משלוחים
                  ישנה בלחיצת כפתור.
                </p>
              </div>

              <div className="rounded-xl px-4 py-3 space-y-2"
                style={{ background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.15)' }}>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 flex-shrink-0" style={{ color: '#4ade80' }} />
                  <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>גישה לקריאה בלבד</p>
                </div>
                <p className="text-xs" style={{ color: '#9aa0ab' }}>
                  אותה הרשאה מוגבלת — לא ניתן לשלוח מיילים בשמך, וניתן לנתק בכל עת.
                </p>
              </div>

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
            </>
          )}

          {/* ── IMPORTING — progress ── */}
          {isImporting && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{ background: 'rgba(66,133,244,0.08)', border: '1px solid rgba(66,133,244,0.2)' }}>
                <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: '#4285f4' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>מייבא היסטוריית משלוחים...</p>
                  <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                    {prog?.phase === 'searching'
                      ? 'מחפש מיילים רלוונטיים...'
                      : `עיבד ${prog?.processed ?? 0} מתוך ${prog?.found ?? '?'} מיילים · יובאו ${prog?.imported ?? 0} משלוחים`}
                  </p>
                </div>
                {importPct !== null && (
                  <span className="text-sm font-bold tabular-nums" style={{ color: '#4285f4' }}>{importPct}%</span>
                )}
              </div>
              {importPct !== null && (
                <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(66,133,244,0.12)' }}>
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${importPct}%`, background: '#4285f4' }} />
                </div>
              )}
              <p className="text-xs" style={{ color: '#6b7280' }}>
                הייבוא רץ ברקע — תוכל לסגור את הדף. רשימת המשלוחים תתעדכן אוטומטית בסיום.
              </p>
            </div>
          )}

          {/* ── CONNECTED + IDLE/DONE/ERROR ── */}
          {!loading && status?.connected && !isImporting && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{ background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.2)' }}>
                <Wifi className="w-4 h-4 flex-shrink-0" style={{ color: '#4ade80' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>מחובר — {status.googleEmail}</p>
                  {status.lastSyncAt && (
                    <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                      סריקה אחרונה: {fmtSyncTime(status.lastSyncAt)}
                      {status.lastSyncResult?.imported != null && ` · יובאו ${status.lastSyncResult.imported} משלוחים`}
                      {status.lastSyncResult?.scanned != null && ` (${status.lastSyncResult.scanned} מיילים נסרקו)`}
                    </p>
                  )}
                </div>
              </div>

              {status.zreportAwaitingConfirmation && (
                <Link
                  href="/zreport"
                  className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-xs transition-colors hover:opacity-90"
                  style={{ background: 'rgba(201,162,39,0.08)', border: '1px solid rgba(201,162,39,0.25)', color: '#e8e8e4' }}
                >
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#c9a227' }} />
                  <span>ייבוא דוחות (אותו חיבור Gmail) ממתין לאישור נושאי מייל — לחץ כדי לעבור לדוחות ולאשר</span>
                </Link>
              )}

              {status.importStatus === 'done' && status.importProgress && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-xs"
                  style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)', color: '#9aa0ab' }}>
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#4ade80' }} />
                  <span>
                    ייבוא היסטוריה הושלם —&nbsp;
                    {status.importProgress.imported ?? 0} משלוחים יובאו מתוך {status.importProgress.found ?? 0} מיילים שנמצאו
                  </span>
                </div>
              )}

              {status.importStatus === 'error' && status.importProgress?.error && (
                <div className="px-3 py-2.5 rounded-xl text-xs"
                  style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                  שגיאה בייבוא: {status.importProgress.error}
                </div>
              )}

              {/* Historical import trigger */}
              <div className="rounded-xl px-4 py-3 space-y-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>ייבוא היסטוריית משלוחים</p>
                <div className="flex items-center gap-2 flex-wrap">
                  {MONTH_OPTIONS.map(m => (
                    <button
                      key={m}
                      onClick={() => setMonths(m)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                      style={{
                        background: months === m ? 'rgba(66,133,244,0.18)' : 'rgba(255,255,255,0.04)',
                        color: months === m ? '#4285f4' : '#9aa0ab',
                        border: `1px solid ${months === m ? 'rgba(66,133,244,0.4)' : 'rgba(255,255,255,0.08)'}`,
                      }}
                    >
                      {m} חודשים
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleImportHistory}
                  disabled={importing}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.35)' }}
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  {importing ? 'מתחיל...' : `ייבא היסטוריית משלוחים (${months} חודשים)`}
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs" style={{ color: '#6b7280' }}>
                <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                <span>סריקה אוטומטית מתבצעת כל 8 שעות</span>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleFetchNow}
                  disabled={fetching}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(66,133,244,0.1)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.25)' }}
                >
                  {fetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {fetching ? 'סורק...' : 'בדוק עכשיו (14 ימים)'}
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
            </div>
          )}

        </div>
      )}
    </div>
  );
}
