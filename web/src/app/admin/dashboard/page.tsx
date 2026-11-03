'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Users, Zap, DollarSign, TrendingUp, RefreshCw } from 'lucide-react';
import { adminFetch } from '@/lib/adminClient';


interface Stats {
  total_businesses: number;
  total_users: number;
  ai_tokens_month: number;
  ai_cost_month: number;
  active_businesses_30d: number;
  top_businesses: Array<{
    id: string;
    name: string;
    total_revenue: number;
    ai_tokens: number;
    health_score: number;
  }>;
}

function HealthBadge({ score }: { score: number }) {
  const style =
    score >= 80
      ? { bg: 'rgba(16,185,129,0.12)', text: '#34d399', border: 'rgba(16,185,129,0.25)' }
      : score >= 60
      ? { bg: 'rgba(201,162,39,0.12)', text: '#c9a227', border: 'rgba(201,162,39,0.25)' }
      : score >= 40
      ? { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b', border: 'rgba(245,158,11,0.25)' }
      : { bg: 'rgba(239,68,68,0.12)', text: '#f87171', border: 'rgba(239,68,68,0.25)' };

  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-bold"
      style={{ background: style.bg, color: style.text, border: `1px solid ${style.border}` }}
    >
      {score}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: '#141418',
        border: '1px solid rgba(201,162,39,0.14)',
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: color + '18' }}
        >
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
      </div>
      <p className="text-2xl font-black" style={{ color: 'rgba(232,232,228,0.92)' }}>{value}</p>
      <p className="text-sm font-medium mt-0.5" style={{ color: 'rgba(232,232,228,0.55)' }}>{label}</p>
      {sub && <p className="text-xs mt-1" style={{ color: 'rgba(232,232,228,0.3)' }}>{sub}</p>}
    </div>
  );
}

export default function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchStats = async () => {
    setLoading(true);
    setError('');
    try {
        const res = await adminFetch(`/admin/stats`);
      if (res.status === 401 || res.status === 403) {
        router.replace('/admin/login');
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load stats');
      setStats(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה בטעינת נתונים');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStats(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div
          className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: 'rgba(201,162,39,0.5)', borderTopColor: 'transparent' }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>
        <button
          onClick={fetchStats}
          className="text-sm hover:underline"
          style={{ color: '#c9a227' }}
        >
          נסה שוב
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const formatNumber = (n: number) =>
    n >= 1_000_000
      ? (n / 1_000_000).toFixed(1) + 'M'
      : n >= 1_000
      ? (n / 1_000).toFixed(1) + 'K'
      : n.toString();

  const formatCost = (n: number) => '$' + n.toFixed(4);
  const formatRevenue = (n: number) => '₪' + formatNumber(Math.round(n));

  return (
    <div className="max-w-6xl mx-auto" dir="rtl">
      {/* Header */}
      <div
        className="rounded-2xl px-6 py-5 mb-6 flex items-center justify-between"
        style={{
          background: 'linear-gradient(145deg,#0f0f14,#141418)',
          border: '1px solid rgba(201,162,39,0.18)',
        }}
      >
        <div>
          <h1 className="text-2xl font-black" style={{ color: 'rgba(232,232,228,0.95)' }}>
            Dashboard
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'rgba(232,232,228,0.4)' }}>
            סקירה כללית של המערכת
          </p>
        </div>
        <button
          onClick={fetchStats}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all"
          style={{
            background: 'rgba(201,162,39,0.06)',
            border: '1px solid rgba(201,162,39,0.2)',
            color: 'rgba(232,232,228,0.6)',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = '#c9a227';
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(201,162,39,0.4)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'rgba(232,232,228,0.6)';
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(201,162,39,0.2)';
          }}
        >
          <RefreshCw className="w-4 h-4" />
          רענן
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={Building2}
          label="עסקים רשומים"
          value={formatNumber(stats.total_businesses)}
          sub={`${stats.active_businesses_30d} פעילים ב-30 יום`}
          color="#c9a227"
        />
        <StatCard
          icon={Users}
          label="משתמשים"
          value={formatNumber(stats.total_users)}
          color="#a78bfa"
        />
        <StatCard
          icon={Zap}
          label="AI טוקנים (חודש)"
          value={formatNumber(stats.ai_tokens_month)}
          color="#34d399"
        />
        <StatCard
          icon={DollarSign}
          label="עלות AI (חודש)"
          value={formatCost(stats.ai_cost_month)}
          color="#60a5fa"
        />
      </div>

      {/* Top Businesses */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: '#141418',
          border: '1px solid rgba(201,162,39,0.14)',
        }}
      >
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid rgba(201,162,39,0.1)' }}
        >
          <TrendingUp className="w-5 h-5" style={{ color: '#c9a227' }} />
          <h2 className="font-bold" style={{ color: 'rgba(232,232,228,0.85)' }}>
            עסקים מובילים (לפי הכנסות)
          </h2>
        </div>

        {stats.top_businesses.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: 'rgba(232,232,228,0.3)' }}>
            אין נתונים
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-xs font-medium uppercase tracking-wide"
                  style={{
                    background: 'rgba(201,162,39,0.04)',
                    borderBottom: '1px solid rgba(201,162,39,0.1)',
                    color: 'rgba(232,232,228,0.35)',
                  }}
                >
                  <th className="text-right px-5 py-3">#</th>
                  <th className="text-right px-5 py-3">שם עסק</th>
                  <th className="text-right px-5 py-3">הכנסות (30י')</th>
                  <th className="text-right px-5 py-3">AI טוקנים</th>
                  <th className="text-right px-5 py-3">Health Score</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_businesses.map((biz, i) => (
                  <tr
                    key={biz.id}
                    style={{ borderBottom: '1px solid rgba(201,162,39,0.06)' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'rgba(201,162,39,0.03)')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
                  >
                    <td className="px-5 py-3.5 font-mono text-xs" style={{ color: 'rgba(201,162,39,0.4)' }}>
                      {i + 1}
                    </td>
                    <td className="px-5 py-3.5 font-semibold" style={{ color: 'rgba(232,232,228,0.85)' }}>
                      {biz.name}
                    </td>
                    <td className="px-5 py-3.5" style={{ color: 'rgba(232,232,228,0.6)' }}>
                      {formatRevenue(biz.total_revenue)}
                    </td>
                    <td className="px-5 py-3.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                      {formatNumber(parseInt(String(biz.ai_tokens)) || 0)}
                    </td>
                    <td className="px-5 py-3.5">
                      <HealthBadge score={biz.health_score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
