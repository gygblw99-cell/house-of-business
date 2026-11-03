'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { restoreSession } from '@/store/slices/authSlice';

export default function Home() {
  const router   = useRouter();
  const dispatch = useAppDispatch();
  const { user, loading } = useAppSelector((s) => s.auth);

  // Restore session before deciding where to redirect.
  // Without this, user is always null on first render and everyone gets
  // bounced to /login even when they have a valid cookie.
  useEffect(() => {
    dispatch(restoreSession());
  }, [dispatch]);

  useEffect(() => {
    if (loading) return; // wait for restoreSession to finish
    router.replace(user ? '/dashboard' : '/login');
  }, [user, loading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    </div>
  );
}
