const https     = require('https');
const Anthropic     = require('@anthropic-ai/sdk');
const logger        = require('../../utils/logger');
const geminiService = require('../ai/geminiService');
const cache         = require('../../utils/cache');
const { sanitizeField } = require('../../utils/aiSanitize');
const { parseClaudeJSON } = require('../../utils/parseClaudeJSON');
const { logTokenUsage }   = require('../../utils/logTokenUsage');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Wholesale food prices don't move within a day, and SerpAPI quota is the
// binding constraint on this feature — see the budget note in searchPrice().
const SERP_CACHE_TTL_SECONDS = 24 * 60 * 60;

// Links surfaced by the AI are rendered straight into href attributes by the
// UI. The AI's own input is third-party web content, so an attacker-influenced
// `javascript:` URL is reachable in principle — allow only real web URLs.
function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
  } catch { return ''; }
}

// ── Helper: SerpAPI search ────────────────────────────────────
const MAX_SERP_RESPONSE_BYTES = 500_000;

function serpSearch(query, params = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({
      q: query,
      api_key: process.env.SERP_API_KEY,
      hl: 'iw',
      gl: 'il',
      num: '10',
      ...params,
    });
    const url = `https://serpapi.com/search.json?${qs}`;
    // Cleared on every exit path. Previously the timer was never cleared, so a
    // completed request still left a live 10s timer per call — with several
    // searches per lookup that's a stack of stray timers holding the event loop.
    let timer;
    const done = (value) => { clearTimeout(timer); resolve(value); };

    const req = https.get(url, (res) => {
      let data = '';
      let overflowed = false;
      res.on('data', (c) => {
        if (data.length + c.length > MAX_SERP_RESPONSE_BYTES) { overflowed = true; return; }
        data += c;
      });
      res.on('end', () => {
        // An oversized body used to be silently truncated mid-JSON, fail to
        // parse, and come back as {} — indistinguishable from "found nothing".
        // Say so instead; the caller can tell a real empty result from this.
        if (overflowed) {
          logger.warn('[priceSearch] SerpAPI response exceeded size cap — discarded', { query });
          return done({});
        }
        try { done(JSON.parse(data)); }
        catch (err) {
          logger.warn('[priceSearch] SerpAPI response was not valid JSON', { query, err: err.message });
          done({});
        }
      });
    }).on('error', (err) => {
      logger.warn('[priceSearch] SerpAPI request failed', { query, err: err.message });
      done({});
    });

    timer = setTimeout(() => { req.destroy(); resolve({}); }, timeoutMs);
  });
}

// ── ספקי מזון סיטונאיים ידועים בישראל (מסעדות / קייטרינג) ─────
const FOOD_WHOLESALERS_IL = [
  { name: 'אלקטרא פוד',       domain: 'electrafood.co.il',    type: 'מפיץ ראשי' },
  { name: 'גלובוס מקס',        domain: 'globus.co.il',          type: 'שוק סיטונאי' },
  { name: 'רמי לוי עסקים',     domain: 'rami-levy.co.il',       type: 'סיטונאי/קמעונאי' },
  { name: 'מחסני השוק',        domain: 'mahasane-hashuk.co.il', type: 'שוק סיטונאי' },
  { name: 'יוחננוף עסקים',     domain: 'yochananof.co.il',      type: 'סיטונאי מזון' },
  { name: 'ספיר סיטונאי',      domain: 'sapir.co.il',           type: 'ספק ירקות/פירות' },
  { name: 'תנובה / שטראוס',    domain: 'tnuva.co.il',           type: 'יצרן מזון' },
  { name: 'נייס פוד',           domain: 'nicefood.co.il',        type: 'ספק מסעדות' },
  { name: 'פרי גלים (ים)',      domain: 'perigalim.co.il',       type: 'ספק פירות ים' },
  { name: 'דיאמונד פוד',        domain: 'diamondfood.co.il',     type: 'ספק מסעדות' },
];

// חולץ ערך מספרי ראשון ממחרוזת מחיר חופשית ("12.5 ₪/ק\"ג" → 12.5)
function extractNumericPrice(priceStr) {
  if (typeof priceStr !== 'string') return null;
  const match = priceStr.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// חולץ שם עיר ממחרוזת כתובת חופשית ("רחוב הרצל 5, תל אביב" → "תל אביב")
function extractCity(address) {
  if (!address) return null;
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  // הסר מיקוד (5+ ספרות) ורווחים עודפים
  return city ? city.replace(/\d{5,}/g, '').trim() || null : null;
}

// מריץ חיפושי SerpAPI מקבילים + ניתוח Claude, ומחזיר תוצאת השוואת מחירים
// מלאה (ללא כל תלות ב-DB/HTTP) — משמש גם את מסלול ה-API וגם את ה-scheduler
// שבודק התראות מחיר.
// options.businessAddress — כתובת העסק לסינון גיאוגרפי ועלויות משלוח
async function searchPrice(rawQuery, options = {}) {
  const q = rawQuery.trim().slice(0, 100).replace(/[`\\]/g, '');

  // Without this guard, every search fired 10 parallel SerpAPI requests with
  // api_key=undefined regardless of whether the key was actually configured —
  // SerpAPI's JSON error response still parses fine (no organic_results/
  // shopping_results keys), so the function quietly degraded to an empty,
  // confidence:'low' result indistinguishable from "genuinely found nothing".
  // Same guard already exists in aiAdvisor.agent.js's _webSearch for the
  // same reason; this file didn't have it.
  if (!process.env.SERP_API_KEY) {
    logger.warn('[priceSearch] SERP_API_KEY not configured — skipping search', { query: q });
    return {
      cheapestPrice: null, priceRange: {}, suppliers: [],
      marketInsight: {},
      knownIsraeliSuppliers: FOOD_WHOLESALERS_IL.map(s => ({
        name: s.name, domain: s.domain, type: s.type, recommended: false,
      })),
      summary: 'חיפוש מחירים אינו מוגדר במערכת כרגע — פנה לתמיכה',
      confidence: 'low',
      searchedAt: new Date().toISOString(),
    };
  }

  const businessCity = extractCity(options.businessAddress || '');

  // ── SerpAPI budget ────────────────────────────────────────────────────────
  // This used to fire TEN searches per lookup. The account is on SerpAPI's Free
  // Plan — 250 searches/month — so ten-per-lookup allowed only ~25 lookups a
  // month, and a single daily price alert (10 × 30 = 300) exceeded the whole
  // plan on its own. Five of the ten queries were near-duplicates of each other
  // ("ספק … סיטונאי מחיר ישראל" in five phrasings), so most of that spend bought
  // overlapping results.
  //
  // Three queries, each doing the work of several via OR:
  //   1. Google Shopping — the only source with structured, parseable prices
  //   2. Wholesale/restaurant suppliers — merges the five Hebrew supplier
  //      variants plus the site: filters for the known wholesalers
  //   3. Retail + market reference — supermarket and open-market pricing, which
  //      is what anchors "is this wholesale price actually good?"
  // Delivery/locality is folded into query 2 when the city is known.
  const localityClause = businessCity ? ` ${businessCity} משלוח` : '';
  const serpQueries = [
    { key: 'shopping',   q: `${q} מחיר`, params: { tbm: 'shop', gl: 'il' } },
    { key: 'wholesale',  q: `${q} ספק סיטונאי מחיר ישראל מסעדות${localityClause} OR site:electrafood.co.il OR site:globus.co.il OR site:rami-levy.co.il` },
    { key: 'retail',     q: `${q} מחיר לקילו OR "מחיר ליחידה" site:shufersal.co.il OR site:mysupermarket.co.il OR "שוק הכרמל" OR "מחנה יהודה"` },
  ];

  // Cached globally by normalised query for 24h — NOT per business. Wholesale
  // prices are public data, so two businesses searching "חזה עוף" on the same
  // day should cost one lookup, not two. It also covers the plain repeat case,
  // which is most of the real traffic: of the five searches on record, four
  // were same-day duplicates of just two products.
  //
  // wrapWithLock (not wrap) so two concurrent identical searches don't both
  // miss the cache and both spend the quota.
  const cacheKey = `serp:price:v2:${q.toLowerCase().replace(/\s+/g, ' ').trim()}:${businessCity || '-'}`;
  const serpResults = await cache.wrapWithLock(
    cacheKey,
    async () => {
      const settled = await Promise.allSettled(
        serpQueries.map(s => serpSearch(s.q, s.params || {}))
      );
      return Object.fromEntries(
        serpQueries.map((s, i) => [s.key, settled[i].status === 'fulfilled' ? settled[i].value : {}])
      );
    },
    SERP_CACHE_TTL_SECONDS,
  );

  const shoppingItems = serpResults.shopping?.shopping_results?.slice(0, 10) || [];
  const wholesaleItems = serpResults.wholesale?.organic_results?.slice(0, 8) || [];
  const retailItems    = serpResults.retail?.organic_results?.slice(0, 8)    || [];

  // Titles and snippets are arbitrary third-party web content — the least
  // trustworthy input in the whole app — and they are embedded verbatim into
  // the prompt below, whose output the UI renders as clickable supplier links.
  // marketing.context.js already sanitizes the owner's OWN dish names against
  // exactly this; skipping it here, where the text comes from strangers' web
  // pages, was the larger hole. sanitizeField redacts injection payloads and
  // caps length (which also keeps the prompt token-efficient).
  const _clean     = (s, max = 120) => sanitizeField(String(s ?? ''), max) || '';
  const _cleanItem = (i) => ({
    title:   _clean(i.title, 120),
    snippet: _clean(i.snippet, 120),
    link:    safeHttpUrl(i.link),
  });

  const rawData = JSON.stringify({
    googleShopping: shoppingItems.map(i => ({
      title: _clean(i.title, 120), price: _clean(i.price, 40),
      source: _clean(i.source, 60), link: safeHttpUrl(i.link),
    })),
    wholesaleSuppliers: wholesaleItems.map(_cleanItem),
    retailAndMarkets:   retailItems.map(_cleanItem),
  });

  const knownSuppliersList = FOOD_WHOLESALERS_IL
    .map(s => `• ${s.name} (${s.domain}) — ${s.type}`)
    .join('\n');

  const locationContext = businessCity
    ? `מיקום העסק: ${businessCity}. חשוב: ספקים מצפון הארץ (חיפה צפונה) לא מתאימים לעסק בדרום ולהיפך. הוסף אזהרה ל-isReachable=false לספקים שמרחוק מדי מ-${businessCity}.`
    : 'מיקום העסק: לא ידוע — אל תסנן לפי מיקום.';

  const promptContent = `אתה מומחה רכש למסעדות ועסקי מזון בישראל. נמצאו תוצאות חיפוש מ-10 מקורות שונים עבור: "${q}".

${locationContext}

ספקי מזון סיטונאיים ידועים בישראל (השתמש בהם כהפניה):
${knownSuppliersList}

תוצאות חיפוש מ-10 מקורות:
${rawData}

נתח את כל התוצאות והחזר JSON בלבד (ללא הסבר):
{
  "cheapestPrice": {
    "price": "X ₪/ק\\"ג",
    "source": "שם הספק/האתר",
    "link": "url",
    "note": "הערה קצרה — למה הוא זול"
  },
  "priceRange": {
    "min": "X ₪",
    "max": "Y ₪",
    "unit": "ק\\"ג / יחידה / ליטר / מארז"
  },
  "suppliers": [
    {
      "name": "שם ספק",
      "price": "מחיר",
      "priceWithDelivery": "מחיר כולל משלוח לעיר הרלוונטית (אם ניתן לאמוד)",
      "link": "url",
      "type": "סיטונאי/שוק/אתר/מפיץ",
      "minOrder": "כמות מינימום אם ידועה",
      "location": "עיר/אזור הספק (תל אביב / חיפה / ירושלים / צפון / דרום / ארצי)",
      "deliveryFee": "עלות משלוח אם ידועה, או הערכה (למשל: ₪50-100 למשלוח)",
      "deliveryAvailable": true,
      "isReachable": true,
      "source": "מאיזה מקור חיפוש נמצא"
    }
  ],
  "marketInsight": {
    "typicalRestaurantCost": "עלות טיפוסית למסעדה לק\\"ג",
    "bestBuyingStrategy": "אסטרטגיית רכישה מומלצת",
    "seasonalNote": "האם המוצר עונתי? מתי הכי זול?",
    "portionCost": "עלות ממוצעת למנה (אם ניתן להעריך)"
  },
  "locationInsight": {
    "nearbySuppliers": ["שמות ספקים שמתאימים גיאוגרפית לעסק"],
    "shippingNote": "סיכום עלויות משלוח ואפשרויות אספקה לאזור העסק",
    "distanceWarnings": ["ספקים שנמצאים רחוק מדי ולא כלכלי לקבל מהם משלוח"]
  },
  "knownIsraeliSuppliers": [
    { "name": "שם", "domain": "כתובת אתר", "type": "סוג", "recommended": true/false }
  ],
  "summary": "סיכום בעברית — הספק הזול ביותר, המלצה מעשית למסעדה, ותובנות מהשוק",
  "confidence": "high/medium/low",
  "searchedAt": "${new Date().toISOString()}"
}

חוקים קריטיים:
1. השתמש רק בנתונים שנמצאו בפועל — אל תמציא מחירים
2. אם אין מחירים ברורים — confidence: "low" ו-priceRange ריק
3. suppliers: עד 8 ספקים. סדר קריטי — קודם כל הספקים שיש להם מחיר בפועל (מהזול ליקר), ורק אחריהם (אם יש מקום פנוי) ספקים בלי מחיר מפורש. אל תערבב אותם — ספק בלי מחיר תמיד אחרי כל הספקים עם מחיר.
4. אם ל-3 ספקים או יותר יש מחיר אמיתי — אל תכלול יותר מ-2 ספקים בלי מחיר בסה"כ (הם תוספת ליצירת קשר, לא הליבה של השוואת המחירים)
5. העדף ספקים סיטונאיים (אלקטרא פוד, גלובוס מקס, מחסני השוק) על קמעונאיים — אבל רק בתוך קבוצת הספקים עם מחיר
6. knownIsraeliSuppliers — הוסף רק ספקים שנמצאו בתוצאות OR שרלוונטיים בוודאות לפריט זה
7. marketInsight — אפילו אם אין מחיר מדויק, תן הערכה מנוסיון שוק ישראלי
8. isReachable: false לספקים שנמצאים רחוק גיאוגרפית מהעסק (לפי locationContext למעלה)
9. deliveryFee: הערך גם כשאין נתון מדויק — "~₪50-80" זה טוב יותר מריק`;

  let text;
  let provider = 'gemini';
  let finishReason = null;
  try {
    // responseMimeType constrains the model to emit a bare JSON document, which
    // removes the prose preambles and fenced blocks that the hand-rolled
    // brace-matching below used to trip over.
    const gemRes = await geminiService.chat('', [{ role: 'user', content: promptContent }], {
      maxTokens: 6000,
      responseMimeType: 'application/json',
    });
    text = gemRes.text?.trim() || '';
    finishReason = gemRes.finishReason ?? null;
  } catch (gemErr) {
    logger.warn('[priceSearch] Gemini failed → Haiku fallback', { query: q, err: gemErr.message });
    provider = 'haiku';
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 6000,
      messages: [{ role: 'user', content: promptContent }],
    });
    logTokenUsage({ businessId: options.businessId || null, feature: 'price_search', model: 'claude-haiku-4-5', usage: msg.usage });
    finishReason = msg.stop_reason ?? null;
    text = msg.content?.find(b => b.type === 'text')?.text?.trim() || '';
  }

  // parseClaudeJSON is the hardened parser already used elsewhere in this
  // codebase — it strips ```json fences and warns on truncation. This service
  // hand-rolled `text.match(/\{[\s\S]*\}/)`, a greedy match from the first
  // brace to the last, which silently produces invalid JSON whenever the model
  // emits anything else alongside the object.
  let result = parseClaudeJSON({ content: [{ type: 'text', text }], stop_reason: finishReason },
    { feature: 'priceSearch', query: q, provider });

  if (!result || typeof result !== 'object') {
    // This is NOT "no prices exist" — the search ran and the model answered, we
    // just couldn't read the answer. Reporting it as an empty result made a
    // successful search indistinguishable from a genuinely empty one: on the
    // record, 3 of 5 production searches landed here and told the user "לא נמצאו
    // מחירים", including one for a product that had succeeded the same day.
    //
    // finishReason and a generous snippet are logged because the previous
    // version kept neither for the primary provider, which left those three
    // failures permanently undiagnosable.
    logger.error('[priceSearch] AI response could not be parsed as JSON', {
      query: q, provider, finishReason,
      textLength: text.length,
      snippet: text.slice(0, 1000),
    });
    return {
      cheapestPrice: null, priceRange: {}, suppliers: [],
      marketInsight: {},
      knownIsraeliSuppliers: FOOD_WHOLESALERS_IL.map(s => ({
        name: s.name, domain: s.domain, type: s.type, recommended: false,
      })),
      summary: 'החיפוש רץ אך לא הצלחנו לקרוא את תשובת ה-AI — נסה שוב',
      confidence: 'low',
      error: 'parse_failed',
      searchedAt: new Date().toISOString(),
    };
  }

  // עדיפות דטרמיניסטית לספקים עם מחיר אמיתי — לא סומכים רק על ה-LLM לשמור על
  // הסדר/המכסה המבוקשים בפרומפט (הוראת ניסוח בלבד אינה אכיפה מובטחת)
  const _hasRealPrice = (p) => typeof p === 'string' && p.trim() && !/^(לא צוין|לא ידוע|n\/a|לא זמין)/i.test(p.trim());
  if (Array.isArray(result.suppliers)) {
    const priced      = result.suppliers.filter(s => _hasRealPrice(s?.price));
    const unpriced    = result.suppliers.filter(s => !_hasRealPrice(s?.price));
    const maxUnpriced = priced.length >= 3 ? 2 : unpriced.length;
    result.suppliers  = [...priced, ...unpriced.slice(0, maxUnpriced)];
    // Every link the UI turns into an href goes through the scheme allowlist —
    // the model's own input is third-party web content, so its output URLs are
    // not trusted either.
    result.suppliers.forEach(s => { if (s) s.link = safeHttpUrl(s.link); });
  }
  if (result.cheapestPrice) result.cheapestPrice.link = safeHttpUrl(result.cheapestPrice.link);

  if (!result.knownIsraeliSuppliers?.length) {
    result.knownIsraeliSuppliers = FOOD_WHOLESALERS_IL.map(s => ({
      name: s.name, domain: s.domain, type: s.type, recommended: false,
    }));
  }

  return result;
}

module.exports = { searchPrice, extractNumericPrice, extractCity, FOOD_WHOLESALERS_IL };
