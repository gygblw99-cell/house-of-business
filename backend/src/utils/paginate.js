'use strict';

/**
 * Shared pagination utility.
 *
 * Usage in a route:
 *   const { limit, offset, paginate } = parsePage(req.query);
 *   const { rows } = await db.query(`SELECT ... LIMIT $1 OFFSET $2`, [limit, offset]);
 *   const total = rows[0]?.total_count ?? 0;
 *   res.json(paginate(rows, total));
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

/**
 * Parse pagination params from query string.
 * @returns {{ limit: number, offset: number, page: number, paginate: Function }}
 */
function parsePage(query = {}) {
  const page   = Math.max(1, parseInt(query.page)  || 1);
  const limit  = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit) || DEFAULT_LIMIT));
  const offset = (page - 1) * limit;

  /**
   * Build a standard paginated response envelope.
   * @param {Array}  rows  — the result rows (may include a `total_count` column)
   * @param {number} total — total matching rows (pass explicitly or read from rows[0].total_count)
   */
  function paginate(rows, total) {
    const count = total ?? (rows[0]?.total_count ? parseInt(rows[0].total_count) : rows.length);
    // Strip synthetic total_count column from each row before returning
    const data = rows.map(r => {
      if ('total_count' in r) {
        const { total_count, ...rest } = r;
        return rest;
      }
      return r;
    });
    return {
      data,
      meta: {
        total:       count,
        page,
        limit,
        totalPages:  Math.ceil(count / limit),
        hasNextPage: offset + limit < count,
        hasPrevPage: page > 1,
      },
    };
  }

  return { limit, offset, page, paginate };
}

module.exports = { parsePage, DEFAULT_LIMIT, MAX_LIMIT };
