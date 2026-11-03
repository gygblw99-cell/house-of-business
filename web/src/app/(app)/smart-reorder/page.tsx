'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, Sparkles } from 'lucide-react';
import { inventoryApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/utils';

interface Suggestion {
  name: string;
  priority: 'critical' | 'high' | 'medium';
  current_qty: number;
  min_qty: number;
  unit: string;
  recommended_order_qty: number;
  estimated_cost: number;
  supplier: string;
  reasoning: string;
}

interface Result {
  suggestions: Suggestion[];
  generated_at: string;
  message?: string;
}

const PRIORITY_COLOR = {
  critical: '#f87171',
  high:     '#fbbf24',
  medium:   '#60a5fa',
};
const PRIORITY_LABEL = {
  critical: 'קריטי',
  high:     'גבוה',
  medium:   'בינוני',
};

export default function SmartReorderPage() {
  const [data, setData]       = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  const load = () => {
    setLoading(true);
    setError(false);
    inventoryApi.reorderSuggestions()
      .then((r) => setData(r.data as Result))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useSyncEvent('inventory.updated', load);

  const totalEstCost = data?.suggestions.reduce((s, sg) => s + (sg.estimated_cost || 0), 0) || 0;
  const bySeverity = (sev: string) => data?.suggestions.filter(s => s.priority === sev).length || 0;

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6" style={{ color: '#c9a227' }} />
            הזמנה חכמה — AI
          </h1>
          <p className="text-sm opacity-60 mt-0.5">המלצות הזמנה מבוססות AI על פי צריכה היסטורית ומלאי נוכחי</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* KPIs */}
      {data && !data.message && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'פריטים לרכש', value: data.suggestions.length, color: '#c9a227' },
            { label: 'קריטי', value: bySeverity('critical'), color: '#f87171' },
            { label: 'גבוה', value: bySeverity('high'), color: '#fbbf24' },
            { label: 'עלות משוערת', value: formatCurrency(totalEstCost), color: '#4ade80' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-2xl p-4"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
              <p className="text-2xl font-black" style={{ color }}>{value}</p>
              <p className="text-xs opacity-60 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-red-400" />
            <p className="font-semibold text-red-400">טעינת ההמלצות נכשלה</p>
            <Button variant="outline" onClick={load} className="mt-3">נסה שוב</Button>
          </CardContent>
        </Card>
      ) : data?.message ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-400" />
            <p className="font-semibold text-green-400">{data.message}</p>
            <p className="text-xs opacity-50 mt-1">כל פריטי המלאי מעל סף המינימום</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(data?.suggestions || []).map((sg, i) => (
            <div key={i} className="rounded-2xl p-4"
              style={{
                background: 'var(--card-bg)',
                border: `1px solid ${PRIORITY_COLOR[sg.priority] || 'var(--card-border-color)'}33`,
              }}>
              <div className="flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm">{sg.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                      style={{
                        background: `${PRIORITY_COLOR[sg.priority]}22`,
                        color: PRIORITY_COLOR[sg.priority],
                        border: `1px solid ${PRIORITY_COLOR[sg.priority]}44`,
                      }}>
                      {PRIORITY_LABEL[sg.priority]}
                    </span>
                  </div>
                  <p className="text-xs opacity-50 mt-1">{sg.reasoning}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs flex-wrap">
                    <span className="opacity-60">מלאי נוכחי: <strong className="text-white">{sg.current_qty} {sg.unit}</strong></span>
                    <span className="opacity-60">מינימום: <strong className="text-white">{sg.min_qty} {sg.unit}</strong></span>
                    <span className="opacity-60">ספק: <strong className="text-white">{sg.supplier}</strong></span>
                  </div>
                </div>
                <div className="text-left flex-shrink-0 space-y-1">
                  <div className="text-center">
                    <p className="text-xs opacity-40">כמות להזמנה</p>
                    <p className="text-lg font-black" style={{ color: '#c9a227' }}>
                      {sg.recommended_order_qty} {sg.unit}
                    </p>
                  </div>
                  {sg.estimated_cost > 0 && (
                    <div className="text-center">
                      <p className="text-xs opacity-40">עלות משוערת</p>
                      <p className="text-sm font-bold text-white">{formatCurrency(sg.estimated_cost)}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <p className="text-xs opacity-30 text-center">
          עודכן: {new Date(data.generated_at).toLocaleString('he-IL')}
        </p>
      )}
    </div>
  );
}
