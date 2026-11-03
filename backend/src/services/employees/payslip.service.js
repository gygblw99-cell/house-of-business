/**
 * Payslip Service
 * מייצר תלושי שכר PDF ושולח ב-10 לחודש
 * אם ה-10 חל בשבת/חג — נשלח ביום עסקים קודם
 */

const db         = require('../../utils/db');
const logger     = require('../../utils/logger');
const shiftModel = require('../../models/shift.model');
const { calcMonthlySalary, calcDeductions, calcLeaveAccrual } = require('./salary.calculator');
const { savePayslipPdf } = require('./payslipPdf.service');
const { sendEmail } = require('../notifications/email.service');
const { ACTIVE_BUSINESS_SQL } = require('../../utils/activeBusiness');

// ── ימי חגים ישראל ────────────────────────────────────────────
const ISRAELI_HOLIDAYS = new Set([
  // 2025
  '2025-04-13','2025-04-14','2025-04-19','2025-04-20', // פסח (ראשון + שביעי)
  '2025-05-01','2025-05-02',                            // יום העצמאות
  '2025-06-02',                                         // שבועות
  '2025-09-22','2025-09-23',                            // ראש השנה
  '2025-10-01',                                         // יום כיפור
  '2025-10-06','2025-10-07',                            // סוכות (ראשון + שני)
  '2025-10-13','2025-10-14',                            // שמיני עצרת / שמחת תורה
  // 2026
  '2026-03-03',                                         // פורים
  '2026-04-02','2026-04-03','2026-04-08','2026-04-09', // פסח
  '2026-04-22',                                         // יום העצמאות
  '2026-05-22',                                         // שבועות
  '2026-09-11','2026-09-12',                            // ראש השנה
  '2026-09-20',                                         // יום כיפור
  '2026-09-25','2026-09-26',                            // סוכות (ראשון + שני)
  '2026-10-02','2026-10-03',                            // שמיני עצרת / שמחת תורה
]);

// ── מחשב את יום השליחה (10 לחודש / יום עסקים קודם) ─────────
function getPayslipSendDate(year, month) {
  const day10 = new Date(year, month - 1, 10);
  let sendDate = new Date(day10);

  // עובר אחורה עד שמגיע ליום עסקים
  while (_isNonWorkingDay(sendDate)) {
    sendDate.setDate(sendDate.getDate() - 1);
  }
  return sendDate;
}

function _isNonWorkingDay(date) {
  const dow = date.getDay(); // 6 = שבת
  // getFullYear/Month/Date return local-time components (Jerusalem TZ on this server),
  // matching the YYYY-MM-DD strings in ISRAELI_HOLIDAYS — do NOT use toISOString() which is UTC
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return dow === 6 || ISRAELI_HOLIDAYS.has(dateStr);
}

// ── יצירת תלוש שכר לעובד ─────────────────────────────────────
// prefetchedBusiness אופציונלי — מונע N+1 כשמריצים batch לכל העובדים
async function generatePayslip(businessId, employeeId, year, month, prefetchedBusiness = null) {
  const [employee, business, summary] = await Promise.all([
    _getEmployee(employeeId, businessId),
    prefetchedBusiness ? Promise.resolve(prefetchedBusiness) : _getBusiness(businessId),
    shiftModel.getMonthlySummary(employeeId, businessId, year, month),
  ]);

  if (!employee) throw Object.assign(new Error('עובד לא נמצא'), { status: 404 });

  const shifts         = summary?.shifts || [];
  const vacationDays   = summary?.vacation_days || 0;
  const sickDays       = summary?.sick_days || 0;

  // חישוב שכר — 'monthly' הוא שם נרדף מלא ל-'global' בכל שאר הקוד (ראה
  // salary.calculator.js), חייב להתייחס אליו באותו אופן כאן, אחרת עובד עם
  // salary_type='monthly' מקבל תלוש שבו סכום השכר החודשי מוכפל בשעות עבודה
  // כאילו היה תעריף שעתי.
  let salaryData;
  if (['global', 'monthly'].includes(employee.salary_type)) {
    salaryData = {
      regularHours: null, overtime125: null, overtime150: null,
      grossSalary: parseFloat(employee.salary_amount),
    };
  } else if (employee.salary_type === 'tips') {
    // Gross = actual tip distributions received this month
    const { rows: tipRows } = await db.query(`
      SELECT COALESCE(SUM(td.amount), 0)::numeric AS tips_total
      FROM tip_distributions td
      JOIN tip_entries te ON te.id = td.tip_entry_id
      WHERE td.employee_id = $1
        AND te.business_id = $2
        AND te.entry_date >= DATE_TRUNC('month', MAKE_DATE($3::int, $4::int, 1))
        AND te.entry_date <  DATE_TRUNC('month', MAKE_DATE($3::int, $4::int, 1)) + INTERVAL '1 month'
    `, [employeeId, businessId, year, month]);
    salaryData = {
      regularHours: null, overtime125: null, overtime150: null,
      grossSalary: parseFloat(tipRows[0]?.tips_total || 0),
    };
  } else {
    salaryData = calcMonthlySalary(shifts, parseFloat(employee.salary_amount));
  }

  const deductions = calcDeductions(
    salaryData.grossSalary,
    parseFloat(employee.tax_credit_points || 2.25),
    ['global', 'monthly'].includes(employee.salary_type)
  );

  // חישוב ותק לצבירת חופשה
  const monthsWorked = _calcMonthsWorked(employee.created_at);
  const leave        = calcLeaveAccrual(monthsWorked);

  const payslipData = {
    // פרטי עובד
    employeeName:   employee.full_name,
    employeeEmail:  employee.email,
    employeePhone:  employee.phone,
    // פרטי עסק
    businessName:   business.name,
    businessAddress: business.address || '',
    businessVat:    business.vat_number || '',
    // תקופה
    periodMonth: month, periodYear: year,
    // שכר
    salaryType:    employee.salary_type,
    grossSalary:   deductions.grossSalary,
    regularHours:  salaryData.regularHours,
    overtime125:   salaryData.overtime125,
    overtime150:   salaryData.overtime150,
    hourlyRate:    employee.salary_type === 'hourly' ? parseFloat(employee.salary_amount) : null,
    // ניכויים
    incomeTax:         deductions.incomeTax,
    nationalInsurance: deductions.nationalInsurance,
    healthInsurance:   deductions.healthInsurance,
    pension:           deductions.pension,
    netSalary:         deductions.netSalary,
    taxCreditPoints:   parseFloat(employee.tax_credit_points || 2.25),
    // חופשה ומחלה
    vacationDaysUsed:    vacationDays,
    sickDaysUsed:        sickDays,
    vacationDaysAccrued: leave.vacationDaysAccrued,
    sickDaysAccrued:     leave.sickDaysAccrued,
  };

  // שמירה ב-DB
  const { rows } = await db.query(
    `INSERT INTO payslips
       (business_id, employee_id, period_month, period_year,
        gross_salary, regular_hours, overtime_125, overtime_150,
        vacation_days, sick_days,
        tax_deduction, national_insurance, health_insurance, pension, net_salary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (business_id, employee_id, period_month, period_year)
     DO UPDATE SET
       gross_salary       = EXCLUDED.gross_salary,
       regular_hours      = EXCLUDED.regular_hours,
       overtime_125       = EXCLUDED.overtime_125,
       overtime_150       = EXCLUDED.overtime_150,
       vacation_days      = EXCLUDED.vacation_days,
       sick_days          = EXCLUDED.sick_days,
       tax_deduction      = EXCLUDED.tax_deduction,
       national_insurance = EXCLUDED.national_insurance,
       health_insurance   = EXCLUDED.health_insurance,
       pension            = EXCLUDED.pension,
       net_salary         = EXCLUDED.net_salary
     RETURNING id`,
    [
      businessId, employeeId, month, year,
      deductions.grossSalary,
      salaryData.regularHours, salaryData.overtime125, salaryData.overtime150,
      vacationDays, sickDays,
      deductions.incomeTax, deductions.nationalInsurance,
      deductions.healthInsurance, deductions.pension, deductions.netSalary,
    ]
  );

  if (!rows[0]) throw new Error('payslip INSERT returned no row');
  const payslipId = rows[0].id;

  // יצירת PDF עם ID אמיתי — פעם אחת בלבד (לאחר הכנסת ה-DB)
  let pdfUrl = null;
  let pdfBuffer = null;
  try {
    const { filePath, buffer } = await savePayslipPdf(payslipData, payslipId);
    pdfUrl = filePath;
    pdfBuffer = buffer;
    await db.query('UPDATE payslips SET pdf_url = $1 WHERE id = $2', [pdfUrl, payslipId]);
  } catch (pdfErr) {
    logger.error('[Payslip] PDF generation failed', { payslipId, err: pdfErr.message });
  }

  return { payslipId, payslipData, pdfUrl, pdfBuffer };
}

// ── יצירה מחדש ושליחה לעובד בודד (endpoint "שליחה מחדש") ──────
async function resendPayslip(businessId, employeeId, year, month) {
  const employee = await _getEmployee(employeeId, businessId);
  if (!employee) throw Object.assign(new Error('עובד לא נמצא'), { status: 404 });

  const { payslipData, pdfBuffer } = await generatePayslip(businessId, employeeId, year, month);
  await _sendPayslipEmail(employee.email, employee.full_name, payslipData, pdfBuffer, month, year);
  await db.query(
    `UPDATE payslips SET sent_at = NOW()
     WHERE business_id = $1 AND employee_id = $2 AND period_month = $3 AND period_year = $4`,
    [businessId, employeeId, month, year]
  );

  return payslipData;
}

// ── שליחת תלושים לכל העובדים של העסק ─────────────────────────
async function sendMonthlyPayslips(businessId, year, month, extraEmails = [], employeeIds = null) {
  let query = `SELECT id, full_name, email, salary_type FROM users
     WHERE business_id = $1 AND is_active = TRUE AND salary_type IS NOT NULL`;
  const params = [businessId];

  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    query += ` AND id = ANY($2)`;
    params.push(employeeIds);
  } else if (Array.isArray(employeeIds) && employeeIds.length === 0) {
    // רשימה ריקה — לא שולחים לאף עובד
    const results = [];
    for (const email of (extraEmails || [])) {
      if (!email || !email.includes('@')) continue;
      try {
        await _sendSummaryEmail(email, [], month, year);
        results.push({ email, status: 'sent' });
      } catch (err) {
        results.push({ email, status: 'failed', error: err.message });
      }
    }
    return results;
  }

  const { rows: employees } = await db.query(query, params);

  // Pre-fetch business once — prevents N+1 (generatePayslip would call _getBusiness per employee)
  const business = await _getBusiness(businessId);

  const sentPayslips = [];

  // Process up to 5 employees in parallel to avoid hammering the email/PDF service
  const BATCH = 5;
  const results = [];

  for (let i = 0; i < employees.length; i += BATCH) {
    const batch = employees.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(async (emp) => {
        const { payslipData, pdfBuffer } = await generatePayslip(businessId, emp.id, year, month, business);
        await _sendPayslipEmail(emp.email, emp.full_name, payslipData, pdfBuffer, month, year);
        await db.query(
          `UPDATE payslips SET sent_at = NOW()
           WHERE business_id = $1 AND employee_id = $2
             AND period_month = $3 AND period_year = $4`,
          [businessId, emp.id, month, year]
        );
        return { emp, payslipData };
      })
    );

    for (let j = 0; j < batch.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled') {
        results.push({ employeeId: batch[j].id, status: 'sent' });
        sentPayslips.push({ name: batch[j].full_name, ...r.value.payslipData });
      } else {
        logger.error('[Payslip] נכשל עבור עובד', { employeeId: batch[j].id, err: r.reason?.message });
        results.push({ employeeId: batch[j].id, status: 'failed', error: r.reason?.message });
      }
    }
  }

  // שליחת סיכום לכתובות נוספות — אלה כמות קטנה, אפשר במקביל
  const extraResults = await Promise.allSettled(
    (extraEmails || [])
      .filter(email => email && email.includes('@'))
      .map(email => _sendSummaryEmail(email, sentPayslips, month, year).then(() => ({ email, status: 'sent' })))
  );
  for (const r of extraResults) {
    if (r.status === 'fulfilled') results.push(r.value);
    else {
      logger.error('[Payslip] נכשל לכתובת נוספת', { err: r.reason?.message });
      results.push({ email: '?', status: 'failed', error: r.reason?.message });
    }
  }

  return results;
}

// ── Scheduler — מריץ ב-10 לכל חודש (או יום עסקים קודם) ──────
function startPayslipScheduler() {
  _scheduleNext();
  logger.info('[Payslip Scheduler] פעיל — תלושים נשלחים ב-10 לחודש');
}

// Node.js setTimeout max is 2^31-1 ms (~24.8 days). Scheduling beyond that overflows
// to 1ms and causes an infinite tight loop. Cap at 24h and reschedule.
const MAX_TIMEOUT_MS = 2_147_483_647;

function _scheduleNext() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // חודש נוכחי

  const sendDate = getPayslipSendDate(year, month);
  sendDate.setHours(8, 0, 0, 0); // שליחה ב-08:00

  let msUntil = sendDate.getTime() - now.getTime();
  if (msUntil < 0) {
    // כבר עבר — מתזמן לחודש הבא
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    const nextSend  = getPayslipSendDate(nextYear, nextMonth);
    nextSend.setHours(8, 0, 0, 0);
    msUntil = nextSend.getTime() - now.getTime();
  }

  logger.info(`[Payslip Scheduler] שליחה הבאה בעוד ${Math.round(msUntil / 3_600_000)} שעות`);

  // Prevent 32-bit overflow: if > 24.8 days, check back in 24h and recalculate
  if (msUntil > MAX_TIMEOUT_MS) {
    setTimeout(_scheduleNext, 24 * 60 * 60_000).unref();
    return;
  }

  setTimeout(async () => {
    const d  = new Date();
    const yr = d.getFullYear();
    const mo = d.getMonth() + 1;
    const prevMonth = mo === 1 ? 12 : mo - 1;
    const prevYear  = mo === 1 ? yr - 1 : yr;

    // This one had no filter at all, so it ran for every business including
    // ones an admin had switched off or suspended.
    const { rows: businesses } = await db.query(
      `SELECT id FROM businesses WHERE ${ACTIVE_BUSINESS_SQL} LIMIT 500`
    );
    for (const { id } of businesses) {
      await sendMonthlyPayslips(id, prevYear, prevMonth).catch(err => logger.error('[Payslip Scheduler] שגיאה', { id, err: err.message }));
    }
    _scheduleNext(); // מתזמן מחדש
  }, msUntil).unref();
}

// ── עזר ──────────────────────────────────────────────────────
async function _getEmployee(id, businessId) {
  const { rows } = await db.query(
    `SELECT id, full_name, email, phone, salary_type, salary_amount,
            tax_credit_points, created_at
     FROM users WHERE id = $1 AND business_id = $2`,
    [id, businessId]
  );
  return rows[0];
}

async function _getBusiness(id) {
  const { rows } = await db.query(
    'SELECT name, address, vat_number, email FROM businesses WHERE id = $1', [id]
  );
  return rows[0];
}

function _calcMonthsWorked(startDate) {
  const now   = new Date();
  const start = new Date(startDate);
  return (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
}

function _buildPayslipText(d) {
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                      'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  return `
תלוש שכר — ${monthNames[d.periodMonth - 1]} ${d.periodYear}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
עובד:   ${d.employeeName}
מעסיק: ${d.businessName}  |  ח.פ: ${d.businessVat}

${d.salaryType === 'hourly' ? `שעות רגילות:      ${d.regularHours}
שעות נוספות 125%: ${d.overtime125}
שעות נוספות 150%: ${d.overtime150}
תעריף שעתי:       ₪${d.hourlyRate}` : `שכר גלובלי קבוע`}

ברוטו:             ₪${d.grossSalary.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ניכויים:
  מס הכנסה:        ₪${d.incomeTax.toFixed(2)}
  ביטוח לאומי:     ₪${d.nationalInsurance.toFixed(2)}
  ביטוח בריאות:    ₪${d.healthInsurance.toFixed(2)}
  פנסיה (6%):      ₪${d.pension.toFixed(2)}
  נקודות זיכוי:    ${d.taxCreditPoints}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
נטו לתשלום:        ₪${d.netSalary.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
צבירת חופשה:  ${d.vacationDaysAccrued} ימים | שימוש: ${d.vacationDaysUsed}
צבירת מחלה:   ${d.sickDaysAccrued} ימים   | שימוש: ${d.sickDaysUsed}
`;
}

async function _sendPayslipEmail(toEmail, employeeName, data, pdfBuffer, month, year) {
  await sendEmail({
    to:      toEmail,
    subject: `תלוש שכר ${month}/${year} — ${data.businessName}`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 500px;">
        <h2 style="color: #1e40af;">שלום ${employeeName},</h2>
        <p>מצורף תלוש השכר שלך לחודש ${month}/${year}.</p>
        <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
          <tr style="background:#eff6ff">
            <td style="padding:8px; border:1px solid #dbeafe;">ברוטו</td>
            <td style="padding:8px; border:1px solid #dbeafe; font-weight:bold;">₪${data.grossSalary?.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding:8px; border:1px solid #e5e7eb;">סה״כ ניכויים</td>
            <td style="padding:8px; border:1px solid #e5e7eb;">₪${(data.incomeTax + data.nationalInsurance + data.healthInsurance + data.pension).toFixed(2)}</td>
          </tr>
          <tr style="background:#f0fdf4">
            <td style="padding:8px; border:1px solid #bbf7d0; font-weight:bold;">נטו לתשלום</td>
            <td style="padding:8px; border:1px solid #bbf7d0; font-weight:bold; color:#15803d;">₪${data.netSalary?.toFixed(2)}</td>
          </tr>
        </table>
        <p style="color:#6b7280; font-size:12px;">תלוש זה הופק אוטומטית על ידי מערכת House of Business</p>
      </div>
    `,
    attachments: pdfBuffer ? [{
      filename: `payslip_${month}_${year}.pdf`,
      content:  pdfBuffer,
      contentType: 'application/pdf',
    }] : undefined,
  });
}

// ── שליחת סיכום לכתובות נוספות ────────────────────────────────
async function _sendSummaryEmail(toEmail, payslips, month, year) {
  const totalGross = payslips.reduce((s, p) => s + (p.grossSalary || 0), 0);
  const totalNet   = payslips.reduce((s, p) => s + (p.netSalary   || 0), 0);

  const rows = payslips.map(p => `
    <tr>
      <td style="padding:8px; border:1px solid #e5e7eb;">${p.employeeName || p.name}</td>
      <td style="padding:8px; border:1px solid #e5e7eb;">₪${(p.grossSalary || 0).toFixed(2)}</td>
      <td style="padding:8px; border:1px solid #e5e7eb; color:#15803d; font-weight:bold;">₪${(p.netSalary || 0).toFixed(2)}</td>
    </tr>`).join('');

  await sendEmail({
    to:      toEmail,
    subject: `סיכום תלושי שכר ${month}/${year}`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #1e40af;">סיכום שכר — ${month}/${year}</h2>
        <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
          <thead>
            <tr style="background:#eff6ff">
              <th style="padding:8px; border:1px solid #dbeafe; text-align:right;">עובד</th>
              <th style="padding:8px; border:1px solid #dbeafe; text-align:right;">ברוטו</th>
              <th style="padding:8px; border:1px solid #dbeafe; text-align:right;">נטו</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr style="background:#f0fdf4; font-weight:bold;">
              <td style="padding:8px; border:1px solid #bbf7d0;">סה״כ (${payslips.length} עובדים)</td>
              <td style="padding:8px; border:1px solid #bbf7d0;">₪${totalGross.toFixed(2)}</td>
              <td style="padding:8px; border:1px solid #bbf7d0; color:#15803d;">₪${totalNet.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
        <p style="color:#6b7280; font-size:12px;">הופק אוטומטית על ידי מערכת House of Business</p>
      </div>`,
  });
}

module.exports = {
  generatePayslip,
  resendPayslip,
  sendMonthlyPayslips,
  startPayslipScheduler,
  getPayslipSendDate,
};
