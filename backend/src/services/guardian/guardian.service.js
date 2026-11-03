/**
 * Guardian AI — Platform Stability & Monitoring Service
 *
 * Scans PM2 error logs, runs endpoint health checks, checks DB health,
 * deduplicates errors by hash, and creates structured incident reports
 * with optional Claude AI analysis for critical/high severity issues.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');
const db      = require('../../utils/db');
const logger  = require('../../utils/logger');
const { analyzeWithGuardianAI } = require('../../agents/guardian.agent');
const { scrubPII: scrubForAI } = require('../../utils/aiSanitize');
const { sendEmail } = require('../notifications/email.service');
const { withTimeout } = require('../../utils/withTimeout');
const { getFreeTierIncident } = require('../ai/freeTierHealth.service');

const PM2_ERROR_LOG = path.join(os.homedir(), '.pm2', 'logs', 'hob-backend-error.log');
const PM2_OUT_LOG   = path.join(os.homedir(), '.pm2', 'logs', 'hob-backend-out.log');
// BACKEND_BASE_URL — use service name in Docker (e.g. http://backend:3000),
// fallback to localhost only in non-production
const BASE_URL = process.env.BACKEND_BASE_URL ||
  `http://localhost:${process.env.PORT || 3001}`;
if (!process.env.BACKEND_BASE_URL && process.env.NODE_ENV === 'production') {
  logger.warn('[Guardian] BACKEND_BASE_URL not set in production — health checks will target localhost');
}

// ── DB Table Bootstrap ─────────────────────────────────────────────────────────

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS guardian_incidents (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      severity         TEXT NOT NULL,
      feature          TEXT,
      issue_summary    TEXT NOT NULL,
      technical_details TEXT,
      root_cause_analysis TEXT,
      user_impact      TEXT,
      estimated_risk   TEXT,
      recommended_fix  TEXT,
      confidence_score FLOAT,
      affected_services TEXT[],
      logs_summary     TEXT,
      prediction_analysis TEXT,
      status           TEXT NOT NULL DEFAULT 'open',
      monitoring_actions TEXT[],
      recovery_actions TEXT[],
      error_hash       TEXT,
      occurrence_count INT NOT NULL DEFAULT 1,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at  TIMESTAMPTZ,
      resolved_at      TIMESTAMPTZ,
      last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS guardian_health_log (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service         TEXT NOT NULL,
      endpoint        TEXT,
      status          TEXT NOT NULL,
      response_time_ms INT,
      error_message   TEXT,
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Indexes (ignore errors if already exist)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_gi_status   ON guardian_incidents(status)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_gi_severity ON guardian_incidents(severity)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_gi_hash     ON guardian_incidents(error_hash)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ghl_time    ON guardian_health_log(checked_at DESC)`).catch(() => {});
}

// ── Log Parsing ────────────────────────────────────────────────────────────────

function readTailBytes(filePath, bytes = 20 * 1024) {
  if (!fs.existsSync(filePath)) return '';
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(bytes, stat.size);
    const buf = Buffer.alloc(readSize);
    const fd  = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// Transient errors we deliberately ignore
const NOISE_PATTERNS = [
  'Connection terminated',
  'EADDRINUSE',
  'client password must be a string',
  'SCRAM-SERVER',
];

function parseLogErrors(logContent, since) {
  const errors = [];
  const lines  = logContent.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Skip noise
    if (NOISE_PATTERNS.some(p => line.includes(p))) continue;

    // PM2 timestamp format: 2026-05-08T21:25:10
    const tsMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (!tsMatch) continue;

    const ts = new Date(tsMatch[1]);
    if (since && ts <= since) continue;

    // Must contain error indicator
    if (!/error/i.test(line)) continue;

    // Extract the actual error message
    const errMatch = line.match(/error:\s+(.+)/i);
    if (!errMatch) continue;

    const message = errMatch[1].trim();
    if (message.length < 5) continue;

    // Collect following stack trace lines (start with spaces or 'at ')
    const stackLines = [];
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const next = lines[j];
      if (/^\s+(at\s|Error:)/.test(next)) {
        stackLines.push(next.trim());
      } else {
        break;
      }
    }

    errors.push({
      timestamp: ts,
      message,
      raw:   line.trim(),
      stack: stackLines.join('\n') || null,
    });
  }

  return errors;
}

// ── Error Classification ───────────────────────────────────────────────────────

function hashError(message) {
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/\b\d+\b/g, 'N')
    .replace(/["'`]/g, '')
    .toLowerCase()
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function classifySeverity(message) {
  const m = message.toLowerCase();
  if (/econnrefused|connection refused|offline|database.*down/.test(m))  return 'critical';
  if (/table.*does not exist|relation.*does not exist/.test(m))           return 'critical';
  if (/permission denied|authentication failed/.test(m))                  return 'critical';
  if (/column.*does not exist|does not exist/.test(m))                   return 'high';
  if (/null value.*not-null|violates.*constraint/.test(m))               return 'high';
  if (/syntax error|invalid input syntax|operator is not unique/.test(m)) return 'high';
  if (/timeout|ETIMEDOUT/.test(m))                                        return 'high';
  if (/duplicate key|unique constraint/.test(m))                         return 'medium';
  if (/warning|deprecated/.test(m))                                       return 'low';
  return 'medium';
}

function classifyFeature(message) {
  const m = message.toLowerCase();
  if (/inventory/.test(m))                    return 'מלאי';
  if (/invoice/.test(m))                      return 'חשבוניות';
  if (/forecast/.test(m))                     return 'חיזוי ביקוש';
  if (/audit/.test(m))                        return 'ביקורת עסקית';
  if (/employee|shift|payroll/.test(m))       return 'עובדים';
  if (/recipe|dish|menu/.test(m))             return 'מנות';
  if (/dashboard/.test(m))                    return 'דשבורד';
  if (/autoinsights|insights/.test(m))        return 'תובנות AI';
  if (/ai/.test(m))                           return 'יועץ AI';
  if (/finance|vat/.test(m))                  return 'פיננסים';
  if (/supplier/.test(m))                     return 'ספקים';
  if (/delivery/.test(m))                     return 'משלוחים';
  if (/reminder/.test(m))                     return 'תזכורות';
  if (/pos|sale/.test(m))                     return 'קופה';
  if (/customer|loyalty/.test(m))             return 'לקוחות';
  if (/fraud/.test(m))                        return 'גילוי חריגות';
  return 'שרת';
}

// ── Admin Alert Email ──────────────────────────────────────────────────────────
// Fires once per NEW distinct critical/high incident (not on repeat
// occurrences of an already-open one — see the dedup check in the scan loop).

async function _resolveAlertRecipients() {
  if (process.env.ADMIN_ALERT_EMAIL) {
    return process.env.ADMIN_ALERT_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
  }
  const { rows } = await db.query(
    `SELECT email FROM admin_users WHERE role = 'super_admin' AND is_active = TRUE`
  ).catch(() => ({ rows: [] }));
  return rows.map(r => r.email).filter(Boolean);
}

function _escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function _alertAdminOfIncident(incident, severity, feature, message) {
  try {
    const recipients = await _resolveAlertRecipients();
    if (!recipients.length) {
      logger.warn('[Guardian] No admin alert recipient configured (ADMIN_ALERT_EMAIL or admin_users super_admin) — skipping email alert');
      return;
    }
    const severityLabel = { critical: 'קריטי', high: 'גבוה' }[severity] || severity;
    await sendEmail({
      to: recipients,
      subject: `🚨 Guardian AI — תקלה ברמת חומרה ${severityLabel} (${feature})`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#dc2626">Guardian AI זיהה תקלה חדשה</h2>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">חומרה</td><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold">${_escHtml(severityLabel)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">פיצ'ר</td><td style="padding:8px;border:1px solid #e5e7eb">${_escHtml(feature)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">תיאור</td><td style="padding:8px;border:1px solid #e5e7eb">${_escHtml(message)}</td></tr>
          </table>
          <p style="color:#6b7280;font-size:12px">נשלח אוטומטית על ידי Guardian AI — House of Business</p>
        </div>`,
    });
    logger.info(`[Guardian] Alert email sent to ${recipients.length} recipient(s) for incident ${incident.id}`);
  } catch (err) {
    // Never let an alert-delivery failure break the scan itself
    logger.warn(`[Guardian] Failed to send alert email: ${err.message}`);
  }
}

// ── Endpoint Health Check ──────────────────────────────────────────────────────

function checkEndpointHealth(urlPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    // BASE_URL is https in production (BACKEND_BASE_URL=https://api.houseofbusiness.co.il) —
    // http.get() throws synchronously (ERR_INVALID_PROTOCOL) on an https:// URL, which was
    // crashing every single scan (unhandled rejection propagating out of this Promise,
    // uncaught by the caller's loop) with no visible error, since guardian.scheduler.js logs
    // it as `logger.error(msg, err.message)` — a raw string in the metadata position, which
    // Winston's JSON formatter silently drops.
    const client = BASE_URL.startsWith('https:') ? https : http;
    const req = client.get(`${BASE_URL}${urlPath}`, { timeout: timeoutMs }, (res) => {
      // Drain the response to free the socket
      res.resume();
      const ms = Date.now() - start;
      // 401/403 = auth working (healthy), 500+ = server error
      const status = res.statusCode >= 500 ? 'degraded' : 'healthy';
      resolve({ status, statusCode: res.statusCode, responseTime: ms });
    });

    req.on('error', (err) => {
      resolve({ status: 'down', statusCode: 0, responseTime: Date.now() - start, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'degraded', statusCode: 0, responseTime: timeoutMs, error: 'timeout' });
    });
  });
}

// ── Main Guardian Scan ─────────────────────────────────────────────────────────

async function runGuardianScan() {
  logger.info('[Guardian] Starting platform scan…');
  const scanStart = Date.now();

  // Last health check time (for log delta)
  const { rows: lastRow } = await db.query(
    `SELECT MAX(checked_at) AS ts FROM guardian_health_log`
  ).catch(() => ({ rows: [{ ts: null }] }));

  const since = lastRow[0]?.ts
    ? new Date(lastRow[0].ts)
    : new Date(Date.now() - 10 * 60 * 1000);

  // ── 1. Parse error logs ──────────────────────────────────────
  // PM2_ERROR_LOG/PM2_OUT_LOG only ever have content on a PM2-managed deploy
  // (docker-compose/bare metal) — Railway runs `node src/index.js` directly,
  // so that path is silently empty there. getRecentErrorLog() is an
  // in-process ring buffer fed by every logger.error() call, which works
  // regardless of how the process was launched.
  const errorLogContent = readTailBytes(PM2_ERROR_LOG);
  const outLogContent   = readTailBytes(PM2_OUT_LOG);
  const inProcessLog    = logger.getRecentErrorLog ? logger.getRecentErrorLog() : '';
  const rawErrors       = parseLogErrors(errorLogContent + '\n' + outLogContent + '\n' + inProcessLog, since);

  // ── 2. Database health ──────────────────────────────────────
  let dbStatus = 'healthy';
  let dbMs     = 0;
  let dbError  = null;
  const dbT0 = Date.now();
  try {
    await withTimeout(
    db.query('SELECT 1'),
    5000, "DB health check");
    dbMs = Date.now() - dbT0;
    if (dbMs > 3000) dbStatus = 'degraded';
  } catch (err) {
    dbMs     = Date.now() - dbT0;
    dbStatus = err.message.includes('timeout') ? 'degraded' : 'down';
    dbError  = err.message;
    rawErrors.push({ timestamp: new Date(), message: `Database health check failed: ${err.message}`, raw: err.message, stack: null });
  }

  await db.query(
    `INSERT INTO guardian_health_log (service, endpoint, status, response_time_ms, error_message)
     VALUES ('Database', '/db', $1, $2, $3)`,
    [dbStatus, dbMs, dbError]
  ).catch(() => {});

  // ── 3. Endpoint health checks ───────────────────────────────
  // 401 = auth working (route reachable) → healthy; 500+ = server error → degraded
  const ENDPOINTS = [
    { path: '/health',            name: 'Server Health' },
    { path: '/api/guardian/ping', name: 'Guardian'      },
    { path: '/api/auth/me',       name: 'Auth'          },
    { path: '/api/dashboard',     name: 'Dashboard'     },
    { path: '/api/inventory',     name: 'Inventory'     },
  ];

  const endpointResults = [];
  for (const ep of ENDPOINTS) {
    const result = await checkEndpointHealth(ep.path);
    endpointResults.push({ ...result, name: ep.name, endpoint: ep.path });

    await db.query(
      `INSERT INTO guardian_health_log (service, endpoint, status, response_time_ms, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [ep.name, ep.path, result.status, result.responseTime, result.error || null]
    ).catch(() => {});

    if (result.status === 'down') {
      rawErrors.push({
        timestamp: new Date(),
        message:   `API endpoint unreachable: ${ep.path} — ${result.error || 'no response'}`,
        raw:       `endpoint check: ${ep.path}`,
        stack:     null,
      });
    }
  }

  // ── 3b. Free AI tier health ─────────────────────────────────
  // A dead free tier breaks nothing for the owner, so nothing ever surfaced it:
  // Groq was pinned to a model that had been retired, every call 404-ed, and the
  // orchestrator silently fell through to a paid provider for months until the
  // Anthropic credit ran out. ai_logs already recorded tier/provider/cost on
  // every call, so the evidence was there the whole time with no reader.
  try {
    const freeTier = await getFreeTierIncident();
    if (freeTier) {
      rawErrors.push({
        timestamp: new Date(),
        message:   `${freeTier.summary} — ${freeTier.details}`,
        raw:       `ai_free_tier: verdict=${freeTier.health.verdict} freeCalls=${freeTier.health.freeCalls}/${freeTier.health.totalCalls}`,
        stack:     null,
      });
    }
  } catch (err) {
    logger.warn('[Guardian] free-tier check failed', { err: err.message });
  }

  // ── 4. Process errors → incidents ──────────────────────────
  const incidentsCreated = [];
  const seenHashes = new Set();

  for (const err of rawErrors) {
    const hash = hashError(err.message);
    if (seenHashes.has(hash)) continue; // deduplicate within same scan
    seenHashes.add(hash);

    // Check existing open incident with same hash
    const { rows: existing } = await db.query(
      `SELECT id, occurrence_count FROM guardian_incidents
       WHERE error_hash = $1 AND status = 'open' LIMIT 1`,
      [hash]
    ).catch(() => ({ rows: [] }));

    if (existing.length > 0) {
      await db.query(
        `UPDATE guardian_incidents
         SET occurrence_count = occurrence_count + 1, last_seen_at = NOW()
         WHERE id = $1`,
        [existing[0].id]
      ).catch(() => {});
      continue;
    }

    // New unique incident
    const severity = classifySeverity(err.message);
    const feature  = classifyFeature(err.message);

    let analysis = {
      root_cause_analysis: null, user_impact: null, recommended_fix: null,
      confidence_score: null, prediction_analysis: null,
      monitoring_actions: [], recovery_actions: [],
    };

    if ((severity === 'critical' || severity === 'high') && process.env.ANTHROPIC_API_KEY) {
      try {
        analysis = await analyzeWithGuardianAI(
          scrubForAI(err.message),
          feature,
          severity,
          { stack: scrubForAI(err.stack) }
        );
      } catch (aiErr) {
        logger.warn(`[Guardian] AI analysis skipped: ${aiErr.message}`);
      }
    }

    const estimatedRisk = { critical: 'גבוה מאוד', high: 'גבוה', medium: 'בינוני', low: 'נמוך' }[severity];

    const { rows: [incident] } = await db.query(
      `INSERT INTO guardian_incidents
         (severity, feature, issue_summary, technical_details, root_cause_analysis,
          user_impact, estimated_risk, recommended_fix, confidence_score,
          affected_services, logs_summary, prediction_analysis,
          monitoring_actions, recovery_actions, error_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        severity,
        feature,
        err.message.slice(0, 255),
        err.raw.slice(0, 500),
        analysis.root_cause_analysis,
        analysis.user_impact,
        estimatedRisk,
        analysis.recommended_fix,
        analysis.confidence_score,
        [feature],
        (err.stack ? err.raw + '\n' + err.stack : err.raw).slice(0, 400),
        analysis.prediction_analysis,
        analysis.monitoring_actions,
        analysis.recovery_actions,
        hash,
      ]
    );

    incidentsCreated.push(incident.id);
    logger.warn(`[Guardian] New ${severity} incident: ${err.message.slice(0, 80)}`);

    if (severity === 'critical' || severity === 'high') {
      await _alertAdminOfIncident(incident, severity, feature, err.message.slice(0, 255));
    }
  }

  // ── 5. Auto-resolve incidents whose error hasn't recurred in 24h ──
  // Critical and high severity incidents must be resolved manually — only auto-resolve low/medium.
  await db.query(
    `UPDATE guardian_incidents
     SET status = 'resolved', resolved_at = NOW()
     WHERE status = 'open'
       AND severity NOT IN ('critical', 'high')
       AND last_seen_at < NOW() - INTERVAL '24 hours'`
  ).catch(() => {});

  const scanMs = Date.now() - scanStart;
  logger.info(`[Guardian] Scan done in ${scanMs}ms — ${rawErrors.length} errors, ${incidentsCreated.length} new incidents`);

  return {
    scanned:          true,
    errorsFound:      rawErrors.length,
    newIncidents:     incidentsCreated.length,
    dbStatus,
    dbResponseMs:     dbMs,
    endpointResults,
    scanMs,
  };
}

// ── Get current system health summary ─────────────────────────────────────────

async function getHealthSummary() {
  const { rows: latest } = await db.query(
    `SELECT DISTINCT ON (service) service, endpoint, status, response_time_ms, checked_at
     FROM guardian_health_log
     ORDER BY service, checked_at DESC`
  ).catch(() => ({ rows: [] }));

  const { rows: openCounts } = await db.query(
    `SELECT severity, COUNT(*)::int AS count
     FROM guardian_incidents
     WHERE status = 'open'
     GROUP BY severity`
  ).catch(() => ({ rows: [] }));

  const { rows: [lastScan] } = await db.query(
    `SELECT MAX(checked_at) AS ts FROM guardian_health_log`
  ).catch(() => ({ rows: [{ ts: null }] }));

  // The scheduler scans every 30 minutes, so a service whose newest row is
  // hours old is not "healthy" — it simply stopped being probed. DISTINCT ON
  // returns the latest row per service with no cutoff, so services dropped
  // from the scan list kept reporting the last status they ever had; five of
  // them were still showing green off checks that ran 97 days earlier.
  const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 4 missed scans
  const now = Date.now();
  const services = latest.map(s => {
    const age = s.checked_at ? now - new Date(s.checked_at).getTime() : Infinity;
    return { ...s, stale: age > STALE_AFTER_MS, age_ms: Number.isFinite(age) ? age : null };
  });

  const openBySeverity = Object.fromEntries(openCounts.map(r => [r.severity, r.count]));

  // An open critical incident is not a healthy system. Previously this was
  // derived purely from service pings, so the panel reported "healthy" while
  // real, unresolved critical incidents sat in the table underneath it —
  // which is precisely the state that made the whole feature look inert.
  const overallStatus =
      services.some(s => !s.stale && s.status === 'down') || (openBySeverity.critical > 0) ? 'down'
    : services.some(s => !s.stale && s.status === 'degraded')
      || services.some(s => s.stale)
      || (openBySeverity.high > 0)                                                          ? 'degraded'
    :                                                                                          'healthy';

  return {
    services,
    openBySeverity,
    lastScanAt:    lastScan?.ts || null,
    staleServices: services.filter(s => s.stale).map(s => s.service),
    overallStatus,
  };
}

// ── Predictive Pattern Analysis ────────────────────────────────────────────────
// Detects time-of-day, day-of-week, and feature-level patterns in incidents.
// Returns actionable predictions so ops can act before failures recur.

async function analyzeIncidentPatterns() {
  const [hourlyRes, featureRes, weekdayRes] = await Promise.all([
    db.query(
      `SELECT
         EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
         COUNT(*)::int                                                      AS incident_count,
         COUNT(*) FILTER (WHERE severity IN ('critical','high'))::int       AS serious_count
       FROM guardian_incidents
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1
       ORDER BY 1`
    ).catch(() => ({ rows: [] })),

    db.query(
      `SELECT
         feature,
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE severity = 'critical')::int         AS critical_count,
         ROUND(AVG(occurrence_count)::numeric, 1)::float            AS avg_recurrence,
         MAX(last_seen_at)                                          AS last_seen
       FROM guardian_incidents
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY feature
       ORDER BY total DESC
       LIMIT 10`
    ).catch(() => ({ rows: [] })),

    db.query(
      `SELECT
         TO_CHAR(created_at AT TIME ZONE 'Asia/Jerusalem', 'Day')   AS day_name,
         EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
         COUNT(*)::int                                               AS incident_count
       FROM guardian_incidents
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1, 2
       ORDER BY 2`
    ).catch(() => ({ rows: [] })),
  ]);

  const hourlyPatterns  = hourlyRes.rows;
  const featurePatterns = featureRes.rows;
  const weekdayPatterns = weekdayRes.rows;

  const predictions = [];

  // Peak hour warning
  const peakHour = hourlyPatterns.reduce(
    (max, h) => (h.incident_count > (max?.incident_count || 0) ? h : max),
    null
  );
  if (peakHour && peakHour.incident_count >= 3) {
    predictions.push({
      type:       'peak_hours',
      confidence: Math.min(0.9, peakHour.incident_count / 10),
      message:    `רוב התקלות מתרחשות בשעה ${peakHour.hour}:00–${peakHour.hour + 1}:00 (${peakHour.incident_count} אירועים ב-30 יום) — מומלץ להגביר ניטור בזמן זה`,
    });
  }

  // Recurring feature warning
  const topFeature = featurePatterns[0];
  if (topFeature && topFeature.total >= 3) {
    predictions.push({
      type:       'recurring_feature',
      confidence: Math.min(0.9, topFeature.total / 15),
      message:    `הפיצ'ר "${topFeature.feature}" נכשל ${topFeature.total} פעמים ב-30 יום${topFeature.critical_count > 0 ? ` (כולל ${topFeature.critical_count} קריטיים)` : ''} — מומלץ בדיקה מעמיקה`,
    });
  }

  // High-recurrence incident
  const recurringFeature = featurePatterns.find(f => f.avg_recurrence >= 3);
  if (recurringFeature) {
    predictions.push({
      type:       'high_recurrence',
      confidence: Math.min(0.85, recurringFeature.avg_recurrence / 10),
      message:    `תקלות ב"${recurringFeature.feature}" חוזרות בממוצע ${recurringFeature.avg_recurrence} פעמים כל אירוע — ייתכן שהשורש לא טופל`,
    });
  }

  return {
    hourlyPatterns,
    featurePatterns,
    weekdayPatterns,
    predictions,
    peakHour:                peakHour?.hour ?? null,
    topProblematicFeature:   topFeature?.feature ?? null,
  };
}

module.exports = { runGuardianScan, getHealthSummary, ensureTables, analyzeIncidentPatterns };
