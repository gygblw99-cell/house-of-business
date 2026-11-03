'use client';
import { useState } from 'react';
import { Building2, User, Mail, Phone, Lock, RefreshCw, CheckCircle, Copy, Check, Eye, EyeOff, AtSign } from 'lucide-react';
import { adminFetch } from '@/lib/adminClient';

// חייב להתאים בדיוק ל-CHECK constraint על businesses.business_type ב-DB
const BUSINESS_TYPES = [
  { value: 'restaurant', label: 'מסעדה' },
  { value: 'cafe', label: 'בית קפה' },
  { value: 'bar', label: 'בר' },
  { value: 'bakery', label: 'מאפייה' },
  { value: 'barber', label: 'מספרה' },
  { value: 'service', label: 'עסק שירותים' },
];

function generatePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function suggestUsername(businessName: string): string {
  const base = businessName
    .toLowerCase()
    .replace(/[֐-׿\s]/g, '') // strip Hebrew + spaces
    .replace(/[^a-z0-9]/g, '')         // keep only alphanumeric
    .slice(0, 12);
  const suffix = Math.floor(Math.random() * 900 + 100);
  return (base || 'owner') + suffix;
}

export default function CreateBusinessPage() {
  const [form, setForm] = useState({
    businessName: '',
    businessType: 'restaurant',
    ownerName: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    contractType: 'trial',
    contractMonths: '3',
  });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ business: Record<string, unknown>; user: Record<string, unknown> } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const set = (field: string, value: string) =>
    setForm(f => ({ ...f, [field]: value }));

  const autoPassword = () => set('password', generatePassword());

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await adminFetch('/admin/create-business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה');
      setResult({ ...data, plainPassword: form.password });
      setForm({ businessName: '', businessType: 'restaurant', ownerName: '', username: '', email: '', phone: '', password: '', contractType: 'trial', contractMonths: '3' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(201,162,39,0.18)',
    borderRadius: '10px',
    color: 'rgba(232,232,228,0.9)',
    outline: 'none',
    width: '100%',
    padding: '10px 14px',
    fontSize: '14px',
  } as React.CSSProperties;

  const labelStyle = {
    color: 'rgba(201,162,39,0.7)',
    fontSize: '12px',
    fontWeight: 600,
    marginBottom: '6px',
    display: 'block',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <div className="mb-8">
        <h1 className="text-2xl font-black mb-1" style={{ color: 'rgba(232,232,228,0.95)' }}>
          פתיחת עסק חדש
        </h1>
        <p style={{ color: 'rgba(232,232,228,0.4)', fontSize: 14 }}>
          יצירת עסק ומשתמש בעלים חדש במערכת
        </p>
      </div>

      {result ? (
        <div
          className="rounded-2xl p-6 space-y-4"
          style={{
            background: 'rgba(201,162,39,0.06)',
            border: '1px solid rgba(201,162,39,0.25)',
          }}
        >
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle className="w-6 h-6" style={{ color: '#c9a227' }} />
            <h2 className="text-lg font-bold" style={{ color: '#c9a227' }}>
              עסק נוצר בהצלחה!
            </h2>
          </div>

          {[
            { label: 'שם העסק', value: (result.business as Record<string, unknown>).name as string, key: 'biz' },
            { label: 'סוג עסק', value: (result.business as Record<string, unknown>).business_type as string, key: 'type' },
            { label: 'שם הבעלים', value: (result.user as Record<string, unknown>).full_name as string, key: 'name' },
            { label: 'אימייל', value: (result.user as Record<string, unknown>).email as string, key: 'email' },
            ...((result.user as Record<string, unknown>).username ? [{ label: 'שם משתמש', value: (result.user as Record<string, unknown>).username as string, key: 'uname', sensitive: false }] : []),
            { label: 'סיסמה', value: (result as Record<string, unknown>).plainPassword as string, key: 'pw', sensitive: true },
          ].map(({ label, value, key, sensitive }) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-xl px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(201,162,39,0.12)' }}
            >
              <div>
                <p style={{ color: 'rgba(201,162,39,0.6)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {label}
                </p>
                <p
                  style={{
                    color: sensitive ? '#c9a227' : 'rgba(232,232,228,0.85)',
                    fontSize: 14,
                    fontFamily: sensitive ? 'monospace' : undefined,
                    fontWeight: sensitive ? 700 : 400,
                  }}
                >
                  {value}
                </p>
              </div>
              <button
                onClick={() => copyToClipboard(value, key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: copied === key ? 'rgba(201,162,39,0.15)' : 'rgba(255,255,255,0.05)',
                  color: copied === key ? '#c9a227' : 'rgba(232,232,228,0.5)',
                  border: `1px solid ${copied === key ? 'rgba(201,162,39,0.3)' : 'rgba(255,255,255,0.08)'}`,
                }}
              >
                {copied === key ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied === key ? 'הועתק' : 'העתק'}
              </button>
            </div>
          ))}

          <button
            onClick={() => setResult(null)}
            className="w-full py-2.5 rounded-xl text-sm font-semibold mt-2 transition-all"
            style={{
              background: 'rgba(201,162,39,0.12)',
              border: '1px solid rgba(201,162,39,0.25)',
              color: '#c9a227',
            }}
          >
            + פתח עסק נוסף
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="rounded-2xl p-6 space-y-5"
          style={{
            background: '#050507',
            border: '1px solid rgba(201,162,39,0.12)',
          }}
        >
          {/* Business Name */}
          <div>
            <label style={labelStyle}>שם העסק</label>
            <div className="relative">
              <Building2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                required
                value={form.businessName}
                onChange={e => set('businessName', e.target.value)}
                placeholder="מסעדת הים הכחול"
                style={{ ...inputStyle, paddingRight: '38px' }}
              />
            </div>
          </div>

          {/* Business Type */}
          <div>
            <label style={labelStyle}>סוג עסק</label>
            <select
              value={form.businessType}
              onChange={e => set('businessType', e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {BUSINESS_TYPES.map(t => (
                <option key={t.value} value={t.value} style={{ background: '#050507' }}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Contract Term — the length signed with the owner */}
          <div>
            <label style={labelStyle}>משך התקשרות</label>
            <select
              value={form.contractType}
              onChange={e => set('contractType', e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="trial" style={{ background: '#050507' }}>חודש ניסיון</option>
              <option value="year" style={{ background: '#050507' }}>שנה</option>
              <option value="custom" style={{ background: '#050507' }}>מותאם אישית</option>
            </select>
            {form.contractType === 'custom' && (
              <div className="mt-2 relative">
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={form.contractMonths}
                  onChange={e => set('contractMonths', e.target.value)}
                  placeholder="מספר חודשים"
                  style={inputStyle}
                />
                <span
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-xs"
                  style={{ color: 'rgba(201,162,39,0.5)' }}
                >
                  חודשים
                </span>
              </div>
            )}
          </div>

          {/* Owner Name */}
          <div>
            <label style={labelStyle}>שם הבעלים</label>
            <div className="relative">
              <User className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                required
                value={form.ownerName}
                onChange={e => set('ownerName', e.target.value)}
                placeholder="ישראל ישראלי"
                style={{ ...inputStyle, paddingRight: '38px' }}
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label style={{ ...labelStyle, marginBottom: 0 }}>שם משתמש (אופציונלי)</label>
              <button
                type="button"
                onClick={() => set('username', suggestUsername(form.businessName || form.ownerName))}
                className="flex items-center gap-1.5 text-xs font-medium transition-all"
                style={{ color: 'rgba(201,162,39,0.7)' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = '#c9a227')}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'rgba(201,162,39,0.7)')}
              >
                <RefreshCw className="w-3 h-3" />
                יצור אוטומטית
              </button>
            </div>
            <div className="relative">
              <AtSign className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                value={form.username}
                onChange={e => set('username', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="owner123"
                dir="ltr"
                style={{ ...inputStyle, paddingRight: '38px', fontFamily: 'monospace' }}
              />
            </div>
            <p style={{ color: 'rgba(232,232,228,0.25)', fontSize: 11, marginTop: 4 }}>
              אותיות קטנות באנגלית, מספרים וקו תחתון בלבד
            </p>
          </div>

          {/* Email */}
          <div>
            <label style={labelStyle}>אימייל</label>
            <div className="relative">
              <Mail className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                required
                type="email"
                value={form.email}
                onChange={e => set('email', e.target.value)}
                placeholder="owner@restaurant.co.il"
                dir="ltr"
                style={{ ...inputStyle, paddingRight: '38px' }}
              />
            </div>
          </div>

          {/* Phone */}
          <div>
            <label style={labelStyle}>טלפון (אופציונלי)</label>
            <div className="relative">
              <Phone className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                value={form.phone}
                onChange={e => set('phone', e.target.value)}
                placeholder="050-0000000"
                style={{ ...inputStyle, paddingRight: '38px' }}
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label style={{ ...labelStyle, marginBottom: 0 }}>סיסמה</label>
              <button
                type="button"
                onClick={autoPassword}
                className="flex items-center gap-1.5 text-xs font-medium transition-all"
                style={{ color: 'rgba(201,162,39,0.7)' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = '#c9a227')}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = 'rgba(201,162,39,0.7)')}
              >
                <RefreshCw className="w-3 h-3" />
                יצירה אוטומטית
              </button>
            </div>
            <div className="relative">
              <Lock className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
              <input
                required
                type={showPw ? 'text' : 'password'}
                value={form.password}
                onChange={e => set('password', e.target.value)}
                minLength={8}
                placeholder="לפחות 8 תווים"
                dir="ltr"
                style={{ ...inputStyle, paddingRight: '38px', paddingLeft: '38px', fontFamily: showPw ? 'monospace' : undefined }}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'rgba(201,162,39,0.4)' }}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div
              className="rounded-xl px-4 py-3 text-sm"
              style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-bold transition-all mt-2"
            style={{
              background: loading ? 'rgba(201,162,39,0.15)' : 'linear-gradient(135deg, rgba(201,162,39,0.25), rgba(201,162,39,0.12))',
              border: '1px solid rgba(201,162,39,0.35)',
              color: loading ? 'rgba(201,162,39,0.5)' : '#c9a227',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'יוצר עסק...' : 'צור עסק ובעלים'}
          </button>
        </form>
      )}
    </div>
  );
}
