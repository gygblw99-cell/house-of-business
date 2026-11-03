'use strict';

const db = require('./db');

/**
 * Runs `fn(client)` inside a BEGIN/COMMIT block.
 * Automatically ROLLBACKs and re-throws on any error.
 * The caller receives whatever `fn` returns.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('UPDATE ...');
 *     await client.query('INSERT ...');
 *     return someValue;
 *   });
 */
async function withTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
