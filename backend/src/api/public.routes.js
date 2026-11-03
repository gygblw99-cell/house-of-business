const express = require('express');
const router  = require('express').Router();
const db      = require('../utils/db');
const cache   = require('../utils/cache');
const logger  = require('../utils/logger');

const CACHE_KEY = 'public:stats';
const CACHE_TTL = 3600;

async function triggerWebsiteRevalidation() {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) return;
  const base = process.env.WEBSITE_URL || 'http://localhost:4000';
  try {
    await fetch(`${base}/api/revalidate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret }),
      signal:  AbortSignal.timeout(3000),
    });
  } catch { /* non-critical — website will revalidate on schedule */ }
}

// GET /api/public/stats — no auth, for marketing website ISR
router.get('/stats', async (_req, res) => {
  try {
    const cached = await cache.get(CACHE_KEY);

    if (cached) {
      res.set('Cache-Control', `public, max-age=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL * 2}`);
      return res.json(cached);
    }

    // Cache miss — fetch fresh data then trigger website revalidation.
    // Customer count is deliberately not queried or returned: it was pulled
    // from the marketing site's hero stats because a low number reads badly,
    // and an unauthenticated endpoint shouldn't keep publishing it anyway.
    const [salesCount, aiCount] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS cnt FROM sales WHERE sold_at >= NOW() - INTERVAL '30 days' AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')`),
      db.query(`SELECT COUNT(*)::int AS cnt FROM ai_usage_logs WHERE created_at >= NOW() - INTERVAL '30 days'`),
    ]);

    const data = {
      sales_last_30d:    salesCount.rows[0].cnt,
      ai_calls_last_30d: aiCount.rows[0].cnt,
      updated_at:        new Date().toISOString(),
    };

    await cache.set(CACHE_KEY, data, CACHE_TTL);

    // Fire-and-forget: tell the marketing site to revalidate its ISR page
    setImmediate(() => triggerWebsiteRevalidation());

    res.set('Cache-Control', `public, max-age=${CACHE_TTL}, stale-while-revalidate=${CACHE_TTL * 2}`);
    res.json(data);
  } catch (err) {
    logger.error('[PublicAPI] /stats error', { err: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
