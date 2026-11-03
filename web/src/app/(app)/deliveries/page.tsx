'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Bike, Plus, CheckCircle2, XCircle, Clock, TrendingUp, ShoppingBag, RefreshCw, Upload, History, Calendar, FileUp, Link2 } from 'lucide-react';
import { deliveriesApi } from '@/lib/api';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { DateRangePicker } from '@/components/ui/DatePicker';
import { useSyncEvent } from '@/context/SyncContext';
import { useAppDialog } from '@/context/AppDialogContext';
import DeliveryGmailConnectCard from '@/components/deliveries/DeliveryGmailConnectCard';
import { todayIL } from '@/lib/dates';

const PLATFORMS: { key: string; label: string; color: string; bg: string }[] = [
  { key: 'wolt',      label: 'Wolt',       color: '#03cdee', bg: 'rgba(3,205,238,0.1)' },
  { key: 'tenbis',    label: '10bis',      color: '#ff6b00', bg: 'rgba(255,107,0,0.1)' },
  { key: 'sibuv',     label: 'סיבוס',      color: '#7c3aed', bg: 'rgba(124,58,237,0.1)' },
  { key: 'mislocha',  label: 'משלוחה',     color: '#059669', bg: 'rgba(5,150,105,0.1)' },
  { key: 'self',      label: 'עצמאי',      color: '#64748b', bg: 'rgba(100,116,139,0.1)' },
];

interface PlatformStat { platform: string; total: number; revenue: number; active: number; done: number; cancelled: number; }
interface ActiveDelivery { id: string; delivery_platform: string; total_amount: number; sold_at: string; notes?: string; }
interface TodayData {
  totals: { total: number; revenue: number; active: number };
  byPlatform: PlatformStat[];
  active: ActiveDelivery[];
}
interface HistoryDelivery { id: string; delivery_platform: string; total_amount: number; sold_at: string; status: string; notes?: string; }
interface HistoryPlatformStat { platform: string; total: number; revenue: number; done: number; cancelled: number; }
interface HistoryData {
  totals: { total: number; revenue: number; done: number; cancelled: number };
  byPlatform: HistoryPlatformStat[];
  deliveries: HistoryDelivery[];
}

export default function DeliveriesPage() {
  const { toast, confirm } = useAppDialog();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<'today' | 'history' | 'connect'>('today');

  // Today tab
  const [data, setData]       = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm]       = useState({ platform: 'wolt', amount: '', notes: '' });
  const [adding, setAdding]   = useState(false);
  const [showForm, setShowForm] = useState(false);

  // CSV import
  const [showImport, setShowImport]   = useState(false);
  const [csvText, setCsvText]         = useState('');
  const [importPlatform, setImportPlatform] = useState('wolt');
  const [importing, setImporting]     = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  // Connect tab — file upload
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const [uploadPlatform, setUploadPlatform] = useState('wolt');
  const [selectedFile,   setSelectedFile]   = useState<File | null>(null);
  const [uploading,      setUploading]      = useState(false);
  const [uploadResult,   setUploadResult]   = useState<{ imported: number; skipped: number; total: number } | null>(null);

  const doUpload = async () => {
    if (!selectedFile) return;
    setUploading(true); setUploadResult(null);
    try {
      const { data } = await deliveriesApi.uploadFile(selectedFile, uploadPlatform);
      setUploadResult(data);
      setSelectedFile(null);
      load();
    } catch (err) { setUploadResult(null); toast(getErrorMessage(err) || 'העלאת הקובץ נכשלה', 'error'); }
    setUploading(false);
  };

  // History tab — Israel calendar date, not UTC (toISOString() rolls over
  // 2-3 hours early relative to Israel midnight)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const weekAgo = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const [histFrom, setHistFrom] = useState(weekAgo);
  const [histTo, setHistTo]     = useState(today);
  const [histData, setHistData] = useState<HistoryData | null>(null);
  const [histLoading, setHistLoading] = useState(false);

  const loadHistory = useCallback(async (from: string, to: string) => {
    setHistLoading(true);
    try {
      const res = await deliveriesApi.history(from, to);
      setHistData(res.data);
    } catch {
      setHistData(null);
    } finally {
      setHistLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await deliveriesApi.today();
      setData(res.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncEvent('delivery.imported', load);
  useEffect(() => { if (tab === 'history') loadHistory(histFrom, histTo); }, [tab, histFrom, histTo, loadHistory]);

  // Handle Gmail OAuth callback params (redirected here when the connection
  // was initiated from this page — same pattern as zreport/page.tsx)
  useEffect(() => {
    const connected = searchParams.get('gmail_connected');
    const email     = searchParams.get('email');
    const error     = searchParams.get('gmail_error');
    if (connected === '1') {
      // useSearchParams() already URL-decodes — decoding again throws
      // URIError on a value containing a stray '%', which then breaks this
      // whole effect (toast + redirect never run).
      toast(`Gmail מחובר בהצלחה${email ? ` (${email})` : ''}`, 'success');
      setTab('connect'); // OAuth only ever starts from this tab — land back on it
      router.replace('/deliveries');
    } else if (error) {
      toast(error, 'error');
      setTab('connect');
      router.replace('/deliveries');
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) setSelectedFile(f);
  };

  const updateStatus = async (id: string, status: 'done' | 'cancelled') => {
    if (status === 'cancelled' && !await confirm('לבטל את המשלוח?', 'ביטול משלוח')) return;
    try {
      await deliveriesApi.updateStatus(id, status);
      load();
    } catch (err) { toast(getErrorMessage(err) || 'עדכון הסטטוס נכשל', 'error'); }
  };

  const addDelivery = async () => {
    const amount = parseFloat(form.amount);
    if (!amount || amount <= 0) return;
    setAdding(true);
    try {
      await deliveriesApi.add({ platform: form.platform, amount, notes: form.notes || undefined });
      setForm({ platform: 'wolt', amount: '', notes: '' });
      setShowForm(false);
      load();
    } catch (err) {
      toast(getErrorMessage(err) || 'הוספת המשלוח נכשלה', 'error');
    } finally {
      setAdding(false);
    }
  };

  const getPlatformMeta = (key: string) => PLATFORMS.find(p => p.key === key) ?? PLATFORMS[4];

  const runImport = async () => {
    if (!csvText.trim()) return;
    setImporting(true);
    setImportResult(null);
    try {
      // Parse CSV: each line = amount[,date[,order_id[,note]]]
      // OR paste just amounts, one per line
      const lines = csvText.trim().split('\n').filter(l => l.trim() && !l.startsWith('#'));
      const rows = lines.map(line => {
        const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        const amount = parseFloat(parts[0].replace('₪','').replace(/[^\d.]/g,''));
        const sold_at = parts[1] || todayIL();
        const external_order_id = parts[2] || null;
        const notes = parts[3] || null;
        return { platform: importPlatform, amount, sold_at, external_order_id, notes };
      }).filter(r => r.amount > 0);

      const { data } = await deliveriesApi.import(rows);
      setImportResult({ imported: data.imported, skipped: data.skipped });
      load();
    } catch (err) { setImportResult(null); toast(getErrorMessage(err) || 'ייבוא ה-CSV נכשל', 'error'); }
    setImporting(false);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4] flex items-center gap-2">
            <Bike className="w-6 h-6" style={{ color: 'var(--color-primary)' }} />
            משלוחים
          </h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-0.5">
            {tab === 'today' ? 'מעקב משלוחים לפי פלטפורמה — היום' : 'היסטוריית משלוחים לפי טווח תאריכים'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Tabs */}
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <button onClick={() => setTab('today')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === 'today' ? 'bg-[#141418] shadow-sm text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.72)]'}`}>
              <Clock className="w-3.5 h-3.5" /> היום
            </button>
            <button onClick={() => setTab('history')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === 'history' ? 'bg-[#141418] shadow-sm text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.72)]'}`}>
              <History className="w-3.5 h-3.5" /> היסטוריה
            </button>
            <button onClick={() => setTab('connect')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === 'connect' ? 'bg-[#141418] shadow-sm text-[#e8e8e4]' : 'text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.72)]'}`}>
              <Link2 className="w-3.5 h-3.5" /> חיבור
            </button>
          </div>
          {tab === 'today' && <>
            <button onClick={load} className="p-2 rounded-xl hover:bg-[rgba(201,162,39,0.06)] transition-colors" title="רענן">
              <RefreshCw className="w-4 h-4 text-[rgba(232,232,228,0.42)]" />
            </button>
            <Button variant="secondary" onClick={() => { setShowImport(true); setImportResult(null); setCsvText(''); }}>
              <Upload className="w-4 h-4" />
              ייבוא Wolt/10bis
            </Button>
            <Button onClick={() => setShowForm(s => !s)}>
              <Plus className="w-4 h-4" />
              הוסף משלוח
            </Button>
          </>}
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="rounded-2xl p-5"
          style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
          <h3 className="font-bold text-[#e8e8e4] mb-4">משלוח חדש</h3>
          <div className="flex gap-3 flex-wrap">
            <select
              value={form.platform}
              onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
              className="px-3 py-2.5 rounded-xl text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid var(--glass-border)' }}
            >
              {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <input
              type="number"
              placeholder="סכום ₪"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              className="w-32 px-3 py-2.5 rounded-xl text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid var(--glass-border)' }}
            />
            <input
              type="text"
              placeholder="הערה (אופציונלי)"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="flex-1 min-w-[160px] px-3 py-2.5 rounded-xl text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid var(--glass-border)' }}
            />
            <Button onClick={addDelivery} loading={adding} disabled={!form.amount}>
              הוסף
            </Button>
          </div>
        </div>
      )}

      {/* Import modal */}
      <Modal open={showImport} onClose={() => setShowImport(false)} title="ייבוא הזמנות מפלטפורמה">
        <div className="space-y-4" dir="rtl">
          <div>
            <label className="block text-sm text-[rgba(232,232,228,0.42)] mb-1">פלטפורמה</label>
            <select
              value={importPlatform}
              onChange={e => setImportPlatform(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
            >
              {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-[rgba(232,232,228,0.42)] mb-1">
              הדבק נתוני CSV — כל שורה: <code className="text-xs text-yellow-400">סכום, תאריך (אופציונלי), מזהה הזמנה (אופציונלי)</code>
            </label>
            <textarea
              value={csvText}
              onChange={e => setCsvText(e.target.value)}
              rows={8}
              placeholder={"58.90, 2026-05-04 12:30, W123\n43.00, 2026-05-04 13:15\n72.50"}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500"
              dir="ltr"
            />
          </div>
          {importResult && (
            <div className={`rounded-lg p-3 text-sm ${importResult.imported > 0 ? 'bg-green-500/20 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
              ✓ יובאו {importResult.imported} הזמנות
              {importResult.skipped > 0 && ` · ${importResult.skipped} דולגו (כפולים או שגויים)`}
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={runImport} disabled={importing || !csvText.trim()} className="flex-1">
              {importing ? 'מייבא...' : 'ייבא'}
            </Button>
            <Button variant="secondary" onClick={() => setShowImport(false)} className="flex-1">סגור</Button>
          </div>
        </div>
      </Modal>

      {/* ── HISTORY TAB ─────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-5">
          {/* Date range picker */}
          <div className="rounded-2xl p-5 flex flex-wrap items-end gap-4"
            style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[rgba(232,232,228,0.42)]" />
              <span className="text-sm font-medium text-[rgba(232,232,228,0.72)]">טווח תאריכים</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <DateRangePicker
                from={histFrom} to={histTo}
                onFromChange={setHistFrom}
                onToChange={setHistTo}
              />
              <Button onClick={() => loadHistory(histFrom, histTo)} loading={histLoading}>
                <RefreshCw className="w-4 h-4" /> טען
              </Button>
            </div>
            {/* Quick range shortcuts */}
            <div className="flex gap-1.5 flex-wrap mr-auto">
              {[
                { label: 'שבוע', days: 7 },
                { label: 'חודש', days: 30 },
                { label: '3 חודשים', days: 90 },
              ].map(({ label, days }) => (
                <button key={days} onClick={() => {
                  const f = new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
                  const t = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
                  setHistFrom(f); setHistTo(t);
                  loadHistory(f, t);
                }}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium text-[rgba(232,232,228,0.55)] hover:bg-[rgba(201,162,39,0.06)] transition-colors border border-[rgba(201,162,39,0.14)]">
                  {label}
                </button>
              ))}
            </div>
          </div>

          {histLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--glass-bg)' }} />
              ))}
            </div>
          ) : histData ? (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: 'סה"כ משלוחים', value: histData.totals.total, fmt: (v: number) => String(v), color: 'var(--color-primary,#1a5c2a)', icon: ShoppingBag },
                  { label: 'סה"כ הכנסה',   value: histData.totals.revenue, fmt: formatCurrency, color: '#7c3aed', icon: TrendingUp },
                  { label: 'הושלמו',        value: histData.totals.done, fmt: (v: number) => String(v), color: '#059669', icon: CheckCircle2 },
                  { label: 'בוטלו',         value: histData.totals.cancelled, fmt: (v: number) => String(v), color: '#dc2626', icon: XCircle },
                ].map(({ label, value, fmt, color, icon: Icon }) => (
                  <div key={label} className="rounded-2xl p-5"
                    style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3" style={{ background: color + '18' }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <p className="text-xl font-black" style={{ color }}>{fmt(value)}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.42)] mt-1">{label}</p>
                  </div>
                ))}
              </div>

              {/* By platform */}
              <div className="rounded-2xl overflow-hidden"
                style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
                <div className="px-5 py-3.5" style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--glass-border)' }}>
                  <h3 className="font-bold text-[#e8e8e4] text-sm">פירוט לפי פלטפורמה</h3>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-x-reverse" style={{ borderColor: 'var(--glass-border)' }}>
                  {PLATFORMS.map(p => {
                    const stat = histData.byPlatform.find(b => b.platform === p.key);
                    return (
                      <div key={p.key} className="p-4 text-center">
                        <p className="font-bold text-xs" style={{ color: p.color }}>{p.label}</p>
                        <p className="text-2xl font-black text-[#e8e8e4] mt-1">{stat?.total || 0}</p>
                        <p className="text-xs text-[rgba(232,232,228,0.42)]">{formatCurrency(stat?.revenue || 0)}</p>
                        <div className="flex justify-center gap-2 mt-1 text-xs">
                          <span className="text-green-600">{stat?.done || 0} הושלם</span>
                          <span className="text-red-500">{stat?.cancelled || 0} בוטל</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Deliveries list */}
              <div className="rounded-2xl overflow-hidden"
                style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
                <div className="px-5 py-3.5 flex items-center justify-between" style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--glass-border)' }}>
                  <h3 className="font-bold text-[#e8e8e4] text-sm flex items-center gap-2">
                    <History className="w-4 h-4 text-[rgba(232,232,228,0.42)]" />
                    {histData.deliveries.length} משלוחים
                  </h3>
                  <span className="text-xs text-[rgba(232,232,228,0.42)]">{histFrom} — {histTo}</span>
                </div>
                {histData.deliveries.length === 0 ? (
                  <div className="px-6 py-10 text-center text-[rgba(232,232,228,0.42)] text-sm">אין משלוחים בתקופה זו</div>
                ) : (
                  <div className="divide-y" style={{ borderColor: 'var(--glass-border)', maxHeight: '480px', overflowY: 'auto' }}>
                    {histData.deliveries.map(d => {
                      const meta = getPlatformMeta(d.delivery_platform);
                      const dt = new Date(d.sold_at);
                      const dateStr = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
                      const timeStr = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                      return (
                        <div key={d.id} className="flex items-center justify-between px-5 py-3 gap-4">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-bold px-2 py-1 rounded-lg flex-shrink-0" style={{ background: meta.bg, color: meta.color }}>
                              {meta.label}
                            </span>
                            <div>
                              <p className="font-semibold text-[#e8e8e4] text-sm">{formatCurrency(d.total_amount)}</p>
                              {d.notes && <p className="text-xs text-[rgba(232,232,228,0.42)]">{d.notes}</p>}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="text-left">
                              <p className="text-xs text-[rgba(232,232,228,0.42)]">{dateStr}</p>
                              <p className="text-xs text-[rgba(232,232,228,0.42)]">{timeStr}</p>
                            </div>
                            <span className={`text-xs font-semibold px-2 py-1 rounded-lg ${
                              d.status === 'done' ? 'bg-green-100 text-green-700' :
                              d.status === 'cancelled' ? 'bg-red-100 text-red-600' :
                              'bg-orange-100 text-orange-600'
                            }`}>
                              {d.status === 'done' ? 'הושלם' : d.status === 'cancelled' ? 'בוטל' : 'פעיל'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="py-16 text-center text-[rgba(232,232,228,0.42)] text-sm">בחר טווח תאריכים ולחץ "טען"</div>
          )}
        </div>
      )}

      {/* ── TODAY TAB ───────────────────────────────────── */}
      {tab === 'today' && loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--glass-bg)' }} />
          ))}
        </div>
      ) : tab === 'today' && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'משלוחים היום', value: data?.totals.total || 0, icon: ShoppingBag, fmt: (v: number) => String(v), color: 'var(--color-primary,#1a5c2a)' },
              { label: 'הכנסה היום',   value: data?.totals.revenue || 0, icon: TrendingUp, fmt: formatCurrency, color: '#7c3aed' },
              { label: 'פעיל כעת',     value: data?.totals.active || 0,  icon: Clock,      fmt: (v: number) => String(v), color: '#f97316' },
            ].map(({ label, value, icon: Icon, fmt, color }) => (
              <div key={label} className="rounded-2xl p-5"
                style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: color + '18' }}>
                  <Icon className="w-5 h-5" style={{ color }} />
                </div>
                <p className="text-2xl font-black" style={{ color }}>{fmt(value)}</p>
                <p className="text-xs text-[rgba(232,232,228,0.42)] mt-1">{label}</p>
              </div>
            ))}
          </div>

          {/* Platform breakdown */}
          <div className="rounded-2xl overflow-hidden"
            style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
            <div className="px-6 py-4" style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--glass-border)' }}>
              <h3 className="font-bold text-[#e8e8e4]">פירוט לפי פלטפורמה</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-0 divide-x divide-x-reverse"
              style={{ borderColor: 'var(--glass-border)' }}>
              {PLATFORMS.map(p => {
                const stat = data?.byPlatform.find(b => b.platform === p.key);
                return (
                  <div key={p.key} className="p-4 text-center">
                    <p className="font-bold text-sm" style={{ color: p.color }}>{p.label}</p>
                    <p className="text-2xl font-black text-[#e8e8e4] mt-1">{stat?.total || 0}</p>
                    <p className="text-xs text-[rgba(232,232,228,0.42)]">{formatCurrency(stat?.revenue || 0)}</p>
                    <div className="flex justify-center gap-2 mt-2 text-xs">
                      <span className="text-orange-500">{stat?.active || 0} פעיל</span>
                      <span className="text-green-600">{stat?.done || 0} הושלם</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Active deliveries */}
          <div className="rounded-2xl overflow-hidden"
            style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
            <div className="px-6 py-4" style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--glass-border)' }}>
              <h3 className="font-bold text-[#e8e8e4] flex items-center gap-2">
                <Clock className="w-4 h-4 text-orange-500" />
                משלוחים פעילים ({data?.active.length || 0})
              </h3>
            </div>
            {!data?.active.length ? (
              <div className="px-6 py-8 text-center text-[rgba(232,232,228,0.42)] text-sm">אין משלוחים פעילים כרגע</div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--glass-border)' }}>
                {data.active.map(d => {
                  const meta = getPlatformMeta(d.delivery_platform);
                  const time = new Date(d.sold_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={d.id} className="flex items-center justify-between px-6 py-3 gap-4">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{ background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </span>
                        <div>
                          <p className="font-semibold text-[#e8e8e4] text-sm">{formatCurrency(d.total_amount)}</p>
                          {d.notes && <p className="text-xs text-[rgba(232,232,228,0.42)]">{d.notes}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-[rgba(232,232,228,0.42)]">{time}</span>
                        <button
                          onClick={() => updateStatus(d.id, 'done')}
                          className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                          title="סמן כהושלם"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          הושלם
                        </button>
                        <button
                          onClick={() => updateStatus(d.id, 'cancelled')}
                          className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          title="בטל משלוח"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          בטל
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── CONNECT TAB ─────────────────────────────────── */}
      {tab === 'connect' && (
        <div className="space-y-6">
          <div className="rounded-2xl p-5"
            style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
            <h2 className="text-lg font-bold text-[#e8e8e4] mb-1">ייבוא הזמנות משלוח</h2>
            <p className="text-sm text-[rgba(232,232,228,0.55)]">
              בחר את השיטה המתאימה לך — ייבוא ידני של קובץ מדורת הניהול, או חיבור מייל שמייבא הזמנות אוטומטית.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* ─── OPTION A: File Upload ─── */}
            <div className="rounded-2xl p-5 flex flex-col gap-4"
              style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
              <div className="flex items-center gap-2">
                <FileUp className="w-5 h-5 text-blue-400" />
                <h3 className="font-bold text-[#e8e8e4]">ייבוא קובץ CSV / Excel</h3>
                <span className="mr-auto px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/25">ידני</span>
              </div>

              <div className="rounded-xl p-3.5 text-xs space-y-1.5" style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}>
                <p className="font-semibold text-blue-400 mb-1">כיצד זה עובד?</p>
                <p className="text-[rgba(232,232,228,0.6)] leading-relaxed">
                  כל פלטפורמת משלוחים מאפשרת לייצא דוחות כספיים מדורת הניהול שלה.
                  הורד את הקובץ, בחר פלטפורמה, ולחץ "ייבא" — הסכומים ייכנסו אוטומטית.
                </p>
              </div>

              {/* Per-platform instructions */}
              <div className="space-y-2">
                {[
                  { key: 'wolt',     label: 'Wolt',    color: '#03cdee', steps: ['היכנס ל-Partner Portal', 'Payments ← Finance', 'בחר טווח תאריכים ולחץ Export'] },
                  { key: 'tenbis',   label: '10bis',   color: '#ff6b00', steps: ['היכנס לפורטל העסקי', 'דוחות ← דוח הזמנות', 'לחץ ייצוא ל-Excel'] },
                  { key: 'sibuv',    label: 'סיבוס',   color: '#7c3aed', steps: ['דשבורד מסעדה', 'כספים ← ייצוא נתונים'] },
                  { key: 'mislocha', label: 'משלוחה',  color: '#059669', steps: ['פורטל שותפים', 'דוחות ← הורדת CSV'] },
                ].map(p => (
                  <details key={p.key} className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-sm font-medium" style={{ color: p.color }}>
                      <span className="text-xs font-black">{p.label}</span>
                      <span className="text-[rgba(232,232,228,0.42)] text-xs font-normal mr-auto">הצג הוראות</span>
                    </summary>
                    <div className="px-3 pb-3">
                      <ol className="list-decimal list-inside space-y-1">
                        {p.steps.map((s, i) => (
                          <li key={i} className="text-xs text-[rgba(232,232,228,0.55)]">{s}</li>
                        ))}
                      </ol>
                    </div>
                  </details>
                ))}
              </div>

              {/* Platform select + drop zone */}
              <select
                value={uploadPlatform}
                onChange={e => setUploadPlatform(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-border)', color: '#e8e8e4' }}
              >
                {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleFileDrop}
                onDragOver={e => e.preventDefault()}
                className="flex flex-col items-center justify-center gap-2 rounded-xl px-4 py-8 cursor-pointer transition-colors text-center"
                style={{ border: '2px dashed rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.04)' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.35)')}
              >
                <Upload className="w-6 h-6 text-blue-400" />
                {selectedFile ? (
                  <p className="text-sm font-semibold text-blue-400">{selectedFile.name}</p>
                ) : (
                  <>
                    <p className="text-sm text-[rgba(232,232,228,0.55)]">גרור קובץ לכאן או לחץ לבחירה</p>
                    <p className="text-xs text-[rgba(232,232,228,0.35)]">תומך: CSV, XLSX, XLS</p>
                  </>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) setSelectedFile(f); e.target.value = ''; }} />

              <Button onClick={doUpload} disabled={!selectedFile || uploading} loading={uploading}>
                <FileUp className="w-4 h-4" />
                {uploading ? 'מייבא...' : 'ייבא קובץ'}
              </Button>

              {uploadResult && (
                <div className={`rounded-xl p-3 text-sm ${uploadResult.imported > 0 ? 'bg-green-500/15 text-green-300 border border-green-500/25' : 'bg-gray-500/15 text-gray-400 border border-gray-500/25'}`}>
                  {uploadResult.imported > 0
                    ? `יובאו ${uploadResult.imported} הזמנות מתוך ${uploadResult.total} שורות`
                    : `לא יובאו הזמנות חדשות`}
                  {uploadResult.skipped > 0 && ` · ${uploadResult.skipped} דולגו (כפולים)`}
                </div>
              )}
            </div>

            {/* ─── OPTION B: Gmail (shared with Z-report import) ─── */}
            <DeliveryGmailConnectCard onImported={load} />
          </div>
        </div>
      )}
    </div>
  );
}
