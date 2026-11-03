'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Plus, X, CreditCard, Bell, AlertTriangle, Settings, TrendingDown } from 'lucide-react';
import { todayIL } from '@/lib/dates';
import { adminFetch } from '@/lib/adminClient';


interface Payment {
  id: string;
  business_id: string;
  business_name: string;
  amount: string | number;
  payment_date: string;
  note: string | null;
  recorded_by_name: string | null;
  created_at: string;
}

interface BusinessOption { id: string; name: string; }

interface ScheduleItem {
  business_id: string;
  business_name: string;
  billing_day: number;
  monthly_fee: number;
  billing_start_date: string;
  grace_period_days: number;
  next_due_date: string | null;
  days_until_due: number | null;
  status: 'overdue' | 'due_soon' | 'ok';
  last_payment: string | null;
  total_paid: number;
  total_expected: number;
  balance: number;
  open_months: number;
  payments_count: number;
  suspended: boolean;
}

interface NoAgreementItem {
  business_id: string;
  business_name: string;
  total_paid: number;
  payments_count: number;
  suspended: boolean;
}

interface BillingForm {
  billingDay: string;
  monthlyFee: string;
  billingStartDate: string;
  gracePeriodDays: string;
}

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatCurrency(n: number) {
  return '₪' + n.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function todayStr() {
  return todayIL();
}

export default function AdminPaymentsPage() {
  const router = useRouter();

  const [payments, setPayments]       = useState<Payment[]>([]);
  const [schedule, setSchedule]       = useState<ScheduleItem[]>([]);
  const [noAgreement, setNoAgreement] = useState<NoAgreementItem[]>([]);
  const [businesses, setBusinesses]   = useState<BusinessOption[]>([]);
  const [total, setTotal]             = useState(0);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [businessFilter, setBusinessFilter] = useState('');

  // רישום תשלום
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState({ businessId: '', amount: '', paymentDate: todayStr(), note: '' });

  // הגדרת הסכם חיוב
  const [billingTarget, setBillingTarget]   = useState<{ id: string; name: string } | null>(null);
  const [billingForm, setBillingForm]       = useState<BillingForm>({ billingDay: '', monthlyFee: '', billingStartDate: '', gracePeriodDays: '7' });
  const [billingError, setBillingError]     = useState('');
  const [billingSaving, setBillingSaving]   = useState(false);

  // tab
  const [tab, setTab] = useState<'balance' | 'history'>('balance');

  const fetchPayments = async (bizId: string) => {
    setLoading(true); setError('');
    try {
      const qs = bizId ? `?businessId=${bizId}` : '';
      const res = await adminFetch(`/admin/payments${qs}`);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPayments(data.payments); setTotal(data.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally { setLoading(false); }
  };

  const fetchBusinesses = async () => {
    try {
      const res = await adminFetch(`/admin/businesses?limit=200`);
      if (!res.ok) return;
      const data = await res.json();
      setBusinesses((data.businesses || []).map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })));
    } catch { /* ignore */ }
  };

  const fetchSchedule = async () => {
    try {
      const res = await adminFetch(`/admin/payments/schedule`);
      if (!res.ok) return;
      const data = await res.json();
      setSchedule(data.schedule || []);
      setNoAgreement(data.no_agreement || []);
    } catch { /* ignore */ }
  };

  const refreshAll = () => { fetchPayments(businessFilter); fetchSchedule(); };

  useEffect(() => { fetchPayments(businessFilter); }, [businessFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchBusinesses(); fetchSchedule(); }, []);

  const reminders = schedule.filter(s => s.status === 'due_soon' || s.status === 'overdue');
  const sumShown  = payments.reduce((s, p) => s + parseFloat(String(p.amount)), 0);

  const submitPayment = async () => {
    setFormError('');
    if (!form.businessId) return setFormError('בחר עסק');
    if (!form.amount || parseFloat(form.amount) <= 0) return setFormError('סכום לא תקין');
    if (!form.paymentDate) return setFormError('תאריך חסר');
    setSaving(true);
    try {
      const res = await adminFetch(`/admin/businesses/${form.businessId}/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: form.amount, paymentDate: form.paymentDate, note: form.note }),
      });
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowForm(false);
      setForm({ businessId: '', amount: '', paymentDate: todayStr(), note: '' });
      refreshAll();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'שגיאה');
    } finally { setSaving(false); }
  };

  const openBillingModal = (biz: { id: string; name: string }, existing?: ScheduleItem) => {
    setBillingTarget(biz);
    setBillingForm({
      billingDay:       existing?.billing_day?.toString()        || '',
      monthlyFee:       existing?.monthly_fee?.toString()        || '',
      billingStartDate: existing?.billing_start_date             || '',
      gracePeriodDays:  existing?.grace_period_days?.toString()  || '7',
    });
    setBillingError('');
  };

  const saveBilling = async () => {
    if (!billingTarget) return;
    setBillingError('');
    setBillingSaving(true);
    try {
      const res = await adminFetch(`/admin/businesses/${billingTarget.id}/billing`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billingDay:      parseInt(billingForm.billingDay, 10),
          monthlyFee:      parseFloat(billingForm.monthlyFee),
          billingStartDate: billingForm.billingStartDate,
          gracePeriodDays: parseInt(billingForm.gracePeriodDays, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBillingTarget(null);
      fetchSchedule();
    } catch (err: unknown) {
      setBillingError(err instanceof Error ? err.message : 'שגיאה');
    } finally { setBillingSaving(false); }
  };

  return (
    <div className="max-w-5xl mx-auto" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">תשלומים</h1>
          <p className="text-slate-500 text-sm mt-0.5">{total} תשלומים נרשמו</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshAll}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors">
            <RefreshCw className="w-4 h-4" /> רענן
          </button>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" /> רישום תשלום
          </button>
        </div>
      </div>

      {/* Reminders strip */}
      {reminders.length > 0 && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bell className="w-4 h-4 text-amber-600" />
            <h2 className="font-bold text-amber-800 text-sm">מצריכים טיפול ({reminders.length})</h2>
          </div>
          <div className="space-y-1.5">
            {reminders.map(r => {
              const overdue = r.status === 'overdue';
              return (
                <div key={r.business_id}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${overdue ? 'bg-red-100/60' : 'bg-white'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {overdue && <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />}
                    <span className="font-semibold text-slate-800 truncate">{r.business_name}</span>
                    {r.suspended && <span className="text-[10px] bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded shrink-0">מושהה</span>}
                    {(r.balance ?? 0) > 0 && (
                      <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded shrink-0">
                        חוב {r.balance != null ? formatCurrency(r.balance) : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {r.next_due_date && <span className="text-slate-500 text-xs">מועד: {formatDate(r.next_due_date)}</span>}
                    <span className={`text-xs font-bold ${overdue ? 'text-red-600' : 'text-amber-700'}`}>
                      {overdue
                        ? `באיחור ${Math.abs(r.days_until_due ?? 0)} ימים`
                        : r.days_until_due === 0 ? 'היום' : `בעוד ${r.days_until_due} ימים`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 p-1 rounded-xl w-fit">
        {([['balance', 'יתרות חוב'], ['history', 'היסטוריית תשלומים']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              tab === key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab: יתרות חוב ── */}
      {tab === 'balance' && (
        <div className="space-y-3">
          {/* עסקים עם הסכם */}
          {schedule.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-50 bg-slate-50/50 flex items-center justify-between">
                <h3 className="font-bold text-slate-700 text-sm">עסקים עם הסכם חיוב</h3>
                <span className="text-xs text-slate-400">{schedule.length} עסקים</span>
              </div>
              <div className="divide-y divide-slate-50">
                {schedule.map(s => {
                  const statusColor = s.status === 'overdue' ? 'text-red-600 bg-red-50 border-red-200'
                    : s.status === 'due_soon' ? 'text-amber-700 bg-amber-50 border-amber-200'
                    : 'text-green-700 bg-green-50 border-green-200';
                  const statusLabel = s.status === 'overdue' ? 'באיחור'
                    : s.status === 'due_soon' ? 'קרוב'
                    : 'שוטף';
                  return (
                    <div key={s.business_id} className="flex items-center gap-4 px-5 py-3.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-slate-800 text-sm truncate">{s.business_name}</span>
                          {s.suspended && <span className="text-[10px] bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded">מושהה</span>}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusColor}`}>{statusLabel}</span>
                          {s.days_until_due != null && s.days_until_due >= 0 && s.days_until_due <= 2 && s.balance === 0 && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200 flex items-center gap-1">
                              🔔 {s.days_until_due === 0 ? 'חיוב היום' : `חיוב בעוד ${s.days_until_due} ${s.days_until_due === 1 ? 'יום' : 'ימים'}`}
                              {s.next_due_date && <span className="opacity-70">· {formatDate(s.next_due_date)}</span>}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-400">
                          <span>יום {s.billing_day ?? '?'} לחודש · {s.monthly_fee != null ? formatCurrency(s.monthly_fee) : '—'}/חודש</span>
                          {s.last_payment && <span>שולם לאחרונה: {formatDate(s.last_payment)}</span>}
                        </div>
                      </div>
                      {/* חוב */}
                      <div className="text-center shrink-0 min-w-[80px]">
                        {(s.balance ?? 0) > 0 ? (
                          <>
                            <div className="text-base font-black text-red-600">{formatCurrency(s.balance)}</div>
                            <div className="text-[10px] text-red-400">{s.open_months} חודש פתוח</div>
                          </>
                        ) : (
                          <div className="text-sm font-bold text-green-600">מעודכן</div>
                        )}
                      </div>
                      {/* כפתור הגדרה */}
                      <button
                        onClick={() => openBillingModal({ id: s.business_id, name: s.business_name }, s)}
                        className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                        title="ערוך הסכם"
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* עסקים ללא הסכם */}
          {noAgreement.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-50 bg-slate-50/50 flex items-center justify-between">
                <h3 className="font-bold text-slate-500 text-sm flex items-center gap-2">
                  <TrendingDown className="w-4 h-4" />
                  ללא הסכם חיוב
                </h3>
                <span className="text-xs text-slate-400">{noAgreement.length} עסקים</span>
              </div>
              <div className="divide-y divide-slate-50">
                {noAgreement.map(b => (
                  <div key={b.business_id} className="flex items-center gap-4 px-5 py-3">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-slate-600 font-medium truncate block">{b.business_name}</span>
                      <span className="text-xs text-slate-400">{b.payments_count} תשלומים · {formatCurrency(b.total_paid)} שולם סה״כ</span>
                    </div>
                    <button
                      onClick={() => openBillingModal({ id: b.business_id, name: b.business_name })}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> הגדר הסכם
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {schedule.length === 0 && noAgreement.length === 0 && (
            <div className="text-center py-16 text-slate-400">
              <CreditCard className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">אין עסקים עם הסכמי חיוב</p>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: היסטוריית תשלומים ── */}
      {tab === 'history' && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <select value={businessFilter} onChange={e => setBusinessFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400">
              <option value="">כל העסקים</option>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {payments.length > 0 && (
              <span className="text-sm text-slate-500">
                סה״כ מוצג: <span className="font-bold text-slate-700">{formatCurrency(sumShown)}</span>
              </span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="text-center text-red-500 py-8 text-sm">{error}</div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-xs text-slate-500 font-medium">
                      <th className="text-right px-4 py-3">עסק</th>
                      <th className="text-right px-4 py-3">סכום</th>
                      <th className="text-right px-4 py-3">תאריך תשלום</th>
                      <th className="text-right px-4 py-3">הערה</th>
                      <th className="text-right px-4 py-3">נרשם ע״י</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center py-8 text-slate-400">
                          <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-30" />
                          לא נמצאו תשלומים
                        </td>
                      </tr>
                    ) : payments.map(p => (
                      <tr key={p.id} className="border-t border-slate-50">
                        <td className="px-4 py-3.5 font-semibold text-slate-800">{p.business_name}</td>
                        <td className="px-4 py-3.5 text-green-700 font-bold">{formatCurrency(parseFloat(String(p.amount)))}</td>
                        <td className="px-4 py-3.5 text-slate-600">{formatDate(p.payment_date)}</td>
                        <td className="px-4 py-3.5 text-slate-500 text-xs max-w-xs truncate">{p.note || '—'}</td>
                        <td className="px-4 py-3.5 text-slate-400 text-xs">{p.recorded_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Modal: רישום תשלום ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5" dir="rtl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-slate-800">רישום תשלום</h2>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">עסק</label>
                <select value={form.businessId} onChange={e => setForm(f => ({ ...f, businessId: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400">
                  <option value="">בחר עסק...</option>
                  {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">סכום (₪)</label>
                <input type="number" min="0" step="0.01" value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">תאריך תשלום</label>
                <input type="date" value={form.paymentDate}
                  onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">הערה (אופציונלי)</label>
                <textarea value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                  rows={2} className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400 resize-none" />
              </div>
              {formError && <p className="text-red-500 text-xs">{formError}</p>}
              <button onClick={submitPayment} disabled={saving}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50">
                {saving ? 'שומר...' : 'שמור תשלום'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: הגדרת הסכם חיוב ── */}
      {billingTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={e => { if (e.target === e.currentTarget) setBillingTarget(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5" dir="rtl">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-bold text-slate-800">הסכם חיוב</h2>
              <button onClick={() => setBillingTarget(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">{billingTarget.name}</p>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">יום בחודש (1–28)</label>
                  <input type="number" min="1" max="28"
                    value={billingForm.billingDay}
                    onChange={e => setBillingForm(f => ({ ...f, billingDay: e.target.value }))}
                    placeholder="15"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">סכום חודשי (₪)</label>
                  <input type="number" min="0" step="0.01"
                    value={billingForm.monthlyFee}
                    onChange={e => setBillingForm(f => ({ ...f, monthlyFee: e.target.value }))}
                    placeholder="500"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">תאריך תחילת חיוב (החודש הראשון)</label>
                <input type="date"
                  value={billingForm.billingStartDate}
                  onChange={e => setBillingForm(f => ({ ...f, billingStartDate: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">ימי חסד לאחר מועד החיוב</label>
                <input type="number" min="0" max="60"
                  value={billingForm.gracePeriodDays}
                  onChange={e => setBillingForm(f => ({ ...f, gracePeriodDays: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400" />
                <p className="text-[11px] text-slate-400 mt-1">
                  לאחר {billingForm.gracePeriodDays || '7'} ימים ללא תשלום — המערכת תשהה את הגישה אוטומטית
                </p>
              </div>

              {billingError && <p className="text-red-500 text-xs">{billingError}</p>}
              <button onClick={saveBilling} disabled={billingSaving}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50">
                {billingSaving ? 'שומר...' : 'שמור הסכם'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
