'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { restoreSession, logout } from '@/store/slices/authSlice';

export default function SuspendedPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { user, business } = useAppSelector((s) => s.auth);
  const [checking, setChecking] = useState(false);

  // This page is reached outside the (app) layout (which is what normally
  // restores the session), so it needs to bootstrap its own — e.g. on a
  // direct refresh of /suspended.
  useEffect(() => {
    if (user) return;
    dispatch(restoreSession()).then((action) => {
      if (action.type.endsWith('/rejected')) router.replace('/login');
    });
  }, [user, dispatch, router]);

  // If an admin unsuspends the business while this page is open, leave.
  useEffect(() => {
    if (business && !business.is_suspended) router.replace('/dashboard');
  }, [business, router]);

  const handleRefresh = () => {
    setChecking(true);
    dispatch(restoreSession()).finally(() => setChecking(false));
  };

  const handleLogout = () => {
    dispatch(logout()).then(() => router.replace('/login'));
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-8"
      style={{ background: '#0a0a0e' }}
      dir="rtl"
    >
      <div
        className="w-full max-w-md text-center rounded-2xl p-8"
        style={{
          background: '#141418',
          border: '1px solid rgba(201,162,39,0.2)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
          style={{ background: 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.3)' }}
        >
          <span style={{ fontSize: 28 }}>⏸️</span>
        </div>
        <h2 className="text-xl font-bold mb-2" style={{ color: '#e8e8e4' }}>
          מערכת מושהית עד לתשלום
        </h2>
        <p className="text-sm mb-2" style={{ color: '#9aa0ab' }}>
          הגישה למערכת הושהתה זמנית. אנא צור קשר לסידור התשלום כדי לחדש את הגישה.
        </p>
        {business?.suspended_reason && (
          <p
            className="text-sm mb-6 rounded-lg px-4 py-3"
            style={{ background: 'rgba(255,255,255,0.03)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.15)' }}
          >
            {business.suspended_reason}
          </p>
        )}
        <div className="flex gap-3 justify-center flex-wrap mt-2">
          <button
            onClick={handleRefresh}
            disabled={checking}
            className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg,#b8941f,#c9a227)', color: '#050507' }}
          >
            {checking ? 'בודק...' : 'בדוק שוב'}
          </button>
          <button
            onClick={handleLogout}
            className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#9ca3af', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            התנתקות
          </button>
        </div>
      </div>
    </div>
  );
}
