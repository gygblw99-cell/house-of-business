'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CalendarOff, HelpCircle } from 'lucide-react';
import api from '@/lib/api/client';
import { useSyncEvent } from '@/context/SyncContext';

/**
 * States the coverage answer honestly instead of letting a figure imply the data
 * is there. Every revenue number in the platform comes from Z-reports, and this
 * pipeline has failed silently before — an expired Gmail token, a BOM that broke
 * parsing — with the UI showing totals rather than admitting it had nothing.
 */

interface Gap { from: string; to: string; days: number }

interface Coverage {
  range: { from: string; to: string; days: number | null };
  verdict: 'complete' | 'partial' | 'empty' | 'no_data' | 'closed_period' | 'unknown';
  canReportFinancials: boolean;
  coverage: number | null;
  expectedDayCount: number | null;
  presentDayCount: number | null;
  missingDays: string[];
  gaps: Gap[];
  firstReportDate: string | null;
  ingestion: { configured: boolean; broken: boolean; staleDays: number | null; reason: string | null };
  explanation: string[];
}

const LOOK = {
  complete:      { icon: CheckCircle2,  color: '#2f7157', bg: 'rgba(47,113,87,0.10)',  border: 'rgba(47,113,87,0.35)',  label: 'הנתונים מלאים' },
  closed_period: { icon: CalendarOff,   color: '#5f6573', bg: 'rgba(95,101,115,0.10)', border: 'rgba(95,101,115,0.30)', label: 'אין מה לצפות בתקופה הזאת' },
  partial:       { icon: AlertTriangle, color: '#b4651a', bg: 'rgba(180,101,26,0.10)', border: 'rgba(180,101,26,0.35)', label: 'נתונים חלקיים' },
  empty:         { icon: AlertTriangle, color: '#a93a37', bg: 'rgba(169,58,55,0.10)',  border: 'rgba(169,58,55,0.35)',  label: 'אין נתונים לתקופה' },
  no_data:       { icon: AlertTriangle, color: '#a93a37', bg: 'rgba(169,58,55,0.10)',  border: 'rgba(169,58,55,0.35)',  label: 'לא יובא אף דוח Z' },
  unknown:       { icon: HelpCircle,    color: '#5f6573', bg: 'rgba(95,101,115,0.10)', border: 'rgba(95,101,115,0.30)', label: 'לא ניתן לאמת' },
} as const;

function fmt(d: string) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

export default function ZCoverageBanner({ from, to }: { from?: string; to?: string }) {
  const [cov, setCov] = useState<Coverage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to)   params.to   = to;
      const { data } = await api.get<Coverage>('/zreport/coverage', { params });
      setCov(data);
      setFailed(false);
    } catch {
      // Not knowing is itself worth saying — staying silent here is the exact
      // failure mode this banner exists to prevent.
      setFailed(true);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['dashboard.refresh', 'finance.updated'], load);

  if (failed) {
    const L = LOOK.unknown;
    return (
      <Shell look={L}>
        <strong style={{ color: L.color }}>לא ניתן לאמת את זמינות הנתונים</strong>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
          בדיקת הכיסוי נכשלה. אל תסתמך על סכומים לתקופה הזאת עד שהבדיקה תעבור.
        </p>
      </Shell>
    );
  }

  if (!cov) return null;

  const L = LOOK[cov.verdict] ?? LOOK.unknown;
  const pct = cov.coverage === null ? null : Math.round(cov.coverage * 100);

  return (
    <Shell look={L}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <strong style={{ color: L.color, fontSize: 15 }}>{L.label}</strong>
        {pct !== null && cov.expectedDayCount ? (
          <span style={{ fontSize: 12.5, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
            {cov.presentDayCount}/{cov.expectedDayCount} ימי פעילות ({pct}%)
          </span>
        ) : null}
        <span style={{ fontSize: 12, opacity: 0.55 }}>
          {fmt(cov.range.from)} — {fmt(cov.range.to)}
        </span>
      </div>

      {cov.explanation.map((line, i) => (
        <p key={i} style={{ margin: 0, fontSize: 13, opacity: 0.85 }}>{line}</p>
      ))}

      {cov.gaps.length > 0 && (
        <div style={{ fontSize: 12.5, opacity: 0.8 }}>
          <span style={{ opacity: 0.7 }}>ימים חסרים: </span>
          {cov.gaps.slice(0, 6).map((g, i) => (
            <span key={i} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {g.days === 1 ? fmt(g.from) : `${fmt(g.from)}–${fmt(g.to)} (${g.days} ימים)`}
              {i < Math.min(cov.gaps.length, 6) - 1 ? ' · ' : ''}
            </span>
          ))}
          {cov.gaps.length > 6 && <span> ועוד {cov.gaps.length - 6}</span>}
        </div>
      )}

      {!cov.canReportFinancials && cov.verdict !== 'closed_period' && (
        <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: L.color }}>
          סכומים לתקופה הזאת אינם מלאים — אל תסתמך עליהם לדיווח.
        </p>
      )}
    </Shell>
  );
}

function Shell({ look, children }: { look: typeof LOOK[keyof typeof LOOK]; children: React.ReactNode }) {
  const Icon = look.icon;
  return (
    <div
      className="rounded-2xl"
      style={{
        background: look.bg,
        border: `1px solid ${look.border}`,
        padding: '14px 16px',
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <Icon size={18} style={{ color: look.color, flex: 'none', marginTop: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>{children}</div>
    </div>
  );
}
