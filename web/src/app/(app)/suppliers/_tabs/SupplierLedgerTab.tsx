'use client';

import { useEffect, useState, useCallback } from 'react';
import { Truck, ChevronDown, ChevronUp, RefreshCw, Plus, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';
import { supplierLedgerApi } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency, getErrorMessage } from '@/lib/utils';
import { DatePicker } from '@/components/ui/DatePicker';
import { useAppDialog } from '@/context/AppDialogContext';
import { todayIL } from '@/lib/dates';

interface SupplierSummary {
  id: string; name: string; phone: string | null; email: string | null;
  total_invoiced: number; total_paid: number; balance: number;
  open_invoices: number; oldest_unpaid: string | null;
}

interface LedgerEntry {
  type: 'invoice' | 'payment';
  id: string; date: string; description: string;
  debit: number; credit: number; running_balance: number;
  status?: string; due_date?: string | null; notes?: string | null;
}

interface LedgerDetail {
  supplier: { id: string; name: string; phone: string; email: string; payment_method: string };
  summary: { total_invoiced: number; total_paid: number; balance: number; open_invoices: number };
  entries: LedgerEntry[];
}

const PAYMENT_METHODS = [
  { value: 'bank_transfer', label: 'העברה בנקאית' },
  { value: 'check',         label: "צ'ק" },
  { value: 'cash',          label: 'מזומן' },
  { value: 'credit_card',   label: 'כרטיס אשראי' },
];

export function SupplierLedgerTab() {
  const { toast, confirm } = useAppDialog();
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [detail, setDetail]       = useState<Record<string, LedgerDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const [payForm, setPayForm] = useState<{ supplierId: string | null; amount: string; date: string; method: string; reference: string; notes: string }>({
    supplierId: null, amount: '', date: todayIL(),
    method: 'bank_transfer', reference: '', notes: '',
  });
  const [saving, setSaving] = useState(false);

  const loadList = () => {
    setLoading(true);
    supplierLedgerApi.list()
      .then((r) => setSuppliers((r.data as { suppliers: SupplierSummary[] }).suppliers || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadList(); }, []);

  const toggleDetail = useCallback((id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (detail[id]) return;
    setLoadingDetail(id);
    supplierLedgerApi.get(id)
      .then((r) => setDetail(prev => ({ ...prev, [id]: r.data as LedgerDetail })))
      .catch(() => {})
      .finally(() => setLoadingDetail(null));
  }, [expanded, detail]);

  const submitPayment = async () => {
    if (!payForm.supplierId || !payForm.amount) return;
    setSaving(true);
    try {
      await supplierLedgerApi.addPayment(payForm.supplierId, {
        amount:       parseFloat(payForm.amount),
        payment_date: payForm.date,
        method:       payForm.method,
        reference:    payForm.reference || undefined,
        notes:        payForm.notes || undefined,
      });
      loadList();
      const d = { ...detail };
      delete d[payForm.supplierId];
      setDetail(d);
      if (expanded === payForm.supplierId) {
        setLoadingDetail(payForm.supplierId);
        supplierLedgerApi.get(payForm.supplierId)
          .then((r) => setDetail(prev => ({ ...prev, [payForm.supplierId!]: r.data as LedgerDetail })))
          .finally(() => setLoadingDetail(null));
      }
      setPayForm(p => ({ ...p, amount: '', reference: '', notes: '', supplierId: null }));
    } catch (err) { toast(getErrorMessage(err) || 'שמירת התשלום נכשלה', 'error'); }
    finally { setSaving(false); }
  };

  const totalBalance  = suppliers.reduce((s, sup) => s + sup.balance, 0);
  const totalInvoiced = suppliers.reduce((s, sup) => s + sup.total_invoiced, 0);
  const totalPaid     = suppliers.reduce((s, sup) => s + sup.total_paid, 0);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Truck className="w-5 h-5" style={{ color: '#c9a227' }} />
            ספר חשבונות ספקים
          </h2>
          <p className="text-sm opacity-60 mt-0.5">מעקב חובות, חשבוניות ותשלומים לכל ספק</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'סה"כ חשבוניות', value: formatCurrency(totalInvoiced), color: '#c9a227' },
          { label: 'שולם',          value: formatCurrency(totalPaid),     color: '#4ade80' },
          { label: 'יתרה לתשלום',   value: formatCurrency(totalBalance),  color: totalBalance > 0 ? '#f87171' : '#4ade80' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl p-4"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <p className="text-xl font-black" style={{ color }}>{value}</p>
            <p className="text-xs opacity-60 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : suppliers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <p>אין ספקים פעילים</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {suppliers.map(sup => {
            const isOpen = expanded === sup.id;
            const d      = detail[sup.id];
            const overdue = sup.oldest_unpaid
              ? (new Date().getTime() - new Date(sup.oldest_unpaid).getTime()) / (1000 * 60 * 60 * 24) > 30
              : false;

            return (
              <div key={sup.id} className="rounded-2xl overflow-hidden"
                style={{
                  background: 'var(--card-bg)',
                  border: `1px solid ${overdue && sup.balance > 0 ? 'rgba(239,68,68,0.3)' : sup.balance > 0 ? 'rgba(251,191,36,0.2)' : 'rgba(74,222,128,0.15)'}`,
                }}>
                {/* Row */}
                <div className="flex items-center gap-4 p-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{sup.name}</span>
                      {overdue && sup.balance > 0 && <AlertTriangle className="w-4 h-4 text-red-400" />}
                      {sup.balance <= 0 && <CheckCircle className="w-4 h-4 text-green-400" />}
                      {sup.open_invoices > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold"
                          style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                          {sup.open_invoices} חשבוניות פתוחות
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-0.5 flex-wrap text-xs opacity-50">
                      <span>חשבוניות: {formatCurrency(sup.total_invoiced)}</span>
                      <span>שולם: {formatCurrency(sup.total_paid)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-center">
                      <p className="text-xs opacity-40">יתרה</p>
                      <p className="text-lg font-black" style={{ color: sup.balance > 0 ? '#f87171' : '#4ade80' }}>
                        {formatCurrency(sup.balance)}
                      </p>
                    </div>
                    {sup.balance > 0 && (
                      <Button size="sm" variant="outline"
                        onClick={() => setPayForm(p => ({ ...p, supplierId: sup.id }))}
                        style={{ borderColor: 'rgba(201,162,39,0.4)', color: '#c9a227' }}>
                        <Plus className="w-3 h-3 ml-1" />
                        תשלום
                      </Button>
                    )}
                    <button onClick={() => toggleDetail(sup.id)} className="opacity-40 hover:opacity-100 transition-opacity">
                      {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Detail */}
                {isOpen && (
                  <div className="border-t px-4 py-3"
                    style={{ borderColor: 'var(--card-border-color)', background: 'rgba(0,0,0,0.15)' }}>
                    {loadingDetail === sup.id ? (
                      <div className="h-20 animate-pulse rounded-xl" style={{ background: 'var(--card-bg)' }} />
                    ) : d ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs min-w-[500px]">
                          <thead>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                              {['תאריך', 'תיאור', 'חיוב', 'זיכוי', 'יתרה'].map(h => (
                                <th key={h} className="py-2 pr-3 text-right opacity-40 font-medium">{h}</th>
                              ))}
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {d.entries.map((e, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                <td className="py-2 pr-3 opacity-60">{new Date(e.date).toLocaleDateString('he-IL')}</td>
                                <td className="py-2 pr-3 font-medium">{e.description}</td>
                                <td className="py-2 pr-3" style={{ color: e.debit > 0 ? '#f87171' : undefined }}>
                                  {e.debit > 0 ? formatCurrency(e.debit) : '—'}
                                </td>
                                <td className="py-2 pr-3" style={{ color: e.credit > 0 ? '#4ade80' : undefined }}>
                                  {e.credit > 0 ? formatCurrency(e.credit) : '—'}
                                </td>
                                <td className="py-2 pr-3 font-bold"
                                  style={{ color: e.running_balance > 0 ? '#f87171' : '#4ade80' }}>
                                  {formatCurrency(e.running_balance)}
                                </td>
                                <td className="py-2 pr-3">
                                  {e.type === 'payment' && (
                                    <button className="opacity-30 hover:opacity-100 hover:text-red-400 transition-all"
                                      onClick={async () => {
                                        if (!await confirm('האם למחוק את התשלום? הפעולה בלתי הפיכה.', 'מחיקת תשלום', 'מחק')) return;
                                        try {
                                          await supplierLedgerApi.deletePayment(e.id);
                                          loadList();
                                          const updated = { ...detail };
                                          delete updated[sup.id];
                                          setDetail(updated);
                                          setLoadingDetail(sup.id);
                                          supplierLedgerApi.get(sup.id)
                                            .then((r) => setDetail(prev => ({ ...prev, [sup.id]: r.data as LedgerDetail })))
                                            .finally(() => setLoadingDetail(null));
                                        } catch (err) { toast(getErrorMessage(err) || 'מחיקת התשלום נכשלה', 'error'); }
                                      }}>
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Payment Modal */}
      {payForm.supplierId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={e => { if (e.target === e.currentTarget) setPayForm(p => ({ ...p, supplierId: null })); }}>
          <div className="w-full max-w-md rounded-2xl p-6 space-y-4 shadow-2xl bg-white">
            <h2 className="text-lg font-bold text-slate-800">
              רישום תשלום — {suppliers.find(s => s.id === payForm.supplierId)?.name}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">סכום (₪)</label>
                <input type="number" min="0" step="0.01"
                  value={payForm.amount}
                  onChange={e => setPayForm(p => ({ ...p, amount: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm text-slate-800 bg-slate-50 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-green-300"
                  placeholder="0.00" />
              </div>
              <div>
                <DatePicker
                  label="תאריך"
                  value={payForm.date}
                  onChange={v => setPayForm(p => ({ ...p, date: v }))}
                  className="w-full"
                  clearable={false}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">אמצעי תשלום</label>
                <select value={payForm.method}
                  onChange={e => setPayForm(p => ({ ...p, method: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm text-slate-800 bg-slate-50 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-green-300">
                  {PAYMENT_METHODS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 block mb-1">מספר אסמכתא (אופציונלי)</label>
                <input type="text"
                  value={payForm.reference}
                  onChange={e => setPayForm(p => ({ ...p, reference: e.target.value }))}
                  className="w-full px-3 py-2 rounded-xl text-sm text-slate-800 bg-slate-50 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-green-300"
                  placeholder="מס׳ המחאה / אסמכתא" />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button className="flex-1" onClick={submitPayment} disabled={saving || !payForm.amount}>
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'שמור תשלום'}
              </Button>
              <Button variant="outline" onClick={() => setPayForm(p => ({ ...p, supplierId: null }))}>
                ביטול
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
