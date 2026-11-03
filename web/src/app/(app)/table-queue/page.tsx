'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Users, Clock, CheckCircle, XCircle, MessageCircle, QrCode, RefreshCw, Phone } from 'lucide-react';
import { queueApi } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useAppDialog } from '@/context/AppDialogContext';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useSyncEvent } from '@/context/SyncContext';
import { getErrorMessage } from '@/lib/utils';

interface QueueEntry {
  id: string; customer_name: string; phone: string; party_size: number;
  notes: string | null; status: 'waiting' | 'ready' | 'seated' | 'cancelled';
  position?: number; created_at: string; notified_at: string | null;
}

function waitMinutes(createdAt: string) {
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 60000);
}

export default function TableQueuePage() {
  const { toast, confirm } = useAppDialog();
  const { business } = useAppSelector((s) => s.auth);

  const [queue, setQueue]         = useState<QueueEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showAdd, setShowAdd]     = useState(false);
  const [addForm, setAddForm]     = useState({ customer_name: '', phone: '', party_size: '2', notes: '' });
  const [addLoading, setAddLoading] = useState(false);
  const [showQr, setShowQr]       = useState(false);
  const [waLink, setWaLink]       = useState<{ link: string; name: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    queueApi.list()
      .then(r => setQueue(r.data.queue || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncEvent('queue.updated', load);

  const handleAdd = async () => {
    if (!addForm.customer_name.trim() || !addForm.phone.trim()) {
      toast('שם ומספר טלפון חובה', 'error'); return;
    }
    setAddLoading(true);
    try {
      await queueApi.add({
        name: addForm.customer_name.trim(),
        phone: addForm.phone.trim(),
        party_size: parseInt(addForm.party_size) || 2,
        notes: addForm.notes || undefined,
      });
      toast('נוסף לתור בהצלחה', 'success');
      setShowAdd(false);
      setAddForm({ customer_name: '', phone: '', party_size: '2', notes: '' });
      load();
    } catch (err) { toast(getErrorMessage(err) || 'שגיאה בהוספה', 'error'); }
    finally { setAddLoading(false); }
  };

  const handleReady = async (entry: QueueEntry) => {
    try {
      const r = await queueApi.ready(entry.id);
      setWaLink({ link: r.data.wa_link, name: entry.customer_name });
      load();
    } catch { toast('שגיאה', 'error'); }
  };

  const handleSeated = async (id: string) => {
    try {
      await queueApi.seated(id);
      toast('סומן כישב ✓', 'success');
      load();
    } catch { toast('שגיאה', 'error'); }
  };

  const handleCancel = async (id: string, name: string) => {
    const ok = await confirm(`לבטל את ${name} מהתור?`);
    if (!ok) return;
    try {
      await queueApi.cancel(id);
      load();
    } catch { toast('שגיאה', 'error'); }
  };

  const waiting = queue.filter(e => e.status === 'waiting');
  const ready   = queue.filter(e => e.status === 'ready');

  // QR URL for customers to self-join
  const joinUrl = business?.id
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join-queue/${business.id}`
    : '';

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">תור שולחנות</h1>
          <p className="text-sm opacity-60 mt-0.5">
            {waiting.length} ממתינים · {ready.length} שולחן מוכן
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setShowQr(true)}>
            <QrCode className="w-4 h-4 ml-1" /> QR להצטרפות
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4 ml-1" /> הוסף ידנית
          </Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'ממתינים', value: waiting.length, color: '#f59e0b' },
          { label: 'שולחן מוכן', value: ready.length, color: '#a855f7' },
          { label: 'ממוצע המתנה', value: waiting.length ? `${Math.round(waiting.reduce((s, e) => s + waitMinutes(e.created_at), 0) / waiting.length)} דק׳` : '—', color: '#60a5fa' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl p-4 text-center"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
            <p className="text-xs opacity-60 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Ready to seat */}
      {ready.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-400" /> שולחן מוכן — ממתין לאישור ישיבה
          </h2>
          <div className="space-y-2">
            {ready.map(e => (
              <div key={e.id} className="rounded-2xl p-4 flex items-center justify-between gap-3 flex-wrap"
                style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
                <div>
                  <p className="font-bold text-green-300">{e.customer_name}</p>
                  <p className="text-xs opacity-60">{e.party_size} אנשים · {e.phone} · המתין {waitMinutes(e.created_at)} דק׳</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleSeated(e.id)}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white"
                    style={{ background: '#22c55e' }}>
                    ישב ✓
                  </button>
                  <button onClick={() => handleCancel(e.id, e.customer_name)}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold opacity-60 hover:opacity-100"
                    style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                    ביטול
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Waiting queue */}
      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-400" /> בתור
        </h2>
        {loading && !queue.length ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: 'var(--card-bg)' }} />
            ))}
          </div>
        ) : waiting.length === 0 ? (
          <div className="rounded-2xl py-12 text-center opacity-40"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
            <Users className="w-10 h-10 mx-auto mb-2" />
            <p>התור ריק</p>
            <p className="text-xs mt-1">לקוחות יכולים להצטרף דרך קוד QR</p>
          </div>
        ) : (
          <div className="space-y-2">
            {waiting.map((e, idx) => (
              <div key={e.id} className="rounded-2xl p-4 flex items-center gap-4 flex-wrap"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}>
                {/* Position badge */}
                <div className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-sm flex-shrink-0"
                  style={{ background: idx === 0 ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.05)',
                           color: idx === 0 ? '#fbbf24' : 'var(--color-text-muted)' }}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{e.customer_name}</p>
                  <p className="text-xs opacity-50">
                    <Users className="w-3 h-3 inline ml-1" />{e.party_size} אנשים
                    <Phone className="w-3 h-3 inline mr-3 ml-1" />{e.phone}
                    <Clock className="w-3 h-3 inline mr-3 ml-1" />{waitMinutes(e.created_at)} דק׳
                  </p>
                  {e.notes && <p className="text-xs opacity-40 mt-0.5">📝 {e.notes}</p>}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleReady(e)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-white"
                    style={{ background: 'linear-gradient(135deg,#075e54,#25d366)' }}>
                    <MessageCircle className="w-3.5 h-3.5" /> שולחן מוכן
                  </button>
                  <button onClick={() => handleCancel(e.id, e.customer_name)}
                    className="p-1.5 rounded-xl opacity-50 hover:opacity-100 hover:text-red-400 transition-all">
                    <XCircle className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add manually modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="הוסף לתור ידנית">
        <div className="space-y-4 p-4">
          <div>
            <label className="text-xs font-semibold opacity-60 mb-1 block">שם לקוח *</label>
            <Input value={addForm.customer_name} onChange={e => setAddForm(p => ({ ...p, customer_name: e.target.value }))} placeholder="ישראל ישראלי" />
          </div>
          <div>
            <label className="text-xs font-semibold opacity-60 mb-1 block">טלפון *</label>
            <Input value={addForm.phone} onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))} placeholder="050-0000000" type="tel" dir="ltr" />
          </div>
          <div>
            <label className="text-xs font-semibold opacity-60 mb-1 block">מספר אנשים</label>
            <Input value={addForm.party_size} onChange={e => setAddForm(p => ({ ...p, party_size: e.target.value }))} type="number" min="1" max="20" />
          </div>
          <div>
            <label className="text-xs font-semibold opacity-60 mb-1 block">הערה (אופציונלי)</label>
            <Input value={addForm.notes} onChange={e => setAddForm(p => ({ ...p, notes: e.target.value }))} placeholder="בקשת מקום ישיבה, אלרגיות..." />
          </div>
          <div className="flex gap-2 pt-2">
            <Button className="flex-1" onClick={handleAdd} disabled={addLoading}>
              {addLoading ? 'מוסיף...' : 'הוסף לתור'}
            </Button>
            <Button variant="outline" onClick={() => setShowAdd(false)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* QR code modal */}
      <Modal open={showQr} onClose={() => setShowQr(false)} title="QR להצטרפות עצמאית לתור">
        <div className="p-6 text-center space-y-4">
          <p className="text-sm opacity-60">לקוח סורק את הקוד, ממלא שם + טלפון, ונכנס לתור</p>
          {/* Simple QR via Google Charts API — no auth needed */}
          {joinUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(joinUrl)}`}
              alt="QR לתור"
              className="mx-auto rounded-xl"
              width={200}
              height={200}
            />
          )}
          <p className="text-xs opacity-40 break-all font-mono">{joinUrl}</p>
          <Button variant="outline" className="w-full" onClick={() => setShowQr(false)}>סגור</Button>
        </div>
      </Modal>

      {/* WhatsApp notification link */}
      <Modal open={!!waLink} onClose={() => setWaLink(null)} title={`שלח הודעה ל-${waLink?.name}`}>
        <div className="p-6 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto"
            style={{ background: 'linear-gradient(135deg,#075e54,#25d366)' }}>
            <MessageCircle className="w-8 h-8 text-white" />
          </div>
          <p className="text-sm opacity-70">לחץ לשלוח הודעת וואטסאפ ל-{waLink?.name} שהשולחן מוכן</p>
          <a
            href={waLink?.link || '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setWaLink(null)}
            className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl font-semibold text-white text-sm"
            style={{ background: 'linear-gradient(135deg,#075e54,#25d366)' }}>
            <MessageCircle className="w-5 h-5" />
            פתח WhatsApp ושלח
          </a>
          <Button variant="outline" className="w-full" onClick={() => setWaLink(null)}>סגור בלי לשלוח</Button>
        </div>
      </Modal>
    </div>
  );
}
