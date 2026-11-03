/**
 * Anthropic call wrapper — retries once on a transient overload (529/503/429)
 * before giving up. Same pattern already proven in zreport.import.service.js's
 * AI fallback parser; extracted here so every agent gets it instead of only
 * the one call site that happened to have it hand-rolled.
 */
const logger = require('./logger');

async function createWithRetry(client, params, { retries = 1, delayMs = 2000, context = {}, requestOptions } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return requestOptions
        ? await client.messages.create(params, requestOptions)
        : await client.messages.create(params);
    } catch (err) {
      const overloaded = err.status === 529 || err.status === 503 || err.status === 429;
      if (attempt < retries && overloaded) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      logger.error('[AnthropicRetry] call failed', { err: err.message, status: err.status, attempt, ...context });
      throw err;
    }
  }
}

module.exports = { createWithRetry };
