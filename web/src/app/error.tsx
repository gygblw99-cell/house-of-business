'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[App Error]', error);
  }, [error]);

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
          border: '1px solid rgba(239,68,68,0.2)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <span style={{ fontSize: 28 }}>⚠️</span>
        </div>
        <h2 className="text-xl font-bold mb-2" style={{ color: '#e8e8e4' }}>
          משהו השתבש
        </h2>
        <p className="text-sm mb-6" style={{ color: '#9aa0ab' }}>
          אירעה שגיאה בטעינת העמוד. נסה שוב.
        </p>
        <button
          onClick={reset}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{
            background: 'linear-gradient(135deg,#b8941f,#c9a227)',
            color: '#050507',
          }}
        >
          נסה שוב
        </button>
      </div>
    </div>
  );
}
