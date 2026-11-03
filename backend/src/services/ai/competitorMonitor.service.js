/**
 * Competitor Menu Price Monitor
 *
 * רץ פעם בשבוע (ראשון 06:00) — מנתח מחירי מתחרים לעומת מחירי העסק
 * ומייצר התראות כשמתחרה זול ביותר מ-15% על מנה דומה.
 *
 * Flow:
 *  1. שואב מנות העסק עם מחיריהן
 *  2. שואב רשימת מתחרים (שמות + URLs) מהגדרות העסק
 *  3. לכל מתחרה — scrape עמוד תפריט (regex חיפוש מחירים)
 *  4. Claude מנתח ומוצא פערי מחיר משמעותיים
 *  5. שומר ב-DB + שולח התראה לבעל העסק
 */

const db            = require('../../utils/db');
const logger        = require('../../utils/logger');
const Anthropic     = require('@anthropic-ai/sdk');
const geminiService = require('./geminiService');
const https     = require('https');
const http      = require('http');
const { ssrfSafeIp } = require('../../utils/ssrfGuard');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { createWithRetry } = require('../../utils/anthropicRetry');
const { logTokenUsage }   = require('../../utils/logTokenUsage');
const { ACTIVE_BUSINESS_SQL } = require('../../utils/activeBusiness');
const { locked } = require('../../utils/jobLock');
const { withTimeout } = require('../../utils/withTimeout');
const PRICE_GAP_THRESHOLD = 0.15; // התראה אם מתחרה זול ב-15%+

// ── DB migration — create table on first use ─────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS competitor_price_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL,
    competitor_name TEXT NOT NULL,
    competitor_url  TEXT,
    our_dish        TEXT NOT NULL,
    our_price       NUMERIC(10,2),
    their_price     NUMERIC(10,2),
    price_gap_pct   NUMERIC(5,1),
    raw_context     TEXT,
    scanned_at      TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_biz
  ON competitor_price_snapshots (business_id, scanned_at DESC)`);

// ── Fetch page with redirect follow + timeout ─────────────────
// competitor.url is owner-controlled JSONB (business settings) — validated
// and IP-pinned the same way priceComparison.routes.js's extract-email does,
// otherwise an owner could point a "competitor URL" at an internal/cloud
// metadata address and have the server fetch it on their behalf.
async function fetchPage(pageUrl, timeoutMs = 8000, depth = 0) {
  if (depth > 1) return '';
  const safeIp = await ssrfSafeIp(pageUrl);
  if (!safeIp) return '';
  let parsedUrl;
  try { parsedUrl = new URL(pageUrl); } catch { return ''; }
  return new Promise((resolve) => {
    try {
      const mod  = parsedUrl.protocol === 'https:' ? https : http;
      const req2 = mod.get({
        hostname: safeIp,
        port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path:     `${parsedUrl.pathname}${parsedUrl.search}`,
        // TLS SNI/cert validation and virtual-hosting still target the real
        // hostname — only the DNS resolution itself is pinned to the IP.
        servername: parsedUrl.hostname,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HobBot/1.0; +https://hob.ai)', Host: parsedUrl.hostname },
        timeout: timeoutMs,
      }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth === 0) {
          return fetchPage(r.headers.location, timeoutMs, depth + 1).then(resolve).catch(() => resolve(''));
        }
        let data = '';
        r.setEncoding('utf8');
        r.on('data', c => { if (data.length < 200_000) data += c; });
        r.on('end', () => resolve(data));
      });
      req2.on('error', () => resolve(''));
      req2.on('timeout', () => { req2.destroy(); resolve(''); });
    } catch { resolve(''); }
  });
}

// ── Strip HTML to plain text (very lightweight) ───────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 8000); // keep only first 8k chars for Claude
}

// ── Analyze one competitor vs our menu using Claude ───────────
async function _analyzeCompetitor(businessId, ourDishes, competitor) {
  const { name: competitorName, url: competitorUrl } = competitor;

  if (!competitorUrl) return [];

  const html = await fetchPage(competitorUrl);
  if (!html || html.length < 100) {
    logger.warn('[CompetitorMonitor] could not fetch page', { competitorName, competitorUrl });
    return [];
  }

  const pageText = stripHtml(html);

  const ourDishList = ourDishes
    .filter(d => d.selling_price > 0)
    .map(d => `- ${d.name}: ₪${d.selling_price}`)
    .join('\n');

  let analysisText = '';
  try {
    const competitorPrompt = `אתה מנתח מחירי מסעדות בישראל.

המנות שלנו:
${ourDishList}

תוכן תפריט המתחרה "${competitorName}":
${pageText}

בדוק אם המתחרה מוכר מנות דומות. לכל מנה דומה שמצאת — ציין:
1. שם המנה שלנו
2. המחיר שלנו
3. שם המנה המקבילה אצל המתחרה
4. המחיר אצל המתחרה (אם נמצא בטקסט)
5. הפרש % (חיובי = המתחרה יקר יותר, שלילי = המתחרה זול יותר)

ענה ב-JSON בלבד, ללא הסברים:
{
  "comparisons": [
    { "our_dish": "", "our_price": 0, "their_dish": "", "their_price": 0, "gap_pct": 0 }
  ]
}
אם אין מחירים בטקסט, החזר { "comparisons": [] }`;

    let raw;
    try {
      const gemRes = await withTimeout(
    geminiService.chat('', [{ role: 'user', content: competitorPrompt }], { maxTokens: 1000 }),
    20_000, "timeout");
      raw = gemRes.text || '{}';
    } catch {
      const haikuRes = await createWithRetry(anthropic, {
        model:      'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: competitorPrompt }],
      }, { context: { agent: 'competitorMonitor', businessId, competitorName } });
      logTokenUsage({ businessId, feature: 'competitor_monitor', model: 'claude-haiku-4-5', usage: haikuRes.usage });
      raw = haikuRes.content[0]?.text || '{}';
    }
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    analysisText = raw;

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      logger.warn('[CompetitorMonitor] Claude JSON parse failed', { competitorName, err: parseErr.message, preview: clean.slice(0, 120) });
      return [];
    }

    return (parsed.comparisons || [])
      .filter(c => c.their_price > 0 && c.our_price > 0)
      .map(c => ({
        ...c,
        gap_pct: parseFloat(c.gap_pct) || parseFloat(((c.their_price - c.our_price) / c.our_price * 100).toFixed(1)),
        competitor_name: competitorName,
        competitor_url:  competitorUrl,
        raw_context:     analysisText.slice(0, 500),
      }));
  } catch (err) {
    logger.warn('[CompetitorMonitor] Claude error', { competitorName, err: err.message });
    return [];
  }
}

// ── Main scan — called by weekly scheduler ────────────────────
async function runCompetitorScan(businessId) {
  logger.info('[CompetitorMonitor] starting scan', { businessId });

  // שואב מנות + מחירים
  const { rows: ourDishes } = await db.query(`
    SELECT name, selling_price FROM recipes
    WHERE business_id = $1 AND selling_price > 0
    ORDER BY selling_price DESC
    LIMIT 30
  `, [businessId]).catch(() => ({ rows: [] }));

  if (!ourDishes.length) return { scanned: 0, alerts: 0 };

  // שואב מתחרים מהגדרות העסק (שדה JSONB: competitors: [{name, url}])
  const { rows: bizRows } = await db.query(
    `SELECT settings->'competitors' AS competitors, name FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  const competitors = bizRows[0]?.competitors;
  if (!Array.isArray(competitors) || competitors.length === 0) {
    logger.info('[CompetitorMonitor] no competitors configured', { businessId });
    return { scanned: 0, alerts: 0 };
  }

  let totalAlerts = 0;

  for (const competitor of competitors.slice(0, 5)) { // max 5 competitors per scan
    const comparisons = await _analyzeCompetitor(businessId, ourDishes, competitor);

    const alertComparisons = comparisons.filter(c => c.gap_pct <= -(PRICE_GAP_THRESHOLD * 100));

    if (comparisons.length > 0) {
      // Save snapshot
      const vals   = [];
      const params = [];
      comparisons.forEach((c, i) => {
        const base = i * 7;
        vals.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`);
        params.push(businessId, c.competitor_name, c.competitor_url, c.our_dish, c.our_price, c.their_price, c.gap_pct);
      });
      await db.query(
        `INSERT INTO competitor_price_snapshots (business_id, competitor_name, competitor_url, our_dish, our_price, their_price, price_gap_pct) VALUES ${vals.join(',')}`,
        params
      ).catch(() => {});
    }

    // Create notification for significant gaps
    if (alertComparisons.length > 0) {
      const lines = alertComparisons
        .slice(0, 3)
        .map(c => `• ${c.our_dish}: שלנו ₪${c.our_price} | ${c.competitor_name} ₪${c.their_price} (${Math.abs(c.gap_pct)}% זול יותר)`)
        .join('\n');

      // notifications has no `data` column — this INSERT threw on every call
      // (caught by the bare .catch below, with zero logging) and never
      // persisted a single competitor_alert. Also resolves an owner/partner
      // user_id: GET /notifications requires user_id = $1, so a NULL user_id
      // row (the other half of this bug) would still be invisible even once
      // the INSERT itself stopped failing.
      await db.query(
        `INSERT INTO notifications (business_id, user_id, type, title, body)
         SELECT $1, u.id, 'competitor_alert', $2, $3
         FROM users u
         WHERE u.business_id = $1 AND u.role IN ('owner','partner') AND u.is_active = TRUE
         LIMIT 1`,
        [
          businessId,
          `מחירי מתחרה: ${competitor.name} זול יותר`,
          lines,
        ]
      ).catch(e => logger.warn('[CompetitorMonitor] Failed to write notification', { err: e.message }));

      totalAlerts += alertComparisons.length;
    }
  }

  logger.info('[CompetitorMonitor] scan complete', { businessId, alerts: totalAlerts });
  return { scanned: competitors.length, alerts: totalAlerts };
}

// ── Weekly scheduler — runs every Sunday 06:00 ───────────────
function startCompetitorMonitorScheduler() {
  function msUntilSunday6am() {
    const now  = new Date();
    const next = new Date();
    // Set to next Sunday
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    next.setDate(now.getDate() + daysUntilSunday);
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 7);
    return next - now;
  }

  const runAll = async () => {
    try {
      const { rows } = await db.query(`SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL}`);
      for (const { id } of rows) {
        await _runCompetitorScanLocked(id).catch(err =>
          logger.error('[CompetitorMonitor] scan failed', { id, err: err.message })
        );
        await new Promise(r => setTimeout(r, 2000)); // 2s between businesses
      }
    } catch (err) {
      logger.error('[CompetitorMonitor] weekly run failed', { err: err.message });
    }
  };

  setTimeout(() => {
    runAll();
    setInterval(runAll, 7 * 24 * 60 * 60_000).unref();
  }, msUntilSunday6am());

  logger.info('[CompetitorMonitor] Scheduler started — weekly scan every Sunday 06:00');
}


// Scheduled runs only. The export above stays unlocked so an admin "run now"
// and the tests still execute directly; a second replica would otherwise fire
// this job twice on every tick (see utils/jobLock.js).
const _runCompetitorScanLocked = locked('competitor-scan', runCompetitorScan);
module.exports = { startCompetitorMonitorScheduler, runCompetitorScan };
