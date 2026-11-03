/**
 * Z Report Import Service
 * מייבא דוחות Z מכל סוגי הקבצים האפשריים:
 * EML, XLSX, XLS, CSV, PDF, TXT, HTML, HTM, XML, JSON, ZIP
 * מכניס נתונים לטבלאות sales + sale_items
 */

const XLSX      = require('xlsx');
const path      = require('path');
const crypto    = require('crypto');
const sharp     = require('sharp');
const iconv     = require('iconv-lite');
const { XMLParser: FastXMLParser } = require('fast-xml-parser');
const db        = require('../utils/db');
const { INGREDIENT_SOURCE_CTE } = require('../utils/ingredientSource');
const { resolveFallbackDeduction } = require('../utils/salesNameFallback');
const { withTransaction } = require('../utils/transaction');
const logger    = require('../utils/logger');
const eventBus  = require('../utils/eventBus');
const Anthropic = require('@anthropic-ai/sdk');
const { logTokenUsage } = require('../utils/logTokenUsage');
const { createWithRetry } = require('../utils/anthropicRetry');

// z_report_shifts had no unique constraint at all — two concurrent imports
// for the same business (scheduled fetch overlapping a manual click, or two
// browser tabs re-uploading the same file) could both pass the pre-insert
// "does this (name, date) already exist?" check and both insert a shift row,
// silently doubling that employee's counted hours for payroll. Combined with
// the advisory lock in importToDatabase() below (which prevents the race in
// the first place) this is defense-in-depth against any other insert path.
db.migrate(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_zreport_shifts_biz_name_date_unique
    ON z_report_shifts (business_id, LOWER(employee_name), report_date);
`).catch(() => {});

// ── Format learning: fingerprint an unrecognized layout once, reuse forever ──
// A POS export's *shape* (sheet names + column headers) is a property of the
// POS software, not of any one business — global (not per-business) so every
// business benefits the moment ANY business's file teaches the system a new
// vendor's layout. Only structural metadata is stored (sheet/column names),
// never business data.
db.migrate(`
  CREATE TABLE IF NOT EXISTS z_report_formats (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint       VARCHAR(64) NOT NULL UNIQUE,
    schema            JSONB NOT NULL,
    confidence        VARCHAR(20) NOT NULL DEFAULT 'ai_auto',
    sample_filename   VARCHAR(255),
    first_business_id UUID,
    times_used        INT NOT NULL DEFAULT 1,
    last_used_at      TIMESTAMPTZ DEFAULT NOW(),
    created_at        TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_zrf_fingerprint ON z_report_formats(fingerprint)`);

// Ensure payment breakdown columns exist on the sales table
db.migrate(`
  ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS cash_amount         NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS credit_amount       NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wolt_amount         NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ten_bis_amount      NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_amount     NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cancellation_amount NUMERIC DEFAULT 0
`);
// Extended payment channels (dejavoo, sodexo, goodi, etc.) stored as flexible JSONB
// so adding new payment methods never requires a schema migration.
db.migrate(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_breakdown JSONB DEFAULT '{}'`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── חילוץ Excel מ-EML ─────────────────────────────────────────
// A forwarded email thread (each reply/forward wraps the previous message as
// a nested message/rfc822 attachment) can carry MANY xlsx attachments — one
// per historical Z-report in the chain, sometimes dozens deep. The previous
// implementation recursed once per nesting level using boundary-based string
// splitting, which both (a) genuinely stack-overflowed on a real ~20-forward
// thread, and (b) even when it didn't crash, returned only the FIRST xlsx
// found and silently discarded every other real report in the thread.
//
// This scans the whole raw content once for every xlsx Content-Type marker
// regardless of nesting depth — flat, non-recursive, and returns ALL of them
// so every Z-report in a forwarded thread gets imported, not just one.
function extractXlsxFromEml(emlBuffer) {
  const content = emlBuffer.toString('binary');
  const buffers = _findAllXlsxParts(content);
  if (!buffers.length) throw new Error('לא נמצא קובץ Excel ב-EML');
  return buffers;
}

// Matches both XLSX (Office Open XML) and legacy XLS/CSV MIME types from EML attachments
const XLSX_PART_RE = /Content-Type:\s*(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel|text\/csv)[\s\S]*?\r?\n\r?\n/gi;
// Guards against a pathological input (e.g. no real boundaries at all) turning this into an unbounded scan
const MAX_XLSX_PARTS = 200;

function _findAllXlsxParts(content) {
  const results = [];
  XLSX_PART_RE.lastIndex = 0;
  let m;
  while ((m = XLSX_PART_RE.exec(content)) !== null && results.length < MAX_XLSX_PARTS) {
    const bodyStart = m.index + m[0].length;
    // The base64 body runs until the next MIME boundary line ("--...") or end of content
    const boundaryEnd = content.indexOf('\r\n--', bodyStart);
    const bodyEnd = boundaryEnd === -1 ? content.length : boundaryEnd;
    const b64 = content.slice(bodyStart, bodyEnd).replace(/[\r\n]/g, '');
    try {
      const buf = Buffer.from(b64, 'base64');
      // Sanity-check the decoded bytes are actually a ZIP/OOXML file (magic
      // "PK") before trusting them — a malformed match here would otherwise
      // silently hand garbage bytes to the xlsx parser downstream.
      if (buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4B) results.push(buf);
    } catch { /* skip an unparseable match, keep scanning for others */ }
  }
  return results;
}

// ── פרסור ה-Excel ──────────────────────────────────────────────
function parseZReportExcel(xlsxBuffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  const wb = XLSX.read(xlsxBuffer, { type: 'buffer', cellDates: true });

  const result = {
    zReports:     [],           // פירוט לפי Z
    items:        [],           // פריטים (Z אחרון בלבד)
    shifts:       [],           // משמרות
    _sheetsFound: wb.SheetNames, // לדיבוג — שמות הגיליונות בקובץ
  };

  // גיליון: פירוט לפי Z — מחפש בשמות אפשריים שונים
  const Z_SHEET_NAMES = ['פירוט לפי Z', 'דוחות Z', 'z reports', 'Z Reports', 'דוח Z', 'zreports', 'reports'];
  const zSheetName = wb.SheetNames.find(sn => Z_SHEET_NAMES.some(n => n.toLowerCase() === sn.toLowerCase().trim()));

  if (zSheetName) {
    const ws   = wb.Sheets[zSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const headers = (rows[0] || []).map(h => String(h || '').trim().toLowerCase());

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const zNumRaw = row[0];
      const zNum = _num(zNumRaw);
      if (zNumRaw === '' || zNumRaw == null || String(zNumRaw).trim() === 'סה"כ' || zNum < 0) continue;

      const fromDate = _parseDate(row[1]);
      const toDate   = _parseDate(row[2]) || fromDate;
      if (!fromDate) continue;

      result.zReports.push({
        zNumber:          zNum,
        fromDate,
        toDate,
        total:            _num(row[3]),
        totalNoVat:       _num(row[4]),
        vat:              _num(row[5]),
        avgPerOrder:      _num(row[7]),
        ordersCount:      _num(row[9]),
        cash:             _sumCols(row, headers, ['מזומן','cash','מזומן כולל','סהכ מזומן']) || _num(row[12]),
        credit:           _sumCols(row, headers, ['dejavoo','אשראי חיצוני','אשראי','credit','כרטיס אשראי']),
        wolt:             _sumCols(row, headers, ['wolt','וולט']),
        tenBis:           _sumCols(row, headers, ['תן ביס','ten bis','tenbis','10bis','תן-ביס']),
        discount:         _sumCols(row, headers, ['הנחות','הנחה','discount','discounts','מבצעים','הנחה מיוחדת']),
        cancellation:     _sumCols(row, headers, ['ביטולים','ביטול','cancellations','cancellation','voids','void','ביטולים וזיכויים','זיכויים','ביטול עסקה']),
        paymentBreakdown: _buildPaymentBreakdown(row, headers),
      });
    }
  }

  // fallback: אם לא נמצא גיליון Z מוכר — נסה לפרסר כל גיליון כטבלה שטוחה
  if (result.zReports.length === 0) {
    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const parsed = _parseFlatTable(rows, vatDivisor);
      if (parsed.zReports.length > 0) {
        result.zReports = parsed.zReports;
        break;
      }
    }
  }

  // גיליון: פריטים (Z אחרון) — ניסיון על שמות שונים
  result.items = _extractItemsFromWorkbook(wb);

  // גיליון: משמרות — ניסיון על שמות שונים
  const SHIFT_SHEET_NAMES = ['משמרות', 'Shifts', 'shifts', 'שעות', 'עובדים', 'Staff', 'Hours'];
  const shiftSheetName = wb.SheetNames.find(sn => SHIFT_SHEET_NAMES.some(n => n.toLowerCase() === sn.toLowerCase().trim()));
  if (shiftSheetName) {
    const ws   = wb.Sheets[shiftSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    result.shifts = _parseShiftRows(rows);
  }

  // אם אין גיליון משמרות ייעודי — נסה לחלץ משמרות מגיליונות אחרים
  if (result.shifts.length === 0) {
    for (const sheetName of wb.SheetNames) {
      const _lcSN = sheetName.trim().toLowerCase();
      if (sheetName === zSheetName || _ITEMS_SHEET_NAMES_LC.has(_lcSN) || _ITEMS_SHEET_KEYWORDS.some(kw => _lcSN.includes(kw)) || sheetName === shiftSheetName) continue;
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
      const candidates = _parseShiftRows(rows);
      if (candidates.length > 0) { result.shifts = candidates; break; }
    }
  }

  return result;
}

// Patterns that identify sale_item names that are NOT actual dishes.
// Covers POS modifier prompts, responses, payment labels, Z-report rows,
// and common customer-facing confirmation strings ("כן בבקשה", "בלי בצל", etc.).
const _NON_DISH_NAME_PATTERNS = [
  // Customer responses / modifiers
  /^כן\b/,          // "כן", "כן בבקשה", "כן תודה"
  /^לא\b/,          // "לא", "לא תודה", "לא בצל"
  /^בבקשה$/,
  /^תודה\b/,
  /^בלי\b/,         // "בלי בצל", "בלי גלוטן"
  /^ללא\b/,         // "ללא לקטוז"
  /^בנוסף\b/,
  /^הוספה\b/,       // "הוספה" — add-on item marker
  /^תוספת\b/,       // "תוספת"
  /^הערה\b/,        // free-text note
  /^הנחה\b/,        // discount line
  /^ביטול\b/,
  /^זיכוי\b/,
  /^החזר\b/,
  /^שינוי\b/,
  // Payment types that appear as sale_items in some POS systems
  /^מזומן$/,
  /^אשראי$/,
  /^וולט$/,
  /^תן.?ביס$/,
  /^ביט$/,
  /^פייבוקס$/,
  /^העברה$/,
  /^שובר(ים)?$/,
  /^משלוח(ה)?$/,
  // Z-report summary markers
  /^z-/i,
  /^סה.?כ/,
  /^מע.?מ/,
  /^ריכוז\b/,
  /^דוח\b/,
  /^סיכום\b/,
  /^total\b/i,
  /^subtotal\b/i,
];

function _isValidDishName(name) {
  if (!name) return false;
  const t = name.trim();
  if (t.length < 2) return false;                  // too short
  if (/^\d+([.,]\d+)?$/.test(t)) return false;     // pure number
  // "no letters at all" — MUST use \p{L} with the u flag, not [\W\d].
  //
  // This guard was written as /^[\W\d]+$/ and that rejected EVERY Hebrew name:
  // in JS without /u, \w is [A-Za-z0-9_], so every Hebrew letter counts as \W
  // and "שניצל" looks like "no letters at all". Effect on production: from the
  // moment the filter was added (6.8.2026) NOT ONE dish was auto-created from a
  // Z report in ANY business — verified, 0 rows after that timestamp across all
  // 7 businesses, last dish ever created 5.8.2026. A new business importing its
  // first Z report got an empty dishes page and therefore never deducted stock.
  if (!/\p{L}/u.test(t)) return false;
  return !_NON_DISH_NAME_PATTERNS.some(p => p.test(t));
}

// ── סנכרון מנות מ-sale_items שבDB ────────────────────────────
// רץ תמיד — עובד גם כשדוחות Z כבר יובאו, וגם בכל נתיב ייבוא (upload/IMAP/email)
async function _syncDishesFromSaleItems(businessId) {
  // מגבלת 90 יום — מונע יצירת מנות-רפאים מהיסטוריה ישנה
  const { rows: saleItems } = await db.query(
    `SELECT regexp_replace(trim(lower(si.name)), '\\s+', ' ', 'g') AS lname,
            MIN(trim(si.name)) AS name, AVG(si.unit_price)::float AS avg_price
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id AND s.business_id = $1
     WHERE si.name IS NOT NULL AND TRIM(si.name) != ''
       AND s.sold_at >= NOW() - INTERVAL '90 days'
     GROUP BY regexp_replace(trim(lower(si.name)), '\\s+', ' ', 'g')`,
    [businessId]
  );
  if (!saleItems.length) return;

  // Filter out names that are clearly not dishes (modifiers, payment labels, responses, etc.)
  const validItems = saleItems.filter(r => _isValidDishName(r.name));
  if (validItems.length < saleItems.length) {
    logger.debug('[SyncDishes] filtered non-dish names', {
      businessId,
      removed: saleItems.length - validItems.length,
      examples: saleItems.filter(r => !_isValidDishName(r.name)).slice(0, 5).map(r => r.name),
    });
  }
  const filteredItems = validItems;

  const lnames = filteredItems.map(r => r.lname);

  // (א) צור מנות חסרות — רק אם אין מנה פעילה או ארכיבית עם אותו שם (normalized)
  const { rows: existDishes } = await db.query(
    `SELECT regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') AS lname
     FROM dishes WHERE business_id = $1
       AND regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') = ANY($2::text[])`,
    [businessId, lnames]
  );
  const existDishSet = new Set(existDishes.map(r => r.lname));
  const newDishes = filteredItems.filter(r => !existDishSet.has(r.lname));
  if (newDishes.length) {
    const vals = newDishes.map((_, i) => `($1, $${i*2+2}, $${i*2+3})`).join(', ');
    await db.query(
      `INSERT INTO dishes (business_id, name, selling_price) VALUES ${vals}`,
      [businessId, ...newDishes.flatMap(r => [r.name, r.avg_price || 0])]
    ).catch(() => {});
  }

  // (ב) קבע אילו שמות יש להם בפועל מנה פעילה עכשיו (כולל אלו שנוצרו הרגע
  // ב-(א)) — recipe נוצר/מקושר רק לשמות האלה. שם בלי מנה פעילה תואמת לא
  // מקבל recipe עצמאי: זה בדיוק מה שיצר בעבר "מנות-רפאים" — recipes בלי
  // dish תואם, בלי עלות מוגדרת, שלא מופיעות בכלל בעמוד המנות ואי אפשר
  // למחוק/לנהל אותן משם, אבל ממשיכות "לחיות" לצמיתות בדוחות ותובנות.
  const { rows: activeDishNames } = await db.query(
    `SELECT regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') AS lname FROM dishes
     WHERE business_id = $1
       AND regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') = ANY($2::text[])
       AND (is_active IS NULL OR is_active = TRUE)`,
    [businessId, lnames]
  );
  const activeDishSet = new Set(activeDishNames.map(r => r.lname));
  const syncableItems = filteredItems.filter(r => activeDishSet.has(r.lname));
  if (!syncableItems.length) return;
  const syncableLnames = syncableItems.map(r => r.lname);

  // (ג) צור recipes חסרות — רק עבור שמות עם מנה פעילה תואמת, ורק אם אין
  // recipe פעילה עם אותו שם
  const { rows: existRecipes } = await db.query(
    `SELECT id, regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') AS lname FROM recipes
     WHERE business_id = $1
       AND regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') = ANY($2::text[])
       AND (is_active IS NULL OR is_active = TRUE)`,
    [businessId, syncableLnames]
  );
  const recipeIdMap = Object.fromEntries(existRecipes.map(r => [r.lname, r.id]));
  const newRecipes = syncableItems.filter(r => !recipeIdMap[r.lname]);
  if (newRecipes.length) {
    const vals = newRecipes.map((_, i) => `($1, $${i*2+2}, $${i*2+3})`).join(', ');
    const { rows: inserted } = await db.query(
      `INSERT INTO recipes (business_id, name, selling_price) VALUES ${vals}
       RETURNING id, regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') AS lname`,
      [businessId, ...newRecipes.flatMap(r => [r.name, r.avg_price || 0])]
    ).catch(() => ({ rows: [] }));
    (inserted || []).forEach(r => { recipeIdMap[r.lname] = r.id; });
  }

  // (ד) קשר recipe_id על כל sale_items קיימים עם NULL — רק לשמות הסונכרנים
  // מגבלת 90 יום עקבית עם שאר השלבים ומונעת full-history scan
  if (Object.keys(recipeIdMap).length) {
    await db.query(
      `UPDATE sale_items SET recipe_id = m.rid
       FROM (SELECT unnest($1::uuid[]) AS rid, unnest($2::text[]) AS lname) m
       WHERE sale_items.sale_id IN (
         SELECT id FROM sales WHERE business_id = $3 AND sold_at >= NOW() - INTERVAL '90 days'
       )
         AND regexp_replace(trim(lower(sale_items.name)), '\\s+', ' ', 'g') = m.lname
         AND sale_items.recipe_id IS NULL`,
      [Object.values(recipeIdMap), Object.keys(recipeIdMap), businessId]
    ).catch(() => {});
  }

  // (ה) Fuzzy fallback — for sale_items still without recipe_id, use pg_trgm similarity
  // against active recipes. Threshold 0.45 is intentionally generous: false positives
  // are harmless (a wrong match shows unexpected leakage warnings), while false negatives
  // mean the ingredient cost goes untracked entirely. The DISTINCT ON keeps only the
  // best-scoring recipe per sale_item so there's never ambiguity.
  try {
    await db.query(`
      UPDATE sale_items si
      SET recipe_id = matches.recipe_id
      FROM (
        SELECT DISTINCT ON (si2.id)
          si2.id AS sale_item_id,
          r.id   AS recipe_id
        FROM sale_items si2
        JOIN sales s ON s.id = si2.sale_id AND s.business_id = $1
        JOIN recipes r ON r.business_id = $1 AND (r.is_active IS NULL OR r.is_active = TRUE)
        WHERE si2.recipe_id IS NULL
          AND s.sold_at >= NOW() - INTERVAL '90 days'
          AND si2.name IS NOT NULL
          AND similarity(
                regexp_replace(trim(lower(si2.name)), '\\s+', ' ', 'g'),
                regexp_replace(trim(lower(r.name)),   '\\s+', ' ', 'g')
              ) > 0.65
        ORDER BY si2.id,
                 similarity(
                   regexp_replace(trim(lower(si2.name)), '\\s+', ' ', 'g'),
                   regexp_replace(trim(lower(r.name)),   '\\s+', ' ', 'g')
                 ) DESC
      ) matches
      WHERE si.id = matches.sale_item_id
    `, [businessId]);
  } catch (e) {
    logger.debug('[SyncDishes] fuzzy similarity fallback skipped', { err: e.message });
  }
}

// ── שמירה ל-DB (batch — one round-trip per operation) ─────────
// Serializes concurrent imports for the same business — without this, two
// overlapping calls (the scheduled Gmail/IMAP fetch racing a manual click,
// or two browser tabs re-uploading the same file) both run the "does this
// already exist?" pre-check before either commits its INSERT, so both can
// see lastZIsNew=true for the same brand-new Z-report and both proceed to
// decrementInventoryFromZItems — double-decrementing raw-material stock for
// a single real-world report.
async function importToDatabase(businessId, parsed) {
  const client = await db.getClient();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [businessId]);
    return await _importToDatabaseLocked(businessId, parsed);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [businessId]).catch(() => {});
    client.release();
  }
}

async function _importToDatabaseLocked(businessId, parsed) {
  const { zReports, items = [], shifts } = parsed;

  // מיון לפי תאריך עלייה
  zReports.sort((a, b) => new Date(a.toDate) - new Date(b.toDate));

  // Deduplicate by zNumber (keep last) — prevents PostgreSQL "ON CONFLICT DO UPDATE
  // command cannot affect row a second time" when a file contains duplicate Z rows.
  const _zMap = new Map();
  for (const z of zReports) _zMap.set(z.zNumber, z);
  zReports.splice(0, zReports.length, ..._zMap.values());

  // 1. בדוק אילו Z-reports כבר קיימים — שאילתה אחת לכולם
  const allPosIds = zReports.map(z => `Z-${z.zNumber}`);
  const { rows: existing } = await db.query(
    `SELECT pos_sale_id, sold_at::date AS report_date FROM sales WHERE business_id = $1 AND pos_sale_id = ANY($2::text[])`,
    [businessId, allPosIds]
  );
  const existingSet = new Set(existing.map(r => r.pos_sale_id));
  const newCount = zReports.filter(z => !existingSet.has(`Z-${z.zNumber}`)).length;
  const skipped  = existingSet.size;

  // Detect Z-number date conflicts (same Z-number but different date = POS counter may have reset)
  const dateConflicts = [];
  for (const row of existing) {
    const incoming = zReports.find(z => `Z-${z.zNumber}` === row.pos_sale_id);
    if (!incoming) continue;
    const existingDate = new Date(row.report_date).toISOString().slice(0, 10);
    const newDate = incoming.toDate instanceof Date
      ? incoming.toDate.toISOString().slice(0, 10)
      : String(incoming.toDate).slice(0, 10);
    if (existingDate !== newDate) {
      dateConflicts.push({ posId: row.pos_sale_id, existingDate, newDate });
      logger.warn('[ZReport] Z-number date conflict — POS counter may have reset', { businessId, posId: row.pos_sale_id, existingDate, newDate });
    }
  }

  let imported = 0;
  let shiftsImported = 0;
  let itemsRefreshed = false;
  let lastZIsNew = false;
  let lastZSaleId = null;

  if (zReports.length > 0) {
    // 2. Bulk UPSERT כל Z-reports — VALUES רב-שורתי, הכל בשאילתה אחת
    // מסונכרן גם על דוחות קיימים כדי לתקן תאריכים שגויים מייבוא ישן
    const salesValues = zReports.map((z, i) => {
      const base = i * 13;
      return `($${base+1}, $${base+2}, 'z_report', $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7}, $${base+8}, $${base+9}, $${base+10}, $${base+11}, $${base+12}, $${base+13})`;
    }).join(', ');
    const salesParams = zReports.flatMap(z => [
      businessId, `Z-${z.zNumber}`, z.total, z.toDate,
      Math.round(z.ordersCount || 0),
      Math.round((z.avgPerOrder    || 0) * 100) / 100,
      Math.round((z.cash           || 0) * 100) / 100,
      Math.round((z.credit         || 0) * 100) / 100,
      Math.round((z.wolt           || 0) * 100) / 100,
      Math.round((z.tenBis         || 0) * 100) / 100,
      Math.round((z.discount       || 0) * 100) / 100,
      Math.round((z.cancellation   || 0) * 100) / 100,
      JSON.stringify(z.paymentBreakdown && Object.keys(z.paymentBreakdown).length ? z.paymentBreakdown : {}),
    ]);

    const { rows: insertedSales } = await db.query(
      `INSERT INTO sales (business_id, pos_sale_id, sale_type, total_amount, sold_at, orders_count, avg_per_order,
                          cash_amount, credit_amount, wolt_amount, ten_bis_amount, discount_amount, cancellation_amount,
                          payment_breakdown)
       VALUES ${salesValues}
       ON CONFLICT (business_id, pos_sale_id) WHERE pos_sale_id IS NOT NULL
       DO UPDATE SET sold_at              = EXCLUDED.sold_at,
                     total_amount         = EXCLUDED.total_amount,
                     orders_count         = EXCLUDED.orders_count,
                     avg_per_order        = EXCLUDED.avg_per_order,
                     cash_amount          = EXCLUDED.cash_amount,
                     credit_amount        = EXCLUDED.credit_amount,
                     wolt_amount          = EXCLUDED.wolt_amount,
                     ten_bis_amount       = EXCLUDED.ten_bis_amount,
                     discount_amount      = EXCLUDED.discount_amount,
                     cancellation_amount  = EXCLUDED.cancellation_amount,
                     payment_breakdown    = EXCLUDED.payment_breakdown
       RETURNING id, pos_sale_id`,
      salesParams
    );
    imported = newCount; // count only genuinely new records, not upserted existing ones

    // 3. Bulk INSERT פריטים לדוח Z האחרון — שאילתה אחת
    const maxZNumber = Math.max(...zReports.map(z => z.zNumber));
    lastZIsNew = !existingSet.has(`Z-${maxZNumber}`);
    const lastSale   = insertedSales.find(s => s.pos_sale_id === `Z-${maxZNumber}`);
    if (lastSale) lastZSaleId = lastSale.id;
    if (lastSale && items.length > 0) {
      const itemValues = items.map((_, i) => {
        const base = i * 5;
        return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5})`;
      }).join(', ');
      const itemParams = items.flatMap(item => [
        lastSale.id, item.name, item.qty, item.unitPrice, item.total,
      ]);
      // DELETE + INSERT must be atomic: if INSERT fails after DELETE, the sale
      // would be left with no items. withTransaction runs both on the SAME
      // checked-out connection (plain db.query() pulls a fresh pooled
      // connection per call, so BEGIN/COMMIT there would not actually wrap
      // the statements in between) so a failure rolls back to the previous
      // item state rather than producing an empty record.
      try {
        await withTransaction(async (client) => {
          await client.query(`DELETE FROM sale_items WHERE sale_id = $1`, [lastSale.id]);
          await client.query(
            `INSERT INTO sale_items (sale_id, name, qty, unit_price, total_price) VALUES ${itemValues}`,
            itemParams
          );
        });
        itemsRefreshed = true;
      } catch (itemErr) {
        logger.warn('[ZReport] sale_items upsert rolled back — existing items preserved', { saleId: lastSale.id, err: itemErr.message });
      }
    }

    // 4. Bulk INSERT משמרות עובדים
    const validShifts = (shifts || []).filter(s => s.employeeName && s.totalHours > 0);
    if (validShifts.length > 0) {
      const lastZ       = zReports.reduce((max, z) => z.zNumber > max.zNumber ? z : max, zReports[0]);
      const defaultDate = lastZ.toDate;

      // כל משמרת מקבלת תאריך ספציפי אם יש, אחרת תאריך הדוח האחרון
      const shiftsWithDates = validShifts.map(s => ({
        ...s,
        reportDate: s.shiftDate || defaultDate,
      }));

      const empNames = [...new Set(shiftsWithDates.map(s => s.employeeName.toLowerCase()))];
      const { rows: empRows } = await db.query(
        `SELECT id, LOWER(full_name) AS lname FROM users WHERE business_id = $1 AND LOWER(full_name) = ANY($2::text[])`,
        [businessId, empNames]
      );
      const empMap = Object.fromEntries(empRows.map(e => [e.lname, e.id]));

      // בדוק כפולות לפי (שם, תאריך) — לא רק שם
      const { rows: existingShifts } = await db.query(
        `SELECT LOWER(employee_name) AS lname, report_date::date::text AS d
         FROM z_report_shifts
         WHERE business_id = $1 AND LOWER(employee_name) = ANY($2::text[])`,
        [businessId, empNames]
      );
      const existingSet = new Set(existingShifts.map(r => `${r.lname}::${r.d}`));

      const newShifts = shiftsWithDates.filter(s => {
        const d = s.reportDate instanceof Date
          ? s.reportDate.toISOString().split('T')[0]
          : String(s.reportDate).split('T')[0];
        return !existingSet.has(`${s.employeeName.toLowerCase()}::${d}`);
      });

      if (newShifts.length > 0) {
        const shiftValues = newShifts.map((_, i) => {
          const base = i * 5;
          return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5})`;
        }).join(', ');
        const shiftParams = newShifts.flatMap(s => [
          businessId, s.employeeName, s.totalHours, s.reportDate,
          empMap[s.employeeName.toLowerCase()] || null,
        ]);
        // rowCount, not newShifts.length — ON CONFLICT DO NOTHING can
        // silently drop a row a concurrent import already inserted after
        // this function's own pre-check ran (same fix pattern used in
        // deliveries.routes.js/order.suggestion.js for the identical race).
        const shiftResult = await db.query(
          `INSERT INTO z_report_shifts (business_id, employee_name, total_hours, report_date, employee_id)
           VALUES ${shiftValues}
           ON CONFLICT (business_id, LOWER(employee_name), report_date) DO NOTHING`,
          shiftParams
        );
        shiftsImported = shiftResult.rowCount;
      }
    }
  }

  // 5. סנכרון מנות — כשיובאו דוחות חדשים OR כש-sale_items התרענן (re-import עם שמות מתוקנים)
  if (imported > 0 || itemsRefreshed) await _syncDishesFromSaleItems(businessId).catch(() => {});

  return { imported, skipped, total: zReports.length, shiftsImported, lastZIsNew, lastZSaleId, itemsRefreshed, dateConflicts };
}

// ── Items helper ──────────────────────────────────────────────
// רשימת שמות גיליונות אפשריים לפריטים/מנות — נפוצים בקופות ישראליות
const ITEMS_SHEET_NAMES = [
  'פריטים', 'פירוט מנות', 'ריכוז מנות', 'מנות נמכרות', 'מנות', 'מכירות מנות',
  'Items', 'Item Sales', 'items', 'מוצרים', 'Dishes', 'סיכום מנות',
  'Sales Items', 'Sold Items', 'פירוט פריטים', 'ריכוז פריטים',
  // 'מכירות' (standalone) intentionally excluded — it matches Z-summary sheets
  // named "סיכום מכירות" and is too generic without a qualifier.
];
const _ITEMS_SHEET_NAMES_LC  = new Set(ITEMS_SHEET_NAMES.map(n => n.toLowerCase()));
// 'מכירות' and 'sold' removed: too generic, match Z-summary / non-item sheets.
const _ITEMS_SHEET_KEYWORDS  = ['פריט', 'מנות', 'מוצר', 'item', 'dish'];

// Column-header keywords for flexible detection
const _ITEM_NAME_KW  = ['שם', 'פריט', 'מנה', 'מוצר', 'item', 'name', 'תיאור', 'description'];
const _ITEM_QTY_KW   = ['כמות', 'qty', 'quantity', 'כמ', 'count'];
const _ITEM_TOTAL_KW = ['סכום', 'total', 'סה"כ', 'הכנסה', 'revenue'];
const _ITEM_CAT_KW   = ['קטגוריה', 'category', 'קבוצה', 'group', 'סוג'];

function _parseItemSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 2) return [];

  const headerRow = rows[0].map(h => String(h || '').toLowerCase().trim());
  const _col = (...kws) => {
    for (const kw of kws) {
      const i = headerRow.findIndex(h => h.includes(kw));
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameCol  = _col(..._ITEM_NAME_KW);
  const catCol   = _col(..._ITEM_CAT_KW);
  const qtyCol   = _col(..._ITEM_QTY_KW);
  const totalCol = _col(..._ITEM_TOTAL_KW);

  // Positional fallbacks (original layout: name | category | qty | total)
  const effName  = nameCol  >= 0 ? nameCol  : 0;
  const effQty   = qtyCol   >= 0 ? qtyCol   : 2;
  const effTotal = totalCol >= 0 ? totalCol : 3;

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = row[effName];
    if (!rawName) continue;
    const name = String(rawName).trim();
    if (!name || /סה["״]?כ|total/i.test(name)) continue;
    // Filter Z-IDs, ISO dates (YYYY-MM-DD), and Israeli dates (D/M/YY or DD/MM/YYYY)
    if (/^Z-\d+/i.test(name) || /^\d{4}-\d{2}-\d{2}/.test(name) || /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.](\d{2}|\d{4})$/.test(name)) continue;
    const qty   = _num(row[effQty]);
    const total = _num(row[effTotal]);
    items.push({
      name,
      category:  catCol >= 0 ? String(row[catCol] || '').trim() : '',
      qty,
      total,
      unitPrice: total / (qty || 1),
    });
  }
  return items;
}

function _extractItemsFromWorkbook(wb) {
  // 1. Case-insensitive exact name match
  const lcSheets = wb.SheetNames.map(n => n.trim().toLowerCase());
  let idx = lcSheets.findIndex(lc => _ITEMS_SHEET_NAMES_LC.has(lc));

  // 2. Partial keyword match (e.g. "ריכוז_מנות", "Sales-Items 2024")
  if (idx < 0) {
    idx = lcSheets.findIndex(lc => _ITEMS_SHEET_KEYWORDS.some(kw => lc.includes(kw)));
  }

  if (idx >= 0) return _parseItemSheet(wb.Sheets[wb.SheetNames[idx]]);

  // 3. Heuristic scan: try every sheet, accept first that yields ≥3 item rows
  for (const sn of wb.SheetNames) {
    const items = _parseItemSheet(wb.Sheets[sn]);
    // Guard: only trust heuristic result if items look plausible (have non-zero totals)
    if (items.length >= 3 && items.some(it => it.total > 0 || it.qty > 0)) return items;
  }

  return [];
}

// ── Shift helpers ─────────────────────────────────────────────

// מחלץ משמרות מטבלת שורות (Excel) עם זיהוי כותרות גמיש
function _parseShiftRows(rows) {
  if (!rows || rows.length < 2) return [];
  const shifts = [];
  const headers = rows[0].map(h => String(h || '').toLowerCase().trim());

  const _ci = (...names) => {
    for (const n of names) {
      let i = headers.findIndex(h => h === n);
      if (i < 0) i = headers.findIndex(h => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameCol  = _ci('שם עובד', 'עובד', 'employee', 'name', 'שם', 'worker');
  const hoursCol = _ci('שעות', 'סה"כ שעות', 'total hours', 'hours', 'שעות עבודה', 'סהכ שעות', 'total', 'סה"כ');
  const startCol = _ci('כניסה', 'שעת כניסה', 'start', 'start time', 'התחלה', 'clock in');
  const endCol   = _ci('יציאה', 'שעת יציאה', 'end', 'end time', 'סיום', 'clock out');
  const dateCol  = _ci('תאריך', 'date', 'יום', 'day');

  // fallback: עמודה 0 = שם, עמודה 1 = שעות
  const effName  = nameCol  >= 0 ? nameCol  : 0;
  const effHours = hoursCol >= 0 ? hoursCol : (startCol >= 0 ? -1 : 1);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const nameRaw = row[effName];
    if (!nameRaw || /סה["״]?כ|total/i.test(String(nameRaw))) continue;
    const employeeName = String(nameRaw).trim();
    if (!employeeName || employeeName.length < 2) continue;

    let totalHours = 0;

    // עדיפות: כניסה-יציאה → חשב פרק זמן
    if (startCol >= 0 && endCol >= 0) {
      const s = _parseTimeCell(row[startCol]);
      const e = _parseTimeCell(row[endCol]);
      if (s !== null && e !== null) {
        totalHours = e >= s ? e - s : 24 - s + e;
      }
    }

    // fallback: עמודת שעות
    if (totalHours <= 0 && effHours >= 0) {
      totalHours = _parseTimeCell(row[effHours]) ?? _num(row[effHours]);
    }

    if (totalHours <= 0 || totalHours > 24) continue;

    const shiftDateRaw = dateCol >= 0 ? row[dateCol] : null;
    const shiftDate    = shiftDateRaw ? _parseDate(shiftDateRaw) : null;

    shifts.push({
      employeeName,
      totalHours: Math.round(totalHours * 100) / 100,
      shiftDate,
    });
  }

  return shifts;
}

// מפרסר ערך זמן מתא Excel — מחזיר שעות כ-float או null
function _parseTimeCell(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return val.getUTCHours() + val.getUTCMinutes() / 60 + val.getUTCSeconds() / 3600;
  }
  if (typeof val === 'number') {
    if (val > 0 && val < 1) return val * 24;  // Excel fractional day
    if (val >= 1 && val <= 24) return val;     // שעות כבר
    return null;
  }
  if (typeof val === 'string') {
    const t = val.trim();
    if (t.includes(':')) {
      const parts = t.split(':').map(Number);
      const h = parts[0] || 0;
      const m = (parts[1] || 0) / 60;
      const s = (parts[2] || 0) / 3600;
      if (h <= 24) return h + m + s;
    }
    const n = parseFloat(t.replace(',', '.'));
    if (!isNaN(n) && n > 0 && n <= 24) return n;
  }
  return null;
}

// מחלץ משמרות מטקסט חופשי (PDF / TXT / HTML)
function _parseShiftsFromText(text) {
  if (!text || text.length < 20) return [];

  const shifts = [];
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
  let inSection = false;
  let misses = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // כותרת קטע משמרות
    if (/^(משמרות|עובדים|שעות\s*עובדים|shifts?|staff|employee\s*hours?)\s*:?\s*$/i.test(line)) {
      inSection = true;
      misses = 0;
      continue;
    }

    if (!inSection) continue;

    // סיום קטע בגבול ברור או יותר מ-4 שורות ללא התאמה
    if (/^(מכירות|פריטים|סיכום|summary|items|sales|total|payments?)\b/i.test(line) || misses > 4) {
      inSection = false;
      continue;
    }

    const shift = _parseShiftLine(line);
    if (shift) {
      shifts.push(shift);
      misses = 0;
    } else {
      misses++;
    }
  }

  // Fallback: global scan without requiring a section header.
  // Catches files that list employee hours without a recognized header keyword.
  if (shifts.length === 0) {
    for (const line of lines) {
      if (/^(מכירות|פריטים|סיכום|summary|items|sales|total|payments?|z[-\s]?\d)/i.test(line)) continue;
      const shift = _parseShiftLine(line);
      if (shift) shifts.push(shift);
    }
  }

  return shifts;
}

// מנסה לפרסר שורה אחת כמשמרת עובד
function _parseShiftLine(line) {
  // "שם עובד 08:00-16:30" → שעות = הפרש
  let m = line.match(/^(.{2,35}?)\s+(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
  if (m) {
    const name = m[1].trim();
    if (/^(סה|total|סהכ|\d)/i.test(name)) return null;
    const s = _timeStrToHours(m[2]);
    const e = _timeStrToHours(m[3]);
    if (s === null || e === null) return null;
    const hours = e >= s ? e - s : 24 - s + e;
    if (hours <= 0 || hours > 24) return null;
    return { employeeName: name, totalHours: Math.round(hours * 100) / 100, shiftDate: null };
  }

  // "שם עובד 8.5" / "שם עובד 08:30" (סה"כ שעות)
  m = line.match(/^(.{2,35}?)\s+(\d{1,2}(?:[.:]\d{2})?)\s*(?:שעות|ש[׳']|hrs?|h)?\s*$/i);
  if (m) {
    const name = m[1].trim();
    if (/^(סה|total|סהכ|\d)/i.test(name)) return null;
    const raw = m[2];
    let hours = raw.includes(':')
      ? (() => { const [hh, mm] = raw.split(':').map(Number); return hh + (mm || 0) / 60; })()
      : parseFloat(raw.replace(',', '.'));
    if (!hours || hours <= 0 || hours > 24) return null;
    return { employeeName: name, totalHours: Math.round(hours * 100) / 100, shiftDate: null };
  }

  return null;
}

function _timeStrToHours(str) {
  const parts = str.split(':').map(Number);
  return isNaN(parts[0]) ? null : parts[0] + (parts[1] || 0) / 60;
}

// ── Helpers ───────────────────────────────────────────────────
function _parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  // פורמט: "29/01/2026 16:06" — use UTC noon; time is local POS time, only date matters
  const match = String(val).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return new Date(Date.UTC(+match[3], +match[2]-1, +match[1], 12, 0, 0));
  return null;
}

function _num(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// Fallback "z number" derived from the report's date (YYYYMMDD) when no real
// document/report ID can be found in the file. Z-reports are effectively one
// per business per day, so this is guaranteed unique per day — unlike a raw
// row-index or constant placeholder, which would make every file with this
// same unrecognized layout collide on the same `pos_sale_id` ("Z-1"/"Z-<n>")
// and silently overwrite each other's sales data on every import.
function _dateSerial(date) {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function _sumCols(row, headers, names) {
  return names.reduce((sum, name) => {
    const idx = headers.indexOf(name);
    return sum + (idx >= 0 ? _num(row[idx]) : 0);
  }, 0);
}

function _buildPaymentBreakdown(row, headers) {
  const paymentCols = ['dejavoo','מזומן','wolt','אשראי חיצוני','sodexo','תן ביס','shelly','goodi','סיבוס משלוחים'];
  const result = {};
  paymentCols.forEach(col => {
    const idx = headers.indexOf(col);
    if (idx >= 0) {
      const val = _num(row[idx]);
      if (val > 0) result[col] = val;
    }
  });
  return result;
}

// Builds paymentBreakdown for JSON/AI-extracted Z-reports from extended payment channels
function _buildJsonPaymentBreakdown(item) {
  const breakdown = {};
  const channels = [
    { key: 'bit',      aliases: ['bit', 'ביט'] },
    { key: 'paybox',   aliases: ['paybox', 'פייבוקס'] },
    { key: 'sodexo',   aliases: ['sodexo', 'סודקסו'] },
    { key: 'goodi',    aliases: ['goodi', 'גודי'] },
    { key: 'vouchers', aliases: ['vouchers', 'voucher', 'שוברים'] },
    { key: 'dejavoo',  aliases: ['dejavoo'] },
    { key: 'checks',   aliases: ['checks', 'check', 'המחאות', 'שיקים'] },
    { key: 'cibus',    aliases: ['cibus', 'סיבוס'] },
    { key: 'mishloha', aliases: ['mishloha', 'משלוחה'] },
    { key: 'transfer', aliases: ['transfer', 'העברה'] },
    { key: 'shelly',   aliases: ['shelly'] },
  ];
  for (const { key, aliases } of channels) {
    for (const alias of aliases) {
      const val = _num(item[alias] || 0);
      if (val > 0) { breakdown[key] = val; break; }
    }
  }
  return breakdown;
}

// ── CSV parser ────────────────────────────────────────────────
// Parses CSV manually so DD/MM/YYYY date strings are never misinterpreted by XLSX
function parseZReportCsv(buffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  // BOM stripping and encoding detection.
  // Many Israeli POS systems export CSV in Windows-1255 (single-byte Hebrew,
  // bytes 0xE0-0xFA). Decoding as UTF-8 turns Hebrew into mojibake (U+FFFD
  // replacement chars), breaking all column/item matching silently.
  const raw = (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)
    ? buffer.slice(3) // UTF-8 BOM
    : buffer;
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // If no Hebrew detected in UTF-8 decode but the raw buffer has bytes in the
  // CP1255 Hebrew range (0xE0-0xFA), fall back to CP1255 decoding.
  if (!/[א-ת]/.test(text) && raw.some(b => b >= 0xE0 && b <= 0xFA)) {
    try {
      const iconv = require('iconv-lite');
      const cp1255 = iconv.decode(raw, 'CP1255');
      if (/[א-ת]/.test(cp1255)) text = cp1255;
    } catch { /* iconv-lite not available — proceed with UTF-8 decode */ }
  }

  // Manual CSV split: handles quoted fields, CR+LF, Hebrew
  // Auto-detect delimiter: count occurrences in first non-empty data line
  // Israeli Excel often saves with semicolons; pipe and tab are also common
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const sampleLine = lines.find(l => l.trim().length > 2) || '';
  const delimCounts = {
    ',': (sampleLine.match(/,/g) || []).length,
    ';': (sampleLine.match(/;/g) || []).length,
    '\t': (sampleLine.match(/\t/g) || []).length,
    '|': (sampleLine.match(/\|/g) || []).length,
  };
  const delimiter = Object.entries(delimCounts).sort((a, b) => b[1] - a[1])[0][0];
  const rows  = lines.map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (!inQ && cur === '') { inQ = true; }
        else if (inQ) { inQ = false; }
        else { cur += ch; }
      } else if (ch === delimiter && !inQ) {
        cells.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });

  if (rows.length >= 2) {
    const result = _parseFlatTable(rows, vatDivisor);
    if (result.zReports.length > 0) return result;
  }

  // Last resort: XLSX (for CSV files saved by Excel with numeric date serials)
  const wb = XLSX.read(text, { type: 'string', cellDates: true });
  try {
    const result = parseZReportExcel(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), vatDivisor);
    if (result.zReports.length > 0) return result;
  } catch {}
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const xlsxRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return _parseFlatTable(xlsxRows, vatDivisor);
}

// ── PDF text extraction (shared) ───────────────────────────────
// pdf-parse v2's API is class-based (require('pdf-parse') no longer exports
// a callable function like v1 did) — `new PDFParse({ data }).getText()`.
async function _extractPdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ── PDF parser ────────────────────────────────────────────────
async function parseZReportPdf(buffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  let text = '';
  try {
    text = await _extractPdfText(buffer);
  } catch {
    throw new Error('לא ניתן לקרוא את קובץ ה-PDF');
  }
  const result = _parseTextContent(text, vatDivisor);
  if (result.shifts.length === 0) result.shifts = _parseShiftsFromText(text);
  return result;
}

// ── TXT parser ────────────────────────────────────────────────
function parseZReportTxt(buffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  const raw = (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)
    ? buffer.slice(3) : buffer;
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Fall back to CP1255 if UTF-8 decode produced no Hebrew but raw bytes are in the Hebrew range
  if (!/[א-ת]/.test(text) && raw.some(b => b >= 0xE0 && b <= 0xFA)) {
    const cp = iconv.decode(raw, 'CP1255');
    if (/[א-ת]/.test(cp)) text = cp;
  }
  const result = _parseTextContent(text, vatDivisor);
  if (result.shifts.length === 0) result.shifts = _parseShiftsFromText(text);
  return result;
}

// ── HTML parser ───────────────────────────────────────────────
function parseZReportHtml(buffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  // Detect charset from <meta charset=...> or http-equiv before UTF-8 decode
  let raw = buffer;
  const metaHint = buffer.toString('latin1').match(/charset\s*=\s*["']?\s*(windows-1255|cp1255|iso-8859-8)/i);
  if (metaHint && !/[א-ת]/.test(buffer.toString('utf8'))) {
    raw = Buffer.from(iconv.decode(buffer, 'CP1255'));
  }
  let html = raw.toString('utf8');
  if (html.charCodeAt(0) === 0xFEFF) html = html.slice(1);
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#[0-9]+;/g, ' ')
    // Strip RTL/LTR Unicode direction marks that corrupt number parsing in Hebrew content
    .replace(/[‎‏‪-‮]/g, '');

  // First try to parse as a tab-separated table (common in HTML email reports)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const tableRows = lines.map(l => l.split('\t').map(c => c.trim()));
  if (tableRows.length > 1 && tableRows[0].length > 2) {
    const result = _parseFlatTable(tableRows, vatDivisor);
    if (result.zReports.length > 0) {
      if (result.shifts.length === 0) result.shifts = _parseShiftsFromText(text);
      return result;
    }
  }

  const result = _parseTextContent(text, vatDivisor);
  if (result.shifts.length === 0) result.shifts = _parseShiftsFromText(text);
  return result;
}

// ── XML parser ────────────────────────────────────────────────
// Uses fast-xml-parser for proper parsing: preserves text nodes, CDATA content,
// and attribute values — all of which the old regex-strip approach silently lost.
function parseZReportXml(buffer, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  // Encoding: detect from <?xml ... encoding="windows-1255"?> before UTF-8 decode
  let raw = buffer;
  const xmlDecl = buffer.slice(0, 200).toString('latin1');
  const encMatch = xmlDecl.match(/encoding\s*=\s*["'](windows-1255|cp1255|iso-8859-8)/i);
  if (encMatch) {
    const decoded = iconv.decode(buffer, 'CP1255');
    raw = Buffer.from(decoded, 'utf8');
  }

  let xml = raw.toString('utf8');
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1);

  // Try structured parsing first — extract all text content including CDATA and attribute values
  try {
    const parser = new FastXMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      cdataPropName: '__cdata',
      textNodeName: '#text',
      parseAttributeValue: true,
      allowBooleanAttributes: true,
      trimValues: true,
    });
    const obj = parser.parse(xml);

    // Flatten all string/number values from the parsed object tree into a text block
    // so that _parseTextContent can run its regex patterns over them.
    const lines = [];
    const flatten = (node, depth = 0) => {
      if (depth > 20) return;
      if (node === null || node === undefined) return;
      if (typeof node === 'string' || typeof node === 'number') {
        lines.push(String(node));
        return;
      }
      if (Array.isArray(node)) { node.forEach(n => flatten(n, depth + 1)); return; }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          // Include attribute values (strip @_ prefix) alongside tag text
          if (k !== '__cdata') flatten(v, depth + 1);
          else lines.push(String(v)); // CDATA content
        }
      }
    };
    flatten(obj);

    const text = lines.join('\n');
    const result = _parseTextContent(text, vatDivisor);
    if (result.zReports.length > 0) return result;
    // Fall through to regex strip if structured parse found nothing
  } catch { /* ignore parse errors, fall through */ }

  // Fallback: legacy regex strip (handles malformed XML that fast-xml-parser rejects)
  const stripped = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, ' $1 ') // preserve CDATA content
    .replace(/<[^>]+>/g, ' ');
  return _parseTextContent(stripped, vatDivisor);
}

// ── JSON parser ───────────────────────────────────────────────
// Business-specific VAT rate (e.g. VAT-exempt/reduced-rate businesses) —
// fall back to the Israeli statutory default only when it can't be read.
// Shared by every parser below that has to derive totalNoVat/vat when the
// source file doesn't supply them explicitly.
const DEFAULT_VAT_RATE = 0.18;
async function _getVatDivisor(context = {}) {
  let vatRate = DEFAULT_VAT_RATE;
  if (context.businessId) {
    try {
      const { rows: [bizRow] } = await db.query(
        `SELECT COALESCE(vat_rate, $1) AS vat_rate FROM businesses WHERE id = $2`,
        [DEFAULT_VAT_RATE, context.businessId]
      );
      if (bizRow) vatRate = parseFloat(bizRow.vat_rate);
    } catch (err) {
      logger.warn('[ZReport] failed to read business vat_rate, using default', { err: err.message });
    }
  }
  return 1 + vatRate;
}

async function parseZReportJson(buffer, context = {}) {
  let obj;
  try {
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip UTF-8 BOM
    obj = JSON.parse(text);
  } catch { throw new Error('JSON לא תקין'); }

  const vatDivisor = await _getVatDivisor(context);

  const arr = Array.isArray(obj) ? obj : (obj.reports || obj.zReports || obj.data || [obj]);
  const zReports = [];

  for (const item of arr) {
    const total = _num(item.total || item.totalAmount || item.amount || item.sum || item.סהכ || 0);
    const dateRaw = item.date || item.toDate || item.reportDate || item.תאריך;
    const toDate  = _parseDateStr(dateRaw);
    if (!toDate) continue;
    const fromDate = toDate;
    if (total <= 0) continue;
    const ordersCount = _num(item.ordersCount || item.orders || item.orderCount || item.מספרהזמנות || item['מספר הזמנות'] || 0);
    const avgPerOrder = ordersCount > 0
      ? Math.round((total / ordersCount) * 100) / 100
      : _num(item.avgPerOrder || item.avg || 0);
    zReports.push({
      zNumber:   (() => {
        const rawZ = item.zNumber ?? item.z ?? item.מספרZ ?? item['מספר z'];
        if (rawZ != null && !Number.isNaN(parseFloat(String(rawZ)))) return _num(rawZ);
        // Use date-serial fallback to avoid colliding with real POS Z-numbers
        const d = new Date(toDate);
        return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      })(),
      fromDate,
      toDate,
      total,
      totalNoVat: _num(item.totalNoVat || item.netAmount || total / vatDivisor),
      vat:       _num(item.vat || item.vatAmount || total - total / vatDivisor),
      avgPerOrder, ordersCount,
      cash:         _num(item.cash         || item.מזומן || 0),
      credit:       _num(item.credit       || item.אשראי || 0),
      wolt:         _num(item.wolt         || item['וולט'] || 0),
      tenBis:       _num(item.tenBis       || item['תן ביס'] || 0),
      discount:     _num(item.discount     || item.discounts || item.הנחות || item.הנחה || 0),
      cancellation: _num(item.cancellation || item.cancellations || item.ביטולים || item.ביטול || item.void || 0),
      paymentBreakdown: _buildJsonPaymentBreakdown(item),
    });
  }

  // חיפוש משמרות בתוך JSON
  const shifts = [];
  const shiftArr = obj.shifts || obj.employees || obj.staff || obj.workers || obj.משמרות;
  if (Array.isArray(shiftArr)) {
    for (const emp of shiftArr) {
      const name  = emp.name || emp.employee || emp.employeeName || emp.employee_name || emp['שם'] || emp['שם עובד'];
      const hours = _num(emp.hours || emp.total_hours || emp.totalHours || emp.שעות || emp.duration || 0);
      const dateRaw = emp.date || emp.report_date || emp.reportDate || emp.תאריך;
      const shiftDate = dateRaw ? _parseDateStr(dateRaw) : null;
      if (name && hours > 0 && hours <= 24) {
        shifts.push({ employeeName: String(name).trim(), totalHours: Math.round(hours * 100) / 100, shiftDate });
      }
    }
  }

  // חילוץ פריטים/מנות מה-JSON
  const items = [];
  const itemArr = obj.items || obj.dishes || obj.products || obj.מנות || obj.פריטים
               || obj.item_details || obj.itemDetails || obj.sales_items;
  if (Array.isArray(itemArr)) {
    for (const it of itemArr) {
      const name = it.name || it.product || it.item || it.dish || it.מנה || it.שם || it.description || it.תיאור;
      if (!name) continue;
      const qty   = _num(it.qty || it.quantity || it.count || it.כמות || 0);
      const total = _num(it.total || it.totalPrice || it.amount || it.סכום || it.revenue || it.הכנסה || 0);
      items.push({
        name:      String(name).trim(),
        category:  String(it.category || it.קטגוריה || it.group || '').trim(),
        qty,
        total,
        unitPrice: _num(it.unitPrice || it.price || it.מחיר || (total / (qty || 1))),
      });
    }
  }

  return { zReports, items, shifts };
}

// ── ZIP parser ────────────────────────────────────────────────
const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024; // 100 MB guard against ZIP bombs

async function parseZReportZip(buffer, context = {}) {
  const depth = context._zipDepth ?? 0;
  if (depth > 2) throw new Error('ZIP קינון עמוק מדי — פתח ידנית והעלה את הקובץ הפנימי');

  const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
  if (!AdmZip) throw new Error('adm-zip לא מותקן — פתח את ה-ZIP ידנית והעלה את הקובץ הפנימי');

  const zip     = new AdmZip(buffer);
  const entries = zip.getEntries();
  const subCtx  = { ...context, _zipDepth: depth + 1 };

  const allZReports = [];
  const allShifts   = [];
  let   foundItems  = [];
  let   bestZNumForItems = -Infinity;

  // Cumulative guard: many small-looking entries can still expand to GBs total
  // (e.g. 100 entries × 99 MB = ~9.9 GB). Cap the total across all entries at
  // 5× the per-entry limit so a single legit Z-report file is never rejected
  // while a ZIP-bomb spray is still caught.
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // Guard against ZIP bombs — header.size is attacker-controlled metadata,
    // so we check it as a fast pre-filter and then verify the actual byte count
    // after decompression to catch dishonest/zeroed headers.
    if (entry.header.size > ZIP_MAX_UNCOMPRESSED) {
      logger.warn('[ZReport ZIP] skipping oversized entry (header)', { entry: entry.name, size: entry.header.size });
      continue;
    }
    const buf = entry.getData();
    if (buf.length > ZIP_MAX_UNCOMPRESSED) {
      logger.warn('[ZReport ZIP] skipping oversized entry (actual bytes)', { entry: entry.name, size: buf.length });
      continue;
    }
    totalUncompressedBytes += buf.length;
    if (totalUncompressedBytes > ZIP_MAX_UNCOMPRESSED * 5) {
      logger.warn('[ZReport ZIP] cumulative uncompressed size exceeded — aborting extraction', {
        total: totalUncompressedBytes, entry: entry.name,
      });
      break;
    }
    try {
      const result = await parseZReportAuto(buf, null, entry.name, subCtx);
      if (result.zReports.length > 0) {
        allZReports.push(...result.zReports);
        allShifts.push(...(result.shifts || []));
        // Use items from the file containing the highest Z-number (matches importToDatabase strategy)
        const thisMaxZ = result.zReports.reduce((m, z) => Math.max(m, z.zNumber), -Infinity);
        if (result.items?.length > 0 && thisMaxZ > bestZNumForItems) {
          bestZNumForItems = thisMaxZ;
          foundItems = result.items;
        } else if (foundItems.length === 0 && result.items?.length > 0) {
          foundItems = result.items; // fallback: take first file with items
        }
      }
    } catch (e) {
      logger.warn('[ZReport ZIP] failed to parse entry', { entry: entry.name, err: e.message });
    }
  }

  if (!allZReports.length) throw new Error('לא נמצא דוח Z תקין בתוך קובץ ה-ZIP');
  return { zReports: allZReports, shifts: allShifts, items: foundItems };
}

// ── Format fingerprinting ──────────────────────────────────────
// Hash of sheet names + each sheet's header row (Excel) or the file's first
// non-empty line (CSV/text) — captures the file's *shape*, not its data, so
// the same POS vendor's export always hashes the same regardless of which
// numbers/dates are in it.
function _computeFingerprint(buffer, filename) {
  const ext = (filename ? path.extname(filename).toLowerCase() : '');
  let sheets;
  try {
    if (ext === '.xlsx' || ext === '.xls' || (buffer[0] === 0x50 && buffer[1] === 0x4B)) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      sheets = wb.SheetNames.map(name => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
        const header = (rows[0] || []).map(h => String(h || '').trim().toLowerCase());
        return { name, header };
      });
    } else {
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '');
      const header = firstLine.split(/[,;\t]/).map(h => h.trim().toLowerCase());
      sheets = [{ name: null, header }];
    }
  } catch { return null; }
  if (!sheets.length || sheets.every(s => s.header.every(h => !h))) return null;
  return crypto.createHash('sha256').update(JSON.stringify(sheets)).digest('hex');
}

async function _getStoredFormat(fingerprint) {
  if (!fingerprint) return null;
  const { rows } = await db.query(`SELECT * FROM z_report_formats WHERE fingerprint = $1`, [fingerprint]);
  return rows[0] || null;
}

async function _saveOrTouchFormat(fingerprint, schema, filename, businessId) {
  if (!fingerprint) return null;
  try {
    const { rows } = await db.query(`
      INSERT INTO z_report_formats (fingerprint, schema, sample_filename, first_business_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (fingerprint) DO UPDATE
        SET times_used = z_report_formats.times_used + 1, last_used_at = NOW()
      RETURNING id, confidence
    `, [fingerprint, JSON.stringify(schema), filename || null, businessId || null]);
    return rows[0] || null;
  } catch (err) {
    logger.warn('[ZReport] failed to save/touch learned format', { err: err.message });
    return null;
  }
}

// Deterministic extraction using a previously-learned schema — the whole
// point of learning a format: no AI call at all on repeat imports from a
// vendor we've already seen. schema.columns values are 0-based column
// indices into the matched sheet (mirrors how the hardcoded parsers above
// already read fixed columns like row[3], row[7]).
function _applySchema(buffer, schema, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  const empty = { zReports: [], items: [], shifts: [] };
  if (!schema?.columns) return empty;
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); } catch { return empty; }
  const ws = wb.Sheets[schema.sheetName] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return empty;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const c = schema.columns;
  const zReports = [];
  for (let i = (schema.headerRowIndex ?? 0) + 1; i < rows.length; i++) {
    const row = rows[i];
    const zNumRaw = c.zNumber != null ? row[c.zNumber] : null;
    const zNumParsed = _num(zNumRaw);
    if (zNumRaw === '' || zNumRaw == null || zNumParsed < 0) continue;
    const fromDate = c.fromDate != null ? _parseDate(row[c.fromDate]) : null;
    const toDate   = c.toDate   != null ? _parseDate(row[c.toDate])   : fromDate;
    const total    = c.total    != null ? _num(row[c.total]) : 0;
    if (!toDate || total <= 0) continue;
    const ordersCount = c.ordersCount != null ? _num(row[c.ordersCount]) : 0;
    zReports.push({
      zNumber: zNumParsed, fromDate, toDate, total,
      totalNoVat:  c.totalNoVat  != null ? _num(row[c.totalNoVat])  : total / vatDivisor,
      vat:         c.vat         != null ? _num(row[c.vat])         : total - total / vatDivisor,
      avgPerOrder: c.avgPerOrder != null ? _num(row[c.avgPerOrder]) : (ordersCount > 0 ? Math.round((total / ordersCount) * 100) / 100 : 0),
      ordersCount,
      cash:         c.cash         != null ? _num(row[c.cash])         : 0,
      credit:       c.credit       != null ? _num(row[c.credit])       : 0,
      wolt:         c.wolt         != null ? _num(row[c.wolt])         : 0,
      tenBis:       c.tenBis       != null ? _num(row[c.tenBis])       : 0,
      discount:     c.discount     != null ? _num(row[c.discount])     : 0,
      cancellation: c.cancellation != null ? _num(row[c.cancellation]) : 0,
      paymentBreakdown: {},
    });
  }
  return { zReports, items: _extractItemsFromWorkbook(wb), shifts: [] };
}

// AI schema-DETECTION (not value-extraction): shown only a small header/
// sample preview of each sheet, asked which sheet+column holds each field.
// Much cheaper than parseZReportWithAI's whole-file dump, and — critically —
// produces a reusable {sheetName, columns} schema instead of one-off values,
// which is what makes learning possible. Falls back to the proven
// parseZReportWithAI (full value-extraction) if no valid schema results.
async function _detectSchemaWithAI(buffer, filename) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }); } catch { return null; }
  if (!wb.SheetNames.length) return null;

  const preview = wb.SheetNames.map(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }).slice(0, 4);
    const lines = rows.map((r, i) => `[${i}] ` + r.map((cell, ci) => `(${ci})${cell}`).join(' | '));
    return `--- גיליון: "${name}" ---\n${lines.join('\n')}`;
  }).join('\n\n');

  const prompt = `להלן תצוגה מקדימה (שורת כותרות + עד 3 שורות נתונים) מקובץ דוח Z ממערכת קופה שלא זוהתה אוטומטית. שם הקובץ: ${filename || 'לא ידוע'}

${preview.slice(0, 6000)}

זהה איזה גיליון מכיל את טבלת דוחות ה-Z (שורה אחת = דוח Z אחד, בדרך כלל עם עמודות: מספר Z, תאריכים, סכום כולל, מספר הזמנות). עבור כל שדה, ציין את מספר העמודה (0-based, המספר בסוגריים לפני כל תא) בגיליון הזה, או null אם השדה לא קיים.

החזר אך ורק JSON בפורמט הזה, ללא טקסט נוסף:
{
  "sheetName": "השם המדויק של הגיליון",
  "headerRowIndex": 0,
  "columns": {
    "zNumber": מספר עמודה או null,
    "fromDate": מספר עמודה או null,
    "toDate": מספר עמודה או null,
    "total": מספר עמודה או null,
    "totalNoVat": מספר עמודה או null,
    "vat": מספר עמודה או null,
    "ordersCount": מספר עמודה או null,
    "avgPerOrder": מספר עמודה או null,
    "cash": מספר עמודה או null,
    "credit": מספר עמודה או null,
    "wolt": מספר עמודה או null,
    "tenBis": מספר עמודה או null,
    "discount": מספר עמודה או null,
    "cancellation": מספר עמודה או null
  }
}

אם אין sheet שנראה כמו טבלת דוחות Z אמיתית, החזר {"sheetName": null, "columns": {}}`;

  let result;
  try {
    result = await createWithRetry(anthropic, {
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }, { context: { feature: 'zreport_schema_detect', filename } });
  } catch (err) {
    logger.warn('[ZReport] schema-detection AI call failed', { err: err.message, filename });
    return null;
  }

  const responseText = result.content.find(b => b.type === 'text')?.text?.trim() || '';
  const match = responseText.match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(match ? match[0] : responseText); } catch { return null; }
  if (!parsed?.sheetName || !parsed.columns || parsed.columns.zNumber == null || parsed.columns.total == null) return null;

  logTokenUsage({ feature: 'zreport_schema_detect', model: 'claude-haiku-4-5', usage: result.usage });
  return { sheetName: parsed.sheetName, headerRowIndex: parsed.headerRowIndex ?? 0, columns: parsed.columns };
}

// ── Auto-detect and parse ─────────────────────────────────────
// `context` (optional): { businessId, userId } — only used to attribute AI
// token usage when the deterministic parsers below can't handle the file.
async function parseZReportAuto(buffer, mimetype, filename, context = {}) {
  const ext  = (filename ? path.extname(filename).toLowerCase() : '');
  const mime = (mimetype || '').toLowerCase();
  const vatDivisor = await _getVatDivisor(context);

  // "We read the file and it holds no Z rows" and "we could not read the file"
  // are different outcomes with different fixes, and the chain below used to
  // collapse them: every strategy is gated on zReports.length > 0, so a file
  // that parsed perfectly and simply had nothing in it fell through to the same
  // final throw as a file whose format had broken.
  //
  // That is what three days of "90 scanned, 0 imported" actually was: the AI
  // extractor returned valid JSON reporting zero Z-reports, which is a complete
  // and correct answer, and the error said "we could not read the file".
  // Whoever read that went looking for a parser bug when the right question was
  // whether the business had been closed.
  //
  // Any strategy that returns a well-formed result with zero rows sets this.
  let parsedButEmpty = false;
  const noteEmpty = (r) => { if (r && Array.isArray(r.zReports) && r.zReports.length === 0) parsedButEmpty = true; return r; };

  let result = null;
  try {
    if (ext === '.eml' || mime === 'message/rfc822' || mime === 'application/octet-stream' && ext === '.eml') {
      // A forwarded thread can contain many nested xlsx attachments (one per
      // historical Z-report) — parse every one found and merge them, rather
      // than only importing whichever the old single-buffer extractor
      // happened to find first.
      const xlsxBufs = extractXlsxFromEml(buffer);
      const merged = { zReports: [], items: [], shifts: [] };
      let latestZNumber = -Infinity;
      for (const buf of xlsxBufs) {
        let parsed;
        try { parsed = parseZReportExcel(buf, vatDivisor); } catch { continue; }
        merged.zReports.push(...parsed.zReports);
        merged.shifts.push(...parsed.shifts);
        const maxZ = parsed.zReports.reduce((m, z) => Math.max(m, z.zNumber), -Infinity);
        if (maxZ > latestZNumber) { latestZNumber = maxZ; merged.items = parsed.items; }
      }
      // Forwarded threads often repeat the same historical days as context
      // in each new forward — de-dup by zNumber so they aren't double-counted
      const seenZ = new Set();
      merged.zReports = merged.zReports.filter(z => {
        if (seenZ.has(z.zNumber)) return false;
        seenZ.add(z.zNumber);
        return true;
      });
      result = merged;
    } else if (ext === '.xlsx' || ext === '.xls' || mime.includes('spreadsheetml') || mime.includes('ms-excel')) {
      result = parseZReportExcel(buffer, vatDivisor);
    } else if (ext === '.csv' || mime === 'text/csv') {
      result = parseZReportCsv(buffer, vatDivisor);
    } else if (ext === '.pdf' || mime === 'application/pdf') {
      result = await parseZReportPdf(buffer, vatDivisor);
    } else if (ext === '.html' || ext === '.htm' || mime === 'text/html') {
      result = parseZReportHtml(buffer, vatDivisor);
    } else if (ext === '.txt' || mime === 'text/plain') {
      result = parseZReportTxt(buffer, vatDivisor);
    } else if (ext === '.xml' || mime === 'text/xml' || mime === 'application/xml') {
      result = parseZReportXml(buffer, vatDivisor);
    } else if (ext === '.json' || mime === 'application/json') {
      result = await parseZReportJson(buffer, context);
    } else if (ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
      // ZIP recurses through this same function per entry — AI fallback below
      // applies automatically to each entry, so just return its result as-is.
      return parseZReportZip(buffer, context);
    } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) || mime.startsWith('image/')) {
      // Photos have no reusable tabular shape to fingerprint/learn — go
      // straight to one-shot Vision extraction instead of falling through
      // the spreadsheet-oriented attempts below (which would all no-op on
      // image bytes anyway).
      return parseZReportImage(buffer, filename, context);
    }
  } catch {
    result = null; // known extension, but its parser choked — fall through
  }

  if (result && result.zReports.length > 0) return result;
  noteEmpty(result);

  // Format learning, step 1: have we already learned this exact file *shape*
  // (sheet names + headers) before? If so, apply the stored schema — no AI
  // call at all, same cost as any hardcoded parser above.
  const fingerprint = _computeFingerprint(buffer, filename);
  const stored = await _getStoredFormat(fingerprint).catch(() => null);
  if (stored) {
    try {
      const r = _applySchema(buffer, stored.schema, vatDivisor);
      if (r.zReports.length > 0) {
        _saveOrTouchFormat(fingerprint, stored.schema, filename, context.businessId).catch(() => {});
        r._formatSource = 'learned_reused';
        r._formatId = stored.id;
        r._formatConfirmed = stored.confidence === 'user_confirmed';
        return r;
      }
    } catch {}
    // Stored schema no longer matches (vendor changed their export) — fall
    // through to re-detect below; a successful re-detection overwrites it.
  }

  // Last resort: try each deterministic parser in order (covers unknown
  // extensions, and known extensions whose internal structure didn't match
  // what we expected)
  const attempts = [
    () => parseZReportExcel(buffer, vatDivisor),
    () => parseZReportCsv(buffer, vatDivisor),
    () => parseZReportTxt(buffer, vatDivisor),
    async () => parseZReportPdf(buffer, vatDivisor),
  ];
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (r.zReports.length > 0) return r;
      noteEmpty(r);
    } catch {}
  }

  // Format learning, step 2: never seen this shape before — ask Claude to
  // identify *which sheet/column* holds each field (cheap: just a header/
  // sample preview, not the whole file). A successful schema is both used
  // immediately and saved, so the next file with this same shape skips AI
  // entirely (step 1 above).
  try {
    const schema = await _detectSchemaWithAI(buffer, filename);
    if (schema?.sheetName) {
      const r = _applySchema(buffer, schema, vatDivisor);
      if (r.zReports.length > 0) {
        // Validate before persisting: an implausible result (zero total, date in 1970,
        // future date) means the AI mapped the wrong columns. Don't save a poisoned
        // schema that would corrupt every future file with the same fingerprint.
        const now = new Date();
        const isPlausible = r.zReports.every(z =>
          z.total > 0 &&
          z.toDate instanceof Date &&
          !isNaN(z.toDate.getTime()) &&
          z.toDate.getFullYear() >= 2020 &&
          z.toDate.getFullYear() <= now.getFullYear() + 1
        );
        if (isPlausible) {
          const saved = await _saveOrTouchFormat(fingerprint, schema, filename, context.businessId);
          r._formatSource = 'learned_new';
          r._formatId = saved?.id || null;
          r._formatConfirmed = false;
        } else {
          logger.warn('[ZReport] AI schema produced implausible values — schema not saved to avoid poisoning future imports', {
            filename,
            sample: r.zReports.map(z => ({ total: z.total, toDate: z.toDate })),
          });
          r._formatSource = 'learned_new_unvalidated';
        }
        return r;
      }
    }
  } catch (schemaErr) {
    logger.warn('[ZReport] schema-detection failed, falling back to full AI extraction', { err: schemaErr.message, filename });
  }

  // Final fallback — schema detection couldn't produce a usable result either
  // (e.g. a non-spreadsheet format, or a layout too irregular to describe as
  // fixed columns). Ask Claude to extract the values directly, one-off, so
  // the import still succeeds even though this particular shape isn't
  // learnable as a reusable schema.
  try {
    const aiResult = await parseZReportWithAI(buffer, filename, context);
    if (aiResult.zReports.length > 0) return aiResult;
    // Valid JSON reporting zero Z-reports is a complete answer about the file,
    // not a failure to read it. This is the branch that was being reported as
    // "we could not read the file" for three days.
    noteEmpty(aiResult);
  } catch (aiErr) {
    logger.warn('[ZReport] AI fallback parser failed', { err: aiErr.message, filename });
  }

  // Debug: log actual xlsx sheet names so format failures can be diagnosed
  const KNOWN_EXT = ['.xlsx', '.xls', '.eml', '.pdf', '.csv', '.html', '.htm', '.xml', '.json', '.zip'];
  const isKnownType = KNOWN_EXT.includes(ext) || (buffer[0] === 0x50 && buffer[1] === 0x4B);
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      logger.warn('[ZReport] xlsx parse failed — actual sheet names', { filename, sheets: wb.SheetNames });
    } catch {}
  }

  // A supported format that simply couldn't be read is a different failure from
  // a format we don't handle, and saying "סוג קובץ לא נתמך: .xlsx" about a file
  // type we do support sends whoever reads it to inspect the file when the
  // cause was elsewhere. That happened for real: a Gmail scan reported it for
  // .xlsx Z-reports alongside two "timeout exceeded when trying to connect"
  // errors — the database was unreachable, so schema detection and the AI
  // fallback both failed, and the final throw blamed the extension.
  // Read fine, nothing in it. Distinct from a parse failure, and almost always
  // not a fault at all: a closed day, or an attachment that is a different kind
  // of report. Carries a code so callers can count it apart from real errors
  // instead of reporting a quiet day as a broken importer.
  if (parsedButEmpty) {
    logger.info('[ZReport] file parsed successfully but contains no Z rows', { filename, ext });
    const err = new Error(
      `הקובץ${filename ? ` "${filename}"` : ''} נקרא בהצלחה אך לא נמצאו בו שורות דוח Z. ` +
      `אם העסק היה סגור ביום הזה — זה תקין ואין מה לייבא. אם הוא היה פתוח, ייתכן שהקופה שלחה דוח מסוג אחר.`
    );
    err.code = 'ZREPORT_NO_DATA';
    err.isNoData = true;
    throw err;
  }

  if (isKnownType) {
    logger.warn('[ZReport] all parse strategies failed on a supported format', { filename, ext, mime });
    // Name the file. Without it a mailbox scan reports "we couldn't read the
    // file (.xlsx)" with no way to tell which of ninety-odd messages it came
    // from, so the same unreadable attachment gets rediscovered on every run
    // and looks like the whole import is broken.
    throw new Error(
      `לא הצלחנו לקרוא את הקובץ${filename ? ` "${filename}"` : ''} (${ext || mime || 'סוג לא ידוע'}) — הפורמט נתמך אך הפירוק נכשל. ` +
      `ייתכן שהמבנה שונה מהרגיל, או שהשירות היה זמנית לא זמין. נסה שוב, ואם זה חוזר — שלח את הקובץ לבדיקה.`
    );
  }
  throw new Error(`סוג קובץ לא נתמך: ${ext || mime || 'לא ידוע'}`);
}

// ── AI fallback parser (value-extraction) ───────────────────────────────────
// Last-resort fallback: used only when neither the hardcoded parsers nor the
// schema-learning path above (_detectSchemaWithAI + _applySchema) manage to
// find Z-report data — e.g. non-spreadsheet formats, or a layout irregular
// enough that it can't be described as fixed sheet/column positions. Converts
// the file to readable text and asks Claude to extract fields in one shot.
// Not learned/reused, by nature — there's no fixed schema to save here.
async function _extractReadableText(buffer, filename) {
  const ext = (filename ? path.extname(filename).toLowerCase() : '');

  if (ext === '.xlsx' || ext === '.xls' || (buffer[0] === 0x50 && buffer[1] === 0x4B)) {
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
      // Put the most-likely Z-summary sheet first so the 20k char limit doesn't
      // cut it off when item-detail sheets come before it in the original order.
      const Z_LIKE_NAMES = ['z', 'דוח', 'report', 'summary', 'סיכום', 'daily', 'יומי', 'beeport', 'מכירות'];
      // Known items/detail sheets must not be prioritised — 'מכירות' above would
      // otherwise match 'מכירות מנות' and push the items sheet to the front.
      const KNOWN_ITEMS_SHEETS = new Set(['פריטים', 'items', 'מוצרים', 'מנות', 'מכירות מנות', 'dishes']);
      const sorted = [...wb.SheetNames].sort((a, b) => {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        const aZ = !KNOWN_ITEMS_SHEETS.has(al) && Z_LIKE_NAMES.some(n => al.includes(n)) ? 0 : 1;
        const bZ = !KNOWN_ITEMS_SHEETS.has(bl) && Z_LIKE_NAMES.some(n => bl.includes(n)) ? 0 : 1;
        return aZ - bZ;
      });
      return sorted
        .map(name => `--- ${name} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`)
        .join('\n\n');
    } catch {}
  }

  if (ext === '.pdf' || (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46)) {
    try {
      const text = await _extractPdfText(buffer);
      if (text.trim()) return text;
    } catch {}
  }

  try {
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Crude binary-garbage check — if most characters got replaced/are
    // control chars, this probably wasn't real text (e.g. an unrecognized
    // binary format), so don't send it to the AI as if it were readable.
    const printable = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F�]/g, '');
    if (text.length > 0 && printable.length > text.length * 0.85) return text;
  } catch {}

  return null;
}

async function parseZReportWithAI(buffer, filename, context = {}) {
  const text = await _extractReadableText(buffer, filename);
  if (!text || text.trim().length < 20) return { zReports: [], items: [], shifts: [] };

  const prompt = `להלן תוכן קובץ עסקי (כנראה דוח Z / סיכום מכירות מקופה, מפורמט שלא זוהה אוטומטית). זהה את מבנה הקובץ וחלץ ממנו את כל נתוני דוחות ה-Z שאתה מוצא בפועל.

שם הקובץ: ${filename || 'לא ידוע'}
תוכן הקובץ:
"""
${text.slice(0, 20000).replace(/"""/g, "'''")}
"""

עבור כל דוח Z שמצאת, חלץ: מספר Z, תאריך, סה"כ כולל מע"מ, סה"כ ללא מע"מ (אם קיים בנפרד), מע"מ (אם קיים בנפרד), מספר הזמנות (אם קיים).
חלץ גם ערוצי מכירה אם מופיעים: מזומן (cash), אשראי (credit), וולט/Wolt, תן-ביס/Ten-Bis.
חלץ גם הנחות (discounts) וביטולים (cancellations) אם מופיעים בדוח — ביטולים הם עסקאות שבוטלו, הנחות הן הפחתות מחיר שניתנו.
אם יש טבלת פריטים/מנות (שם מוצר, כמות, סכום) עבור הדוח האחרון בלבד — חלץ אותה לשדה items.
אם יש גם טבלת משמרות עובדים (שם עובד + שעות עבודה), חלץ גם את זה.

החזר אך ורק JSON בפורמט הזה, ללא טקסט נוסף לפני/אחרי:
{
  "zReports": [
    { "zNumber": מספר, "date": "DD/MM/YYYY", "total": מספר, "totalNoVat": מספר או null, "vat": מספר או null, "ordersCount": מספר או null, "cash": מספר או null, "credit": מספר או null, "wolt": מספר או null, "tenBis": מספר או null, "discounts": מספר או null, "cancellations": מספר או null }
  ],
  "items": [
    { "name": "שם פריט/מנה", "qty": מספר, "total": מספר, "category": "קטגוריה או null" }
  ],
  "shifts": [
    { "employeeName": "שם", "totalHours": מספר, "date": "DD/MM/YYYY" או null }
  ]
}

חוקים קריטיים:
1. אל תמציא נתונים — רק מה שמופיע בפועל בקובץ
2. אם לא מצאת שום דוח Z אמיתי בקובץ, החזר zReports: []
3. אם totalNoVat/vat לא מופיעים בנפרד בקובץ, החזר null עבורם — המערכת תחשב אותם לבד לפי 18% מע"מ
4. אם ערוצי תשלום לא מופיעים בקובץ, החזר null עבורם (לא 0)
5. אם אין נתוני הנחות/ביטולים בקובץ, החזר null עבורם
6. אם אין טבלת פריטים, החזר items: []
7. אם אין טבלת משמרות, החזר shifts: []`;

  let result;
  try {
    result = await createWithRetry(anthropic, {
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }, { context: { feature: 'zreport_ai_fallback_parse', businessId: context.businessId } });
  } catch (aiErr) {
    logger.error('[ZReport AI-fallback] Claude call failed', { err: aiErr.message, filename, status: aiErr.status });
    return { zReports: [], items: [], shifts: [] };
  }

  if (result.stop_reason === 'max_tokens') {
    logger.warn('[ZReport AI-fallback] response truncated at max_tokens', { filename });
  }

  logTokenUsage({
    businessId: context.businessId || null,
    userId:     context.userId || null,
    feature:    'zreport_ai_fallback_parse',
    model:      'claude-haiku-4-5',
    usage:      result.usage,
  });

  const responseText = result.content.find(b => b.type === 'text')?.text?.trim() || '';
  const parsed = _parseAIJsonResponse(responseText);
  if (!parsed) {
    logger.error('[ZReport AI-fallback] invalid JSON from AI', { filename, snippet: responseText.slice(0, 200) });
    return { zReports: [], items: [], shifts: [] };
  }

  const { zReports, items, shifts } = _mapAIExtractedZReport(parsed, await _getVatDivisor(context));
  logger.info('[ZReport AI-fallback] extracted via AI', { filename, zReportsFound: zReports.length, itemsFound: items.length, shiftsFound: shifts.length });
  return { zReports, items, shifts };
}

// Shared JSON-from-AI-response parsing — tolerates markdown fences and preamble text.
// Uses a proper brace-depth walk instead of a greedy regex so that a '{' inside
// Claude's reasoning text doesn't cause the match to start before the real JSON.
function _parseAIJsonResponse(responseText) {
  const stripped = responseText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // Fast path: the whole stripped text is valid JSON
  try { return JSON.parse(stripped); } catch {}

  // Find every balanced {...} block and try each from last to first.
  // Last wins because Claude often puts the JSON after any thinking/preamble.
  const blocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') { if (depth++ === 0) start = i; }
    else if (stripped[i] === '}' && depth > 0) {
      if (--depth === 0 && start !== -1) { blocks.push(stripped.slice(start, i + 1)); start = -1; }
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { return JSON.parse(blocks[i]); } catch {}
  }
  return null;
}

// Shared mapping from the AI's {zReports:[...], shifts:[...]} JSON shape into
// our internal zReports/shifts records — used by both the text-based AI
// fallback and the image (Vision) OCR path, since both prompts return the
// same JSON schema.
function _mapAIExtractedZReport(parsed, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  // Same collision-guard as _parseFlatTable: two Z-reports for the same
  // calendar day in one AI response (e.g. a morning/evening split that the
  // AI correctly separated) would both get the same dateSerial fallback,
  // causing the bulk UPSERT to error with "cannot affect row a second time".
  const _dateSerialSeen = new Map();
  const dateSerialFallback = (date) => {
    const base = _dateSerial(date);
    const n = (_dateSerialSeen.get(base) || 0) + 1;
    _dateSerialSeen.set(base, n);
    return n === 1 ? base : base * 1000 + n;
  };

  const zReports = (Array.isArray(parsed.zReports) ? parsed.zReports : [])
    .map((z, i) => {
      const total  = _num(z.total);
      const toDate = _parseDateStr(z.date);
      if (!toDate || total <= 0) return null;
      const ordersCount = _num(z.ordersCount);
      return {
        // Use != null AND parseFloat check so a legitimate Z-report 0 is preserved
        // while non-numeric AI responses like "N/A" fall back to the date-serial
        // (avoiding duplicate pos_sale_id='Z-0' collisions in the bulk UPSERT).
        zNumber:     (z.zNumber != null && !Number.isNaN(parseFloat(String(z.zNumber))))
          ? _num(z.zNumber)
          : dateSerialFallback(toDate),
        fromDate:    toDate,
        toDate,
        total,
        totalNoVat:  z.totalNoVat != null ? _num(z.totalNoVat) : total / vatDivisor,
        vat:         z.vat != null ? _num(z.vat) : total - total / vatDivisor,
        avgPerOrder: ordersCount > 0 ? Math.round((total / ordersCount) * 100) / 100 : 0,
        ordersCount,
        cash:         z.cash          != null ? _num(z.cash)          : 0,
        credit:       z.credit        != null ? _num(z.credit)        : 0,
        wolt:         z.wolt          != null ? _num(z.wolt)          : 0,
        tenBis:       z.tenBis        != null ? _num(z.tenBis)        : 0,
        discount:     z.discounts     != null ? _num(z.discounts)     : (z.discount     != null ? _num(z.discount)     : 0),
        cancellation: z.cancellations != null ? _num(z.cancellations) : (z.cancellation != null ? _num(z.cancellation) : 0),
        paymentBreakdown: _buildJsonPaymentBreakdown(z),
      };
    })
    .filter(Boolean);

  const shifts = (Array.isArray(parsed.shifts) ? parsed.shifts : [])
    .map(s => {
      const employeeName = String(s.employeeName || '').trim();
      const totalHours   = _num(s.totalHours);
      if (!employeeName || totalHours <= 0 || totalHours > 24) return null;
      return { employeeName, totalHours: Math.round(totalHours * 100) / 100, shiftDate: s.date ? _parseDateStr(s.date) : null };
    })
    .filter(Boolean);

  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map(it => {
      const name = String(it.name || '').trim();
      if (!name) return null;
      const qty   = _num(it.qty   || 0);
      const total = _num(it.total || 0);
      return { name, category: String(it.category || '').trim(), qty, total, unitPrice: total / (qty || 1) };
    })
    .filter(Boolean);

  return { zReports, items, shifts };
}

// ── Image (photo) parser — Claude Vision ──────────────────────
// A photographed/scanned printed Z-report has no reusable tabular "shape" to
// fingerprint (unlike spreadsheets, it's pixels, not columns), so it always
// goes straight to one-shot Vision value-extraction — same architectural
// role as parseZReportWithAI's text fallback, just for images. Uses
// claude-sonnet-5 (not the cheaper haiku used elsewhere in this file)
// because reading a photographed receipt/printout reliably needs stronger
// vision OCR, matching the model already used for invoice photo OCR
// (see invoiceOCR.agent.js).
const IMAGE_OCR_PROMPT = `אתה מומחה OCR לדוחות Z ישראליים ממערכות קופה. לפניך תמונה/צילום של דוח Z מודפס (או צילום מסך). משימתך: לחלץ ממנו את נתוני דוח/י ה-Z ולהחזיר JSON בלבד.

עבור כל דוח Z שאתה מזהה בתמונה, חלץ:
- מספר Z, תאריך, סה"כ כולל מע"מ, סה"כ ללא מע"מ (אם מופיע), מע"מ (אם מופיע), מספר הזמנות (אם מופיע)
- ערוצי מכירה: מזומן (cash), אשראי (credit), וולט/Wolt, תן-ביס/Ten-Bis, ביט/Bit, פייבוקס/Paybox, מכר עתידי, שוברים/Vouchers
- הנחות (discounts) — אם מופיע סכום כולל הנחות לדוח
- ביטולים (cancellations) — אם מופיע מספר/סכום עסקאות שבוטלו
- החזרות (returns/refunds) — אם מופיע

אם מופיעה טבלת פריטים/מנות (שם מוצר, כמות, סכום) — חלץ אותה לשדה items (עבור הדוח האחרון בתמונה).
אם מופיעה טבלת משמרות עובדים (שם עובד + שעות עבודה) — חלץ לשדה shifts.

החזר אך ורק JSON בפורמט הזה, ללא טקסט נוסף לפני/אחרי:
{
  "zReports": [
    {
      "zNumber": מספר,
      "date": "DD/MM/YYYY",
      "total": מספר,
      "totalNoVat": מספר או null,
      "vat": מספר או null,
      "ordersCount": מספר או null,
      "cash": מספר או null,
      "credit": מספר או null,
      "wolt": מספר או null,
      "tenBis": מספר או null,
      "discounts": מספר או null,
      "cancellations": מספר או null,
      "returns": מספר או null
    }
  ],
  "items": [
    { "name": "שם פריט/מנה", "qty": מספר, "total": מספר, "category": "קטגוריה או null" }
  ],
  "shifts": [
    { "employeeName": "שם", "totalHours": מספר, "date": "DD/MM/YYYY" או null }
  ]
}

חוקים קריטיים:
1. אל תמציא נתונים — רק מה שמופיע בפועל וקריא בתמונה
2. אם התמונה מטושטשת/לא קריאה ואינך בטוח בערך — עדיף להשמיט אותו (null) מאשר לנחש
3. אם לא מצאת שום דוח Z אמיתי בתמונה, החזר zReports: []
4. אם ערוצי תשלום לא מופיעים, החזר null עבורם (לא 0)
5. אם אין טבלת פריטים, החזר items: []
6. discounts/cancellations/returns — null אם לא מופיעים בדוח, לא 0`;

async function _resizeImageForVision(buffer, ext) {
  if (ext === '.png') {
    return { mediaType: 'image/png', data: (await sharp(buffer).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 6 }).toBuffer()).toString('base64') };
  }
  if (ext === '.webp') {
    // Anthropic Vision accepts image/webp natively — pass it through without
    // transcoding to JPEG, which would degrade text sharpness on lossless WebP
    // screenshots and make small digits harder for the OCR model to read.
    return { mediaType: 'image/webp', data: (await sharp(buffer).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer()).toString('base64') };
  }
  return { mediaType: 'image/jpeg', data: (await sharp(buffer).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 95 }).toBuffer()).toString('base64') };
}

async function parseZReportImage(buffer, filename, context = {}) {
  const ext = (filename ? path.extname(filename).toLowerCase() : '.jpg');
  let mediaType, data;
  try {
    ({ mediaType, data } = await _resizeImageForVision(buffer, ext));
  } catch (err) {
    logger.error('[ZReport Image-OCR] failed to process image', { err: err.message, filename });
    return { zReports: [], items: [], shifts: [] };
  }

  let result;
  try {
    result = await createWithRetry(anthropic, {
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: IMAGE_OCR_PROMPT },
        ],
      }],
    }, { context: { feature: 'zreport_image_ocr', businessId: context.businessId } });
  } catch (err) {
    logger.error('[ZReport Image-OCR] Claude call failed', { err: err.message, filename });
    return { zReports: [], items: [], shifts: [] };
  }

  logTokenUsage({
    businessId: context.businessId || null,
    userId:     context.userId || null,
    feature:    'zreport_image_ocr',
    model:      'claude-sonnet-5',
    usage:      result.usage,
  });

  const responseText = result.content.find(b => b.type === 'text')?.text?.trim() || '';
  const parsed = _parseAIJsonResponse(responseText);
  if (!parsed) {
    logger.error('[ZReport Image-OCR] invalid JSON from AI', { filename, snippet: responseText.slice(0, 200) });
    return { zReports: [], items: [], shifts: [] };
  }

  const { zReports, items, shifts } = _mapAIExtractedZReport(parsed, await _getVatDivisor(context));
  logger.info('[ZReport Image-OCR] extracted via Vision', { filename, zReportsFound: zReports.length, itemsFound: items.length, shiftsFound: shifts.length });
  const out = { zReports, items, shifts };
  out._formatSource = 'image_ocr';
  return out;
}

// ── Flat table parser (CSV / HTML rows) ──────────────────────
// Tries to find date + total in any table with multiple columns
function _parseFlatTable(rows, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  if (rows.length < 2) return { zReports: [], items: [], shifts: [] };

  const headers = rows[0].map(h => String(h).toLowerCase().trim());
  const zReports = [];

  const colIdx = (names) => {
    for (const n of names) {
      // Try exact match first, then includes (for multi-word headers)
      let i = headers.findIndex(h => h === n);
      if (i < 0) i = headers.findIndex(h => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  // Counts _dateSerial collisions within THIS file so two rows sharing a date
  // (e.g. a morning/evening Z split) still get distinct pos_sale_ids — without
  // this, a multi-row-per-day file with no Z-number column would produce the
  // same fallback zNumber twice in one batch, and the bulk upsert's single
  // multi-row `ON CONFLICT DO UPDATE` errors ("cannot affect row a second
  // time") instead of just skipping/updating a duplicate.
  const _dateSerialSeen = new Map();
  const dateSerialFallback = (date) => {
    const base = _dateSerial(date);
    const n = (_dateSerialSeen.get(base) || 0) + 1;
    _dateSerialSeen.set(base, n);
    return n === 1 ? base : base * 1000 + n;
  };

  const dateCol    = colIdx(['תאריך','עד תאריך','date','to date','יום']);
  const totalCol   = colIdx(['סה"כ','סהכ','מכירות','total amount','total','amount','סכום']);
  const zCol       = colIdx(['מספר z','z number','znum','z-number','מס z']);
  const vatCol     = colIdx(['מע"מ','מעמ','vat']);
  const orderCol   = colIdx(['מספר הזמנות','הזמנות','orders','order count','ordercount']);
  const cashCol        = colIdx(['מזומן','cash','מזומן כולל','סהכ מזומן','total cash']);
  const creditCol      = colIdx(['אשראי','credit','dejavoo','אשראי חיצוני','כרטיס אשראי']);
  const woltCol        = colIdx(['wolt','וולט']);
  const tenBisCol      = colIdx(['תן ביס','ten bis','tenbis','תן-ביס','10bis']);
  const discountCol    = colIdx(['הנחות','הנחה','discount','discounts','מבצעים','הנחה מיוחדת']);
  const cancelCol      = colIdx(['ביטולים','ביטול','cancellations','cancellation','voids','void','זיכויים','ביטול עסקה']);

  if (totalCol < 0) {
    // No header match — try heuristic: second-to-last or last numeric column is total
    return _parseTextContent(rows.map(r => r.join(' ')).join('\n'), vatDivisor);
  }

  for (let i = 1; i < rows.length; i++) {
    const row   = rows[i];
    const total = _num(row[totalCol]);
    if (total <= 0) continue;

    const dateRawCell = dateCol >= 0 ? row[dateCol] : '';
    const toDate      = _parseDateStr(dateRawCell);
    if (!toDate) continue;
    const zNumber  = zCol >= 0 ? _num(row[zCol]) : dateSerialFallback(toDate);
    const vat      = vatCol >= 0 ? _num(row[vatCol]) : Math.round((total - total / vatDivisor) * 100) / 100;

    const ordersCount = orderCol >= 0 ? _num(row[orderCol]) : 0;
    const avgPerOrder = ordersCount > 0 ? Math.round((total / ordersCount) * 100) / 100 : 0;
    zReports.push({
      zNumber,
      fromDate: toDate,
      toDate,
      total,
      totalNoVat: Math.round((total - vat) * 100) / 100,
      vat,
      avgPerOrder, ordersCount,
      cash:         cashCol     >= 0 ? _num(row[cashCol])     : 0,
      credit:       creditCol   >= 0 ? _num(row[creditCol])   : 0,
      wolt:         woltCol     >= 0 ? _num(row[woltCol])     : 0,
      tenBis:       tenBisCol   >= 0 ? _num(row[tenBisCol])   : 0,
      discount:     discountCol >= 0 ? _num(row[discountCol]) : 0,
      cancellation: cancelCol   >= 0 ? _num(row[cancelCol])   : 0,
      paymentBreakdown: {},
    });
  }

  return { zReports, items: [], shifts: [] };
}

// ── Multi-Z table scanner ─────────────────────────────────────
// Some POS systems print a monthly summary as a line-per-Z table in PDF/TXT:
//   Z-123  01/08/2026  5,000.00
//   Z-124  02/08/2026  4,800.00
// Tries to find ≥2 such rows; returns parsed result or null if not found.
function _tryMultiZTable(lines, vatDivisor) {
  const seenZ = new Set();
  const rows  = [];
  for (const line of lines) {
    const dateM = line.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2}|\d{4})/);
    if (!dateM) continue;

    // Normalize 2-digit year (e.g. "26" → "2026") so _parseDateStr always gets 4 digits
    const yyyy = dateM[3].length === 2 ? '20' + dateM[3] : dateM[3];

    const beforeDate = line.slice(0, dateM.index);
    const afterDate  = line.slice(dateM.index + dateM[0].length);

    // Find the total first so we can exclude it from the Z-number search zone
    const totalM = afterDate.match(/[\d,]{4,}(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?/);
    if (!totalM) continue;
    const total = _num(totalM[0].replace(/,/g, ''));
    if (total < 100) continue;

    // Search for Z-number in beforeDate (normal: "Z-123  01/08/2026  5000")
    // AND in the slice of afterDate before the total (date-first: "01/08/2026  Z-123  5000")
    const beforeTotal = afterDate.slice(0, totalM.index);
    const searchZone  = beforeDate + ' ' + beforeTotal;
    const zNumM = searchZone.match(/(?:z[-\s]?)?(\d{2,5})(?:\s|$|[|,\t])/i);
    if (!zNumM) continue;
    const zNum = _num(zNumM[1]);
    if (!zNum || zNum < 1 || seenZ.has(zNum)) continue;

    const date = _parseDateStr(`${dateM[1]}/${dateM[2]}/${yyyy}`);
    if (!date) continue;
    seenZ.add(zNum);
    rows.push({ zNumber: zNum, toDate: date, total });
  }
  if (rows.length < 2) return null;
  return {
    zReports: rows.map(z => ({
      zNumber: z.zNumber, fromDate: z.toDate, toDate: z.toDate,
      total: z.total,
      totalNoVat: Math.round((z.total / vatDivisor) * 100) / 100,
      vat:        Math.round((z.total - z.total / vatDivisor) * 100) / 100,
      avgPerOrder: 0, ordersCount: 0, cash: 0, credit: 0, wolt: 0, tenBis: 0,
      discount: 0, cancellation: 0, paymentBreakdown: {},
    })),
    items: [], shifts: [],
  };
}

// ── Text/PDF content parser ───────────────────────────────────
// Extracts Z-report data from unstructured text using regex patterns
function _parseTextContent(text, vatDivisor = 1 + DEFAULT_VAT_RATE) {
  if (!text || text.trim().length < 10) return { zReports: [], items: [], shifts: [] };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Fast path: detect a multi-Z table (≥2 lines each with Z-number, date, total)
  const multiZ = _tryMultiZTable(lines, vatDivisor);
  if (multiZ) return multiZ;
  const zReports = [];

  // Find all dates in the text — use UTC noon to avoid timezone date shifts
  const dateMatches = [...text.matchAll(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/g)];
  const dates = dateMatches.map(m => new Date(Date.UTC(+m[3], +m[2]-1, +m[1], 12, 0, 0)));

  // Find all amounts that look like totals (numbers > 100 with optional commas/decimals)
  const amountPattern = /(\d{1,3}(?:[,\.]\d{3})*(?:[,\.]\d{1,2})?)/g;

  // Number-capture patterns below require a real thousands-grouping shape
  // (comma followed by exactly 3 digits) rather than a bare `[\d,\.]+`, which
  // would also swallow a CSV field separator followed by a short next field
  // (e.g. "2030,01" from "...,2030,01/06/2026,..." — a receipt number and a
  // date's day digits, not one number) whenever this free-text fallback runs
  // against comma-delimited content that its own structured parsers missed.

  // Try to find total and Z number with contextual regex
  // \b around the Latin "total" alternatives so this doesn't also match
  // inside an unrelated compound column header like "CashTotal"/"CardTotal"
  // (no \b on the Hebrew alternatives: JS's ASCII-only \w treats Hebrew
  // letters as non-word chars, so a boundary requirement there would fail to
  // match Hebrew text preceded by whitespace — the overwhelmingly common case)
  // [ \t]* (not \s*) between keyword and number — stays on the same line, so
  // a label with no value of its own (e.g. blank/malformed row) can't reach
  // across a newline and grab the FOLLOWING line's unrelated number instead
  const totalPatterns = [
    /(?:סה[""׳]?כ|\btotal\b|סכום כולל|\btotal sales\b|מכירות)[ \t]*:?[ \t]*((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))/i,
    /(?:\btotal\b|סה"כ)[ \t]+((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))/i,
    /((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))\s*(?:₪|NIS|nis)(?:\s|$)/,
    /(?:^|\s)(?:₪|NIS|nis)[ \t]*((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))/,
  ];

  const vatPatterns = [
    /(?:מע[""׳]?מ|\bvat\b|מס ערך מוסף)[ \t]*:?[ \t]*((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))/i,
  ];

  const ordersPatterns = [
    /(?:מספר הזמנות|כמות הזמנות|הזמנות|orders?(?:[ \t]*processed|[ \t]*count)?|order[ \t]*count)[ \t]*:?[ \t]*(\d+)/i,
  ];

  const zNumPatterns = [
    /(?:z\s*(?:מספר|number|#|num)?|דוח z)\s*:?\s*(\d+)/i,
    /^z[-\s]?(\d+)/im,
  ];

  let total = 0, vat = 0, zNumber = 0, ordersCount = 0;
  let totalFromKeyword = false;
  let zNumberFound = false;
  let toDate = dates[dates.length - 1] || new Date();

  for (const pat of totalPatterns) {
    const m = text.match(pat);
    if (m) { total = _num(m[1].replace(/,/g, '')); if (total > 0) { totalFromKeyword = true; break; } }
  }

  for (const pat of vatPatterns) {
    const m = text.match(pat);
    if (m) { vat = _num(m[1].replace(/,/g, '')); break; }
  }

  for (const pat of ordersPatterns) {
    const m = text.match(pat);
    if (m) { ordersCount = _num(m[1]); break; }
  }

  for (const pat of zNumPatterns) {
    const m = text.match(pat);
    if (m) { zNumber = _num(m[1]); zNumberFound = true; break; }
  }
  // No real document/report number found in the text — fall back to a
  // date-derived id (see _dateSerial) rather than a constant, so distinct
  // days from the same unrecognized layout don't collide on the same
  // pos_sale_id and silently overwrite each other on import.
  if (!zNumberFound) zNumber = _dateSerial(toDate);

  // If no total found by keyword, look for the largest plausible number.
  // The comma branch requires a full 3-digit group (real thousands
  // grouping, e.g. "12,337") — allowing 1-2 digits after a comma would also
  // match a plain CSV field separator followed by a short value (e.g. the
  // "2030,01" in "2030,01/06/2026,..."), silently concatenating two
  // unrelated fields into one bogus number.
  if (total <= 0) {
    // Cap at 1M ILS (realistic upper bound for a single restaurant day).
    // Exclude the Z-number itself — it's often a large integer that would
    // otherwise be picked as the "largest number" and silently become revenue.
    const allNums = [...text.matchAll(/\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{3,}(?:\.\d{1,2})?)\b/g)]
      .map(m => _num(m[1].replace(/,/g, '')))
      .filter(n => n >= 100 && n < 1_000_000 && n !== zNumber);
    if (allNums.length > 0) total = Math.max(...allNums);
  }

  if (total <= 0) return { zReports: [], items: [], shifts: [] };

  // Low-confidence guess: neither an explicit "total"/"סה"כ" keyword nor a
  // Z-number pattern matched anywhere — the total above came purely from
  // "largest number found in the whole document", which can just as easily
  // be an ID, phone number, or barcode as a real sales total. Bail out
  // (empty result) instead of confidently returning a wrong figure, so the
  // caller's parser chain moves on to something more reliable (eventually
  // the AI fallback) rather than silently importing bad data.
  if (!totalFromKeyword && !zNumberFound) return { zReports: [], items: [], shifts: [] };

  if (vat <= 0) vat = Math.round((total - total / vatDivisor) * 100) / 100;

  const _matchPayment = (patterns) => {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) return _num(m[1].replace(/,/g, ''));
    }
    return 0;
  };
  const NUM_PAT = '((?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?))'
  const cash        = _matchPayment([new RegExp('(?:מזומן|cash|מזומן כולל|סה[""׳]?כ מזומן)[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);
  const credit      = _matchPayment([new RegExp('(?:אשראי|credit|כרטיס אשראי|dejavoo|אשראי חיצוני)[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);
  const wolt        = _matchPayment([new RegExp('wolt[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);
  const tenBis      = _matchPayment([new RegExp('(?:תן[ \\t\\-]?ביס|ten[ \\t\\-]?bis|tenbis|10bis)[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);
  const discount    = _matchPayment([new RegExp('(?:הנחות|הנחה|discount|discounts|מבצעים)[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);
  const cancellation = _matchPayment([new RegExp('(?:ביטולים|ביטול|cancellations?|voids?|זיכויים|ביטול עסקה)[ \\t]*:?[ \\t]*' + NUM_PAT, 'i')]);

  zReports.push({
    zNumber,
    fromDate: toDate,
    toDate,
    total,
    totalNoVat: Math.round((total - vat) * 100) / 100,
    vat,
    avgPerOrder: ordersCount > 0 ? Math.round((total / ordersCount) * 100) / 100 : 0,
    ordersCount,
    cash,
    credit,
    wolt,
    tenBis,
    discount,
    cancellation,
    paymentBreakdown: {},
  });

  // Try to extract item lines — lines with: name, qty, price pattern
  const items = [];
  for (const line of lines) {
    const itemMatch = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+((?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?))\s*$/);
    if (itemMatch) {
      const qty   = _num(itemMatch[2]);
      const price = _num(itemMatch[3].replace(/,/g, ''));
      if (qty > 0 && price > 0) {
        items.push({ name: itemMatch[1].trim(), qty, total: price, unitPrice: price / qty });
      }
    }
  }

  return { zReports, items, shifts: [] };
}

// ── Date string parser (handles multiple formats) ─────────────
function _parseDateStr(s) {
  if (!s) return null;
  // XLSX cellDates:true returns JS Date objects for date cells — pass them through
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  const clean = String(s).trim();
  if (!clean) return null;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (Israeli format — takes priority)
  let m = clean.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (m) {
    let [, a, b, yyyy] = m;
    a = +a; b = +b;
    let dd, mm;
    if (a > 12) {
      // Unambiguous DD/MM: first component can only be a day
      dd = a; mm = b;
    } else if (b > 12) {
      // Unambiguous MM/DD: second component can only be a day (US format)
      mm = a; dd = b;
    } else {
      // Both ≤ 12 — ambiguous. Israeli DD/MM takes priority.
      dd = a; mm = b;
    }
    return new Date(Date.UTC(+yyyy, mm - 1, dd, 12, 0, 0));
  }

  // YYYY-MM-DD
  m = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 12, 0, 0));

  // ISO datetime string (from Date.toString() — fallback for stringified Date objects)
  const d = new Date(clean);
  if (!isNaN(d.getTime()) && clean.length > 6) return d;

  return null;
}

// ── Inventory decrement (exported so routes/imap/email services share one copy) ─
// saleId — the UUID of the sale record in the `sales` table for the last Z-report.
// By the time this runs, _syncDishesFromSaleItems has already backfilled recipe_id
// on every sale_item row that could be matched to a recipe. We query those links
// directly (primary path) and fall back to dish name-matching for any item whose
// recipe_id is still NULL.
async function decrementInventoryFromZItems(businessId, saleId, zReports = []) {
  if (!saleId) return;
  const { saveLowInventoryNotification, saveMissingIngredientsAlert } = require('./sync.service');

  // 7-day staleness guard — prevents corrupting current inventory with historical data.
  // Empty zReports means no date info → reject (unknown age is as risky as old age).
  if (zReports.length === 0) {
    logger.warn('[ZReport] skipping inventory decrement — no zReports date info');
    return;
  }
  const latestDate = zReports.reduce((max, z) => {
    const d = new Date(z.toDate || z.date || 0);
    return d > max ? d : max;
  }, new Date(0));
  if (Date.now() - latestDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
    logger.warn('[ZReport] skipping inventory decrement — report older than 7 days', { latestDate });
    return;
  }

  // Dedup guard — prevents double-deduction when the same Z-report is re-imported
  // (e.g. manual re-upload, concurrent Gmail/IMAP fetch racing a manual click).
  const { rows: alreadyApplied } = await db.query(
    `SELECT 1 FROM sales WHERE id = $1 AND inventory_applied_at IS NOT NULL LIMIT 1`,
    [saleId]
  ).catch(() => ({ rows: [] }));
  if (alreadyApplied.length > 0) {
    logger.info('[ZReport] inventory already applied for this sale — skipping dedup', { saleId });
    return;
  }

  // Query ingredients consumed by this Z-report's sold dishes.
  //
  // Three paths, tried in order of accuracy:
  //
  // 1. recipe_id → recipe_ingredients  (exact DB link + recipe_ingredients exist)
  //
  // 2. recipe_id set BUT no recipe_ingredients (business uses dish_ingredients)
  //    → look up dish_ingredients for the matching dish by name
  //
  // 3. No recipe_id → name-match to dishes, use dish_ingredients
  //    (catch-all for items that _syncDishesFromSaleItems couldn't resolve)
  //
  // Whitespace in names is normalized so "שניצל עוף " matches "שניצל עוף".
  const { rows: ingredientRows } = await db.query(`
    WITH ${INGREDIENT_SOURCE_CTE},
    sold AS (
      SELECT si.recipe_id, si.name, si.qty AS qty_sold
      FROM sale_items si
      WHERE si.sale_id = $2
    ),
    norm AS (
      SELECT recipe_id, qty_sold,
             regexp_replace(trim(lower(name)), '\\s+', ' ', 'g') AS nname
      FROM sold
    ),
    -- Paths 1+2 (merged): recipe_id → the authoritative ingredient list for that
    -- recipe, resolved by utils/ingredientSource.js.
    --
    -- These used to be two ordered paths: recipe_ingredients first, and the
    -- same-name dish only when the recipe had NO recipe_ingredients rows AT ALL.
    -- A recipe holding a stale partial copy — rows present, every item_id NULL —
    -- therefore matched Path 1 (which INNER JOINs inventory_items and so yielded
    -- nothing) while simultaneously disqualifying itself from Path 2. Result: a
    -- best-seller like "כריך אסאדו" deducted ZERO inventory on every sale, even
    -- though its dish definition was fully linked. That silent no-op is also
    -- what starved the leakage agent of any real "actual usage" signal.
    --
    -- The shared CTE picks whichever list is more completely linked, so both
    -- cases resolve through one path. GROUP BY collapses duplicate
    -- (recipe_id, item_id) rows that can exist when the UI allows adding the
    -- same ingredient twice.
    from_recipe_ing AS (
      SELECT n.qty_sold, ing.item_id, SUM(ing.qty) AS ingredient_qty
      FROM norm n
      JOIN ingredients ing ON ing.recipe_id = n.recipe_id
      JOIN inventory_items ii ON ii.id = ing.item_id AND ii.business_id = $1
      WHERE n.recipe_id IS NOT NULL
      GROUP BY n.qty_sold, ing.item_id
    ),
    -- Path 3: no recipe_id → dish_ingredients by normalized name.
    -- is_active filter prevents deducting archived dish ingredients.
    from_dish_name AS (
      SELECT n.qty_sold, di.inventory_item_id AS item_id, di.qty AS ingredient_qty
      FROM norm n
      JOIN dishes d ON regexp_replace(trim(lower(d.name)), '\\s+', ' ', 'g') = n.nname
                   AND d.business_id = $1
                   AND (d.is_active IS NULL OR d.is_active = TRUE)
      JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
      JOIN inventory_items ii ON ii.id = di.inventory_item_id AND ii.business_id = $1
      WHERE n.recipe_id IS NULL
    ),
    -- Path 4: recipe_id set but the recipe resolved to no ingredients at all →
    -- fall back to matching by the sale_item's OWN name against dishes (same
    -- logic as Path 3). This handles the case where _syncDishesFromSaleItems
    -- linked the item to a recipe whose name differs slightly from the dish name
    -- in the UI, so the recipe→dish name join inside the shared CTE missed —
    -- even though the sale_item name itself matches the dish name exactly.
    -- The guard is now simply "the shared CTE produced nothing for this recipe",
    -- which is the actual condition, rather than re-deriving it from the two
    -- source tables and getting it subtly wrong.
    from_sale_name_fallback AS (
      SELECT n.qty_sold, di.inventory_item_id AS item_id, di.qty AS ingredient_qty
      FROM norm n
      JOIN dishes d ON regexp_replace(trim(lower(d.name)), '\\s+', ' ', 'g') = n.nname
                   AND d.business_id = $1
                   AND (d.is_active IS NULL OR d.is_active = TRUE)
      JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
      JOIN inventory_items ii ON ii.id = di.inventory_item_id AND ii.business_id = $1
      WHERE n.recipe_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ingredients ing WHERE ing.recipe_id = n.recipe_id
        )
    )
    SELECT item_id, qty_sold, ingredient_qty FROM from_recipe_ing
    UNION ALL
    SELECT item_id, qty_sold, ingredient_qty FROM from_dish_name
    UNION ALL
    SELECT item_id, qty_sold, ingredient_qty FROM from_sale_name_fallback
  `, [businessId, saleId]);

  // Sold items that had NO ingredient path at all. Used for two things:
  //   1. the "missing ingredients" alert to the owner
  //   2. Path 5 — the name→inventory fallback below
  // Awaited (not fire-and-forget as before) because the fallback deduction needs
  // these rows before the UPDATE transaction runs. qty is summed per name so a
  // name that appears on several lines of the same Z deducts once, for the total.
  // Deliberately NOT filtered to active dishes. A commit on main added two
  // EXISTS guards here to stop the alert firing for deleted dishes; both were
  // removed on merge, for three reasons:
  //   1. A deleted dish that still sells is the single largest gap in this
  //      business (43 dishes, ILS 118k over 90 days with no deduction behind
  //      it). The owner asked to be told about it and offered a restore, which
  //      _saveMissingIngredientsAlert now does — suppressing the alert hides it.
  //   2. The recipe-side guard required a dish_recipes row, and nothing in the
  //      import ever writes one — a dish and its shadow recipe are matched by
  //      NAME. dish_recipes is empty in production, so that guard was always
  //      false and silenced the alert for legitimately active, unconfigured
  //      dishes too, not just deleted ones.
  //   3. These rows now also feed Path 5 (the name→inventory fallback) below.
  //      Narrowing them stops real deductions, not just alerts.
  const { rows: unmatchedSold } = await db.query(`
    SELECT trim(si.name) AS name, SUM(si.qty) AS qty_sold
    FROM sale_items si
    WHERE si.sale_id = $2
      AND (
        (si.recipe_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM recipe_ingredients ri
            JOIN inventory_items ii ON ii.id = ri.item_id AND ii.business_id = $1
            WHERE ri.recipe_id = si.recipe_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM recipes r
            JOIN dishes d ON regexp_replace(trim(lower(d.name)), '\\s+', ' ', 'g')
                           = regexp_replace(trim(lower(r.name)), '\\s+', ' ', 'g')
                         AND d.business_id = $1
                         AND (d.is_active IS NULL OR d.is_active = TRUE)
            JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
            WHERE r.id = si.recipe_id
          )
        )
        OR
        (si.recipe_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM dishes d
            JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
            WHERE regexp_replace(trim(lower(d.name)), '\\s+', ' ', 'g')
                  = regexp_replace(trim(lower(si.name)), '\\s+', ' ', 'g')
              AND d.business_id = $1
              AND (d.is_active IS NULL OR d.is_active = TRUE)
          )
        )
      )
    GROUP BY trim(si.name)
  `, [businessId, saleId]).catch(() => ({ rows: [] }));

  const decrements = {};
  const recipeItemIds = new Set();
  for (const row of ingredientRows) {
    const qty = parseFloat(row.qty_sold) * parseFloat(row.ingredient_qty);
    if (qty > 0) {
      decrements[row.item_id] = (decrements[row.item_id] || 0) + qty;
      recipeItemIds.add(row.item_id);
    }
  }

  // ── Path 5 — ניכוי לפי שם הפריט הנמכר, כשאין מנה/מתכון ──────────────────
  // רשת ביטחון צרה: מנכה רק כששם הפריט מספק גם את חומר הגלם (התאמה ייחודית
  // לפריט מלאי קיים) וגם את הכמות (משקל כתוב בשם, או פריט שנמדד ביחידות).
  // כל מקרה דו-משמעי נשאר בלי ניכוי ועם התראה — ראה utils/salesNameFallback.js.
  const fallbackItemIds = new Set();
  const deductedByName  = new Set();
  if (unmatchedSold.length) {
    const { rows: invItems } = await db.query(
      `SELECT id, name, unit FROM inventory_items WHERE business_id = $1`,
      [businessId]
    ).catch(() => ({ rows: [] }));

    for (const sold of unmatchedSold) {
      const hit = resolveFallbackDeduction(sold.name, sold.qty_sold, invItems);
      if (!hit) continue;
      decrements[hit.itemId] = (decrements[hit.itemId] || 0) + hit.qty;
      fallbackItemIds.add(hit.itemId);
      deductedByName.add(sold.name);
      logger.info('[ZReport] ניכוי לפי שם (ללא מתכון)', {
        businessId, sold: sold.name, item: hit.itemName, qty: hit.qty, basis: hit.basis,
      });
    }
  }

  // ההתראה נשלחת רק על מה שגם ה-fallback לא הצליח לפרש. פריט שנוכה לפי שמו
  // כבר לא "מרכיבים חסרים", והתראה עליו היא רעש.
  // fire-and-forget: התראה שנכשלת לא אמורה לעצור את הניכוי.
  const needsAlert = unmatchedSold.filter(s => s.name && !deductedByName.has(s.name));
  for (const sold of needsAlert) {
    saveMissingIngredientsAlert(businessId, sold.name).catch(() => {});
  }
  if (needsAlert.length > 0) {
    logger.info(`[ZReport] ${needsAlert.length} מנות ללא מרכיבים מוגדרים — נשלחה התראה`, {
      businessId, dishes: needsAlert.map(s => s.name),
    });
  }

  const entries = Object.entries(decrements).filter(([, d]) => d > 0);
  if (!entries.length) return;

  const updateValues = entries.map((_, i) => `($${i*2+1}::uuid, $${i*2+2}::float)`).join(', ');
  const updateParams = entries.flatMap(([itemId, decr]) => [itemId, decr]);
  const decrementMap = new Map(entries);

  // Retry up to 3 times on PostgreSQL serialization failures (error code 40001).
  // These happen when two concurrent decrements for the same business UPDATE
  // shared inventory_items rows at the same time. Exponential backoff prevents
  // thundering-herd on retry.
  const MAX_RETRIES = 3;
  let updatedItemIds = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = await db.getClient();
    let committed = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // RETURNING gives us the post-update qty_after required by the NOT NULL
      // constraint on inventory_transactions.qty_after.
      const { rows: updatedRows } = await client.query(
        `UPDATE inventory_items AS ii
         SET current_qty = GREATEST(0, ii.current_qty - v.decrement), updated_at = NOW()
         FROM (VALUES ${updateValues}) AS v(item_id, decrement)
         WHERE ii.id = v.item_id AND ii.business_id = $${entries.length*2+1}
         RETURNING ii.id AS item_id, ii.current_qty AS qty_after`,
        [...updateParams, businessId]
      );

      if (updatedRows.length > 0) {
        // הסיבה נשמרת כפרמטר (ולא כליטרל) כדי שניכוי שנעשה לפי שם הפריט,
        // בלי מתכון, יהיה מסומן ככזה בלדג'ר — אחרת אי אפשר לבקר בדיעבד מה
        // המערכת ניחשה לבד ומה הגיע ממתכון מוגדר.
        const txValues = updatedRows.map((_, i) => {
          const base = i * 5;
          return `($${base+1}, $${base+2}::uuid, $${base+3}::float, 'sale', $${base+4}, $${base+5}::float, NOW())`;
        }).join(', ');
        const txParams = updatedRows.flatMap(r => [
          businessId,
          r.item_id,
          -(decrementMap.get(r.item_id) || 0),
          (fallbackItemIds.has(r.item_id) && !recipeItemIds.has(r.item_id))
            ? 'הפחתה אוטומטית מדוח Z (התאמה לפי שם — ללא מתכון)'
            : 'הפחתה אוטומטית מדוח Z',
          parseFloat(r.qty_after),
        ]);
        await client.query(
          `INSERT INTO inventory_transactions (business_id, item_id, qty_change, type, reason, qty_after, created_at)
           VALUES ${txValues}`,
          txParams
        );
        // Atomically claim the sale by stamping only when inventory_applied_at IS NULL.
        // If a concurrent process already stamped it (retry scenario after 40001),
        // 0 rows are returned — we roll back our inventory changes and break out.
        const { rows: claimed } = await client.query(
          `UPDATE sales SET inventory_applied_at = NOW()
           WHERE id = $1 AND inventory_applied_at IS NULL RETURNING id`,
          [saleId]
        );
        if (claimed.length === 0) {
          await client.query('ROLLBACK');
          logger.info('[ZReport] inventory already applied by concurrent process — aborting retry', { saleId });
          committed = true; // not an error
          break;
        }
        await client.query('COMMIT');
        committed = true;
        updatedItemIds = updatedRows.map(r => r.item_id);
      } else {
        // No matching inventory rows to deduct, but still mark the sale processed
        // so a later import of the same Z doesn't reprocess it.
        const { rows: claimed } = await client.query(
          `UPDATE sales SET inventory_applied_at = NOW()
           WHERE id = $1 AND inventory_applied_at IS NULL RETURNING id`,
          [saleId]
        );
        if (claimed.length === 0) {
          await client.query('ROLLBACK');
          logger.info('[ZReport] sale already stamped by concurrent process — aborting retry', { saleId });
          committed = true;
          break;
        }
        await client.query('COMMIT');
        committed = true;
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      if (txErr.code === '40001' && attempt < MAX_RETRIES) {
        logger.debug('[ZReport] decrement serialization conflict, retrying', { attempt, businessId });
        await new Promise(res => setTimeout(res, attempt * 75));
      } else {
        logger.warn('[ZReport] inventory decrement transaction failed', { attempt, err: txErr.message });
      }
    } finally {
      client.release();
    }
    if (committed) break;
  }

  // Low-stock check runs after client is released to avoid pool contention under burst load
  if (updatedItemIds.length > 0) {
    const { rows: lowItems } = await db.query(
      `SELECT id, name, current_qty, unit, min_qty
       FROM inventory_items
       WHERE id = ANY($1::uuid[]) AND current_qty <= min_qty AND min_qty > 0`,
      [updatedItemIds]
    ).catch(() => ({ rows: [] }));
    for (const item of lowItems) {
      saveLowInventoryNotification(businessId, item).catch(() => {});
    }

    // ── רענון המסכים הפתוחים ────────────────────────────────────────────────
    // עמוד המלאי מאזין ל-'inventory.updated' ומרענן את עצמו (inventory/page.tsx),
    // אבל הניכוי עצמו לא פרסם שום אירוע. מתוך ארבעת הקוראים לפונקציה הזאת רק
    // ההעלאה הידנית (zreport.routes.js) פרסמה את האירוע בעצמה — ושלושת נתיבי
    // המייל (gmail.fetch / emailConfig / imap), שהם הנתיב שרץ בפועל כל בוקר
    // דרך ה-scheduler, לא פרסמו כלום.
    //
    // התוצאה שהמשתמש ראה: המלאי אכן ירד במסד, אבל המספר על המסך נשאר תקוע עד
    // רענון ידני של הדף — כלומר "המלאי לא מתנכה" מבחינתו.
    //
    // הפרסום נעשה כאן, בתוך הניכוי, ולא בכל קורא בנפרד: כך גם כל נתיב ייבוא
    // עתידי מקבל את הרענון בלי לזכור להוסיף אותו.
    try {
      eventBus.publish(businessId, 'inventory.updated', { source: 'zreport', items: updatedItemIds.length });
      eventBus.publish(businessId, 'dashboard.refresh', { reason: 'zreport_inventory' });
    } catch (e) {
      logger.warn('[ZReport] inventory.updated publish failed', { businessId, err: e.message });
    }
  }

  // inventory_applied_at is now stamped inside the deduction transaction above
  // (atomic with the deduction), so no separate post-commit UPDATE is needed.
}

// ── Standalone shift-file parser ──────────────────────────────
// Parses a file that contains ONLY shift data (no Z-report totals needed).
// Tries Excel sheets first, then CSV rows, then free text.
// Returns { shifts: [{ employeeName, totalHours, shiftDate }] }
function parseShiftsFile(buffer, filename = '') {
  const shifts = [];

  // 1. Try Excel
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
    const NON_SHIFT_SHEETS = new Set([
      'פירוט לפי Z', 'דוחות Z', 'z reports', 'Z Reports', 'דוח Z', 'zreports', 'reports',
      'פריטים', 'Items', 'items', 'מוצרים', 'מנות', 'מכירות מנות', 'Dishes',
    ]);
    for (const sheetName of wb.SheetNames) {
      if (NON_SHIFT_SHEETS.has(sheetName)) continue;
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
      if (rows.length < 2) continue;
      const s = _parseShiftRows(rows);
      shifts.push(...s);
    }
    if (shifts.length > 0) return { shifts };
  } catch {}

  // 2. Try CSV / plain text
  try {
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    // CSV → rows
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length >= 2) {
      const rows = lines.map(line => {
        const cells = []; let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQ = !inQ; }
          else if ((ch === ',' || ch === '\t') && !inQ) { cells.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        cells.push(cur.trim());
        return cells;
      });
      const csvShifts = _parseShiftRows(rows);
      if (csvShifts.length > 0) return { shifts: csvShifts };
    }

    // Free text fallback
    const textShifts = _parseShiftsFromText(text);
    if (textShifts.length > 0) return { shifts: textShifts };
  } catch {}

  return { shifts: [] };
}

// ── Employee auto-sync helpers (shared with gmail.fetch.service) ─────────────

function _normName(n) {
  return String(n || '').replace(/['"״׳`\-\.]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function _nameMatches(a, b) {
  const na = _normName(a);
  const nb = _normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length > 1);
  const wb = nb.split(' ').filter(w => w.length > 1);
  if (wa.length >= 2 && [...wa].reverse().join(' ') === nb) return true;
  if (wb.length >= 2 && [...wb].reverse().join(' ') === na) return true;
  const setA = new Set(wa);
  const shared = wb.filter(w => setA.has(w));
  return shared.length >= Math.min(2, Math.min(wa.length, wb.length));
}

async function _autoSyncEmployees(businessId) {
  const { rows: allNames } = await db.query(
    `SELECT LOWER(employee_name) AS lname, MIN(employee_name) AS employee_name
     FROM z_report_shifts WHERE business_id = $1 AND employee_id IS NULL
     GROUP BY LOWER(employee_name)`,
    [businessId]
  );
  if (!allNames.length) return;

  const { rows: allUsers } = await db.query(
    `SELECT id, full_name FROM users WHERE business_id = $1`,
    [businessId]
  );

  const nameToId = {};
  for (const emp of allNames) {
    const u = allUsers.find(u => u.full_name.toLowerCase() === emp.lname);
    if (u) nameToId[emp.lname] = u.id;
  }
  for (const emp of allNames.filter(r => !nameToId[r.lname])) {
    const u = allUsers.find(u => _nameMatches(u.full_name, emp.employee_name));
    if (u) nameToId[emp.lname] = u.id;
  }

  if (!Object.keys(nameToId).length) return;

  const empNames = Object.keys(nameToId);
  const empIds   = empNames.map(n => nameToId[n]);
  await db.query(
    `UPDATE z_report_shifts AS zrs
     SET employee_id = mapping.eid
     FROM (SELECT unnest($2::text[]) AS lname, unnest($3::uuid[]) AS eid) AS mapping
     WHERE zrs.business_id = $1
       AND zrs.employee_id IS NULL
       AND LOWER(zrs.employee_name) = mapping.lname`,
    [businessId, empNames, empIds]
  );
}

async function _syncZShiftsToShifts(businessId) {
  const { rows } = await db.query(
    `SELECT zrs.id, zrs.employee_id, zrs.report_date, zrs.total_hours
     FROM z_report_shifts zrs
     JOIN users u ON u.id = zrs.employee_id AND u.salary_type = 'hourly'
     WHERE zrs.business_id = $1
       AND zrs.employee_id IS NOT NULL
       AND zrs.total_hours > 0
       AND NOT EXISTS (
         SELECT 1 FROM shifts s WHERE s.z_report_shift_id = zrs.id
       )`,
    [businessId]
  );
  if (!rows.length) return 0;

  const values = rows.map((_, i) => {
    const b = i * 5;
    return `($${b+1}, $${b+2},
      ($${b+3}::date + time '08:00') AT TIME ZONE 'Asia/Jerusalem',
      ($${b+3}::date + time '08:00') AT TIME ZONE 'Asia/Jerusalem' + ($${b+4} * interval '1 hour'),
      'completed', 'מדוח Z', $${b+5})`;
  }).join(', ');

  const params = rows.flatMap(r => [businessId, r.employee_id, r.report_date, r.total_hours, r.id]);

  await db.query(
    `INSERT INTO shifts (business_id, employee_id, actual_start, actual_end, status, edit_note, z_report_shift_id)
     VALUES ${values}
     ON CONFLICT DO NOTHING`,
    params
  );

  logger.info('[ZReport] synced z_report_shifts → shifts', { businessId, count: rows.length });
  return rows.length;
}

async function syncEmployeesAndShifts(businessId) {
  await _autoSyncEmployees(businessId);
  await _syncZShiftsToShifts(businessId);
}

module.exports = {
  extractXlsxFromEml,
  parseZReportExcel,
  parseZReportCsv,
  parseZReportPdf,
  parseZReportTxt,
  parseZReportHtml,
  parseZReportXml,
  parseZReportJson,
  parseZReportZip,
  parseZReportImage,
  parseZReportAuto,
  parseShiftsFile,
  importToDatabase,
  decrementInventoryFromZItems,
  syncEmployeesAndShifts,
  syncDishesFromSaleItems: _syncDishesFromSaleItems,
  extractPdfText: _extractPdfText,
  // exported for tests — a silent regression here stops dish auto-creation
  // for every business, with no error anywhere (see _isValidDishName)
  isValidDishName: _isValidDishName,
};
