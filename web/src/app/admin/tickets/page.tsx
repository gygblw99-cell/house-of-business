'use client';
import { adminFetch } from '@/lib/adminClient';
import { useAdminSyncEvent } from '@/hooks/useAdminSyncEvent';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import {
  Ticket, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle2, Clock, AlertCircle, Building2, User, Calendar, MessageSquare, Send } from 'lucide-react';

interface SupportTicket {
  id:            string;
  business_id:   string;
  business_name: string;
  owner_name:    string;
  owner_email?:  string;
  issue_type:    string;
  title:         string;
  description?:  string;
  severity:      'critical' | 'high' | 'medium' | 'low';
  status:        'open' | 'in_progress' | 'resolved';
  admin_note?:   string;
  created_at:    string;
  updated_at:    string;
  resolved_at?:  string;
}


const STATUS_CONFIG = {
  open:        { label: 'פתוח',    color: '#ef4444', bg: 'rgba(254,226,226,0.7)', icon: AlertCircle },
  in_progress: { label: 'בטיפול', color: '#f97316', bg: 'rgba(255,237,213,0.7)', icon: Clock },
  resolved:    { label: 'נסגר',   color: '#22c55e', bg: 'rgba(220,252,231,0.7)', icon: CheckCircle2 },
};

const SEVERITY_CONFIG = {
  critical: { label: 'קריטי',  color: '#dc2626', bg: '#fee2e2' },
  high:     { label: 'גבוה',   color: '#ea580c', bg: '#ffedd5' },
  medium:   { label: 'בינוני', color: '#d97706', bg: '#fef9c3' },
  low:      { label: 'נמוך',   color: '#6b7280', bg: '#f3f4f6' },
};

const FILTER_TABS = [
  { value: 'all',         label: 'הכל' },
  { value: 'open',        label: 'פתוחות' },
  { value: 'in_progress', label: 'בטיפול' },
  { value: 'resolved',    label: 'נסגרו' },
];

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminTicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving,   setSaving]   = useState<string | null>(null);
  const [notes, setNotes]       = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState('');

  const beginRequest = useLatestRequest();

  const load = useCallback(async (status = filter) => {
    const latest = beginRequest();
    setLoading(true);
    try {
      const url = status === 'all'
        ? `/admin/support-tickets`
        : `/admin/support-tickets?status=${status}`;
      const res = await adminFetch(url);
      if (res.status === 401 || res.status === 403) { router.replace('/admin/login'); return; }
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      latest(() => setTickets(data.tickets || []));
    } catch {
      latest(() => setTickets([]));
    } finally {
      latest(() => setLoading(false));
    }
  }, [filter, router, beginRequest]);

  useEffect(() => { load(filter); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: the backend publishes ticket.updated whenever a ticket is created or
  // its status changes, including from another admin's session.
  useAdminSyncEvent('ticket.updated', () => load(filter));

  const setStatus = async (id: string, status: string) => {
    setSaving(id);
    setActionError('');
    try {
      const body: Record<string, string> = { status };
      if (notes[id] !== undefined) body.adminNote = notes[id];
      const res = await adminFetch(`/admin/support-tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'העדכון נכשל');
      await load(filter);
      setExpanded(null);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'העדכון נכשל');
    }
    setSaving(null);
  };

  const saveNote = async (id: string) => {
    if (!notes[id]) return;
    setSaving(id);
    setActionError('');
    try {
      const res = await adminFetch(`/admin/support-tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminNote: notes[id] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'שמירת ההערה נכשלה');
      await load(filter);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'שמירת ההערה נכשלה');
    }
    setSaving(null);
  };

  const openCount = tickets.filter(t => t.status === 'open').length;

  return (
    <div dir="rtl" style={{ color: 'rgba(232,232,228,0.9)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(201,162,39,0.12)', border: '1px solid rgba(201,162,39,0.25)' }}>
            <Ticket className="w-5 h-5" style={{ color: '#c9a227' }} />
          </div>
          <div>
            <h1 className="text-xl font-black" style={{ color: 'rgba(232,232,228,0.95)' }}>תקלות משתמשים</h1>
            {openCount > 0 && (
              <p className="text-xs" style={{ color: '#ef4444' }}>{openCount} קריאות פתוחות</p>
            )}
          </div>
        </div>
        <button
          onClick={() => load(filter)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all"
          style={{ background: 'rgba(201,162,39,0.1)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.2)' }}
        >
          <RefreshCw className="w-4 h-4" />
          רענן
        </button>
      </div>

      {actionError && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
          {actionError}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className="px-4 py-1.5 rounded-xl text-sm font-semibold transition-all"
            style={
              filter === tab.value
                ? { background: 'rgba(201,162,39,0.18)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.35)' }
                : { background: 'rgba(255,255,255,0.04)', color: 'rgba(232,232,228,0.45)', border: '1px solid rgba(255,255,255,0.07)' }
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-16" style={{ color: 'rgba(232,232,228,0.3)' }}>טוען...</div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-16 rounded-2xl"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <Ticket className="w-10 h-10 mx-auto mb-3" style={{ color: 'rgba(232,232,228,0.15)' }} />
          <p style={{ color: 'rgba(232,232,228,0.35)' }}>אין קריאות תמיכה</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map(ticket => {
            const isExpanded = expanded === ticket.id;
            const sev = SEVERITY_CONFIG[ticket.severity] ?? SEVERITY_CONFIG.medium;
            const sta = STATUS_CONFIG[ticket.status] ?? STATUS_CONFIG.open;
            const StaIcon = sta.icon;

            return (
              <div key={ticket.id}
                className="rounded-2xl overflow-hidden"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${ticket.status === 'open' ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'}`,
                }}>
                {/* Row */}
                <button
                  className="w-full flex items-center gap-4 px-5 py-4 text-right transition-all"
                  style={{ background: isExpanded ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                  onClick={() => setExpanded(isExpanded ? null : ticket.id)}
                >
                  {/* Severity dot */}
                  <div className="flex-shrink-0 w-2.5 h-2.5 rounded-full" style={{ background: sev.color }} />

                  {/* Business + owner */}
                  <div className="flex-1 min-w-0 text-right">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-semibold text-sm" style={{ color: 'rgba(232,232,228,0.9)' }}>
                        {ticket.title}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0"
                        style={{ background: sev.bg + '33', color: sev.color, border: `1px solid ${sev.color}44` }}>
                        {sev.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1 text-xs" style={{ color: 'rgba(232,232,228,0.45)' }}>
                        <Building2 className="w-3 h-3" /> {ticket.business_name || '—'}
                      </span>
                      {ticket.owner_name && (
                        <span className="flex items-center gap-1 text-xs" style={{ color: 'rgba(232,232,228,0.45)' }}>
                          <User className="w-3 h-3" /> {ticket.owner_name}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-xs" style={{ color: 'rgba(232,232,228,0.3)' }}>
                        <Calendar className="w-3 h-3" /> {fmt(ticket.created_at)}
                      </span>
                    </div>
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl flex-shrink-0"
                    style={{ background: sta.bg + '33', border: `1px solid ${sta.color}44` }}>
                    <StaIcon className="w-3.5 h-3.5" style={{ color: sta.color }} />
                    <span className="text-xs font-semibold" style={{ color: sta.color }}>{sta.label}</span>
                  </div>

                  {/* Expand arrow */}
                  <div style={{ color: 'rgba(232,232,228,0.25)' }}>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-5 pb-5 space-y-4"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>

                    {/* Description */}
                    {ticket.description && (
                      <div className="pt-4">
                        <p className="text-xs font-semibold mb-1.5" style={{ color: 'rgba(232,232,228,0.4)' }}>
                          תיאור התקלה
                        </p>
                        <p className="text-sm leading-relaxed p-3 rounded-xl whitespace-pre-wrap"
                          style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(232,232,228,0.75)', border: '1px solid rgba(255,255,255,0.07)' }}>
                          {ticket.description}
                        </p>
                      </div>
                    )}

                    {/* Owner email */}
                    {ticket.owner_email && (
                      <div>
                        <p className="text-xs font-semibold mb-1" style={{ color: 'rgba(232,232,228,0.4)' }}>אימייל בעלים</p>
                        <a href={`mailto:${ticket.owner_email}`} className="text-sm"
                          style={{ color: '#c9a227' }}>{ticket.owner_email}</a>
                      </div>
                    )}

                    {/* Existing admin note */}
                    {ticket.admin_note && (
                      <div className="p-3 rounded-xl"
                        style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.2)' }}>
                        <p className="text-xs font-semibold mb-1" style={{ color: '#c9a227' }}>הערת אדמין קודמת</p>
                        <p className="text-sm" style={{ color: 'rgba(232,232,228,0.7)' }}>{ticket.admin_note}</p>
                      </div>
                    )}

                    {/* Admin note input */}
                    <div>
                      <p className="text-xs font-semibold mb-1.5" style={{ color: 'rgba(232,232,228,0.4)' }}>
                        <MessageSquare className="w-3 h-3 inline ml-1" />
                        הוסף / עדכן הערת אדמין
                      </p>
                      <div className="flex gap-2">
                        <textarea
                          rows={2}
                          className="flex-1 px-3 py-2 rounded-xl text-sm resize-none"
                          placeholder="הערה פנימית..."
                          value={notes[ticket.id] ?? ticket.admin_note ?? ''}
                          onChange={e => setNotes(n => ({ ...n, [ticket.id]: e.target.value }))}
                          style={{
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.12)',
                            color: 'rgba(232,232,228,0.85)',
                            outline: 'none',
                          }}
                        />
                        <button
                          onClick={() => saveNote(ticket.id)}
                          disabled={saving === ticket.id}
                          className="px-3 py-2 rounded-xl flex items-center gap-1.5 text-xs font-semibold flex-shrink-0 transition-all"
                          style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}
                        >
                          <Send className="w-3.5 h-3.5" />
                          שמור
                        </button>
                      </div>
                    </div>

                    {/* Status actions */}
                    <div className="flex gap-2 flex-wrap">
                      {ticket.status !== 'open' && (
                        <button onClick={() => setStatus(ticket.id, 'open')}
                          disabled={saving === ticket.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                          style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' }}>
                          סמן כפתוח
                        </button>
                      )}
                      {ticket.status !== 'in_progress' && (
                        <button onClick={() => setStatus(ticket.id, 'in_progress')}
                          disabled={saving === ticket.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                          style={{ background: 'rgba(249,115,22,0.12)', color: '#f97316', border: '1px solid rgba(249,115,22,0.25)' }}>
                          סמן בטיפול
                        </button>
                      )}
                      {ticket.status !== 'resolved' && (
                        <button onClick={() => setStatus(ticket.id, 'resolved')}
                          disabled={saving === ticket.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                          style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.25)' }}>
                          סמן כנסגר
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
