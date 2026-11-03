/**
 * Gemini Service — Google Gemini Flash-Lite integration (Tier 2)
 * Used when Groq free tier is insufficient but Claude premium not yet warranted
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// gemini-2.0-flash-exp (the previous model here) has been retired by Google —
// every call was failing with a 404. gemini-2.5-flash-lite (the natural
// "cheap tier" successor) is ALSO already retired for new API keys, so this
// codebase's Gemini tier had silently been down for a while. Verified live
// against the real API before picking this one — check periodically, this
// space moves fast. Pricing: $0.25 / $1.50 per 1M input/output tokens.
const MODEL_ID = 'gemini-3.1-flash-lite';
const COST_PER_INPUT_TOKEN  = 0.25 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 1.50 / 1_000_000;

let _genAI = null;
function _getClient() {
  if (!_genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY לא מוגדר ב-.env');
    _genAI = new GoogleGenerativeAI(key);
  }
  return _genAI;
}

async function chat(systemPrompt, messages, options = {}) {
  const genAI = _getClient();

  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    systemInstruction: systemPrompt,
  });

  // Convert to Gemini history format (all but last message)
  const history = messages.slice(0, -1).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }],
  }));

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) throw new Error('No messages provided');

  const session = model.startChat({
    history,
    generationConfig: {
      maxOutputTokens: options.maxTokens  || 1500,
      temperature:     options.temperature ?? 0.6,
      // Opt-in JSON mode for callers that need a parseable object back.
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
    },
  });

  const start  = Date.now();
  const result = await session.sendMessage(lastMsg.content || '');
  const responseTimeMs = Date.now() - start;

  if (!result?.response?.text) throw new Error('Unexpected Gemini response structure — possible content block');
  const text  = result.response.text();
  const usage = result.response.usageMetadata || {};

  const inputTokens  = usage.promptTokenCount      || 0;
  const outputTokens = usage.candidatesTokenCount  || 0;
  const totalTokens  = usage.totalTokenCount       || (inputTokens + outputTokens);
  const costUsd      = (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);

  // Why the response ended — MAX_TOKENS, SAFETY, STOP, … Callers that parse the
  // text need this to tell a truncated answer from a complete one; without it a
  // cut-off response looks exactly like a malformed one, and the caller has
  // nothing to log. (priceSearch had a truncation check that could never fire
  // on this provider because nothing here reported it.)
  const finishReason = result?.response?.candidates?.[0]?.finishReason ?? null;

  return {
    text,
    finishReason,
    model:         MODEL_ID,
    tokensUsed:    totalTokens,
    inputTokens,
    outputTokens,
    costUsd,
    responseTimeMs,
  };
}

module.exports = { chat };
