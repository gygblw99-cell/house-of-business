/**
 * Scoring Engine — Multi-factor AI routing algorithm
 * Decides score for each request to route between Grok (cheap) and Claude (quality)
 */

// ── Keyword banks ─────────────────────────────────────────────
const DEEP_ANALYSIS_KW   = /נתח|ניתוח|תחזית|forecast|predict|analyz|decision|החלטה|אסטרטג|strategic|trend|מגמ|correlation|קשר בין|השוואה|compare|benchmark/i;
const MULTI_STEP_KW      = /מדוע|למה|why|how|איך|כיצד|impact|השפעה|pattern|דפוס|optimize|אופטימיז/i;
const SUMMARY_KW         = /סכם|סיכום|summary|explain|הסבר|describe|תאר/i;
// הכנס (not הכנסה) — the root without the singular suffix, so it also
// matches plural/inflected forms like הכנסות, הכנסתי (the ה...ה form only
// matched the exact singular "הכנסה" and silently missed "מה ההכנסות היום?").
const FINANCIAL_KW       = /פיננס|finance|רווח|profit|הפסד|loss|שכר|salary|budget|תקציב|invoice|חשבונית|עלות|cost|revenue|הכנס|ROI|תשואה/i;
const OPERATIONAL_KW     = /ספק|supplier|מלאי|inventory|עובד|employee|מכירות|sales|משמרת|shift|לקוח|customer/i;
const WEB_SEARCH_KW      = /מחיר שוק|מחירי שוק|market price|מגמות שוק|חוק|תקנה|regulation|חדשות|news|עדכון|update|מה קורה|מה נאמר|what is happening|industry/i;
const TOOL_LIKELY_KW     = /חפש באינטרנט|search online|find online|look up/i;
// Signals that a question likely needs the get_business_data tool (aiAdvisor.agent.js) —
// an identifier- or arbitrary-period-scoped DB lookup NOT already baked into
// business.context.js's static snapshot. Groq/Gemini never receive that tool
// at all (grokService.js/geminiService.js take no `tools` param), and
// responseValidator.js only checks surface quality — nothing fact-checks a
// fluent answer against real data — so a question matching this bank must be
// forced to Claude (which has the tool) rather than risk a confident,
// well-formatted, but fabricated number from a cheaper tier.
const BUSINESS_DATA_KW   = /רווחיות של|כמה עולה לי|מחיר.*ספק|ספק.*מחיר|לקוחות חוזרים|החזרת.*לקוחות|שימור לקוחות|customer retention|לקוחות מובילים|top customers|תחזית|forecast|השווה|לעומת חודש|compare.*month|כמה שעות עבד|תזרים מזומנים|cash ?flow/i;

// ── 1. Prompt Length Score (0–20) ─────────────────────────────
function _promptLengthScore(message) {
  const len = message.length;
  if (len < 100)  return 5;
  if (len < 500)  return 10;
  if (len < 1500) return 15;
  return 20;
}

// ── 2. Context Complexity Score (0–20) ────────────────────────
// Based on conversation history depth + entities in message
function _contextComplexityScore(message, historyLength) {
  let score = 0;
  // history depth
  if (historyLength === 0)      score += 5;
  else if (historyLength < 6)   score += 10;
  else                          score += 15;

  // entity count heuristic (numbers, names, references)
  const entities = (message.match(/\d+|₪|%|[א-ת]{4,}/g) || []).length;
  if (entities > 10) score += 5;

  return Math.min(20, score);
}

// ── 3. Reasoning Depth Score (0–25) ──────────────────────────
function _reasoningDepthScore(message) {
  if (DEEP_ANALYSIS_KW.test(message)) return 25;
  if (MULTI_STEP_KW.test(message))    return 20;
  if (SUMMARY_KW.test(message))       return 10;
  return 5; // basic Q&A
}

// ── 4. Business Criticality Score (0–20) ─────────────────────
function _businessCriticalityScore(message) {
  if (FINANCIAL_KW.test(message))    return 20;
  if (OPERATIONAL_KW.test(message))  return 10;
  return 5;
}

// ── 5. User Tier Modifier (-5 to +10) ────────────────────────
function _userTierModifier(role) {
  const map = { owner: 10, partner: 10, manager: 0, employee: -5 };
  return map[role] ?? 0;
}

// ── 6. Historical Feedback Score (0–10) ──────────────────────
function _historicalFeedbackScore(recentGrokFailures) {
  return Math.min(10, (recentGrokFailures || 0) * 5);
}

// ── Tool need detection ───────────────────────────────────────
function likelyNeedsTools(message) {
  return WEB_SEARCH_KW.test(message) || TOOL_LIKELY_KW.test(message) || BUSINESS_DATA_KW.test(message);
}

// True when a question is plausibly about this business's own current data —
// used to gate aiAdvisor.agent.js's generic-response cache. That cache used
// to key off "no tool was called", but Groq/Gemini never call tools at all
// (they don't receive the tools array), so a live-data question they happen
// to answer straight from the static context snapshot (e.g. "מה ההכנסות
// היום?") looked identical to a timeless knowledge question and got cached
// for an hour — serving a stale answer the next time the same phrasing was
// asked, even after real sales/data changed in between.
function looksDataDependent(message) {
  return FINANCIAL_KW.test(message) || OPERATIONAL_KW.test(message) || likelyNeedsTools(message);
}

// ── Main scorer ───────────────────────────────────────────────
const MAX_SCORE_MSG_LEN = 5000;

function score(params) {
  const {
    historyLength   = 0,
    userRole        = 'employee',
    recentGrokFails = 0,
  } = params;
  // חיתוך הודעה ארוכה לפני regex — מונע עומס על event loop
  const message = (params.message || '').slice(0, MAX_SCORE_MSG_LEN);

  const breakdown = {
    promptLength:      _promptLengthScore(message),
    contextComplexity: _contextComplexityScore(message, historyLength),
    reasoningDepth:    _reasoningDepthScore(message),
    businessCriticality: _businessCriticalityScore(message),
    userTierModifier:  _userTierModifier(userRole),
    historicalFeedback: _historicalFeedbackScore(recentGrokFails),
  };

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  let provider;
  let reason;
  if (likelyNeedsTools(message)) {
    provider = 'claude';
    reason   = 'tool_use_required';
  } else if (total <= 35) {
    provider = 'grok';
    reason   = 'simple_request';
  } else if (total <= 60) {
    provider = 'grok_with_fallback';
    reason   = 'moderate_request';
  } else {
    provider = 'claude';
    reason   = 'complex_request';
  }

  return { total, breakdown, provider, reason };
}

module.exports = { score, likelyNeedsTools, looksDataDependent };
