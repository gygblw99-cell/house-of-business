'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2, Eye, EyeOff, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAppDispatch } from '@/hooks/useAppDispatch';
import { restoreSession } from '@/store/slices/authSlice';
import api from '@/lib/api';
import Cookies from 'js-cookie';

interface InviteInfo {
  userId: string; fullName: string; email: string; businessName: string;
}

function JoinContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const dispatch     = useAppDispatch();
  const token        = searchParams.get('token') || '';

  const [invite, setInvite]     = useState<InviteInfo | null>(null);
  const [tokenError, setTokenError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState('');
  const [done, setDone]         = useState(false);

  useEffect(() => {
    if (!token) { setTokenError('קישור לא תקף'); setLoading(false); return; }
    api.get(`/auth/join?token=${token}`)
      .then(({ data }) => { setInvite(data); setLoading(false); })
      .catch(() => { setTokenError('קישור לא תקף או פג תוקף'); setLoading(false); });
  }, [token]);

  const submit = async () => {
    if (submitting) return;
    if (password.length < 6) { setError('סיסמה חייבת להכיל לפחות 6 תווים'); return; }
    if (password !== confirm)  { setError('הסיסמאות אינן תואמות'); return; }
    setSubmitting(true); setError('');
    try {
      const { data } = await api.post('/auth/join', { token, password });
      Cookies.set('token', data.token, { expires: 30 });
      await dispatch(restoreSession());
      setDone(true);
      setTimeout(() => router.replace('/dashboard'), 1500);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'שגיאה, נסה שוב');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">House of Business</h1>
          <p className="text-gray-500 text-sm mt-1">הצטרפות לצוות</p>
        </div>

        {loading ? (
          <p className="text-center text-gray-400 py-8">מאמת קישור...</p>

        ) : tokenError ? (
          <div className="text-center py-6">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <p className="text-red-600 font-medium">{tokenError}</p>
            <p className="text-sm text-gray-500 mt-2">בקש מהמנהל לשלוח הזמנה חדשה</p>
          </div>

        ) : done ? (
          <div className="text-center py-6">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <p className="text-green-700 font-medium">ברוך הבא! מעביר לדשבורד...</p>
          </div>

        ) : (
          <div className="space-y-5">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm">
              <p className="font-semibold text-gray-900">{invite?.businessName}</p>
              <p className="text-gray-600 mt-0.5">הוזמנת להצטרף כעובד</p>
              <p className="text-gray-500 text-xs mt-1">{invite?.fullName} · {invite?.email}</p>
            </div>

            <div className="relative">
              <Input
                label="סיסמה חדשה"
                type={showPw ? 'text' : 'password'}
                placeholder="לפחות 6 תווים"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute left-3 top-8 text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <Input
              label="אימות סיסמה"
              type="password"
              placeholder="הקלד שוב את הסיסמה"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />

            {error && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <Button onClick={submit} loading={submitting} className="w-full" size="lg">
              הצטרף והיכנס
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">טוען...</p></div>}>
      <JoinContent />
    </Suspense>
  );
}
