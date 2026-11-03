/**
 * Guardian AI Agent
 * Uses Claude to perform deep root-cause analysis on detected platform errors.
 * Returns a structured incident report with fix recommendations.
 */

const Anthropic      = require('@anthropic-ai/sdk');
const { createWithRetry } = require('../utils/anthropicRetry');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const geminiService  = require('../services/ai/geminiService');
const { scrubPII }   = require('../utils/aiSanitize');
const { logTokenUsage } = require('../utils/logTokenUsage');
const logger         = require('../utils/logger');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeWithGuardianAI(errorMessage, feature, severity, context = {}) {
  const safeError = String(errorMessage || '').replace(/[\r\n]/g, ' ').slice(0, 300);
  const safeStack = context.stack ? String(context.stack).replace(/[\r\n]/g, ' ').slice(0, 200) : null;
  const prompt = `שגיאה קריטית בפלטפורמה. החזר JSON בלבד:
{"root_cause_analysis":"","user_impact":"","recommended_fix":"","confidence_score":0.8,"recovery_actions":[]}

פיצ'ר: ${feature}
שגיאה: ${safeError}${safeStack ? `\n${safeStack}` : ''}

כתוב בעברית. קצר וטכני.`;

  let parsed = null;
  try {
    const gemRes = await geminiService.chat('', [{ role: 'user', content: prompt }], { maxTokens: 600 });
    const raw = gemRes.text?.trim() || '';
    const m = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim().match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    logTokenUsage({ businessId: null, feature: 'guardian_analyze', model: gemRes.model, usage: { input_tokens: gemRes.inputTokens, output_tokens: gemRes.outputTokens } });
  } catch (gemErr) {
    logger.warn('[Guardian] Gemini failed → Haiku fallback', { feature, err: gemErr.message });
    const response = await createWithRetry(client, {
      model:      'claude-haiku-4-5',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    }, { context: { agent: 'guardian', feature } });
    parsed = parseClaudeJSON(response, { agent: 'guardian', step: 'analyze', feature });
    // This platform scan runs unattended every 30 minutes and auto-triggers
    // an AI call for every new distinct error — unlike every other paid AI
    // agent in this codebase, it never logged usage, so this ongoing spend
    // never landed in ai_usage_logs (no cost dashboard visibility, no
    // per-incident audit trail).
    logTokenUsage({ businessId: null, feature: 'guardian_analyze', model: 'claude-haiku-4-5', usage: response.usage });
  }
  if (parsed?.root_cause_analysis || parsed?.recommended_fix) {
    return {
      root_cause_analysis: parsed.root_cause_analysis || null,
      user_impact:         parsed.user_impact         || null,
      recommended_fix:     parsed.recommended_fix     || null,
      confidence_score:    typeof parsed.confidence_score === 'number' ? parsed.confidence_score : 0.7,
      prediction_analysis: null,
      monitoring_actions:  [],
      recovery_actions:    Array.isArray(parsed.recovery_actions) ? parsed.recovery_actions.slice(0, 3) : [],
    };
  }
  return {
    root_cause_analysis: `שגיאה זוהתה: ${errorMessage}`,
    user_impact:         `הפיצ'ר "${feature}" עלול להיות מושפע`,
    recommended_fix:     'בדוק את הלוגים לפרטים נוספים',
    confidence_score:    0.5,
    prediction_analysis: null,
    monitoring_actions:  ['עקוב אחרי הלוגים'],
    recovery_actions:    ['הפעל מחדש את השרת אם הבעיה נמשכת'],
  };
}

async function fixIncidentWithAI(incident) {
  // issue_summary/technical_details are stored RAW in guardian_incidents (so
  // admins viewing the incident get full detail) — analyzeWithGuardianAI's
  // caller scrubs its own copy before that first AI call, but this function
  // reads straight back out of the DB and previously sent the unscrubbed
  // text (real customer emails, UUIDs, file paths from stack traces)
  // straight to Gemini/Claude on every "AI fix" click.
  const safeSummary  = scrubPII(incident.issue_summary);
  const safeDetails  = scrubPII(incident.technical_details);
  const safeRootCause = scrubPII(incident.root_cause_analysis);
  const prompt = `תקלה בפלטפורמה — צור תוכנית תיקון מפורטת. החזר JSON בלבד:
{"steps":[{"action":"","automated":false,"command":"","expected_result":""}],"summary":"","can_auto_fix":false,"risk_level":"low"}

פיצ'ר: ${incident.feature}
חומרה: ${incident.severity}
תקלה: ${safeSummary}
${safeDetails ? `פרטים: ${safeDetails.slice(0, 300)}` : ''}
${safeRootCause ? `סיבה שורשית: ${safeRootCause}` : ''}

כללים:
- steps: עד 5 צעדים ממוספרים, כל אחד קצר וטכני
- automated: true רק אם הצעד יכול להתבצע אוטומטית על ידי השרת (כמו בדיקת DB, ניקוי קאש)
- command: פקודה טכנית לביצוע (אם יש)
- can_auto_fix: true רק אם ניתן לפתור לחלוטין אוטומטית
- risk_level: low/medium/high
כתוב בעברית. ממוקד.`;

  let parsed = null;
  try {
    const gemRes = await geminiService.chat('', [{ role: 'user', content: prompt }], { maxTokens: 700 });
    const raw = gemRes.text?.trim() || '';
    const m = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim().match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    logTokenUsage({ businessId: null, feature: 'guardian_fix', model: gemRes.model, usage: { input_tokens: gemRes.inputTokens, output_tokens: gemRes.outputTokens } });
  } catch (gemErr) {
    logger.warn('[Guardian] Gemini failed → Haiku fallback', { feature: incident.feature, err: gemErr.message });
    const response = await createWithRetry(client, {
      model:      'claude-haiku-4-5',
      max_tokens: 700,
      messages:   [{ role: 'user', content: prompt }],
    }, { context: { agent: 'guardian', feature: incident.feature } });
    parsed = parseClaudeJSON(response, { agent: 'guardian', step: 'fixIncident', feature: incident.feature });
    logTokenUsage({ businessId: null, feature: 'guardian_fix', model: 'claude-haiku-4-5', usage: response.usage });
  }
  if (parsed?.steps || parsed?.summary) {
    return {
      steps:         Array.isArray(parsed.steps) ? parsed.steps.slice(0, 5) : [],
      summary:       parsed.summary       || 'תוכנית תיקון נוצרה',
      can_auto_fix:  !!parsed.can_auto_fix,
      risk_level:    parsed.risk_level    || 'low',
    };
  }
  return {
    steps:        [{ action: 'בדוק את הלוגים ואתחל את השרת אם הבעיה נמשכת', automated: false, command: 'pm2 restart hob-backend', expected_result: 'שרת פועל תקין' }],
    summary:      'בעיה זוהתה — בצע תיקון ידני',
    can_auto_fix: false,
    risk_level:   'medium',
  };
}

module.exports = { analyzeWithGuardianAI, fixIncidentWithAI };
