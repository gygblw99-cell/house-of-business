/**
 * Payroll Routes
 * /api/payroll
 */

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const db       = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const { generatePayslip, sendMonthlyPayslips } = require('../services/employees/payslip.service');
const { buildPayslipPdf }  = require('../services/employees/payslipPdf.service');
const { calcMonthlySalary, calcDeductions } = require('../services/employees/salary.calculator');
const shiftModel = require('../models/shift.model');

const canManage = [requireAuth, requirePermission('finance')];
const canView   = [requireAuth];

// ── GET /api/payroll — רשימת תלושים ──────────────────────────
router.get('/', ...canManage, async (req, res, next) => {
  try {
    const { year, month, employeeId } = req.query;

    const conditions = ['p.business_id = $1'];
    const params     = [req.user.businessId];
    let   idx        = 2;

    const parsedYear  = parseInt(year);
    const parsedMonth = parseInt(month);
    if (year  && !isNaN(parsedYear))  { conditions.push(`p.period_year = $${idx++}`);  params.push(parsedYear); }
    if (month && !isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) { conditions.push(`p.period_month = $${idx++}`); params.push(parsedMonth); }
    if (employeeId) { conditions.push(`p.employee_id = $${idx++}`);  params.push(employeeId); }

    const { rows } = await db.query(
      `SELECT p.*, u.full_name AS employee_name, u.email AS employee_email
       FROM payslips p
       JOIN users u ON u.id = p.employee_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.period_year DESC, p.period_month DESC, u.full_name`,
      params
    );
    res.json({ payslips: rows });
  } catch (err) { next(err); }
});

// ── GET /api/payroll/summary — סיכום חודשי ───────────────────
router.get('/summary', ...canManage, async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year)  || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;

    const { rows } = await db.query(
      `SELECT
         COUNT(*)                    AS employee_count,
         COALESCE(SUM(gross_salary), 0) AS total_gross,
         COALESCE(SUM(net_salary),   0) AS total_net,
         COALESCE(SUM(tax_deduction + national_insurance + health_insurance + pension), 0) AS total_deductions,
         COALESCE(SUM(regular_hours), 0) AS total_hours
       FROM payslips
       WHERE business_id = $1
         AND period_year  = $2
         AND period_month = $3`,
      [req.user.businessId, y, m]
    );
    res.json({ year: y, month: m, summary: rows[0] });
  } catch (err) { next(err); }
});

// ── POST /api/payroll/generate — יצירת תלושים לחודש ──────────
router.post('/generate', ...canManage, validate({ body: schemas.generatePayrollSchema }), async (req, res, next) => {
  try {
    const { year, month, employeeIds } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'year ו-month חובה' });
    const mVal = parseInt(month);
    if (isNaN(mVal) || mVal < 1 || mVal > 12) return res.status(400).json({ error: 'month חייב להיות בין 1 ל-12' });

    // אם לא צוינו עובדים — מייצר לכולם
    let empQuery;
    const params = [req.user.businessId];
    if (employeeIds?.length) {
      empQuery = `SELECT id FROM users WHERE business_id = $1 AND id = ANY($2) AND is_active = TRUE`;
      params.push(employeeIds);
    } else {
      empQuery = `SELECT id FROM users WHERE business_id = $1 AND is_active = TRUE AND salary_type IS NOT NULL`;
    }

    const { rows: employees } = await db.query(empQuery, params);
    if (!employees.length) return res.status(404).json({ error: 'לא נמצאו עובדים' });

    // מייצר במקביל לכל העובדים — כל תלוש מבודד לפי (business_id, employee_id,
    // period_year, period_month), אז אין סיכון להתנגשות בין ריצות מקבילות.
    const settled = await Promise.allSettled(
      employees.map(emp => generatePayslip(req.user.businessId, emp.id, parseInt(year), parseInt(month)))
    );
    const results = settled.map((r, i) => {
      const employeeId = employees[i].id;
      if (r.status === 'fulfilled') {
        return { employeeId, payslipId: r.value.payslipId, netSalary: r.value.payslipData.netSalary, status: 'ok' };
      }
      return { employeeId, status: 'error', error: r.reason?.message || 'שגיאה לא ידועה' };
    });

    res.json({
      year, month,
      generated: results.filter(r => r.status === 'ok').length,
      errors:    results.filter(r => r.status === 'error').length,
      results,
    });
  } catch (err) { next(err); }
});

// ── GET /api/payroll/:id/pdf — הורדת PDF ─────────────────────
router.get('/:id/pdf', ...canManage, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, u.full_name, u.email, u.salary_type, u.salary_amount,
              u.tax_credit_points, u.created_at AS emp_created,
              b.name AS business_name, b.address AS business_address, b.vat_number
       FROM payslips p
       JOIN users u ON u.id = p.employee_id
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id = $1 AND p.business_id = $2`,
      [req.params.id, req.user.businessId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'תלוש לא נמצא' });
    const row = rows[0];

    // בניית payslipData מהשורה
    const payslipData = {
      employeeName:    row.full_name,
      employeeEmail:   row.email,
      businessName:    row.business_name,
      businessAddress: row.business_address || '',
      businessVat:     row.vat_number || '',
      periodMonth:     row.period_month,
      periodYear:      row.period_year,
      salaryType:      row.salary_type,
      grossSalary:     parseFloat(row.gross_salary),
      regularHours:    parseFloat(row.regular_hours || 0),
      overtime125:     parseFloat(row.overtime_125 || 0),
      overtime150:     parseFloat(row.overtime_150 || 0),
      hourlyRate:      row.salary_type === 'hourly' ? parseFloat(row.salary_amount) : null,
      incomeTax:       parseFloat(row.tax_deduction || 0),
      nationalInsurance: parseFloat(row.national_insurance || 0),
      healthInsurance: parseFloat(row.health_insurance || 0),
      pension:         parseFloat(row.pension || 0),
      netSalary:       parseFloat(row.net_salary),
      taxCreditPoints: parseFloat(row.tax_credit_points || 2.25),
      vacationDaysUsed:    parseFloat(row.vacation_days || 0),
      sickDaysUsed:        parseFloat(row.sick_days || 0),
      vacationDaysAccrued: 0,
      sickDaysAccrued:     0,
    };

    // אם PDF שמור — מחזיר אותו (path boundary check)
    if (row.pdf_url) {
      const allowedDir  = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
      const resolvedPdf = path.resolve(row.pdf_url);
      let realPdf = resolvedPdf;
      try { realPdf = fs.realpathSync(resolvedPdf); } catch { realPdf = null; }
      if (realPdf && realPdf.startsWith(allowedDir) && realPdf.endsWith('.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="payslip_${row.period_month}_${row.period_year}.pdf"`);
        return fs.createReadStream(realPdf).pipe(res);
      }
    }

    // מייצר on-the-fly
    const buffer = await buildPayslipPdf(payslipData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip_${row.period_month}_${row.period_year}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

// ── POST /api/payroll/send — שליחת תלושים במייל ──────────────
router.post('/send', ...canManage, async (req, res, next) => {
  try {
    const { year, month, extraEmails, employeeIds } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'year ו-month חובה' });

    const results = await sendMonthlyPayslips(
      req.user.businessId, parseInt(year), parseInt(month), extraEmails || [], employeeIds || null
    );
    res.json({
      sent:   results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (err) { next(err); }
});

// ── GET /api/payroll/preview/:employeeId — תצוגה מקדימה ──────
router.get('/preview/:employeeId', ...canManage, async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const parsedY = parseInt(year);
    const parsedM = parseInt(month);
    const currentYear  = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1; // getMonth() is 0-indexed
    // בברירת מחדל (בלי month) רוצים את החודש הקודם — בינואר זה דצמבר
    // *של השנה הקודמת*, לא דצמבר של השנה הנוכחית (שעדיין לא קרה)
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear  = currentMonth === 1 ? currentYear - 1 : currentYear;
    const m = (!isNaN(parsedM) && parsedM >= 1 && parsedM <= 12) ? parsedM : prevMonth;
    const y = !isNaN(parsedY) ? parsedY : prevYear;

    const { rows: [emp] } = await db.query(
      `SELECT id, full_name, salary_type, salary_amount, tax_credit_points
       FROM users WHERE id = $1 AND business_id = $2`,
      [req.params.employeeId, req.user.businessId]
    );
    if (!emp) return res.status(404).json({ error: 'עובד לא נמצא' });

    const summary = await shiftModel.getMonthlySummary(emp.id, req.user.businessId, y, m);
    const shifts  = summary?.shifts || [];

    let salaryData;
    if (emp.salary_type === 'global') {
      salaryData = { regularHours: null, overtime125: null, overtime150: null, grossSalary: parseFloat(emp.salary_amount) || 0 };
    } else {
      salaryData = calcMonthlySalary(shifts, parseFloat(emp.salary_amount) || 0);
    }

    const deductions = calcDeductions(salaryData.grossSalary, parseFloat(emp.tax_credit_points || 2.25));

    res.json({
      employee:   { id: emp.id, name: emp.full_name, salaryType: emp.salary_type },
      year: y, month: m,
      shiftsCount: shifts.length,
      ...salaryData,
      ...deductions,
    });
  } catch (err) { next(err); }
});

module.exports = router;
