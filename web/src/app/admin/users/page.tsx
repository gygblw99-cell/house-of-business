'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X, RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react';
import { adminFetch } from '@/lib/adminClient';


interface User {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  business_name: string;
  business_id: string;
}

const ROLES = ['הכל', 'owner', 'partner', 'manager', 'employee'];

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעלים',
  partner: 'שותף',
  manager: 'מנהל',
  employee: 'עובד',
};

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  owner: { bg: '#ede9fe', text: '#6d28d9' },
  partner: { bg: '#dbeafe', text: '#1d4ed8' },
  manager: { bg: '#dcfce7', text: '#166534' },
  employee: { bg: '#f1f5f9', text: '#475569' },
};

function formatDate(d: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('הכל');
  const [bizFilter, setBizFilter] = useState('הכל');
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');


  const fetchUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminFetch(`/admin/users?limit=200`);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUsers(data.users);
      setTotal(data.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  };

  const toggleStatus = async (user: User) => {
    if (user.is_active && !confirm(`להשבית את המשתמש "${user.full_name}"? הוא לא יוכל להתחבר יותר.`)) return;
    setTogglingId(user.id);
    setActionError('');
    try {
      const res = await adminFetch(`/admin/users/${user.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !user.is_active }),
      });
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'העדכון נכשל');
      const data = await res.json();
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: data.is_active } : u));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'העדכון נכשל');
    } finally {
      setTogglingId(null);
    }
  };

  useEffect(() => { fetchUsers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unique businesses for filter
  const businesses = ['הכל', ...Array.from(new Set(users.map(u => u.business_name).filter(Boolean)))];

  const filtered = users.filter(u => {
    const matchSearch =
      (u.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (u.email ?? '').toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === 'הכל' || u.role === roleFilter;
    const matchBiz = bizFilter === 'הכל' || u.business_name === bizFilter;
    return matchSearch && matchRole && matchBiz;
  });

  return (
    <div className="max-w-7xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">משתמשים</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {total} משתמשים רשומים
            {users.length < total && ` (מוצגים ${users.length} — השתמש בחיפוש כדי לצמצם)`}
          </p>
        </div>
        <button
          onClick={fetchUsers}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          רענן
        </button>
      </div>

      {actionError && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium bg-red-50 border border-red-200 text-red-600">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        {/* Search */}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="חפש שם, אימייל..."
            className="w-full pr-10 pl-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute left-3 top-1/2 -translate-y-1/2">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          )}
        </div>

        {/* Role filter */}
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400 transition-colors"
        >
          {ROLES.map(r => <option key={r} value={r}>{r === 'הכל' ? 'כל התפקידים' : (ROLE_LABELS[r] || r)}</option>)}
        </select>

        {/* Business filter */}
        <select
          value={bizFilter}
          onChange={e => setBizFilter(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 outline-none focus:border-blue-400 transition-colors max-w-48"
        >
          {businesses.map(b => <option key={b} value={b}>{b === 'הכל' ? 'כל העסקים' : b}</option>)}
        </select>
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
                  <th className="text-right px-4 py-3">אימייל</th>
                  <th className="text-right px-4 py-3">תפקיד</th>
                  <th className="text-right px-4 py-3">עסק</th>
                  <th className="text-right px-4 py-3">סטטוס</th>
                  <th className="text-right px-4 py-3">נוצר</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-slate-400">לא נמצאו משתמשים</td>
                  </tr>
                ) : filtered.map(user => {
                  const roleColor = ROLE_COLORS[user.role] || ROLE_COLORS.employee;
                  return (
                    <tr key={user.id} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3.5 font-semibold text-slate-800">{user.full_name}</td>
                      <td className="px-4 py-3.5 text-slate-500 text-xs">{user.email}</td>
                      <td className="px-4 py-3.5">
                        <span
                          className="px-2 py-0.5 rounded-full text-xs font-semibold"
                          style={{ background: roleColor.bg, color: roleColor.text }}
                        >
                          {ROLE_LABELS[user.role] || user.role}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-slate-600 text-xs">{user.business_name || '—'}</td>
                      <td className="px-4 py-3.5">
                        <button
                          onClick={() => toggleStatus(user)}
                          disabled={togglingId === user.id}
                          className="flex items-center gap-1.5 transition-colors"
                          style={{ opacity: togglingId === user.id ? 0.5 : 1 }}
                        >
                          {user.is_active ? (
                            <>
                              <ToggleRight className="w-5 h-5 text-green-500" />
                              <span className="text-xs text-green-600 font-medium">פעיל</span>
                            </>
                          ) : (
                            <>
                              <ToggleLeft className="w-5 h-5 text-slate-400" />
                              <span className="text-xs text-slate-400">מושבת</span>
                            </>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3.5 text-slate-400 text-xs">{formatDate(user.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer count */}
          <div className="px-4 py-3 border-t border-slate-50 bg-slate-50 text-xs text-slate-400 text-left">
            מציג {filtered.length} מתוך {users.length} משתמשים
          </div>
        </div>
      )}
    </div>
  );
}
