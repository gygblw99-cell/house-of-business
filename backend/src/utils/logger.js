/**
 * Centralized logger — Winston
 * - production: JSON logs (לקליטה ב-CloudWatch / Datadog)
 * - development: צבעוני + קריא
 */

const winston   = require('winston');
const Transport = require('winston-transport');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Railway runs `node src/index.js` directly (no PM2), so Guardian AI's
// PM2-log-file scan (~/.pm2/logs/*) never has content there. This in-memory
// ring buffer gives Guardian a log source that works regardless of how the
// process is launched, without removing the PM2 path (still used by the
// docker-compose/bare-metal PM2 deploy). Formatted to match the exact line
// shape guardian.service.js's parseLogErrors() already parses.
const MAX_RING_ENTRIES = 200;
const _errorRing = [];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

class RingBufferTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    if (info.level.replace(ANSI_RE, '') === 'error') {
      const ts     = new Date().toISOString().slice(0, 19);
      const detail = info.err || info.error;
      const clean  = (s) => String(s ?? '').replace(ANSI_RE, '');
      const msg    = detail && detail !== info.message ? `${clean(info.message)} — ${clean(detail)}` : clean(info.message);
      _errorRing.push(`${ts} error: ${msg}`);
      if (_errorRing.length > MAX_RING_ENTRIES) _errorRing.shift();
    }
    callback();
  }
}

function getRecentErrorLog() {
  return _errorRing.join('\n');
}

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) =>
    `${timestamp} [${level}] ${stack || message}`
  )
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    new RingBufferTransport({ level: 'error' }),
    // בproduction — File transport עם rotation (מונע צמיחה בלתי מוגבלת של הדיסק)
    ...(process.env.NODE_ENV === 'production'
      ? [new winston.transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 10 * 1024 * 1024, maxFiles: 5 }),
         new winston.transports.File({ filename: 'logs/combined.log', maxsize: 10 * 1024 * 1024, maxFiles: 5 })]
      : []),
  ],
});

logger.getRecentErrorLog = getRecentErrorLog;

module.exports = logger;
