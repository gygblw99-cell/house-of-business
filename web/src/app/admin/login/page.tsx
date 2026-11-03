'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, Mail, User, AlertCircle } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || '/api-proxy';

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Forgot-password flow — inline on this same page (no separate route)
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>('login');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [info, setInfo] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${API}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'שגיאה בהתחברות');
        return;
      }

      router.replace('/admin/dashboard');
    } catch {
      setError('שגיאת חיבור לשרת');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');
    try {
      const res = await fetch(`${API}/admin/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'שגיאה'); return; }
      setInfo(data.message || 'קוד נשלח למייל');
      setMode('reset');
    } catch {
      setError('שגיאת חיבור לשרת');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');
    try {
      const res = await fetch(`${API}/admin/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail, code, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'שגיאה'); return; }
      setInfo('הסיסמה עודכנה — ניתן להתחבר');
      setMode('login');
      setPassword('');
      setCode('');
      setNewPassword('');
    } catch {
      setError('שגיאת חיבור לשרת');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{ background: '#050507' }}
      dir="rtl"
    >
      {/* Gold ambient glows */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] rounded-full opacity-10"
          style={{ background: 'radial-gradient(ellipse, #c9a227, transparent 70%)', filter: 'blur(60px)' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full opacity-5"
          style={{ background: 'radial-gradient(circle, #c9a227, transparent)', filter: 'blur(80px)' }}
        />
        {/* Grid texture */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'linear-gradient(rgba(201,162,39,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(201,162,39,0.5) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />
      </div>

      <div className="relative w-full max-w-md mx-4">
        {/* Card */}
        <div
          className="rounded-2xl p-8"
          style={{
            background: 'linear-gradient(145deg, #0f0f14, #141418)',
            border: '1px solid rgba(201,162,39,0.2)',
            boxShadow: '0 0 60px rgba(201,162,39,0.06), 0 24px 48px rgba(0,0,0,0.6)',
          }}
        >
          {/* Header */}
          <div className="text-center mb-8">
            <div className="flex items-center justify-center mx-auto mb-4" style={{ height: '72px' }}>
              <img
                src="/logo-login.png"
                alt="HOB"
                style={{
                  width: '72px',
                  height: '72px',
                  objectFit: 'contain',
                  filter: 'drop-shadow(0 0 14px rgba(201,162,39,0.45))',
                }}
              />
            </div>
            <h1 className="text-2xl font-black" style={{ color: 'rgba(232,232,228,0.95)' }}>
              Admin Panel
            </h1>
            <p className="text-sm mt-1" style={{ color: 'rgba(232,232,228,0.4)' }}>
              House of Business — ניהול מערכת
            </p>
          </div>

          {/* Error */}
          {error && (
            <div
              className="flex items-center gap-3 p-3 rounded-xl mb-5 text-sm"
              style={{
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: '#fca5a5',
              }}
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {info && (
            <div
              className="flex items-center gap-3 p-3 rounded-xl mb-5 text-sm"
              style={{
                background: 'rgba(34,197,94,0.1)',
                border: '1px solid rgba(34,197,94,0.25)',
                color: '#86efac',
              }}
            >
              {info}
            </div>
          )}

          {mode === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                  אימייל
                </label>
                <div className="relative">
                  <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgba(201,162,39,0.5)' }} />
                  <input
                    type="email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="admin@hob.com"
                    required
                    className="w-full pr-10 pl-4 py-3 rounded-xl text-sm outline-none transition-all"
                    style={{ background: 'rgba(201,162,39,0.04)', border: '1px solid rgba(201,162,39,0.16)', color: 'rgba(232,232,228,0.85)' }}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl font-bold text-sm transition-all mt-2"
                style={{
                  background: loading ? 'rgba(201,162,39,0.3)' : 'linear-gradient(135deg, #c9a227, #a8841e)',
                  color: loading ? 'rgba(232,232,228,0.5)' : '#050507',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'שולח...' : 'שלח קוד איפוס'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); setInfo(''); }}
                className="w-full text-center text-xs"
                style={{ color: 'rgba(201,162,39,0.6)' }}
              >
                חזרה לכניסה
              </button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                  קוד אימות
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  required
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all text-center tracking-[0.3em]"
                  style={{ background: 'rgba(201,162,39,0.04)', border: '1px solid rgba(201,162,39,0.16)', color: 'rgba(232,232,228,0.85)' }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                  סיסמה חדשה
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="לפחות 8 תווים"
                  required
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{ background: 'rgba(201,162,39,0.04)', border: '1px solid rgba(201,162,39,0.16)', color: 'rgba(232,232,228,0.85)' }}
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl font-bold text-sm transition-all mt-2"
                style={{
                  background: loading ? 'rgba(201,162,39,0.3)' : 'linear-gradient(135deg, #c9a227, #a8841e)',
                  color: loading ? 'rgba(232,232,228,0.5)' : '#050507',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'מעדכן...' : 'עדכן סיסמה'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); setInfo(''); }}
                className="w-full text-center text-xs"
                style={{ color: 'rgba(201,162,39,0.6)' }}
              >
                חזרה לכניסה
              </button>
            </form>
          )}

          {/* Form */}
          {mode === 'login' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                שם משתמש
              </label>
              <div className="relative">
                <User className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgba(201,162,39,0.5)' }} />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  required
                  className="w-full pr-10 pl-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: 'rgba(201,162,39,0.04)',
                    border: '1px solid rgba(201,162,39,0.16)',
                    color: 'rgba(232,232,228,0.85)',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(201,162,39,0.5)')}
                  onBlur={(e) => (e.target.style.borderColor = 'rgba(201,162,39,0.16)')}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'rgba(232,232,228,0.45)' }}>
                סיסמה
              </label>
              <div className="relative">
                <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgba(201,162,39,0.5)' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full pr-10 pl-10 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: 'rgba(201,162,39,0.04)',
                    border: '1px solid rgba(201,162,39,0.16)',
                    color: 'rgba(232,232,228,0.85)',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(201,162,39,0.5)')}
                  onBlur={(e) => (e.target.style.borderColor = 'rgba(201,162,39,0.16)')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'rgba(232,232,228,0.3)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'rgba(201,162,39,0.7)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'rgba(232,232,228,0.3)')}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl font-bold text-sm transition-all mt-2"
              style={{
                background: loading
                  ? 'rgba(201,162,39,0.3)'
                  : 'linear-gradient(135deg, #c9a227, #a8841e)',
                color: loading ? 'rgba(232,232,228,0.5)' : '#050507',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: loading ? 'none' : '0 4px 20px rgba(201,162,39,0.25)',
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span
                    className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: 'rgba(232,232,228,0.4)', borderTopColor: 'transparent' }}
                  />
                  מתחבר...
                </span>
              ) : (
                'כניסה למערכת'
              )}
            </button>

            <button
              type="button"
              onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}
              className="w-full text-center text-xs mt-1"
              style={{ color: 'rgba(201,162,39,0.6)' }}
            >
              שכחתי סיסמה
            </button>
          </form>
          )}

          <p className="text-center text-xs mt-6" style={{ color: 'rgba(232,232,228,0.2)' }}>
            גישה מוגבלת למנהלי מערכת בלבד
          </p>
        </div>

        {/* Bottom label */}
        <p className="text-center text-xs mt-4" style={{ color: 'rgba(201,162,39,0.3)' }}>
          House of Business © 2025
        </p>
      </div>
    </div>
  );
}
