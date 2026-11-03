'use client';

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCw, CheckCircle2, AlertTriangle, Clock,
  ChevronDown, ChevronUp, Flag, X, Send, User } from 'lucide-react';
import { formatDateTime, getErrorMessage } from '@/lib/utils';
import api from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ── Config ──────────────────────────────────────────────────────────────────────

const TICKET_STATUS_TABS = [
  { key: 'open',        label: 'פתוחים' },
  { key: 'in_progress', label: 'בטיפול' },
  { key: 'resolved',    label: 'נפתרו'  },
  { key: 'all',         label: 'הכל'    },
];

const SEVERITY_CFG: Record<string, { label: string; color: string; dot: string }> = {
  critical: { label: 'קריטית', color: 'text-red-600',    dot: 'bg-red-500'    },
  high:     { label: 'גבוהה',  color: 'text-orange-600', dot: 'bg-orange-500' },
  medium:   { label: 'בינונית',color: 'text-yellow-600', dot: 'bg-yellow-500' },
  low:      { label: 'נמוכה',  color: 'text-blue-600',   dot: 'bg-blue-400'   },
};

const ISSUE_TYPE_LABEL: Record<string, string> = {
  platform: 'בעיה בפלטפורמה',
  billing:  'בעיה בחיוב',
  feature:  'בקשת פיצ׳ר',
  other:    'אחר',
};

const ISSUE_TYPES = [
  { value: 'platform', label: 'בעיה בפלטפורמה' },
  { value: 'billing',  label: 'בעיה בחיוב'     },
  { value: 'feature',  label: 'בקשת פיצ׳ר'     },
  { value: 'other',    label: 'אחר'             },
];

interface SupportTicket {
  id: string;
  business_name: string;
  issue_type: string;
  title: string;
  description?: string;
  severity: string;
  status: string;
  admin_note?: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}

// ── Sub-components ──────────────────────────────────────────────────────────────

function TicketRow({ ticket, onUpdate }: { ticket: SupportTicket; onUpdate: () => void }) {
  const { toast } = useAppDialog();
  const [expanded, setExpanded] = useState(false);
  const [note,     setNote]     = useState(ticket.admin_note || '');
  const [saving,   setSaving]   = useState(false);
  const sev = SEVERITY_CFG[ticket.severity] ?? SEVERITY_CFG.medium;

  const updateStatus = async (status: string) => {
    setSaving(true);
    try {
      await api.patch(`/guardian/admin/tickets/${ticket.id}`, { status, adminNote: note });
      onUpdate();
    } catch (err) { toast(getErrorMessage(err) || 'עדכון הפנייה נכשל', 'error'); }
    setSaving(false);
  };

  return (
    <div className={`border rounded-xl overflow-hidden ${
      ticket.status === 'open'        ? 'border-red-100 bg-red-50/30'     :
      ticket.status === 'in_progress' ? 'border-amber-100 bg-amber-50/30' :
                                        'border-emerald-100 bg-emerald-50/30'
    }`}>
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v); } }}
      >
        <span className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${sev.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-[#e8e8e4] text-sm">{ticket.title}</p>
            <span className="text-xs bg-[#1a1a20] text-[rgba(232,232,228,0.6)] px-2 py-0.5 rounded-full">
              {ISSUE_TYPE_LABEL[ticket.issue_type] ?? ticket.issue_type}
            </span>
            <span className={`text-xs font-semibold ${sev.color}`}>{sev.label}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-[rgba(232,232,228,0.4)] flex-wrap">
            <span className="flex items-center gap-1"><User className="w-3 h-3" />{ticket.business_name || 'עסק לא ידוע'}</span>
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDateTime(ticket.created_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${
            ticket.status === 'open'        ? 'bg-red-100 text-red-700'     :
            ticket.status === 'in_progress' ? 'bg-amber-100 text-amber-700' :
                                              'bg-emerald-100 text-emerald-700'
          }`}>
            {ticket.status === 'open' ? 'פתוח' : ticket.status === 'in_progress' ? 'בטיפול' : 'נפתר'}
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-[rgba(232,232,228,0.4)]" /> : <ChevronDown className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-[rgba(201,162,39,0.14)] pt-3">
          {ticket.description && <p className="text-sm text-[rgba(232,232,228,0.6)] leading-relaxed">{ticket.description}</p>}
          <div>
            <label className="block text-xs font-semibold text-[rgba(232,232,228,0.4)] mb-1">הערת אדמין</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
              placeholder="הוסף הערה פנימית..."
              className="w-full border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-[#0f0f14] text-[#e8e8e4]" />
          </div>
          <div className="flex gap-2 flex-wrap">
            {ticket.status !== 'in_progress' && (
              <button onClick={() => updateStatus('in_progress')} disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
                {saving ? '...' : 'העבר לטיפול'}
              </button>
            )}
            {ticket.status !== 'resolved' && (
              <button onClick={() => updateStatus('resolved')} disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                <CheckCircle2 className="w-3 h-3 inline ml-1" />{saving ? '...' : 'סמן כנפתר'}
              </button>
            )}
            {ticket.status !== 'open' && (
              <button onClick={() => updateStatus('open')} disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#1a1a20] text-[rgba(232,232,228,0.6)] hover:bg-[rgba(201,162,39,0.06)] disabled:opacity-50">
                {saving ? '...' : 'פתח מחדש'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportIssueModal({ onClose }: { onClose: () => void }) {
  const { toast } = useAppDialog();
  const [issueType, setIssueType] = useState('platform');
  const [title,     setTitle]     = useState('');
  const [desc,      setDesc]      = useState('');
  const [severity,  setSeverity]  = useState('medium');
  const [sending,   setSending]   = useState(false);
  const [sent,      setSent]      = useState(false);

  const handleSend = async () => {
    if (!title.trim()) return;
    setSending(true);
    try {
      await api.post('/guardian/tickets', { issueType, title: title.trim(), description: desc.trim(), severity });
      setSent(true);
    } catch (err) {
      toast(getErrorMessage(err) || 'שגיאה בשליחה — נסה שנית', 'error');
    }
    setSending(false);
  };

  const content = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" dir="rtl">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#141418] rounded-2xl shadow-2xl overflow-hidden border border-[rgba(201,162,39,0.16)]">
        <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-l from-violet-600 to-indigo-600 text-white">
          <div className="flex items-center gap-2">
            <Flag className="w-5 h-5" />
            <h3 className="font-bold text-base">דווח על תקלה</h3>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {sent ? (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
              <p className="font-bold text-[#e8e8e4]">הדיווח נשלח בהצלחה</p>
              <p className="text-sm text-[rgba(232,232,228,0.4)] mt-1">צוות התמיכה יטפל בפנייתך בהקדם</p>
              <button onClick={onClose} className="mt-4 px-5 py-2 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700">סגור</button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-semibold text-[rgba(232,232,228,0.72)] mb-1">סוג התקלה</label>
                <select value={issueType} onChange={e => setIssueType(e.target.value)}
                  className="w-full border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-[#0f0f14] text-[#e8e8e4]">
                  {ISSUE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-[rgba(232,232,228,0.72)] mb-1">כותרת הבעיה</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="תאר בקצרה את הבעיה..."
                  className="w-full border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-[#0f0f14] text-[#e8e8e4]" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-[rgba(232,232,228,0.72)] mb-1">פרטים נוספים</label>
                <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={3}
                  placeholder="ספר לנו מה קרה, מתי, ואיך לשחזר את הבעיה..."
                  className="w-full border border-[rgba(201,162,39,0.16)] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none bg-[#0f0f14] text-[#e8e8e4]" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-[rgba(232,232,228,0.72)] mb-1">דחיפות</label>
                <div className="flex gap-2">
                  {['low','medium','high','critical'].map(s => (
                    <button key={s} onClick={() => setSeverity(s)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        severity === s ? 'bg-violet-600 text-white border-violet-600' : 'border-[rgba(201,162,39,0.16)] text-[rgba(232,232,228,0.6)] hover:border-violet-300'
                      }`}>
                      {s === 'low' ? 'נמוכה' : s === 'medium' ? 'בינונית' : s === 'high' ? 'גבוהה' : 'קריטית'}
                    </button>
                  ))}
                </div>
              </div>
              <button onClick={handleSend} disabled={!title.trim() || sending}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition-colors">
                <Send className="w-4 h-4" /> {sending ? 'שולח...' : 'שלח דיווח'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(content, document.body) : null;
}

// ── Main Page ───────────────────────────────────────────────────────────────────

export default function GuardianPage() {
  const { toast } = useAppDialog();
  const [tickets,    setTickets]    = useState<SupportTicket[]>([]);
  const [tickFilter, setTickFilter] = useState('open');
  const [showReport, setShowReport] = useState(false);
  const [loading, setLoading] = useState(true);

  const beginRequest = useLatestRequest();

  const loadTickets = useCallback(async () => {
    const latest = beginRequest();
    try {
      const { data } = await api.get('/guardian/tickets', { params: { status: tickFilter } });
      latest(() => setTickets(data.tickets || []));
    } catch (err) { latest(() => toast(getErrorMessage(err) || 'שגיאה בטעינת הפניות', 'error')); }
  }, [tickFilter, toast, beginRequest]);

  const load = useCallback(async () => {
    setLoading(true);
    await loadTickets();
    setLoading(false);
  }, [loadTickets]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent(['ticket.updated'], loadTickets);

  const openTickets = tickets.filter(t => t.status === 'open').length;

  return (
    <div className="space-y-6" dir="rtl">

      {showReport && <ReportIssueModal onClose={() => { setShowReport(false); loadTickets(); }} />}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">פניות ותקלות</h1>
          <p className="text-sm text-[rgba(232,232,228,0.4)] mt-0.5">
            {openTickets > 0 ? `${openTickets} פניות פתוחות` : 'אין פניות פתוחות'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={load} className="gap-1.5">
            <RefreshCw className="w-4 h-4" /> רענן
          </Button>
          <Button onClick={() => setShowReport(true)}
            className="bg-red-500 hover:bg-red-600 text-white border-0 gap-1.5 shadow-md">
            <Flag className="w-4 h-4" /> דווח על תקלה
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'פתוחות', count: tickets.filter(t => t.status === 'open').length,        icon: AlertTriangle, color: 'text-red-600',    bg: 'bg-red-50'     },
          { label: 'בטיפול', count: tickets.filter(t => t.status === 'in_progress').length, icon: Clock,         color: 'text-amber-600',  bg: 'bg-amber-50'   },
          { label: 'נפתרו',  count: tickets.filter(t => t.status === 'resolved').length,    icon: CheckCircle2,  color: 'text-emerald-600',bg: 'bg-emerald-50' },
        ].map(({ label, count, icon: Icon, color, bg }) => (
          <div key={label} className={`${bg} rounded-xl p-4 flex items-center justify-between`}>
            <div>
              <p className="text-xs text-[rgba(232,232,228,0.4)]">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{count}</p>
            </div>
            <Icon className={`w-6 h-6 ${color} opacity-50`} />
          </div>
        ))}
      </div>

      {/* Filter Tabs */}
      <div className="flex rounded-xl bg-[#111116] p-1 gap-0.5 w-fit border border-[rgba(201,162,39,0.1)]">
        {TICKET_STATUS_TABS.map(t => (
          <button key={t.key} onClick={() => setTickFilter(t.key)}
            className={`text-xs px-4 py-2 rounded-lg font-medium transition-all ${
              tickFilter === t.key ? 'bg-[#1a1a20] text-[#e8e8e4] shadow-sm border border-[rgba(201,162,39,0.2)]' : 'text-[rgba(232,232,228,0.42)] hover:text-[rgba(232,232,228,0.7)]'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tickets List */}
      {loading ? (
        <div className="text-center py-12 text-[rgba(232,232,228,0.4)]">טוען...</div>
      ) : tickets.filter(t => tickFilter === 'all' || t.status === tickFilter).length === 0 ? (
        <div className="text-center py-16 bg-[#141418] rounded-2xl border border-[rgba(201,162,39,0.14)]">
          <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
          <p className="text-[rgba(232,232,228,0.42)] font-medium">אין פניות בסטטוס זה</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets
            .filter(t => tickFilter === 'all' || t.status === tickFilter)
            .map(t => <TicketRow key={t.id} ticket={t} onUpdate={loadTickets} />)}
        </div>
      )}

    </div>
  );
}
