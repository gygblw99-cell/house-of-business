'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Users, Clock, CheckCircle } from 'lucide-react';
import { queueApi } from '@/lib/api';

export default function JoinQueuePage() {
  const { businessId } = useParams<{ businessId: string }>();

  const [info, setInfo]     = useState<{ business_name: string; waiting_count: number } | null>(null);
  const [form, setForm]     = useState({ name: '', phone: '', party_size: '2', notes: '' });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ position: number; message: string } | null>(null);
  const [error, setError]   = useState('');

  useEffect(() => {
    if (!businessId) return;
    queueApi.joinInfo(businessId as string)
      .then(r => setInfo(r.data))
      .catch(() => setError('לא נמצא עסק זה'));
  }, [businessId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim()) { setError('שם ומספר טלפון חובה'); return; }
    setSubmitting(true);
    try {
      const r = await queueApi.join(businessId as string, {
        customerName: form.name.trim(),
        phone: form.phone.trim(),
        partySize: parseInt(form.party_size) || 2,
        notes: form.notes || undefined,
      });
      setResult(r.data);
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בהצטרפות, נסה שוב');
    } finally { setSubmitting(false); }
  };

  if (error && !info) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0f172a' }}>
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#0f172a' }}>
        <div className="max-w-sm w-full text-center space-y-5" dir="rtl">
          <div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto"
            style={{ background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e' }}>
            <CheckCircle className="w-10 h-10 text-green-400" />
          </div>
          <h1 className="text-2xl font-black text-white">נרשמת בהצלחה!</h1>
          <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <p className="text-5xl font-black text-amber-400 mb-1">{result.position}</p>
            <p className="text-sm text-white/60">מקום בתור</p>
          </div>
          <p className="text-white/70 text-sm">{result.message}</p>
          <p className="text-white/40 text-xs">נשלח לך וואטסאפ כשהשולחן מוכן 📱</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#0f172a' }}>
      <div className="max-w-sm w-full space-y-6" dir="rtl">
        {/* Header */}
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg,#1a5c2a,#2e7d32)' }}>
            <Users className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-black text-white">{info?.business_name || '...'}</h1>
          <p className="text-white/50 text-sm mt-1">הצטרפות לתור שולחנות</p>
          {info && (
            <div className="flex items-center justify-center gap-1.5 mt-3 text-xs text-amber-400">
              <Clock className="w-3.5 h-3.5" />
              {info.waiting_count > 0 ? `${info.waiting_count} אנשים לפנייך` : 'אין תור כרגע — שולחן כמעט מוכן!'}
            </div>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-white/50 block mb-1">שם מלא *</label>
            <input
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              placeholder="ישראל ישראלי"
              required
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:ring-2"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-white/50 block mb-1">טלפון (לקבלת וואטסאפ) *</label>
            <input
              value={form.phone}
              onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
              placeholder="050-0000000"
              type="tel"
              required
              dir="ltr"
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 outline-none"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-white/50 block mb-1">מספר אנשים</label>
            <div className="flex gap-2">
              {[1,2,3,4,5,6].map(n => (
                <button key={n} type="button"
                  onClick={() => setForm(p => ({ ...p, party_size: String(n) }))}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all"
                  style={{
                    background: form.party_size === String(n) ? 'rgba(201,162,39,0.2)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${form.party_size === String(n) ? 'rgba(201,162,39,0.5)' : 'rgba(255,255,255,0.08)'}`,
                    color: form.party_size === String(n) ? '#c9a227' : 'rgba(255,255,255,0.6)',
                  }}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-white/50 block mb-1">הערה (אופציונלי)</label>
            <input
              value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              placeholder="כיסא לתינוק, אלרגיות..."
              className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 outline-none"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)' }}
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3.5 rounded-2xl font-bold text-white transition-opacity"
            style={{ background: 'linear-gradient(135deg,#1a5c2a,#c9a227)', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'נרשם...' : 'הצטרף לתור 🍽️'}
          </button>
        </form>
      </div>
    </div>
  );
}
