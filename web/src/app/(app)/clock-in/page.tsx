'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle, QrCode, Loader2 } from 'lucide-react';
import { shiftsApi } from '@/lib/api';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { Button } from '@/components/ui/Button';

type State = 'idle' | 'loading' | 'success' | 'error' | 'already_active';

export default function ClockInPage() {
  const params        = useSearchParams();
  const token         = params.get('t') || '';
  const businessParam = params.get('b') || '';
  const { user }      = useAppSelector(s => s.auth);

  const [state,   setState]   = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [shift,   setShift]   = useState<{ actual_start?: string } | null>(null);

  const handleClockIn = async () => {
    if (!token) { setMessage('QR לא תקין — סרוק שנית'); setState('error'); return; }
    setState('loading');
    try {
      const res = await shiftsApi.clockInQR(token);
      setShift(res.data);
      setState('success');
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string; shift?: unknown } } };
      if (e.response?.status === 409) {
        setShift(e.response.data?.shift as { actual_start?: string } | null);
        setState('already_active');
      } else {
        setMessage(e.response?.data?.error || 'שגיאה — נסה שנית');
        setState('error');
      }
    }
  };

  const timeStr = shift?.actual_start
    ? new Date(shift.actual_start).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <div className="min-h-screen flex items-center justify-center p-4" dir="rtl"
      style={{ background: 'var(--page-bg,#f0fdf4)' }}>
      <div className="w-full max-w-sm rounded-3xl p-8 text-center shadow-2xl"
        style={{ background: 'var(--glass-bg,white)', border: '1px solid var(--glass-border)' }}>

        {state === 'idle' && (
          <>
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={{ background: 'var(--tag-bg,#e8f5eb)' }}>
              <QrCode className="w-10 h-10" style={{ color: 'var(--color-primary,#1a5c2a)' }} />
            </div>
            <h1 className="text-2xl font-black text-gray-900 mb-1">כניסה למשמרת</h1>
            <p className="text-gray-500 text-sm mb-6">
              {user?.fullName ? `שלום ${user.fullName}` : 'שלום'}
              {businessParam ? '' : ''}
            </p>
            {!token ? (
              <p className="text-red-500 text-sm">QR לא תקין — סרוק שנית מהמסך</p>
            ) : (
              <Button onClick={handleClockIn} className="w-full text-lg py-4">
                כנס למשמרת
              </Button>
            )}
          </>
        )}

        {state === 'loading' && (
          <>
            <Loader2 className="w-16 h-16 mx-auto animate-spin mb-4" style={{ color: 'var(--color-primary)' }} />
            <p className="text-gray-600">מרשם כניסה...</p>
          </>
        )}

        {state === 'success' && (
          <>
            <CheckCircle2 className="w-20 h-20 mx-auto mb-4 text-green-500" />
            <h2 className="text-2xl font-black text-green-700 mb-1">כניסה נרשמה!</h2>
            <p className="text-gray-500 text-sm">{user?.fullName} · {timeStr}</p>
            <p className="text-xs text-gray-400 mt-4">אפשר לסגור את הדף</p>
          </>
        )}

        {state === 'already_active' && (
          <>
            <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-10 h-10 text-orange-500" />
            </div>
            <h2 className="text-xl font-black text-orange-700 mb-1">משמרת כבר פעילה</h2>
            <p className="text-gray-500 text-sm">כניסה מ-{timeStr}</p>
            <p className="text-xs text-gray-400 mt-4">אפשר לסגור את הדף</p>
          </>
        )}

        {state === 'error' && (
          <>
            <XCircle className="w-20 h-20 mx-auto mb-4 text-red-500" />
            <h2 className="text-xl font-black text-red-700 mb-2">שגיאה</h2>
            <p className="text-gray-600 text-sm mb-6">{message}</p>
            <Button variant="outline" onClick={() => setState('idle')} className="w-full">
              נסה שנית
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
