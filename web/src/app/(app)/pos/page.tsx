'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Monitor, RefreshCw, Plug, PlugZap, ChevronRight, ChevronLeft,
  ShoppingBag, Utensils, Package, MoreHorizontal, CheckCircle2, Clock, TrendingUp, Upload, FileSpreadsheet, Wifi, Key, Zap,
  Mail, Eye, EyeOff, RotateCcw, Trash2, Settings2 , AlertTriangle} from 'lucide-react';
import { posApi, businessApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { formatCurrency, formatDateTime, getErrorMessage } from '@/lib/utils';
import { todayIL, shiftDateStr } from '@/lib/dates';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { StatCard } from '@/components/ui/StatCard';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface PosStatus {
  connected: boolean;
  provider?: string;
  lastSyncAt?: string;
  connectedAt?: string;
}

interface SaleItem {
  name: string;
  qty: number;
  unit_price: number;
  total_price: number;
}

interface Sale {
  id: string;
  sale_type: 'table' | 'delivery' | 'takeaway' | 'other';
  table_number?: string;
  total_amount: number;
  sold_at: string;
  items: SaleItem[];
}

interface Stats {
  total_count: number;
  total_revenue: string;
  table_count: number;
  delivery_count: number;
  takeaway_count: number;
  table_revenue: string;
  delivery_revenue: string;
  takeaway_revenue: string;
}

const PROVIDERS = [
  { value: 'bikoum', label: 'ביקום (Bikoum)' },
  { value: 'aviv', label: 'אביב (Aviv POS)' },
  { value: 'netlunch', label: 'Netlunch' },
  { value: 'rsd', label: 'RSD מערכות' },
  { value: 'ironpos', label: 'Iron POS' },
  { value: 'apkufot', label: 'AP קופות' },
  { value: 'other', label: 'אחר' },
];

const SALE_TYPE_LABELS: Record<string, string> = {
  table: 'שולחן',
  delivery: 'משלוח',
  takeaway: 'טייק אוויי',
  other: 'אחר',
};

const SALE_TYPE_COLORS: Record<string, 'default' | 'success' | 'info' | 'warning'> = {
  table: 'success',
  delivery: 'info',
  takeaway: 'warning',
  other: 'default',
};

export default function PosPage() {
  const { confirm, toast } = useAppDialog();
  const [status, setStatus] = useState<PosStatus | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);

  // Date navigation — Israel calendar date, not UTC (toISOString() rolls
  // over 2-3 hours early relative to Israel midnight)
  const [viewDate, setViewDate] = useState(todayIL);

  // Connect modal
  const [showConnect, setShowConnect] = useState(false);
  const [connectForm, setConnectForm] = useState({ provider: 'bikoum', apiKey: '', apiUrl: '' });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Manual import (CSV)
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // Z Report import
  const [zImporting, setZImporting] = useState(false);
  const [zImportResult, setZImportResult] = useState<{ imported: number; skipped: number; shiftsImported: number; message: string; debug?: { sheetsFound: string[]; shiftsFound: number; zReportsFound: number } } | null>(null);
  const zImportRef = useRef<HTMLInputElement>(null);

  const [businessName, setBusinessName] = useState<string>('');

  // Email config (חיבור קופה יומי)
  type EmailConfig = {
    id: string; email: string; imap_host: string; imap_port: number;
    sender_filter: string; subject_filter: string; is_active: boolean;
    last_fetched_at: string | null; last_result: { imported: number; skipped: number; emailsScanned: number; errors: string[]; _fetchFailed?: boolean } | null;
  };
  const [emailConfig, setEmailConfig] = useState<EmailConfig | null | undefined>(undefined); // undefined=loading
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [emailForm, setEmailForm] = useState({ email: '', app_password: '', imap_host: 'imap.gmail.com', imap_port: '993', sender_filter: '', subject_filter: '' });
  const [showPass, setShowPass] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailFetching, setEmailFetching] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await posApi.status();
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    }
  }, []);

  const beginRequest = useLatestRequest();

  const loadSales = useCallback(async () => {
    const latest = beginRequest();
    setLoading(true);
    try {
      const { data } = await posApi.sales({ date: viewDate });
      latest(() => {
        setSales(data.sales || []);
        setStats(data.stats || null);
      });
    } catch {
      latest(() => setSales([]));
    } finally {
      latest(() => setLoading(false));
    }
  }, [viewDate, beginRequest]);

  const loadEmailConfig = useCallback(async () => {
    try {
      const { data } = await posApi.getEmailConfig();
      setEmailConfig(data.config);
    } catch { setEmailConfig(null); }
  }, []);

  useEffect(() => {
    loadStatus();
    loadSales();
    loadEmailConfig();
    businessApi.get().then(({ data }) => setBusinessName(data.name || '')).catch(() => {});
  }, [loadStatus, loadSales, loadEmailConfig]);

  // סטטוס חיבור/סנכרון קופה השתנה מטאב או מכשיר אחר
  useSyncEvent(['pos.updated'], loadStatus);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await posApi.sync();
      await loadSales();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleConnect = async () => {
    if (!connectForm.apiKey) { setConnectError('API Key נדרש'); return; }
    setConnecting(true);
    setConnectError('');
    try {
      await posApi.connect(connectForm);
      setShowConnect(false);
      await loadStatus();
      await loadSales();
    } catch (err) {
      setConnectError(getErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!await confirm('האם לנתק את הקופה?', 'ניתוק קופה', 'נתק')) return;
    try {
      await posApi.disconnect();
      await loadStatus();
    } catch (err) {
      toast(getErrorMessage(err));
    }
  };

  const handleImport = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    // Z-report file types — auto-route to the correct handler
    if (['xlsx', 'xls', 'eml', 'pdf', 'html', 'htm', 'xml', 'json', 'zip'].includes(ext)) {
      return handleZImport(files);
    }
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await posApi.import(formData);
      setImportResult({ imported: data.imported, skipped: data.skipped });
      await loadSales();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const handleZImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setZImporting(true);
    setZImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', files[0]);
      const { data } = await posApi.importZReport(formData);
      setZImportResult(data);
      await loadSales();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setZImporting(false);
      if (zImportRef.current) zImportRef.current.value = '';
    }
  };

  const handleSaveEmailConfig = async () => {
    if (!emailForm.email || !emailForm.app_password) { setEmailMsg({ type: 'error', text: 'כתובת מייל וסיסמת אפליקציה נדרשות' }); return; }
    setEmailSaving(true); setEmailMsg(null);
    try {
      await posApi.saveEmailConfig({ ...emailForm, imap_port: parseInt(emailForm.imap_port) || 993 });
      await loadEmailConfig();
      setShowEmailForm(false);
      toast('הגדרות חיבור מייל נשמרו בהצלחה', 'success');
    } catch (err) { setEmailMsg({ type: 'error', text: getErrorMessage(err) }); }
    finally { setEmailSaving(false); }
  };

  const handleTestEmailConfig = async () => {
    if (!emailForm.email || !emailForm.app_password) { setEmailMsg({ type: 'error', text: 'מלא מייל וסיסמה לפני הבדיקה' }); return; }
    setEmailTesting(true); setEmailMsg(null);
    try {
      const { data } = await posApi.testEmailConfig({ ...emailForm, imap_port: parseInt(emailForm.imap_port) || 993 });
      setEmailMsg({ type: data.success ? 'success' : 'error', text: data.message });
    } catch (err) { setEmailMsg({ type: 'error', text: getErrorMessage(err) }); }
    finally { setEmailTesting(false); }
  };

  const handleFetchNow = async () => {
    setEmailFetching(true); setEmailMsg(null);
    try {
      const { data } = await posApi.fetchEmailNow();
      await loadEmailConfig();
      setEmailMsg({ type: 'success', text: data.message });
    } catch (err) { setEmailMsg({ type: 'error', text: getErrorMessage(err) }); }
    finally { setEmailFetching(false); }
  };

  const handleDeleteEmailConfig = async () => {
    if (!await confirm('האם למחוק את הגדרות חיבור המייל?', 'מחיקת חיבור')) return;
    try {
      await posApi.deleteEmailConfig();
      setEmailConfig(null);
      toast('חיבור המייל הוסר', 'success');
    } catch (err) { toast(getErrorMessage(err)); }
  };

  const openEmailForm = () => {
    setEmailForm({
      email: emailConfig?.email || '',
      app_password: '',
      imap_host: emailConfig?.imap_host || 'imap.gmail.com',
      imap_port: String(emailConfig?.imap_port || 993),
      sender_filter: emailConfig?.sender_filter || '',
      subject_filter: emailConfig?.subject_filter || '',
    });
    setEmailMsg(null);
    setShowAdvanced(false);
    setShowEmailForm(true);
  };

  // viewDate is a YYYY-MM-DD string, so step it as one. `new Date(viewDate)`
  // parses to UTC midnight while getDate()/setDate() read and write in the
  // browser's local frame, and the result was then compared against an
  // Israel-time `today` — three frames in one function. shiftDateStr does the
  // arithmetic on the string itself, so no timezone enters into it.
  const prevDay = () => setViewDate(shiftDateStr(viewDate, -1));

  const nextDay = () => {
    const next = shiftDateStr(viewDate, 1);
    if (next > todayIL()) return; // don't navigate into the future
    setViewDate(next);
  };

  const isToday = viewDate === todayIL();

  const formatDateHebrew = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  const timeSinceSync = status?.lastSyncAt
    ? Math.round((Date.now() - new Date(status.lastSyncAt).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">קופה</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">סנכרון מכירות ממערכת הקופה</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={importRef}
            type="file"
            accept=".csv,.xlsx,.xls,.eml,.pdf,.txt,.html,.htm,.xml,.json,.zip,text/csv"
            className="hidden"
            onChange={e => handleImport(e.target.files)}
          />
          <input
            ref={zImportRef}
            type="file"
            accept=".eml,.xlsx,.xls,.csv,.pdf,.txt,.html,.htm,.xml,.json,.zip"
            className="hidden"
            onChange={e => handleZImport(e.target.files)}
          />
          <Button variant="outline" onClick={() => zImportRef.current?.click()} loading={zImporting} title="EML, XLSX, CSV, PDF, TXT, HTML, ZIP">
            <FileSpreadsheet className="w-4 h-4" /> ייבוא דוח
          </Button>
          <Button variant="outline" onClick={() => { setShowImport(true); setImportResult(null); }}>
            <Upload className="w-4 h-4" /> העלאה ידנית
          </Button>
          {status?.connected && (
            <Button variant="outline" onClick={handleSync} loading={syncing}>
              <RefreshCw className="w-4 h-4" /> סנכרן עכשיו
            </Button>
          )}
          {status?.connected ? (
            <Button variant="outline" onClick={handleDisconnect} className="text-red-600 border-red-200 hover:bg-red-50">
              <PlugZap className="w-4 h-4" /> נתק קופה
            </Button>
          ) : (
            <Button onClick={() => { setConnectError(''); setShowConnect(true); }}>
              <Plug className="w-4 h-4" /> חבר קופה
            </Button>
          )}
        </div>
      </div>

      {/* Connection status banner */}
      {status?.connected && (
        <div className="flex items-center gap-3 px-5 py-3 rounded-xl border bg-green-50 border-green-200">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div className="flex items-center gap-3 flex-wrap flex-1">
            <span className="text-sm font-medium text-green-800">
              קופה מחוברת — {PROVIDERS.find(p => p.value === status.provider)?.label || status.provider}
            </span>
            {timeSinceSync !== null && (
              <span className={`text-xs flex items-center gap-1 ${timeSinceSync > 5 ? 'text-amber-600' : 'text-green-600'}`}>
                <Clock className="w-3.5 h-3.5" />
                סנכרון אחרון לפני {timeSinceSync} דקות
              </span>
            )}
          </div>
        </div>
      )}

      {/* Detailed explanation when not connected */}
      {status && !status.connected && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* How it works */}
          <Card>
            <CardHeader><CardTitle className="text-base">איך מתחברים לקופה?</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 text-blue-700 font-bold text-sm">1</div>
                <div>
                  <p className="text-sm font-medium text-[#e8e8e4]">פנה לספק מערכת הקופה</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mt-0.5">בקש מביקום / אביב / ספק אחר לפתוח גישת API לחשבון שלך</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 text-blue-700 font-bold text-sm">2</div>
                <div>
                  <p className="text-sm font-medium text-[#e8e8e4]">קבל API Key</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mt-0.5">ביקום: הגדרות ← אינטגרציות ← צור API Key. אביב: תמיכה טכנית</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 text-blue-700 font-bold text-sm">3</div>
                <div>
                  <p className="text-sm font-medium text-[#e8e8e4]">לחץ &quot;חבר קופה&quot;</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mt-0.5">הזן את המפתח ואת URL ה-API — ומהרגע הזה המכירות יסתנכרנו אוטומטית</p>
                </div>
              </div>

              <div className="rounded-xl bg-[#1a1a20] p-3 space-y-2">
                <p className="text-xs font-medium text-[rgba(232,232,228,0.72)] flex items-center gap-1.5"><Wifi className="w-3.5 h-3.5" /> מה קורה אחרי החיבור?</p>
                <ul className="text-xs text-[rgba(232,232,228,0.42)] space-y-1 pr-1">
                  <li>• <strong>סנכרון אוטומטי</strong> כל 15 דקות</li>
                  <li>• כל מכירה — סוג, שולחן, פריטים, סכום</li>
                  <li>• הנתונים זורמים ישירות לדוח הפיננסי</li>
                  <li>• ניתן לנתק בכל עת ללא אובדן נתונים</li>
                </ul>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full flex items-center gap-1">
                  <Key className="w-3 h-3" /> ביקום
                </span>
                <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-full flex items-center gap-1">
                  <Key className="w-3 h-3" /> אביב POS
                </span>
                <span className="text-xs px-2 py-1 bg-[#1a1a20] text-[rgba(232,232,228,0.55)] rounded-full flex items-center gap-1">
                  <Zap className="w-3 h-3" /> מערכות נוספות בקרוב
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Manual upload option */}
          <Card>
            <CardHeader><CardTitle className="text-base">העלאה ידנית</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-[rgba(232,232,228,0.55)]">
                אין חיבור API? ניתן לייצא קובץ CSV ממערכת הקופה שלך ולהעלות אותו ידנית.
              </p>

              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                <p className="text-xs font-medium text-amber-800 mb-2 flex items-center gap-1.5">
                  <FileSpreadsheet className="w-3.5 h-3.5" /> פורמט הקובץ הנדרש (CSV)
                </p>
                <code className="text-xs text-amber-700 block font-mono leading-relaxed">
                  date,time,sale_type,table_number,total_amount<br/>
                  2024-01-15,12:30,table,5,150.00<br/>
                  2024-01-15,13:45,delivery,,89.50<br/>
                  2024-01-15,14:00,takeaway,,45.00
                </code>
              </div>

              <ul className="text-xs text-[rgba(232,232,228,0.42)] space-y-1">
                <li>• <strong>date</strong> — תאריך (YYYY-MM-DD) — חובה</li>
                <li>• <strong>time</strong> — שעה (HH:MM) — אופציונלי</li>
                <li>• <strong>sale_type</strong> — table / delivery / takeaway / other</li>
                <li>• <strong>table_number</strong> — מספר שולחן — אופציונלי</li>
                <li>• <strong>total_amount</strong> — סכום — חובה</li>
              </ul>

              <Button
                onClick={() => { if (importRef.current) { importRef.current.value = ''; importRef.current.click(); } }}
                loading={importing || zImporting}
                className="w-full"
              >
                <Upload className="w-4 h-4" /> העלה קובץ CSV
              </Button>

              {importResult && (
                <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
                  יובאו <strong>{importResult.imported}</strong> רשומות בהצלחה
                  {importResult.skipped > 0 && ` • ${importResult.skipped} שורות דולגו`}
                </div>
              )}
              {zImportResult && (
                <div className={`border rounded-xl px-4 py-3 text-sm space-y-2 ${zImportResult.shiftsImported > 0 ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                  <p className="font-semibold">✅ {zImportResult.message}</p>
                  {zImportResult.debug && (
                    <div className="text-xs text-[rgba(232,232,228,0.42)] space-y-0.5">
                      <p>גיליונות בקובץ: {zImportResult.debug.sheetsFound.join(', ')}</p>
                      <p>דוחות שנמצאו: {zImportResult.debug.zReportsFound} | משמרות שנמצאו: {zImportResult.debug.shiftsFound}</p>
                    </div>
                  )}
                  {zImportResult.shiftsImported > 0 && (
                    <p className="text-xs">
                      ✔ נשמרו {zImportResult.shiftsImported} משמרות עובדים — עבור ל<a href="/employees" className="underline font-semibold">לשונית עובדים</a> ולחץ &quot;סנכרן + צור עובדים&quot;
                    </p>
                  )}
                  {zImportResult.shiftsImported === 0 && zImportResult.debug && (
                    <p className="text-xs text-amber-700">
                      {zImportResult.debug.sheetsFound.includes('משמרות')
                        ? 'גיליון משמרות נמצא אך אין נתוני שעות תקינים'
                        : 'גיליון "משמרות" לא נמצא בקובץ — בדוק שהקובץ הנכון הועלה'}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── חיבור קופה יומי (email auto-fetch) — shown only when no direct POS API ── */}
      {status && !status.connected && (
        <div className="space-y-3">
          {/* Section header */}
          <div className="flex items-center gap-2 pt-1">
            <Mail className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-semibold text-[#e8e8e4]">חיבור קופה יומי</h2>
            <span className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-300 rounded-full border border-blue-700/40 font-medium">אוטומטי</span>
            <span className="text-xs text-[rgba(232,232,228,0.3)] mr-1">— רק כשאין חיבור API ישיר</span>
          </div>

          <Card>
            <CardContent className="pt-5 space-y-5">
              {emailConfig === undefined ? (
                <div className="h-20 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !emailConfig ? (
                /* ── Not configured ─────────────────────────────── */
                <div className="space-y-4">
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-xl bg-blue-900/30 border border-blue-700/30 flex items-center justify-center flex-shrink-0">
                      <Mail className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#e8e8e4]">שליפה אוטומטית מהמייל</p>
                      <p className="text-xs text-[rgba(232,232,228,0.42)] mt-1 leading-relaxed">
                        הקופה שולחת דוח למייל בסוף כל יום? חבר את תיבת הדואר — המערכת תזהה אוטומטית את הדוח, תייבא אותו ותעדכן את כל הנתונים הפיננסיים.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    {[
                      { n: '1', t: 'סוף יום', d: 'הקופה נסגרת ושולחת דוח למייל' },
                      { n: '2', t: 'זיהוי אוטומטי', d: 'המערכת מזהה את המייל ומחלצת את הנתונים' },
                      { n: '3', t: 'עדכון מיידי', d: 'הנתונים מתעדכנים בדוחות הפיננסיים' },
                    ].map(s => (
                      <div key={s.n} className="flex items-start gap-2 p-3 rounded-xl bg-[#1a1a20] border border-[rgba(201,162,39,0.1)]">
                        <div className="w-5 h-5 rounded-full bg-blue-900/60 text-blue-300 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">{s.n}</div>
                        <div>
                          <p className="font-medium text-[rgba(232,232,228,0.72)]">{s.t}</p>
                          <p className="text-[rgba(232,232,228,0.38)] mt-0.5">{s.d}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <Button onClick={openEmailForm} className="w-full sm:w-auto">
                    <Mail className="w-4 h-4" /> חבר חשבון מייל
                  </Button>
                </div>
              ) : (
                /* ── Configured ─────────────────────────────────── */
                <div className="space-y-4">
                  {/* Status row */}
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
                      <div>
                        <p className="text-sm font-medium text-[#e8e8e4]">{emailConfig.email}</p>
                        <p className="text-xs text-[rgba(232,232,228,0.38)]">
                          {emailConfig.imap_host}:{emailConfig.imap_port}
                          {emailConfig.last_fetched_at && (
                            <> · שליפה אחרונה: {new Date(emailConfig.last_fetched_at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={handleFetchNow} loading={emailFetching}>
                        <RotateCcw className="w-3.5 h-3.5" /> שלוף עכשיו
                      </Button>
                      <Button variant="outline" size="sm" onClick={openEmailForm}>
                        <Settings2 className="w-3.5 h-3.5" /> הגדרות
                      </Button>
                      <button onClick={handleDeleteEmailConfig} className="p-2 rounded-lg text-red-400 hover:bg-red-900/20 transition-colors" title="הסר חיבור">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Last result.
                      A failed fetch used to render here as a green tick reading
                      "0 מיילים נסרקו · אין דוחות חדשים" — indistinguishable from a
                      healthy scan that simply found nothing new. When the Google
                      authorisation expired, that is exactly what the screen said
                      for four days straight while no Z-report was imported.
                      A failure now looks like a failure and names the fix. */}
                  {emailConfig.last_result && (() => {
                    const r = emailConfig.last_result;
                    const errs = r.errors || [];
                    const failed = r._fetchFailed || errs.length > 0;
                    const authDead = errs.some(e => /invalid_grant|invalid_client|unauthorized|401/i.test(String(e)));
                    if (!failed) {
                      return (
                        <div className={`rounded-xl px-4 py-3 text-xs flex items-center gap-3 ${r.imported > 0 ? 'bg-green-900/20 border border-green-700/30 text-green-300' : 'bg-[#1a1a20] border border-[rgba(201,162,39,0.1)] text-[rgba(232,232,228,0.42)]'}`}>
                          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                          <span>
                            שליפה אחרונה: {r.emailsScanned} מיילים נסרקו
                            {r.imported > 0 ? ` · יובאו ${r.imported} דוחות` : ' · אין דוחות חדשים'}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div className="rounded-xl px-4 py-3 text-xs flex items-start gap-3 bg-red-900/20 border border-red-700/40 text-red-300">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <p className="font-semibold">
                            {authDead ? 'החיבור ל-Gmail פג — לא נסרקו מיילים' : 'השליפה האחרונה נכשלה — לא נסרקו מיילים'}
                          </p>
                          <p className="opacity-80 mt-1 leading-relaxed">
                            {authDead
                              ? 'Google ביטל את ההרשאה, ולכן דוחות Z לא מיובאים אוטומטית. התחבר מחדש ל-Gmail כאן למעלה כדי לחדש את הסריקה.'
                              : `שגיאה: ${errs.slice(0, 2).join(' · ')}`}
                          </p>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Inline fetch message */}
                  {emailMsg && (
                    <div className={`rounded-xl px-4 py-3 text-sm ${emailMsg.type === 'success' ? 'bg-green-900/20 border border-green-700/30 text-green-300' : 'bg-red-900/20 border border-red-700/30 text-red-300'}`}>
                      {emailMsg.text}
                    </div>
                  )}

                  {/* Auto-schedule note */}
                  <p className="text-xs text-[rgba(232,232,228,0.3)] flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> שליפה אוטומטית מתבצעת בכל לילה ב-02:00
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Email config modal */}
      <Modal open={showEmailForm} onClose={() => { setShowEmailForm(false); setEmailMsg(null); }} title={emailConfig ? 'עריכת חיבור מייל' : 'חיבור קופה יומי'} size="md">
        <div className="p-6 space-y-4" dir="rtl">
          {businessName && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
              <span className="text-amber-400 text-xs">🏢</span>
              <span className="text-xs text-amber-200">מגדיר הגדרות מייל עבור: <strong className="text-amber-100 font-semibold">{businessName}</strong></span>
            </div>
          )}
          <div className="rounded-xl bg-blue-900/20 border border-blue-700/30 p-4 text-xs text-blue-200 space-y-2">
            <p className="font-semibold text-sm text-blue-100">Gmail — איך להפעיל? (שלב אחרי שלב)</p>
            <p><span className="font-semibold text-blue-100">שלב 1</span> — כנס ל-<a href="https://myaccount.google.com" target="_blank" rel="noopener noreferrer" className="underline text-blue-300">myaccount.google.com</a> עם הגוגל שאליו מגיעים הדוחות</p>
            <p><span className="font-semibold text-blue-100">שלב 2</span> — לחץ על <span className="text-blue-100 font-medium">&quot;אבטחה&quot;</span> בתפריט הצד</p>
            <p><span className="font-semibold text-blue-100">שלב 3</span> — גלול ל-<span className="text-blue-100 font-medium">&quot;כניסה ל-Google&quot;</span> ← וודא ש<span className="text-blue-100 font-medium">&quot;אימות דו-שלבי&quot;</span> פעיל</p>
            <p><span className="font-semibold text-blue-100">שלב 4</span> — כנס ישירות ל-<a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="underline text-blue-300">myaccount.google.com/apppasswords</a></p>
            <p><span className="font-semibold text-blue-100">שלב 5</span> — בשדה <span className="text-blue-100 font-medium">&quot;שם האפליקציה&quot;</span> כתוב כל שם (למשל: HouseOfBusiness) ← לחץ <span className="text-blue-100 font-medium">&quot;צור&quot;</span></p>
            <p><span className="font-semibold text-blue-100">שלב 6</span> — יופיעו <span className="text-blue-100 font-medium">16 תווים</span> — העתק אותם (מוצגים פעם אחת בלבד!) והדבק בשדה &quot;סיסמת אפליקציה&quot; למטה</p>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">כתובת Gmail / מייל עסקי</label>
              <input
                type="email"
                value={emailForm.email}
                onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))}
                placeholder="business@gmail.com"
                className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] placeholder-[rgba(232,232,228,0.28)] focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">סיסמת אפליקציה (App Password)</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  value={emailForm.app_password}
                  onChange={e => setEmailForm(f => ({ ...f, app_password: e.target.value }))}
                  placeholder="xxxx xxxx xxxx xxxx"
                  className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] placeholder-[rgba(232,232,228,0.28)] focus:border-blue-500 focus:outline-none pr-10"
                />
                <button type="button" onClick={() => setShowPass(p => !p)} className="absolute left-3 top-1/2 -translate-y-1/2 text-[rgba(232,232,228,0.42)]">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-[rgba(232,232,228,0.3)] mt-1">הסיסמה מוצפנת ונשמרת בצורה מאובטחת</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">מייל השולח (אופציונלי)</label>
              <input
                type="text"
                value={emailForm.sender_filter}
                onChange={e => setEmailForm(f => ({ ...f, sender_filter: e.target.value }))}
                placeholder="noreply@beepos.co.il"
                className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] placeholder-[rgba(232,232,228,0.28)] focus:border-blue-500 focus:outline-none"
                dir="ltr"
              />
              <p className="text-xs text-[rgba(232,232,228,0.3)] mt-1">כתובת המייל שממנה הקופה שולחת דוח. ריק = כל המיילים.</p>
            </div>

            {/* Advanced toggle */}
            <button type="button" onClick={() => setShowAdvanced(a => !a)} className="flex items-center gap-1.5 text-xs text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.7)] transition-colors">
              <Settings2 className="w-3.5 h-3.5" />
              {showAdvanced ? 'הסתר הגדרות מתקדמות' : 'הגדרות מתקדמות (IMAP, פילטר נושא)'}
            </button>

            {showAdvanced && (
              <div className="space-y-3 rounded-xl border border-[rgba(201,162,39,0.12)] bg-[#141418] p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">שרת IMAP</label>
                    <input
                      value={emailForm.imap_host}
                      onChange={e => setEmailForm(f => ({ ...f, imap_host: e.target.value }))}
                      placeholder="imap.gmail.com"
                      className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">פורט</label>
                    <input
                      type="number"
                      value={emailForm.imap_port}
                      onChange={e => setEmailForm(f => ({ ...f, imap_port: e.target.value }))}
                      className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[rgba(232,232,228,0.72)] mb-1">פילטר נושא (Subject)</label>
                  <input
                    value={emailForm.subject_filter}
                    onChange={e => setEmailForm(f => ({ ...f, subject_filter: e.target.value }))}
                    placeholder="דוח z,z report,zreport"
                    className="w-full rounded-lg border border-[rgba(201,162,39,0.2)] bg-[#1a1a20] px-3 py-2 text-sm text-[#e8e8e4] placeholder-[rgba(232,232,228,0.28)] focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-[rgba(232,232,228,0.3)] mt-1">מילות מפתח בנושא המייל — מופרדות בפסיקים</p>
                </div>
              </div>
            )}
          </div>

          {emailMsg && (
            <div className={`rounded-xl px-4 py-3 text-sm ${emailMsg.type === 'success' ? 'bg-green-900/20 border border-green-700/30 text-green-300' : 'bg-red-900/20 border border-red-700/30 text-red-300'}`}>
              {emailMsg.text}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
            <Button variant="outline" onClick={handleTestEmailConfig} loading={emailTesting} size="sm">
              <Wifi className="w-4 h-4" /> בדוק חיבור
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setShowEmailForm(false); setEmailMsg(null); }}>ביטול</Button>
              <Button onClick={handleSaveEmailConfig} loading={emailSaving}>
                <Mail className="w-4 h-4" /> שמור
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Date navigation */}
      <div className="flex items-center gap-3 bg-[#141418] rounded-xl border border-[rgba(201,162,39,0.16)] shadow-sm px-5 py-3 w-full lg:w-fit">
        <button onClick={prevDay} className="p-1 rounded-lg hover:bg-[rgba(201,162,39,0.06)] transition-colors">
          <ChevronRight className="w-5 h-5 text-[rgba(232,232,228,0.42)]" />
        </button>
        <span className="text-base font-semibold text-[#e8e8e4] flex-1 text-center">
          {isToday ? 'היום — ' : ''}{formatDateHebrew(viewDate)}
        </span>
        <button onClick={nextDay} disabled={isToday}
          className="p-1 rounded-lg hover:bg-[rgba(201,162,39,0.06)] transition-colors disabled:opacity-30">
          <ChevronLeft className="w-5 h-5 text-[rgba(232,232,228,0.42)]" />
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="סה״כ מכירות"
            value={formatCurrency(parseFloat(stats.total_revenue))}
            subtitle={`${stats.total_count} עסקאות`}
            icon={TrendingUp}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
          />
          <StatCard
            title="שולחן"
            value={formatCurrency(parseFloat(stats.table_revenue))}
            subtitle={`${stats.table_count} עסקאות`}
            icon={Utensils}
            iconColor="text-green-600"
            iconBg="bg-green-50"
          />
          <StatCard
            title="משלוחים"
            value={formatCurrency(parseFloat(stats.delivery_revenue))}
            subtitle={`${stats.delivery_count} עסקאות`}
            icon={Package}
            iconColor="text-blue-600"
            iconBg="bg-blue-50"
          />
          <StatCard
            title="טייק אוויי"
            value={formatCurrency(parseFloat(stats.takeaway_revenue))}
            subtitle={`${stats.takeaway_count} עסקאות`}
            icon={ShoppingBag}
            iconColor="text-orange-600"
            iconBg="bg-orange-50"
          />
        </div>
      )}

      {/* Sales table */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            {loading ? 'טוען...' : `${sales.length} עסקאות — ${formatDateHebrew(viewDate)}`}
          </CardTitle>
        </CardHeader>
        {loading ? (
          <CardContent>
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-[#1a1a20] rounded-lg animate-pulse" />
              ))}
            </div>
          </CardContent>
        ) : sales.length === 0 ? (
          <CardContent>
            <div className="text-center py-12">
              <Monitor className="w-12 h-12 text-[rgba(232,232,228,0.2)] mx-auto mb-3" />
              <p className="text-[rgba(232,232,228,0.42)] text-sm">
                {status?.connected ? 'אין מכירות בתאריך זה' : 'חבר קופה כדי לראות מכירות'}
              </p>
            </div>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[rgba(201,162,39,0.14)]">
                  {['שעה', 'סוג', 'שולחן', 'פריטים', 'סכום', ''].map(h => (
                    <th key={h} className="text-right text-xs font-medium text-[rgba(232,232,228,0.42)] px-6 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                {sales.map((sale) => (
                  <tr key={sale.id} className="hover:bg-[rgba(201,162,39,0.06)] transition-colors">
                    <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.55)]">
                      {new Date(sale.sold_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant={SALE_TYPE_COLORS[sale.sale_type] || 'default'}>
                        {SALE_TYPE_LABELS[sale.sale_type] || sale.sale_type}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.55)]">
                      {sale.table_number || '—'}
                    </td>
                    <td className="px-6 py-3 text-sm text-[rgba(232,232,228,0.55)]">
                      {sale.items.length > 0 ? (
                        <span className="truncate max-w-[180px] block">
                          {sale.items.slice(0, 2).map(i => i.name).join(', ')}
                          {sale.items.length > 2 && ` +${sale.items.length - 2}`}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-sm font-semibold text-[#e8e8e4]">
                      {formatCurrency(sale.total_amount)}
                    </td>
                    <td className="px-6 py-3">
                      <button
                        onClick={() => setSelectedSale(sale)}
                        className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.06)] text-[rgba(232,232,228,0.42)] transition-colors"
                        title="פרטים"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Sale detail modal */}
      <Modal
        open={!!selectedSale}
        onClose={() => setSelectedSale(null)}
        title={`עסקה — ${selectedSale ? formatDateTime(selectedSale.sold_at) : ''}`}
        size="sm"
      >
        {selectedSale && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <Badge variant={SALE_TYPE_COLORS[selectedSale.sale_type] || 'default'}>
                {SALE_TYPE_LABELS[selectedSale.sale_type]}
              </Badge>
              {selectedSale.table_number && (
                <span className="text-sm text-[rgba(232,232,228,0.42)]">שולחן {selectedSale.table_number}</span>
              )}
            </div>

            <div className="border border-[rgba(201,162,39,0.14)] rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-[#1a1a20]">
                    <th className="text-right text-xs font-medium text-[rgba(232,232,228,0.42)] px-4 py-2">פריט</th>
                    <th className="text-center text-xs font-medium text-[rgba(232,232,228,0.42)] px-4 py-2">כמות</th>
                    <th className="text-left text-xs font-medium text-[rgba(232,232,228,0.42)] px-4 py-2">מחיר</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                  {selectedSale.items.map((item, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2.5 text-sm text-[#e8e8e4]">{item.name}</td>
                      <td className="px-4 py-2.5 text-sm text-center text-[rgba(232,232,228,0.55)]">{item.qty}</td>
                      <td className="px-4 py-2.5 text-sm text-left font-medium">{formatCurrency(item.total_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-[rgba(201,162,39,0.14)]">
              <span className="text-sm font-semibold text-[rgba(232,232,228,0.72)]">סה״כ</span>
              <span className="text-lg font-bold text-[#e8e8e4]">{formatCurrency(selectedSale.total_amount)}</span>
            </div>
          </div>
        )}
      </Modal>

      {/* Manual import modal (when connected) */}
      <Modal open={showImport} onClose={() => { setShowImport(false); setImportResult(null); }} title="העלאת נתוני מכירות ידנית">
        <div className="p-6 space-y-4">
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
            <p className="text-xs font-medium text-amber-800 mb-2 flex items-center gap-1.5">
              <FileSpreadsheet className="w-3.5 h-3.5" /> פורמט הקובץ הנדרש (CSV)
            </p>
            <code className="text-xs text-amber-700 block font-mono leading-relaxed">
              date,time,sale_type,table_number,total_amount<br/>
              2024-01-15,12:30,table,5,150.00<br/>
              2024-01-15,13:45,delivery,,89.50
            </code>
          </div>
          <ul className="text-xs text-[rgba(232,232,228,0.42)] space-y-1">
            <li>• <strong>date</strong> — תאריך (YYYY-MM-DD) — חובה</li>
            <li>• <strong>sale_type</strong> — table / delivery / takeaway / other</li>
            <li>• <strong>total_amount</strong> — סכום — חובה</li>
          </ul>
          {importResult && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800">
              יובאו <strong>{importResult.imported}</strong> רשומות בהצלחה
              {importResult.skipped > 0 && ` • ${importResult.skipped} שורות דולגו`}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => { setShowImport(false); setImportResult(null); }}>סגור</Button>
            <Button onClick={() => { if (importRef.current) { importRef.current.value = ''; importRef.current.click(); } }} loading={importing || zImporting}>
              <Upload className="w-4 h-4" /> בחר קובץ
            </Button>
          </div>
        </div>
      </Modal>

      {/* Connect modal */}
      <Modal open={showConnect} onClose={() => setShowConnect(false)} title="חיבור קופה">
        <div className="p-6 space-y-4">
          <div className="space-y-1">
            <label className="block text-sm font-medium text-[rgba(232,232,228,0.72)]">ספק קופה</label>
            <select
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              value={connectForm.provider}
              onChange={e => setConnectForm(f => ({ ...f, provider: e.target.value }))}
            >
              {PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <Input
            label="API Key"
            value={connectForm.apiKey}
            onChange={e => setConnectForm(f => ({ ...f, apiKey: e.target.value }))}
            placeholder="הכנס את המפתח שקיבלת מספק הקופה"
          />
          <Input
            label="API URL (אופציונלי)"
            value={connectForm.apiUrl}
            onChange={e => setConnectForm(f => ({ ...f, apiUrl: e.target.value }))}
            placeholder="https://api.provider.com"
          />

          <div className="bg-blue-50 rounded-xl p-4 text-xs text-blue-700 space-y-1">
            <p className="font-medium">איך לקבל API Key?</p>
            <p>• ביקום: הגדרות → אינטגרציות → צור API Key</p>
            <p>• אביב: פנה לתמיכה הטכנית של אביב</p>
          </div>

          {connectError && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{connectError}</p>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowConnect(false)}>ביטול</Button>
            <Button onClick={handleConnect} loading={connecting}>
              <Plug className="w-4 h-4" /> חבר
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
