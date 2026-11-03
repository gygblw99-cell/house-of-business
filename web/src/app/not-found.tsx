import Link from 'next/link';

export default function NotFound() {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#08080a',
        color: '#f3f4f6',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ marginBottom: '1.5rem', opacity: 0.15, fontSize: '7rem', lineHeight: 1 }}>
        404
      </div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', color: '#f3f4f6' }}>
        הדף לא נמצא
      </h1>
      <p style={{ color: '#6b7280', marginBottom: '2rem', maxWidth: 320 }}>
        הכתובת שחיפשת אינה קיימת או הוסרה.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/dashboard"
          style={{
            padding: '0.6rem 1.4rem',
            borderRadius: '0.75rem',
            background: 'rgba(201,162,39,0.15)',
            color: '#c9a227',
            border: '1px solid rgba(201,162,39,0.3)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          לדשבורד
        </Link>
        <Link
          href="/login"
          style={{
            padding: '0.6rem 1.4rem',
            borderRadius: '0.75rem',
            background: 'rgba(255,255,255,0.05)',
            color: '#9ca3af',
            border: '1px solid rgba(255,255,255,0.08)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}
        >
          התחברות
        </Link>
      </div>
    </div>
  );
}
