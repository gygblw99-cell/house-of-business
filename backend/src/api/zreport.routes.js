const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const logger   = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const db       = require('../utils/db');
const bcrypt   = require('bcryptjs');
const { parseZReportAuto, importToDatabase, syncDishesFromSaleItems, decrementInventoryFromZItems, syncEmployeesAndShifts } = require('../services/zreport.import.service');
const { getMissingDays, fetchZReportsForBusiness, isImapConfigured, isGlobalFallbackSafe } = require('../services/zreport.imap.service');
const {
  getEmailConfig, getEmailConfigWithPassword, saveEmailConfig, deleteEmailConfig,
  testEmailConnection, fetchWithConfig, updateLastFetched,
} = require('../services/zreport.emailConfig.service');
const { withTransaction } = require('../utils/transaction');
const { getZReportCoverage } = require('../services/zreportCoverage.service');
const { VAT_RATE } = require('../constants/business');
const { bustContextCache } = require('../services/ai/business.context');
const { saveLowInventoryNotification, dismissNotifications, fullCacheBust } = require('../services/sync.service');
const { fetchZReportsFromGmail } = require('../services/gmail.fetch.service');
const eventBus = require('../utils/eventBus');
const cache = require('../utils/cache');
const { todayIL } = require('../utils/dateIL');
const { validateBufferMagicBytes } = require('../utils/upload');

const router  = express.Router();

// Ensure businesses table has vat_rate column
db.migrate(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,4) DEFAULT ${VAT_RATE}`).catch(() => {});
// Track which z_report_shifts row produced each synthetic shifts record (enables precise dedup)
// The DO-block drops the column if it exists as INTEGER (wrong type from an earlier migration) before re-adding as UUID
db.migrate(`
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='shifts' AND column_name='z_report_shift_id' AND udt_name='int4'
    ) THEN ALTER TABLE shifts DROP COLUMN z_report_shift_id; END IF;
  END $$;
  ALTER TABLE shifts ADD COLUMN IF NOT EXISTS z_report_shift_id UUID REFERENCES z_report_shifts(id) ON DELETE SET NULL
`).catch(() => {});

// Bust all derived caches that are invalidated by new Z-report data.
// Delegates to fullCacheBust (single source of truth in sync.service.js)
// which already covers all 19 key families including zreport:missing.
async function _bustZRelatedCaches(businessId) {
  await fullCacheBust(businessId);
}

const ZREPORT_ALLOWED_EXT = new Set([
  '.eml', '.xlsx', '.xls', '.csv',
  '.pdf', '.txt', '.html', '.htm',
  '.xml', '.json', '.zip',
  '.jpg', '.jpeg', '.png', '.webp',
]);

// Allow any MIME ג€” rely on extension validation instead,
// since many POS systems send with wrong/generic MIME types.
const zreportFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ZREPORT_ALLOWED_EXT.has(ext)) {
    cb(null, true);
  } else {
    // Store the rejection reason so the route handler can return a clear error
    // instead of the misleading "לא צורף קובץ" that shows when req.file is undefined.
    req._fileRejected = { ext: ext || '(ללא סיומת)', name: file.originalname };
    cb(null, false);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: zreportFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ג”€ג”€ Auto-sync helpers moved to zreport.import.service (syncEmployeesAndShifts) ג”€

// זהה ימי שבוע שהעסק עבד בהם לפי דוחות Z ועדכן businesses.open_days
async function _updateOpenDaysFromZReports(businessId, dbConn) {
  const { rows } = await dbConn.query(
    `SELECT DISTINCT EXTRACT(DOW FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS dow
     FROM sales
     WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
       AND sold_at >= NOW() - INTERVAL '6 months'`,
    [businessId]
  );
  if (!rows.length) return;
  const activeDows = rows.map(r => r.dow).sort((a, b) => a - b);
  await dbConn.query(
    `UPDATE businesses SET open_days = $1::jsonb WHERE id = $2`,
    [JSON.stringify(activeDows), businessId]
  );
}

// POST /api/zreport/import — ייבוא קובץ בכל פורמט
router.post('/import', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!req.file) {
      if (req._fileRejected) {
        return res.status(400).json({
          error: `סוג קובץ לא נתמך: ${req._fileRejected.ext}`,
          hint: `סוגי קבצים נתמכים: ${[...ZREPORT_ALLOWED_EXT].join(', ')}`,
        });
      }
      return res.status(400).json({ error: 'לא צורף קובץ' });
    }

    // Content vs. declared-extension check for the binary formats (xlsx/zip/
    // pdf/images) ג€” this route previously relied on extension alone ("Allow
    // any MIME ג€” rely on extension validation instead"), the broadest
    // attacker-reachable parsing surface of any upload route in the app
    // (dispatches into XLSX/zip/XML/HTML/PDF parsers based on extension).
    const _ext = path.extname(req.file.originalname).toLowerCase();
    if (!validateBufferMagicBytes(req.file.buffer, _ext)) {
      return res.status(400).json({ error: `תוכן הקובץ לא תואם לסיומת ${_ext} — ודא שהקובץ תקין` });
    }

    let parsed;
    try {
      parsed = await parseZReportAuto(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
        { businessId, userId: req.user.userId },
      );
    } catch (parseErr) {
      return res.status(422).json({ error: `הקובץ אינו תקין: ${parseErr.message}` });
    }

    if (!parsed.zReports.length) {
      logger.warn('[ZReport] import failed ג€” no Z data found', {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        sheetsFound: parsed._sheetsFound || [],
      });
      return res.status(422).json({
        error: 'לא נמצאו נתוני דוח Z בקובץ — בדוק שהקובץ הנכון הועלה',
        debug: { sheetsFound: parsed._sheetsFound || [], zReportsFound: 0, shiftsFound: parsed.shifts?.length || 0 },
      });
    }

    const result = await importToDatabase(businessId, parsed);

    // סנכרון מנות מטופל בתוך importToDatabase — אין צורך בקריאה נפרדת

    let unmatchedEmployees = [];

    // Employee + shift sync only for genuinely new records
    if (result.imported > 0 && parsed.shifts?.length > 0) {
      try {
        await syncEmployeesAndShifts(businessId);
      } catch (e) {
        logger.warn('[ZReport] shift sync failed', { err: e.message });
      }
      const { rows: unmatched } = await db.query(
        `SELECT employee_name, COUNT(*)::int AS shift_count
         FROM z_report_shifts
         WHERE business_id = $1 AND employee_id IS NULL
         GROUP BY employee_name
         ORDER BY employee_name`,
        [businessId]
      );
      if (unmatched.length > 0) {
        const { rows: existingUsers } = await db.query(
          `SELECT id, full_name FROM users WHERE business_id = $1 AND is_active = TRUE ORDER BY full_name`,
          [businessId]
        );
        unmatchedEmployees = unmatched.map(r => ({ name: r.employee_name, shiftCount: r.shift_count }));
        unmatchedEmployees._existingUsers = existingUsers;
      }
    }

    // Always bust caches when any Z-reports were processed ג€” includes corrective re-uploads
    // that run DO UPDATE but return imported=0 (existing rows updated, not inserted).
    if (result.total > 0) {
      const tasks = [
        bustContextCache(businessId).catch(e => logger.warn('[ZReport] bustContextCache failed', { err: e.message })),
        _bustZRelatedCaches(businessId).catch(e => logger.warn('[ZReport] bustZRelatedCaches failed', { err: e.message })),
        _updateOpenDaysFromZReports(businessId, db).catch(e => logger.warn('[ZReport] updateOpenDays failed', { err: e.message })),
        dismissNotifications(businessId, 'zreport_missing').catch(() => {}),
      ];
      // Only decrement inventory for the last Z-report's items when that report is genuinely new.
      // Skipping when it's a duplicate prevents double-decrement on mixed new+existing batches.
      if (result?.lastZSaleId) {
        tasks.push(
          decrementInventoryFromZItems(businessId, result.lastZSaleId, parsed.zReports || [])
            .catch(e => logger.warn('[ZReport] decrementInventory failed', { err: e.message }))
        );
      }
      await Promise.all(tasks);
      try {
        eventBus.publish(businessId, 'dashboard.refresh', { reason: 'zreport' });
        eventBus.publish(businessId, 'inventory.updated', { source: 'zreport' });
        eventBus.publish(businessId, 'finance.updated',   { source: 'zreport' });
      } catch {}
    }

    const unmatchedArr = Array.isArray(unmatchedEmployees) ? unmatchedEmployees : [];
    const existingUsers = unmatchedEmployees._existingUsers || [];

    res.json({
      success: true,
      message: `יובאו ${result.imported} דוחות Z (${result.skipped} כבר קיימים), ${result.shiftsImported} משמרות עובדים`,
      ...result,
      unmatchedEmployees: unmatchedArr,
      existingUsers,
      // כשזוהה/נוצר פורמט חדש עבור ספק קופה שלא זוהה קודם (ראה
      // parseZReportAuto/_detectSchemaWithAI) — מאפשר לממשק להציע למשתמש
      // לאשר פעם אחת שהזיהוי נכון; לאחר אישור, כל קובץ באותה צורה מזוהה
      // אוטומטית תמיד, בלי לשאול שוב.
      newFormatLearned: parsed._formatSource === 'learned_new' ? {
        id:        parsed._formatId,
        zCount:    parsed.zReports.length,
        hasItems:  (parsed.items  || []).length > 0,
        hasShifts: (parsed.shifts || []).length > 0,
      } : null,
      // קובץ חודשי/מרובה-Z עם פריטים — מזהיר שפירוט מנות שייך לדוח האחרון בלבד
      multiZWithItems: parsed.zReports.length > 1 && (parsed.items || []).length > 0
        ? { zCount: parsed.zReports.length }
        : null,
      formatId: parsed._formatId || null,
      debug: {
        shiftsFound: parsed.shifts.length,
        zReportsFound: parsed.zReports.length,
        sheetsFound: [],
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/zreport/summary — סיכום מצטבר של כל דוחות Z שיובאו
// GET /api/zreport/coverage?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Says plainly whether the Z-report data for a period is actually there, and
// when it is not, why. Every financial number in the platform derives from
// Z-reports, and this pipeline has failed silently before — a bad token, a BOM,
// a wrong heuristic — with the UI showing figures rather than admitting it had
// nothing. Consumers should gate a headline figure on canReportFinancials.
router.get('/coverage', requireAuth, async (req, res, next) => {
  try {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const { from, to } = req.query;
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
      return res.status(400).json({ error: 'תאריכים חייבים להיות בפורמט YYYY-MM-DD' });
    }
    const coverage = await getZReportCoverage(req.user.businessId, { from, to });
    res.json(coverage);
  } catch (err) { next(err); }
});
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { rows: bizRows } = await db.query(
      `SELECT COALESCE(vat_rate, $2)::float AS vat_rate FROM businesses WHERE id = $1`,
      [businessId, VAT_RATE]
    );
    const vatRate = bizRows[0]?.vat_rate ?? VAT_RATE;

    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(s.total_amount), 0)::float          AS total_sales,
         COUNT(s.id)::int                                  AS total_transactions,
         COALESCE(SUM(s.total_amount * $2 / (1 + $2)), 0)::float AS total_vat,
         COALESCE(AVG(s.total_amount), 0)::float           AS avg_ticket,
         MIN(s.sold_at)                                     AS date_from,
         MAX(s.sold_at)                                     AS date_to,
         COALESCE(SUM(s.cash_amount),    0)::float          AS total_cash,
         COALESCE(SUM(s.credit_amount),  0)::float          AS total_credit,
         COALESCE(SUM(s.wolt_amount),    0)::float          AS total_wolt,
         COALESCE(SUM(s.ten_bis_amount), 0)::float          AS total_ten_bis,
         (
           SELECT si.name
           FROM sale_items si
           JOIN sales s2 ON s2.id = si.sale_id
           WHERE s2.business_id = $1 AND s2.pos_sale_id LIKE 'Z-%'
           GROUP BY si.name
           ORDER BY SUM(si.total_price) DESC
           LIMIT 1
         ) AS top_item
       FROM sales s
       WHERE s.business_id = $1 AND s.pos_sale_id LIKE 'Z-%'`,
      [businessId, vatRate]
    );

    const summary = rows[0] ?? { total_sales: 0, total_transactions: 0, total_vat: 0, avg_ticket: 0, date_from: null, date_to: null, top_item: null, total_cash: 0, total_credit: 0, total_wolt: 0, total_ten_bis: 0 };

    // פירוט כל הדוחות
    const { rows: recentRows } = await db.query(
      `SELECT pos_sale_id, total_amount::float AS total_amount, sold_at,
              cash_amount::float AS cash_amount, credit_amount::float AS credit_amount,
              wolt_amount::float AS wolt_amount, ten_bis_amount::float AS ten_bis_amount
       FROM sales
       WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
       ORDER BY sold_at DESC, id DESC LIMIT 500`,
      [businessId]
    );

    // הדוח האחרון שיש לו בפועל פירוט פריטים ב-sale_items
    // (לא בהכרח הדוח האחרון בתאריך — יובאי JSON/PDF/קבצים ללא גיליון פריטים לא שומרים פריטים)
    let lastReport = null;
    if (recentRows.length > 0) {
      const { rows: lastWithItemsRows } = await db.query(
        `SELECT s.pos_sale_id, s.total_amount::float AS total_amount, s.sold_at,
                s.cash_amount::float AS cash_amount, s.credit_amount::float AS credit_amount,
                s.wolt_amount::float AS wolt_amount, s.ten_bis_amount::float AS ten_bis_amount
         FROM sales s
         WHERE s.business_id = $1 AND s.pos_sale_id LIKE 'Z-%'
           AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id)
         ORDER BY s.sold_at DESC, s.id DESC
         LIMIT 1`,
        [businessId]
      );
      const last = lastWithItemsRows[0] || recentRows[0];
      const { rows: items } = await db.query(
        `SELECT si.name, si.qty, si.unit_price, si.total_price
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.business_id = $1 AND s.pos_sale_id = $2
         ORDER BY si.total_price DESC NULLS LAST LIMIT 20`,
        [businessId, last.pos_sale_id]
      );
      lastReport = { ...last, items };
    }

    res.json({ ...summary, reports: recentRows, lastReport, vatRate });
  } catch (err) {
    next(err);
  }
});

// PUT /api/zreport/vat-rate — עדכון שיעור מע"מ לעסק
router.put('/vat-rate', requireAuth, async (req, res, next) => {
  try {
    const rate = parseFloat(req.body.vatRate);
    if (isNaN(rate) || rate < 0 || rate > 1) {
      return res.status(400).json({ error: 'שיעור מע"מ לא חוקי — חייב להיות בין 0 ל-1 (לדוגמה: 0.18)' });
    }
    await db.query(`UPDATE businesses SET vat_rate = $1 WHERE id = $2`, [rate, req.user.businessId]);
    // Unlike every other mutating route in this file (import, sync-employees,
    // match-employee, auto-fetch, delete), this never busted any cache ג€” VAT
    // feeds finance-forecast/ai-context/weekly-report/insights/audit (see
    // sync.service.js's _allCacheKeys), all of which kept serving
    // pre-correction VAT-based figures until their own TTL expired.
    fullCacheBust(req.user.businessId).catch(() => {});
    eventBus.publish(req.user.businessId, 'finance.updated', { action: 'vat_rate_updated' });
    res.json({ vatRate: rate });
  } catch (err) { next(err); }
});

// GET /api/zreport/employees — נתוני עובדים מדוחות Z, שנה אחורה
router.get('/employees', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { rows } = await db.query(
      `SELECT
         zrs.employee_name,
         zrs.employee_id,
         u.full_name,
         u.email,
         u.is_active,
         COALESCE(u.pending_invite, false) AS is_stub,
         COUNT(*)                    AS shifts_count,
         SUM(zrs.total_hours)::float AS total_hours,
         MIN(zrs.report_date) AS first_shift,
         MAX(zrs.report_date) AS last_shift,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'date', zrs.report_date,
             'hours', zrs.total_hours::float
           ) ORDER BY zrs.report_date DESC
         ) AS shifts_log
       FROM z_report_shifts zrs
       LEFT JOIN users u ON u.id = zrs.employee_id
       WHERE zrs.business_id = $1
       GROUP BY zrs.employee_name, zrs.employee_id, u.full_name, u.email, u.is_active, u.pending_invite
       ORDER BY total_hours DESC`,
      [businessId]
    );
    res.json({ employees: rows });
  } catch (err) { next(err); }
});

// POST /api/zreport/sync-employees — קשר + צור עובדים מדוחות Z
router.post('/sync-employees', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    // כל השמות הייחודיים מדוחות Z
    const { rows: allNames } = await db.query(
      `SELECT DISTINCT employee_name FROM z_report_shifts WHERE business_id = $1`,
      [businessId]
    );

    const names    = allNames.map(r => r.employee_name);
    let linked = 0;
    const nameToId = {};

    // Match Z-report names to existing platform users only ג€” no stub creation
    if (names.length > 0) {
      const { rows: existingUsers } = await db.query(
        `SELECT id, full_name FROM users
         WHERE business_id = $1 AND LOWER(full_name) = ANY($2::text[])`,
        [businessId, names.map(n => n.toLowerCase())]
      );
      for (const u of existingUsers) {
        nameToId[u.full_name.toLowerCase()] = u.id;
        linked++;
      }
    }

    if (Object.keys(nameToId).length > 0) {
      const empNames = Object.keys(nameToId);
      const empIds   = empNames.map(n => nameToId[n]);
      await db.query(
        `UPDATE z_report_shifts AS zrs
         SET employee_id = mapping.eid
         FROM (
           SELECT unnest($2::text[]) AS lname, unnest($3::uuid[]) AS eid
         ) AS mapping
         WHERE zrs.business_id = $1
           AND LOWER(zrs.employee_name) = mapping.lname`,
        [businessId, empNames, empIds]
      );
    }

    // סנכרון משמרות ל-shifts (כולל נתונים היסטוריים)
    const shiftsSynced = await syncEmployeesAndShifts(businessId).catch(e => {
      logger.warn('[ZReport] syncZShiftsToShifts failed in sync-employees', { err: e.message });
      return 0;
    });

    await _bustZRelatedCaches(businessId).catch(() => {});
    eventBus.publish(businessId, 'employee.updated', { action: 'zreport_synced' });
    eventBus.publish(businessId, 'finance.updated',  { source: 'shift_sync' });
    res.json({
      message: `קושרו ${linked} עובדים, ${shiftsSynced} משמרות סונכרנו`,
      linked, total: allNames.length, shiftsSynced,
    });
  } catch (err) { next(err); }
});

// POST /api/zreport/match-employee — התאמה ידנית של שם מדוח Z לחשבון עובד קיים
router.post('/match-employee', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { employeeName, userId } = req.body;

    if (!employeeName?.trim()) return res.status(400).json({ error: 'חסר שם עובד' });
    if (!userId) return res.status(400).json({ error: 'חסר מזהה עובד' });

    // ודא שהעובד שייך לאותו עסק
    const { rows: userCheck } = await db.query(
      `SELECT id FROM users WHERE id = $1 AND business_id = $2`,
      [userId, businessId]
    );
    if (!userCheck.length) return res.status(400).json({ error: 'העובד לא נמצא בעסק זה' });

    // עדכן את כל השורות שמכילות שם זה ב-z_report_shifts
    const { rowCount } = await db.query(
      `UPDATE z_report_shifts
         SET employee_id = $1
       WHERE business_id = $2
         AND LOWER(employee_name) = LOWER($3)
         AND employee_id IS NULL`,
      [userId, businessId, employeeName.trim()]
    );

    // צור shifts מהשורות שרק עכשיו קיבלו employee_id
    const shiftsSynced = await syncEmployeesAndShifts(businessId).catch(() => 0);
    await _bustZRelatedCaches(businessId).catch(() => {});
    eventBus.publish(businessId, 'finance.updated', { source: 'manual_match' });

    res.json({ updated: rowCount, shiftsSynced });
  } catch (err) { next(err); }
});

// GET /api/zreport/unmatched-employees — עובדים לא ממופים + רשימת עובדים קיימים לדרופדאון
router.get('/unmatched-employees', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const [unmatched, users] = await Promise.all([
      db.query(
        `SELECT employee_name, COUNT(*)::int AS shift_count
         FROM z_report_shifts WHERE business_id = $1 AND employee_id IS NULL
         GROUP BY employee_name ORDER BY employee_name`,
        [businessId]
      ),
      db.query(
        `SELECT id, full_name FROM users WHERE business_id = $1 AND is_active = TRUE ORDER BY full_name`,
        [businessId]
      ),
    ]);
    res.json({
      unmatchedEmployees: unmatched.rows.map(r => ({ name: r.employee_name, shiftCount: r.shift_count })),
      existingUsers: users.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/zreport/status — ימים חסרים + האם IMAP מוגדר
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const [missingDays, lastRow, openDaysRow, totalRow, emailCfg, coverageRow,
           coveredDays30Row, confirmedFormatRow, employeeMatchRow] = await Promise.all([
      getMissingDays(businessId, 7),
      db.query(
        `SELECT MAX((sold_at AT TIME ZONE 'Asia/Jerusalem')::date) AS last_date FROM sales
         WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
        [businessId]
      ),
      db.query(`SELECT open_days FROM businesses WHERE id = $1`, [businessId]),
      db.query(
        `SELECT COUNT(DISTINCT (sold_at AT TIME ZONE 'Asia/Jerusalem')::date)::int AS total_days
         FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
        [businessId]
      ),
      getEmailConfig(businessId).catch(() => null),
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE s.business_id = $1 AND s.pos_sale_id LIKE 'Z-%') AS items_count,
           (SELECT COUNT(*)::int FROM z_report_shifts WHERE business_id = $1) AS shifts_count,
           (SELECT COUNT(*)::int FROM sales
            WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
              AND (credit_amount > 0 OR wolt_amount > 0 OR ten_bis_amount > 0)) AS payment_detail_count,
           (SELECT COUNT(*)::int FROM sales
            WHERE business_id = $1 AND sale_type = 'delivery'
              AND pos_sale_id NOT LIKE 'Z-%') AS delivery_orders_count`,
        [businessId]
      ),
      // ממד 2: כמה ימי Z נקלטו ב-30 הימים האחרונים (לחישוב יחס כיסוי בצד הלקוח)
      db.query(
        `SELECT COUNT(DISTINCT (sold_at AT TIME ZONE 'Asia/Jerusalem')::date)::int AS covered_days
         FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '30 days'`,
        [businessId]
      ),
      // ממד 3: האם יש פורמט קופה מאושר על-ידי המשתמש
      db.query(
        `SELECT COUNT(*)::int AS confirmed
         FROM z_report_formats WHERE first_business_id = $1 AND confidence = 'user_confirmed'`,
        [businessId]
      ),
      // ממד 4: אחוז שיוך עובדים
      db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE employee_id IS NOT NULL)::int AS matched
         FROM z_report_shifts WHERE business_id = $1`,
        [businessId]
      ),
    ]);

    const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const raw = openDaysRow.rows[0]?.open_days;
    let openDays;
    if (Array.isArray(raw)) {
      openDays = raw;
    } else if (raw && typeof raw === 'object') {
      openDays = Object.entries(raw).filter(([, v]) => v?.open).map(([k]) => DOW[k]).filter(d => d !== undefined);
    } else {
      openDays = [0, 1, 2, 3, 4, 5, 6];
    }

    const emailConfigured = !!(emailCfg?.is_active);
    const cov        = coverageRow.rows[0] || {};
    const totalDays  = totalRow.rows[0]?.total_days ?? 0;
    const itemsCount          = cov.items_count           ?? 0;
    const shiftsCount         = cov.shifts_count          ?? 0;
    const paymentCount        = cov.payment_detail_count  ?? 0;
    const deliveryOrdersCount = cov.delivery_orders_count ?? 0;

    // ממד 1: רעננות — כמה ימים עברו מהדוח האחרון
    const lastDate = lastRow.rows[0]?.last_date ?? null;
    const daysSinceLastReport = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86_400_000)
      : null;

    // ממד 2: יחס כיסוי 30 ימים — expected = ימי פעילות לפי openDays.
    // Anchored on todayIL(), not Date.now() ג€” d.getDay() resolves in the
    // server's local timezone (UTC), 2-3 hours behind Israel's calendar date,
    // which could compute the wrong weekday for the day boundary and skew
    // expectedDays30 (and therefore the coverage ratio shown to the user).
    const coveredDays30 = coveredDays30Row.rows[0]?.covered_days ?? 0;
    const [_zy, _zm, _zd] = todayIL().split('-').map(Number);
    const todayILMidnightUTC = Date.UTC(_zy, _zm - 1, _zd);
    let expectedDays30 = 0;
    for (let i = 1; i <= 30; i++) {
      const d = new Date(todayILMidnightUTC - i * 86_400_000);
      if (openDays.includes(d.getUTCDay())) expectedDays30++;
    }

    // ממד 3: פורמט מאושר
    const hasConfirmedFormat = (confirmedFormatRow.rows[0]?.confirmed ?? 0) > 0;

    // ממד 4: אחוז שיוך עובדים
    const totalShifts   = employeeMatchRow.rows[0]?.total   ?? 0;
    const matchedShifts = employeeMatchRow.rows[0]?.matched ?? 0;

    res.json({
      missingDays,
      lastReportDate: lastDate,
      imapConfigured: isImapConfigured() || emailConfigured,
      emailConfigured,
      // last_success_* is carried alongside last_result so the screen can say
      // "last imported 3 reports this morning" even when the most recent scan
      // came back empty ג€” otherwise a routine no-new-mail run reads as a fault.
      emailConfig: emailCfg ? {
        email:               emailCfg.email,
        last_fetched_at:     emailCfg.last_fetched_at,
        last_result:         emailCfg.last_result,
        last_success_at:     emailCfg.last_success_at,
        last_success_result: emailCfg.last_success_result,
      } : null,
      openDays,
      totalZDays: totalDays,
      coverage: {
        hasRevenue:        totalDays            > 0,
        hasItems:          itemsCount           > 0,
        hasShifts:         shiftsCount          > 0,
        hasPaymentDetail:  paymentCount         > 0,
        hasDeliveryData:   deliveryOrdersCount  > 0,
        revenueDays:         totalDays,
        itemsCount,
        shiftsCount,
        paymentDetailCount:  paymentCount,
        deliveryOrdersCount,
        // 4 ממדים נוספים
        daysSinceLastReport,
        isFresh:             daysSinceLastReport !== null && daysSinceLastReport <= 7,
        coveredDays30,
        expectedDays30,
        coverageRatio:       expectedDays30 > 0 ? Math.round(coveredDays30 / expectedDays30 * 100) : null,
        hasConfirmedFormat,
        totalShifts,
        matchedShifts,
        employeeMatchRate:   totalShifts > 0 ? Math.round(matchedShifts / totalShifts * 100) : null,
      },
    });
  } catch (err) { next(err); }
});

// ג”€ג”€ shared helper used by both /auto-fetch and /email-config/fetch ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€
async function _doEmailFetch(businessId) {
  // חשב חלון חיפוש דינמי — מכסה ימים חסרים עד 90 יום אחורה
  const DEFAULT_LOOKBACK = 14;
  const MAX_LOOKBACK = 90;
  let daysBack = DEFAULT_LOOKBACK;
  try {
    const missing = await getMissingDays(businessId, MAX_LOOKBACK);
    if (missing.length > 0) {
      const israelToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
      const todayMs = new Date(israelToday).getTime();
      const oldestMs = new Date(missing[0]).getTime();
      const gapDays = Math.ceil((todayMs - oldestMs) / 86_400_000);
      daysBack = Math.max(DEFAULT_LOOKBACK, Math.min(gapDays + 1, MAX_LOOKBACK));
    }
  } catch { /* ignore ג€” fall back to default */ }

  if (daysBack > DEFAULT_LOOKBACK) {
    logger.info(`[ZReport manual-fetch] biz=${businessId} gap detected ג€” extending lookback to ${daysBack} days`);
  }

  // 1. Gmail OAuth — עדיפות ראשונה (כמו בסקדולר)
  const gmailResult = await fetchZReportsFromGmail(businessId, daysBack).catch(() => null);
  // If Gmail is connected but the fetch itself failed (_fetchFailed), fall through to IMAP
  // so the user's IMAP config is tried as a backup and the error doesn't silently disappear.
  if (gmailResult !== null && !gmailResult._fetchFailed) {
    await updateLastFetched(businessId, { ...gmailResult, source: 'gmail' });
    return {
      imported:      gmailResult.imported ?? 0,
      skipped:       0,
      emailsScanned: gmailResult.scanned  ?? 0,
      errors:        gmailResult.errors   ?? [],
    };
  }

  // 2. IMAP per-business config
  const perBizConfig = await getEmailConfigWithPassword(businessId).catch(() => null);
  const hasPerBiz = perBizConfig?.is_active && perBizConfig.app_password;
  const hasGlobal = !hasPerBiz && isImapConfigured() && await isGlobalFallbackSafe();
  if (!hasPerBiz && !hasGlobal) return null;

  let result;
  if (hasPerBiz) {
    result = await fetchWithConfig(businessId, perBizConfig, daysBack);
    await updateLastFetched(businessId, result);
  } else {
    result = await fetchZReportsForBusiness(businessId, daysBack);
  }
  return result;
}

// POST /api/zreport/auto-fetch — הפעל שליפה ידנית מ-IMAP עכשיו
router.post('/auto-fetch', requireAuth, async (req, res, next) => {
  try {
    const bId = req.user.businessId;
    const result = await _doEmailFetch(bId);

    if (!result) {
      return res.status(503).json({ error: 'לא הוגדר חיבור מייל — הגדר חיבור מייל בהגדרות' });
    }

    if (result.imported > 0) {
      await Promise.all([
        bustContextCache(bId).catch(e => logger.warn('[ZReport/auto-fetch] bustContextCache failed', { err: e.message })),
        _bustZRelatedCaches(bId).catch(e => logger.warn('[ZReport/auto-fetch] bustZRelatedCaches failed', { err: e.message })),
        dismissNotifications(bId, 'zreport_missing').catch(() => {}),
      ]);
      // SSE events are already emitted by fullCacheBust inside _bustZRelatedCaches ג€” no need to publish again
      syncEmployeesAndShifts(bId).catch(e => logger.warn('[ZReport/auto-fetch] syncEmployeesAndShifts failed', { err: e.message }));
      _updateOpenDaysFromZReports(bId, db).catch(e => logger.warn('[ZReport/auto-fetch] updateOpenDays failed', { err: e.message }));
    }
    res.json({
      success: true,
      message: result.imported > 0
        ? `יובאו ${result.imported} דוחות Z חדשים (${result.emailsScanned} מיילים נסרקו)`
        : `לא נמצאו דוחות Z חדשים (${result.emailsScanned} מיילים נסרקו)`,
      ...result,
    });
  } catch (err) { next(err); }
});

// ג”€ג”€ Email config (per-business Z-report auto-fetch) ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€

// GET /api/zreport/email-config ג€” returns config (no password)
router.get('/email-config', requireAuth, async (req, res, next) => {
  try {
    const config = await getEmailConfig(req.user.businessId);
    res.json({ config: config || null });
  } catch (err) { next(err); }
});

// POST /api/zreport/email-config ג€” save config
router.post('/email-config', requireAuth, async (req, res, next) => {
  try {
    const { email, app_password, imap_host, imap_port, sender_filter, subject_filter } = req.body;
    if (!email || !app_password) return res.status(400).json({ error: 'email ו-app_password נדרשים' });
    await saveEmailConfig(req.user.businessId, { email, app_password, imap_host, imap_port, sender_filter, subject_filter });
    const config = await getEmailConfig(req.user.businessId);
    res.json({ success: true, config });
  } catch (err) { next(err); }
});

// DELETE /api/zreport/email-config ג€” remove config
router.delete('/email-config', requireAuth, async (req, res, next) => {
  try {
    await deleteEmailConfig(req.user.businessId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/zreport/email-config/test ג€” test connection without saving
router.post('/email-config/test', requireAuth, async (req, res, next) => {
  try {
    const { email, app_password, imap_host, imap_port } = req.body;
    if (!email || !app_password) return res.status(400).json({ error: 'email ו-app_password נדרשים' });
    const result = await testEmailConnection({ email, app_password, imap_host, imap_port });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/zreport/email-config/fetch ג€” alias for /auto-fetch (same post-import steps)
router.post('/email-config/fetch', requireAuth, async (req, res, next) => {
  try {
    const bId = req.user.businessId;
    const result = await _doEmailFetch(bId);
    if (!result) return res.status(503).json({ error: 'לא הוגדר חיבור מייל — הגדר חיבור מייל בהגדרות' });
    if (result.imported > 0) {
      await Promise.all([
        bustContextCache(bId).catch(() => {}),
        _bustZRelatedCaches(bId).catch(() => {}),
        dismissNotifications(bId, 'zreport_missing').catch(() => {}),
      ]);
      syncEmployeesAndShifts(bId).catch(e => logger.warn('[ZReport/email-config/fetch] syncEmployeesAndShifts failed', { err: e.message }));
      _updateOpenDaysFromZReports(bId, db).catch(e => logger.warn('[ZReport/email-config/fetch] updateOpenDays failed', { err: e.message }));
    }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /api/zreport/export — ייצוא Excel: דוחות Z + משמרות עובדים
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const XLSX = require('xlsx');

    const [zRes, shiftRes, bizRes] = await Promise.all([
      db.query(
        `SELECT pos_sale_id, total_amount, sold_at, orders_count, avg_per_order
         FROM sales WHERE business_id=$1 AND pos_sale_id LIKE 'Z-%'
         ORDER BY sold_at ASC`,
        [businessId]
      ),
      db.query(
        `SELECT zrs.report_date, zrs.employee_name, zrs.total_hours, u.full_name AS matched_name
         FROM z_report_shifts zrs
         LEFT JOIN users u ON u.id = zrs.employee_id
         WHERE zrs.business_id=$1
         ORDER BY zrs.report_date ASC, zrs.employee_name ASC`,
        [businessId]
      ),
      db.query(`SELECT name, COALESCE(vat_rate, $2) AS vat_rate FROM businesses WHERE id=$1`, [businessId, VAT_RATE]),
    ]);

    const bizName = bizRes.rows[0]?.name || 'עסק';
    const exportVatRate = parseFloat(bizRes.rows[0]?.vat_rate) || VAT_RATE;
    const wb = XLSX.utils.book_new();

    // ── גיליון 1: דוחות Z ───────────────────────────────────────
    const fmtDate = d => new Date(d).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const fmtNum  = n => Math.round((n || 0) * 100) / 100;

    const zHeaders = ['מספר Z', 'תאריך', 'סכום (₪)', 'מע"מ (₪)', 'מספר הזמנות', 'ממוצע להזמנה (₪)'];
    const zRows = zRes.rows.map(r => [
      r.pos_sale_id,
      fmtDate(r.sold_at),
      fmtNum(r.total_amount),
      fmtNum(r.total_amount * exportVatRate / (1 + exportVatRate)),
      r.orders_count || 0,
      fmtNum(r.avg_per_order),
    ]);

    const ws1 = XLSX.utils.aoa_to_sheet([zHeaders, ...zRows]);
    ws1['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'דוחות Z');

    // ── גיליון 2: משמרות עובדים ────────────────────────────────
    if (shiftRes.rows.length > 0) {
      const shiftHeaders = ['תאריך', 'שם עובד', 'שם מקושר', 'שעות'];
      const shiftRows = shiftRes.rows.map(r => [
        fmtDate(r.report_date),
        r.employee_name,
        r.matched_name || 'ג€”',
        fmtNum(r.total_hours),
      ]);
      const ws2 = XLSX.utils.aoa_to_sheet([shiftHeaders, ...shiftRows]);
      ws2['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 8 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'משמרות עובדים');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = encodeURIComponent(`דוחות-Z-${bizName}-${new Date().toLocaleDateString('he-IL').replace(/\//g, '-')}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) { next(err); }
});

// POST /api/zreport/sync-dishes — סנכרון מנות מנתונים קיימים (ללא צורך בהעלאת קובץ)
router.post('/sync-dishes', requireAuth, async (req, res, next) => {
  try {
    await syncDishesFromSaleItems(req.user.businessId);
    eventBus.publish(req.user.businessId, 'inventory.updated', { action: 'zreport_dishes_synced' });
    res.json({ success: true, message: 'מנות סונכרנו בהצלחה מנתוני המכירות' });
  } catch (err) { next(err); }
});

// DELETE /api/zreport/selected — מחיקת דוחות Z ספציפיים לפי pos_sale_id
router.delete('/selected', requireAuth, async (req, res, next) => {
  try {
    const biz    = req.user.businessId;
    const posIds = req.body?.posIds;
    if (!Array.isArray(posIds) || posIds.length === 0)
      return res.status(400).json({ error: 'נדרש מערך posIds' });

    const { rowCount } = await db.query(
      `DELETE FROM sales WHERE business_id = $1 AND pos_sale_id = ANY($2::text[])`,
      [biz, posIds]
    );
    await _bustZRelatedCaches(biz).catch(e => logger.warn('[ZReport/delete-selected] bustCaches failed', { err: e.message }));
    bustContextCache(biz).catch(() => {});
    // SSE already emitted by fullCacheBust inside _bustZRelatedCaches
    res.json({ ok: true, deleted: rowCount, message: `נמחקו ${rowCount} דוחות Z` });
  } catch (err) { next(err); }
});

// DELETE /api/zreport/all — מחיקת כל דוחות ה-Z של העסק (איפוס מלא)
router.delete('/all', requireAuth, async (req, res, next) => {
  try {
    const biz = req.user.businessId;

    // Both deletes are one unit of work: this endpoint's contract is "the
    // Z-report data is gone". Run separately, a failure on the second left the
    // sales deleted and the shift logs behind — and the .catch(() => {}) meant
    // that happened silently, reporting success with the reset half-done. The
    // owner's next move is to re-import, which then double-counts those shifts.
    const rowCount = await withTransaction(async (client) => {
      const { rowCount: salesDeleted } = await client.query(
        `DELETE FROM sales
          WHERE business_id = $1
            -- pos_sale_id LIKE 'Z-%' is the Z-report marker, as in getMissingDays.
            -- This also tested , a column that does not exist in
            -- the schema and that nothing writes, so this endpoint threw
            -- "column source does not exist" on every call.
            AND pos_sale_id LIKE 'Z-%'`,
        [biz]
      );

      // Employee shift logs that came from Z-reports.
      await client.query(
        `DELETE FROM z_report_shifts WHERE business_id = $1`,
        [biz]
      );

      return salesDeleted;
    });

    // Bust all related caches (SSE already emitted by fullCacheBust inside _bustZRelatedCaches)
    await _bustZRelatedCaches(biz).catch(e => logger.warn('[ZReport/delete-all] bustCaches failed', { err: e.message }));
    bustContextCache(biz).catch(() => {});

    res.json({ ok: true, deleted: rowCount, message: `נמחקו ${rowCount} דוחות Z — המערכת אופסה` });
  } catch (err) { next(err); }
});

// POST /api/zreport/formats/:id/confirm — אישור חד-פעמי לפורמט קופה שזוהה
// אוטומטית לראשונה. לא חוסם שימוש חוזר (הפורמט כבר פעיל ומזוהה אוטומטית
// מהעלאה הראשונה) — רק מסמן שמשתמש בדק וידאם שהזיהוי נכון.
router.post('/formats/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE z_report_formats SET confidence = 'user_confirmed' WHERE id = $1 AND first_business_id = $2 RETURNING id, confidence`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'פורמט לא נמצא' });
    res.json({ ok: true, format: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
