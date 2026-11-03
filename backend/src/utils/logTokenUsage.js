const db     = require('./db');
const logger = require('./logger');

// Prices are the published Anthropic API rates ($ per token). Haiku 4.5 was
// previously listed here at 0.80/4.00 — the real rate is 1.00/5.00, so every
// logged Haiku call (the bulk of them) was under-costed by ~20%. Corrected.
const MODEL_PRICES = {
  // Current generation — what the code calls today.
  'claude-haiku-4-5':          { input: 1.00 / 1_000_000, output: 5.00  / 1_000_000 },
  'claude-sonnet-5':           { input: 2.00 / 1_000_000, output: 10.00 / 1_000_000 },
  // Superseded IDs stay here so historical rows keep costing what they actually
  // cost. Sonnet 5 replaced Sonnet 4.6 at a LOWER rate ($3/$15 -> $2/$10), so
  // removing these would silently re-price the past upward.
  'claude-haiku-4-5-20251001': { input: 1.00 / 1_000_000, output: 5.00  / 1_000_000 },
  'claude-sonnet-4-6':         { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  'claude-sonnet-4-5':         { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  'llama-3.3-70b-versatile':   { input: 0,                output: 0                }, // Groq free tier
  'gemini-3.1-flash-lite':     { input: 0.25 / 1_000_000, output: 1.50  / 1_000_000 },
};

async function logTokenUsage({ businessId, userId = null, feature, model, usage }) {
  try {
    if (!MODEL_PRICES[model]) {
      logger.warn('[logTokenUsage] unknown model — cost estimate uses Haiku rates, will be inaccurate', { model, feature });
    }
    const prices       = MODEL_PRICES[model] ?? MODEL_PRICES['claude-haiku-4-5'];
    const inputTokens  = usage?.input_tokens  || 0;
    const outputTokens = usage?.output_tokens || 0;

    // Prompt-cache counters. These are the ONLY reliable way to know whether a
    // cache_control breakpoint actually took: a prompt shorter than the model's
    // minimum cacheable prefix is not cached, and the API reports no error for
    // it — cache_read stays 0 forever. businessAudit.agent.js already documents
    // its own breakpoint as inert for exactly that reason. Recording the
    // counters turns "we set cache_control" into something measurable.
    const cacheReadTokens  = usage?.cache_read_input_tokens     || 0;
    const cacheWriteTokens = usage?.cache_creation_input_tokens || 0;

    const totalTokens = inputTokens + outputTokens;

    // Cost intentionally charges cached input at the full input rate. Cache
    // reads are billed at a discount, so this over-states spend rather than
    // under-stating it — the safer direction for a budget alert, and it avoids
    // hard-coding a discount multiplier that varies by model.
    const costUsd = (inputTokens * prices.input) + (outputTokens * prices.output);

    await db.query(
      `INSERT INTO ai_usage_logs
         (business_id, user_id, feature, model, input_tokens, output_tokens,
          total_tokens, cost_usd, cache_read_tokens, cache_write_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [businessId || null, userId || null, feature, model,
       inputTokens, outputTokens, totalTokens, costUsd,
       cacheReadTokens, cacheWriteTokens]
    );
  } catch (err) {
    logger.error('[logTokenUsage] failed', { err: err.message });
  }
}

module.exports = { logTokenUsage, MODEL_PRICES };
