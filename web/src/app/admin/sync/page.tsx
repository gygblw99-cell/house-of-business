'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/adminClient';
import {
  Activity, Wifi, WifiOff, RefreshCw, Zap,
  AlertTriangle, CheckCircle, Building2, ShieldCheck,
  Clock, TrendingUp, Users,
} from 'lucide-react';


interface SyncStatus {
  total_businesses: number;
  active_sse_connections: number;
  connections_per_business: Record<string, number>;
  low_stock_businesses: number;
  sales_last_24h: number;
  last_sale: string | null;
  active_businesses_7d: number;
  synced_at: string;
}

interface SSEBusiness {
  business_id: string;
  business_name: string;
  connections: number;
}

interface SSEConnections {
  total: number;
  businesses: SSEBusiness[];
}

function Stat({
  icon: Icon,
  label,
  value,
  color,
  sub,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string | number;
  color: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: color + '18' }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <p className="text-2xl font-black text-slate-800">{value}</p>
      <p className="text-sm font-medium text-slate-500 mt-0.5">{label}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function AdminSyncPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [connections, setConnections] = useState<SSEConnections | null>(null);
  const [loading, setLoading] = useState(true);
  const [busting, setBusting] = useState(false);
  const [bustResult, setBustResult] = useState<{ busted: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statusRes, connRes] = await Promise.all([
        adminFetch(`/admin/sync/status`),
        adminFetch(`/admin/sse/connections`),
      ]);
      if (statusRes.status === 401 || statusRes.status === 403) { router.replace('/admin/login'); return; }
      if (!statusRes.ok || !connRes.ok) throw new Error('שגיאת שרת');
      const [s, c] = await Promise.all([statusRes.json(), connRes.json()]);
      setStatus(s);
      setConnections(c);
      setLastRefresh(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleFullSync = async () => {
    if (!confirm('מחיקת כל הקאש לכל העסקים — להמשיך?')) return;
    setBusting(true);
    setBustResult(null);
    setError('');
    try {
      const res = await adminFetch(`/admin/sync/full-all`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'שגיאה בסנכרון מלא');
      setBustResult(data);
      await fetchAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'שגיאה בסנכרון מלא');
    } finally {
      setBusting(false);
    }
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('he-IL', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error && !status) {
    return <div className="text-center text-red-500 py-8 text-sm">{error}</div>;
  }

  const healthOk = status ? status.low_stock_businesses === 0 : false;

  return (
    <div className="max-w-4xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">מרכז סנכרון</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            רענון אוטומטי כל 10 שניות · עדכון אחרון:{' '}
            {lastRefresh.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            רענן
          </button>
          <button
            onClick={handleFullSync}
            disabled={busting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: busting ? '#94a3b8' : '#f59e0b' }}
          >
            <Zap className="w-4 h-4" />
            {busting ? 'מסנכרן...' : 'סנכרון מלא לכל העסקים'}
          </button>
        </div>
      </div>

      {/* Bust result banner */}
      {bustResult && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium flex items-center gap-2"
          style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d' }}>
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          סנכרון מלא הושלם — {bustResult.busted}/{bustResult.total} עסקים רועננו
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium flex items-center gap-2"
          style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Overall health badge */}
      <div
        className="mb-6 p-4 rounded-2xl flex items-center gap-3"
        style={{
          background: healthOk ? 'linear-gradient(135deg,#f0fdf4,#dcfce7)' : 'linear-gradient(135deg,#fef9ec,#fef3c7)',
          border: healthOk ? '1px solid #bbf7d0' : '1px solid #fde68a',
        }}
      >
        {healthOk
          ? <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          : <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />}
        <div>
          <p className="font-bold text-sm" style={{ color: healthOk ? '#15803d' : '#92400e' }}>
            {healthOk ? 'מצב הסנכרון תקין' : 'יש התראות פעילות'}
          </p>
          <p className="text-xs mt-0.5" style={{ color: healthOk ? '#166534' : '#a16207' }}>
            {status?.low_stock_businesses
              ? `${status.low_stock_businesses} עסקים עם מלאי נמוך`
              : 'אין עסקים עם בעיות מלאי'}
          </p>
        </div>
        <div className="mr-auto text-xs font-mono" style={{ color: healthOk ? '#15803d' : '#92400e' }}>
          עדכון: {formatTime(status?.synced_at ?? null)}
        </div>
      </div>

      {/* Stats grid */}
      {status && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <Stat icon={Building2}  label="סה״כ עסקים"         value={status.total_businesses}       color="#3b82f6" />
          <Stat icon={Wifi}       label="חיבורי SSE פעילים"  value={status.active_sse_connections}  color="#10b981"
            sub={`מתוך ${status.total_businesses} עסקים`} />
          <Stat icon={TrendingUp} label="מכירות 24ש׳"        value={status.sales_last_24h.toLocaleString('he-IL')} color="#f59e0b"
            sub={`מכירה אחרונה: ${formatTime(status.last_sale)}`} />
          <Stat icon={AlertTriangle} label="עסקים עם מלאי נמוך" value={status.low_stock_businesses}  color={status.low_stock_businesses > 0 ? '#ef4444' : '#10b981'} />
        </div>
      )}

      {/* SSE connections per business */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between"
          style={{ background: '#fafafa' }}>
          <div className="flex items-center gap-2">
            <Wifi className="w-4 h-4 text-emerald-600" />
            <h2 className="font-bold text-slate-700 text-sm">חיבורי SSE פעילים</h2>
          </div>
          <span className="text-xs font-bold px-2.5 py-1 rounded-full"
            style={{ background: '#dcfce7', color: '#15803d' }}>
            {connections?.total ?? 0} חיבורים
          </span>
        </div>

        {!connections?.businesses.length ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <WifiOff className="w-8 h-8 text-slate-200 mb-2" />
            <p className="text-sm text-slate-400">אין חיבורים פעילים כרגע</p>
            <p className="text-xs text-slate-300 mt-1">משתמשים שמחוברים לפלטפורמה יופיעו כאן</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {connections.businesses.map((biz) => (
              <div key={biz.business_id} className="flex items-center gap-4 px-5 py-3">
                <div className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse" />
                <p className="flex-1 text-sm font-medium text-slate-700">{biz.business_name}</p>
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-xs font-bold text-slate-600">{biz.connections}</span>
                  <span className="text-xs text-slate-400">לשונית{biz.connections !== 1 ? 'ות' : ''}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-slate-500">
        <div className="flex items-center gap-2 bg-white rounded-xl p-3 border border-slate-100">
          <Activity className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <span>SSE = ערוץ עדכון בזמן אמת לכל טאב פתוח</span>
        </div>
        <div className="flex items-center gap-2 bg-white rounded-xl p-3 border border-slate-100">
          <Clock className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span>הנתונים מתרעננים אוטומטית כל 10 שניות</span>
        </div>
        <div className="flex items-center gap-2 bg-white rounded-xl p-3 border border-slate-100">
          <ShieldCheck className="w-4 h-4 text-emerald-500 flex-shrink-0" />
          <span>סנכרון מלא מוחק את כל ה-cache ומרענן</span>
        </div>
      </div>
    </div>
  );
}
