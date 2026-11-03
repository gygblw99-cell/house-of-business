require('dotenv').config();

// ── Sentry — must be initialised before anything else ───────────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  try {
    const { nodeProfilingIntegration } = require('@sentry/profiling-node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      integrations: [nodeProfilingIntegration()],
      enableLogs: true,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
      profileSessionSampleRate: 0.1,
      profileLifecycle: 'trace',
    });
  } catch {
    // profiling-node not available — init without it
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      enableLogs: true,
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    });
  }
}

const fs        = require('fs');
const path      = require('path');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const logger    = require('./utils/logger');

// צור תיקיית logs אם לא קיימת (נדרש ל-Winston בproduction) — יחסית ל-cwd, כמו שWinston עצמו פותר 'logs/error.log'
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ── Security startup checks ──────────────────────────────────
{
  const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`FATAL: Missing required env vars: ${missing.join(', ')}. Refusing to start.`);
    process.exit(1);
  }

  const jwt = process.env.JWT_SECRET;
  if (jwt === 'hob-secret') {
    logger.error('FATAL: JWT_SECRET is the insecure default. Change it before running.');
    process.exit(1);
  }
  if (jwt.length < 32) {
    logger.error(`FATAL: JWT_SECRET too short (${jwt.length} chars). Minimum 32 characters required.`);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    if (jwt.length < 64) {
      logger.error(`FATAL: JWT_SECRET must be at least 64 characters in production (got ${jwt.length}).`);
      process.exit(1);
    }
    if (!process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-')) {
      logger.error('FATAL: Invalid ANTHROPIC_API_KEY format in production.');
      process.exit(1);
    }
    const REQUIRED_PROD = ['APP_URL', 'ALLOWED_ORIGINS', 'BACKEND_URL'];
    const missingProd = REQUIRED_PROD.filter(k => !process.env[k]);
    if (missingProd.length) {
      logger.error(`FATAL: Missing required production env vars: ${missingProd.join(', ')}`);
      process.exit(1);
    }
    // ADMIN_ORIGIN is required for CSRF to work in production
    if (!process.env.ADMIN_ORIGIN) {
      logger.error('FATAL: ADMIN_ORIGIN env var is required in production (used for admin CSRF protection).');
      process.exit(1);
    }
  }

  // ── Optional-service warnings (non-fatal) ──────────────────
  if (!process.env.RESEND_API_KEY) {
    logger.warn('[Startup] RESEND_API_KEY not configured — password reset, invite, and payslip emails will NOT be sent');
  }
  if (!process.env.TWILIO_ACCOUNT_SID) {
    logger.warn('[Startup] Twilio not configured — SMS notifications will not be sent');
  }
  if (!process.env.FIREBASE_PROJECT_ID) {
    logger.warn('[Startup] Firebase not configured — push notifications will not be sent');
  }
  if (!process.env.SENTRY_DSN) {
    logger.warn('[Startup] SENTRY_DSN not set — errors will not be reported to Sentry');
  }
}

const authRoutes          = require('./api/auth.routes');
const businessRoutes      = require('./api/business.routes');
const posRoutes           = require('./api/pos.routes');
const auditRoutes         = require('./api/audit.routes');
const dashboardRoutes     = require('./api/dashboard.routes');
const suppliersRoutes     = require('./api/suppliers.routes');
const invoicesRoutes      = require('./api/invoices.routes');
const employeesRoutes     = require('./api/employees.routes');
const aiRoutes            = require('./api/ai.routes');
const financeRoutes       = require('./api/finance.routes');
const recipesRoutes       = require('./api/recipes.routes');
const notificationsRoutes = require('./api/notifications.routes');
const activityRoutes      = require('./api/activityLog.routes');
const inventoryRoutes     = require('./api/inventory.routes');
const payrollRoutes       = require('./api/payroll.routes');
const eventsRoutes        = require('./api/events.routes');
const exportRoutes           = require('./api/export.routes');
const priceComparisonRoutes  = require('./api/priceComparison.routes');
const messagesRoutes         = require('./api/messages.routes');
const remindersRoutes        = require('./api/reminders.routes');
const deliveriesRoutes       = require('./api/deliveries.routes');
const dishesRoutes           = require('./api/dishes.routes');
const extrasRoutes           = require('./api/extras.routes');
const tasksRoutes            = require('./api/tasks.routes');
const forecastRoutes         = require('./api/forecast.routes');
const reviewsRoutes          = require('./api/reviews.routes');
const zreportRoutes          = require('./api/zreport.routes');
const gmailRoutes            = require('./api/gmail.routes');
const insightsRoutes         = require('./api/insights.routes');
const adminRoutes            = require('./api/admin.routes');
const aiAnalyzeRoutes        = require('./api/aiAnalyze.routes');
const customersRoutes        = require('./api/customers.routes');
const queueRoutes            = require('./api/queue.routes');
const supplierLedgerRoutes   = require('./api/supplierLedger.routes');
const fraudRoutes            = require('./api/fraud.routes');
const guardianRoutes         = require('./api/guardian.routes');
const orchestratorRoutes     = require('./api/orchestrator.routes');
const galleryRoutes          = require('./api/gallery.routes');
const calendarRoutes         = require('./api/calendar.routes');
const syncRoutes             = require('./api/sync.routes');
const publicRoutes           = require('./api/public.routes');
const dataQualityRoutes      = require('./api/dataQuality.routes');
const billingRoutes          = require('./api/billing.routes');

const { bootstrap }                   = require('./db/bootstrap');
const { startPayslipScheduler }       = require('./services/employees/payslip.service');
const { startReminderScheduler }      = require('./services/reminders/reminder.scheduler');
const { startStandingOrderScheduler } = require('./services/suppliers/standingOrder.scheduler');
const { startDeliveryEmailScheduler } = require('./services/deliveries.emailScheduler');
const errorHandler              = require('./middleware/errorHandler');
const { requireAuth, requireAuthImg } = require('./middleware/auth');
const { startMonitor }          = require('./services/pos/pos.monitor');
const { startPosScheduler }     = require('./services/pos/pos.scheduler');
// audit.scheduler (nightly auto-audit) intentionally not imported/started —
// business audit is on-demand only now. See the safeStart block below.
const { startInsightsScheduler } = require('./services/insights/insights.scheduler');
const { startExpiryScheduler }       = require('./services/inventory/expiry.scheduler');
const { startWeeklyReportScheduler } = require('./services/finance/weeklyReport.scheduler');
const { startGuardianScheduler }     = require('./services/guardian/guardian.scheduler');
const { startZReportScheduler }      = require('./services/zreport.scheduler');
const { startCompetitorMonitorScheduler } = require('./services/ai/competitorMonitor.service');
const { startPriceAlertScheduler }   = require('./services/priceComparison/priceAlert.scheduler');
const { startDbWatchdog }            = require('./services/dbWatchdog');
const { startBillingScheduler }        = require('./services/billing/billing.scheduler');
const { startManualBillingScheduler }  = require('./services/billing/manualBilling.scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust the immediate upstream proxy (nginx) only.
// This lets express-rate-limit key on the real client IP from X-Forwarded-For,
// while still rejecting spoofed headers added before nginx.
app.set('trust proxy', 1);

// ── Rate limiting ────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות, נסה שנית בעוד מספר דקות' },
});


// Auth limiter — brute force protection for login/forgot-password only.
// sse-token and image-token are already gated by requireAuth (valid JWT) and
// hit frequently on every SSE reconnect — they don't need brute-force guards.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'test'
    || req.path === '/sse-token'
    || req.path === '/image-token'
    || req.path === '/me',
  message: { error: 'יותר מדי ניסיונות כניסה, נסה שנית בעוד 15 דקות' },
});

// Coarse per-IP burst shield for the AI route groups.
//
// This is NOT the per-user AI quota, though it used to claim to be. It is
// mounted with app.use(), which runs BEFORE the per-route requireAuth, so
// `req.user` was always undefined here and the key silently fell back to
// req.ip — one shared bucket for everyone behind the same NAT. The
// `validate: { keyGeneratorIpFallback: false }` line switched off the very
// warning that would have reported it.
//
// It also counted every request to the group, including cheap reads like
// GET /api/ai/history and /api/ai/health. Simply opening the AI page spent
// several of the 20 before the user had asked anything, and then the reply read
// "יותר מדי בקשות AI" — which sounds like the AI quota is gone when it isn't.
//
// The real per-user limits live AFTER requireAuth, where req.user exists:
// aiLimiter in ai.routes.js (20/min keyed by userId) and rateLimitAI() (a daily
// quota keyed by userId and role). This one now only guards the groups that have
// no per-minute limiter of their own, at a ceiling normal use never reaches.
const aiIpBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות בזמן קצר, המתן רגע ונסה שנית' },
});


// ── Allowed origins ─────────────────────────────────────────
const _defaultOrigins = process.env.NODE_ENV === 'production'
  ? '' // No localhost fallback in production — ALLOWED_ORIGINS must be set
  : 'http://localhost:3000,http://localhost:3002,http://localhost:4000';

if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) {
  logger.error('FATAL: ALLOWED_ORIGINS env var is required in production. Refusing to start.');
  process.exit(1);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || _defaultOrigins)
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// ── Middleware ──────────────────────────────────────────────
// Security headers — must be first
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'", ...ALLOWED_ORIGINS, 'https://*.supabase.co'],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameSrc:    ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false, // needed for some browser APIs
}));
app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and known frontends
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(globalLimiter);
// Per-user rate limiting is applied inside requireAuth (middleware/auth.js)
// once req.user is populated — applying it globally before auth would always skip.

// Request timeout — 30s for most routes; AI routes handled by their own 55s timeout
app.use((req, res, next) => {
  // SSE, AI, and audit routes manage their own timeouts (Claude can take 30-120s)
  if (req.path === '/events' || req.path.startsWith('/api/ai') || req.path.startsWith('/api/audit')) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(408).json({ error: 'הבקשה ארכה יותר מדי זמן' });
  }, 30_000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
});

// ── Routes ──────────────────────────────────────────────────
app.use('/api/auth',          authLimiter, authRoutes);
app.use('/api/business',      businessRoutes);
app.use('/api/pos',           posRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/suppliers',     suppliersRoutes);
app.use('/api/invoices',      invoicesRoutes);
app.use('/api/employees',     employeesRoutes);
app.use('/api/ai',            aiRoutes); // per-user limits live inside (post-requireAuth)
app.use('/api/ai-analyze',    aiIpBurstLimiter, aiAnalyzeRoutes);
app.use('/api/finance',       financeRoutes);
app.use('/api/recipes',       recipesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/activity',      activityRoutes);
app.use('/api/inventory',     inventoryRoutes);
app.use('/api/payroll',       payrollRoutes);
app.use('/api/tips',          require('./api/tips.routes'));
app.use('/api/events',        eventsRoutes);
app.use('/api/export',           exportRoutes);
app.use('/api/price-comparison', priceComparisonRoutes);
app.use('/api/messages',         messagesRoutes);
app.use('/api/reminders',        remindersRoutes);
app.use('/api/deliveries',       deliveriesRoutes);
app.use('/api/dishes',           dishesRoutes);
app.use('/api/extras',           extrasRoutes);
app.use('/api/tasks',            tasksRoutes);
app.use('/api/forecast',         forecastRoutes);
app.use('/api/reviews',          reviewsRoutes);
app.use('/api/zreport',          zreportRoutes);
app.use('/api/gmail',            gmailRoutes);
app.use('/api/insights',         insightsRoutes);
app.use('/api/admin',            adminRoutes);
app.use('/api/customers',        customersRoutes);
app.use('/api/queue',            queueRoutes);
app.use('/api/supplier-ledger',  supplierLedgerRoutes);
app.use('/api/fraud',            aiIpBurstLimiter, fraudRoutes);
app.use('/api/guardian',         aiIpBurstLimiter, guardianRoutes);
app.use('/api/orchestrator',     aiIpBurstLimiter, orchestratorRoutes);
app.use('/api/gallery',          galleryRoutes);
app.use('/api/calendar',         calendarRoutes);
app.use('/api/sync',             syncRoutes);
app.use('/api/public',           publicRoutes);
app.use('/api/data-quality',     dataQualityRoutes);
app.use('/api/billing',          billingRoutes);

// ── Static uploads — auth-gated, strict filename validation, business-scoped ─
const _uploadsDir = require('path').join(__dirname, '../uploads');
const _safeUploadRe = /^[\w\-]+\.(jpg|jpeg|png|webp|heic|pdf)$/i;
const _serveUpload = async (req, res) => {
  // Helmet defaults to CORP: same-origin, which blocks cross-origin <img> loads.
  // Uploads are already protected by the img-token auth check; cross-origin reads
  // are safe because only the token holder (the authenticated user's browser tab)
  // can request them.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (!_safeUploadRe.test(req.params.filename)) return res.status(400).end();
  try {
    // Fail closed on both paths. These files are business documents —
    // invoice scans, task completion photos — so "serve it and hope" is the
    // wrong default:
    //
    //  - No tracking row: previously served to ANY authenticated user, which
    //    meant one business could read another's older uploads given the
    //    filename. Untracked files are now refused; run a backfill into
    //    file_uploads to restore access to any legitimate legacy file.
    //  - Lookup threw: a transient DB error used to widen access to every
    //    caller. A 503 tells the client to retry instead.
    const { rows } = await require('./utils/db').query(
      'SELECT business_id FROM file_uploads WHERE filename = $1',
      [req.params.filename]
    );
    if (!rows[0] || rows[0].business_id !== req.user.businessId) {
      return res.status(404).end();
    }
  } catch (err) {
    logger.error('[uploads] ownership lookup failed', { err: err.message, filename: req.params.filename });
    return res.status(503).end();
  }
  // Served through the storage layer so the same URL works whether the file
  // lives in R2 or on local disk. Every check above — the filename pattern,
  // authentication, and the business-ownership lookup — runs first and is
  // untouched; only where the bytes come from has changed.
  try {
    const objectStore = require('./utils/storage');
    const obj = await objectStore.getStream(req.params.filename);
    if (!obj) return res.status(404).end();
    if (obj.contentType)   res.type(obj.contentType);
    if (obj.contentLength) res.set('Content-Length', String(obj.contentLength));
    // These are private business documents behind an auth check, so they must
    // not be cached by any shared proxy on the way back.
    res.set('Cache-Control', 'private, max-age=900');
    obj.stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    obj.stream.pipe(res);
  } catch (err) {
    logger.error('[uploads] read failed', { err: err.message, filename: req.params.filename });
    if (!res.headersSent) res.status(503).end();
  }
};
// Registered at both /uploads/:filename and /api/uploads/:filename so the
// api-proxy (which always prepends /api) can serve files without a separate
// proxy route in the frontend.
app.get('/uploads/:filename',      requireAuthImg, _serveUpload);
app.get('/api/uploads/:filename',  requireAuthImg, _serveUpload);

// ── Health check ────────────────────────────────────────────
// This is the exact path Railway's own healthcheck polls (railway.json) to
// decide whether the deploy is healthy and whether to route traffic to it —
// a static 200 with no DB check meant Railway considered the service
// perfectly healthy even during a total database outage, so it would never
// roll back a bad deploy or flag the service as down for that failure mode.
app.get('/health', async (_req, res) => {
  try {
    await Promise.race([
      require('./utils/db').query('SELECT 1'),
      // Production baseline for a bare "SELECT 1" runs ~1.6-2.3s (confirmed via
      // live logs — the DB itself/pool is just slow, not a code bug), spiking
      // higher under the connection-pool contention every scheduler startup
      // causes right after boot. A 3s cap left almost no margin and was
      // causing spurious 503s during deploy, which Railway's healthcheck
      // then reads as "unhealthy" and fails the deploy over.
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB health check timeout')), 8000)),
    ]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unreachable', error: err.message });
  }
});

// ── GET /health/storage — can the uploads directory actually be written to? ──
// Uploads live on a Railway volume mounted at /app/uploads. A volume mounts
// owned by root, and if the container's user differs, every write fails with
// EACCES — which is what happened the first time this volume was attached and
// took the service down. Directory creation is lazy now, so a failure no
// longer crashes anything; it just makes uploads quietly 503 instead.
//
// "Quietly" is the problem. Every upload path requires authentication, so the
// storage layer could be completely broken and nothing outside the app would
// show it until a user tried to attach an invoice and failed. This performs
// the exact operations an upload performs — mkdir the directory, write a file,
// read it back, delete it — and reports the result. It returns no file
// contents or paths, only whether each step worked.
app.get('/health/storage', async (_req, res) => {
  // Probes whichever backend is actually live — R2 when configured, local disk
  // otherwise — so this answers "can this service store an upload right now",
  // not "is some particular directory writable".
  const objectStore = require('./utils/storage');
  const r = await objectStore.healthCheck();
  res.status(r.ok ? 200 : 503).json({
    status:   r.ok ? 'ok' : 'not_writable',
    writable: r.ok,
    backend:  r.backend,   // 'r2' — durable across deploys | 'local' — wiped on every deploy
    durable:  r.backend === 'r2',
    steps:    r.steps,
    ...(r.error ? { code: r.code, error: r.error } : {}),
  });
});

// ── 404 — must be after all routes and before the error handler ──────────────
app.use((_req, res) => res.status(404).json({ error: 'הנתיב המבוקש לא נמצא' }));

// ── Sentry error handler — must be before custom errorHandler ───────────────
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Error handler (חייב להיות אחרון) ────────────────────────
app.use(errorHandler);

// ── Global crash guards — log and exit cleanly so PM2 can restart ────────────
// Node.js docs: after uncaughtException the process may be in an undefined state.
// Log, give in-flight requests 5 s to finish, then let PM2 restart clean.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down for safety', { message: err.message, stack: err.stack });
  if (process.env.SENTRY_DSN) {
    try { require('@sentry/node').captureException(err); } catch {}
  }
  setTimeout(() => process.exit(1), 5000).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection — shutting down for safety', { reason: String(reason) });
  if (process.env.SENTRY_DSN) {
    try { require('@sentry/node').captureMessage(String(reason), 'fatal'); } catch {}
  }
  setTimeout(() => process.exit(1), 5000).unref();
});

function safeStart(name, fn) {
  try { fn(); } catch (err) { logger.error(`Scheduler "${name}" failed to start`, { message: err.message }); }
}

(async () => {
  if (process.env.NODE_ENV === 'test') return; // supertest binds its own port
  // Run all DDL migrations before accepting any requests
  await bootstrap();

  const server = app.listen(PORT, async () => {
    logger.info(`House of Business API running on port ${PORT}`);
    // Verify Supabase connectivity at startup (non-blocking warning only)
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const { checkSupabaseConnection } = require('./utils/supabase');
        await checkSupabaseConnection();
      } catch { /* supabase.js logs its own warnings */ }
    }
    // Backend reactors — see services/reactors/index.js. Registered before the
    // schedulers so an event published during startup already has a consumer.
    safeStart('reactors', () => {
      require('./services/reactors/derivedData.reactor').register();
      require('./services/reactors').startReactors();
    });
    safeStart('posMonitor',         startMonitor);
    safeStart('posScheduler',       startPosScheduler);
    // Business audit is on-demand only — the owner runs it for a period they
    // choose (POST /api/audit/run). The nightly auto-audit was removed: it
    // spent AI tokens every night per business whether or not anyone wanted a
    // fresh score. startScheduler() is intentionally left unstarted.
    safeStart('insightsScheduler',  startInsightsScheduler);
    safeStart('payslipScheduler',   startPayslipScheduler);
    safeStart('reminderScheduler',  startReminderScheduler);
    safeStart('standingOrderScheduler', startStandingOrderScheduler);
    safeStart('deliveryEmailScheduler', startDeliveryEmailScheduler);
    safeStart('expiryScheduler',    startExpiryScheduler);
    safeStart('weeklyReportScheduler', startWeeklyReportScheduler);
    safeStart('guardianScheduler',  startGuardianScheduler);
    safeStart('zreportScheduler',        startZReportScheduler);
    safeStart('competitorMonitorScheduler', startCompetitorMonitorScheduler);
    safeStart('priceAlertScheduler', startPriceAlertScheduler);
    safeStart('dbWatchdog',          startDbWatchdog);
    safeStart('billingScheduler',        startBillingScheduler);
    safeStart('manualBillingScheduler',  startManualBillingScheduler);
  });

  // Graceful shutdown — lets in-flight requests finish before container exits
  function shutdown(signal) {
    logger.info(`[Server] ${signal} received — shutting down gracefully`);
    server.close(() => {
      const { closePool } = require('./utils/db');
      closePool().finally(() => {
        logger.info('[Server] DB pool closed — exiting');
        process.exit(0);
      });
    });
    // Force-exit after 10s if requests don't drain
    setTimeout(() => { logger.error('[Server] Forced exit after timeout'); process.exit(1); }, 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})();

module.exports = app;
