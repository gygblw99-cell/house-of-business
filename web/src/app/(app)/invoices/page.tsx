'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import {
  Upload, CheckCircle, XCircle, Search, AlertCircle,
  Eye, FileText, Loader2, SplitSquareHorizontal, Merge, Download, Camera,
  Sparkles, SlidersHorizontal, TrendingUp, TrendingDown, Minus, Pencil, Plus, Trash2,
} from 'lucide-react';
import { invoicesApi, suppliersApi, exportApi } from '@/lib/api';
import { formatCurrency, formatDate, getErrorMessage, downloadBlob } from '@/lib/utils';
import { DatePicker, DateRangePicker } from '@/components/ui/DatePicker';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { StatCard } from '@/components/ui/StatCard';
import type { Invoice } from '@/types';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import CameraCapture from '@/components/CameraCapture';
import { useImgToken } from '@/hooks/useImgToken';

interface SupplierTrend {
  supplierId: string;
  supplierName: string;
  amounts: number[];
  dates: string[];
  lastAmount: number;
  prevAmount: number;
  pctChange: number;
  trend: 'up' | 'down' | 'stable';
}

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'multipage_confirm'; pagesCount: number; tempFiles: string[] }
  | { phase: 'processing' }
  | { phase: 'done'; result: Record<string, unknown> }
  | { phase: 'error'; message: string };

export default function InvoicesPage() {
  const { confirm, toast } = useAppDialog();
  const [invoices, setInvoices]   = useState<Invoice[]>([]);
  // pending_approval replaces the old `duplicates` counter, which was always 0:
  // nothing in the backend ever set is_duplicate (a duplicate upload is
  // rejected, not stored flagged), so that card showed a permanent zero.
  const [stats, setStats]         = useState<{ total: number; unpaid: number; pending_approval: number; unpaid_amount: number } | null>(null);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState<Invoice | null>(null);
  const [editMode, setEditMode]   = useState(false);
  const [editForm, setEditForm]   = useState<{
    supplier_id: string; supplier_name: string; invoice_number: string;
    invoice_date: string; total_amount: string; notes: string; invoice_category: string;
    items: { _key: string; name: string; qty: string; unit: string; unit_price: string; total_price: string; item_type: string }[];
  }>({ supplier_id: '', supplier_name: '', invoice_number: '', invoice_date: '', total_amount: '', notes: '', invoice_category: 'food', items: [] });
  const [suppliersList, setSuppliersList] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving]       = useState(false);
  const [search, setSearch]       = useState('');
  const debouncedSearch = useDebounce(search);
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo]     = useState('');
  const [aiQuery, setAiQuery]       = useState('');
  const [aiSearching, setAiSearching] = useState(false);
  const [aiFilters, setAiFilters]   = useState<Record<string, unknown> | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [upload, setUpload]       = useState<UploadState>({ phase: 'idle' });
  const [suspiciousCosts, setSuspiciousCosts] = useState<Array<{ name: string; unit: string; cost_per_unit: number; reason: string }>>([]);
  const [trends, setTrends]       = useState<SupplierTrend[]>([]);
  const fileRef   = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [partialPayInvoiceId, setPartialPayInvoiceId] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [imgToken] = useImgToken();
  const [imageViewer, setImageViewer] = useState<{ urls: string[]; title: string } | null>(null);

  const invImgUrl = (raw: string) => {
    const filename = raw.replace(/^.*\/uploads\//, '').replace(/^\//, '');
    return `/api-proxy/uploads/${filename}${imgToken ? `?token=${imgToken}` : ''}`;
  };

  const load = () => {
    Promise.allSettled([
      invoicesApi.list(),
      invoicesApi.stats(),
      suppliersApi.list(),
      invoicesApi.supplierTrends(),
    ]).then(([list, st, sup, tr]) => {
      if (list.status === 'fulfilled') setInvoices(list.value.data.invoices || []);
      if (st.status   === 'fulfilled') setStats(st.value.data || null);
      if (sup.status  === 'fulfilled') {
        const supData = Array.isArray(sup.value.data) ? sup.value.data : (sup.value.data?.items || []);
        setSuppliersList(supData.filter((s: { is_active?: boolean }) => s.is_active !== false));
      }
      if (tr.status   === 'fulfilled') setTrends(tr.value.data.trends || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useSyncEvent(['invoice_uploaded', 'invoice_approved', 'invoice.updated'], load);

  // ── העלאת קבצים ──────────────────────────────────────────────
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUpload({ phase: 'uploading' });

    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('invoices', f));

      const { data } = await invoicesApi.upload(formData);

      if (data.status === 'multipage_confirm_required') {
        setUpload({
          phase: 'multipage_confirm',
          pagesCount: data.pagesCount,
          tempFiles: data.tempFiles,
        });
        return;
      }

      setUpload({ phase: 'done', result: data });
      load();
    } catch (err) {
      setUpload({ phase: 'error', message: getErrorMessage(err) });
    }
  };

  // ── אישור איחוד עמודים ───────────────────────────────────────
  const confirmMerge = async (merge: boolean) => {
    if (upload.phase !== 'multipage_confirm') return;
    const { tempFiles } = upload;
    setUpload({ phase: 'processing' });

    try {
      const { data } = await invoicesApi.confirmMerge(tempFiles, merge);
      setUpload({ phase: 'done', result: data });
      load();
    } catch (err) {
      setUpload({ phase: 'error', message: getErrorMessage(err) });
    }
  };

  const markPaid = async (id: string) => {
    if (!await confirm('לסמן את החשבונית כשולמה?', 'סימון כשולם')) return false;
    try {
      await invoicesApi.markPaid(id);
      load();
      return true;
    } catch (err) {
      toast(getErrorMessage(err));
      return false;
    }
  };

  const openPartialPay = (id: string, currentPaidAmount?: number) => {
    setPartialPayInvoiceId(id);
    setPartialAmount(currentPaidAmount ? currentPaidAmount.toString() : '');
  };

  const submitPartialPayment = async () => {
    if (!partialPayInvoiceId) return;
    const amount = parseFloat(partialAmount);
    if (!Number.isFinite(amount) || amount < 0) { toast('נא להזין סכום תקין'); return; }
    try {
      await invoicesApi.partialPayment(partialPayInvoiceId, amount);
      setPartialPayInvoiceId(null);
      setPartialAmount('');
      load();
      toast('תשלום חלקי נרשם', 'success');
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const deleteInvoice = async (id: string) => {
    if (!await confirm('האם למחוק את החשבונית לצמיתות? פעולה זו אינה הפיכה.', 'מחיקת חשבונית')) return;
    try {
      await invoicesApi.delete(id);
      setSelected(null);
      setEditMode(false);
      load();
    } catch (err) {
      toast(getErrorMessage(err));
    }
  };

  const openDetail = (inv: Invoice, startEdit = false) => {
    setSelected(inv);
    setEditMode(startEdit);
    setEditForm({
      supplier_id:    (inv as Invoice & { supplier_id?: string }).supplier_id || '',
      supplier_name:  inv.supplier_name  || '',
      invoice_number: inv.invoice_number || '',
      invoice_date:   inv.invoice_date   ? inv.invoice_date.slice(0, 10) : '',
      total_amount:   inv.total_amount?.toString() || '',
      notes:          inv.notes || '',
      invoice_category: (inv as any).invoice_category || 'food',
      items:          (inv.items || []).map(it => ({
        _key:        crypto.randomUUID(),
        name:        it.name || '',
        qty:         it.qty?.toString()        || '',
        unit:        it.unit || '',
        unit_price:  it.unit_price?.toString() || '',
        total_price: it.total_price?.toString()|| '',
        item_type:   (it as { item_type?: string }).item_type || 'מזון',
      })),
    });
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const approveRes = await invoicesApi.approve(selected.id, {
        supplierId:    editForm.supplier_id   || undefined,
        supplierName:  editForm.supplier_name,
        invoiceNumber: editForm.invoice_number,
        invoiceDate:   editForm.invoice_date,
        totalAmount:   Number.isFinite(parseFloat(editForm.total_amount)) ? parseFloat(editForm.total_amount) : null,
        notes:         editForm.notes || null,
        invoiceCategory: editForm.invoice_category || 'food',
        items:         editForm.items.filter(it => it.name.trim()).map(it => ({
          name:        it.name,
          qty:         Number.isFinite(parseFloat(it.qty))         ? parseFloat(it.qty)         : null,
          unit:        it.unit                    || null,
          unit_price:  Number.isFinite(parseFloat(it.unit_price))  ? parseFloat(it.unit_price)  : null,
          total_price: Number.isFinite(parseFloat(it.total_price)) ? parseFloat(it.total_price) : null,
          item_type:   it.item_type || 'מזון',
        })),
      });
      setEditMode(false);
      setSelected(null);
      setSuspiciousCosts(approveRes?.data?.suspiciousCosts || []);
      load();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const supplierOptions = Array.from(new Set(invoices.map(i => i.supplier_name).filter(Boolean)));

  const AI_QUERY_MAX = 500;

  const runAiSearch = async () => {
    if (!aiQuery.trim()) return;
    if (aiQuery.length > AI_QUERY_MAX) return;
    setAiSearching(true);
    setAiFilters(null);
    try {
      const { data } = await invoicesApi.aiSearch(aiQuery);
      const filters = data.filters;
      setAiFilters(filters);

      // אם יש תוצאה אחת בדיוק — פתח אותה אוטומטית
      if (filters) {
        const f = filters as {
          supplierName?: string; dateFrom?: string; dateTo?: string;
          invoiceNumber?: string; minAmount?: number; maxAmount?: number;
          isPaid?: boolean; keyword?: string;
        };
        const matches = invoices.filter(inv => {
          if (f.supplierName && !(inv.supplier_name || '').toLowerCase().includes(f.supplierName.toLowerCase())) return false;
          if (f.dateFrom && inv.invoice_date && inv.invoice_date.slice(0, 10) < f.dateFrom) return false;
          if (f.dateTo   && inv.invoice_date && inv.invoice_date.slice(0, 10) > f.dateTo)   return false;
          if (f.invoiceNumber && !(inv.invoice_number || '').toLowerCase().includes(f.invoiceNumber.toLowerCase())) return false;
          if (f.minAmount != null && (inv.total_amount || 0) < f.minAmount) return false;
          if (f.maxAmount != null && (inv.total_amount || 0) > f.maxAmount) return false;
          if (f.isPaid != null && inv.is_paid !== f.isPaid) return false;
          if (f.keyword && !(inv.supplier_name || '').toLowerCase().includes(f.keyword.toLowerCase())
            && !(inv.invoice_number || '').toLowerCase().includes(f.keyword.toLowerCase())) return false;
          return true;
        });
        if (matches.length === 1) openDetail(matches[0]);
      }
    } catch {
      setAiFilters(null);
    } finally {
      setAiSearching(false);
    }
  };

  const clearAiSearch = () => { setAiQuery(''); setAiFilters(null); };

  const filtered = useMemo(() => invoices.filter(inv => {
    // AI filters
    if (aiFilters) {
      const f = aiFilters as {
        supplierName?: string; dateFrom?: string; dateTo?: string;
        invoiceNumber?: string; minAmount?: number; maxAmount?: number;
        isPaid?: boolean; keyword?: string;
      };
      if (f.supplierName && !(inv.supplier_name || '').toLowerCase().includes(f.supplierName.toLowerCase())) return false;
      if (f.dateFrom && inv.invoice_date && inv.invoice_date.slice(0, 10) < f.dateFrom) return false;
      if (f.dateTo   && inv.invoice_date && inv.invoice_date.slice(0, 10) > f.dateTo)   return false;
      if (f.invoiceNumber && !(inv.invoice_number || '').toLowerCase().includes(f.invoiceNumber.toLowerCase())) return false;
      if (f.minAmount != null && (inv.total_amount || 0) < f.minAmount) return false;
      if (f.maxAmount != null && (inv.total_amount || 0) > f.maxAmount) return false;
      if (f.isPaid != null && inv.is_paid !== f.isPaid) return false;
      if (f.keyword && !(inv.supplier_name || '').toLowerCase().includes(f.keyword.toLowerCase())
        && !(inv.invoice_number || '').toLowerCase().includes(f.keyword.toLowerCase())) return false;
      return true;
    }
    // Manual filters
    const q = debouncedSearch.toLowerCase();
    if (q && !(inv.supplier_name || '').toLowerCase().includes(q) && !(inv.invoice_number || '').toLowerCase().includes(q)) return false;
    if (filterSupplier && inv.supplier_name !== filterSupplier) return false;
    if (filterDateFrom && inv.invoice_date && inv.invoice_date.slice(0, 10) < filterDateFrom) return false;
    if (filterDateTo   && inv.invoice_date && inv.invoice_date.slice(0, 10) > filterDateTo)   return false;
    return true;
  }), [invoices, aiFilters, debouncedSearch, filterSupplier, filterDateFrom, filterDateTo]);

  const hasFilters = filterSupplier || filterDateFrom || filterDateTo;
  const clearFilters = () => { setFilterSupplier(''); setFilterDateFrom(''); setFilterDateTo(''); setSearch(''); };

  const missingAmountInvoices = invoices.filter(inv => !inv.total_amount || inv.total_amount === 0);

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">

      {showCamera && (
        <CameraCapture
          onCapture={file => {
            if (typeof DataTransfer !== 'undefined') {
              const list = new DataTransfer();
              list.items.add(file);
              handleFiles(list.files);
            } else {
              // Fallback for very old Safari: create synthetic single-file list
              handleFiles({ 0: file, length: 1, item: () => file, [Symbol.iterator]: function*() { yield file; } } as unknown as FileList);
            }
          }}
          onClose={() => setShowCamera(false)}
          // The in-page camera can fail for reasons nothing could check before
          // opening it — permission denied, no camera fitted. This hands the
          // capture to the device's own camera app instead of leaving the
          // owner on an error screen whose only button fails identically.
          onFallback={() => { setShowCamera(false); cameraRef.current?.click(); }}
        />
      )}

      {/* Cost sanity warning — shown after invoice approval if unit prices seem wrong */}
      {suspiciousCosts.length > 0 && (
        <div className="flex items-start gap-3 text-sm bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
          <span className="text-orange-500 text-lg flex-shrink-0">⚠️</span>
          <div className="flex-1 text-orange-900">
            <strong>בדוק מחירי מלאי — נראה חריג:</strong>
            <ul className="mt-1 space-y-1 list-disc list-inside">
              {suspiciousCosts.map((s, i) => (
                <li key={i}><strong>{s.name}</strong> ({s.unit || 'ללא יחידה'}): {s.reason}</li>
              ))}
            </ul>
            <p className="mt-2 text-orange-700 text-xs">ייתכן ש-OCR שמר מחיר לאריזה כמחיר ליחידה. ערוך את הפריט במלאי כדי לתקן.</p>
          </div>
          <button onClick={() => setSuspiciousCosts([])} className="text-orange-400 hover:text-orange-600 flex-shrink-0 text-lg leading-none">×</button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">חשבוניות</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">{invoices.length} חשבוניות</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={async () => {
            try { const { data } = await exportApi.invoices(); downloadBlob(data, 'חשבוניות.xlsx'); }
            catch (err) { toast(getErrorMessage(err)); }
          }}>
            <Download className="w-4 h-4" /> ייצוא Excel
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf,.heic,.heif"
            multiple
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => handleFiles(e.target.files)}
          />
          <Button
            variant="outline"
            onClick={() => {
              if (navigator.mediaDevices) {
                setShowCamera(true);
              } else {
                cameraRef.current?.click();
              }
            }}
            disabled={upload.phase === 'uploading' || upload.phase === 'processing'}
            title="צלם חשבונית עם המצלמה"
          >
            <Camera className="w-4 h-4" /> צלם
          </Button>
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={upload.phase === 'uploading' || upload.phase === 'processing'}
          >
            {(upload.phase === 'uploading' || upload.phase === 'processing')
              ? <><Loader2 className="w-4 h-4 animate-spin" /> מעבד...</>
              : <><Upload className="w-4 h-4" /> סרוק חשבונית</>
            }
          </Button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="סה״כ חשבוניות" value={stats.total} icon={FileText} iconColor="text-blue-600" iconBg="bg-blue-50" />
          <StatCard title="ממתינות לתשלום" value={stats.unpaid} icon={AlertCircle} iconColor="text-amber-600" iconBg="bg-amber-50" />
          <StatCard title="סכום לתשלום" value={formatCurrency(stats.unpaid_amount)} icon={CheckCircle} iconColor="text-green-600" iconBg="bg-green-50" />
          <StatCard title="ממתינות לאישור" value={stats.pending_approval} icon={XCircle} iconColor="text-red-600" iconBg="bg-red-50" />
        </div>
      )}

      {/* Upload result banner */}
      {upload.phase === 'done' && (
        <div className={`rounded-xl px-5 py-4 flex items-center justify-between ${
          (upload.result as Record<string,unknown>).status === 'duplicate'
            ? 'bg-red-50 border border-red-200'
            : 'bg-green-50 border border-green-200'
        }`}>
          <div>
            {(upload.result as Record<string,unknown>).status === 'duplicate' ? (
              <p className="text-sm font-medium text-red-800">חשבונית כפולה זוהתה — לא נשמרה</p>
            ) : (upload.result as Record<string,unknown>).status === 'manual_required' ? (
              <p className="text-sm font-medium text-amber-800">לא ניתן לקרוא אוטומטית — נדרש מילוי ידני</p>
            ) : (
              <div className="text-sm text-green-800">
                <p className="font-medium flex items-center gap-2 flex-wrap">
                  {`חשבונית נקראה בהצלחה${(upload.result as Record<string,unknown>).supplierName ? ` — ${String((upload.result as Record<string,unknown>).supplierName)}` : ''}`}
                  {(upload.result as Record<string,unknown>).totalAmount != null && (upload.result as Record<string,unknown>).totalAmount !== 0 && (
                    <span className="inline-flex items-center gap-1 bg-green-700 text-white text-xs font-bold px-2.5 py-0.5 rounded-full">
                      סכום לתשלום: {formatCurrency((upload.result as Record<string,unknown>).totalAmount as number)}
                    </span>
                  )}
                </p>
                <p className="text-xs mt-0.5">
                  {`ביטחון AI: ${Math.round((((upload.result as Record<string,unknown>).aiConfidence as number) || 0) * 100)}%`}
                  {((upload.result as Record<string,unknown>).itemsCount as number) > 0 && ` • ${String((upload.result as Record<string,unknown>).itemsCount)} פריטים`}
                  {!!(upload.result as Record<string,unknown>).supplierAutoCreated && ' • ✅ ספק נוצר אוטומטית'}
                  {!(upload.result as Record<string,unknown>).supplierId && !(upload.result as Record<string,unknown>).supplierAutoCreated && ' • ⚠️ ספק לא זוהה'}
                </p>
              </div>
            )}
          </div>
          <button onClick={() => setUpload({ phase: 'idle' })} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
      )}

      {upload.phase === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-5 py-4 rounded-xl flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {upload.message}
          </div>
          <button onClick={() => setUpload({ phase: 'idle' })} className="text-red-400">✕</button>
        </div>
      )}

      {/* Missing amount alert banner */}
      {missingAmountInvoices.length > 0 && (
        <div className="flex items-center justify-between rounded-xl px-4 py-3 bg-amber-900/15 border border-amber-700/30">
          <div className="flex items-center gap-2 text-sm">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="font-semibold text-amber-300">{missingAmountInvoices.length} חשבוניות ללא סכום</span>
            <span className="text-amber-400/70">— לחץ על החשבונית להזנת הסכום ידנית</span>
          </div>
          <button
            onClick={() => openDetail(missingAmountInvoices[0], true)}
            className="text-xs font-semibold text-amber-300 hover:text-amber-200 underline"
          >
            הזן עכשיו
          </button>
        </div>
      )}

      {/* AI Search */}
      <div className="space-y-3">
        <div className="flex gap-2 items-center">
          <div className="relative flex-1 max-w-xl">
            <Sparkles className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-purple-400" />
            <input
              value={aiQuery}
              onChange={e => setAiQuery(e.target.value.slice(0, 500))}
              onKeyDown={e => e.key === 'Enter' && runAiSearch()}
              maxLength={500}
              placeholder='חפש בשפה טבעית — "ספק X מינואר" / "לא שולמו" / "מעל 500 ₪"'
              className="w-full pr-9 pl-4 py-2.5 text-sm border-2 border-purple-800/40 rounded-xl focus:outline-none focus:border-purple-400 bg-purple-900/10 text-[#e8e8e4] placeholder:text-[rgba(232,232,228,0.3)]"
            />
          </div>
          <button
            onClick={runAiSearch}
            disabled={aiSearching || !aiQuery.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50 transition-colors"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: 'white' }}
          >
            {aiSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {aiSearching ? 'מחפש...' : 'חפש'}
          </button>
          {aiFilters && (
            <button onClick={clearAiSearch} className="text-xs text-red-500 hover:text-red-700 font-medium px-2">
              נקה
            </button>
          )}
          <button
            onClick={() => setShowManual(v => !v)}
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm text-[rgba(232,232,228,0.42)] hover:bg-[rgba(201,162,39,0.06)] border border-[rgba(201,162,39,0.14)]"
            title="סינון ידני"
          >
            <SlidersHorizontal className="w-4 h-4" />
            {showManual ? 'הסתר' : 'סינון ידני'}
          </button>
        </div>

        {/* AI result badge */}
        {aiFilters && (
          <div className="flex flex-wrap gap-2 items-center text-xs">
            <span className="text-purple-600 font-medium">תוצאות AI:</span>
            {!!(aiFilters as Record<string,unknown>).supplierName && <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">ספק: {String((aiFilters as Record<string,unknown>).supplierName)}</span>}
            {!!(aiFilters as Record<string,unknown>).dateFrom && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">מ-{String((aiFilters as Record<string,unknown>).dateFrom)}</span>}
            {!!(aiFilters as Record<string,unknown>).dateTo && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">עד-{String((aiFilters as Record<string,unknown>).dateTo)}</span>}
            {(aiFilters as Record<string,unknown>).isPaid === false && <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">לא שולמו</span>}
            {(aiFilters as Record<string,unknown>).isPaid === true && <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full">שולמו</span>}
            {!!(aiFilters as Record<string,unknown>).minAmount && <span className="bg-[#1a1a20] text-[rgba(232,232,228,0.72)] px-2 py-0.5 rounded-full">מ-₪{String((aiFilters as Record<string,unknown>).minAmount)}</span>}
            <span className="text-gray-400">• {filtered.length} תוצאות</span>
          </div>
        )}

        {/* Manual filters (collapsible) */}
        {showManual && (
          <div className="flex flex-wrap items-center gap-3 p-3 bg-[#111116] rounded-xl border border-[rgba(201,162,39,0.14)]">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[rgba(232,232,228,0.4)]" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="חיפוש טקסט..."
                className="pr-9 pl-4 py-2 text-sm border border-[rgba(201,162,39,0.16)] rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 w-44 bg-[#141418] text-[#e8e8e4]"
              />
            </div>
            <select
              value={filterSupplier}
              onChange={e => setFilterSupplier(e.target.value)}
              className="py-2 px-3 text-sm border border-[rgba(201,162,39,0.16)] rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 text-[rgba(232,232,228,0.72)] bg-[#141418]"
            >
              <option value="">כל הספקים</option>
              {supplierOptions.map(s => <option key={s} value={s!}>{s}</option>)}
            </select>
            <DateRangePicker
              from={filterDateFrom} to={filterDateTo}
              onFromChange={setFilterDateFrom}
              onToChange={setFilterDateTo}
            />
            {hasFilters && (
              <button onClick={clearFilters} className="text-xs text-red-500 hover:text-red-700 font-medium underline">נקה</button>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <Card>
        {loading ? (
          <div className="p-8 text-center text-[rgba(232,232,228,0.4)]">טוען...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[rgba(201,162,39,0.14)]">
                  {['ספק', 'מספר', 'תאריך', 'סכום', 'ביטחון AI', 'סטטוס', ''].map(h => (
                    <th key={h} className="text-right text-xs font-medium text-[rgba(232,232,228,0.42)] px-6 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                {filtered.map(inv => {
                  const missingAmt = !inv.total_amount || inv.total_amount === 0;
                  return (
                  <tr key={inv.id}
                    className={`hover:bg-[rgba(201,162,39,0.04)] transition-colors cursor-pointer ${inv.is_duplicate ? 'bg-red-900/10' : missingAmt ? 'bg-amber-900/5' : ''}`}
                    onClick={() => openDetail(inv, missingAmt)}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#e8e8e4]">{inv.supplier_name || 'לא זוהה'}</span>
                        {inv.is_duplicate && <Badge variant="danger">כפולה</Badge>}
                        {!inv.supplier_name && <Badge variant="warning">ממתין לשיוך</Badge>}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-[rgba(232,232,228,0.6)]">{inv.invoice_number || '—'}</td>
                    <td className="px-6 py-4 text-sm text-[rgba(232,232,228,0.6)]">
                      {inv.invoice_date ? formatDate(inv.invoice_date) : '—'}
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold">
                      {missingAmt ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-400 bg-amber-900/20 border border-amber-700/30 px-2 py-0.5 rounded-full">
                          <AlertCircle className="w-3 h-3" /> ללא סכום
                        </span>
                      ) : (
                        <span className="text-[#e8e8e4]">{formatCurrency(inv.total_amount)}</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {inv.ai_confidence != null && (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-[#1a1a20] rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${inv.ai_confidence >= 0.9 ? 'bg-green-500' : inv.ai_confidence >= 0.7 ? 'bg-amber-500' : 'bg-red-500'}`}
                              style={{ width: `${inv.ai_confidence * 100}%` }}
                            />
                          </div>
                          <span className="text-xs text-[rgba(232,232,228,0.42)]">{Math.round(inv.ai_confidence * 100)}%</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {inv.is_paid ? (
                        <Badge variant="success">שולם</Badge>
                      ) : (inv.paid_amount ?? 0) > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="warning">שולם חלקית</Badge>
                          <span className="text-xs" style={{ color: 'rgba(232,232,228,0.4)' }}>
                            ₪{(inv.paid_amount ?? 0).toLocaleString('he-IL')} / {inv.total_amount != null ? `₪${inv.total_amount.toLocaleString('he-IL')}` : '—'}
                          </span>
                        </div>
                      ) : (
                        <Badge variant="warning">ממתין</Badge>
                      )}
                    </td>
                    <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button onClick={() => openDetail(inv)} className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.06)] text-[rgba(232,232,228,0.42)]" title="צפייה">
                          <Eye className="w-4 h-4" />
                        </button>
                        {(inv.image_urls?.length ?? 0) > 0 && (
                          <button
                            onClick={() => setImageViewer({ urls: inv.image_urls!, title: inv.supplier_name || inv.invoice_number || 'חשבונית' })}
                            className="p-1.5 rounded-lg hover:bg-[rgba(201,162,39,0.1)] text-[rgba(201,162,39,0.7)]"
                            title="צפייה בתמונת חשבונית"
                          >
                            <Camera className="w-4 h-4" />
                          </button>
                        )}
                        <button onClick={() => openDetail(inv, true)} className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-500" title="עריכה">
                          <Pencil className="w-4 h-4" />
                        </button>
                        {!inv.is_paid && (
                          <>
                            <button onClick={() => openPartialPay(inv.id, inv.paid_amount)} className="p-1.5 rounded-lg hover:bg-amber-50 text-amber-500" title="תשלום חלקי">
                              <Plus className="w-4 h-4" />
                            </button>
                            <button onClick={() => markPaid(inv.id)} className="p-1.5 rounded-lg hover:bg-green-50 text-green-600" title="סמן כשולם">
                              <CheckCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && !loading && (
              <div className="py-16 text-center">
                <FileText className="w-10 h-10 text-[rgba(232,232,228,0.2)] mx-auto mb-3" />
                <p className="text-[rgba(232,232,228,0.4)] text-sm">אין חשבוניות — לחץ &quot;סרוק חשבונית&quot; להתחלה</p>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Supplier price trends */}
      {trends.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>מגמת מחירים לפי ספק</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {trends.map(t => {
                const pts    = t.amounts.slice(-8); // last 8 data points
                const ptsMax = Math.max(...pts);
                const ptsMin = Math.min(...pts);
                const ptsRange = ptsMax - ptsMin || 1;
                const W = 120, H = 40, pad = 4;
                const svgPts = pts.map((v, i) => {
                  const x = pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2);
                  const y = H - pad - ((v - ptsMin) / ptsRange) * (H - pad * 2);
                  return `${x},${y}`;
                }).join(' ');

                const trendColor = t.trend === 'up' ? 'text-red-400 bg-red-900/10 border-red-700/30'
                  : t.trend === 'down' ? 'text-green-400 bg-green-900/10 border-green-700/30'
                  : 'text-[rgba(232,232,228,0.42)] bg-[#141418] border-[rgba(201,162,39,0.14)]';
                const lineColor  = t.trend === 'up' ? '#ef4444' : t.trend === 'down' ? '#22c55e' : '#94a3b8';
                const TrendIcon  = t.trend === 'up' ? TrendingUp : t.trend === 'down' ? TrendingDown : Minus;

                return (
                  <div key={t.supplierId} className={`rounded-xl border p-4 space-y-3 ${trendColor}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-[#e8e8e4] leading-tight">{t.supplierName}</p>
                        <p className="text-xs text-[rgba(232,232,228,0.42)] mt-0.5">{t.amounts.length} חשבוניות</p>
                      </div>
                      <div className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full border ${trendColor}`}>
                        <TrendIcon className="w-3.5 h-3.5" />
                        {t.pctChange > 0 ? '+' : ''}{t.pctChange}%
                      </div>
                    </div>

                    {/* Sparkline */}
                    <svg width={W} height={H} className="w-full" viewBox={`0 0 ${W} ${H}`}>
                      <polyline
                        points={svgPts}
                        fill="none"
                        stroke={lineColor}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      {pts.map((v, i) => {
                        const x = pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2);
                        const y = H - pad - ((v - ptsMin) / ptsRange) * (H - pad * 2);
                        return i === pts.length - 1
                          ? <circle key={i} cx={x} cy={y} r="3" fill={lineColor} />
                          : null;
                      })}
                    </svg>

                    {/* Last vs prev */}
                    <div className="flex items-center justify-between text-xs">
                      <div>
                        <span className="text-[rgba(232,232,228,0.4)]">קודם </span>
                        <span className="font-medium text-[rgba(232,232,228,0.72)]">{formatCurrency(t.prevAmount)}</span>
                      </div>
                      <div className="text-[rgba(232,232,228,0.3)]">→</div>
                      <div>
                        <span className="text-[rgba(232,232,228,0.4)]">אחרון </span>
                        <span className="font-semibold text-[#e8e8e4]">{formatCurrency(t.lastAmount)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Multipage confirm modal */}
      <Modal
        open={upload.phase === 'multipage_confirm'}
        onClose={() => setUpload({ phase: 'idle' })}
        title="חשבונית מרובת עמודים"
        size="sm"
      >
        {upload.phase === 'multipage_confirm' && (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600">
              הועלו <strong>{upload.pagesCount}</strong> עמודים. כיצד לעבד?
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => confirmMerge(true)}
                className="flex flex-col items-center gap-2 p-4 border-2 border-blue-700/40 rounded-xl hover:border-blue-500 hover:bg-blue-900/20 transition-colors"
              >
                <Merge className="w-6 h-6 text-blue-400" />
                <span className="text-sm font-medium text-[#e8e8e4]">חשבונית אחת</span>
                <span className="text-xs text-[rgba(232,232,228,0.42)]">כל העמודים = חשבונית אחת</span>
              </button>
              <button
                onClick={() => confirmMerge(false)}
                className="flex flex-col items-center gap-2 p-4 border-2 border-[rgba(201,162,39,0.2)] rounded-xl hover:border-[rgba(201,162,39,0.4)] hover:bg-[rgba(201,162,39,0.06)] transition-colors"
              >
                <SplitSquareHorizontal className="w-6 h-6 text-[rgba(232,232,228,0.6)]" />
                <span className="text-sm font-medium text-[#e8e8e4]">חשבוניות נפרדות</span>
                <span className="text-xs text-[rgba(232,232,228,0.42)]">כל עמוד = חשבונית נפרדת</span>
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Invoice detail / edit modal */}
      <Modal
        open={!!selected}
        onClose={() => { setSelected(null); setEditMode(false); }}
        title={editMode ? 'עריכת חשבונית' : 'פרטי חשבונית'}
        size="lg"
      >
        {selected && (
          <div className="p-6 space-y-5">

            {/* ── תצוגת מידע ── */}
            {!editMode && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    ['ספק',           selected.supplier_name  || '—'],
                    ['מספר חשבונית', selected.invoice_number || '—'],
                    ['תאריך',         selected.invoice_date   ? formatDate(selected.invoice_date) : '—'],
                    ['סכום',          selected.total_amount   ? formatCurrency(selected.total_amount) : '—'],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-[#1a1a20] rounded-lg px-3 py-2">
                      <p className="text-xs text-[rgba(232,232,228,0.4)] mb-0.5">{label}</p>
                      <p className="font-medium text-[#e8e8e4]">{value}</p>
                    </div>
                  ))}
                  <div className="bg-[#1a1a20] rounded-lg px-3 py-2">
                    <p className="text-xs text-[rgba(232,232,228,0.4)] mb-0.5">סטטוס</p>
                    {selected.is_paid ? (
                      <Badge variant="success">שולם</Badge>
                    ) : (selected.paid_amount ?? 0) > 0 ? (
                      <div className="space-y-1">
                        <Badge variant="warning">שולם חלקית</Badge>
                        <p className="text-xs text-[rgba(232,232,228,0.55)]">
                          שולם: <strong>₪{(selected.paid_amount ?? 0).toLocaleString('he-IL')}</strong>
                        </p>
                        <p className="text-xs text-amber-400">
                          נותר: <strong>₪{Math.max(0, selected.total_amount - (selected.paid_amount ?? 0)).toLocaleString('he-IL')}</strong>
                        </p>
                      </div>
                    ) : (
                      <Badge variant="warning">ממתין לתשלום</Badge>
                    )}
                  </div>
                  {selected.ai_confidence != null && (
                    <div className="bg-[#1a1a20] rounded-lg px-3 py-2">
                      <p className="text-xs text-[rgba(232,232,228,0.4)] mb-0.5">ביטחון AI</p>
                      <p className={`font-medium ${selected.ai_confidence < 0.7 ? 'text-amber-600' : 'text-green-600'}`}>
                        {Math.round(selected.ai_confidence * 100)}%
                      </p>
                    </div>
                  )}
                </div>

                {selected.items && selected.items.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-[rgba(232,232,228,0.42)] uppercase mb-2">פריטים</p>
                    <div className="border border-[rgba(201,162,39,0.14)] rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-[#111116]">
                          <tr>
                            {['פריט', 'כמות', 'יח׳', 'מחיר', 'סה״כ'].map(h => (
                              <th key={h} className="text-right text-xs text-[rgba(232,232,228,0.42)] px-3 py-2">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                          {selected.items.map((item, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 font-medium text-[#e8e8e4]">{item.name}</td>
                              <td className="px-3 py-2 text-[rgba(232,232,228,0.6)]">{item.qty ?? '—'}</td>
                              <td className="px-3 py-2 text-[rgba(232,232,228,0.6)]">{item.unit || '—'}</td>
                              <td className="px-3 py-2">{item.unit_price  ? formatCurrency(item.unit_price)  : '—'}</td>
                              <td className="px-3 py-2 font-medium">{item.total_price ? formatCurrency(item.total_price) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* badge קטגוריה */}
                {(() => {
                  const cat = (selected as any).invoice_category || 'food';
                  const map: Record<string, { icon: string; label: string; cls: string }> = {
                    food:      { icon: '🍽', label: 'מזון — עלות סחורה (COGS)', cls: 'bg-green-900/20 border-green-700/30 text-green-300' },
                    cleaning:  { icon: '🧹', label: 'ניקיון — הוצאה תפעולית',  cls: 'bg-blue-900/20 border-blue-700/30 text-blue-300' },
                    equipment: { icon: '🔧', label: 'ציוד — הוצאה תפעולית',    cls: 'bg-purple-900/20 border-purple-700/30 text-purple-300' },
                    other:     { icon: '📦', label: 'שונות — הוצאה תפעולית',   cls: 'bg-gray-800/40 border-gray-600/30 text-gray-300' },
                  };
                  const c = map[cat] || map.food;
                  return (
                    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${c.cls}`}>
                      <span>{c.icon}</span><span className="font-medium">{c.label}</span>
                    </div>
                  );
                })()}

                {selected.notes && (
                  <div className="bg-amber-900/10 border border-amber-700/20 rounded-lg p-3 text-sm text-[rgba(232,232,228,0.72)]">
                    <p className="text-xs font-medium text-[rgba(232,232,228,0.42)] mb-1">הערות</p>
                    <p>{selected.notes}</p>
                  </div>
                )}
              </>
            )}

            {/* ── מצב עריכה ── */}
            {editMode && (
              <div className="space-y-4">
                {(!editForm.total_amount || editForm.total_amount === '0') && (
                  <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-amber-900/20 border border-amber-700/30 text-sm text-amber-300">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    הסכום לא זוהה אוטומטית — אנא הזן את הסכום הכולל של החשבונית
                  </div>
                )}
                {/* ספק */}
                {/* קטגוריית חשבונית — קובעת אם הסכום ייחשב כ-COGS (מזון) או הוצאה תפעולית */}
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-[rgba(232,232,228,0.8)]">סוג חשבונית <span className="text-amber-400">*</span></label>
                  <div className="grid grid-cols-4 gap-2">
                    {([
                      { key: 'food',      icon: '🍽', label: 'מזון', sub: 'עלות סחורה' },
                      { key: 'cleaning',  icon: '🧹', label: 'ניקיון', sub: 'הוצאה' },
                      { key: 'equipment', icon: '🔧', label: 'ציוד', sub: 'הוצאה' },
                      { key: 'other',     icon: '📦', label: 'שונות', sub: 'הוצאה' },
                    ] as const).map(cat => (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => setEditForm(f => ({ ...f, invoice_category: cat.key }))}
                        className={`flex flex-col items-center gap-0.5 py-2.5 px-1 rounded-xl border-2 text-center transition-all ${
                          editForm.invoice_category === cat.key
                            ? 'border-amber-400 bg-amber-400/10 text-amber-300'
                            : 'border-[rgba(201,162,39,0.16)] bg-[#0f0f14] text-[rgba(232,232,228,0.5)] hover:border-[rgba(201,162,39,0.4)]'
                        }`}
                      >
                        <span className="text-lg leading-none">{cat.icon}</span>
                        <span className="text-xs font-semibold leading-none mt-1">{cat.label}</span>
                        <span className="text-[10px] leading-none opacity-60">{cat.sub}</span>
                      </button>
                    ))}
                  </div>
                  {editForm.invoice_category !== 'food' && (
                    <p className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2">
                      חשבונית זו תיכנס להוצאות תפעוליות ולא תחושב כעלות סחורה (COGS)
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-medium text-[rgba(232,232,228,0.6)]">ספק</label>
                  <select
                    value={editForm.supplier_id || '__manual__'}
                    onChange={e => {
                      const val = e.target.value;
                      if (val === '__manual__') {
                        setEditForm(f => ({ ...f, supplier_id: '' }));
                      } else {
                        const sup = suppliersList.find(s => s.id === val);
                        setEditForm(f => ({ ...f, supplier_id: val, supplier_name: sup?.name || '' }));
                      }
                    }}
                    className="w-full text-sm border border-[rgba(201,162,39,0.16)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]"
                  >
                    <option value="__manual__">— הקלד שם ידנית —</option>
                    {suppliersList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {!editForm.supplier_id && (
                    <input
                      value={editForm.supplier_name}
                      onChange={e => setEditForm(f => ({ ...f, supplier_name: e.target.value }))}
                      placeholder="שם ספק..."
                      className="w-full text-sm border border-[rgba(201,162,39,0.16)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]"
                    />
                  )}
                </div>

                {/* שדות בסיסיים */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-[rgba(232,232,228,0.6)]">מספר חשבונית</label>
                    <input value={editForm.invoice_number}
                      onChange={e => setEditForm(f => ({ ...f, invoice_number: e.target.value }))}
                      className="w-full text-sm border border-[rgba(201,162,39,0.16)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]" />
                  </div>
                  <div className="space-y-1">
                    <DatePicker
                      label="תאריך"
                      value={editForm.invoice_date}
                      onChange={v => setEditForm(f => ({ ...f, invoice_date: v }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-[rgba(232,232,228,0.6)]">
                      סכום (₪)
                      {(!editForm.total_amount || editForm.total_amount === '0') && (
                        <span className="mr-1 text-amber-400 font-semibold">← נדרש</span>
                      )}
                    </label>
                    <input
                      type="number" step="0.01"
                      value={editForm.total_amount}
                      onChange={e => setEditForm(f => ({ ...f, total_amount: e.target.value }))}
                      autoFocus={!editForm.total_amount || editForm.total_amount === '0'}
                      className={`w-full text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-1 bg-[#0f0f14] text-[#e8e8e4] ${
                        (!editForm.total_amount || editForm.total_amount === '0')
                          ? 'border-2 border-amber-500 focus:ring-amber-500'
                          : 'border border-[rgba(201,162,39,0.16)] focus:ring-blue-500'
                      }`}
                      placeholder="הזן סכום חשבונית..."
                    />
                  </div>
                </div>

                {/* הערות */}
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-[rgba(232,232,228,0.6)]">הערות</label>
                  <textarea
                    value={editForm.notes}
                    onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2}
                    className="w-full text-sm border border-[rgba(201,162,39,0.16)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none bg-[#0f0f14] text-[#e8e8e4]"
                    placeholder="הערות אופציונליות..."
                  />
                </div>

                {/* פריטים */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-[rgba(232,232,228,0.6)]">פריטים</label>
                    <button
                      onClick={() => setEditForm(f => ({
                        ...f,
                        items: [...f.items, { _key: crypto.randomUUID(), name: '', qty: '', unit: '', unit_price: '', total_price: '', item_type: 'מזון' }],
                      }))}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Plus className="w-3.5 h-3.5" /> הוסף פריט
                    </button>
                  </div>
                  {editForm.items.length > 0 && (
                    <div className="border border-[rgba(201,162,39,0.14)] rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-[#111116]">
                          <tr>
                            {['שם פריט', 'כמות', 'יחידה', 'מחיר ליח׳', 'סה״כ', 'קטגוריה', ''].map(h => (
                              <th key={h} className="text-right font-medium text-[rgba(232,232,228,0.42)] px-2 py-2">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[rgba(201,162,39,0.08)]">
                          {editForm.items.map((item, i) => (
                            <tr key={item._key}>
                              <td className="px-2 py-1.5">
                                <input value={item.name}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], name: e.target.value }; return { ...f, items }; })}
                                  className="w-full border border-[rgba(201,162,39,0.16)] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[100px] bg-[#0f0f14] text-[#e8e8e4]"
                                  placeholder="שם פריט" />
                              </td>
                              <td className="px-2 py-1.5">
                                <input type="number" value={item.qty}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], qty: e.target.value }; return { ...f, items }; })}
                                  className="w-16 border border-[rgba(201,162,39,0.16)] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]" />
                              </td>
                              <td className="px-2 py-1.5">
                                <input value={item.unit}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], unit: e.target.value }; return { ...f, items }; })}
                                  className="w-16 border border-[rgba(201,162,39,0.16)] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]"
                                  placeholder="יח׳" />
                              </td>
                              <td className="px-2 py-1.5">
                                <input type="number" step="0.01" value={item.unit_price}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], unit_price: e.target.value }; return { ...f, items }; })}
                                  className="w-20 border border-[rgba(201,162,39,0.16)] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]" />
                              </td>
                              <td className="px-2 py-1.5">
                                <input type="number" step="0.01" value={item.total_price}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], total_price: e.target.value }; return { ...f, items }; })}
                                  className="w-20 border border-[rgba(201,162,39,0.16)] rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]" />
                              </td>
                              <td className="px-2 py-1.5">
                                <select
                                  value={item.item_type}
                                  onChange={e => setEditForm(f => { const items = [...f.items]; items[i] = { ...items[i], item_type: e.target.value }; return { ...f, items }; })}
                                  className="border border-[rgba(201,162,39,0.16)] rounded px-1 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-[#0f0f14] text-[#e8e8e4]"
                                >
                                  <option value="מזון">🍽 מזון</option>
                                  <option value="ניקיון">🧹 ניקיון</option>
                                  <option value="ציוד">🔧 ציוד</option>
                                  <option value="שונות">📦 שונות</option>
                                </select>
                              </td>
                              <td className="px-2 py-1.5">
                                <button
                                  onClick={() => setEditForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}
                                  className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* כפתורי פעולה */}
            <div className="flex items-center justify-between pt-3 border-t border-[rgba(201,162,39,0.14)]">
              {editMode ? (
                <>
                  <button onClick={() => setEditMode(false)} className="text-sm text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.7)]">
                    ביטול
                  </button>
                  <Button onClick={saveEdit} loading={saving}>
                    <CheckCircle className="w-4 h-4" /> {selected?.approved_at ? 'שמור שינויים' : 'אשר וקבל למלאי'}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditMode(true)}
                      className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Pencil className="w-4 h-4" /> ערוך
                    </button>
                    <button
                      onClick={() => deleteInvoice(selected.id)}
                      className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      <Trash2 className="w-4 h-4" /> מחק
                    </button>
                  </div>
                  <div className="flex gap-3 flex-wrap">
                    <Button variant="outline" onClick={() => { setSelected(null); setEditMode(false); }}>סגור</Button>
                    {!selected.approved_at && (
                      <Button onClick={saveEdit} loading={saving}>
                        <CheckCircle className="w-4 h-4" /> אשר וקבל למלאי
                      </Button>
                    )}
                    {!selected.is_paid && (
                      <>
                        <Button variant="outline" onClick={() => openPartialPay(selected.id, selected.paid_amount)}>
                          <Plus className="w-4 h-4" /> תשלום חלקי
                        </Button>
                        <Button variant="outline" onClick={async () => { if (await markPaid(selected.id)) setSelected(null); }}>
                          <CheckCircle className="w-4 h-4" /> סמן כשולם
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

          </div>
        )}
      </Modal>

      {/* ── Partial Payment Modal ── */}
      {partialPayInvoiceId && (() => {
        const inv = invoices.find(i => i.id === partialPayInvoiceId);
        const remaining = inv ? Math.max(0, inv.total_amount - (inv.paid_amount ?? 0)) : 0;
        const entered = parseFloat(partialAmount) || 0;
        return (
          <Modal open onClose={() => { setPartialPayInvoiceId(null); setPartialAmount(''); }} title="תשלום חלקי">
            <div className="space-y-4 p-1">
              {inv && (
                <div className="rounded-xl p-3 space-y-1" style={{ background: 'rgba(201,162,39,0.06)', border: '1px solid rgba(201,162,39,0.15)' }}>
                  <p className="text-sm text-[rgba(232,232,228,0.6)]">
                    סכום חשבונית: <strong className="text-[rgba(232,232,228,0.9)]">₪{inv.total_amount.toLocaleString('he-IL')}</strong>
                  </p>
                  {(inv.paid_amount ?? 0) > 0 && (
                    <p className="text-sm text-[rgba(232,232,228,0.6)]">
                      שולם עד כה: <strong className="text-green-400">₪{(inv.paid_amount ?? 0).toLocaleString('he-IL')}</strong>
                    </p>
                  )}
                  <p className="text-sm text-[rgba(232,232,228,0.6)]">
                    נותר לתשלום: <strong className="text-amber-400">₪{remaining.toLocaleString('he-IL')}</strong>
                  </p>
                </div>
              )}
              <div>
                <label className="block text-xs text-[rgba(232,232,228,0.5)] mb-1.5">סכום ששולם (סה״כ)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={partialAmount}
                  onChange={e => setPartialAmount(e.target.value)}
                  placeholder="הזן סכום..."
                  className="w-full rounded-xl px-3 py-2.5 text-sm"
                  style={{ background: '#1a1a20', border: '1px solid rgba(201,162,39,0.2)', color: 'rgba(232,232,228,0.9)', outline: 'none' }}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') submitPartialPayment(); }}
                />
                {entered > 0 && inv && (
                  <p className="text-xs mt-1.5 text-amber-400">
                    נותר לאחר תשלום: ₪{Math.max(0, inv.total_amount - entered).toLocaleString('he-IL')}
                  </p>
                )}
              </div>
              <div className="flex gap-3 pt-1">
                <Button variant="outline" onClick={() => { setPartialPayInvoiceId(null); setPartialAmount(''); }}>ביטול</Button>
                <Button onClick={submitPartialPayment} disabled={!partialAmount || parseFloat(partialAmount) < 0}>
                  <CheckCircle className="w-4 h-4" /> אשר תשלום
                </Button>
              </div>
            </div>
          </Modal>
        );
      })()}
      {/* ── Invoice image viewer lightbox ── */}
      {imageViewer && (
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.92)' }}
          onClick={() => setImageViewer(null)}
        >
          <div className="w-full max-w-3xl flex flex-col items-center gap-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between w-full">
              <p className="text-white font-semibold">{imageViewer.title}</p>
              <button className="p-2 rounded-full text-white hover:bg-white/10" onClick={() => setImageViewer(null)}>
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <div className="flex flex-col gap-4 w-full items-center">
              {imageViewer.urls.map((raw, i) => (
                <img
                  key={i}
                  src={invImgUrl(raw)}
                  alt={`עמוד ${i + 1}`}
                  className="max-w-full max-h-[82vh] rounded-xl object-contain"
                  style={{ border: '1px solid rgba(201,162,39,0.3)' }}
                />
              ))}
            </div>
            {imageViewer.urls.length > 1 && (
              <p className="text-sm text-[rgba(232,232,228,0.4)]">{imageViewer.urls.length} עמודים</p>
            )}
          </div>
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}
