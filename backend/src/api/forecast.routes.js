const express = require('express');
const router  = express.Router();
const https   = require('https');
const logger  = require('../utils/logger');
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../utils/db');
const eventBus = require('../utils/eventBus');
const { todayIL } = require('../utils/dateIL');

// ── עזרים ──────────────────────────────────────────────────────
const DAYS_HE = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

// חגים ישראליים קבועים לשנים 2025-2030 (תאריך גרגוריאני)
const IL_HOLIDAYS = new Set([
  // 2025
  '2025-04-12','2025-04-13', // פסח ב + ז
  '2025-06-01','2025-06-02', // שבועות
  '2025-09-22','2025-09-23', // ר"ה
  '2025-10-01',              // יום כיפור
  '2025-10-06','2025-10-07', // סוכות א + שמחת תורה
  '2025-10-13',              // שמחת תורה (אחרון של חג)
  // 2026
  '2026-04-01','2026-04-02','2026-04-08','2026-04-09', // פסח
  '2026-05-21','2026-05-22',                            // שבועות
  '2026-09-20','2026-09-21',                            // ר"ה
  '2026-09-29',                                         // יום כיפור
  '2026-10-04','2026-10-05','2026-10-11',               // סוכות
  '2026-12-14','2026-12-15','2026-12-16','2026-12-17',  // חנוכה חלק
  // 2027
  '2027-03-22',                                         // פורים
  '2027-04-20','2027-04-21','2027-04-27','2027-04-28',  // פסח
  '2027-06-09','2027-06-10',                            // שבועות
  '2027-09-11','2027-09-12',                            // ר"ה
  '2027-09-20',                                         // יום כיפור
  '2027-09-25','2027-09-26','2027-10-02',               // סוכות
  '2027-12-02','2027-12-03','2027-12-04',               // חנוכה (חלק)
  // 2028
  '2028-03-12',                                         // פורים
  '2028-04-11','2028-04-12','2028-04-18','2028-04-19',  // פסח
  '2028-05-30','2028-05-31',                            // שבועות
  '2028-09-29','2028-09-30',                            // ר"ה
  '2028-10-08',                                         // יום כיפור
  '2028-10-13','2028-10-14','2028-10-20',               // סוכות
  '2028-12-19','2028-12-20','2028-12-21',               // חנוכה (חלק)
  // 2029
  '2029-02-28',                                         // פורים
  '2029-03-30','2029-03-31','2029-04-06','2029-04-07',  // פסח
  '2029-05-18','2029-05-19',                            // שבועות
  '2029-09-18','2029-09-19',                            // ר"ה
  '2029-09-27',                                         // יום כיפור
  '2029-10-02','2029-10-03','2029-10-09',               // סוכות
  '2029-12-09','2029-12-10','2029-12-11',               // חנוכה (חלק)
  // 2030
  '2030-03-19',                                         // פורים
  '2030-04-19','2030-04-20','2030-04-26','2030-04-27',  // פסח
  '2030-06-07','2030-06-08',                            // שבועות
  '2030-09-06','2030-09-07',                            // ר"ה
  '2030-09-15',                                         // יום כיפור
  '2030-09-20','2030-09-21','2030-09-27',               // סוכות
]);

// ערבי חג (יום לפני החג — צפי גבוה)
const IL_EVES = new Set([
  '2025-04-11','2025-05-31','2025-09-21','2025-09-30','2025-10-05',
  '2026-03-31','2026-05-20','2026-09-19','2026-09-28','2026-10-03',
  '2026-12-13',
  '2027-03-21','2027-04-19','2027-04-26','2027-06-08','2027-09-10','2027-09-19','2027-09-24',
  '2028-03-11','2028-04-10','2028-04-17','2028-05-29','2028-09-28','2028-10-07','2028-10-12',
  '2029-02-27','2029-03-29','2029-04-05','2029-05-17','2029-09-17','2029-09-26','2029-10-01',
  '2030-03-18','2030-04-18','2030-04-25','2030-06-06','2030-09-05','2030-09-14','2030-09-19',
]);

// ── HTTP helper ──────────────────────────────────────────────
function httpGet(url, timeoutMs = 8000, headers = {}) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers:  { ...headers },
    };
    const req = https.get(opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
    setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
  });
}

// ── Geocoding (Nominatim / OpenStreetMap) ───────────────────
// Cache keyed by businessId; TTL 24h. Geocode is done once per address change.
const _geocodeCache = new Map(); // businessId → { lat, lon, city, address, fetchedAt }
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;
  const encoded = encodeURIComponent(address.trim());
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=il&accept-language=he`;
  const data = await httpGet(url, 8000, {
    'User-Agent': 'HouseOfBusiness/1.0 (houseof.biz)',
    'Accept-Language': 'he',
  });
  if (!Array.isArray(data) || !data[0]) return null;
  const city = (data[0].display_name || '').split(',')[0].trim();
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), city };
}

async function resolveWeatherCoords(businessId, fallbackLat, fallbackLon) {
  const cached = _geocodeCache.get(businessId);
  if (cached && (Date.now() - cached.fetchedAt) < GEOCODE_CACHE_TTL_MS) {
    return { lat: cached.lat, lon: cached.lon, city: cached.city };
  }
  try {
    const { rows: [biz] } = await db.query(
      `SELECT address FROM businesses WHERE id = $1`, [businessId]
    );
    if (biz?.address) {
      const geo = await geocodeAddress(biz.address);
      if (geo) {
        _geocodeCache.set(businessId, { ...geo, address: biz.address, fetchedAt: Date.now() });
        return { lat: geo.lat, lon: geo.lon, city: geo.city };
      }
    }
  } catch (e) {
    logger.debug('[Weather] geocoding failed', { businessId, err: e.message });
  }
  return { lat: fallbackLat, lon: fallbackLon, city: null };
}

// ── OpenWeatherMap One-Call 3.0 ───────────────────────────────
// דורש OPENWEATHER_API_KEY ב-env
// מחזיר מבנה { daily: [{ date, maxTemp, precip, windKph, humidity, code }] }
async function fetchWeatherOWM(lat, lon, days, apiKey) {
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=current,minutely,hourly,alerts&units=metric&lang=he&appid=${apiKey}`;
  const data = await httpGet(url);
  if (!data?.daily) return null;

  // OWM weather-id → WMO-like code mapping
  function owmToWmo(id) {
    if (id >= 200 && id < 300) return 95;  // thunderstorm
    if (id >= 300 && id < 400) return 51;  // drizzle
    if (id === 500) return 61;             // light rain
    if (id === 501) return 63;             // moderate rain
    if (id >= 502 && id < 505) return 65; // heavy rain
    if (id === 511) return 66;            // freezing rain
    if (id >= 520 && id < 525) return 80; // shower rain
    if (id === 531) return 82;            // ragged shower
    if (id >= 600 && id < 700) return 71; // snow
    if (id === 741) return 45;            // fog
    if (id === 800) return 0;             // clear
    if (id === 801) return 1;             // few clouds
    if (id === 802) return 2;             // scattered clouds
    if (id >= 803) return 3;             // broken/overcast clouds
    return 0;
  }

  return {
    source: 'openweathermap',
    daily: data.daily.slice(0, days).map(d => ({
      date:     new Date(d.dt * 1000).toISOString().slice(0, 10),
      maxTemp:  d.temp.max,
      precip:   (d.rain || 0) + (d.snow || 0),
      windKph:  Math.round((d.wind_speed || 0) * 3.6),
      humidity: d.humidity || 0,
      uvi:      d.uvi || 0,
      code:     owmToWmo(d.weather?.[0]?.id || 800),
      description: d.weather?.[0]?.description || '',
    })),
  };
}

// ── Open-Meteo (חינמי, ללא key) — Tel Aviv default ──────────
async function fetchWeatherOpenMeteo(lat, lon, days) {
  // Uses new field names (weather_code, wind_speed_10m_max) — also handles old names as fallback
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_sum,weather_code,wind_speed_10m_max,relative_humidity_2m_max&forecast_days=${days}&timezone=Asia%2FJerusalem`;
  const data = await httpGet(url);
  if (!data?.daily) {
    if (data?.error) logger.warn('[Weather] Open-Meteo error', { reason: data.reason, days });
    // retry with old field names (backward compat)
    const url2 = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_sum,weathercode,windspeed_10m_max,relative_humidity_2m_max&forecast_days=${days}&timezone=Asia%2FJerusalem`;
    const data2 = await httpGet(url2);
    if (!data2?.daily) {
      if (data2?.error) logger.warn('[Weather] Open-Meteo fallback error', { reason: data2.reason, days });
      return null;
    }
    return _mapOpenMeteoResponse(data2);
  }
  return _mapOpenMeteoResponse(data);
}

function _mapOpenMeteoResponse(data) {
  return {
    source: 'open-meteo',
    daily: data.daily.time.map((date, i) => ({
      date,
      maxTemp:  data.daily.temperature_2m_max[i],
      precip:   data.daily.precipitation_sum[i] || 0,
      // accept both old and new field names
      windKph:  Math.round(data.daily.wind_speed_10m_max?.[i] ?? data.daily.windspeed_10m_max?.[i] ?? 0),
      humidity: data.daily.relative_humidity_2m_max?.[i] || 0,
      uvi:      0,
      code:     data.daily.weather_code?.[i] ?? data.daily.weathercode?.[i] ?? 0,
      description: '',
    })),
  };
}

// ── Server-side weather cache: 1 שעה TTL, מונע קריאות חוזרות ──
// מפתח ללא days — תמיד שולפים את המקסימום וחותכים בקוד, כך שינוי horizon לא מבטל cache.
// 16 הוא המקסימום של Open-Meteo tier חינמי; OWM One-Call 3.0 מחזיר 8 ימים בלבד.
const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const WEATHER_MAX_DAYS = 16;
const _weatherCache = new Map(); // key: "lat,lon" → { data, fetchedAt }

async function fetchWeather(lat = 32.09, lon = 34.79, days = 14) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = _weatherCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < WEATHER_CACHE_TTL_MS) {
    const sliced = { ...cached.data, daily: (cached.data.daily || []).slice(0, days) };
    return { ...sliced, fromCache: true, cachedAt: new Date(cached.fetchedAt).toISOString() };
  }

  const owmKey = process.env.OPENWEATHER_API_KEY;
  let fresh = null;
  if (owmKey) {
    fresh = await fetchWeatherOWM(lat, lon, WEATHER_MAX_DAYS, owmKey);
    if (!fresh) logger.warn('[Weather] OWM failed — falling back to Open-Meteo');
  }
  if (!fresh) fresh = await fetchWeatherOpenMeteo(lat, lon, WEATHER_MAX_DAYS);

  if (fresh) {
    _weatherCache.set(key, { data: fresh, fetchedAt: Date.now() });
    // Evict stale entries from other keys to prevent unbounded growth
    for (const [k, v] of _weatherCache) {
      if (k !== key && (Date.now() - v.fetchedAt) > WEATHER_CACHE_TTL_MS * 2) {
        _weatherCache.delete(k);
      }
    }
    return { ...fresh, daily: (fresh.daily || []).slice(0, days), fromCache: false };
  } else if (cached) {
    logger.warn('[Weather] Fetch failed — serving stale cache', { key, ageMin: Math.round((Date.now() - cached.fetchedAt) / 60000) });
    return { ...cached.data, daily: (cached.data.daily || []).slice(0, days), fromCache: true, stale: true };
  }

  return null;
}

// המרת weathercode (WMO) + רוח + לחות → תיאור עברי + מכפיל + חומרה
function weatherEffect(code, maxTemp, precip, windKph = 0, humidity = 0) {
  let multiplier = 1.0;
  let label = 'בהיר';
  let severity = 'normal';
  let emoji = '☀️';
  const extras = [];

  // ── WMO code ─────────────────────────────────────────────
  if (code === 95 || code === 96 || code === 99) {
    multiplier = 0.65; label = 'סערה ורעמים'; severity = 'severe'; emoji = '⛈️';
  } else if (code === 82) {
    multiplier = 0.70; label = 'גשם סוחף';    severity = 'severe'; emoji = '🌧️';
  } else if (code === 65 || code === 75 || code === 86) {
    multiplier = 0.74; label = 'גשם כבד';      severity = 'severe'; emoji = '🌧️';
  } else if (code === 80 || code === 81 || code === 63) {
    multiplier = 0.83; label = 'גשם';          severity = 'warning'; emoji = '🌦️';
  } else if (code === 61 || code === 55 || code === 53) {
    multiplier = 0.91; label = 'גשמי חלקית';  severity = 'warning'; emoji = '🌦️';
  } else if (code === 51) {
    multiplier = 0.96; label = 'טפטוף קל';    severity = 'normal';  emoji = '🌦️';
  } else if (code === 45 || code === 48) {
    multiplier = 0.88; label = 'ערפל';         severity = 'warning'; emoji = '🌫️';
  } else if (code === 71 || code === 73 || code === 85) {
    multiplier = 0.78; label = 'שלג';          severity = 'severe';  emoji = '❄️';
  } else if (code === 3) {
    label = 'מעונן'; emoji = '☁️';
  } else if (code === 2) {
    label = 'מעונן חלקית'; emoji = '⛅';
  } else if (code === 1) {
    label = 'בהיר חלקית'; emoji = '🌤️';
  } else {
    // Fallback לפי נתונים גולמיים
    if      (precip > 10)  { multiplier = 0.74; label = 'גשום מאוד';  severity = 'severe';  emoji = '🌧️'; }
    else if (precip > 5)   { multiplier = 0.82; label = 'גשום';       severity = 'warning'; emoji = '🌧️'; }
    else if (precip > 1)   { multiplier = 0.92; label = 'גשמי חלקית'; severity = 'warning'; emoji = '🌦️'; }
    else if (maxTemp >= 38){ multiplier = 0.80; label = 'גל חום';     severity = 'severe';  emoji = '🌡️'; }
    else if (maxTemp >= 36){ multiplier = 0.88; label = 'חם מאוד';    severity = 'warning'; emoji = '☀️'; }
    else if (maxTemp >= 32){ multiplier = 0.95; label = 'חם';         emoji = '☀️'; }
    else if (maxTemp <= 5) { multiplier = 0.85; label = 'קר מאוד';    severity = 'warning'; emoji = '🥶'; }
    else if (maxTemp <= 10){ multiplier = 0.91; label = 'קר';         emoji = '🌬️'; }
    else if (maxTemp >= 22 && maxTemp <= 28 && precip === 0)
                           { multiplier = 1.08; label = 'נעים';       emoji = '😊'; }
  }

  // ── השפעת רוח (עצמאית) ───────────────────────────────────
  if (windKph >= 60) {
    multiplier *= 0.82; severity = 'severe';
    extras.push('רוח קיצונית');
  } else if (windKph >= 40) {
    multiplier *= 0.92; if (severity === 'normal') severity = 'warning';
    extras.push('רוח חזקה');
  } else if (windKph >= 25) {
    multiplier *= 0.97;
    extras.push('רוח');
  }

  // ── השפעת לחות גבוהה בחום ────────────────────────────────
  if (humidity >= 85 && maxTemp >= 30) {
    multiplier *= 0.93; if (severity === 'normal') severity = 'warning';
    extras.push('לחות גבוהה');
  }

  if (extras.length) label += ` + ${extras.join(', ')}`;
  multiplier = Math.max(0.50, Math.min(1.20, parseFloat(multiplier.toFixed(2))));

  return { multiplier, label, severity, emoji };
}

// ── Forecast Settings (persisted per-business in DB) ─────────────────────────
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS forecast_settings JSONB`).catch(() => {});

const DEFAULT_FORECAST_SETTINGS = {
  staffRatio: 25, minStaff: 2,
  cogsBreakdown: { meat: 36, fish: 14, produce: 21, dairy: 12, dry: 0, beverages: 17 },
  lat: 32.09, lon: 34.79,
};

// GET /api/forecast/settings
router.get('/settings', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT forecast_settings FROM businesses WHERE id = $1`, [req.user.businessId]);
    const saved = rows[0]?.forecast_settings || {};
    res.json({ ...DEFAULT_FORECAST_SETTINGS, ...saved });
  } catch (err) { next(err); }
});

// PUT /api/forecast/settings
router.put('/settings', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE businesses SET forecast_settings = $1 WHERE id = $2 RETURNING forecast_settings`,
      [req.body, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'forecast.updated', { action: 'settings_updated' });
    res.json({ ...DEFAULT_FORECAST_SETTINGS, ...(rows[0]?.forecast_settings || {}) });
  } catch (err) { next(err); }
});

// Shared param extractor — supports both query (GET) and body (POST)
function extractForecastParams(source) {
  const forecastDays = Math.min(Math.max(parseInt(source.days) || 14, 1), 30);
  const rawLat = parseFloat(source.lat);
  const rawLon = parseFloat(source.lon);
  const lat = (!isNaN(rawLat) && rawLat >= -90  && rawLat <= 90)  ? rawLat : 32.09;
  const lon = (!isNaN(rawLon) && rawLon >= -180 && rawLon <= 180) ? rawLon : 34.79;
  const staffRatio = Math.max(5, parseInt(source.staffRatio) || 25);
  const minStaff   = Math.max(1, parseInt(source.minStaff)   || 2);

  let cogsBreakdown = { meat:36, fish:14, produce:21, dairy:12, dry:0, beverages:17 };
  const rawCogs = typeof source.cogsBreakdown === 'string' ? (() => { try { return JSON.parse(source.cogsBreakdown); } catch { return null; } })() : source.cogsBreakdown;
  if (rawCogs && typeof rawCogs === 'object') {
    const total = Object.values(rawCogs).reduce((s, v) => s + Number(v), 0);
    if (total > 0) {
      cogsBreakdown = {};
      for (const [k, v] of Object.entries(rawCogs)) cogsBreakdown[k] = Number(v) / total * 100;
    }
  }

  let customEvents = {};
  const rawEvents = typeof source.customEvents === 'string' ? (() => { try { return JSON.parse(source.customEvents); } catch { return null; } })() : source.customEvents;
  if (Array.isArray(rawEvents)) {
    rawEvents.forEach(ev => {
      if (ev.date && ev.multiplier) customEvents[ev.date] = { label: ev.label || 'אירוע', multiplier: Math.min(Math.max(Number(ev.multiplier) || 1, 0.1), 10) };
    });
  }

  return { forecastDays, lat, lon, staffRatio, minStaff, cogsBreakdown, customEvents };
}

// Shared handler for both GET and POST /demand
async function handleDemandForecast(req, res, next) {
  try {
    const source = req.method === 'POST' ? req.body : req.query;
    const { forecastDays, lat, lon, staffRatio, minStaff, cogsBreakdown, customEvents } = extractForecastParams(source);
    const businessId = req.user.businessId;

    // Resolve weather coordinates from business address (geocoded, cached 24h).
    // Falls back to lat/lon from request params if address is unavailable or geocoding fails.
    const { lat: weatherLat, lon: weatherLon, city: weatherCity } =
      await resolveWeatherCoords(businessId, lat, lon);

    // Anchored on todayIL(), not a naive new Date().setHours(0,0,0,0) — the
    // server runs in UTC (no TZ env var set), 2-3 hours behind Israel's
    // calendar date around midnight. Every SQL query in this file already
    // computes "day" via AT TIME ZONE 'Asia/Jerusalem'; this anchor now
    // matches that instead of silently shifting the whole forecast window
    // (and the IL_HOLIDAYS/IL_EVES lookups keyed by it) by a day during that
    // window. Built from todayIL()'s Y-M-D via Date.UTC so the existing
    // downstream .setDate()/.getDay()/.toISOString() calls stay correct
    // (this process's local time IS UTC, so local and UTC Date methods agree).
    const [_ty, _tm, _td] = todayIL().split('-').map(Number);
    const today = new Date(Date.UTC(_ty, _tm - 1, _td));

    // Pre-compute YoY range (pure date math — no DB dependency)
    const yoyRangeStart = new Date(today);
    yoyRangeStart.setFullYear(yoyRangeStart.getFullYear() - 1);
    yoyRangeStart.setDate(yoyRangeStart.getDate() + 1);
    const yoyRangeEnd = new Date(yoyRangeStart);
    yoyRangeEnd.setDate(yoyRangeEnd.getDate() + forecastDays - 1);

    // ── MEGA-PARALLEL: כל שאילתות ה-DB + מזג אוויר מורצות בו-זמנית ───────────────
    // לפני: 8 סבבי DB ברצף (~2.5s). אחרי: 2 סבבים (~700ms).
    // Q1+Q2+Q4 מאוחדות ל-CTE אחד. Q7+Q9 מאוחדות. הכל מורץ ב-Promise.all אחד.
    const [
      { rows: [salesAndCogs] },
      [{ rows: queueCoverRows }, { rows: avgPriceRows }, { rows: shiftStaffRows }, { rows: staffCalibRows }],
      { rows: yoyRows },
      { rows: invoiceItemRows },
      { rows: histRevRows },
      { rows: invRows },
      { rows: dishNameRows },
      weather,
    ] = await Promise.all([

      // ── Q1+Q2+Q4 MERGED: מכירות DOW + עונתיות + COGS — סריקה אחת של sales ──
      db.query(`
        WITH smart_sales AS (
          SELECT *,
            (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
          FROM sales
          WHERE business_id = $1
            AND sold_at >= NOW() - INTERVAL '12 months'
        ),
        ind_days AS (
          SELECT DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d
          FROM smart_sales WHERE is_ind
        ),
        valid_sales AS (
          SELECT * FROM smart_sales
          WHERE is_ind
             OR DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') NOT IN (SELECT d FROM ind_days)
        ),
        daily_agg AS (
          SELECT
            DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')::date              AS day,
            EXTRACT(DOW   FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
            EXTRACT(MONTH FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS month,
            SUM(total_amount)                                              AS daily_total
          FROM valid_sales
          GROUP BY day, dow, month
          HAVING SUM(total_amount) > 0
        )
        SELECT
          (SELECT COALESCE(json_agg(r ORDER BY r.dow), '[]'::json)
           FROM (SELECT dow, AVG(daily_total) AS avg_revenue, COUNT(*)::int AS sample_days
                 FROM daily_agg GROUP BY dow) r)         AS sales_by_dow,
          (SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
           FROM (SELECT month, AVG(daily_total) AS avg_daily
                 FROM daily_agg GROUP BY month) r)       AS sales_by_month,
          COALESCE((SELECT SUM(i.total_amount)
            FROM invoices i WHERE i.business_id = $1
              AND i.invoice_date >= NOW() - INTERVAL '12 months'
              AND i.total_amount IS NOT NULL), 0)::float AS total_cogs,
          COALESCE((SELECT SUM(total_amount) FROM valid_sales), 0)::float AS total_revenue
      `, [businessId]),

      // ── Q3: covers + avg price + staff (כבר מקביל) ──
      Promise.all([
        db.query(`
          SELECT dow, ROUND(AVG(daily_covers))::int AS avg_covers
          FROM (
            SELECT DATE(created_at AT TIME ZONE 'Asia/Jerusalem') AS d,
                   EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
                   SUM(COALESCE(party_size, 1))::int AS daily_covers
            FROM table_queue
            WHERE business_id = $1
              AND created_at >= NOW() - INTERVAL '365 days'
              AND status IN ('seated','waiting','ready','cancelled')
            GROUP BY d, dow
          ) daily GROUP BY dow
        `, [businessId]).catch(() => ({ rows: [] })),

        db.query(`
          SELECT COALESCE(SUM(si.qty * r.selling_price) / NULLIF(SUM(si.qty), 0), 75)
            AS avg_dish_price
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          JOIN recipes r ON r.id = si.recipe_id AND r.selling_price > 0
          WHERE s.business_id = $1 AND s.sold_at >= NOW() - INTERVAL '12 months'
        `, [businessId]).catch(() => ({ rows: [{ avg_dish_price: 75 }] })),

        db.query(`
          SELECT EXTRACT(DOW FROM report_date AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
                 ROUND(AVG(daily_count))::int AS avg_employees
          FROM (
            SELECT report_date, COUNT(DISTINCT employee_name) AS daily_count
            FROM z_report_shifts
            WHERE business_id = $1 AND report_date >= NOW() - INTERVAL '6 months'
            GROUP BY report_date
          ) d GROUP BY dow
        `, [businessId]).catch(() => ({ rows: [] })),

        // ── Q_STAFF_CALIB: כמה מחזור יומי מייצג כל עובד — מחושב מהיסטוריית משמרות ──
        // מצטרף shifts (status='completed') עם מכירות יומיות לאותו יום.
        // אם אין מספיק נתוני משמרות (<3 ימים), פונה לנתוני z_report_shifts.
        db.query(`
          WITH shift_days AS (
            -- Keyed on actual_start, falling back to planned_start. This used
            -- to read planned_start only, but that column is populated on just
            -- 144 of 1,116 shifts platform-wide (every shift imported from a
            -- Z-report has actual_start and no planned_start). The calibration
            -- therefore found nothing for almost every business and staffing
            -- silently fell through to the covers/25 rule of thumb.
            SELECT
              DATE(COALESCE(actual_start, planned_start) AT TIME ZONE 'Asia/Jerusalem') AS d,
              EXTRACT(DOW FROM COALESCE(actual_start, planned_start) AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
              COUNT(CASE WHEN status = 'completed' THEN 1 END)::int AS staff_count
            FROM shifts
            WHERE business_id = $1
              AND COALESCE(actual_start, planned_start) >= NOW() - INTERVAL '365 days'
              AND COALESCE(actual_start, planned_start) < NOW()
            GROUP BY d, dow
            HAVING COUNT(CASE WHEN status = 'completed' THEN 1 END) > 0
          ),
          revenue_days AS (
            -- Prefer individual POS sales over Z-report aggregates to avoid double-counting.
            -- On days that have both, use only the individual POS rows (same logic as Q1).
            SELECT
              d,
              SUM(total_amount)::float AS daily_rev
            FROM (
              SELECT
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d,
                total_amount,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
              FROM sales
              WHERE business_id = $1
                AND sold_at >= NOW() - INTERVAL '365 days'
                AND sold_at < NOW()
            ) raw
            WHERE is_ind
               OR d NOT IN (
                 SELECT DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')
                 FROM sales
                 WHERE business_id = $1
                   AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
                   AND sold_at >= NOW() - INTERVAL '365 days'
                   AND sold_at < NOW()
               )
            GROUP BY d
            HAVING SUM(total_amount) > 200
          ),
          pairs AS (
            SELECT
              s.dow,
              r.daily_rev,
              s.staff_count,
              (r.daily_rev / s.staff_count)::float AS rps
            FROM shift_days s
            JOIN revenue_days r ON r.d = s.d
            WHERE (r.daily_rev / NULLIF(s.staff_count, 0)) BETWEEN 200 AND 15000
          )
          SELECT
            dow,
            COUNT(*)::int AS sample_days,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rps)::float AS median_rps,
            ROUND(AVG(staff_count))::int AS avg_staff,
            ROUND(AVG(daily_rev))::int AS avg_revenue
          FROM pairs
          GROUP BY dow
          -- One real day of shifts beats the covers/25 guess. A single sample
          -- is too thin for a day-of-week median, so the JS below only uses a
          -- DOW's own figure at 2+ samples and otherwise pools every day into
          -- one business-wide revenue-per-employee ratio.
          HAVING COUNT(*) >= 1
          ORDER BY dow
        `, [businessId]).catch(() => ({ rows: [] })),
      ]),

      // ── Q6: year-over-year ──
      db.query(`
        WITH smart AS (
          SELECT *,
            DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
            (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
          FROM sales
          WHERE business_id = $1
            AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') >= $2
            AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') <= $3
        ),
        ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
        filtered AS (
          SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
        )
        SELECT sale_day,
               SUM(total_amount)::float AS revenue,
               COALESCE(SUM(CASE WHEN is_ind THEN 1 ELSE COALESCE(orders_count, 0) END), 0)::int AS covers
        FROM filtered GROUP BY sale_day
      `, [businessId, yoyRangeStart.toISOString().slice(0, 10), yoyRangeEnd.toISOString().slice(0, 10)])
        .catch(() => ({ rows: [] })),

      // ── Q7+Q9 MERGED: חשבוניות לפי קטגוריה + ספירת שבועות בשאילתה אחת ──
      db.query(`
        WITH inv_data AS (
          SELECT DATE_TRUNC('week', inv.invoice_date)::date AS week_start,
                 LOWER(COALESCE(ic.name, ii.name)) AS raw_category,
                 LOWER(ii.name)                    AS item_name,
                 COALESCE(ii.total_price, 0)       AS item_spend
          FROM invoice_items ii
          JOIN invoices inv ON inv.id = ii.invoice_id
          LEFT JOIN inventory_items ii_item ON ii_item.id = ii.inventory_item_id
          LEFT JOIN inventory_categories ic ON ic.id = ii_item.category_id
          WHERE inv.business_id = $1
            AND inv.invoice_date >= NOW() - INTERVAL '8 weeks'
            AND ii.total_price IS NOT NULL AND ii.total_price > 0
        ),
        week_count AS (
          SELECT GREATEST(COUNT(DISTINCT week_start), 1)::float AS n,
                 COUNT(DISTINCT week_start)::int                AS n_weeks
          FROM inv_data
        )
        SELECT raw_category, item_name,
               SUM(item_spend)::float / n AS avg_weekly_spend,
               n_weeks
        FROM inv_data, week_count
        GROUP BY raw_category, item_name, n, n_weeks
        ORDER BY avg_weekly_spend DESC
      `, [businessId]).catch(() => ({ rows: [] })),

      // ── Q8: מחזור שבועי היסטורי (8 שבועות) ──
      db.query(`
        SELECT COALESCE(AVG(weekly_total), 0)::float AS avg_weekly_revenue
        FROM (
          SELECT DATE_TRUNC('week', sold_at AT TIME ZONE 'Asia/Jerusalem') AS wk,
                 SUM(total_amount) AS weekly_total
          FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '8 weeks'
          GROUP BY wk HAVING SUM(total_amount) > 0
        ) wk_data
      `, [businessId]).catch(() => ({ rows: [{ avg_weekly_revenue: 0 }] })),

      // ── Q10: מלאי נוכחי (low-stock + fallback filter) ──
      db.query(`
        SELECT ii.name, ii.current_qty AS quantity, ii.unit,
               ii.min_qty AS reorder_point, ic.name AS category
        FROM inventory_items ii
        LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
        WHERE ii.business_id = $1 ORDER BY ic.name, ii.name
      `, [businessId]).catch(() => ({ rows: [] })),

      // ── שמות מנות לסינון fallback קטגוריות ──
      db.query(`
        SELECT DISTINCT LOWER(r.name) AS dish_name
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN recipes r ON r.id = si.recipe_id
        WHERE s.business_id = $1 AND s.sold_at >= NOW() - INTERVAL '90 days'
      `, [businessId]).catch(() => ({ rows: [] })),

      // ── מזג אוויר — משתמש בקואורדינטות שגיאוקודו מכתובת העסק ──
      fetchWeather(weatherLat, weatherLon, forecastDays),
    ]);
    // ─────────────────────────────────────────────────────────────────────────────────

    // Parse Q1+Q2+Q4 merged result
    const salesByDow  = salesAndCogs?.sales_by_dow  || [];
    const monthlyRows = salesAndCogs?.sales_by_month || [];
    const totalCogs   = parseFloat(salesAndCogs?.total_cogs)    || 0;
    const totalRevDbl = parseFloat(salesAndCogs?.total_revenue)  || 0;

    const cogsRatio = totalCogs > 0
      ? Math.min(totalCogs / Math.max(totalRevDbl, 1), 0.6)
      : 0.30;

    // Parse Q3
    const queueCoversMap = {};
    queueCoverRows.forEach(r => { queueCoversMap[r.dow] = Math.max(1, parseInt(r.avg_covers) || 1); });
    const hasQueueCovers    = queueCoverRows.length > 0;
    const avgDishPrice      = Math.max(10, parseFloat(avgPriceRows[0]?.avg_dish_price) || 75);
    const shiftStaffMap     = {};
    shiftStaffRows.forEach(r => { shiftStaffMap[r.dow] = Math.max(1, parseInt(r.avg_employees) || 1); });
    const hasShiftData      = shiftStaffRows.length > 0;
    const shiftStaffGlobalAvg = hasShiftData
      ? Math.round(shiftStaffRows.reduce((s, r) => s + parseInt(r.avg_employees), 0) / shiftStaffRows.length)
      : 0;

    // ── קליברציה: מחזור-לעובד לפי DOW מנתוני משמרות אמיתיות ──
    // rpsMap[dow] = חציון מחזור-לעובד לאותו יום בשבוע.
    // globalRps = ממוצע משוקלל על כל הימים (fallback לימים בלי מספיק דגימות).
    const rpsMap = {};
    let globalRps = null;
    let hasCalibration = false;

    if (staffCalibRows.length > 0) {
      // Weighted pooled ratio across every day we have, used for any day of
      // week that lacks enough history of its own.
      const totalSamples = staffCalibRows.reduce((s, r) => s + parseInt(r.sample_days), 0);
      const pooled = staffCalibRows.reduce((s, r) =>
        s + parseFloat(r.median_rps) * parseInt(r.sample_days), 0) / Math.max(1, totalSamples);

      if (pooled > 0) {
        hasCalibration = true;
        globalRps = pooled;
        // A single day tells us nothing specific about that weekday — it only
        // contributes to the pooled figure above. Two or more and the day gets
        // to speak for itself.
        staffCalibRows.forEach(r => {
          if (parseInt(r.sample_days) >= 2 && parseFloat(r.median_rps) > 0) {
            rpsMap[r.dow] = parseFloat(r.median_rps);
          }
        });
      }
    }

    // DOW + monthly maps
    const dowMap = {};
    salesByDow.forEach(r => { dowMap[r.dow] = parseFloat(r.avg_revenue); });
    const globalAvg = salesByDow.length > 0
      ? salesByDow.reduce((s, r) => s + parseFloat(r.avg_revenue), 0) / salesByDow.length
      : 500;

    const monthlyMap = {};
    monthlyRows.forEach(r => { monthlyMap[r.month] = parseFloat(r.avg_daily); });
    const annualAvg = monthlyRows.length > 0
      ? monthlyRows.reduce((s, r) => s + parseFloat(r.avg_daily), 0) / monthlyRows.length
      : 1;

    // ימים סגורים — סמן רק אם יש לפחות 4 שבועות היסטוריה (מונע FP לעסק חדש)
    const closedDows = new Set();
    if (salesByDow.length > 0) {
      const maxSampleDays = Math.max(...salesByDow.map(r => parseInt(r.sample_days) || 0));
      if (maxSampleDays >= 4) {
        for (let d = 0; d <= 6; d++) {
          if (!(d in dowMap)) closedDows.add(d);
        }
      }
    }

    // ציון ביטחון לפי ממוצע ימי-דגימה (לא לפי מספר DOWs)
    const avgSampleDays = salesByDow.length > 0
      ? salesByDow.reduce((s, r) => s + (parseInt(r.sample_days) || 0), 0) / salesByDow.length
      : 0;
    const confidenceLevel = avgSampleDays >= 30 ? 'high' : avgSampleDays >= 8 ? 'medium' : 'low';

    // YoY map + weather
    const yoyMap = {};
    yoyRows.forEach(r => { yoyMap[new Date(r.sale_day).toISOString().slice(0, 10)] = r; });

    const weatherSource = weather?.source || 'none';
    const weatherByDate = {};
    if (weather?.daily) weather.daily.forEach(d => { weatherByDate[d.date] = d; });

    // ── בניית חיזוי ──────────────────────────────────────────────────────────────────
    const forecast = [];
    for (let d = 0; d < forecastDays; d++) {
      const date = new Date(today);
      date.setDate(today.getDate() + d + 1);
      const dateStr = date.toISOString().slice(0, 10);

      const lastYearDate = new Date(date);
      lastYearDate.setFullYear(lastYearDate.getFullYear() - 1);
      const lastYearDateStr = lastYearDate.toISOString().slice(0, 10);
      const yoyData = yoyMap[lastYearDateStr] ?? null;
      const dow = date.getDay();

      const isClosed    = closedDows.has(dow);
      const baseRevenue = isClosed ? 0 : (dowMap[dow] ?? globalAvg);

      const month        = date.getMonth() + 1;
      const monthAvg     = monthlyMap[month] ?? annualAvg;
      const safeMonthAvg = isFinite(monthAvg) ? monthAvg : annualAvg;
      const seasonalMult = annualAvg > 0 ? safeMonthAvg / annualAvg : 1;

      let holidayMult = 1.0, holidayLabel = '';
      if (IL_HOLIDAYS.has(dateStr))  { holidayMult = 0.45; holidayLabel = 'חג'; }
      else if (IL_EVES.has(dateStr)) { holidayMult = 1.28; holidayLabel = 'ערב חג'; }
      if (customEvents[dateStr]) {
        holidayMult = customEvents[dateStr].multiplier;
        const evLabel = customEvents[dateStr].label;
        if (evLabel) holidayLabel = evLabel;
      }

      const w = weatherByDate[dateStr];
      const { multiplier: weatherMult, label: weatherLabel, severity: weatherSeverity, emoji: weatherEmoji } =
        w ? weatherEffect(w.code, w.maxTemp, w.precip, w.windKph, w.humidity)
          : { multiplier: 1.0, label: '', severity: 'normal', emoji: '☀️' };

      const predictedRevenue = isClosed ? 0 : Math.round(baseRevenue * seasonalMult * holidayMult * weatherMult);

      let predictedCovers = 0;
      if (!isClosed) {
        const totalMult = seasonalMult * holidayMult * weatherMult;
        predictedCovers = (hasQueueCovers && queueCoversMap[dow] !== undefined)
          ? Math.max(0, Math.round(queueCoversMap[dow] * totalMult))
          : Math.max(0, Math.round(predictedRevenue / avgDishPrice));
      }

      let recommendedStaff = 0;
      if (!isClosed) {
        if (hasCalibration) {
          // Path A — נתוני משמרות אמיתיות (shifts + sales):
          // חציון המחזור-לעובד לאותו DOW מלמד כמה מחזור יומי מייצג כל עובד.
          // predictedRevenue / rps = מספר העובדים הנדרש לאותו יום.
          const rps = rpsMap[dow] ?? globalRps;
          // Round, not ceil. The ratio is a median of what the business
          // actually staffed, so rounding to nearest reproduces history: the
          // day that ran 4 people on ₪9,948 predicts 4 again. Ceil biased
          // every result upward — ₪7,621 needs 3.06 people and was being
          // reported as 4.
          recommendedStaff = Math.max(minStaff, Math.round(predictedRevenue / rps));
        } else if (hasShiftData) {
          // Path B — z_report_shifts: שינוי פרופורציונלי לפי יחס מחזור
          const avgRevenueSeasonal = Math.max(1, globalAvg * seasonalMult);
          const baseSt = shiftStaffMap[dow] ?? shiftStaffGlobalAvg;
          recommendedStaff = Math.max(minStaff, Math.round(baseSt * (predictedRevenue / avgRevenueSeasonal)));
        } else {
          // Path C — ברירת מחדל: יחס עובד לסועד (fallback לעסק ללא נתוני משמרות)
          recommendedStaff = Math.max(minStaff, Math.round(predictedCovers / staffRatio));
        }
      }

      forecast.push({
        date: dateStr, dayName: DAYS_HE[dow], dow, isClosed,
        predictedRevenue, predictedCovers, recommendedStaff,
        cogsTotal:     isClosed ? 0 : Math.round(predictedRevenue * cogsRatio),
        seasonalMult:  parseFloat(seasonalMult.toFixed(2)),
        holidayMult, holidayLabel,
        weatherMult:   parseFloat(weatherMult.toFixed(2)),
        weatherLabel, weatherSeverity, weatherEmoji,
        weatherCode:   w?.code ?? null,
        temperature:   w?.maxTemp ?? null,
        precipitation: w?.precip ?? null,
        windKph:       w?.windKph ?? null,
        humidity:      w?.humidity ?? null,
        confidence:    confidenceLevel,
        lastYearDate:  lastYearDateStr,
        lastYearRevenue: yoyData ? Math.round(yoyData.revenue) : null,
        lastYearCovers:  yoyData ? yoyData.covers : null,
      });
    }

    // ── המלצת הזמנה שבועית ──────────────────────────────────────────────────────────
    const next7       = forecast.slice(0, 7);
    const weekRevenue = next7.reduce((s, d) => s + d.predictedRevenue, 0);
    const weekCogs    = next7.reduce((s, d) => s + d.cogsTotal, 0);

    // forecastLoadFactor: שיעור עומס השבוע הצפוי יחסית לשבוע "רגיל" (DOW-only, ללא עונה/חג/מזג אוויר).
    // מחושב כיחס בתוך SMART_CTE — הטיית הנתונים מצטמצמת כי המונה והמכנה שניהם מטה-נתוני
    // אותה מקור. לדוגמה: חג שממתן 45% ייתן factor=0.45 ללא קשר לרמת ה-bias הכוללת.
    const openForecastDays  = next7.filter(d => !d.isClosed);
    const baselineWeekRev   = openForecastDays.reduce((s, d) => s + (dowMap[d.dow] ?? globalAvg), 0);
    const forecastLoadFactor = baselineWeekRev > 0
      ? Math.min(Math.max(weekRevenue / baselineWeekRev, 0.4), 2.0)
      : 1.0;

    // 'רוחות' (רבים) במקום 'רוח' — מונע התאמה שגויה לפריטים לא-אלכוהוליים
    const CAT_KW = {
      meat:      ['בשר','עוף','כבש','meat','chicken','lamb','beef','turkey','המבורגר','שניצל','כבד','פסטרמה','ריבס','סטייק'],
      fish:      ['דג','fish','סלמון','טונה','פורל','מוסר','בקלה','שרימפס','לוקוס','בריים'],
      produce:   ['ירק','פרי','עלה','ירוק','vegetable','fruit','produce','salad','סלט','עגבניה','מלפפון','חסה','קישוא','עלים'],
      dairy:     ['חלב','גבינה','שמנת','יוגורט','dairy','milk','cheese','cream','butter','לבנה','קשקבל','מוצרלה'],
      dry:       ['יבש','שמור','אורז','פסטה','קמח','dry','pasta','rice','flour','spice','oil','שמן','תבלין','חומוס','טחינה'],
      beverages: ['שתי','בר','מיץ','יין','בירה','קפה','drink','juice','wine','beer','coffee','קוקטייל','משקה','ספריט','ערק','וודקה','אלכוהול','רוחות','סודה','קולה'],
    };

    function classifyInvoiceItem(rawCategory, itemName) {
      for (const [key, kws] of Object.entries(CAT_KW)) {
        if (kws.some(kw => rawCategory.includes(kw) || itemName.includes(kw))) return key;
      }
      return 'dry';
    }

    const orderSuggestion = { meat: 0, fish: 0, produce: 0, dairy: 0, dry: 0, beverages: 0 };
    let orderSuggestionSource = 'estimated';
    let orderSuggestionWeeks  = 0;

    const totalInvoiceSpend  = invoiceItemRows.reduce((s, r) => s + parseFloat(r.avg_weekly_spend), 0);
    const histWeeklyRevenue  = parseFloat(histRevRows[0]?.avg_weekly_revenue) || 0;

    if (totalInvoiceSpend > 0) {
      orderSuggestionSource = 'invoices';
      orderSuggestionWeeks  = invoiceItemRows[0]?.n_weeks || 1;

      // forecastLoadFactor: ratio-based — SMART_CTE bias cancels out because both
      // weekRevenue (with adjustments) and baselineWeekRev use the same biased source.
      for (const row of invoiceItemRows) {
        const key = classifyInvoiceItem(row.raw_category, row.item_name);
        orderSuggestion[key] += parseFloat(row.avg_weekly_spend) * forecastLoadFactor;
      }
      for (const k of Object.keys(orderSuggestion)) {
        orderSuggestion[k] = Math.round(orderSuggestion[k]);
      }
    } else {
      // אין נתוני חשבוניות — לא מחשבים הערכה, מחזירים 'unavailable'.
      // המשתמש יקבל הודעה ברורה במקום מספר שגוי.
      orderSuggestionSource = 'unavailable';
    }

    const lowStock = invRows.filter(i =>
      i.reorder_point && parseFloat(i.quantity) <= parseFloat(i.reorder_point)
    );

    const openDays = next7.filter(d => !d.isClosed);
    res.json({
      forecast,
      summary: {
        weekRevenue, weekCogs,
        peakDay:     openDays.length ? openDays.reduce((max, d) => d.predictedRevenue > max.predictedRevenue ? d : max, openDays[0]) : (next7[0] || null),
        quietDay:    openDays.length ? openDays.reduce((min, d) => d.predictedRevenue < min.predictedRevenue ? d : min, openDays[0]) : (next7[0] || null),
        totalCovers: next7.reduce((s, d) => s + d.predictedCovers, 0),
        avgStaff:    openDays.length ? Math.round(openDays.reduce((s, d) => s + d.recommendedStaff, 0) / openDays.length) : 0,
      },
      orderSuggestion, orderSuggestionSource, orderSuggestionWeeks, histWeeklyRevenue,
      lowStock,
      hasHistoricalData: salesByDow.length > 0,
      cogsRatio: parseFloat(cogsRatio.toFixed(2)),
      staffSource: hasCalibration ? 'shifts' : hasShiftData ? 'z_shifts' : 'ratio',
      calibratedRps: hasCalibration && globalRps ? Math.round(globalRps) : null,
      weatherSource,
      weatherFetchedAt: weather?.cachedAt ?? new Date().toISOString(),
      weatherFromCache: weather?.fromCache ?? false,
      weatherCity,
    });
  } catch (err) { next(err); }
}

// GET /api/forecast/demand — query-string form (legacy)
router.get('/demand', requireAuth, requirePermission('finance'), handleDemandForecast);
// POST /api/forecast/demand — body-based (preferred; avoids URL length limits on complex settings)
router.post('/demand', requireAuth, requirePermission('finance'), handleDemandForecast);

// GET /api/forecast/smart-order?horizon=7
// diagnostic — remove after investigation
router.get('/debug-order', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const [sales7, saleItems7, recipes, recipeIngredients] = await Promise.all([
      db.query(`SELECT COUNT(*) AS cnt, MAX(sold_at) AS latest FROM sales WHERE business_id=$1 AND sold_at >= NOW()-INTERVAL '7 days'`, [businessId]),
      db.query(`SELECT COUNT(*) AS cnt FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.business_id=$1 AND s.sold_at>=NOW()-INTERVAL '7 days' AND si.recipe_id IS NOT NULL`, [businessId]),
      db.query(`SELECT COUNT(*) AS cnt FROM recipes WHERE business_id=$1 AND (is_active IS NULL OR is_active=TRUE)`, [businessId]),
      db.query(`SELECT COUNT(*) AS cnt FROM recipe_ingredients ri JOIN recipes r ON r.id=ri.recipe_id WHERE r.business_id=$1`, [businessId]),
      // sample: actual dish sales last 7 days
    ]);
    const sampleDishes = await db.query(`
      SELECT si.recipe_id, r.name, SUM(si.qty) AS qty
      FROM sale_items si
      JOIN sales s ON s.id=si.sale_id AND s.business_id=$1
      JOIN recipes r ON r.id=si.recipe_id
      WHERE s.sold_at>=NOW()-INTERVAL '7 days' AND si.recipe_id IS NOT NULL
      GROUP BY si.recipe_id, r.name ORDER BY qty DESC LIMIT 10
    `, [businessId]);
    const sampleSalesRaw = await db.query(`
      SELECT pos_sale_id, sold_at, total_amount FROM sales
      WHERE business_id=$1 AND sold_at>=NOW()-INTERVAL '7 days'
      ORDER BY sold_at DESC LIMIT 5
    `, [businessId]);
    res.json({
      sales_last_7d: sales7.rows[0],
      sale_items_with_recipe_last_7d: saleItems7.rows[0].cnt,
      active_recipes: recipes.rows[0].cnt,
      recipe_ingredients_total: recipeIngredients.rows[0].cnt,
      sample_dishes_sold: sampleDishes.rows,
      sample_sales_raw: sampleSalesRaw.rows,
    });
  } catch (err) { next(err); }
});

router.get('/smart-order', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const horizon    = Math.min(Math.max(parseInt(req.query.horizon) || 7, 1), 14);
    const businessId = req.user.businessId;

    // ── 1+2. מכירות בפועל: 30 יום אחרונים + אותה תקופה שנה שעברה (מקביל) ──
    // חלון 30 יום מחושב כממוצע שבועי (÷4.286) — מכלול יותר מנות שנמכרו לאחרונה.
    const WINDOW_DAYS = 30;
    const WEEKS_IN_WINDOW = WINDOW_DAYS / 7; // ≈4.286

    // הערה: sale_items מהדוחות-ז מגיעים עם recipe_id=NULL אבל עם שם מנה.
    // אנו מחפשים מתכון גם לפי recipe_id וגם לפי שם (ILIKE) כדי לכלול הכל.
    const [{ rows: lastWeekRows }, { rows: yoyRows }] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(si.recipe_id, r_name.id)              AS recipe_id,
          COALESCE(r_direct.name, r_name.name)            AS dish_name,
          SUM(si.qty)::float                              AS total_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.business_id = $1
        LEFT JOIN recipes r_direct
          ON r_direct.id = si.recipe_id AND r_direct.business_id = $1
        LEFT JOIN recipes r_name
          ON si.recipe_id IS NULL
          AND LOWER(TRIM(r_name.name)) = LOWER(TRIM(si.name))
          AND r_name.business_id = $1
        WHERE s.sold_at >= NOW() - INTERVAL '30 days'
          AND (si.recipe_id IS NOT NULL OR r_name.id IS NOT NULL)
        GROUP BY COALESCE(si.recipe_id, r_name.id), COALESCE(r_direct.name, r_name.name)
        HAVING SUM(si.qty) > 0
        ORDER BY total_sold DESC
      `, [businessId]),

      db.query(`
        SELECT
          COALESCE(si.recipe_id, r_name.id)  AS recipe_id,
          SUM(si.qty)::float                  AS total_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.business_id = $1
        LEFT JOIN recipes r_name
          ON si.recipe_id IS NULL
          AND LOWER(TRIM(r_name.name)) = LOWER(TRIM(si.name))
          AND r_name.business_id = $1
        WHERE s.sold_at >= (NOW() - INTERVAL '1 year') - INTERVAL '30 days'
          AND s.sold_at <  (NOW() - INTERVAL '1 year')
          AND (si.recipe_id IS NOT NULL OR r_name.id IS NOT NULL)
        GROUP BY COALESCE(si.recipe_id, r_name.id)
        HAVING SUM(si.qty) > 0
      `, [businessId]).catch(() => ({ rows: [] })),
    ]);

    if (lastWeekRows.length === 0) {
      return res.json({
        horizon, dishes: [], orderList: [], dishTrends: [],
        insights: [{ type: 'info', icon: '📊', title: 'אין נתוני מכירות מנות',
          text: 'לא נמצאו מכירות מנות ב-30 הימים האחרונים. ודא שמכירות מקושרות למתכונים.' }],
        totalOrderCost: 0, itemsToOrder: 0, criticalCount: 0,
      });
    }

    // ── בנה כמויות: ממוצע שבועי מ-30 יום + 30% שנה שעברה (אם קיים) ──
    const yoyMap = {};
    yoyRows.forEach(r => { yoyMap[r.recipe_id] = parseFloat(r.total_sold) / WEEKS_IN_WINDOW; });

    const dishQuantities = {};
    lastWeekRows.forEach(row => {
      const avgWeekQty = parseFloat(row.total_sold) / WEEKS_IN_WINDOW;
      const yoyQty     = yoyMap[row.recipe_id] ?? null;
      const blended    = yoyQty !== null ? avgWeekQty * 0.7 + yoyQty * 0.3 : avgWeekQty;
      dishQuantities[row.recipe_id] = {
        name: row.dish_name, lastWeekQty: parseFloat(row.total_sold), avgWeekQty,
        predicted: Math.ceil(blended),
      };
    });

    // ── 3. מרכיבים + מגמות (מקביל) ──
    const recipeIds = Object.keys(dishQuantities);

    const [{ rows: ingredientRows }, { rows: trendRows }, { rows: actualUsageRows }] = await Promise.all([
      db.query(`
        WITH combined AS (
          SELECT
            r_sold.id                             AS sold_recipe_id,
            ri.item_id                            AS inventory_item_id,
            ri.qty::float                         AS qty_per_dish,
            COALESCE(ri.manual_name, ii.name)     AS ingredient_name,
            COALESCE(ii.current_qty, 0)::float    AS current_stock,
            COALESCE(ii.min_qty, 0)::float        AS min_qty,
            COALESCE(ii.max_qty, 0)::float        AS max_qty,
            COALESCE(ri.unit, ii.unit, '')        AS unit,
            COALESCE(ic.name, 'כללי')             AS category,
            COALESCE(ii.cost_per_unit, ri.manual_cost::float, 0) AS cost_per_unit
          FROM recipes r_sold
          JOIN recipes r_template
            ON LOWER(TRIM(r_template.name)) = LOWER(TRIM(r_sold.name))
           AND r_template.id != r_sold.id
           AND r_template.business_id = r_sold.business_id
          JOIN recipe_ingredients ri ON ri.recipe_id = r_template.id
          LEFT JOIN inventory_items ii  ON ii.id  = ri.item_id
          LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
          WHERE r_sold.id = ANY($1)
          UNION ALL
          SELECT
            ri2.recipe_id                         AS sold_recipe_id,
            ri2.item_id                           AS inventory_item_id,
            ri2.qty::float                        AS qty_per_dish,
            COALESCE(ri2.manual_name, ii2.name)   AS ingredient_name,
            COALESCE(ii2.current_qty, 0)::float   AS current_stock,
            COALESCE(ii2.min_qty, 0)::float       AS min_qty,
            COALESCE(ii2.max_qty, 0)::float       AS max_qty,
            COALESCE(ri2.unit, ii2.unit, '')      AS unit,
            COALESCE(ic2.name, 'כללי')            AS category,
            COALESCE(ii2.cost_per_unit, ri2.manual_cost::float, 0) AS cost_per_unit
          FROM recipe_ingredients ri2
          LEFT JOIN inventory_items ii2  ON ii2.id  = ri2.item_id
          LEFT JOIN inventory_categories ic2 ON ic2.id = ii2.category_id
          WHERE ri2.recipe_id = ANY($1)
        )
        SELECT sold_recipe_id, inventory_item_id,
               MAX(qty_per_dish) AS qty_per_dish, ingredient_name,
               MAX(current_stock) AS current_stock, MAX(min_qty) AS min_qty,
               MAX(max_qty) AS max_qty, MAX(unit) AS unit,
               MAX(category) AS category, MAX(cost_per_unit) AS cost_per_unit
        FROM combined
        GROUP BY sold_recipe_id, inventory_item_id, ingredient_name
      `, [recipeIds]),

      // מגמות: שבוע אחרון vs שבוע לפניו — ישירות מ-sale_items (ללא SMART_CTE)
      db.query(`
        SELECT r.name,
               SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '7 days'
                         THEN si.qty ELSE 0 END)::float AS recent,
               SUM(CASE WHEN s.sold_at <  NOW() - INTERVAL '7 days'
                         AND  s.sold_at >= NOW() - INTERVAL '14 days'
                         THEN si.qty ELSE 0 END)::float AS previous
        FROM sale_items si
        JOIN sales   s ON s.id = si.sale_id AND s.business_id = $1
        JOIN recipes r ON r.id = si.recipe_id
                       AND (r.is_active IS NULL OR r.is_active = TRUE)
        WHERE si.recipe_id IS NOT NULL
          AND s.sold_at >= NOW() - INTERVAL '14 days'
        GROUP BY r.name
        HAVING SUM(si.qty) > 0
          AND SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '7 days' THEN si.qty ELSE 0 END) > 0
        ORDER BY recent DESC LIMIT 12
      `, [businessId]).catch(() => ({ rows: [] })),

      // ── Actual stock movement: what genuinely left the shelf ──────────────
      // The recipe maths above is a model — dish sold x quantity per dish. It
      // misses anything not linked to a recipe (drinks, sides, packaging) and
      // inherits every gap in the recipe definitions. inventory_transactions
      // rows of type 'sale' are written by decrementInventoryFromZItems as
      // each Z-report is imported, so they are the measured truth for items
      // that are actually stock-managed. Rate is per OPERATING day — dividing
      // by 30 would understate a business that trades five days a week.
      db.query(`
        SELECT
          it.item_id,
          ii.name,
          ii.unit,
          COALESCE(ii.current_qty, 0)::float                     AS current_stock,
          COALESCE(ii.min_qty, 0)::float                         AS min_qty,
          COALESCE(ii.max_qty, 0)::float                         AS max_qty,
          COALESCE(ii.cost_per_unit, 0)::float                   AS cost_per_unit,
          COALESCE(ic.name, 'כללי')                              AS category,
          SUM(ABS(it.qty_change))::float                         AS total_used,
          COUNT(DISTINCT DATE(it.created_at AT TIME ZONE 'Asia/Jerusalem'))::int AS active_days
        FROM inventory_transactions it
        JOIN inventory_items ii ON ii.id = it.item_id
        LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
        WHERE it.business_id = $1
          AND it.type = 'sale'
          AND it.created_at >= NOW() - INTERVAL '30 days'
          AND (ii.is_active IS NULL OR ii.is_active = TRUE)
        GROUP BY it.item_id, ii.name, ii.unit, ii.current_qty, ii.min_qty, ii.max_qty, ii.cost_per_unit, ic.name
        HAVING SUM(ABS(it.qty_change)) > 0
      `, [businessId]).catch(() => ({ rows: [] })),
    ]);

    // ── 4. צבירת צורך לפי כמויות בפועל ──
    // Recipe-derived need, kept only for ingredients that map to a real
    // inventory item. A recipe ingredient with no item_id is free text
    // ("בשר בקר", "ירקות טריים") — it has no stock level, no cost and no
    // supplier, so there is nothing coherent to order against it. Those used
    // to appear in the order list looking like real line items; they are now
    // collected separately and reported as a setup gap instead.
    const ingredientNeeds = {};
    const unlinkedIngredients = new Set();
    ingredientRows.forEach(row => {
      if (!row.inventory_item_id) {
        if (row.ingredient_name) unlinkedIngredients.add(row.ingredient_name);
        return;
      }
      const qty = dishQuantities[row.sold_recipe_id]?.predicted || 0;
      const key = row.inventory_item_id;
      if (!ingredientNeeds[key]) {
        ingredientNeeds[key] = {
          name: row.ingredient_name, unit: row.unit, category: row.category,
          currentStock: row.current_stock, totalNeeded: 0, costPerUnit: row.cost_per_unit,
          minQty: row.min_qty, maxQty: row.max_qty, source: 'recipe',
        };
      }
      ingredientNeeds[key].totalNeeded += qty * row.qty_per_dish;
    });

    // ── 4b. Override with measured consumption where we have it ──────────────
    // horizon is in days; the recipe path above works in whole weeks, so
    // convert the measured per-operating-day rate over the same window.
    const horizonDays = Math.max(1, parseInt(horizon) || 7);
    let measuredCount = 0;
    actualUsageRows.forEach(row => {
      const activeDays = Math.max(1, parseInt(row.active_days));
      const perDay     = parseFloat(row.total_used) / activeDays;
      const needed     = perDay * horizonDays;
      const key        = row.item_id;
      measuredCount++;
      if (ingredientNeeds[key]) {
        // Both sources agree this item exists — trust what actually moved,
        // and label it with the inventory item's own name. The recipe path
        // may carry a generic template name ("אורז") where the thing being
        // ordered is a specific SKU ("אורז יסמין שוקחה 5 קג").
        ingredientNeeds[key].totalNeeded = needed;
        ingredientNeeds[key].source      = 'measured';
        ingredientNeeds[key].name        = row.name;
        ingredientNeeds[key].unit        = row.unit;
        ingredientNeeds[key].category    = row.category;
      } else {
        // Consumed but absent from the recipe model — drinks, sides and
        // anything else whose recipe links are incomplete. Real demand the
        // theoretical calculation could never see.
        ingredientNeeds[key] = {
          name: row.name, unit: row.unit, category: row.category,
          currentStock: row.current_stock, totalNeeded: needed,
          costPerUnit: row.cost_per_unit, minQty: row.min_qty, maxQty: row.max_qty,
          source: 'measured',
        };
      }
    });

    // ── 5. רשימת הזמנה ──
    // אם הוגדר max_qty: הזמן כדי לכסות צריכה + למלא חזרה לרמת מקסימום
    //   orderQty = max(0, צריכה + max_qty - מלאי_נוכחי)
    // אחרת: הזמן את כמות הצריכה + 10% בטחון
    const orderList = [];
    for (const [, item] of Object.entries(ingredientNeeds)) {
      const consumption = item.totalNeeded;
      let orderQty;
      if (item.maxQty > 0) {
        // כסה את הצריכה השבועית + חדש את המלאי עד רמת המקסימום
        orderQty = parseFloat(Math.max(0, consumption + item.maxQty - item.currentStock).toFixed(3));
      } else {
        // Deduct what is already on the shelf. This branch used to order the
        // full forecast consumption regardless of current stock, so an item
        // with 99 units in hand and 7 units of expected demand was still put
        // on the order list. Only the shortfall is worth ordering, plus 10%
        // headroom against the forecast being light.
        orderQty = parseFloat(Math.max(0, consumption * 1.10 - item.currentStock).toFixed(3));
      }
      const estimatedCost = parseFloat((orderQty * item.costPerUnit).toFixed(2));
      const hasPrice = item.costPerUnit > 0;
      // מרכיבים עם מחיר: סנן רק אם עלות זניחה; מרכיבים ידניים (ללא מחיר): תמיד הכלל
      // Nothing to order is not a line item — current stock already covers
      // the forecast for this one.
      if (orderQty <= 0) continue;
      if (hasPrice && estimatedCost < 1) continue;
      if (!item.name) continue;
      orderList.push({
        name: item.name, unit: item.unit, category: item.category,
        currentStock:      parseFloat(item.currentStock.toFixed(2)),
        neededForForecast: parseFloat(consumption.toFixed(2)),
        minQty: item.minQty, maxQty: item.maxQty,
        orderQty, estimatedCost, hasPrice,
        // 'measured' = derived from stock actually deducted by Z-report
        // imports; 'recipe' = theoretical dish x quantity-per-dish.
        source: item.source || 'recipe',
        urgency: item.currentStock < consumption ? 'high' : 'normal',
      });
    }
    orderList.sort((a, b) => b.estimatedCost - a.estimatedCost);

    // ── 6. מגמות ──
    const dishTrends = trendRows
      .filter(r => (r.previous || 0) > 0)
      .map(r => {
        const recent   = r.recent   || 0;
        const previous = r.previous || 0;
        const change   = ((recent - previous) / previous) * 100;
        return {
          name: r.name, recentQty: Math.round(recent), previousQty: Math.round(previous),
          changePct: parseFloat(change.toFixed(1)),
          trend: change > 15 ? 'rising' : change < -15 ? 'falling' : 'stable',
        };
      });

    // ── 7. תובנות ──
    const insights = [];
    const totalCost     = orderList.reduce((s, i) => s + i.estimatedCost, 0);
    const criticalItems = orderList.filter(i => i.urgency === 'critical');
    const risingDishes  = dishTrends.filter(d => d.trend === 'rising').slice(0, 3);
    const fallingDishes = dishTrends.filter(d => d.trend === 'falling').slice(0, 3);
    const hasYoy        = yoyRows.length > 0;

    if (criticalItems.length > 0) insights.push({ type: 'critical', icon: '🚨', title: 'מלאי אפסי — דחוף!',
      text: `${criticalItems.map(i => i.name).join(', ')} — אין מלאי כלל. הזמן לפני תחילת הפעילות!` });

    if (orderList.length > 0) insights.push({ type: 'order', icon: '📦', title: 'המלצת הזמנה',
      text: `מבוסס על ${lastWeekRows.length} סוגי מנות (ממוצע שבועי מ-30 יום)${hasYoy ? ' + נתוני שנה שעברה' : ''} — עלות חומרי גלם צפויה${totalCost > 0 ? ` ₪${Math.ceil(totalCost).toLocaleString()}` : ''}.` });

    if (ingredientRows.length === 0 && recipeIds.length > 0) insights.push({ type: 'info', icon: '⚠️', title: 'מרכיבים חסרים',
      text: 'המנות שנמכרו אינן מקושרות למרכיבים במלאי. הוסף מרכיבים למתכונים כדי לקבל המלצת הזמנה.' });

    // Say plainly what the recommendation rests on, and name the ingredients
    // that were excluded — silently dropping them would trade one wrong answer
    // for a quietly incomplete one.
    if (measuredCount > 0) insights.push({ type: 'stock_ok', icon: '🎯', title: 'מבוסס על ירידת מלאי בפועל',
      text: `${measuredCount} פריטים חושבו לפי הכמות שירדה מהמלאי בפועל מדוחות ה-Z של 30 הימים האחרונים, ולא לפי חישוב תיאורטי של מתכונים.` });

    if (unlinkedIngredients.size > 0) insights.push({ type: 'info', icon: '🔗', title: 'מרכיבים לא מקושרים למלאי',
      text: `${[...unlinkedIngredients].join(', ')} — מרכיבים אלה רשומים במתכונים כטקסט חופשי ואינם פריטי מלאי, ולכן לא ניתן לחשב עבורם הזמנה. קשר אותם לפריט מלאי כדי שייכללו.` });

    if (orderList.length === 0 && ingredientRows.length > 0) insights.push({ type: 'stock_ok', icon: '✅', title: 'מלאי מספיק לשבוע הבא',
      text: `המלאי הנוכחי מכסה את הצורך הצפוי עבור ${lastWeekRows.length} סוגי מנות (ממוצע 30 יום). אין צורך להזמין כרגע.` });

    if (risingDishes.length > 0) insights.push({ type: 'rising', icon: '📈', title: 'ביקוש עולה',
      text: `${risingDishes.map(d => `${d.name} (+${d.changePct}%)`).join(', ')} — הזמן מלאי נוסף.` });

    if (fallingDishes.length > 0) insights.push({ type: 'falling', icon: '📉', title: 'ביקוש יורד',
      text: `${fallingDishes.map(d => `${d.name} (${d.changePct}%)`).join(', ')} — הזמן פחות כדי למנוע בזבוז.` });

    const allDishes = Object.values(dishQuantities)
      .sort((a, b) => b.lastWeekQty - a.lastWeekQty);
    // The "מנות שנמכרו השבוע" insight was dropped on request: it listed every
    // dish sold in one long line, duplicating what the sales screens already
    // show and pushing the actual order recommendation down the page. The
    // dishes array is still returned for callers that want the raw numbers.

    res.json({
      horizon, dishes: allDishes, orderList, dishTrends, insights,
      totalOrderCost: Math.ceil(totalCost),
      itemsToOrder:   orderList.length,
      criticalCount:  criticalItems.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
