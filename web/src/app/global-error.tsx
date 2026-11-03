'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="he" dir="rtl">
      <body style={{ margin: 0, background: '#0a0a0e', fontFamily: 'system-ui, sans-serif' }}>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 400,
              textAlign: 'center',
              background: '#141418',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 20,
              padding: 40,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 20 }}>🔴</div>
            <h2 style={{ color: '#e8e8e4', fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>
              שגיאה קריטית
            </h2>
            <p style={{ color: '#9aa0ab', fontSize: 14, margin: '0 0 24px' }}>
              אירעה שגיאה בלתי צפויה. נסה לרענן את הדף.
            </p>
            <button
              onClick={reset}
              style={{
                padding: '10px 28px',
                borderRadius: 12,
                background: 'linear-gradient(135deg,#b8941f,#c9a227)',
                color: '#050507',
                fontWeight: 700,
                fontSize: 14,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              רענן
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
