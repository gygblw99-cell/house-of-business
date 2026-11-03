'use client';
import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X, ChevronLeft, RefreshCw, Users, TrendingUp, Zap, Calendar } from 'lucide-react';
import { adminFetch } from '@/lib/adminClient';
import { useAdminSyncEvent } from '@/hooks/useAdminSyncEvent';


interface Business {
  id: string;
  name: string;
  business_type: string;
  email: string;
  created_at: string;
  user_count: number;
  total_revenue: number;
  ai_tokens_month: number;
  health_score: number;
  last_activity: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  is_active: boolean;
}

interface BusinessDetail {
  business: Business & { [key: string]: unknown };
  users: Array<{ id: string; full_name: string; email: string; role: string; is_active: boolean; created_at: string }>;
  revenue: { revenue_30d: number; revenue_60d: number; revenue_90d: number };
  ai_usage: Array<{ feature: string; tokens: number; cost: number }>;
  recent_activity: Array<{ action: string; entity_type: string; created_at: string; description: string }>;
}

function HealthBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? { bg: '#dcfce7', text: '#166534', border: '#bbf7d0' }
      : score >= 60
      ? { bg: '#fef9c3', text: '#854d0e', border: '#fef08a' }
      : score >= 40
      ? { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa' }
      : { bg: '#fee2e2', text: '#991b1b', border: '#fecaca' };
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-bold"
      style={{ background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
    >
      {score}
    </span>
  );
}

function formatNumber(n: number) {
  return n >= 1_000_000
    ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000
    ? (n / 1_000).toFixed(1) + 'K'
    : n.toString();
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function AdminBusinessesPage() {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const detailReqId = useRef<string | null>(null);


  const fetchBusinesses = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch(`/admin/businesses?limit=200`);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBusinesses(data.businesses);
      setTotal(data.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  };

  const fetchDetail = async (id: string) => {
    detailReqId.current = id;
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await adminFetch(`/admin/businesses/${id}`);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      const data = await res.json();
      // Ignore this response if the admin has since selected a different business.
      if (res.ok && detailReqId.current === id) setDetail(data);
    } catch { /* ignore */ } finally {
      if (detailReqId.current === id) setDetailLoading(false);
    }
  };

  const toggleSuspend = async (biz: Business) => {
    const isSuspended = !!biz.suspended_at;
    if (isSuspended) {
      if (!confirm(`להפעיל מחדש את הגישה של "${biz.name}"?`)) return;
    } else {
      if (!confirm(`להשהות את הגישה של "${biz.name}"? המשתמשים עדיין יוכלו להתחבר אך יראו מסך "מושהה עד לתשלום" בלבד.`)) return;
    }
    const reason = isSuspended ? undefined : (prompt('סיבת ההשהיה (יוצג ללקוח, אופציונלי):') || undefined);

    setSuspending(true);
    try {
      const res = await adminFetch(`/admin/businesses/${biz.id}/${isSuspended ? 'unsuspend' : 'suspend'}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: isSuspended ? undefined : JSON.stringify({ reason }),
      });
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'העדכון נכשל');
      await fetchBusinesses();
      if (selected === biz.id) await fetchDetail(biz.id);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setSuspending(false);
    }
  };

  useEffect(() => { fetchBusinesses(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Suspend / unsuspend / billing / active-flag all publish business.updated —
  // including when another admin makes the change in their own session.
  useAdminSyncEvent('business.updated', () => fetchBusinesses());

  useEffect(() => {
    if (selected) fetchDetail(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = businesses.filter(b =>
    b.name.toLowerCase().includes(search.toLowerCase()) ||
    (b.business_type || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">עסקים</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {total} עסקים רשומים
            {businesses.length < total && ` (מוצגים ${businesses.length} — השתמש בחיפוש כדי לצמצם)`}
          </p>
        </div>
        <button
          onClick={fetchBusinesses}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          רענן
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="חפש עסק לפי שם או סוג..."
          className="w-full pr-10 pl-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400 transition-colors"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute left-3 top-1/2 -translate-y-1/2">
            <X className="w-4 h-4 text-slate-400" />
          </button>
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
                  <th className="text-right px-4 py-3">שם</th>
                  <th className="text-right px-4 py-3">סוג</th>
                  <th className="text-right px-4 py-3">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" />משתמשים</span>
                  </th>
                  <th className="text-right px-4 py-3">
                    <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" />הכנסות (30י')</span>
                  </th>
                  <th className="text-right px-4 py-3">
                    <span className="flex items-center gap-1"><Zap className="w-3 h-3" />AI טוקנים</span>
                  </th>
                  <th className="text-right px-4 py-3">Health</th>
                  <th className="text-right px-4 py-3">
                    <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />נוצר</span>
                  </th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-slate-400">לא נמצאו עסקים</td>
                  </tr>
                ) : filtered.map(biz => (
                  <tr
                    key={biz.id}
                    className="border-t border-slate-50 hover:bg-blue-50/40 transition-colors cursor-pointer"
                    onClick={() => setSelected(biz.id === selected ? null : biz.id)}
                  >
                    <td className="px-4 py-3.5 font-semibold text-slate-800">
                      <span className="flex items-center gap-2">
                        {biz.name}
                        {biz.suspended_at && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-600 border border-red-200">
                            מושהה
                          </span>
                        )}
                        {!biz.is_active && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                            כבוי
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-500 text-xs">{biz.business_type || '—'}</td>
                    <td className="px-4 py-3.5 text-slate-700">{biz.user_count}</td>
                    <td className="px-4 py-3.5 text-slate-700">₪{formatNumber(Math.round(biz.total_revenue))}</td>
                    <td className="px-4 py-3.5 text-slate-500">{formatNumber(biz.ai_tokens_month)}</td>
                    <td className="px-4 py-3.5"><HealthBadge score={biz.health_score} /></td>
                    <td className="px-4 py-3.5 text-slate-400 text-xs">{formatDate(biz.created_at)}</td>
                    <td className="px-4 py-3.5">
                      <ChevronLeft className={`w-4 h-4 text-slate-400 transition-transform ${selected === biz.id ? 'rotate-90' : ''}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Slide-over panel */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex"
          style={{ direction: 'rtl' }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSelected(null)} />
          <div
            className="absolute left-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl overflow-y-auto"
            style={{ direction: 'rtl' }}
          >
            {/* Panel header */}
            <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-center justify-between z-10">
              <h2 className="font-bold text-slate-800">
                {businesses.find(b => b.id === selected)?.name || 'פרטי עסק'}
              </h2>
              <div className="flex items-center gap-2">
                {detail && (
                  <button
                    onClick={() => toggleSuspend(detail.business)}
                    disabled={suspending}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 ${
                      detail.business.suspended_at
                        ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                        : 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                    }`}
                  >
                    {detail.business.suspended_at ? 'הפעל מחדש' : 'השהה עסק'}
                  </button>
                )}
                <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 space-y-5">
              {detailLoading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : detail ? (
                <>
                  {detail.business.suspended_at && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
                      <p className="font-bold text-red-700 mb-1">עסק מושהה</p>
                      <p className="text-red-600">
                        {(detail.business.suspended_reason as string) || 'ללא סיבה מצוינת'}
                      </p>
                      <p className="text-red-400 text-xs mt-1">
                        מאז {formatDate(detail.business.suspended_at as string)}
                      </p>
                    </div>
                  )}

                  {!detail.business.is_active && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm">
                      <p className="font-bold text-slate-700 mb-1">התהליכים האוטומטיים כבויים</p>
                      <p className="text-slate-500">
                        לא מתבצעת שאיבת דוחות Z מהמייל, לא רצים ניתוחי AI ולא נשלחות התראות.
                        הנתונים הקיימים נשמרים והמשתמשים יכולים להתחבר ולצפות בהם.
                      </p>
                    </div>
                  )}

                  {/* Business info */}
                  <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm">
                    <p className="text-slate-500">אימייל: <span className="text-slate-700 font-medium">{detail.business.email || '—'}</span></p>
                    <p className="text-slate-500">סוג: <span className="text-slate-700 font-medium">{detail.business.business_type || '—'}</span></p>
                    <p className="text-slate-500">נוצר: <span className="text-slate-700 font-medium">{formatDate(detail.business.created_at as string)}</span></p>
                    <p className="text-slate-500">התקשרות: <span className="text-slate-700 font-medium">{
                      detail.business.contract_type === 'trial' ? 'חודש ניסיון'
                        : detail.business.contract_type === 'year' ? 'שנה'
                        : detail.business.contract_type === 'custom' ? `${detail.business.contract_months} חודשים`
                        : '—'
                    }</span></p>
                  </div>

                  {/* Revenue */}
                  <div>
                    <h3 className="font-semibold text-slate-700 text-sm mb-3">הכנסות</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: '30 יום', value: detail.revenue?.revenue_30d ?? 0 },
                        { label: '31-60 יום', value: detail.revenue?.revenue_60d ?? 0 },
                        { label: '61-90 יום', value: detail.revenue?.revenue_90d ?? 0 },
                      ].map(r => (
                        <div key={r.label} className="bg-blue-50 rounded-xl p-3 text-center">
                          <p className="text-lg font-bold text-blue-700">₪{formatNumber(Math.round(r.value))}</p>
                          <p className="text-xs text-blue-500 mt-0.5">{r.label}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Users */}
                  <div>
                    <h3 className="font-semibold text-slate-700 text-sm mb-3">משתמשים ({detail.users.length})</h3>
                    <div className="space-y-1.5">
                      {detail.users.slice(0, 8).map(u => (
                        <div key={u.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-sm">
                          <div>
                            <span className="font-medium text-slate-700">{u.full_name}</span>
                            <span className="text-slate-400 text-xs mr-2">{u.email}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">{u.role}</span>
                            <span className={`w-2 h-2 rounded-full ${u.is_active ? 'bg-green-400' : 'bg-red-400'}`} />
                          </div>
                        </div>
                      ))}
                      {detail.users.length > 8 && (
                        <p className="text-xs text-slate-400 text-center">ועוד {detail.users.length - 8} משתמשים</p>
                      )}
                    </div>
                  </div>

                  {/* AI Usage */}
                  {detail.ai_usage.length > 0 && (
                    <div>
                      <h3 className="font-semibold text-slate-700 text-sm mb-3">שימוש AI (חודש)</h3>
                      <div className="space-y-1.5">
                        {detail.ai_usage.map((a, i) => (
                          <div key={i} className="flex items-center justify-between bg-amber-50 rounded-lg px-3 py-2 text-sm">
                            <span className="text-slate-700 font-medium">{a.feature}</span>
                            <div className="text-left">
                              <span className="text-amber-600 font-mono text-xs">{formatNumber(parseInt(String(a.tokens)))} טוקנים</span>
                              <span className="text-slate-400 text-xs mr-2">${parseFloat(String(a.cost)).toFixed(4)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent activity */}
                  {detail.recent_activity.length > 0 && (
                    <div>
                      <h3 className="font-semibold text-slate-700 text-sm mb-3">פעילות אחרונה</h3>
                      <div className="space-y-1.5">
                        {detail.recent_activity.map((a, i) => (
                          <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-lg px-3 py-2 text-xs">
                            <span className="text-slate-400 shrink-0">{formatDate(a.created_at)}</span>
                            <span className="text-slate-600">{a.description || `${a.action} — ${a.entity_type}`}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-slate-400 text-sm text-center py-8">לא נמצאו פרטים</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
