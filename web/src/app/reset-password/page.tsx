'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2, Eye, EyeOff, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import api from '@/lib/api';

function ResetPasswordContent() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const phoneParam   = searchParams.get('phone') || '';

  const [phone, setPhone]       = useState(phoneParam);
  const [code, setCode]         = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [done, setDone]         = useState(false);

  const submit = async () => {
    if (loading) return;
    if (!phone || !code || !password) { setError('יש למלא את כל השדות'); return; }
    if (password.length < 6)          { setError('סיסמה חייבת להכיל לפחות 6 תווים'); return; }
    if (password !== confirm)          { setError('הסיסמאות אינן תואמות'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset-password', { phone, code, newPassword: password });
      setDone(true);
      setTimeout(() => router.replace('/login'), 2000);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'שגיאה, נסה שוב');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">איפוס סיסמה</h1>
          <p className="text-gray-500 text-sm mt-1">הזן את הקוד שקיבלת ב-SMS</p>
        </div>

        {done ? (
          <div className="text-center py-6">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <p className="text-green-700 font-medium">הסיסמה עודכנה!</p>
            <p className="text-sm text-gray-500 mt-1">מעביר לכניסה...</p>
          </div>
        ) : (
          <div className="space-y-4">
            {!phoneParam && (
              <Input
                label="מספר טלפון"
                type="tel"
                placeholder="050-0000000"
                value={phone}
                onChange={e => setPhone(e.target.value)}
              />
            )}

            <Input
              label="קוד SMS (6 ספרות)"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            />

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
              placeholder="הקלד שוב"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />

            {error && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <Button onClick={submit} loading={loading} className="w-full" size="lg">
              עדכן סיסמה
            </Button>

            <p className="text-center text-sm text-gray-500">
              לא קיבלת קוד?{' '}
              <Link href="/forgot-password" className="text-blue-600 hover:underline">שלח שוב</Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-gray-400">טוען...</p></div>}>
      <ResetPasswordContent />
    </Suspense>
  );
}
