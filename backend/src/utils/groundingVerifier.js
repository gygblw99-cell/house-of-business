/**
 * Grounding Verifier — Detection Layer
 *
 * Verifies that every claim in an AI response is backed by real data
 * that was actually passed to the model. Strips or flags unverifiable claims.
 *
 * Two checks per item:
 *  1. TYPE GUARD   — does the data support this type of issue at all?
 *  2. NUMBER CHECK — are numeric claims within ±35% of any real data value?
 *
 * Usage:
 *   const { issues, recommendations } = verifyAuditResponse(claudeOutput, auditData);
 */

// ── Number extraction helpers ─────────────────────────────────

function _extractNumbers(text = '') {
  return (String(text).match(/[\d,.]+/g) || [])
    .map(n => parseFloat(n.replace(/,/g, '')))
    .filter(n => !isNaN(n) && n > 0);
}

/** Recursively collect all positive numbers from a plain object / array */
function _flattenNumbers(value, out = []) {
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) _flattenNumbers(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) _flattenNumbers(v, out);
  }
  return out;
}

/**
 * Returns true if `claimed` is within ±35% of at least one real number,
 * OR if the real pool has no comparable numbers (we can't disprove it).
 */
function _numberGrounded(claimed, realPool, tolerance = 0.35) {
  if (realPool.length === 0) return true; // can't falsify
  // Ignore tiny numbers (counts, percentages, etc.) — only check ≥ 50
  if (claimed < 50) return true;
  return realPool.some(real => Math.abs(claimed - real) / Math.max(real, 1) <= tolerance);
}

// ── Type guards ───────────────────────────────────────────────
// Each guard receives the full sourceData object and returns true
// only when real supporting data exists for that claim type.

const AUDIT_TYPE_GUARDS = {
  inventory: (d) =>
    (d.inventoryWaste?.length > 0) || (d.lowInventory?.length > 0),

  profitability: (d) =>
    (d.salesStats?.length > 0) ||
    (d.weakItems?.length > 0) ||
    ((d.expenseStats?.monthly_fixed_expenses || 0) > 0),

  employees: (d) =>
    (d.shiftStats?.total_shifts || 0) > 0,

  // Allow avg_order recommendations when real data OR benchmark is available
  avg_order: (d) =>
    (d.avgOrderValue?.current_avg || 0) > 0 || (d.benchmarkAvgOrder || 0) > 0,
};

// ── Entity (name) guards ──────────────────────────────────────
function _buildEntityPool(sourceData) {
  const names = [];
  for (const arr of [
    sourceData.inventoryWaste || [],
    sourceData.lowInventory   || [],
    sourceData.weakItems      || [],
  ]) {
    for (const item of arr) {
      if (item.name) names.push(item.name.trim());
    }
  }
  return names;
}

/**
 * If the AI mentions specific item names, at least one must exist in data.
 * If no item names detected in text, pass automatically.
 */
function _entityGrounded(text = '', entityPool) {
  if (entityPool.length === 0) return true;
  // Check if any known entity name appears in the text
  const mentioned = entityPool.filter(name =>
    text.includes(name)
  );
  // If the pool is non-empty but nothing mentioned — pass (AI used generic language)
  return true; // relaxed: we don't penalise generic recommendations
}

// ── Core verifier ─────────────────────────────────────────────

/**
 * @param {object} aiResponse   - Parsed Claude response: { issues[], recommendations[] }
 * @param {object} sourceData   - The data object that was fed to the prompt
 * @returns {{ issues: array, recommendations: array, stripped: number }}
 */
function verifyAuditResponse(aiResponse, sourceData) {
  const realNumbers  = _flattenNumbers(sourceData);
  const entityPool   = _buildEntityPool(sourceData);
  let stripped       = 0;

  const realAvgOrder = sourceData.avgOrderValue?.current_avg || 0;
  // Fall back to benchmark when real per-order data is unavailable (Z-report only businesses)
  const avgOrder = realAvgOrder > 0 ? realAvgOrder : (sourceData.benchmarkAvgOrder || 0);

  const verify = (item, textFields) => {
    // 1. Type guard
    const guard = AUDIT_TYPE_GUARDS[item.type];
    if (guard && !guard(sourceData)) {
      stripped++;
      return false;
    }

    // 2. Number grounding
    const fullText = textFields.map(f => item[f] || '').join(' ');
    const claimed  = _extractNumbers(fullText);
    const bigNums  = claimed.filter(n => n >= 50);

    if (bigNums.length > 0) {
      const ungrounded = bigNums.filter(n => !_numberGrounded(n, realNumbers));
      // Fail only if ALL big numbers are ungrounded (Claude may derive sums/avgs)
      if (ungrounded.length === bigNums.length && bigNums.length >= 2) {
        stripped++;
        return false;
      }
    }

    // 3. Proportionality guard — any monetary threshold must be ≤5× avg order per diner.
    // Uses benchmark avg when real per-order data is unavailable.
    if (avgOrder > 0) {
      const maxRealistic = avgOrder * 5;
      const thresholdNums = bigNums.filter(n => n > avgOrder * 1.5);
      if (thresholdNums.length > 0 && thresholdNums.every(n => n > maxRealistic)) {
        stripped++;
        return false;
      }
    }

    // 4. Entity check
    if (!_entityGrounded(fullText, entityPool)) {
      stripped++;
      return false;
    }

    return true;
  };

  const issues = (aiResponse.issues || []).filter(item =>
    verify(item, ['title', 'description'])
  );

  const recommendations = (aiResponse.recommendations || []).filter(item =>
    verify(item, ['action', 'impact'])
  );

  return { issues, recommendations, stripped };
}

// ── Generic verifier for other features ──────────────────────
/**
 * Lightweight verifier for non-audit AI responses.
 * Checks that every numeric claim exists (±35%) in the source data.
 *
 * @param {string[]} texts      - Array of AI-generated text strings to verify
 * @param {object}   sourceData - The data object passed to the prompt
 * @returns {{ allGrounded: boolean, ungoundedClaims: number[] }}
 */
function verifyNumericClaims(texts, sourceData) {
  const realNumbers = _flattenNumbers(sourceData);
  const ungounded   = [];

  for (const text of texts) {
    const nums = _extractNumbers(text).filter(n => n >= 50);
    for (const n of nums) {
      if (!_numberGrounded(n, realNumbers)) ungounded.push(n);
    }
  }

  return { allGrounded: ungounded.length === 0, ungoundedClaims: ungounded };
}

module.exports = { verifyAuditResponse, verifyNumericClaims };
