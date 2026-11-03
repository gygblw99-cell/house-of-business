'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Lock } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8 text-center space-y-5">
        <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
          <Lock className="w-7 h-7 text-gray-400" />
        </div>

        <div>
          <div className="flex items-center justify-center gap-2 mb-1">
            <Building2 className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-semibold text-blue-600">House of Business</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">הרישום סגור</h1>
          <p className="text-sm text-gray-500 mt-2 leading-relaxed">
            הצטרפות לפלטפורמה מתבצעת בלבד דרך המנהל.
            <br />
            צור קשר כדי לפתוח עסק חדש.
          </p>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => router.push('/login')}
            className="w-full py-2.5 px-4 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
          >
            כניסה לחשבון קיים
          </button>
          <a
            href="mailto:gygblw99@gmail.com"
            className="block w-full py-2.5 px-4 border border-gray-200 text-gray-600 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors"
          >
            צור קשר עם המנהל
          </a>
        </div>

        <p className="text-xs text-gray-400">
          <Link href="/terms" className="hover:text-gray-600 underline">תנאי שימוש</Link>
          {' · '}
          <Link href="/privacy" className="hover:text-gray-600 underline">מדיניות פרטיות</Link>
        </p>
      </div>
    </div>
  );
}
