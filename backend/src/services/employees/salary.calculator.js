/**
 * Israeli Labor Law Salary Calculator
 * חוק שעות עבודה ומנוחה — שעות נוספות 125%/150%
 * ניכויים: מס הכנסה, ביטוח לאומי, בריאות, פנסיה
 */

// ── קבועים (מתעדכנים בחוק) ───────────────────────────────────
// עדכון: אפריל 2025
const MIN_WAGE_PER_HOUR = 33.87;     // שכר מינימום לשעה (אפריל 2025)
const MIN_WAGE_MONTHLY  = 6300.00;   // שכר מינימום חודשי (אפריל 2025)
const PENSION_RATE      = 0.06;      // פנסיה — עובד 6%
const EMPLOYER_PENSION  = 0.065;     // פנסיה — מעסיק 6.5%
const MAX_OVERTIME_DAY  = 4;         // מקסימום שעות נוספות ביום
const MAX_OVERTIME_MONTH = 60;       // מקסימום שעות נוספות בחודש

// ── חישוב שעות נוספות ליום אחד ──────────────────────────────
// MAX_OVERTIME_DAY/MAX_OVERTIME_MONTH are legal limits on how much overtime
// an employer may require an employee to work — they govern compliance, not
// payment. Every hour actually worked must be paid regardless of whether it
// exceeds those limits; a violation should surface as a compliance alert
// (see laborLaw.service.js) rather than as unpaid hours.
function calcDailyOvertime(totalHours) {
  const regular    = Math.min(totalHours, 8);
  const overtime1  = Math.min(Math.max(totalHours - 8, 0), 2);   // שעה 9–10 = 125%
  const overtime2  = Math.max(totalHours - 10, 0);                // מעל שעה 10 = 150%, ללא הגבלה

  return {
    regular:     parseFloat(regular.toFixed(2)),
    overtime125: parseFloat(overtime1.toFixed(2)),
    overtime150: parseFloat(overtime2.toFixed(2)),
  };
}

// ── חישוב שכר חודשי מלא (עובד שעתי) ─────────────────────────
function calcMonthlySalary(shifts, hourlyRate) {
  let totalRegular    = 0;
  let totalOvertime125 = 0;
  let totalOvertime150 = 0;

  for (const shift of shifts) {
    if (!shift.actual_start || !shift.actual_end) continue;
    const start = new Date(shift.actual_start);
    const end   = new Date(shift.actual_end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;
    const hours = (end - start) / 3_600_000;
    if (hours <= 0 || hours > 24) continue;
    const daily  = calcDailyOvertime(hours);
    totalRegular     += daily.regular;
    totalOvertime125 += daily.overtime125;
    totalOvertime150 += daily.overtime150;
  }

  // Real hours worked are always paid in full — MAX_OVERTIME_MONTH is a
  // compliance ceiling on what the employer may legally require, not a cap
  // on what must be paid, so it's surfaced as a flag rather than used to
  // discount pay.
  const totalOT = parseFloat((totalOvertime125 + totalOvertime150).toFixed(2));

  const gross =
    totalRegular     * hourlyRate +
    totalOvertime125 * hourlyRate * 1.25 +
    totalOvertime150 * hourlyRate * 1.50;

  return {
    regularHours:   parseFloat(totalRegular.toFixed(2)),
    overtime125:    parseFloat(totalOvertime125.toFixed(2)),
    overtime150:    parseFloat(totalOvertime150.toFixed(2)),
    grossSalary:    parseFloat(gross.toFixed(2)),
    overtimeExceedsLegalCap: totalOT > MAX_OVERTIME_MONTH,
  };
}

// ── חישוב ניכויים (עובד שעתי וגלובלי) ───────────────────────
function calcDeductions(gross, taxCreditPoints = 2.25, isGlobal = false) {
  // guard — גרוס לא תקין או אפסי
  const g = parseFloat(gross) || 0;
  if (g <= 0) {
    return { grossSalary: 0, incomeTax: 0, nationalInsurance: 0, healthInsurance: 0, pension: 0, netSalary: 0 };
  }

  // ביטוח לאומי (עובד) — טבלה מקורבת 2025
  const nationalInsurance = _calcNationalInsurance(g);

  // ביטוח בריאות — קבוע
  const healthInsurance = _calcHealthInsurance(g);

  // פנסיה
  const pension = parseFloat((g * PENSION_RATE).toFixed(2));

  // מס הכנסה לפי נקודות זיכוי
  // לפי פקודת מס הכנסה: רק 52% מביטוח לאומי ובריאות ניתנים לניכוי מהכנסה החייבת
  const taxableIncome = g - nationalInsurance * 0.52 - healthInsurance * 0.52 - pension;
  const incomeTax     = Math.max(0, _calcIncomeTax(taxableIncome, taxCreditPoints));

  const totalDeductions = nationalInsurance + healthInsurance + pension + incomeTax;
  const netSalary       = parseFloat((g - totalDeductions).toFixed(2));

  return {
    grossSalary:       parseFloat(g.toFixed(2)),
    incomeTax:         parseFloat(incomeTax.toFixed(2)),
    nationalInsurance: parseFloat(nationalInsurance.toFixed(2)),
    healthInsurance:   parseFloat(healthInsurance.toFixed(2)),
    pension:           parseFloat(pension.toFixed(2)),
    netSalary,
  };
}

// ── שכר צפוי (לתצוגה בפרופיל עובד) ─────────────────────────
// 'monthly' is a full synonym for 'global' everywhere else in this codebase
// (checkMinWage above, cashflow.service.js, business.context.js, aiAdvisor
// agent) — must be treated identically here too, otherwise salary_amount
// (a monthly figure) gets multiplied by hours worked as if it were an
// hourly rate.
function calcExpectedSalary(shifts, employee) {
  if (['global', 'monthly'].includes(employee.salary_type)) {
    return {
      type:       'global',
      grossSalary: parseFloat(employee.salary_amount),
      netSalary:  calcDeductions(employee.salary_amount, employee.tax_credit_points, true).netSalary,
    };
  }

  const monthly = calcMonthlySalary(shifts, employee.salary_amount);
  const deductions = calcDeductions(monthly.grossSalary, employee.tax_credit_points);

  return {
    type: 'hourly',
    ...monthly,
    ...deductions,
  };
}

// ── שיעור צבירת חופשה לפי ותק (חוק חופשה שנתית) ─────────────
// שנים 1–4: 14 ימים/שנה | שנים 5–9: 16 ימים/שנה | שנים 10+: 18 ימים/שנה
function _vacationDaysPerMonth(yearsOfSeniority) {
  if (yearsOfSeniority >= 10) return 18 / 12;
  if (yearsOfSeniority >= 5)  return 16 / 12;
  return 14 / 12;
}

// ── צבירת חופשה ומחלה (לפי חוק) ─────────────────────────────
function calcLeaveAccrual(monthsWorked, shiftsPerWeek = 5) {
  // חופשה: לפי ותק — חוק חופשה שנתית
  const seniority          = monthsWorked / 12;
  const vacationRate       = _vacationDaysPerMonth(seniority);
  const vacationDaysAccrued = parseFloat((monthsWorked * vacationRate).toFixed(1));

  // מחלה: 1.5 ימים לחודש (מקסימום 90 ימים)
  const sickDaysAccrued = parseFloat(Math.min(monthsWorked * 1.5, 90).toFixed(1));

  return { vacationDaysAccrued, sickDaysAccrued };
}

// ── בדיקת שכר מינימום ────────────────────────────────────────
function checkMinWage(salaryType, amount) {
  if (salaryType === 'hourly'  && amount < MIN_WAGE_PER_HOUR) {
    return { valid: false, minRequired: MIN_WAGE_PER_HOUR, type: 'hourly' };
  }
  if ((salaryType === 'global' || salaryType === 'monthly') && amount < MIN_WAGE_MONTHLY) {
    return { valid: false, minRequired: MIN_WAGE_MONTHLY, type: 'monthly' };
  }
  return { valid: true };
}

// ── פונקציות עזר — ניכויים ───────────────────────────────────

function _calcNationalInsurance(gross) {
  // ביטוח לאומי עובד — תקרות 2025:
  //   עד 7,522 ₪ (60% שכר ממוצע): 3.5%
  //   מעל 7,522 עד תקרה 49,030 ₪: 12%
  //   מעל תקרה: פטור
  const LOW_CEILING  = 7522;
  const HIGH_CEILING = 49030;
  const g = Math.min(gross, HIGH_CEILING);
  if (g <= LOW_CEILING) return parseFloat((g * 0.035).toFixed(2));
  return parseFloat((LOW_CEILING * 0.035 + (g - LOW_CEILING) * 0.12).toFixed(2));
}

function _calcHealthInsurance(gross) {
  // מס בריאות עובד 2025:
  //   עד 7,522 ₪: 3.1%
  //   מעל 7,522 עד תקרה 49,030 ₪: 5%
  const LOW_CEILING  = 7522;
  const HIGH_CEILING = 49030;
  const g = Math.min(gross, HIGH_CEILING);
  if (g <= LOW_CEILING) return parseFloat((g * 0.031).toFixed(2));
  return parseFloat((LOW_CEILING * 0.031 + (g - LOW_CEILING) * 0.05).toFixed(2));
}

function _calcIncomeTax(taxable, creditPoints) {
  // מדרגות מס הכנסה חודשיות — 2025 (מעודכן לפי פרסום רשות המסים)
  const brackets = [
    { upTo: 7010,     rate: 0.10 },  // 0 – 84,120 ₪/שנה
    { upTo: 10060,    rate: 0.14 },  // 84,120 – 120,720 ₪/שנה
    { upTo: 16150,    rate: 0.20 },  // 120,720 – 193,800 ₪/שנה
    { upTo: 22940,    rate: 0.31 },  // 193,800 – 275,280 ₪/שנה
    { upTo: 45180,    rate: 0.35 },  // 275,280 – 542,160 ₪/שנה
    { upTo: Infinity, rate: 0.47 },  // מעל 542,160 ₪/שנה
  ];

  let tax  = 0;
  let prev = 0;
  for (const { upTo, rate } of brackets) {
    if (taxable <= prev) break;
    tax  += (Math.min(taxable, upTo) - prev) * rate;
    prev  = upTo;
  }

  // ניכוי נקודות זיכוי — ערך נקודה ₪242 לחודש (2025)
  const creditValue = creditPoints * 242;
  return Math.max(0, tax - creditValue);
}

module.exports = {
  calcDailyOvertime,
  calcMonthlySalary,
  calcDeductions,
  calcExpectedSalary,
  calcLeaveAccrual,
  checkMinWage,
  MIN_WAGE_PER_HOUR,
  MIN_WAGE_MONTHLY,
};
