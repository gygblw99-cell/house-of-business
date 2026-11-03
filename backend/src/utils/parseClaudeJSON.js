/**
 * Extracts and parses JSON out of a Claude text response.
 * Handles markdown code fences, bare JSON, and JSON embedded in surrounding
 * prose. Also warns when stop_reason === 'max_tokens' — a truncated response
 * silently parses to nothing or the wrong shape, which was found and fixed
 * twice this session (weekly report Agent 3, price-comparison search) as two
 * separate hand-rolled parsers before being unified here.
 *
 * Returns the parsed value, or null if nothing parseable was found — callers
 * decide their own fallback value, since that's feature-specific.
 */
const logger = require('./logger');

function parseClaudeJSON(response, context = {}) {
  if (response?.stop_reason === 'max_tokens') {
    logger.warn('[parseClaudeJSON] response truncated at max_tokens', context);
  }

  const text = response?.content?.find(b => b.type === 'text')?.text
    ?? response?.content?.[0]?.text
    ?? '';
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch { /* fall through to bracket-matching */ }

  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  const match = objMatch || arrMatch;
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* give up below */ }
  }

  logger.warn('[parseClaudeJSON] failed to parse JSON from response', { preview: text.slice(0, 200), ...context });
  return null;
}

module.exports = { parseClaudeJSON };
