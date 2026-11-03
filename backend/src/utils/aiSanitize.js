'use strict';

// Shared prompt-injection detection patterns.
// Import this wherever AI input/output sanitization is needed so updates
// to the pattern list take effect everywhere simultaneously.
const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|prior|all)\s+instructions?/i,
  /system\s*:/i,
  /\bpretend\s+you\s+are\b/i,
  /\bact\s+as\b/i,
  /\byou\s+are\s+now\b/i,
  /\bforget\s+everything\b/i,
  /\bdo\s+not\s+follow\b/i,
  /<\s*script/i,
  /\[INST\]/i,
  /###\s*(System|Human|Assistant)/i,
];

function containsInjection(value) {
  if (typeof value !== 'string') return false;
  return INJECTION_PATTERNS.some(re => re.test(value));
}

function sanitizeField(value, maxLen = 200) {
  if (typeof value !== 'string') return value;
  if (containsInjection(value)) return '[REDACTED]';
  return value.length > maxLen ? value.substring(0, maxLen) + '…' : value;
}

// arrayCap defaults to 20 for user-provided data (prevents token flooding).
// Pass Infinity when sanitizing AI-generated output that must not lose items (e.g. OCR results).
function sanitizeObject(obj, maxLen = 200, arrayCap = 20) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.slice(0, arrayCap).map(item => sanitizeObject(item, maxLen, arrayCap)).filter(v => v !== undefined);
  if (typeof obj !== 'object') {
    return typeof obj === 'string' ? sanitizeField(obj, maxLen) : obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const sanitized = sanitizeObject(v, maxLen, arrayCap);
    if (sanitized !== undefined) out[k] = sanitized;
  }
  return out;
}

// Sanitizes AI-generated output: truncates strings, but NEVER replaces with [REDACTED].
// Use on model responses — patterns like /system\s*:/i produce false positives on
// legitimate Hebrew names (e.g. "מערכת: אזעקה") that must reach the DB intact.
function sanitizeAIOutput(obj, maxLen = 300) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeAIOutput(item, maxLen));
  if (typeof obj !== 'object') {
    return typeof obj === 'string'
      ? (obj.length > maxLen ? obj.substring(0, maxLen) + '…' : obj)
      : obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeAIOutput(v, maxLen);
  }
  return out;
}

// Strips PII/secrets (UUIDs, emails, phone numbers, file paths) before text
// reaches an external AI provider. Originally private to guardian.service.js
// (as scrubForAI) — moved here so guardian.agent.js can also apply it to
// data it reads back out of the DB (issue_summary/technical_details), which
// previously bypassed this scrub entirely on the "AI fix" call path.
function scrubPII(text) {
  if (!text) return text;
  return String(text)
    .replace(/[\r\n]/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[UUID]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b05\d{8}\b/g, '[PHONE]')
    .replace(/\/[a-zA-Z0-9_/-]{10,}/g, '[PATH]')
    .slice(0, 500);
}

module.exports = { INJECTION_PATTERNS, containsInjection, sanitizeField, sanitizeObject, sanitizeAIOutput, scrubPII };
