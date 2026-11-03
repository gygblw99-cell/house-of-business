/**
 * Daily DB backup — pg_dump to local file, keeps last 7 days.
 * Run via PM2 cron (see ecosystem.config.js) or manually:
 *   node scripts/backup_db.js
 *
 * Requires pg_dump to be accessible in PATH (comes with PostgreSQL client tools).
 * If BACKUP_DIR is not set, backups go to  backend/backups/
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('[Backup] DATABASE_URL not set'); process.exit(1); }

const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '../backups');
const KEEP_DAYS   = parseInt(process.env.BACKUP_KEEP_DAYS || '7');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const filename = `hob-backup-${ts}.dump`;
const filepath = path.join(BACKUP_DIR, filename);

console.log(`[Backup] Starting → ${filepath}`);

try {
  // pg_dump custom format (compressed, restorable with pg_restore)
  execSync(`pg_dump --format=custom --no-password "${DATABASE_URL}" --file="${filepath}"`, {
    timeout: 10 * 60 * 1000, // 10 min max
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const size = fs.statSync(filepath).size;
  console.log(`[Backup] ✓ Success — ${(size / 1024 / 1024).toFixed(1)} MB`);

  // Prune backups older than KEEP_DAYS
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('hob-backup-')) continue;
    const fp  = path.join(BACKUP_DIR, f);
    const mtime = fs.statSync(fp).mtimeMs;
    if (mtime < cutoff) { fs.unlinkSync(fp); pruned++; }
  }
  if (pruned) console.log(`[Backup] Pruned ${pruned} old backup(s)`);

  process.exit(0);
} catch (err) {
  console.error('[Backup] FAILED:', err.message);

  // Send an alert so the failure is visible — PM2 only logs exit code, not why.
  // POST to a monitoring webhook if configured, otherwise log prominently.
  const alertMsg = `[HOB Backup FAILED] ${new Date().toISOString()} — ${err.message}`;

  if (process.env.BACKUP_ALERT_WEBHOOK) {
    try {
      // Use native fetch (Node 18+); fall back gracefully if unavailable
      const fetchFn = typeof fetch !== 'undefined' ? fetch : null;
      if (fetchFn) {
        await fetchFn(process.env.BACKUP_ALERT_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: alertMsg }),
        }).catch(() => {});
      }
    } catch {}
  }

  // Report to Sentry if configured
  if (process.env.SENTRY_DSN) {
    try {
      const Sentry = require('@sentry/node');
      Sentry.init({ dsn: process.env.SENTRY_DSN });
      Sentry.captureException(err);
      await Sentry.flush(2000).catch(() => {});
    } catch {}
  }

  // Write failure marker file so external monitoring can detect it
  try {
    const fs   = require('fs');
    const path = require('path');
    fs.writeFileSync(
      path.join(BACKUP_DIR, 'BACKUP_FAILED.txt'),
      `${alertMsg}\n`,
      'utf8'
    );
  } catch {}

  console.error('[Backup] Alert sent. Exiting with code 0 to prevent PM2 restart loops.');
  process.exit(0);
}
