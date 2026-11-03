'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Phone, Mail, Search, Pencil, Trash2, RefreshCw, X,
  SendHorizonal, Building2, RefreshCcw, Sparkles, ShoppingCart,
  Clock, Send, CalendarDays, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import api from '@/lib/api/client';
import { suppliersApi, invoicesApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Supplier, StandingOrderItem } from '@/types';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { SupplierLedgerTab } from './_tabs/SupplierLedgerTab';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

const schema = z.object({
  name: z.string().min(2, 'שם חובה'),
  contact_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('אימייל לא תקין').max(255, 'אימייל ארוך מדי').optional().or(z.literal('')),
  preferred_channel: z.enum(['whatsapp', 'email', 'phone', 'fax']),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const channelLabels: Record<string, string> = { whatsapp: 'WhatsApp', email: 'אימייל', phone: 'טלפון', fax: 'פקס' };
const channelColors: Record<string, string> = {
  whatsapp: '#25D366', email: '#4F8EF7', phone: '#8B5CF6', fax: '#6B7280',
};

export default function SuppliersPage() {
  const { confirm, toast } = useAppDialog();
  const [activeTab, setActiveTab] = useState<'suppliers' | 'ledger'>('suppliers');
  const [suppliers, setSuppliers]           = useState<Supplier[]>([]);
  const [loading, setLoading]               = useState(true);
  const [syncing, setSyncing]               = useState(false);
  const [syncMsg, setSyncMsg]               = useState('');
  const [search, setSearch]                 = useState('');
  const [showModal, setShowModal]           = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [submitting, setSubmitting]         = useState(false);
  const [error, setError]                   = useState('');

  // New order modal
  const [showNewOrder, setShowNewOrder]     = useState(false);
  const [noSupplierId, setNoSupplierId]     = useState('');
  const [noItems, setNoItems]               = useState<StandingOrderItem[]>([]);
  const [noNewItem, setNoNewItem]           = useState({ name: '', qty: '', unit: '' });
  const [noNotes, setNoNotes]               = useState('');

  // Standing orders
  const [soSupplier, setSoSupplier] = useState<Supplier | null>(null);
  const [soItems, setSoItems]       = useState<StandingOrderItem[]>([]);
  const [soNewItem, setSoNewItem]   = useState({ name: '', qty: '', unit: '' });
  const [soSaving, setSoSaving]     = useState(false);
  const [soDays, setSoDays]         = useState<number[]>([0,1,2,3,4]); // ברירת מחדל א׳-ה׳
  const [soAutoSend, setSoAutoSend] = useState(false);

  // Pending orders panel
  type PendingOrder = {
    id: string; supplier_id: string; supplier_name: string;
    preferred_channel: string; phone?: string; email?: string;
    note_to_supplier?: string;
    items: { id?: string; name: string; qty: number; unit: string }[];
  };
  const [pendingOrders, setPendingOrders]   = useState<PendingOrder[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [editingOrder, setEditingOrder]     = useState<PendingOrder | null>(null);
  const [sending, setSending]               = useState<string | null>(null);

  // Negotiation crew
  const [negotiatingId, setNegotiatingId]   = useState<string | null>(null);
  const [negotiationResult, setNegotiationResult] = useState<{
    supplier: { name: string; email?: string };
    priceAnalysis: string;
    strategy: { mainAsk: string; leverage: string[]; suggestedDiscount: string; fallbackPosition: string };
    email: { subject: string; body: string; followUpNote: string };
    stats: { totalSpend: number; invoiceCount: number; monthlyTrend: string | null };
  } | null>(null);
  const [showNegModal, setShowNegModal]     = useState(false);
  const [negShowAnalysis, setNegShowAnalysis] = useState(false);

  const runNegotiation = async (sup: Supplier) => {
    setNegotiatingId(sup.id);
    try {
      // Backend allows up to 120s for this negotiation crew (see ai.routes.js)
      const { data } = await api.post(`/ai/supplier-negotiate/${sup.id}`, undefined, { timeout: 130_000 });
      setNegotiationResult(data);
      setShowNegModal(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast(msg || 'שגיאה בהפעלת סוכן המשא ומתן', 'error');
    }
    finally { setNegotiatingId(null); }
  };

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const { data } = await suppliersApi.pendingOrders();
      setPendingOrders(data.orders || []);
    } catch { setPendingOrders([]); }
    finally { setPendingLoading(false); }
  }, []);

  useEffect(() => { loadPending(); }, [loadPending]);
  useSyncEvent('order_sent', loadPending);

  const { register, handleSubmit, reset, setValue, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { preferred_channel: 'whatsapp' },
  });

  const load = () => {
    setLoading(true);
    suppliersApi.list().then(({ data }) => {
      const list = Array.isArray(data) ? data : (data.items || []);
      setSuppliers(list.filter((s: Supplier) => s.is_active !== false));
      setLoading(false);
    }).catch((err: unknown) => {
      toast(getErrorMessage(err), 'error');
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);
  useSyncEvent('supplier.updated', load);

  // סנכרון חשבוניות → ספקים
  const syncFromInvoices = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      // שולף ספקים עדכניים מהשרת (לא מה-state) כדי למנוע כפילויות
      const [{ data: invData }, { data: supData }] = await Promise.all([
        invoicesApi.list(),
        suppliersApi.list(),
      ]);

      const invoices: { supplier_name?: string }[] = Array.isArray(invData) ? invData : (invData.invoices || []);
      const freshList = Array.isArray(supData) ? supData : (supData.items || []);
      const existingNames = new Set(freshList.map((s: { name: string }) => s.name.trim().toLowerCase()));

      const newNames = [...new Set(
        invoices
          .map((inv) => inv.supplier_name?.trim())
          .filter((n): n is string => !!n && n.length > 1)
          .filter((n) => !existingNames.has(n.toLowerCase()))
      )];

      if (newNames.length === 0) {
        setSyncMsg('כל הספקים כבר קיימים ברשימה');
        load();
        return;
      }

      for (const name of newNames) {
        await suppliersApi.create({ name, categories: [], preferred_channel: 'whatsapp' });
      }

      setSyncMsg(`נוספו ${newNames.length} ספקים חדשים: ${newNames.join(', ')}`);
      load();
    } catch (err) {
      setSyncMsg('שגיאה בסנכרון: ' + getErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const filtered = suppliers.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.contact_name || '').toLowerCase().includes(search.toLowerCase())
  );

  const openEdit = (sup: Supplier) => {
    setEditingSupplier(sup);
    setValue('name', sup.name);
    setValue('contact_name', sup.contact_name || '');
    setValue('phone', sup.phone || '');
    setValue('email', sup.email || '');
    setValue('preferred_channel', sup.preferred_channel as 'whatsapp' | 'email' | 'phone' | 'fax');
    setValue('notes', (sup as Supplier & { notes?: string }).notes || '');
    setError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingSupplier(null);
    reset();
    setError('');
  };

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    setError('');
    try {
      if (editingSupplier) {
        await suppliersApi.update(editingSupplier.id, data);
      } else {
        await suppliersApi.create({ ...data, categories: [] });
      }
      closeModal();
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openStandingOrders = (sup: Supplier) => {
    setSoSupplier(sup);
    setSoItems(sup.standing_order?.items?.map(i => ({ ...i })) || []);
    setSoDays(sup.standing_order?.order_days ?? [0,1,2,3,4]);
    setSoAutoSend(sup.standing_order?.auto_send ?? false);
    setSoNewItem({ name: '', qty: '', unit: '' });
  };

  const soAddItem = () => {
    const qty = parseFloat(soNewItem.qty);
    if (!soNewItem.name || isNaN(qty) || qty <= 0) return;
    setSoItems(items => [...items, { name: soNewItem.name, qty, unit: soNewItem.unit }]);
    setSoNewItem({ name: '', qty: '', unit: '' });
  };

  const soRemoveItem = (idx: number) => setSoItems(items => items.filter((_, i) => i !== idx));

  const soUpdateQty = (idx: number, val: string) => {
    const q = parseFloat(val);
    if (isNaN(q)) return;
    setSoItems(items => items.map((it, i) => i === idx ? { ...it, qty: q } : it));
  };

  const toggleDay = (d: number) =>
    setSoDays(days => days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort());

  const soSave = async () => {
    if (!soSupplier) return;
    setSoSaving(true);
    try {
      await suppliersApi.update(soSupplier.id, {
        standing_order: { items: soItems, order_days: soDays, auto_send: soAutoSend },
      });
      setSoSupplier(null);
      load();
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setSoSaving(false); }
  };

  // WhatsApp orders aren't actually sent by sendOrder2 itself — it only
  // generates a wa.me link (order.sender.js leaves the order 'pending' on
  // purpose). window.open() below is the moment the user actually gets sent
  // to WhatsApp to press send there, so that's the right point to confirm —
  // matching the "פתח WhatsApp" click handler on the dedicated orders page.
  const confirmIfWhatsApp = (result: { data?: { channel?: string; waLink?: string } }, orderId: string) => {
    if (result.data?.waLink) {
      window.open(result.data.waLink, '_blank');
      if (result.data.channel === 'whatsapp') suppliersApi.markOrderSent(orderId).catch(() => {});
    }
  };

  const sendPendingOrder = async (order: PendingOrder) => {
    setSending(order.id);
    try {
      const result = await suppliersApi.sendOrder2(order.id);
      confirmIfWhatsApp(result, order.id);
      toast('ההזמנה נשלחה', 'success');
      loadPending();
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setSending(null); }
  };

  const saveAndSendOrder = async (order: PendingOrder) => {
    setSending(order.id);
    try {
      await suppliersApi.updateOrder(order.id, { items: order.items });
      const result = await suppliersApi.sendOrder2(order.id);
      confirmIfWhatsApp(result, order.id);
      toast('ההזמנה עודכנה ונשלחה', 'success');
      setEditingOrder(null);
      loadPending();
    } catch (err) { toast(getErrorMessage(err)); }
    finally { setSending(null); }
  };

  const deleteSupplier = async (sup: Supplier) => {
    if (!await confirm(`האם למחוק את "${sup.name}"?`, 'מחיקת ספק')) return;
    try {
      await suppliersApi.delete(sup.id);
      load();
    } catch (err) { toast(getErrorMessage(err)); }
  };

  const sendOrder = (sup: Supplier) => {
    const items = sup.standing_order?.items ?? [];
    const today = new Date().toLocaleDateString('he-IL');
    const lines = items.length > 0
      ? items.map(i => `• ${i.name} — ${i.qty} ${i.unit || 'יח׳'}`).join('\n')
      : '(לא הוגדרו פריטים)';
    const msg = `שלום,\nהזמנה ל-${today}:\n${lines}\n\nתודה`;
    const channel = sup.preferred_channel;

    if ((channel === 'whatsapp') && sup.phone) {
      const digits = sup.phone.replace(/\D/g, '').replace(/^0/, '972');
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank');
    } else if (channel === 'email' && sup.email) {
      window.open(`mailto:${sup.email}?subject=${encodeURIComponent(`הזמנה — ${today}`)}&body=${encodeURIComponent(msg)}`, '_blank');
    } else if (channel === 'phone' && sup.phone) {
      window.open(`tel:${sup.phone}`, '_blank');
    } else if (sup.phone) {
      const digits = sup.phone.replace(/\D/g, '').replace(/^0/, '972');
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank');
    } else if (sup.email) {
      window.open(`mailto:${sup.email}?subject=${encodeURIComponent(`הזמנה — ${today}`)}&body=${encodeURIComponent(msg)}`, '_blank');
    } else {
      toast(`לא הוגדר טלפון או מייל עבור "${sup.name}". ערוך את הספק והוסף פרטי קשר.`);
    }
  };

  const sendNewOrder = () => {
    const sup = suppliers.find(s => s.id === noSupplierId);
    if (!sup) return;
    const today = new Date().toLocaleDateString('he-IL');
    const lines = noItems.length > 0
      ? noItems.map(i => `• ${i.name} — ${i.qty} ${i.unit || 'יח׳'}`).join('\n')
      : '(לא נבחרו פריטים)';
    const msg = `שלום,\nהזמנה ל-${today}:\n${lines}${noNotes ? `\n\nהערות: ${noNotes}` : ''}\n\nתודה`;
    const channel = sup.preferred_channel;
    if (channel === 'whatsapp' && sup.phone) {
      const digits = sup.phone.replace(/\D/g, '').replace(/^0/, '972');
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank');
    } else if (channel === 'email' && sup.email) {
      window.open(`mailto:${sup.email}?subject=${encodeURIComponent(`הזמנה — ${today}`)}&body=${encodeURIComponent(msg)}`, '_blank');
    } else if (sup.phone) {
      const digits = sup.phone.replace(/\D/g, '').replace(/^0/, '972');
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`, '_blank');
    } else if (sup.email) {
      window.open(`mailto:${sup.email}?subject=${encodeURIComponent(`הזמנה — ${today}`)}&body=${encodeURIComponent(msg)}`, '_blank');
    } else {
      toast(`לא הוגדר טלפון או מייל עבור "${sup.name}".`);
      return;
    }
    setShowNewOrder(false);
    setNoItems([]); setNoNotes(''); setNoNewItem({ name: '', qty: '', unit: '' });
  };

  // ── Initials avatar
  const initials = (name: string) => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const avatarColor = (name: string) => {
    const colors = ['#4F46E5','#7C3AED','#0EA5E9','#059669','#D97706','#DC2626','#DB2777'];
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
    return colors[h];
  };

  return (
    <ErrorBoundary>
    <div dir="rtl" style={{ minHeight: '100vh', background: 'linear-gradient(145deg, #0a0a0e 0%, #0f0f14 50%, #0d0d12 100%)', padding: '28px 24px' }}>

      {/* ── Tabs ── */}
      <div className="flex gap-1 mb-6 p-1 rounded-xl" style={{ background: '#111116', width: 'fit-content' }}>
        {([
          { id: 'suppliers', label: 'ספקים והזמנות' },
          { id: 'ledger',    label: 'ספר חשבונות' },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
            style={activeTab === tab.id
              ? { background: '#141418', color: '#c9a227', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }
              : { color: '#9aa0ab' }}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'ledger' && <SupplierLedgerTab />}

      {activeTab === 'suppliers' && <>

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: '#e8e8e4', letterSpacing: '-0.5px' }}>ספקים והזמנות</h1>
          <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>{suppliers.length} ספקים פעילים</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={syncFromInvoices}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}
            title="סנכרן ספקים מחשבוניות"
          >
            <RefreshCcw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            סנכרן חשבוניות
          </button>
          <button
            onClick={() => { setNoSupplierId(suppliers[0]?.id || ''); setNoItems([]); setNoNotes(''); setShowNewOrder(true); }}
            disabled={suppliers.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}
          >
            <ShoppingCart className="w-4 h-4" /> הזמנה חדשה
          </button>
          <button
            onClick={() => { setEditingSupplier(null); reset(); setShowModal(true); }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}
          >
            <Plus className="w-4 h-4" /> ספק חדש
          </button>
        </div>
      </div>

      {/* ── הזמנות ממתינות לאישור ── */}
      {(pendingOrders.length > 0 || pendingLoading) && (
        <div className="mb-6 rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.25)', background: '#111116' }}>
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid rgba(201,162,39,0.2)', background: '#0f0f14' }}>
            <h3 className="font-bold flex items-center gap-2" style={{ color: '#c9a227' }}>
              <Clock className="w-4 h-4" />
              הזמנות ממתינות לאישורך ({pendingOrders.length})
            </h3>
            <button onClick={loadPending} className="text-amber-600 hover:text-amber-800">
              <RefreshCw className={`w-4 h-4 ${pendingLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="divide-y" style={{ borderColor: 'rgba(201,162,39,0.1)' }}>
            {pendingOrders.map(order => (
              <div key={order.id} className="px-5 py-3">
                {editingOrder?.id === order.id ? (
                  /* מצב עריכה */
                  <div className="space-y-2">
                    <p className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>{order.supplier_name}</p>
                    {editingOrder.items.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span className="flex-1 text-sm" style={{ color: '#e8e8e4' }}>{item.name}</span>
                        <input
                          type="number" min={0} step={0.1}
                          value={item.qty}
                          onChange={e => setEditingOrder(o => o ? { ...o, items: o.items.map((it,i) => i===idx ? { ...it, qty: parseFloat(e.target.value)||0 } : it) } : o)}
                          className="w-20 text-sm px-2 py-1 rounded-lg border border-amber-300 outline-none text-center"
                        />
                        <span className="text-xs text-gray-400 w-10">{item.unit}</span>
                      </div>
                    ))}
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => setEditingOrder(null)} className="text-xs px-3 py-1.5 rounded-lg" style={{ border: '1px solid rgba(201,162,39,0.25)', color: '#9aa0ab' }}>ביטול</button>
                      <button onClick={() => saveAndSendOrder(editingOrder)} disabled={sending === order.id}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold"
                        style={{ background: 'var(--color-primary)' }}>
                        <Send className="w-3 h-3" />{sending === order.id ? 'שולח...' : 'שמור ושלח'}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* תצוגה רגילה */
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-semibold text-sm" style={{ color: '#e8e8e4' }}>{order.supplier_name}</p>
                      <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>
                        {order.items.map(i => `${i.name} ×${i.qty}${i.unit ? ' '+i.unit : ''}`).join(' · ')}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => setEditingOrder({ ...order })}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                        style={{ border: '1px solid rgba(201,162,39,0.3)', color: '#c9a227', background: 'rgba(201,162,39,0.08)' }}>
                        ✏️ ערוך
                      </button>
                      <button onClick={() => sendPendingOrder(order)} disabled={sending === order.id}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold"
                        style={{ background: 'var(--color-primary)' }}>
                        <Send className="w-3 h-3" />{sending === order.id ? '...' : 'שלח'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Sync message ── */}
      {syncMsg && (
        <div className="mb-5 flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
          style={{ background: syncMsg.includes('שגיאה') ? '#FEF2F2' : '#F0FDF4', color: syncMsg.includes('שגיאה') ? '#DC2626' : '#16A34A', border: `1px solid ${syncMsg.includes('שגיאה') ? '#FECACA' : '#BBF7D0'}` }}>
          <Sparkles className="w-4 h-4 flex-shrink-0" />
          {syncMsg}
          <button onClick={() => setSyncMsg('')} className="mr-auto"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── Search ── */}
      <div className="relative mb-6 max-w-sm">
        <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש ספק..."
          className="w-full pr-10 pl-4 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-300"
          style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }}
        />
      </div>

      {/* ── Cards grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {loading ? (
          [...Array(6)].map((_, i) => (
            <div key={i} className="rounded-2xl animate-pulse" style={{ height: 200, background: '#1a1a22' }} />
          ))
        ) : filtered.map((sup) => (
          <div
            key={sup.id}
            className="rounded-2xl overflow-hidden transition-all hover:-translate-y-0.5"
            style={{
              background: '#141418',
              border: '1px solid rgba(201,162,39,0.16)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
            }}
          >
            {/* Card top stripe */}
            <div style={{ height: 4, background: `linear-gradient(90deg, ${avatarColor(sup.name)}, ${avatarColor(sup.name)}88)` }} />

            <div className="p-5">
              {/* Header row */}
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-base truncate" style={{ color: '#e8e8e4' }}>{sup.name}</h3>
                  {sup.contact_name && (
                    <p className="text-xs mt-0.5 truncate" style={{ color: '#9aa0ab' }}>{sup.contact_name}</p>
                  )}
                </div>
                <span
                  className="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0"
                  style={{ background: `${channelColors[sup.preferred_channel]}18`, color: channelColors[sup.preferred_channel] }}
                >
                  {channelLabels[sup.preferred_channel]}
                </span>
              </div>

              {/* Contact details */}
              <div className="space-y-1.5 mb-4">
                {sup.phone && (
                  <div className="flex items-center gap-2 text-sm" style={{ color: '#9aa0ab' }}>
                    <Phone className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#9CA3AF' }} />
                    <span dir="ltr">{sup.phone}</span>
                  </div>
                )}
                {sup.email && (
                  <div className="flex items-center gap-2 text-sm" style={{ color: '#9aa0ab' }}>
                    <Mail className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#9CA3AF' }} />
                    <span className="truncate">{sup.email}</span>
                  </div>
                )}
                {!sup.phone && !sup.email && (
                  <p className="text-xs" style={{ color: '#D1D5DB' }}>לא הוגדרו פרטי קשר</p>
                )}
              </div>

              {/* Categories */}
              {(sup.categories ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {(sup.categories ?? []).slice(0, 3).map((cat) => (
                    <span key={cat} className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: '#1a1a22', color: '#9aa0ab' }}>
                      {cat}
                    </span>
                  ))}
                </div>
              )}

              {/* Standing order badge */}
              {(sup.standing_order?.items?.length ?? 0) > 0 && (
                <div className="mb-4 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg"
                  style={{ background: 'rgba(124,58,237,0.12)', color: '#a78bfa' }}>
                  <RefreshCw className="w-3 h-3" />
                  הזמנה עומדת — {sup.standing_order!.items.length} פריטים
                </div>
              )}

              {/* Action buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-3" style={{ borderTop: '1px solid rgba(201,162,39,0.12)' }}>
                <ActionBtn icon={<Pencil className="w-3.5 h-3.5" />} label="עריכה" color="#818cf8" bg="rgba(79,70,229,0.12)" onClick={() => openEdit(sup)} />
                <ActionBtn icon={<SendHorizonal className="w-3.5 h-3.5" />} label="הזמן" color="#34d399" bg="rgba(5,150,105,0.12)" onClick={() => sendOrder(sup)} />
                <ActionBtn
                  icon={negotiatingId === sup.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  label={negotiatingId === sup.id ? '...' : 'מו"מ AI'}
                  color="#c9a227" bg="rgba(201,162,39,0.12)"
                  onClick={() => runNegotiation(sup)}
                />
                <ActionBtn icon={<Trash2 className="w-3.5 h-3.5" />} label="מחק" color="#f87171" bg="rgba(220,38,38,0.12)" onClick={() => deleteSupplier(sup)} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && !loading && (
        <div className="text-center py-20">
          <Building2 className="w-12 h-12 mx-auto mb-4" style={{ color: '#D1D5DB' }} />
          <p className="text-lg font-semibold" style={{ color: '#6B7280' }}>
            {search ? 'לא נמצאו ספקים תואמים' : 'אין ספקים עדיין'}
          </p>
          {!search && (
            <p className="text-sm mt-1" style={{ color: '#9CA3AF' }}>הוסף ספק חדש או סנכרן מחשבוניות</p>
          )}
        </div>
      )}

      </>}

      {/* ── New Order Modal ── */}
      <Modal open={showNewOrder} onClose={() => setShowNewOrder(false)} title="הזמנה חדשה" size="md">
        <div className="p-6 space-y-5" dir="rtl">

          {/* בחירת ספק */}
          <div className="space-y-1">
            <label className="block text-sm font-semibold" style={{ color: '#b8bcc4' }}>ספק</label>
            <select
              value={noSupplierId}
              onChange={e => setNoSupplierId(e.target.value)}
              className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
              style={{ border: '1px solid #D1D5DB' }}
            >
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.preferred_channel ? ` · ${channelLabels[s.preferred_channel]}` : ''}</option>
              ))}
            </select>
            {noSupplierId && (() => {
              const sup = suppliers.find(s => s.id === noSupplierId);
              if (!sup) return null;
              return (
                <p className="text-xs mt-1" style={{ color: '#6B7280' }}>
                  {sup.phone && <span className="ml-3">📞 {sup.phone}</span>}
                  {sup.email && <span>✉️ {sup.email}</span>}
                </p>
              );
            })()}
          </div>

          {/* פריטי הזמנה */}
          <div className="space-y-2">
            <p className="text-sm font-semibold" style={{ color: '#b8bcc4' }}>פריטים</p>
            {noItems.length > 0 && (
              <div className="divide-y rounded-xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)' }}>
                {noItems.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 px-4 py-2.5" style={{ background: '#111116' }}>
                    <span className="flex-1 text-sm font-medium" style={{ color: '#e8e8e4' }}>{item.name}</span>
                    <span className="text-sm" style={{ color: '#9aa0ab' }}>{item.qty} {item.unit || 'יח׳'}</span>
                    <button onClick={() => setNoItems(items => items.filter((_, i) => i !== idx))}
                      className="p-1 rounded-lg hover:bg-red-50">
                      <X className="w-3.5 h-3.5" style={{ color: '#EF4444' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input type="text" placeholder="שם מוצר"
                value={noNewItem.name}
                onChange={e => setNoNewItem(f => ({ ...f, name: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { const qty = parseFloat(noNewItem.qty); if (noNewItem.name && !isNaN(qty) && qty > 0) { setNoItems(items => [...items, { name: noNewItem.name, qty, unit: noNewItem.unit }]); setNoNewItem({ name: '', qty: '', unit: '' }); } } }}
                className="flex-1 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                style={{ border: '1px solid #D1D5DB' }} />
              <input type="number" placeholder="כמות" min={0} step={0.1}
                value={noNewItem.qty}
                onChange={e => setNoNewItem(f => ({ ...f, qty: e.target.value }))}
                className="w-20 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                style={{ border: '1px solid #D1D5DB' }} />
              <input type="text" placeholder="יחידה"
                value={noNewItem.unit}
                onChange={e => setNoNewItem(f => ({ ...f, unit: e.target.value }))}
                className="w-20 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                style={{ border: '1px solid #D1D5DB' }} />
              <button
                onClick={() => { const qty = parseFloat(noNewItem.qty); if (!noNewItem.name || isNaN(qty) || qty <= 0) return; setNoItems(items => [...items, { name: noNewItem.name, qty, unit: noNewItem.unit }]); setNoNewItem({ name: '', qty: '', unit: '' }); }}
                className="px-3 py-2 rounded-xl font-semibold text-sm font-medium"
                style={{ background: 'var(--color-primary)' }}>
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* הערות */}
          <div className="space-y-1">
            <label className="block text-sm font-semibold" style={{ color: '#b8bcc4' }}>הערות (אופציונלי)</label>
            <input type="text" placeholder="לדוגמה: דחוף, משלוח עד 12:00..."
              value={noNotes}
              onChange={e => setNoNotes(e.target.value)}
              className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
              style={{ border: '1px solid #D1D5DB' }} />
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowNewOrder(false)}>ביטול</Button>
            <Button onClick={sendNewOrder} disabled={!noSupplierId}>
              <SendHorizonal className="w-4 h-4" /> שלח הזמנה
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Standing Orders Modal ── */}
      <Modal open={!!soSupplier} onClose={() => setSoSupplier(null)} title={`הזמנה עומדת — ${soSupplier?.name || ''}`}>
        <div className="p-6 space-y-5">

          {/* ── ימי הזמנה ── */}
          <div className="space-y-2">
            <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: '#374151' }}>
              <CalendarDays className="w-4 h-4" /> ימי הזמנה
            </p>
            <div className="flex gap-2 flex-wrap">
              {['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'].map((label, day) => (
                <button key={day} onClick={() => toggleDay(day)}
                  className="w-10 h-10 rounded-xl text-sm font-bold transition-all"
                  style={{
                    background: soDays.includes(day) ? 'var(--color-primary)' : '#1a1a22',
                    color: soDays.includes(day) ? '#fff' : '#9aa0ab',
                    border: '1px solid ' + (soDays.includes(day) ? 'var(--color-primary)' : 'rgba(201,162,39,0.16)'),
                  }}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs" style={{ color: '#9CA3AF' }}>
              {soDays.length === 0 ? 'לא נבחרו ימים — ההזמנה לא תישלח' :
               soDays.length === 7 ? 'כל יום' :
               `${soDays.length} ימים בשבוע`}
            </p>
          </div>

          {/* ── שליחה אוטומטית ── */}
          <div className="flex items-center justify-between px-4 py-3 rounded-xl" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.16)' }}>
            <div>
              <p className="text-sm font-semibold" style={{ color: '#b8bcc4' }}>שלח אוטומטית</p>
              <p className="text-xs" style={{ color: '#9CA3AF' }}>
                {soAutoSend ? 'ההזמנה תישלח לספק ישירות ב-07:00' : 'תקבל התראה לאישור לפני השליחה'}
              </p>
            </div>
            <button onClick={() => setSoAutoSend(v => !v)}
              className="relative w-11 h-6 rounded-full transition-colors"
              style={{ background: soAutoSend ? '#1a5c2a' : '#D1D5DB' }}>
              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
                style={{ transform: soAutoSend ? 'translateX(-24px)' : 'translateX(-2px)' }} />
            </button>
          </div>

          {/* ── פריטים ── */}
          {soItems.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold" style={{ color: '#b8bcc4' }}>פריטי ההזמנה</p>
              <div className="divide-y rounded-xl overflow-hidden" style={{ border: '1px solid rgba(201,162,39,0.16)' }}>
                {soItems.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 px-4 py-2.5" style={{ background: '#111116' }}>
                    <span className="flex-1 text-sm font-medium" style={{ color: '#e8e8e4' }}>{item.name}</span>
                    <input
                      type="number" min={0} step={0.1} value={item.qty}
                      onChange={e => soUpdateQty(idx, e.target.value)}
                      className="w-16 text-center text-sm px-2 py-1 rounded-lg outline-none"
                      style={{ border: '1px solid #D1D5DB' }}
                    />
                    <span className="text-xs text-gray-400 w-10">{item.unit || 'יח׳'}</span>
                    <button onClick={() => soRemoveItem(idx)} className="p-1 rounded-lg hover:bg-red-50">
                      <X className="w-3.5 h-3.5" style={{ color: '#EF4444' }} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── הוספת פריט ── */}
          <div className="space-y-2">
            <p className="text-sm font-semibold" style={{ color: '#b8bcc4' }}>הוספת פריט</p>
            <div className="flex gap-2">
              <input type="text" placeholder="שם מוצר" value={soNewItem.name}
                onChange={e => setSoNewItem(f => ({ ...f, name: e.target.value }))}
                className="flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ border: '1px solid #D1D5DB' }}
              />
              <input type="number" placeholder="כמות" min={0} step={0.1} value={soNewItem.qty}
                onChange={e => setSoNewItem(f => ({ ...f, qty: e.target.value }))}
                className="w-20 rounded-lg px-3 py-2 text-sm focus:outline-none text-center" style={{ border: '1px solid #D1D5DB' }}
              />
              <input type="text" placeholder="יח׳" value={soNewItem.unit}
                onChange={e => setSoNewItem(f => ({ ...f, unit: e.target.value }))}
                className="w-16 rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ border: '1px solid #D1D5DB' }}
              />
              <button onClick={soAddItem} className="px-3 py-2 rounded-lg font-semibold"
                style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)' }}>
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {soItems.length === 0 && (
            <p className="text-xs text-center py-1" style={{ color: '#D1D5DB' }}>לא הוגדרו פריטים</p>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setSoSupplier(null)}>ביטול</Button>
            <Button onClick={soSave} loading={soSaving}>שמור הגדרות</Button>
          </div>
        </div>
      </Modal>

      {/* ── Add / Edit Modal ── */}
      <Modal open={showModal} onClose={closeModal} title={editingSupplier ? `עריכת ${editingSupplier.name}` : 'ספק חדש'}>
        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="שם ספק" error={errors.name?.message} {...register('name')} />
            <Input label="איש קשר" {...register('contact_name')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="טלפון" type="tel" {...register('phone')} />
            <Input label="אימייל" type="email" error={errors.email?.message} {...register('email')} />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-medium" style={{ color: '#b8bcc4' }}>ערוץ מועדף</label>
            <select
              className="block w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              style={{ border: '1px solid #D1D5DB' }}
              {...register('preferred_channel')}
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="email">אימייל</option>
              <option value="phone">טלפון</option>
              <option value="fax">פקס</option>
            </select>
          </div>
          <Input label="הערות" {...register('notes')} />
          {error && <p className="text-sm px-3 py-2 rounded-lg" style={{ background: '#FEF2F2', color: '#DC2626' }}>{error}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={closeModal}>ביטול</Button>
            <Button type="submit" loading={submitting}>{editingSupplier ? 'עדכן' : 'שמור'}</Button>
          </div>
        </form>
      </Modal>

      {/* ── Negotiation Result Modal ── */}
      {showNegModal && negotiationResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setShowNegModal(false)}>
          <div className="rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl"
            style={{ background: 'var(--glass-bg,#fff)', border: '1px solid var(--glass-border)' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="p-5 border-b flex items-center justify-between sticky top-0 z-10 rounded-t-2xl"
              style={{ background: 'var(--glass-bg,#fff)', borderColor: 'var(--card-border-color)' }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#fffbeb' }}>
                  <Sparkles className="w-5 h-5" style={{ color: '#c9a227' }} />
                </div>
                <div>
                  <h2 className="font-bold text-gray-800">סוכן משא ומתן AI</h2>
                  <p className="text-xs text-gray-500">{negotiationResult.supplier.name} · 3 סוכנים הושלמו</p>
                </div>
              </div>
              <button onClick={() => setShowNegModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'הוצאה ל-6 חודשים', value: new Intl.NumberFormat('he-IL',{style:'currency',currency:'ILS',maximumFractionDigits:0}).format(negotiationResult.stats.totalSpend) },
                  { label: 'חשבוניות', value: String(negotiationResult.stats.invoiceCount) },
                  { label: 'מגמת מחירים', value: negotiationResult.stats.monthlyTrend !== null ? (Number(negotiationResult.stats.monthlyTrend) > 0 ? `↑${negotiationResult.stats.monthlyTrend}%` : `↓${Math.abs(Number(negotiationResult.stats.monthlyTrend))}%`) : 'יציב' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: 'var(--tag-bg,#e8f5eb)' }}>
                    <p className="text-xs text-gray-500">{s.label}</p>
                    <p className="font-bold text-gray-800">{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Strategy */}
              <div className="rounded-xl p-4 border" style={{ borderColor: 'var(--card-border-color)' }}>
                <p className="text-sm font-bold text-gray-700 mb-2">🎯 אסטרטגיה: {negotiationResult.strategy.mainAsk}</p>
                <p className="text-xs text-gray-500 mb-2">הנחה מוצעת: <strong>{negotiationResult.strategy.suggestedDiscount}</strong></p>
                <div className="space-y-1">
                  {negotiationResult.strategy.leverage?.map((l, i) => (
                    <p key={i} className="text-xs text-gray-600 flex items-start gap-1.5"><span className="text-green-600 font-bold">✓</span>{l}</p>
                  ))}
                </div>
              </div>

              {/* Email */}
              <div className="rounded-xl p-4 border" style={{ borderColor: '#c9a22730', background: '#fffdf5' }}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-bold text-gray-700">📧 טיוטת מייל מוכנה לשליחה</p>
                  <button
                    onClick={() => { navigator.clipboard.writeText(negotiationResult.email.body); toast('הועתק ✓'); }}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium transition-all"
                    style={{ background: 'var(--color-primary)', color: '#fff' }}>
                    <Copy className="w-3 h-3" /> העתק
                  </button>
                </div>
                <p className="text-xs text-gray-500 mb-2">נושא: <strong>{negotiationResult.email.subject}</strong></p>
                <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-line bg-white rounded-lg p-3 border" style={{ borderColor: '#e5e7eb' }}>
                  {negotiationResult.email.body}
                </div>
                {negotiationResult.email.followUpNote && (
                  <p className="text-xs text-gray-400 mt-2 italic">💡 {negotiationResult.email.followUpNote}</p>
                )}
              </div>

              {/* Analysis toggle */}
              <button onClick={() => setNegShowAnalysis(v => !v)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                {negShowAnalysis ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {negShowAnalysis ? 'הסתר' : 'הצג'} ניתוח מלא
              </button>
              {negShowAnalysis && (
                <div className="rounded-xl p-4 bg-gray-50 text-xs text-gray-600 leading-relaxed whitespace-pre-line">
                  {negotiationResult.priceAnalysis}
                </div>
              )}

              {/* Send button */}
              {negotiationResult.supplier.email && (
                <a href={`mailto:${negotiationResult.supplier.email}?subject=${encodeURIComponent(negotiationResult.email.subject)}&body=${encodeURIComponent(negotiationResult.email.body)}`}
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all"
                  style={{ background: 'var(--color-primary)' }}>
                  <Mail className="w-4 h-4" /> שלח מייל לספק
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}

function ActionBtn({ icon, label, color, bg, onClick }: {
  icon: React.ReactNode; label: string; color: string; bg: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-medium transition-all hover:scale-105"
      style={{ background: bg, color }}
    >
      {icon}
      {label}
    </button>
  );
}
