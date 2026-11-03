'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, EyeOff, ShieldCheck, ArrowRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { login, clearError, cancel2FA } from '@/store/slices/authSlice';

type FormData = { username: string; password: string; totpCode: string };

// Only allow same-origin relative paths from ?redirect=. Resolves via the
// browser's own WHATWG URL parser (against a fake same-scheme base) and
// compares origins — this delegates all of the browser's own URL-resolution
// quirks (backslash normalization, encoded/control characters, //protocol-
// relative, absolute URLs) to the exact same parser that will actually
// navigate, instead of re-deriving those rules by hand in a regex — a
// hand-rolled regex here already needed a second fix for a backslash bypass.
const REDIRECT_FAKE_BASE = 'https://internal.invalid';
function safeRedirectTarget(raw: string | null): string {
  if (!raw) return '/dashboard';
  try {
    const resolved = new URL(raw, REDIRECT_FAKE_BASE);
    if (resolved.origin !== REDIRECT_FAKE_BASE) return '/dashboard';
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return '/dashboard';
  }
}

function LoginForm() {
  const router      = useRouter();
  const searchParams = useSearchParams();
  const dispatch    = useAppDispatch();
  const { loading, error, user, requires2FA } = useAppSelector((s) => s.auth);
  const [showPass, setShowPass]  = useState(false);
  const [imgErr, setImgErr]      = useState(false);

  const { register, handleSubmit, resetField, setFocus, formState: { errors } } = useForm<FormData>();

  useEffect(() => {
    if (user) router.replace(safeRedirectTarget(searchParams.get('redirect')));
  }, [user, router, searchParams]);
  // Leaving the page must also drop a half-finished 2FA step — otherwise
  // returning to /login would show the code field with no password behind it.
  useEffect(() => { return () => { dispatch(clearError()); dispatch(cancel2FA()); }; }, [dispatch]);

  // Move the caret into the code box the moment the server asks for one.
  useEffect(() => { if (requires2FA) setFocus('totpCode'); }, [requires2FA, setFocus]);

  const onSubmit = (data: FormData) => {
    dispatch(login({
      username: data.username.trim().toLowerCase(),
      password: data.password,
      totpCode: data.totpCode?.trim() || undefined,
    }));
  };

  const backToPassword = () => {
    resetField('totpCode');
    dispatch(cancel2FA());
  };

  return (
    <div className="min-h-screen flex" dir="rtl" data-page="login" style={{ background: '#08080a' }}>

      {/* ── Right panel — decorative ─────────────────────────── */}
      <div
        className="hidden lg:flex lg:w-1/2 flex-col items-center justify-center relative overflow-hidden"
        style={{ background: 'linear-gradient(160deg, #050507 0%, #0a0a0e 50%, #0d0d14 100%)' }}
      >
        {/* Radial gold glow behind logo */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(201,162,39,0.08) 0%, transparent 70%)' }} />

        {/* Gold dot grid pattern */}
        <div className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle at 1.5px 1.5px, #d4af37 1px, transparent 0)', backgroundSize: '28px 28px' }} />

        {/* Diagonal gold accent lines */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
          <div className="absolute" style={{ top: '-10%', right: '12%', width: 1, height: '130%', background: 'linear-gradient(180deg, transparent, rgba(201,162,39,0.12), transparent)', transform: 'rotate(-15deg)' }} />
          <div className="absolute" style={{ top: '-10%', right: '28%', width: 1, height: '130%', background: 'linear-gradient(180deg, transparent, rgba(201,162,39,0.06), transparent)', transform: 'rotate(-15deg)' }} />
        </div>

        {/* Top gold line */}
        <div className="absolute top-0 inset-x-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, #c9a227, transparent)' }} />

        {/* Corner ornaments */}
        <div className="absolute top-8 right-8 w-12 h-12 pointer-events-none"
          style={{ borderTop: '1px solid rgba(201,162,39,0.4)', borderRight: '1px solid rgba(201,162,39,0.4)' }} />
        <div className="absolute top-8 left-8 w-12 h-12 pointer-events-none"
          style={{ borderTop: '1px solid rgba(201,162,39,0.4)', borderLeft: '1px solid rgba(201,162,39,0.4)' }} />
        <div className="absolute bottom-8 right-8 w-12 h-12 pointer-events-none"
          style={{ borderBottom: '1px solid rgba(201,162,39,0.4)', borderRight: '1px solid rgba(201,162,39,0.4)' }} />
        <div className="absolute bottom-8 left-8 w-12 h-12 pointer-events-none"
          style={{ borderBottom: '1px solid rgba(201,162,39,0.4)', borderLeft: '1px solid rgba(201,162,39,0.4)' }} />

        <div className="relative z-10 flex flex-col items-center px-12 text-center">
          {/* Logo */}
          <div className="mb-10" style={{ filter: 'drop-shadow(0 0 40px rgba(201,162,39,0.25))' }}>
            {!imgErr ? (
              <Image
                src="/logo-login.png"
                alt="House of Business"
                width={280}
                height={280}
                className="object-contain"
                onError={() => setImgErr(true)}
                priority
                unoptimized
              />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="w-24 h-24 rounded-2xl flex items-center justify-center"
                  style={{ background: 'linear-gradient(135deg, #c9a227, #d4af37)', boxShadow: '0 0 40px rgba(201,162,39,0.3)' }}>
                  <span className="text-4xl font-black" style={{ color: '#050507' }}>HB</span>
                </div>
                <span className="text-2xl font-black tracking-widest" style={{ color: '#c9a227', letterSpacing: '0.2em' }}>HOUSE OF</span>
                <span className="text-2xl font-black tracking-widest" style={{ color: '#d4af37', letterSpacing: '0.25em' }}>BUSINESS</span>
              </div>
            )}
          </div>

          {/* Tagline */}
          <div className="flex items-center gap-3 mt-2">
            <div className="h-px w-12" style={{ background: 'linear-gradient(90deg, transparent, #c9a227)' }} />
            <p className="text-xs tracking-widest font-medium" style={{ color: '#9aa0ab', letterSpacing: '0.2em' }}>
              AI &bull; FINANCE &bull; GROWTH &bull; FREEDOM
            </p>
            <div className="h-px w-12" style={{ background: 'linear-gradient(270deg, transparent, #c9a227)' }} />
          </div>
        </div>

        {/* Bottom gold line */}
        <div className="absolute bottom-0 inset-x-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, #c9a227, transparent)' }} />
      </div>

      {/* ── Left panel — form ────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative"
        style={{ background: 'linear-gradient(160deg, #0d0d14 0%, #0f0f16 100%)' }}>

        {/* Subtle right border */}
        <div className="absolute top-0 right-0 bottom-0 w-px hidden lg:block"
          style={{ background: 'linear-gradient(180deg, transparent, rgba(201,162,39,0.2), transparent)' }} />

        <div className="w-full max-w-md">

          {/* Mobile logo */}
          <div className="lg:hidden flex flex-col items-center mb-10">
            {!imgErr ? (
              <Image src="/logo-login.png" alt="House of Business" width={160} height={160}
                className="object-contain" onError={() => setImgErr(true)} unoptimized />
            ) : (
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-3"
                style={{ background: 'linear-gradient(135deg, #c9a227, #d4af37)' }}>
                <span className="text-xl font-black" style={{ color: '#050507' }}>HB</span>
              </div>
            )}
          </div>

          {/* Heading */}
          <div className="mb-10">
            <h2 className="text-4xl font-black mb-3 tracking-wide" style={{ color: '#d4af37', letterSpacing: '0.05em' }}>
              {requires2FA ? 'אימות דו-שלבי' : 'ברוך הבא'}
            </h2>
            <div className="flex items-center gap-3">
              <div className="h-px flex-1" style={{ background: 'linear-gradient(270deg, rgba(201,162,39,0.4), transparent)' }} />
              <p className="text-xs tracking-widest" style={{ color: '#6b7280', letterSpacing: '0.15em' }}>
                {requires2FA ? 'TWO-FACTOR AUTHENTICATION' : 'SIGN IN TO YOUR ACCOUNT'}
              </p>
              <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, rgba(201,162,39,0.4), transparent)' }} />
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

            {/* ── TOTP step ────────────────────────────────────────
                The username/password inputs stay mounted (hidden) rather than
                being swapped out: react-hook-form must still hold their values
                so the retry submit re-sends the full credential set, and the
                server re-checks the password on every attempt. */}
            {requires2FA && (
              <div>
                <div className="flex items-start gap-3 rounded-lg px-4 py-3 mb-5"
                  style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.25)' }}>
                  <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#c9a227' }} />
                  <p className="text-xs leading-relaxed" style={{ color: '#9aa0ab' }}>
                    הזן את הקוד בן 6 הספרות מאפליקציית האימות שלך
                  </p>
                </div>

                <label className="block text-xs font-bold mb-2 tracking-widest" style={{ color: '#9aa0ab', letterSpacing: '0.15em' }}>
                  קוד אימות
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  dir="ltr"
                  className="w-full rounded-lg px-4 py-3.5 text-center outline-none transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: errors.totpCode ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)',
                    color: '#e8e8e8',
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: '0.5em',
                    textIndent: '0.5em', // counters the trailing letter-spacing so digits look centred
                  }}
                  onFocus={e => {
                    e.target.style.border = '1px solid rgba(201,162,39,0.7)';
                    e.target.style.background = 'rgba(201,162,39,0.05)';
                  }}
                  {...register('totpCode', {
                    validate: (v) => !requires2FA || /^\d{6}$/.test((v || '').trim()) || 'קוד בן 6 ספרות',
                    onBlur: (e) => {
                      e.target.style.border = errors.totpCode ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)';
                      e.target.style.background = 'rgba(255,255,255,0.04)';
                    },
                  })}
                />
                {errors.totpCode && <p className="text-xs text-red-500 mt-1.5">{errors.totpCode.message}</p>}

                <button
                  type="button"
                  onClick={backToPassword}
                  className="flex items-center gap-1.5 text-xs font-medium mt-3 transition-colors"
                  style={{ color: '#6b7280' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#c9a227')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                >
                  <ArrowRight className="w-3 h-3" />
                  חזרה לכניסה רגילה
                </button>
              </div>
            )}

            {/* Credentials — hidden (not unmounted) during the TOTP step */}
            <div className={requires2FA ? 'hidden' : 'space-y-6'}>

            {/* Username */}
            <div>
              <label className="block text-xs font-bold mb-2 tracking-widest" style={{ color: '#9aa0ab', letterSpacing: '0.15em' }}>
                שם משתמש
              </label>
              <input
                type="text"
                placeholder="username"
                autoComplete="username"
                className="w-full rounded-lg px-4 py-3.5 text-sm outline-none transition-all"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: errors.username ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)',
                  color: '#e8e8e8',
                }}
                onFocus={e => {
                  e.target.style.border = '1px solid rgba(201,162,39,0.7)';
                  e.target.style.background = 'rgba(201,162,39,0.05)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(201,162,39,0.08)';
                }}
                {...register('username', {
                  required: 'שם משתמש חובה',
                  onBlur: (e) => {
                    e.target.style.border = errors.username ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)';
                    e.target.style.background = 'rgba(255,255,255,0.04)';
                    e.target.style.boxShadow = 'none';
                  }
                })}
              />
              {errors.username && <p className="text-xs text-red-500 mt-1.5">{errors.username.message}</p>}
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-bold mb-2 tracking-widest" style={{ color: '#9aa0ab', letterSpacing: '0.15em' }}>
                סיסמה
              </label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full rounded-lg px-4 py-3.5 pl-11 text-sm outline-none transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: errors.password ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)',
                    color: '#e8e8e8',
                  }}
                  onFocus={e => {
                    e.target.style.border = '1px solid rgba(201,162,39,0.7)';
                    e.target.style.background = 'rgba(201,162,39,0.05)';
                    e.target.style.boxShadow = '0 0 0 3px rgba(201,162,39,0.08)';
                  }}
                  {...register('password', {
                    onBlur: (e) => {
                      e.target.style.border = errors.password ? '1px solid #dc2626' : '1px solid rgba(201,162,39,0.25)';
                      e.target.style.background = 'rgba(255,255,255,0.04)';
                      e.target.style.boxShadow = 'none';
                    }
                  })}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: '#6b7280' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#c9a227')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && <p className="text-xs text-red-500 mt-1.5">{errors.password.message}</p>}
            </div>

            {/* Forgot password */}
            <div className="flex justify-start">
              <Link href="/forgot-password"
                className="text-xs font-medium transition-colors"
                style={{ color: '#6b7280', letterSpacing: '0.05em' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#c9a227')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
              >
                שכחתי סיסמה
              </Link>
            </div>

            </div>{/* /credentials */}

            {/* Error */}
            {error && (
              <div className="rounded-lg px-4 py-3 text-sm" style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171' }}>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg py-4 text-sm font-bold tracking-widest transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              style={{
                background: loading ? 'rgba(201,162,39,0.4)' : 'linear-gradient(135deg, #b8941f 0%, #c9a227 40%, #d4af37 70%, #c9a227 100%)',
                color: '#050507',
                letterSpacing: '0.2em',
                boxShadow: loading ? 'none' : '0 4px 24px rgba(201,162,39,0.3), 0 0 0 1px rgba(201,162,39,0.2)',
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 8px 32px rgba(201,162,39,0.45), 0 0 0 1px rgba(201,162,39,0.3)';
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 4px 24px rgba(201,162,39,0.3), 0 0 0 1px rgba(201,162,39,0.2)';
              }}
            >
              {loading ? (
                <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
              ) : requires2FA ? 'אמת קוד' : 'כניסה למערכת'}
            </button>
          </form>


          {/* Footer */}
          <p className="text-center text-xs mt-8 tracking-widest" style={{ color: '#374151', letterSpacing: '0.1em' }}>
            © 2026 HOUSE OF BUSINESS
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ background: '#08080a' }}><p className="text-gray-400 text-sm">טוען...</p></div>}>
      <LoginForm />
    </Suspense>
  );
}
