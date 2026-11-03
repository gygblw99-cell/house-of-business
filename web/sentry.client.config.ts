import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // שגיאות JS בדפדפן המשתמש
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

  // מסנן שגיאות רשת רגילות שאין לנו שליטה עליהן
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'ChunkLoadError',
    /Network request failed/,
    /Failed to fetch/,
    /Load failed/,
  ],

  // לא לשלוח שגיאות בפיתוח
  enabled: process.env.NODE_ENV === 'production',
});
