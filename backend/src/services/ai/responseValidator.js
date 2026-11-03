/**
 * Response Validator — Quality check layer for AI responses
 * Used after Grok responses to decide whether to fallback to Claude
 */

const VAGUE_PATTERNS = [
  /^(כן|לא|yes|no|ok|okay|sure|בסדר)\s*\.?\s*$/i,
  /אינני יכול|cannot|I can't|לא מסוגל|not able to/i,
  /אין לי מידע|no information|don't have access|אין לי גישה/i,
  /I apologize|מתנצל|sorry, (but|I)/i,
  /as an AI|כבינה מלאכותית/i,
];

const HEBREW_RATIO_THRESHOLD = 0.15; // at least 15% Hebrew chars for Hebrew queries

// ── Main validator ────────────────────────────────────────────
function validate(response, originalMessage) {
  const issues = [];

  if (!response || typeof response !== 'string') {
    return { quality: 'poor', issues: ['empty_response'], acceptable: false };
  }

  const text = response.trim();

  // 1. Length check
  if (text.length < 40) {
    issues.push('too_short');
  }

  // 2. Truncation check
  if (text.endsWith('...') || text.endsWith('—') || text.endsWith('-')) {
    issues.push('truncated');
  }

  // 3. Vague response check
  const vagueCount = VAGUE_PATTERNS.filter(p => p.test(text)).length;
  if (vagueCount >= 2) {
    issues.push('vague_response');
  }

  // 4. Language mismatch — if user wrote Hebrew but response is mostly English
  const hebrewChars   = (originalMessage.match(/[\u05D0-\u05EA]/g) || []).length;
  const isHebrewQuery = hebrewChars / originalMessage.length > 0.3;
  if (isHebrewQuery) {
    const responseHebrew = (text.match(/[\u05D0-\u05EA]/g) || []).length;
    if (responseHebrew / text.length < HEBREW_RATIO_THRESHOLD) {
      issues.push('language_mismatch');
    }
  }

  // 5. Error string in response
  if (/\berror\b|\bfailed\b|\bException\b/i.test(text) && text.length < 100) {
    issues.push('error_response');
  }

  // 6. Basic hallucination heuristic — very specific numbers not in original context
  // (simple check: if response claims exact currency amounts not mentioned by user)
  const suspiciousMonetary = text.match(/₪[\d,]+/g) || [];
  if (suspiciousMonetary.length > 5 && !originalMessage.includes('₪')) {
    issues.push('possible_hallucination');
  }

  // ── Quality verdict ───────────────────────────────────────
  const hasCritical = ['too_short', 'truncated', 'vague_response', 'error_response'].some(i => issues.includes(i));
  const quality = hasCritical ? 'poor' : issues.length > 0 ? 'acceptable' : 'good';

  return {
    quality,
    issues,
    acceptable: quality !== 'poor',
    score: quality === 'good' ? 1 : quality === 'acceptable' ? 0.6 : 0,
  };
}

module.exports = { validate };
