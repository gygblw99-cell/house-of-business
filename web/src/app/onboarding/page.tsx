'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Sparkles, Loader } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { restoreSession } from '@/store/slices/authSlice';
import api from '@/lib/api/client';

const GOLD    = '#c9a227';
const GOLD_10 = 'rgba(201,162,39,0.10)';
const GOLD_18 = 'rgba(201,162,39,0.18)';
const GOLD_25 = 'rgba(201,162,39,0.25)';
const GOLD_35 = 'rgba(201,162,39,0.35)';
const GOLD_50 = 'rgba(201,162,39,0.50)';
const TEXT     = 'rgba(232,232,228,0.90)';
const TEXT_DIM = 'rgba(232,232,228,0.40)';
const CARD_BG  = 'rgba(255,255,255,0.025)';
const CARD_BD  = 'rgba(255,255,255,0.07)';

const inp: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${GOLD_18}`,
  borderRadius: 10,
  color: TEXT,
  outline: 'none',
  width: '100%',
  padding: '9px 12px',
  fontSize: 14,
};

const lbl: React.CSSProperties = {
  display: 'block',
  color: 'rgba(232,232,228,0.45)',
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 6,
};

const DAY_KEYS   = ['sun','mon','tue','wed','thu','fri','sat'] as const;
const DAY_LABELS = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];

export default function OnboardingPage() {
  const router   = useRouter();
  const dispatch = useAppDispatch();
  const { user, business } = useAppSelector(s => s.auth);

  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const [bizForm, setBizForm] = useState({
    phone:         business?.phone || '',
    primary_email: '',
    openDays:      ['sun','mon','tue','wed','thu','fri'] as string[],
  });

  useEffect(() => {
    if (!user) {
      // /onboarding is a public path (middleware lets unauthenticated visitors
      // through to avoid a redirect loop for users mid-session-restore), so a
      // genuinely logged-out visitor would otherwise be stuck on the spinner
      // forever. Only bounce to /login on an actual auth failure — not on a
      // transient network error, which should let the user retry in place.
      dispatch(restoreSession()).unwrap().catch((reason) => {
        if (reason !== 'network error') router.replace('/login');
      });
    }
  }, [dispatch, user, router]);

  useEffect(() => {
    if (business?.onboarding_completed === true) router.replace('/dashboard');
  }, [business, router]);

  async function saveAndContinue() {
    setSaving(true); setError('');
    try {
      const open_days: Record<string, { open: boolean }> = {};
      DAY_KEYS.forEach(key => {
        open_days[key] = { open: bizForm.openDays.includes(key) };
      });
      await api.put('/business/me', {
        open_days,
        ...(bizForm.phone         ? { phone:         bizForm.phone         } : {}),
        ...(bizForm.primary_email ? { primary_email: bizForm.primary_email } : {}),
      });
      // Must not be swallowed — if this fails, onboarding_completed stays false
      // server-side and the user would otherwise be bounced back here forever
      // by (app)/layout.tsx with no explanation. Let it fall into the catch below.
      await api.put('/business/onboarding', {});
      router.replace('/quickstart');
    } catch (e: unknown) {
      setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'שגיאה בשמירה');
    } finally { setSaving(false); }
  }

  if (!user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#050507' }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '2px solid transparent', borderTopColor: GOLD_50, animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  return (
    <div dir="rtl" style={{
      height: '100vh', overflowY: 'auto',
      background: 'linear-gradient(160deg, #06060a 0%, #050507 60%, #07060c 100%)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <header style={{
        padding: '18px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid rgba(201,162,39,0.08)`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(201,162,39,0.2), rgba(201,162,39,0.06))',
            border: `1px solid ${GOLD_25}`,
          }}>
            <Sparkles style={{ width: 15, height: 15, color: GOLD }} />
          </div>
          <span style={{ fontWeight: 900, fontSize: 13, color: TEXT }}>House of Business</span>
        </div>
        <span style={{
          fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
          background: GOLD_10, border: `1px solid ${GOLD_18}`, color: GOLD_50,
        }}>
          הגדרה ראשונית
        </span>
      </header>

      {/* Progress bar — full since only 1 step */}
      <div style={{ height: 2, background: 'rgba(255,255,255,0.05)' }}>
        <div style={{ height: '100%', width: '100%', background: `linear-gradient(90deg, ${GOLD_50}, ${GOLD})` }} />
      </div>

      {/* Content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 16px' }}>
        <div style={{ width: '100%', maxWidth: 540 }}>

          {/* Step card */}
          <div style={{
            borderRadius: 20, padding: 24,
            background: CARD_BG, border: `1px solid ${CARD_BD}`,
            boxShadow: `0 0 40px rgba(201,162,39,0.04)`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(201,162,39,0.1)', border: `1px solid ${GOLD_18}`,
              }}>
                <Building2 style={{ width: 18, height: 18, color: GOLD_50 }} />
              </div>
              <div>
                <p style={{ fontSize: 11, color: TEXT_DIM, marginBottom: 2 }}>ברוכים הבאים!</p>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: TEXT }}>פרטי העסק</h2>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={lbl}>טלפון</label>
                  <input style={inp} value={bizForm.phone}
                    onChange={e => setBizForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="050-0000000" />
                </div>
                <div>
                  <label style={lbl}>אימייל לעדכונים</label>
                  <input style={inp} type="email" value={bizForm.primary_email}
                    onChange={e => setBizForm(f => ({ ...f, primary_email: e.target.value }))}
                    placeholder="owner@example.com" />
                </div>
              </div>
              <div>
                <label style={{ ...lbl, marginBottom: 8 }}>ימי פעילות</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {DAY_KEYS.map((key, i) => {
                    const active = bizForm.openDays.includes(key);
                    return (
                      <button key={key} type="button"
                        onClick={() => setBizForm(f => ({
                          ...f,
                          openDays: active ? f.openDays.filter(d => d !== key) : [...f.openDays, key],
                        }))}
                        style={{
                          flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          background: active ? 'rgba(201,162,39,0.15)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${active ? GOLD_35 : CARD_BD}`,
                          color: active ? GOLD : TEXT_DIM,
                          transition: 'all 0.15s',
                        }}
                      >
                        {DAY_LABELS[i]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {error && (
              <p style={{ marginTop: 12, fontSize: 13, color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, padding: '8px 12px' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 24 }}>
              <button
                type="button"
                onClick={saveAndContinue}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '11px 28px', borderRadius: 12,
                  background: saving ? GOLD_10 : 'linear-gradient(135deg, rgba(201,162,39,0.22), rgba(201,162,39,0.10))',
                  border: `1px solid ${saving ? GOLD_18 : GOLD_35}`,
                  color: saving ? GOLD_35 : GOLD,
                  fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
                  boxShadow: saving ? 'none' : `0 0 24px rgba(201,162,39,0.08)`,
                  transition: 'all 0.2s',
                  minWidth: 140,
                }}
              >
                {saving
                  ? <Loader style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite' }} />
                  : 'בואו נתחיל →'}
              </button>
            </div>
          </div>

          <p style={{ textAlign: 'center', fontSize: 11, color: 'rgba(232,232,228,0.18)', marginTop: 16 }}>
            ניתן לשנות את הפרטים בכל עת דרך דף ההגדרות
          </p>
        </div>
      </main>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
