'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Phone, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import api from '@/lib/api';

export default function ForgotPasswordPage() {
  const router   = useRouter();
  const [phone, setPhone]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [sent, setSent]         = useState(false);

  const submit = async () => {
    if (loading) return;
    if (!phone.trim()) { setError('יש להזין מספר טלפון'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/auth/forgot-password', { phone: phone.trim() });
      setSent(true);
      setTimeout(() => router.push(`/reset-password?phone=${encodeURIComponent(phone.trim())}`), 2000);
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
          <h1 className="text-2xl font-bold text-gray-900">שכחתי סיסמה</h1>
          <p className="text-gray-500 text-sm mt-1">נשלח קוד אימות למספר שלך</p>
        </div>

        {sent ? (
          <div className="text-center py-6">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <p className="text-green-700 font-medium">קוד נשלח ב-SMS</p>
            <p className="text-sm text-gray-500 mt-1">מעביר לדף האיפוס...</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative">
              <Input
                label="מספר טלפון"
                type="tel"
                placeholder="050-0000000"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
              />
              <Phone className="absolute left-3 top-8 w-4 h-4 text-gray-400" />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <Button onClick={submit} loading={loading} className="w-full" size="lg">
              שלח קוד
            </Button>

            <p className="text-center text-sm text-gray-500">
              <Link href="/login" className="text-blue-600 hover:underline">חזרה לכניסה</Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
