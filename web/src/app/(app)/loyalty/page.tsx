'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Users, Star, TrendingUp, Gift, Phone, Search, Plus,
  Crown, ChevronRight, Trophy, Flame, Calendar, ShoppingBag, Settings } from 'lucide-react';
import { customersApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ─── types ────────────────────────────────────────────────
type Customer = {
  id: string;
  name?: string;
  phone: string;
  email?: string;
  notes?: string;
  total_visits: number;
  total_spent: number;
  points: number;
  birthday?: string;
  last_visit: string;
  first_visit: string;
  visits?: Visit[];
};

type Visit = {
  id: string;
  amount: number;
  points_earned: number;
  note?: string;
  visited_at: string;
};

type Stats = {
  total_customers: number;
  active_this_month: number;
  new_this_month: number;
  vip_count: number;
  visits_today: number;
  total_revenue_all: number;
};

const fmtDate = (d?: string) =>
  d ? new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';

const fmtMoney = (n: number) =>
  '₪' + n.toLocaleString('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ─── component ────────────────────────────────────────────
export default function LoyaltyPage() {
  const { toast, confirm } = useAppDialog();

  const [stats, setStats]       = useState<Stats | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [leaderboard, setLeaderboard] = useState<Customer[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [sort, setSort]         = useState('last_visit');

  // Quick-visit panel
  const [visitPhone, setVisitPhone]   = useState('');
  const [visitCustomer, setVisitCustomer] = useState<Customer | null>(null);
  const [visitAmount, setVisitAmount] = useState('');
  const [visitNote, setVisitNote]     = useState('');
  const [visitLoading, setVisitLoading] = useState(false);
  const [modalVisitLoading, setModalVisitLoading] = useState(false);
  const [lookingUp, setLookingUp]     = useState(false);

  // Detail modal
  const [selected, setSelected] = useState<Customer | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // New customer modal
  const [showNew, setShowNew]   = useState(false);
  const [newForm, setNewForm]   = useState({ name: '', phone: '', email: '', birthday: '' });
  const [newLoading, setNewLoading] = useState(false);

  // Settings modal
  type LoyaltySettings = { points_per_shekel: number; tier_silver: number; tier_gold: number; tier_platinum: number; reward_text: string };
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<LoyaltySettings>({ points_per_shekel: 0.1, tier_silver: 40, tier_gold: 100, tier_platinum: 300, reward_text: 'אחרי 10 ביקורים — פינוק בחינם!' });
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Reads the same configurable thresholds shown/edited in the settings modal
  // below (settings.tier_silver/gold/platinum) — previously hardcoded to
  // 40/100/300 here, so changing the setting had no effect anywhere it's used.
  const tier = useCallback((points: number) => {
    if (points >= settings.tier_platinum) return { label: 'פלטינום', color: '#60a5fa', icon: '💎' };
    if (points >= settings.tier_gold)     return { label: 'זהב', color: '#f59e0b', icon: '🥇' };
    if (points >= settings.tier_silver)   return { label: 'כסף', color: '#9ca3af', icon: '🥈' };
    return { label: 'רגיל', color: '#6b7280', icon: '⭐' };
  }, [settings.tier_silver, settings.tier_gold, settings.tier_platinum]);

  const beginRequest = useLatestRequest();

  const loadAll = useCallback(async () => {
    // `search` is debounced but still user-driven — without this, a slow
    // response for an earlier query overwrites the results for the current one.
    const latest = beginRequest();
    setLoading(true);
    try {
      const [s, c, l] = await Promise.all([
        customersApi.stats(),
        customersApi.list({ sort, limit: 100, search: search || undefined }),
        customersApi.leaderboard(),
      ]);
      latest(() => {
        setStats(s.data);
        setCustomers(Array.isArray(c.data) ? c.data : []);
        setLeaderboard(Array.isArray(l.data) ? l.data : []);
      });
    } catch { /* ignore */ }
    latest(() => setLoading(false));
  }, [sort, search, beginRequest]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useSyncEvent('customer.updated', loadAll);

  // Load settings on mount
  useEffect(() => {
    customersApi.getSettings().then(({ data }) => setSettings(data)).catch(() => {});
  }, []);

  const saveSettings = async () => {
    setSettingsLoading(true);
    try {
      await customersApi.saveSettings(settings);
      toast('הגדרות נשמרו', 'success');
      setShowSettings(false);
    } catch { toast('שגיאה בשמירה', 'error'); }
    setSettingsLoading(false);
  };

  // Phone lookup with debounce
  useEffect(() => {
    if (visitPhone.replace(/\D/g,'').length < 7) { setVisitCustomer(null); return; }
    const t = setTimeout(async () => {
      setLookingUp(true);
      try {
        const { data } = await customersApi.lookup(visitPhone);
        setVisitCustomer(data || null);
      } catch { /* ignore */ }
      setLookingUp(false);
    }, 400);
    return () => clearTimeout(t);
  }, [visitPhone]);

  const registerVisit = async () => {
    if (!visitCustomer && visitPhone.replace(/\D/g,'').length < 7) {
      toast('הזן מספר טלפון תקין', 'error'); return;
    }
    setVisitLoading(true);
    try {
      let cust = visitCustomer;
      if (!cust) {
        const { data } = await customersApi.create({ phone: visitPhone });
        cust = data;
      }
      const { data } = await customersApi.visit(cust!.id, {
        amount: parseFloat(visitAmount) || 0,
        note: visitNote || undefined,
      });
      toast(`✓ ${data.pointsEarned ? `+${data.pointsEarned} נקודות ל${cust!.name || 'לקוח'}` : 'ביקור נרשם'}`, 'success');
      setVisitPhone(''); setVisitAmount(''); setVisitNote(''); setVisitCustomer(null);
      loadAll();
    } catch { toast('שגיאה ברישום הביקור', 'error'); }
    setVisitLoading(false);
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const { data } = await customersApi.get(id);
      setSelected(data);
    } catch { /* ignore */ }
    setDetailLoading(false);
  };

  const createCustomer = async () => {
    if (!newForm.phone) { toast('טלפון חובה', 'error'); return; }
    setNewLoading(true);
    try {
      await customersApi.create(newForm);
      toast('לקוח נוסף בהצלחה', 'success');
      setShowNew(false);
      setNewForm({ name: '', phone: '', email: '', birthday: '' });
      loadAll();
    } catch { toast('שגיאה בהוספת לקוח', 'error'); }
    setNewLoading(false);
  };

  const deleteCustomer = async (id: string, name?: string) => {
    const ok = await confirm(`למחוק את ${name || 'הלקוח'}?`);
    if (!ok) return;
    try {
      await customersApi.remove(id);
      toast('לקוח נמחק', 'success');
      setSelected(null);
      loadAll();
    } catch { toast('שגיאה במחיקה', 'error'); }
  };

  // ── render ─────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Crown className="w-7 h-7 text-yellow-400" />
            לויאלטי לקוחות
          </h1>
          <p className="text-sm text-gray-400 mt-1">עקוב אחרי לקוחות חוזרים, נקודות ומגמות</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="gap-2">
          <Plus className="w-4 h-4" /> לקוח חדש
        </Button>
        <Button variant="secondary" onClick={() => setShowSettings(true)} className="gap-2">
          <Settings className="w-4 h-4" /> הגדרות
        </Button>
      </div>

      {/* KPI cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'סה"כ לקוחות',   value: stats.total_customers,  icon: Users,       color: 'text-blue-400',   bg: 'bg-blue-500/10' },
            { label: 'פעילים החודש',   value: stats.active_this_month, icon: Flame,      color: 'text-orange-400', bg: 'bg-orange-500/10' },
            { label: 'חדשים החודש',    value: stats.new_this_month,   icon: TrendingUp,  color: 'text-green-400',  bg: 'bg-green-500/10' },
            { label: 'ביקורים היום',   value: stats.visits_today,     icon: ShoppingBag, color: 'text-purple-400', bg: 'bg-purple-500/10' },
            { label: 'לקוחות VIP',     value: stats.vip_count,        icon: Star,        color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
            { label: 'הכנסה כוללת',    value: fmtMoney(stats.total_revenue_all), icon: Gift, color: 'text-pink-400', bg: 'bg-pink-500/10', raw: true },
          ].map(({ label, value, icon: Icon, color, bg, raw }) => (
            <div key={label} className="rounded-xl bg-gray-800 border border-gray-700 p-4 flex flex-col gap-2">
              <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center`}>
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
              <div className="text-xl font-bold text-white">{raw ? value : value.toLocaleString()}</div>
              <div className="text-xs text-gray-400">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── Quick Visit Panel ─────────────────────────── */}
        <div className="lg:col-span-1 rounded-xl bg-gray-800 border border-gray-700 p-5 space-y-4">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-purple-400" /> רישום ביקור מהיר
          </h2>

          <div className="space-y-3">
            <div className="relative">
              <Phone className="absolute right-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                value={visitPhone}
                onChange={e => setVisitPhone(e.target.value)}
                placeholder="מספר טלפון לקוח..."
                className="w-full bg-gray-700 border border-gray-600 rounded-lg pr-9 pl-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-purple-500"
                dir="ltr"
              />
            </div>

            {lookingUp && <p className="text-xs text-gray-400">מחפש לקוח...</p>}

            {visitCustomer && (
              <div className="rounded-lg bg-purple-500/10 border border-purple-500/30 p-3 flex items-center justify-between">
                <div>
                  <p className="font-medium text-white">{visitCustomer.name || visitCustomer.phone}</p>
                  <p className="text-xs text-gray-400">{visitCustomer.total_visits} ביקורים · {visitCustomer.points} נק׳</p>
                </div>
                <span className="text-lg">{tier(visitCustomer.points).icon}</span>
              </div>
            )}

            {visitPhone.replace(/\D/g,'').length >= 7 && !visitCustomer && !lookingUp && (
              <p className="text-xs text-yellow-400">לקוח חדש — ייווצר אוטומטית</p>
            )}

            <input
              value={visitAmount}
              onChange={e => setVisitAmount(e.target.value)}
              placeholder="סכום הרכישה (₪)"
              type="number"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-purple-500"
              dir="ltr"
            />
            <input
              value={visitNote}
              onChange={e => setVisitNote(e.target.value)}
              placeholder="הערה (אופציונלי)"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-purple-500"
            />

            <Button
              onClick={registerVisit}
              disabled={visitLoading || visitPhone.replace(/\D/g,'').length < 7}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              {visitLoading ? 'רושם...' : 'רשום ביקור'}
            </Button>
          </div>

          {/* Points info */}
          <div className="rounded-lg bg-gray-700/50 p-3 text-xs text-gray-400 space-y-1">
            <p className="font-medium text-gray-300">מבנה נקודות:</p>
            <p>⭐ רגיל — 0–39 נק׳</p>
            <p>🥈 כסף — 40–99 נק׳</p>
            <p>🥇 זהב — 100–299 נק׳</p>
            <p>💎 פלטינום — 300+ נק׳</p>
            <p className="mt-2 text-gray-500">1 נקודה לכל ₪10</p>
          </div>
        </div>

        {/* ── Leaderboard ───────────────────────────────── */}
        <div className="lg:col-span-1 rounded-xl bg-gray-800 border border-gray-700 p-5">
          <h2 className="font-semibold text-white flex items-center gap-2 mb-4">
            <Trophy className="w-4 h-4 text-yellow-400" /> לוח מצטיינים
          </h2>
          <div className="space-y-2">
            {leaderboard.length === 0 && (
              <p className="text-gray-500 text-sm">אין נתונים עדיין</p>
            )}
            {leaderboard.map((c, i) => {
              const t = tier(c.points);
              return (
                <button
                  key={c.id}
                  onClick={() => openDetail(c.id)}
                  className="w-full flex items-center gap-3 rounded-lg p-2.5 hover:bg-gray-700 transition text-right"
                >
                  <span className="text-base w-6 text-center font-bold text-gray-400">
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}`}
                  </span>
                  <span className="text-base">{t.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{c.name || c.phone}</p>
                    <p className="text-xs text-gray-400">{c.total_visits} ביקורים · {fmtMoney(c.total_spent)}</p>
                  </div>
                  <span className="text-sm font-bold" style={{ color: t.color }}>{c.points} נק׳</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Birthday this month ───────────────────────── */}
        <div className="lg:col-span-1 rounded-xl bg-gray-800 border border-gray-700 p-5">
          <h2 className="font-semibold text-white flex items-center gap-2 mb-4">
            <Calendar className="w-4 h-4 text-pink-400" /> יומולדות החודש
          </h2>
          {(() => {
            const currentMonth = new Date().getMonth() + 1;
            const birthdays = customers.filter(c => {
              if (!c.birthday) return false;
              return new Date(c.birthday).getMonth() + 1 === currentMonth;
            });
            if (birthdays.length === 0) return <p className="text-gray-500 text-sm">אין יומולדות החודש</p>;
            return (
              <div className="space-y-2">
                {birthdays.map(c => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg p-2.5 bg-pink-500/10 border border-pink-500/20">
                    <span className="text-xl">🎂</span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">{c.name || c.phone}</p>
                      <p className="text-xs text-gray-400">{fmtDate(c.birthday)}</p>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Customer List ─────────────────────────────────── */}
      <div className="rounded-xl bg-gray-800 border border-gray-700 p-5">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" /> כל הלקוחות
          </h2>
          <div className="flex gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute right-3 top-2.5 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="חיפוש שם/טלפון..."
                className="bg-gray-700 border border-gray-600 rounded-lg pr-9 pl-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 w-52"
              />
            </div>
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
            >
              <option value="last_visit">ביקור אחרון</option>
              <option value="total_visits">הכי ביקורים</option>
              <option value="points">הכי נקודות</option>
              <option value="total_spent">הכי הוצאה</option>
              <option value="created_at">תאריך הצטרפות</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 py-8">טוען...</div>
        ) : customers.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>אין לקוחות עדיין</p>
            <p className="text-xs mt-1">רשום ביקור ראשון כדי להוסיף לקוח</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700 text-right">
                  <th className="pb-2 font-medium">לקוח</th>
                  <th className="pb-2 font-medium">טלפון</th>
                  <th className="pb-2 font-medium text-center">ביקורים</th>
                  <th className="pb-2 font-medium text-center">נקודות</th>
                  <th className="pb-2 font-medium text-center">הוצאה</th>
                  <th className="pb-2 font-medium">ביקור אחרון</th>
                  <th className="pb-2 font-medium text-center">דרגה</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {customers.map(c => {
                  const t = tier(c.points);
                  return (
                    <tr key={c.id} className="hover:bg-gray-700/30 transition">
                      <td className="py-2.5 font-medium text-white">{c.name || '—'}</td>
                      <td className="py-2.5 text-gray-300 font-mono text-xs" dir="ltr">{c.phone}</td>
                      <td className="py-2.5 text-center text-gray-300">{c.total_visits}</td>
                      <td className="py-2.5 text-center font-semibold" style={{ color: t.color }}>{c.points}</td>
                      <td className="py-2.5 text-center text-gray-300">{fmtMoney(c.total_spent)}</td>
                      <td className="py-2.5 text-gray-400 text-xs">{fmtDate(c.last_visit)}</td>
                      <td className="py-2.5 text-center">
                        <span className="text-base" title={t.label}>{t.icon}</span>
                      </td>
                      <td className="py-2.5">
                        <button
                          onClick={() => openDetail(c.id)}
                          className="text-gray-400 hover:text-white transition p-1"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Customer Detail Modal ─────────────────────────── */}
      {selected && (
        <Modal open onClose={() => setSelected(null)} title={selected.name || selected.phone}>
          {detailLoading ? (
            <p className="text-gray-400 text-center py-8">טוען...</p>
          ) : (
            <div className="space-y-4" dir="rtl">
              {/* Tier badge */}
              {(() => {
                const t = tier(selected.points);
                return (
                  <div className="flex items-center gap-3 rounded-xl p-4" style={{ background: `${t.color}15`, border: `1px solid ${t.color}40` }}>
                    <span className="text-3xl">{t.icon}</span>
                    <div>
                      <p className="font-bold text-white text-lg">{t.label}</p>
                      <p className="text-sm text-gray-400">{selected.points} נקודות</p>
                    </div>
                    <div className="mr-auto text-left">
                      <p className="text-2xl font-bold text-white">{selected.total_visits}</p>
                      <p className="text-xs text-gray-400">ביקורים</p>
                    </div>
                  </div>
                );
              })()}

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  { label: 'טלפון',        value: selected.phone, dir: 'ltr' as const },
                  { label: 'אימייל',       value: selected.email || '—' },
                  { label: 'הצטרף',        value: fmtDate(selected.first_visit) },
                  { label: 'ביקור אחרון',  value: fmtDate(selected.last_visit) },
                  { label: 'סה"כ הוצאה',  value: fmtMoney(selected.total_spent) },
                  { label: 'יום הולדת',    value: fmtDate(selected.birthday) },
                ].map(({ label, value, dir }) => (
                  <div key={label} className="rounded-lg bg-gray-700/50 p-3">
                    <p className="text-xs text-gray-400">{label}</p>
                    <p className="font-medium text-white mt-0.5" dir={dir || 'rtl'}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Visit history */}
              {(selected.visits || []).length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-300 mb-2">היסטוריית ביקורים</p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(selected.visits || []).map(v => (
                      <div key={v.id} className="flex items-center justify-between rounded-lg bg-gray-700/40 px-3 py-2 text-sm">
                        <span className="text-gray-400 text-xs">{fmtDate(v.visited_at)}</span>
                        <span className="text-gray-300">{fmtMoney(v.amount)}</span>
                        <span className="text-yellow-400 text-xs">+{v.points_earned} נק׳</span>
                        {v.note && <span className="text-gray-500 text-xs truncate max-w-24">{v.note}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick visit from modal */}
              <div className="rounded-xl bg-purple-500/10 border border-purple-500/20 p-4 space-y-3">
                <p className="text-sm font-medium text-purple-300">רשום ביקור עכשיו</p>
                <div className="flex gap-2">
                  <input
                    id="modal-amount"
                    type="number"
                    placeholder="₪ סכום"
                    className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                    dir="ltr"
                  />
                  <Button
                    className="bg-purple-600 hover:bg-purple-700 text-sm px-4"
                    disabled={modalVisitLoading}
                    onClick={async () => {
                      if (modalVisitLoading) return;
                      const el = document.getElementById('modal-amount') as HTMLInputElement;
                      const amt = parseFloat(el?.value || '0');
                      setModalVisitLoading(true);
                      try {
                        const { data } = await customersApi.visit(selected.id, { amount: amt });
                        toast(`✓ +${data.pointsEarned} נקודות`, 'success');
                        const { data: fresh } = await customersApi.get(selected.id);
                        setSelected(fresh);
                        loadAll();
                        if (el) el.value = '';
                      } catch { toast('שגיאה', 'error'); }
                      finally { setModalVisitLoading(false); }
                    }}
                  >
                    {modalVisitLoading ? '...' : 'רשום'}
                  </Button>
                </div>
              </div>

              <Button
                variant="danger"
                className="w-full text-sm"
                onClick={() => deleteCustomer(selected.id, selected.name)}
              >
                מחק לקוח
              </Button>
            </div>
          )}
        </Modal>
      )}

      {/* ── New Customer Modal ────────────────────────────── */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="הוספת לקוח חדש">
        <div className="space-y-3" dir="rtl">
          {[
            { label: 'שם', key: 'name', type: 'text', placeholder: 'שם הלקוח' },
            { label: 'טלפון *', key: 'phone', type: 'tel', placeholder: '05X-XXXXXXX' },
            { label: 'אימייל', key: 'email', type: 'email', placeholder: 'email@example.com' },
            { label: 'יום הולדת', key: 'birthday', type: 'date', placeholder: '' },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key}>
              <label className="block text-sm text-gray-400 mb-1">{label}</label>
              <input
                type={type}
                value={newForm[key as keyof typeof newForm]}
                onChange={e => setNewForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                dir={type === 'email' || type === 'tel' ? 'ltr' : 'rtl'}
              />
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Button onClick={createCustomer} disabled={newLoading} className="flex-1">
              {newLoading ? 'מוסיף...' : 'הוסף לקוח'}
            </Button>
            <Button variant="secondary" onClick={() => setShowNew(false)} className="flex-1">ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* ── Settings Modal ────────────────────────────────── */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="הגדרות תוכנית לויאלטי">
        <div className="space-y-5" dir="rtl">
          <div>
            <label className="block text-sm text-gray-400 mb-1">נקודות לכל ₪1</label>
            <div className="flex items-center gap-3">
              <input
                type="number" step="0.01" min="0.01" max="10"
                value={settings.points_per_shekel}
                onChange={e => setSettings(s => ({ ...s, points_per_shekel: parseFloat(e.target.value) || 0.1 }))}
                className="w-28 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                dir="ltr"
              />
              <span className="text-xs text-gray-400">
                כלומר: לכל ₪{(1 / settings.points_per_shekel).toFixed(0)} = 1 נקודה
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: '🥈 כסף מ-', key: 'tier_silver' as const },
              { label: '🥇 זהב מ-',  key: 'tier_gold' as const },
              { label: '💎 פלטינום מ-', key: 'tier_platinum' as const },
            ].map(({ label, key }) => (
              <div key={key}>
                <label className="block text-xs text-gray-400 mb-1">{label}</label>
                <input
                  type="number" min="1"
                  value={settings[key]}
                  onChange={e => setSettings(s => ({ ...s, [key]: parseInt(e.target.value) || 0 }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  dir="ltr"
                />
                <p className="text-xs text-gray-500 mt-0.5">נקודות</p>
              </div>
            ))}
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">טקסט פרס (מוצג ללקוחות)</label>
            <input
              value={settings.reward_text}
              onChange={e => setSettings(s => ({ ...s, reward_text: e.target.value }))}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="לדוגמה: אחרי 10 ביקורים — קפה בחינם!"
            />
          </div>

          <div className="rounded-lg bg-indigo-500/10 border border-indigo-500/20 p-3 text-xs text-indigo-300">
            <p className="font-medium mb-1">תצוגה מקדימה:</p>
            <p>⭐ רגיל — 0–{settings.tier_silver - 1} נק׳</p>
            <p>🥈 כסף — {settings.tier_silver}–{settings.tier_gold - 1} נק׳</p>
            <p>🥇 זהב — {settings.tier_gold}–{settings.tier_platinum - 1} נק׳</p>
            <p>💎 פלטינום — {settings.tier_platinum}+ נק׳</p>
          </div>

          <div className="flex gap-2 pt-1">
            <Button onClick={saveSettings} disabled={settingsLoading} className="flex-1 bg-indigo-600 hover:bg-indigo-700">
              {settingsLoading ? 'שומר...' : 'שמור הגדרות'}
            </Button>
            <Button variant="secondary" onClick={() => setShowSettings(false)} className="flex-1">ביטול</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
