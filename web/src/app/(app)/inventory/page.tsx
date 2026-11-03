'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDebounce } from '@/hooks/useDebounce';
import {
  Plus, AlertTriangle, Search, ArrowUpDown, Pencil, Trash2,
  Download, ChevronDown, ChevronUp, Truck, LayoutList, RefreshCw, CalendarX, Mic, MicOff,
  History, Info } from 'lucide-react';
import { useSyncEvent } from '@/context/SyncContext';
import { useAppDialog } from '@/context/AppDialogContext';
import { inventoryApi, exportApi, invoicesApi } from '@/lib/api';
import { formatCurrency, formatNumber, getErrorMessage, downloadBlob } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { DatePicker, DateRangePicker } from '@/components/ui/DatePicker';
import { StatCard } from '@/components/ui/StatCard';
import { Package, DollarSign } from 'lucide-react';
import type { InventoryItem } from '@/types';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { daysAgoIL, todayIL } from '@/lib/dates';

interface Category { id: string; name: string; }

interface ConsumptionItem { itemId: string; name: string; unit: string; consumedQty: number; consumedValue: number; notInRecipe?: boolean; noSalesData?: boolean; }
interface ConsumptionAnalysis {
  dateFrom: string; dateTo: string;
  itemDataCoveragePct: number;
  totalConsumedValue: number;
  items: ConsumptionItem[];
}

interface SupplierGroup {
  supplier_id: string | null;
  supplier_name: string;
  items: (InventoryItem & { supplier_id?: string | null; supplier_name?: string })[];
}

// ── Unit dropdown options ───────────────────────────────────────────────────
// Older rows carry units this list never offered — "יח'", "יח", "ל". A <select>
// whose value matches no <option> renders the FIRST option instead, so editing
// one of those items showed 'ק"ג' while the form state still held "יח'";
// saving without touching the dropdown wrote the old unit straight back and
// looked like the change had been silently discarded. Always include whatever
// the item actually has, so the control can never display a unit it isn't
// holding.
const STANDARD_UNITS = ['ק"ג', 'גרם', 'ליטר', 'מ"ל', 'יחידה', 'קרטון', 'שקית', 'תריסר'];
const UNIT_OPTIONS = (current?: string) =>
  current && !STANDARD_UNITS.includes(current) ? [current, ...STANDARD_UNITS] : STANDARD_UNITS;

// ── Supplier accordion section ──────────────────────────────────────────────
function SupplierSection({
  group, onEdit, onDelete, onTransaction, onDeleteSupplier,
}: {
  group: SupplierGroup;
  onEdit: (item: InventoryItem) => void;
  onDelete: (item: InventoryItem) => void;
  onTransaction: (item: InventoryItem) => void;
  onDeleteSupplier: (group: SupplierGroup) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasLow = group.items.some(i => i.is_low);

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)', background: '#141418' }}>
      <div className="w-full flex items-center justify-between px-5 py-4" style={{ color: '#e8e8e4' }}>
        <button onClick={() => setOpen(v => !v)} className="flex items-center gap-3 flex-1 text-right">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(96,184,232,0.12)' }}>
            <Truck className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-right">
            <p className="font-bold" style={{ color: '#e8e8e4' }}>{group.supplier_name}</p>
            <p className="text-xs" style={{ color: '#9aa0ab' }}>{group.items.length} פריטים</p>
          </div>
          {hasLow && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(217,119,6,0.15)', color: '#fbbf24' }}>
              מלאי נמוך
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onDeleteSupplier(group)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: '#f87171' }}
            title="מחק את כל פריטי הספק"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={() => setOpen(v => !v)}>
            {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="overflow-x-auto" style={{ borderTop: '1px solid rgba(201,162,39,0.1)' }}>
          <table className="w-full">
            <thead>
              <tr style={{ background: '#111116' }}>
                {['פריט', 'כמות', 'עלות ליחידה', 'שווי', 'תפוגה', 'פעולות'].map(h => (
                  <th key={h} className="text-right text-xs font-medium px-5 py-2.5" style={{ color: '#9aa0ab' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'rgba(201,162,39,0.08)' }}>
              {(group.items ?? []).map(item => (
                <tr key={item.id} className="transition-colors" style={{ background: item.is_expired ? 'rgba(239,68,68,0.08)' : item.is_expiring_soon ? 'rgba(245,158,11,0.06)' : item.is_low ? 'rgba(245,158,11,0.04)' : 'transparent' }}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      {item.is_expired && <CalendarX className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                      {!item.is_expired && item.is_expiring_soon && <CalendarX className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                      {!item.is_expiring_soon && item.is_low && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                      <span className="text-sm font-medium" style={{ color: '#e8e8e4' }}>{item.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-sm font-semibold" style={{ color: item.is_low ? '#fbbf24' : '#e8e8e4' }}>
                      {formatNumber(item.current_qty)} {item.unit}
                    </span>
                    {item.purchase_unit && (item.units_per_purchase ?? 1) > 1 && (
                      <span className="block text-xs" style={{ color: '#6b7280' }}>
                        ({(item.current_qty / (item.units_per_purchase ?? 1)).toLocaleString('he-IL', { maximumFractionDigits: 2 })} {item.purchase_unit})
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-sm" style={{ color: '#9aa0ab' }}>{formatCurrency(item.cost_per_unit)}</td>
                  <td className="px-5 py-3 text-sm font-medium" style={{ color: '#e8e8e4' }}>
                    {formatCurrency(item.current_qty * item.cost_per_unit)}
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {item.expiry_date ? (
                      <span className="font-semibold" style={{ color: item.is_expired ? '#f87171' : item.is_expiring_soon ? '#fb923c' : '#9aa0ab' }}>
                        {new Date(item.expiry_date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                        {item.is_expired && ' (פג!)'}
                      </span>
                    ) : <span style={{ color: '#6b7280' }}>—</span>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => onTransaction(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#9aa0ab' }} title="עדכן כמות">
                        <ArrowUpDown className="w-4 h-4" />
                      </button>
                      <button onClick={() => onEdit(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#818cf8' }} title="עריכה">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => onDelete(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#f87171' }} title="מחק">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function InventoryPage() {
  const { confirm, toast } = useAppDialog();
  const searchParams = useSearchParams();
  const [setupMode, setSetupMode] = useState(false);
  const [view, setView] = useState<'list' | 'supplier'>('supplier');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [supplierGroups, setSupplierGroups] = useState<SupplierGroup[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [inventoryValue, setInventoryValue] = useState(0);
  const [expiringItems, setExpiringItems] = useState<{ id: string; name: string; unit: string; current_qty: number; expiry_date: string; days_until_expiry: number }[]>([]);

  // Transaction modal
  const [txModal, setTxModal] = useState<InventoryItem | null>(null);
  const [txType, setTxType] = useState<'add' | 'remove' | 'waste'>('add');
  const [txQty, setTxQty] = useState('');
  const [txNote, setTxNote] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [txInPurchaseUnits, setTxInPurchaseUnits] = useState(false);

  // Batch waste modal — "מלאי שנזרק"
  const [wasteModal, setWasteModal]   = useState(false);
  const [wasteDate, setWasteDate]     = useState(() => todayIL());
  const [wasteQtys, setWasteQtys]     = useState<Record<string, string>>({});
  const [wasteSearch, setWasteSearch] = useState('');
  const [wasteLoading, setWasteLoading] = useState(false);

  // Voice input
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');

  // Item add/edit modal
  const [itemModal, setItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [itemForm, setItemForm] = useState({
    name: '', unit: 'ק"ג', qty: '', cost_per_unit: '', category_id: '', expiry_date: '',
    min_qty: '', max_qty: '', item_type: 'מזון', purchase_unit: '', units_per_purchase: '',
  });
  const [itemLoading, setItemLoading] = useState(false);
  const [itemError, setItemError] = useState('');
  const [exporting, setExporting]   = useState(false);
  const [syncing, setSyncing]       = useState(false);
  const [syncSuccess, setSyncSuccess] = useState<{ items: number } | null>(null);

  // Sync preview modal
  type InvOption = { id: string; name: string };
  type FuzzyRow  = { invoiceName: string; invoiceNameKey: string; suggestedId: string; suggestedName: string; score: number; price: number; qty: number; unit: string };
  type NewRow    = { invoiceName: string; invoiceNameKey: string; qty: number; price: number; unit: string };
  type ExactRow  = { invoiceName: string; inventoryId: string; inventoryName: string; price: number };
  type PreviewData = { exact: ExactRow[]; fuzzy: FuzzyRow[]; new: NewRow[]; inventory: InvOption[] };

  const [syncPreview, setSyncPreview]       = useState<PreviewData | null>(null);
  const [syncPreviewLoading, setSyncPreviewLoading] = useState(false);
  const [syncApplying, setSyncApplying]     = useState(false);
  // user decisions for fuzzy rows: key=invoiceNameKey, value=inventoryId|'new'
  const [fuzzyDecisions, setFuzzyDecisions] = useState<Record<string, string>>({});

  // Historical consumption analysis
  const [consumptionOpen, setConsumptionOpen] = useState(false);
  const [consumptionFrom, setConsumptionFrom] = useState('');
  const [consumptionTo, setConsumptionTo] = useState('');
  const [consumptionLoading, setConsumptionLoading] = useState(false);
  const [consumptionError, setConsumptionError] = useState('');
  const [consumption, setConsumption] = useState<ConsumptionAnalysis | null>(null);

  const runConsumptionAnalysis = async () => {
    if (!consumptionFrom || !consumptionTo) { setConsumptionError('יש לבחור טווח תאריכים'); return; }
    setConsumptionLoading(true); setConsumptionError('');
    try {
      const { data } = await inventoryApi.consumptionAnalysis(consumptionFrom, consumptionTo);
      setConsumption(data);
    } catch (err) {
      setConsumptionError(getErrorMessage(err));
      setConsumption(null);
    } finally { setConsumptionLoading(false); }
  };

  const load = useCallback(() =>
    Promise.all([
      inventoryApi.list(),
      inventoryApi.value(),
      inventoryApi.categories(),
      inventoryApi.bySupplier(),
      inventoryApi.expiring(3),
    ]).then(([list, val, cats, bySupplier, expiring]) => {
      setItems(list.data.items || []);
      setInventoryValue(val.data.total_value || 0);
      setCategories(cats.data.categories || cats.data || []);
      setSupplierGroups(bySupplier.data.suppliers || []);
      setExpiringItems(expiring.data.items || []);
      setLoading(false);
    }).catch(() => setLoading(false)),
  []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (searchParams.get('setup') === '1') setSetupMode(true); }, [searchParams]);
  // low_inventory was published by sync.service.js and nothing listened to it,
  // so a stock item crossing its threshold reached the notification bell but left
  // the numbers on this page stale until a manual refresh.
  useSyncEvent(['inventory.updated', 'waste_recorded', 'low_inventory'], load);

  const filtered = useMemo(() => items.filter(i =>
    i.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
    (i.category_name || '').toLowerCase().includes(debouncedSearch.toLowerCase())
  ), [items, debouncedSearch]);

  const filteredGroups = useMemo<SupplierGroup[]>(() => debouncedSearch
    ? supplierGroups.map(g => ({
        ...g,
        items: g.items.filter(i => i.name.toLowerCase().includes(debouncedSearch.toLowerCase())),
      })).filter(g => g.items.length > 0)
    : supplierGroups,
  [supplierGroups, debouncedSearch]);

  const lowItems = items.filter(i => i.is_low);

  const openTransaction = (item: InventoryItem) => {
    setTxModal(item); setTxType('add'); setTxQty(''); setTxNote('');
    setVoiceTranscript(''); setVoiceActive(false);
  };

  const startVoice = () => {
    if (voiceActive) return;
    interface SpeechRecognitionInstance {
      lang: string; interimResults: boolean; maxAlternatives: number;
      onresult: ((e: { results: { [n: number]: { [n: number]: { transcript: string } } } }) => void) | null;
      onerror: (() => void) | null; onend: (() => void) | null;
      start: () => void; stop: () => void;
    }
    type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
    const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    const SpeechRecognitionCls = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognitionCls) { toast('דפדפן זה אינו תומך בזיהוי קול'); return; }

    const rec: SpeechRecognitionInstance = new SpeechRecognitionCls();
    rec.lang = 'he-IL';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    setVoiceActive(true);
    setVoiceTranscript('');

    rec.onresult = (e: { results: { [n: number]: { [n: number]: { transcript: string } } } }) => {
      const text = e.results[0][0].transcript;
      setVoiceTranscript(text);

      // Parse Hebrew voice: "הוסף 5", "הפחת שתיים", "בזבוז 3 קילו", "חמישה"
      const hebrewNums: Record<string, number> = {
        'אחת':1,'אחד':1,'שתיים':2,'שניים':2,'שלוש':3,'שלושה':3,'ארבע':4,'ארבעה':4,
        'חמש':5,'חמישה':5,'שש':6,'שישה':6,'שבע':7,'שבעה':7,'שמונה':8,'תשע':9,'תשעה':9,'עשר':10,'עשרה':10,
        'עשרים':20,'שלושים':30,'ארבעים':40,'חמישים':50,'מאה':100,'מאתיים':200,
      };

      let qty = 0;
      // try numeric match first
      const numMatch = text.match(/[\d.]+/);
      if (numMatch) qty = parseFloat(numMatch[0]);
      else {
        for (const [word, val] of Object.entries(hebrewNums)) {
          if (text.includes(word)) { qty = val; break; }
        }
      }

      if (qty > 0) setTxQty(String(qty));

      if (text.includes('הפחת') || text.includes('הסר') || text.includes('הוצא')) setTxType('remove');
      else if (text.includes('בזבוז') || text.includes('פח') || text.includes('אבד')) setTxType('waste');
      else if (text.includes('הוסף') || text.includes('קיבלתי') || text.includes('הגיע')) setTxType('add');
    };

    rec.onerror = () => { setVoiceActive(false); };
    rec.onend   = () => { setVoiceActive(false); };

    rec.start();
  };

  const doTransaction = async () => {
    if (!txModal || !txQty) return;
    const inputQty = parseFloat(txQty);
    if (!(inputQty > 0)) { toast('הכמות חייבת להיות מספר חיובי'); return; }
    // Convert from purchase units to base units if the toggle is active
    const unitsPerPurch = txModal.units_per_purchase ?? 1;
    const qty = txInPurchaseUnits && txModal.purchase_unit && unitsPerPurch > 1
      ? inputQty * unitsPerPurch
      : inputQty;
    setTxLoading(true);
    try {
      await inventoryApi.transaction(txModal.id, { type: txType, qty, note: txNote });
      setTxModal(null); setTxQty(''); setTxNote(''); setTxInPurchaseUnits(false);
      load();
    } catch (err) {
      toast(getErrorMessage(err));
    } finally { setTxLoading(false); }
  };

  // דיווח בזבוז מרוכז — מנה כמה חומרי גלם בבת אחת (במקום תנועת "בזבוז"
  // בודדת לכל פריט), כל אחד כתנועת waste נפרדת עם אותו תאריך מדווח.
  // הסנכרון (עדכון קאשים/דוחות/תובנות) כבר קורה אוטומטית לכל תנועה בנפרד
  // דרך onInventoryChanged, בדיוק כמו בתנועת בזבוז רגילה.
  const submitWasteBatch = async () => {
    const entries = Object.entries(wasteQtys).filter(([, q]) => parseFloat(q) > 0);
    if (!entries.length) return;
    setWasteLoading(true);
    try {
      const results = await Promise.allSettled(
        entries.map(([itemId, q]) =>
          inventoryApi.transaction(itemId, { type: 'waste', qty: parseFloat(q), date: wasteDate })
        )
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        toast(`נרשמו ${entries.length - failed} מתוך ${entries.length} פריטים — חלק נכשלו (כמות במלאי לא מספיקה?)`, 'error');
      } else {
        toast(`נרשם בזבוז עבור ${entries.length} פריטים ✓`, 'success');
      }
      setWasteModal(false); setWasteQtys({}); setWasteSearch('');
      load();
    } finally { setWasteLoading(false); }
  };

  const openAddItem = () => {
    setEditingItem(null);
    setItemForm({ name: '', unit: 'ק"ג', qty: '', cost_per_unit: '', category_id: '', expiry_date: '', min_qty: '', max_qty: '', item_type: 'מזון', purchase_unit: '', units_per_purchase: '' });
    setItemError(''); setItemModal(true);
  };

  const openEditItem = (item: InventoryItem) => {
    setEditingItem(item);
    setItemForm({
      name: item.name, unit: item.unit,
      qty: item.current_qty?.toString() || '',
      cost_per_unit: item.cost_per_unit?.toString() || '',
      category_id: (item as InventoryItem & { category_id?: string }).category_id || '',
      expiry_date: item.expiry_date ? item.expiry_date.split('T')[0] : '',
      min_qty: item.min_qty > 0 ? item.min_qty.toString() : '',
      max_qty: item.max_qty && item.max_qty > 0 ? item.max_qty.toString() : '',
      item_type: item.item_type || 'מזון',
      purchase_unit: item.purchase_unit || '',
      units_per_purchase: item.units_per_purchase && item.units_per_purchase > 1 ? item.units_per_purchase.toString() : '',
    });
    setItemError(''); setItemModal(true);
  };

  const saveItem = async () => {
    if (!itemForm.name) { setItemError('שם הפריט נדרש'); return; }
    setItemLoading(true); setItemError('');
    try {
      const payload = {
        name: itemForm.name, unit: itemForm.unit,
        currentQty: parseFloat(itemForm.qty) || 0,
        costPerUnit: parseFloat(itemForm.cost_per_unit) || 0,
        categoryId: itemForm.category_id || null,
        expiryDate: itemForm.expiry_date || null,
        minQty: itemForm.min_qty !== '' ? parseFloat(itemForm.min_qty) : undefined,
        maxQty: itemForm.max_qty !== '' ? parseFloat(itemForm.max_qty) : undefined,
        itemType: itemForm.item_type,
        purchaseUnit: itemForm.purchase_unit.trim() || null,
        unitsPerPurchase: itemForm.purchase_unit.trim() && itemForm.units_per_purchase !== ''
          ? parseFloat(itemForm.units_per_purchase) || 1
          : 1,
      };
      if (editingItem) {
        await inventoryApi.update(editingItem.id, payload);
      } else {
        await inventoryApi.create(payload);
      }
      setItemModal(false); load();
    } catch (err) {
      setItemError(getErrorMessage(err));
    } finally { setItemLoading(false); }
  };

  const deleteItem = async (item: InventoryItem) => {
    if (!await confirm(`האם למחוק את "${item.name}" מהמלאי?`, 'מחיקת פריט')) return;
    try { await inventoryApi.delete(item.id); load(); }
    catch (err) { toast(getErrorMessage(err)); }
  };

  const deleteSupplierItems = async (group: SupplierGroup) => {
    if (!group.supplier_id) return;
    if (!await confirm(`האם למחוק את כל ${group.items.length} הפריטים של "${group.supplier_name}" מהמלאי?`, 'מחיקת כל פריטי הספק')) return;
    try {
      const res = await inventoryApi.deleteBySupplier(group.supplier_id);
      toast((res.data as { message: string }).message);
      load();
    } catch (err) { toast(getErrorMessage(err)); }
  };

  return (
    <ErrorBoundary>
    <div className="space-y-6" dir="rtl">

      {/* ── Sync success overlay ──────────────────────────────── */}
      {syncSuccess && (
        <div
          onClick={() => setSyncSuccess(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(10,10,14,0.8)', backdropFilter: 'blur(8px)',
            cursor: 'pointer',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
              background: '#141418', borderRadius: 24, padding: '32px 40px',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)', border: '1px solid rgba(201,162,39,0.2)',
            }}>
            <Image src="/logo-login.png" alt="לוגו" width={64} height={64} style={{ objectFit: 'contain' }} />
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 18, fontWeight: 800, color: '#e8e8e4', marginBottom: 4 }}>
                סנכרון בוצע בהצלחה
              </p>
              <p style={{ fontSize: 14, color: '#9aa0ab' }}>
                {syncSuccess.items} פריטים עודכנו במלאי
              </p>
            </div>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--color-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <button
              onClick={() => setSyncSuccess(null)}
              style={{ fontSize: 13, color: '#9aa0ab', marginTop: 4, textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none' }}
            >
              סגור
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#e8e8e4' }}>מלאי</h1>
          <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>{items.length} פריטים</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={async () => {
            setSyncPreviewLoading(true);
            try {
              const { data } = await invoicesApi.syncInventoryAuto();
              await load();
              setSyncSuccess({ items: (data.updated || 0) + (data.inserted || 0) });
              setTimeout(() => setSyncSuccess(null), 3000);
            } catch (err) { toast(getErrorMessage(err)); }
            finally { setSyncPreviewLoading(false); }
          }} loading={syncPreviewLoading}>
            <RefreshCw className="w-4 h-4" /> סנכרון מחשבוניות
          </Button>
          <Button variant="outline" onClick={async () => {
            setExporting(true);
            try { const { data } = await exportApi.inventory(); downloadBlob(data, 'מלאי.xlsx'); }
            catch (err) { toast(getErrorMessage(err)); }
            finally { setExporting(false); }
          }} loading={exporting}>
            <Download className="w-4 h-4" /> ייצוא Excel
          </Button>
          <Button variant="outline" onClick={() => { setWasteDate(todayIL()); setWasteQtys({}); setWasteSearch(''); setWasteModal(true); }}>
            <Trash2 className="w-4 h-4" /> מלאי שנזרק
          </Button>
          <Button onClick={openAddItem}><Plus className="w-4 h-4" /> פריט חדש</Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title="שווי מלאי" value={formatCurrency(inventoryValue)} icon={DollarSign} iconColor="text-green-600" iconBg="bg-green-50" />
        <StatCard title="סה״כ פריטים" value={items.length} icon={Package} iconColor="text-blue-600" iconBg="bg-blue-50" />
        <StatCard title="מלאי נמוך" value={lowItems.length} subtitle="פריטים הדורשים הזמנה" icon={AlertTriangle} iconColor="text-amber-600" iconBg="bg-amber-50" />
      </div>

      {/* Opening inventory setup banner */}
      {setupMode && (
        <div className="rounded-2xl p-5" style={{ background: 'rgba(201,162,39,0.06)', border: '1px solid rgba(201,162,39,0.25)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>📦</span>
              <div>
                <p className="font-bold text-sm" style={{ color: '#c9a227' }}>הגדרת מלאי ראשוני</p>
                <p className="text-xs mt-1" style={{ color: 'rgba(232,232,228,0.55)', lineHeight: 1.6 }}>
                  {items.length > 0
                    ? `${items.length} פריטים נמצאים במלאי — בדוק שהכמויות נכונות לתאריך היום.`
                    : 'המלאי ריק — הוסף פריטים ידנית או סנכרן מחשבוניות שהעלת.'}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    onClick={async () => {
                      setSyncPreviewLoading(true);
                      try {
                        const { data } = await invoicesApi.syncInventoryAuto();
                        await load();
                        setSyncSuccess({ items: (data.updated || 0) + (data.inserted || 0) });
                        setTimeout(() => setSyncSuccess(null), 3000);
                      } catch (err) { toast(getErrorMessage(err)); }
                      finally { setSyncPreviewLoading(false); }
                    }}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgba(201,162,39,0.15)', border: '1px solid rgba(201,162,39,0.3)', color: '#c9a227' }}
                  >
                    <RefreshCw className="w-3 h-3" /> סנכרן מחשבוניות
                  </button>
                  <button
                    onClick={openAddItem}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,232,228,0.7)' }}
                  >
                    <Plus className="w-3 h-3" /> הוסף פריט ידנית
                  </button>
                </div>
              </div>
            </div>
            <button
              onClick={() => setSetupMode(false)}
              className="p-1 flex-shrink-0"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(232,232,228,0.3)' }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Expiry alert */}
      {expiringItems.length > 0 && (
        <div className="rounded-xl px-5 py-3" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <div className="flex items-center gap-2 mb-2">
            <CalendarX className="w-4 h-4" style={{ color: '#f87171' }} />
            <p className="text-sm font-semibold" style={{ color: '#fca5a5' }}>פריטים עם תאריך תפוגה קרוב:</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {expiringItems.map(i => {
              const d = parseInt(String(i.days_until_expiry));
              const label = d < 0 ? `פג תוקף לפני ${Math.abs(d)} ימים` : d === 0 ? 'פג תוקף היום' : `עוד ${d} ${d === 1 ? 'יום' : 'ימים'}`;
              return (
                <Badge key={i.id} variant="danger">{i.name} — {label}</Badge>
              );
            })}
          </div>
        </div>
      )}

      {/* Low stock alert */}
      {lowItems.length > 0 && (
        <div className="rounded-xl px-5 py-3" style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.3)' }}>
          <p className="text-sm font-medium mb-1" style={{ color: '#fbbf24' }}>פריטים במלאי נמוך:</p>
          <div className="flex flex-wrap gap-2">
            {lowItems.map(i => (
              <Badge key={i.id} variant="warning">{i.name} ({i.current_qty} {i.unit})</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Historical consumption analysis */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)', background: '#141418' }}>
        <button
          onClick={() => setConsumptionOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(201,162,39,0.12)' }}>
              <History className="w-4 h-4" style={{ color: '#c9a227' }} />
            </div>
            <div className="text-right">
              <p className="font-bold" style={{ color: '#e8e8e4' }}>ניתוח צריכת מלאי היסטורי</p>
              <p className="text-xs" style={{ color: '#9aa0ab' }}>כמה מלאי נצרך ומה שוויו, לפי דוחות מכירה בטווח תאריכים שתבחר</p>
            </div>
          </div>
          {consumptionOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {consumptionOpen && (
          <div className="p-5 space-y-4" style={{ borderTop: '1px solid rgba(201,162,39,0.1)' }}>
            <div className="flex items-end gap-3 flex-wrap">
              <DateRangePicker from={consumptionFrom} to={consumptionTo} onFromChange={setConsumptionFrom} onToChange={setConsumptionTo} />
              <Button onClick={runConsumptionAnalysis} loading={consumptionLoading}>חשב</Button>
            </div>

            {consumptionError && <p className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">{consumptionError}</p>}

            {consumption && (
              <div className="space-y-4">
                {consumption.itemDataCoveragePct < 50 && (
                  <div className="flex items-start gap-2 rounded-lg px-3 py-2.5" style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.25)' }}>
                    <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                    <p className="text-xs" style={{ color: '#fbbf24' }}>
                      רק {consumption.itemDataCoveragePct}% מהמכירות בתקופה הזו מגובות בפירוט מנות — חלק מדוחות ה-Z שהועלו לתקופה זו לא כוללים פירוט פריטים, לכן הנתונים כאן חלקיים ואינם משקפים את מלוא הצריכה.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between px-1">
                  <p className="text-sm" style={{ color: '#9aa0ab' }}>
                    שווי מלאי שנצרך בתקופה — {new Date(consumption.dateFrom).toLocaleDateString('he-IL')} עד {new Date(consumption.dateTo).toLocaleDateString('he-IL')}
                  </p>
                  <p className="text-lg font-bold" style={{ color: '#e8e8e4' }}>{formatCurrency(consumption.totalConsumedValue)}</p>
                </div>

                {consumption.items.length === 0 ? (
                  <div className="py-8 text-center text-sm" style={{ color: '#6b7280' }}>אין נתוני צריכה זמינים לתקופה זו</div>
                ) : (
                  <>
                  {consumption.items.some(it => it.notInRecipe || it.noSalesData) && (
                    <div className="space-y-2">
                      {consumption.items.some(it => it.noSalesData) && (
                        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5" style={{ background: 'rgba(96,184,232,0.07)', border: '1px solid rgba(96,184,232,0.2)' }}>
                          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#60b8e8' }} />
                          <p className="text-xs" style={{ color: '#60b8e8' }}>
                            <strong>"משויך — אין פירוט מכירות"</strong> — הפריט קשור למנה, אך דוחות ה-Z לתקופה זו לא כוללים פירוט מנות ברמת הפריט, ולכן צריכת המלאי לא ניתנת לחישוב. הנתון יוצג ברגע שיועלו דוחות עם פירוט מנות.
                          </p>
                        </div>
                      )}
                      {consumption.items.some(it => it.notInRecipe) && (
                        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5" style={{ background: 'rgba(201,162,39,0.08)', border: '1px solid rgba(201,162,39,0.18)' }}>
                          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#c9a227' }} />
                          <p className="text-xs" style={{ color: '#c9a227' }}>
                            <strong>"לא משויך למתכון"</strong> — פריטים שנרכשו מספק אך לא שויכו לאף מנה. שייך אותם בדף <strong>מנות</strong> כדי לקבל נתוני צריכה מלאים.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr style={{ background: '#111116' }}>
                          {['רכיב', 'כמות שנצרכה', 'שווי'].map(h => (
                            <th key={h} className="text-right text-xs font-medium px-4 py-2.5" style={{ color: '#9aa0ab' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y" style={{ borderColor: 'rgba(201,162,39,0.08)' }}>
                        {consumption.items.map(it => {
                          const isUntracked = it.notInRecipe || it.noSalesData;
                          const badge = it.notInRecipe
                            ? { label: 'לא משויך למתכון', bg: 'rgba(217,119,6,0.12)', color: '#fbbf24' }
                            : it.noSalesData
                            ? { label: 'משויך — אין פירוט מכירות', bg: 'rgba(96,184,232,0.1)', color: '#60b8e8' }
                            : null;
                          return (
                            <tr key={it.itemId} style={isUntracked ? { opacity: 0.7 } : {}}>
                              <td className="px-4 py-2.5 text-sm font-medium" style={{ color: '#e8e8e4' }}>
                                {it.name}
                                {badge && (
                                  <span className="mr-2 text-xs px-1.5 py-0.5 rounded" style={{ background: badge.bg, color: badge.color }}>
                                    {badge.label}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-sm" style={{ color: '#9aa0ab' }}>
                                {isUntracked ? '—' : `${formatNumber(it.consumedQty)} ${it.unit}`}
                              </td>
                              <td className="px-4 py-2.5 text-sm font-medium" style={{ color: '#e8e8e4' }}>
                                {isUntracked ? '—' : formatCurrency(it.consumedValue)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* View toggle + Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)', background: '#111116' }}>
          <button
            onClick={() => setView('supplier')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold transition-colors"
            style={view === 'supplier' ? { background: '#60b8e8', color: '#0a0a0e' } : { color: '#9aa0ab' }}
          >
            <Truck className="w-4 h-4" /> לפי ספק
          </button>
          <button
            onClick={() => setView('list')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold transition-colors"
            style={view === 'list' ? { background: '#60b8e8', color: '#0a0a0e', borderRight: '1px solid rgba(201,162,39,0.16)' } : { color: '#9aa0ab', borderRight: '1px solid rgba(201,162,39,0.16)' }}
          >
            <LayoutList className="w-4 h-4" /> רשימה
          </button>
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="חיפוש פריט..."
            className="w-full pr-9 pl-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {loading && <div className="py-16 text-center text-gray-400 text-sm">טוען...</div>}

      {/* Supplier view */}
      {!loading && view === 'supplier' && (
        <div className="space-y-4">
          {filteredGroups.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">
              <Truck className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p>אין פריטים — אשר חשבוניות כדי לסנכרן מלאי אוטומטית</p>
            </div>
          ) : (
            filteredGroups.map(group => (
              <SupplierSection
                key={group.supplier_id || '__none__'}
                group={group}
                onEdit={openEditItem}
                onDelete={deleteItem}
                onTransaction={openTransaction}
                onDeleteSupplier={deleteSupplierItems}
              />
            ))
          )}
        </div>
      )}

      {/* List view */}
      {!loading && view === 'list' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  {['פריט', 'קטגוריה', 'ספק', 'כמות', 'עלות ליחידה', 'שווי', 'תפוגה', 'פעולות'].map(h => (
                    <th key={h} className="text-right text-xs font-medium text-gray-500 px-6 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'rgba(201,162,39,0.08)' }}>
                {filtered.map(item => {
                  const supplierName = supplierGroups
                    .find(g => g.items.some(i => i.id === item.id))?.supplier_name;
                  return (
                    <tr key={item.id} className="transition-colors" style={{ background: item.is_expired ? 'rgba(239,68,68,0.08)' : item.is_expiring_soon ? 'rgba(245,158,11,0.06)' : item.is_low ? 'rgba(245,158,11,0.04)' : 'transparent' }}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {item.is_expired && <CalendarX className="w-4 h-4 text-red-500 flex-shrink-0" />}
                          {!item.is_expired && item.is_expiring_soon && <CalendarX className="w-4 h-4 text-orange-500 flex-shrink-0" />}
                          {!item.is_expiring_soon && item.is_low && <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />}
                          <span className="text-sm font-medium" style={{ color: '#e8e8e4' }}>{item.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#9aa0ab' }}>{item.category_name || '—'}</td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#9aa0ab' }}>{supplierName || '—'}</td>
                      <td className="px-6 py-4">
                        <span className="text-sm font-medium" style={{ color: item.is_low ? '#fbbf24' : '#e8e8e4' }}>
                          {formatNumber(item.current_qty)} {item.unit}
                        </span>
                        {item.purchase_unit && (item.units_per_purchase ?? 1) > 1 && (
                          <span className="block text-xs" style={{ color: '#6b7280' }}>
                            ({(item.current_qty / (item.units_per_purchase ?? 1)).toLocaleString('he-IL', { maximumFractionDigits: 2 })} {item.purchase_unit})
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#9aa0ab' }}>{formatCurrency(item.cost_per_unit)}</td>
                      <td className="px-6 py-4 text-sm font-medium" style={{ color: '#e8e8e4' }}>
                        {formatCurrency(item.current_qty * item.cost_per_unit)}
                      </td>
                      <td className="px-6 py-4 text-xs">
                        {item.expiry_date ? (
                          <span className="font-semibold" style={{ color: item.is_expired ? '#f87171' : item.is_expiring_soon ? '#fb923c' : '#9aa0ab' }}>
                            {new Date(item.expiry_date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                            {item.is_expired && ' ⚠'}
                          </span>
                        ) : <span style={{ color: '#6b7280' }}>—</span>}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openTransaction(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#9aa0ab' }} title="עדכן כמות">
                            <ArrowUpDown className="w-4 h-4" />
                          </button>
                          <button onClick={() => openEditItem(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#818cf8' }} title="עריכה">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => deleteItem(item)} className="p-1.5 rounded-lg transition-colors" style={{ color: '#f87171' }} title="מחק">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="py-12 text-center text-sm" style={{ color: '#6b7280' }}>לא נמצאו פריטים</div>
            )}
          </div>
        </Card>
      )}

      {/* Sync Preview Modal */}
      <Modal open={!!syncPreview} onClose={() => setSyncPreview(null)} title="סנכרון מחשבוניות — בדיקת התאמות">
        {syncPreview && (
          <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto" dir="rtl">

            {/* Exact matches */}
            {syncPreview.exact.length > 0 && (
              <details className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(74,222,128,0.25)', background: 'rgba(74,222,128,0.04)' }}>
                <summary className="px-4 py-3 cursor-pointer flex items-center gap-2 text-sm font-semibold" style={{ color: '#4ade80' }}>
                  ✓ {syncPreview.exact.length} פריטים מדויקים — יעודכן מחיר אוטומטית
                </summary>
                <div className="px-4 pb-3 space-y-1">
                  {syncPreview.exact.map(r => (
                    <div key={r.invoiceName} className="flex justify-between text-sm" style={{ color: 'rgba(232,232,228,0.6)' }}>
                      <span>{r.invoiceName}</span>
                      <span style={{ color: '#4ade80' }}>→ {r.inventoryName}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Fuzzy matches — require user decision */}
            {syncPreview.fuzzy.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-semibold" style={{ color: '#f59e0b' }}>
                  🔍 {syncPreview.fuzzy.length} פריטים דומים — בחר לאיזה מוצר הכוונה
                </p>
                {syncPreview.fuzzy.map(row => (
                  <div key={row.invoiceNameKey} className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium" style={{ color: '#e8e8e4' }}>
                        &ldquo;{row.invoiceName}&rdquo;
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                        דמיון {row.score}%
                      </span>
                    </div>
                    <select
                      value={fuzzyDecisions[row.invoiceNameKey] ?? row.suggestedId}
                      onChange={e => setFuzzyDecisions(prev => ({ ...prev, [row.invoiceNameKey]: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm"
                      style={{ background: '#1a1a22', border: '1px solid rgba(255,255,255,0.12)', color: '#e8e8e4' }}
                    >
                      <option value="new">➕ צור פריט חדש במלאי</option>
                      {syncPreview.inventory.map(inv => (
                        <option key={inv.id} value={inv.id}>{inv.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {/* New items */}
            {syncPreview.new.length > 0 && (
              <details className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.04)' }}>
                <summary className="px-4 py-3 cursor-pointer flex items-center gap-2 text-sm font-semibold" style={{ color: '#818cf8' }}>
                  ➕ {syncPreview.new.length} פריטים חדשים — יוצרו במלאי
                </summary>
                <div className="px-4 pb-3 space-y-1">
                  {syncPreview.new.map(r => (
                    <div key={r.invoiceName} className="text-sm" style={{ color: 'rgba(232,232,228,0.6)' }}>
                      {r.invoiceName} — {r.qty} {r.unit} × ₪{r.price}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {syncPreview.exact.length === 0 && syncPreview.fuzzy.length === 0 && syncPreview.new.length === 0 && (
              <p className="text-sm text-center py-4" style={{ color: 'rgba(232,232,228,0.4)' }}>אין פריטים לסנכרון — לא נמצאו חשבוניות עם פריטים</p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <Button variant="outline" onClick={() => setSyncPreview(null)}>בטל</Button>
              <Button
                loading={syncApplying}
                onClick={async () => {
                  setSyncApplying(true);
                  try {
                    const mappings: object[] = [];
                    // Exact matches
                    syncPreview.exact.forEach(r => mappings.push({ invoiceNameKey: r.invoiceName.toLowerCase().trim(), invoiceName: r.invoiceName, inventoryId: r.inventoryId, price: r.price, qty: 0, unit: '' }));
                    // Fuzzy decisions
                    syncPreview.fuzzy.forEach(r => {
                      const chosen = fuzzyDecisions[r.invoiceNameKey] ?? r.suggestedId;
                      mappings.push({ invoiceNameKey: r.invoiceNameKey, invoiceName: r.invoiceName, inventoryId: chosen === 'new' ? null : chosen, price: r.price, qty: r.qty, unit: r.unit });
                    });
                    // New items
                    syncPreview.new.forEach(r => mappings.push({ invoiceNameKey: r.invoiceNameKey, invoiceName: r.invoiceName, inventoryId: null, price: r.price, qty: r.qty, unit: r.unit }));

                    const { data } = await invoicesApi.syncInventory(mappings);
                    await load();
                    setSyncPreview(null);
                    setSyncSuccess({ items: (data.updated || 0) + (data.inserted || 0) });
                    setTimeout(() => setSyncSuccess(null), 3000);
                  } catch (err) { toast(getErrorMessage(err)); }
                  finally { setSyncApplying(false); }
                }}
              >
                אשר וסנכרן
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Transaction Modal */}
      <Modal open={!!txModal} onClose={() => setTxModal(null)} title={`עדכון כמות — ${txModal?.name}`}>
        <div className="p-6 space-y-4">
          <div className="flex gap-2">
            {(['add', 'remove', 'waste'] as const).map(t => (
              <button key={t} onClick={() => setTxType(t)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  txType === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>
                {t === 'add' ? 'הוסף' : t === 'remove' ? 'הפחת' : 'בזבוז'}
              </button>
            ))}
          </div>
          {/* Purchase-unit toggle — only shown for 'add' when item has a purchase_unit configured */}
          {txType === 'add' && txModal?.purchase_unit && (txModal?.units_per_purchase ?? 1) > 1 && (
            <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.2)' }}>
              <button
                type="button"
                onClick={() => setTxInPurchaseUnits(v => !v)}
                className="w-9 h-5 rounded-full transition-colors flex items-center flex-shrink-0"
                style={{ background: txInPurchaseUnits ? '#c9a227' : '#d1d5db' }}
              >
                <span className="w-4 h-4 rounded-full bg-white shadow transition-transform block" style={{ transform: txInPurchaseUnits ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }} />
              </button>
              <div className="text-xs" style={{ color: '#e8e8e4' }}>
                הזן ב<strong>{txModal.purchase_unit}</strong>ים
                <span className="ml-1 opacity-60">(1 {txModal.purchase_unit} = {(txModal.units_per_purchase ?? 1).toLocaleString()} {txModal.unit})</span>
              </div>
            </div>
          )}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">
              כמות ({txInPurchaseUnits && txModal?.purchase_unit ? txModal.purchase_unit : txModal?.unit})
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="number" step="0.1" min="0" value={txQty}
                onChange={e => setTxQty(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={startVoice}
                title="הכנסה קולית"
                className={`p-2.5 rounded-lg transition-colors ${voiceActive ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600'}`}
              >
                {voiceActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            </div>
            {txInPurchaseUnits && txModal?.purchase_unit && txQty && parseFloat(txQty) > 0 && (
              <p className="text-xs mt-1" style={{ color: '#c9a227' }}>
                = {(parseFloat(txQty) * (txModal.units_per_purchase ?? 1)).toLocaleString('he-IL', { maximumFractionDigits: 3 })} {txModal.unit} יתווספו למלאי
              </p>
            )}
            {voiceTranscript && (
              <p className="text-xs text-gray-400 mt-1">
                <span className="font-medium text-blue-600">שמעתי:</span> {voiceTranscript}
              </p>
            )}
            {!voiceActive && !voiceTranscript && (
              <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                <Info className="w-3 h-3 flex-shrink-0" />
                הכנסה קולית דורשת הרשאת מיקרופון ודפדפן Chrome/Edge
              </p>
            )}
          </div>
          <Input label="הערה (אופציונלי)" value={txNote} onChange={e => setTxNote(e.target.value)} />
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setTxModal(null)}>ביטול</Button>
            <Button onClick={doTransaction} loading={txLoading}>שמור</Button>
          </div>
        </div>
      </Modal>

      {/* Batch waste modal — "מלאי שנזרק" */}
      <Modal open={wasteModal} onClose={() => setWasteModal(false)} title="דיווח מלאי שנזרק" size="lg">
        <div className="p-6 space-y-4">
          <DatePicker
            label="תאריך הזריקה"
            value={wasteDate}
            onChange={setWasteDate}
            min={daysAgoIL(7)}
            max={todayIL()}
          />
          <p className="text-xs" style={{ color: '#9aa0ab' }}>
            אפשר לדווח על טווח של עד שבוע אחורה — בחר את היום שבו המלאי בפועל נזרק.
          </p>
          <Input
            label="חיפוש חומר גלם"
            value={wasteSearch}
            onChange={e => setWasteSearch(e.target.value)}
            placeholder="הקלד לסינון..."
          />
          <div className="max-h-80 overflow-y-auto rounded-xl border" style={{ borderColor: 'var(--card-border-color, rgba(201,162,39,0.16))' }}>
            {items
              .filter(i => i.name.toLowerCase().includes(wasteSearch.toLowerCase()))
              .map(item => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0" style={{ borderColor: 'var(--card-border-color, rgba(201,162,39,0.1))' }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: '#e8e8e4' }}>{item.name}</p>
                    <p className="text-xs" style={{ color: '#6b7280' }}>במלאי: {formatNumber(item.current_qty)} {item.unit}</p>
                  </div>
                  <input
                    type="number" min="0" step="0.1"
                    placeholder="0"
                    value={wasteQtys[item.id] || ''}
                    onChange={e => setWasteQtys(q => ({ ...q, [item.id]: e.target.value }))}
                    className="w-24 text-center rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                  />
                  <span className="text-xs w-10 flex-shrink-0" style={{ color: '#6b7280' }}>{item.unit}</span>
                </div>
              ))}
            {items.filter(i => i.name.toLowerCase().includes(wasteSearch.toLowerCase())).length === 0 && (
              <p className="text-sm text-center py-6" style={{ color: '#6b7280' }}>לא נמצאו פריטים</p>
            )}
          </div>
          {Object.values(wasteQtys).filter(q => parseFloat(q) > 0).length > 0 && (
            <p className="text-sm font-semibold" style={{ color: '#c9a227' }}>
              {Object.values(wasteQtys).filter(q => parseFloat(q) > 0).length} פריטים ידווחו כנזרקו
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setWasteModal(false)}>ביטול</Button>
            <Button onClick={submitWasteBatch} loading={wasteLoading}
              disabled={Object.values(wasteQtys).filter(q => parseFloat(q) > 0).length === 0}>
              שמור דיווח בזבוז
            </Button>
          </div>
        </div>
      </Modal>

      {/* Add / Edit Item Modal */}
      <Modal open={itemModal} onClose={() => setItemModal(false)} title={editingItem ? `עריכת ${editingItem.name}` : 'פריט חדש'}>
        <div className="p-6 space-y-4">
          <Input label="שם הפריט" value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="לדוגמה: עגבניות" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">יחידת מידה</label>
              <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                value={itemForm.unit} onChange={e => setItemForm(f => ({ ...f, unit: e.target.value }))}>
                {UNIT_OPTIONS(itemForm.unit).map(u => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">קטגוריה</label>
              <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                value={itemForm.category_id} onChange={e => setItemForm(f => ({ ...f, category_id: e.target.value }))}>
                <option value="">ללא קטגוריה</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">סוג פריט</label>
              <select className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                value={itemForm.item_type} onChange={e => setItemForm(f => ({ ...f, item_type: e.target.value }))}>
                <option value="מזון">🍽 מזון (נספר ב-COGS)</option>
                <option value="ניקיון">🧹 ניקיון</option>
                <option value="ציוד">🔧 ציוד</option>
                <option value="שונות">📦 שונות</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="כמות" type="number" step="0.1" value={itemForm.qty} onChange={e => setItemForm(f => ({ ...f, qty: e.target.value }))} placeholder="0" />
            <Input label="עלות ליחידה (₪)" type="number" step="0.01" value={itemForm.cost_per_unit} onChange={e => setItemForm(f => ({ ...f, cost_per_unit: e.target.value }))} placeholder="0.00" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="מינימום (מלאי מינימלי)" type="number" step="0.1" value={itemForm.min_qty} onChange={e => setItemForm(f => ({ ...f, min_qty: e.target.value }))} placeholder="0" />
            <Input label="מקסימום (יעד הזמנה)" type="number" step="0.1" value={itemForm.max_qty} onChange={e => setItemForm(f => ({ ...f, max_qty: e.target.value }))} placeholder="0" />
          </div>
          <p className="text-xs" style={{ color: '#9aa0ab' }}>מקסימום — המערכת תמליץ להזמין עד לרמה זו בכל שבוע, בנוסף לצריכה הצפויה מהמנות</p>
          <DatePicker label="תאריך תפוגה (אופציונלי)" value={itemForm.expiry_date} onChange={v => setItemForm(f => ({ ...f, expiry_date: v }))} clearable />

          {/* Purchase unit — allows entering stock in bulk packages (e.g. "שק 25 ק"ג") */}
          <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(201,162,39,0.05)', border: '1px solid rgba(201,162,39,0.15)' }}>
            <p className="text-xs font-semibold" style={{ color: '#c9a227' }}>יחידת רכישה (אופציונלי)</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-xs text-gray-500">שם החבילה</label>
                <input
                  placeholder='לדוגמה: שק, ארגז, גלון'
                  value={itemForm.purchase_unit}
                  onChange={e => setItemForm(f => ({ ...f, purchase_unit: e.target.value }))}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-gray-500">
                  {itemForm.purchase_unit ? `כמות ${itemForm.unit || 'יחידות'} בכל ${itemForm.purchase_unit}` : `כמות יחידות ב-1 חבילה`}
                </label>
                <input
                  type="number" step="any" min="1"
                  placeholder='לדוגמה: 25000'
                  value={itemForm.units_per_purchase}
                  onChange={e => setItemForm(f => ({ ...f, units_per_purchase: e.target.value }))}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            {itemForm.purchase_unit && itemForm.units_per_purchase && parseFloat(itemForm.units_per_purchase) > 1 && (
              <p className="text-xs" style={{ color: '#9aa0ab' }}>
                1 {itemForm.purchase_unit} = {parseFloat(itemForm.units_per_purchase).toLocaleString('he-IL')} {itemForm.unit || 'יחידות'} — בעת הוספת מלאי תוכל לבחור להזין כמות ב{itemForm.purchase_unit}ים
              </p>
            )}
          </div>

          {itemError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{itemError}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setItemModal(false)}>ביטול</Button>
            <Button onClick={saveItem} loading={itemLoading}>{editingItem ? 'עדכן' : 'הוסף'}</Button>
          </div>
        </div>
      </Modal>
    </div>
    </ErrorBoundary>
  );
}
