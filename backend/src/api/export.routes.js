const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../utils/db');
const { getMonthlySummary } = require('../services/finance/cashflow.service');
const { todayIL } = require('../utils/dateIL');
const { EXPENSE_ACTIVE_TODAY, EXPENSE_ACTIVE_TODAY_AS } = require('../utils/expenseWindow');

// ── helpers ──────────────────────────────────────────────────
function sendXlsx(res, workbook, filename) {
  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

function makeWorkbook(sheetName, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

// ── GET /api/export/employees ─────────────────────────────────
router.get('/employees', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.full_name                               AS "שם מלא",
              COALESCE(u.email, '')                     AS "אימייל",
              COALESCE(u.phone, '')                     AS "טלפון",
              CASE u.role
                WHEN 'manager'  THEN 'מנהל'
                WHEN 'employee' THEN 'עובד'
                ELSE u.role
              END                                       AS "תפקיד",
              CASE u.salary_type
                WHEN 'hourly' THEN 'שעתי'
                WHEN 'global' THEN 'גלובלי'
                ELSE ''
              END                                       AS "סוג שכר",
              u.salary_amount::float                    AS "סכום שכר",
              u.tax_credit_points::float                AS "נקודות זיכוי",
              CASE WHEN u.is_active THEN 'פעיל' ELSE 'לא פעיל' END AS "סטטוס",
              to_char(u.created_at, 'DD/MM/YYYY')       AS "תאריך הצטרפות"
         FROM users u
        WHERE u.business_id = $1 AND u.role != 'owner'
        ORDER BY u.full_name
        LIMIT 2000`,
      [req.user.businessId]
    );
    sendXlsx(res, makeWorkbook('עובדים', rows), 'עובדים');
  } catch (err) { next(err); }
});

// ── GET /api/export/inventory ─────────────────────────────────
router.get('/inventory', requireAuth, requirePermission('inventory'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT i.name                                    AS "שם פריט",
              COALESCE(c.name, '')                      AS "קטגוריה",
              i.current_qty::float                      AS "כמות נוכחית",
              i.unit                                    AS "יחידה",
              i.min_qty::float                          AS "מינימום",
              COALESCE(i.cost_per_unit, 0)::float       AS "עלות ליחידה",
              ROUND((i.current_qty * COALESCE(i.cost_per_unit, 0))::numeric, 2) AS "שווי כולל",
              CASE WHEN i.current_qty <= i.min_qty THEN 'נמוך' ELSE 'תקין' END AS "מצב מלאי",
              to_char(i.updated_at, 'DD/MM/YYYY HH24:MI') AS "עדכון אחרון"
         FROM inventory_items i
         LEFT JOIN inventory_categories c ON c.id = i.category_id
        WHERE i.business_id = $1
        ORDER BY i.name
        LIMIT 5000`,
      [req.user.businessId]
    );
    sendXlsx(res, makeWorkbook('מלאי', rows), 'מלאי');
  } catch (err) { next(err); }
});

// ── GET /api/export/invoices ──────────────────────────────────
router.get('/invoices', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(inv.invoice_number, '')          AS "מספר חשבונית",
              COALESCE(s.name, 'לא ידוע')              AS "ספק",
              to_char(inv.invoice_date, 'DD/MM/YYYY')   AS "תאריך חשבונית",
              COALESCE(inv.total_amount, 0)::float       AS "סכום כולל",
              CASE WHEN inv.is_paid THEN 'שולם' ELSE 'לא שולם' END AS "סטטוס תשלום",
              -- was: is_duplicate, which nothing in the codebase ever sets, so
              -- this column read 'לא' on every row of every export ever produced.
              CASE WHEN inv.approved_at IS NOT NULL THEN 'מאושר' ELSE 'ממתין לאישור' END AS "סטטוס אישור",
              -- a literal " inside a quoted SQL identifier is escaped by doubling it
              COALESCE(inv.vat_amount, 0)::float        AS "מע""מ",
              ROUND(COALESCE(inv.ai_confidence, 0) * 100) || '%'   AS "ביטחון AI",
              to_char(inv.created_at, 'DD/MM/YYYY')     AS "תאריך העלאה"
         FROM invoices inv
         LEFT JOIN suppliers s ON s.id = inv.supplier_id
        WHERE inv.business_id = $1
        ORDER BY inv.invoice_date DESC NULLS LAST
        LIMIT 5000`,
      [req.user.businessId]
    );
    sendXlsx(res, makeWorkbook('חשבוניות', rows), 'חשבוניות');
  } catch (err) { next(err); }
});

// ── GET /api/export/shifts?month=YYYY-MM ──────────────────────
router.get('/shifts', requireAuth, requirePermission('employees'), async (req, res, next) => {
  try {
    const { month } = req.query;
    const params = [req.user.businessId];
    let whereMonth = '';
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'פורמט חודש לא תקין — נדרש YYYY-MM' });
      params.push(month);
      // AT TIME ZONE 'Asia/Jerusalem' — sibling /export/all already does this
      // for the same column; without it a shift starting just after Israel
      // midnight (still the prior UTC day/hour) lands in the wrong month.
      whereMonth = `AND to_char(sh.actual_start AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM') = $2`;
    }
    const { rows } = await db.query(
      `SELECT u.full_name                                             AS "עובד",
              to_char(sh.actual_start, 'DD/MM/YYYY HH24:MI')         AS "כניסה בפועל",
              to_char(sh.actual_end,   'DD/MM/YYYY HH24:MI')         AS "יציאה בפועל",
              to_char(sh.planned_start,'DD/MM/YYYY HH24:MI')         AS "כניסה מתוכננת",
              to_char(sh.planned_end,  'DD/MM/YYYY HH24:MI')         AS "יציאה מתוכננת",
              CASE WHEN sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
                THEN ROUND(
                  EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0
                , 2)
                ELSE NULL
              END                                                     AS "שעות בפועל",
              CASE sh.status
                WHEN 'planned'   THEN 'מתוכנן'
                WHEN 'active'    THEN 'פתוח'
                WHEN 'completed' THEN 'הושלם'
                WHEN 'absent'    THEN 'היעדרות'
                ELSE sh.status
              END                                                     AS "סטטוס",
              CASE WHEN sh.location_verified THEN 'כן' ELSE 'לא' END AS "מיקום אומת",
              COALESCE(sh.edit_note, '')                              AS "הערה"
         FROM shifts sh
         JOIN users u ON u.id = sh.employee_id
        WHERE sh.business_id = $1 ${whereMonth}
        ORDER BY sh.actual_start DESC NULLS LAST
        LIMIT 5000`,
      params
    );
    const name = month ? `משמרות-${month}` : 'משמרות';
    sendXlsx(res, makeWorkbook('משמרות', rows), name);
  } catch (err) { next(err); }
});

// ── GET /api/export/finance?year=YYYY&month=MM ────────────────
router.get('/finance', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { year, month } = req.query;
    if (year  && !/^\d{4}$/.test(year))  return res.status(400).json({ error: 'Invalid year' });
    if (month && !/^(1[0-2]|[1-9])$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
    const params = [req.user.businessId];
    // הוצאות קבועות (monthly/weekly/yearly/bimonthly) חוזרות מדי חודש — לא מסננים
    // אותן לפי created_at (אחרת הוצאה שנוצרה בינואר "נעלמת" מדוחות מרץ ואילך).
    // רק הוצאות חד-פעמיות (one_time) משויכות לחודש ספציפי דרך created_at.
    const oneTimeDateConds = [];
    let incomeFilter = '';
    if (year) {
      params.push(parseInt(year, 10));
      // fe.created_at is TIMESTAMPTZ — AT TIME ZONE 'Asia/Jerusalem' needed
      // (mi.income_date is a plain DATE, no time-of-day, so no conversion
      // needed there — a one-time expense created just after Israel midnight
      // would otherwise land in the wrong month/year).
      oneTimeDateConds.push(`EXTRACT(YEAR FROM fe.created_at AT TIME ZONE 'Asia/Jerusalem') = $${params.length}`);
      incomeFilter += ` AND EXTRACT(YEAR FROM mi.income_date) = $${params.length}`;
    }
    if (month) {
      params.push(parseInt(month, 10));
      oneTimeDateConds.push(`EXTRACT(MONTH FROM fe.created_at AT TIME ZONE 'Asia/Jerusalem') = $${params.length}`);
      incomeFilter += ` AND EXTRACT(MONTH FROM mi.income_date) = $${params.length}`;
    }
    const expenseFilter = oneTimeDateConds.length
      ? ` AND (fe.frequency <> 'one_time' OR (${oneTimeDateConds.join(' AND ')}))`
      : '';

    const { rows } = await db.query(
      `SELECT to_char(fe.created_at, 'DD/MM/YYYY') AS "תאריך",
              fe.name                               AS "תיאור",
              fe.amount::float                      AS "סכום",
              'הוצאה'                               AS "סוג",
              COALESCE(fe.category, '')             AS "קטגוריה",
              CASE fe.frequency
                WHEN 'monthly'  THEN 'חודשי'
                WHEN 'weekly'   THEN 'שבועי'
                WHEN 'yearly'   THEN 'שנתי'
                WHEN 'one_time' THEN 'חד פעמי'
                ELSE fe.frequency
              END                                   AS "תדירות"
         FROM fixed_expenses fe
        WHERE fe.business_id = $1 AND fe.is_active = TRUE ${expenseFilter}${EXPENSE_ACTIVE_TODAY_AS('fe')}
       UNION ALL
       SELECT to_char(mi.income_date, 'DD/MM/YYYY') AS "תאריך",
              COALESCE(mi.description, '')           AS "תיאור",
              mi.amount::float                       AS "סכום",
              'הכנסה'                                AS "סוג",
              COALESCE(mi.category, '')              AS "קטגוריה",
              ''                                     AS "תדירות"
         FROM manual_income mi
        WHERE mi.business_id = $1 ${incomeFilter}
        ORDER BY "תאריך" DESC
        LIMIT 5000`,
      params
    );
    const name = year && month ? `פיננסים-${year}-${month}` : 'פיננסים';
    sendXlsx(res, makeWorkbook('פיננסים', rows), name);
  } catch (err) { next(err); }
});

// ── GET /api/export/pl?year=YYYY&month=MM ─────────────────────
router.get('/pl', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const summary = await getMonthlySummary(req.user.businessId, year, month);

    const summaryRows = [
      { 'סעיף': 'הכנסות',              'סכום (₪)': summary.revenue },
      { 'סעיף': 'עלות סחורה (COGS)',   'סכום (₪)': -summary.cogs },
      { 'סעיף': 'רווח גולמי',           'סכום (₪)': summary.grossProfit },
      { 'סעיף': 'הוצאות קבועות',        'סכום (₪)': -summary.fixedExpenses },
      { 'סעיף': 'עלויות שכר',           'סכום (₪)': -summary.salaryCost },
      { 'סעיף': 'רווח נקי',             'סכום (₪)': summary.netProfit },
      { 'סעיף': 'מרווח נקי (%)',         'סכום (₪)': summary.margin },
    ];

    const { rows: invoiceRows } = await db.query(
      `SELECT COALESCE(s.name, 'לא ידוע')          AS "ספק",
              COALESCE(inv.invoice_number, '')        AS "מספר חשבונית",
              to_char(inv.invoice_date, 'DD/MM/YYYY') AS "תאריך",
              inv.total_amount::float                  AS "סכום",
              CASE WHEN inv.is_paid THEN 'שולם' ELSE 'לא שולם' END AS "תשלום"
         FROM invoices inv
         LEFT JOIN suppliers s ON s.id = inv.supplier_id
        WHERE inv.business_id = $1
          AND EXTRACT(YEAR  FROM inv.invoice_date) = $2
          AND EXTRACT(MONTH FROM inv.invoice_date) = $3
        ORDER BY inv.invoice_date ASC`,
      [req.user.businessId, year, month]
    );

    const { rows: fixedRows } = await db.query(
      `SELECT name AS "שם הוצאה",
              amount::float AS "סכום",
              CASE frequency
                WHEN 'monthly' THEN 'חודשי'
                WHEN 'weekly'  THEN 'שבועי'
                WHEN 'yearly'  THEN 'שנתי'
                ELSE frequency
              END AS "תדירות",
              COALESCE(category, '') AS "קטגוריה"
         FROM fixed_expenses
        WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}
        ORDER BY name`,
      [req.user.businessId]
    );

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'סיכום');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoiceRows.length ? invoiceRows : [{ 'הערה': 'אין חשבוניות לחודש זה' }]), 'חשבוניות ספקים');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fixedRows.length ? fixedRows : [{ 'הערה': 'אין הוצאות קבועות' }]), 'הוצאות קבועות');

    const mm = String(month).padStart(2, '0');
    sendXlsx(res, wb, `דוח-רווח-והפסד-${year}-${mm}`);
  } catch (err) { next(err); }
});

// ── GET /api/export/all?year=YYYY&month=MM ────────────────────
router.get('/all', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    if (!/^\d{4}$/.test(String(year)) || month < 1 || month > 12) return res.status(400).json({ error: 'Invalid year/month' });

    const summary = await getMonthlySummary(req.user.businessId, year, month);
    const mm = String(month).padStart(2, '0');

    // P&L summary sheet
    const plRows = [
      { 'סעיף': 'הכנסות',              'סכום (₪)': summary.revenue },
      { 'סעיף': 'עלות סחורה (COGS)',   'סכום (₪)': -summary.cogs },
      { 'סעיף': 'רווח גולמי',           'סכום (₪)': summary.grossProfit },
      { 'סעיף': 'הוצאות קבועות',        'סכום (₪)': -summary.fixedExpenses },
      { 'סעיף': 'עלויות שכר',           'סכום (₪)': -summary.salaryCost },
      { 'סעיף': 'רווח נקי',             'סכום (₪)': summary.netProfit },
    ];

    const [empRows, invRows, invoiceRows, shiftRows, expRows, incRows] = await Promise.all([
      db.query(`SELECT u.full_name AS "שם מלא",
          CASE u.role WHEN 'manager' THEN 'מנהל' WHEN 'employee' THEN 'עובד' ELSE u.role END AS "תפקיד",
          CASE u.salary_type WHEN 'hourly' THEN 'שעתי' WHEN 'global' THEN 'גלובלי' ELSE '' END AS "סוג שכר",
          u.salary_amount::float AS "סכום שכר",
          CASE WHEN u.is_active THEN 'פעיל' ELSE 'לא פעיל' END AS "סטטוס"
        FROM users u WHERE u.business_id = $1 AND u.role != 'owner' ORDER BY u.full_name`,
        [req.user.businessId]).then(r => r.rows),

      db.query(`SELECT i.name AS "שם פריט", COALESCE(c.name,'') AS "קטגוריה",
          i.current_qty::float AS "כמות", i.unit AS "יחידה",
          COALESCE(i.cost_per_unit,0)::float AS "עלות ליחידה",
          ROUND((i.current_qty * COALESCE(i.cost_per_unit,0))::numeric,2) AS "שווי כולל"
        FROM inventory_items i
        LEFT JOIN inventory_categories c ON c.id = i.category_id
        WHERE i.business_id = $1 ORDER BY i.name LIMIT 5000`,
        [req.user.businessId]).then(r => r.rows),

      db.query(`SELECT COALESCE(s.name,'לא ידוע') AS "ספק",
          COALESCE(inv.invoice_number,'') AS "מספר חשבונית",
          to_char(inv.invoice_date,'DD/MM/YYYY') AS "תאריך",
          COALESCE(inv.total_amount,0)::float AS "סכום",
          CASE WHEN inv.is_paid THEN 'שולם' ELSE 'לא שולם' END AS "תשלום"
        FROM invoices inv
        LEFT JOIN suppliers s ON s.id = inv.supplier_id
        WHERE inv.business_id = $1
          AND EXTRACT(YEAR FROM inv.invoice_date) = $2
          AND EXTRACT(MONTH FROM inv.invoice_date) = $3
        ORDER BY inv.invoice_date DESC`,
        [req.user.businessId, year, month]).then(r => r.rows),

      db.query(`SELECT u.full_name AS "עובד",
          to_char(sh.actual_start,'DD/MM/YYYY HH24:MI') AS "כניסה",
          to_char(sh.actual_end,'DD/MM/YYYY HH24:MI') AS "יציאה",
          ROUND(EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start))/3600.0,2) AS "שעות",
          CASE sh.status WHEN 'completed' THEN 'הושלם' WHEN 'absent' THEN 'היעדרות' ELSE sh.status END AS "סטטוס"
        FROM shifts sh JOIN users u ON u.id = sh.employee_id
        WHERE sh.business_id = $1 AND sh.actual_start IS NOT NULL AND sh.actual_end IS NOT NULL
          AND EXTRACT(YEAR FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $2
          AND EXTRACT(MONTH FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') = $3
        ORDER BY sh.actual_start DESC LIMIT 5000`,
        [req.user.businessId, year, month]).then(r => r.rows),

      db.query(`SELECT fe.name AS "הוצאה", fe.amount::float AS "סכום",
          CASE fe.frequency WHEN 'monthly' THEN 'חודשי' WHEN 'weekly' THEN 'שבועי'
            WHEN 'yearly' THEN 'שנתי' ELSE fe.frequency END AS "תדירות",
          COALESCE(fe.category,'') AS "קטגוריה"
        FROM fixed_expenses fe
        WHERE fe.business_id = $1 AND fe.is_active = TRUE${EXPENSE_ACTIVE_TODAY_AS('fe')} ORDER BY fe.name`,
        [req.user.businessId]).then(r => r.rows),

      db.query(`SELECT to_char(income_date,'DD/MM/YYYY') AS "תאריך",
          COALESCE(description,'') AS "תיאור", amount::float AS "סכום"
        FROM manual_income
        WHERE business_id = $1
          AND EXTRACT(YEAR FROM income_date) = $2
          AND EXTRACT(MONTH FROM income_date) = $3
        ORDER BY income_date DESC`,
        [req.user.businessId, year, month]).then(r => r.rows),
    ]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plRows), 'דוח רווח והפסד');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(empRows.length ? empRows : [{ 'הערה': 'אין עובדים' }]), 'עובדים');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shiftRows.length ? shiftRows : [{ 'הערה': 'אין משמרות לחודש' }]), 'משמרות');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invRows.length ? invRows : [{ 'הערה': 'אין פריטי מלאי' }]), 'מלאי');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invoiceRows.length ? invoiceRows : [{ 'הערה': 'אין חשבוניות לחודש' }]), 'חשבוניות');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expRows.length ? expRows : [{ 'הערה': 'אין הוצאות קבועות' }]), 'הוצאות קבועות');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(incRows.length ? incRows : [{ 'הערה': 'אין הכנסות נוספות' }]), 'הכנסות נוספות');

    sendXlsx(res, wb, `דוח-מלא-לרוח-${year}-${mm}`);
  } catch (err) { next(err); }
});

// ── GET /api/export/vat?year=YYYY&month=MM&period=1|2 ─────────
router.get('/vat', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const { getVatReport } = require('../services/finance/vat.service');
    // todayIL(), not new Date() — same UTC-vs-Israel bug already fixed in
    // finance.routes.js's own GET /vat; also add the bounds validation that
    // route has and this one was missing (a malformed month otherwise hits
    // Postgres as an invalid date string and surfaces as a raw 500).
    const [_ily, _ilm] = todayIL().split('-').map(Number);
    const year   = parseInt(req.query.year)   || _ily;
    const month  = parseInt(req.query.month)  || _ilm;
    const period = parseInt(req.query.period) || 1;
    if (year < 2000 || year > 2100 || month < 1 || month > 12) {
      return res.status(400).json({ error: 'שנה/חודש לא תקינים' });
    }
    const vat = await getVatReport(req.user.businessId, year, month, period);

    const summaryRows = [
      { 'סעיף': 'מכירות (כולל מע"מ)',        'סכום (₪)': vat.output.gross_sales },
      { 'סעיף': 'מכירות (ללא מע"מ)',          'סכום (₪)': vat.output.net_sales },
      { 'סעיף': 'מע"מ עסקאות (פלט)',          'סכום (₪)': vat.output.output_vat },
      { 'סעיף': 'רכישות מספקים (כולל מע"מ)', 'סכום (₪)': vat.input.gross_purchases },
      { 'סעיף': 'מע"מ תשומות — חשבוניות',    'סכום (₪)': vat.input.input_vat_invoices },
      { 'סעיף': 'מע"מ תשומות — הוצאות קבועות','סכום (₪)': vat.input.input_vat_expenses },
      { 'סעיף': 'סה"כ מע"מ תשומות',          'סכום (₪)': vat.input.total_input_vat },
      { 'סעיף': 'צפי מע"מ לתשלום/זיכוי (נטו)', 'סכום (₪)': vat.net_vat },
    ];

    // This file is the artifact that actually reaches the accountant, so the
    // caveats the screens carry have to travel with it — a spreadsheet gets
    // forwarded, printed and filed long after anyone remembers which screen it
    // came from. The two the accountant most needs to know are what we did NOT
    // deduct, and how much of the input side rests on unreviewed OCR.
    const eb = vat.input.expenses_breakdown;
    const notesRows = [
      { 'הערה': 'מסמך זה הוא אומדן שחושב מהנתונים שבמערכת בלבד — אינו דוח מע"מ להגשה.' },
      { 'הערה': `תקופה: ${vat.period.start_date} עד ${vat.period.end_date} (לא כולל), שיעור מע"מ ${vat.vat_rate}%` },
      { 'הערה': 'מע"מ תשומות על הוצאות קבועות קוזז רק מהוצאות שסומנו כמגיעות עם חשבונית מס.' },
    ];
    if (eb?.unknown_count) {
      notesRows.push({ 'הערה': `₪${eb.unknown} בהוצאות לא סווגו (לא ידוע אם מגיעה חשבונית מס) ולא קוזז מהן מע"מ — פוטנציאל של ₪${eb.potential_extra_vat} נוספים: ${eb.unknown_items.map(i => i.name).join(', ')}` });
    }
    if (eb?.no_vat) {
      notesRows.push({ 'הערה': `₪${eb.no_vat} בהוצאות מסווגות כפטורות ממע"מ (ארנונה/ביטוח/היטלים) ולא קוזז מהן מע"מ.` });
    }
    if (vat.input.unapproved_count) {
      notesRows.push({ 'הערה': `${vat.input.unapproved_count} חשבוניות (₪${vat.input.unapproved_amount}) טרם אושרו ידנית — כלולות בסכומים, מבוססות על קריאת OCR שלא נבדקה.` });
    }
    if (vat.input.invoices_vat_derived) {
      notesRows.push({ 'הערה': `ב-${vat.input.invoices_vat_derived} חשבוניות לא נקרא סכום מע"מ מהמסמך, והוא חושב לפי ${vat.vat_rate}% — לא מדויק לפריטים בשיעור אפס.` });
    }
    const byTypeRows = vat.output.by_type.map(t => ({
      'סוג מכירה': t.sale_type, 'סה"כ (₪)': t.gross, 'מע"מ (₪)': t.vat,
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'סיכום מע"מ');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byTypeRows.length ? byTypeRows : [{ 'הערה': 'אין נתוני מכירות לתקופה זו' }]), 'לפי סוג מכירה');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(notesRows), 'הערות והסתייגויות');

    const mm = String(month).padStart(2, '0');
    // Filename too: "דוח-מעמ" is what the accountant sees in their inbox.
    sendXlsx(res, wb, `צפי-מעמ-${year}-${mm}`);
  } catch (err) { next(err); }
});

module.exports = router;
