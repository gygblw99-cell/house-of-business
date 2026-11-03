'use client';

import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      dir="rtl"
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ fontSize: '2.5rem', marginBottom: '1rem', opacity: 0.25 }}>⚠</div>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        אירעה שגיאה בטעינת הדף
      </h2>
      <p style={{ color: '#6b7280', marginBottom: '1.75rem', maxWidth: 300, fontSize: '0.9rem' }}>
        משהו השתבש. ניתן לנסות שוב.
      </p>
      <button
        onClick={reset}
        style={{
          padding: '0.55rem 1.4rem',
          borderRadius: '0.75rem',
          background: 'rgba(201,162,39,0.15)',
          color: '#c9a227',
          border: '1px solid rgba(201,162,39,0.3)',
          fontWeight: 600,
          fontSize: '0.875rem',
          cursor: 'pointer',
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}
