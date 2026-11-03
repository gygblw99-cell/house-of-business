/**
 * Israeli labor law compliance checker.
 * Checks: overtime thresholds, 11-hour rest between shifts,
 * mandatory break rules, Friday/holiday rate, and youth worker limits.
 */
const db = require('../../utils/db');

const DAILY_NORMAL_HOURS = 8;   // up to 8h = 100%
const DAILY_OT1_HOURS    = 2;   // next 2h = 125%
// beyond 10h = 150%

const WEEKLY_NORMAL_HOURS = 42; // up to 42h/week = normal

const MIN_REST_BETWEEN_SHIFTS = 11; // hours — Israeli labor law
const FRIDAY_DAY = 5;               // getDay() = 5
const SATURDAY_DAY = 6;

// Break rules (Israeli law):
//   shift ≥ 6h → 30-min break required
//   shift ≥ 9h → 45-min break required
const BREAK_RULES = [
  { minHours: 9, requiredMinutes: 45 },
  { minHours: 6, requiredMinutes: 30 },
];

// Youth workers (under 18) — max 8h/day, 40h/week, no night shifts
const YOUTH_MAX_DAILY  = 8;
const YOUTH_MAX_WEEKLY = 40;

async function getLaborAlerts(businessId) {
  const alerts = [];

  // Look at the last 14 days of closed shifts
  const { rows: shifts } = await db.query(`
    SELECT
      sh.id, sh.employee_id,
      u.full_name AS employee_name,
      -- birth_date is not a users column and never was; it lives on the
      -- Form 101 record. Selecting u.birth_date made this whole endpoint
      -- throw 42703 on every call, so no labour-law alert of any kind —
      -- rest periods, overtime, Shabbat — ever reached the owner.
      -- LEFT JOIN so employees without a Form 101 still get every check
      -- except the youth ones, which need a date of birth to evaluate.
      f.birth_date,
      sh.actual_start, sh.actual_end,
      sh.break_minutes,
      EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600 AS duration_hours,
      EXTRACT(DOW FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') AS dow,
      EXTRACT(ISODOW FROM sh.actual_start AT TIME ZONE 'Asia/Jerusalem') AS isodow,
      DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') AS work_date
    FROM shifts sh
    JOIN users u ON u.id = sh.employee_id
    LEFT JOIN employee_form101 f ON f.employee_id = u.id AND f.business_id = sh.business_id
    WHERE sh.business_id = $1
      AND sh.actual_start >= NOW() - INTERVAL '14 days'
      AND sh.actual_end IS NOT NULL
    ORDER BY sh.employee_id, sh.actual_start
  `, [businessId]);

  if (!shifts.length) return [];

  // Group by employee for cross-shift checks
  const byEmployee = {};
  for (const sh of shifts) {
    if (!byEmployee[sh.employee_id]) byEmployee[sh.employee_id] = [];
    byEmployee[sh.employee_id].push(sh);
  }

  // ── Per-shift checks ──────────────────────────────────────
  for (const sh of shifts) {
    const hours        = parseFloat(sh.duration_hours) || 0;
    // NULL means the break was never recorded, which is not the same as a
    // recorded break of zero. Treating it as 0 would accuse the owner of a
    // break violation on every shift over 6h purely because nothing tracks
    // breaks yet — so the break rule below sits out until there's a value.
    const breakMins    = sh.break_minutes == null ? null : (parseInt(sh.break_minutes) || 0);
    const netHours     = hours - ((breakMins || 0) / 60);
    const isYouth      = sh.birth_date && _ageAt(sh.birth_date, sh.actual_start) < 18;
    const isFriday     = parseInt(sh.dow) === FRIDAY_DAY;
    const isSaturday   = parseInt(sh.dow) === SATURDAY_DAY;
    const dateLabel    = new Date(sh.actual_start).toLocaleDateString('he-IL');

    // 1. Daily overtime — threshold is day-aware (Friday = 7h normal, other days = 8h)
    // Israeli law §2: Friday standard workday is 7 hours, not 8.
    // Break time counts toward OT threshold per Israeli labor law and court rulings —
    // do NOT subtract break from gross hours when checking OT threshold.
    const normalHours = isFriday ? 7 : DAILY_NORMAL_HOURS;
    if (hours > normalHours + DAILY_OT1_HOURS) {
      alerts.push({
        type: 'overtime_150',
        severity: 'warning',
        employee_name: sh.employee_name,
        date: dateLabel,
        message: `${sh.employee_name} עבד ${hours.toFixed(1)} שעות ב-${dateLabel} — מעל ${normalHours + DAILY_OT1_HOURS} שעות מחייב 150% שכר`,
      });
    } else if (hours > normalHours) {
      alerts.push({
        type: 'overtime_125',
        severity: 'info',
        employee_name: sh.employee_name,
        date: dateLabel,
        message: `${sh.employee_name} עבד ${hours.toFixed(1)} שעות ב-${dateLabel} — שעות ${normalHours + 1}-${normalHours + DAILY_OT1_HOURS} מחייבות 125% שכר`,
      });
    }

    // 2. Break compliance — only when breaks are actually being recorded
    if (breakMins !== null) for (const rule of BREAK_RULES) {
      if (netHours >= rule.minHours && breakMins < rule.requiredMinutes) {
        alerts.push({
          type: 'missing_break',
          severity: 'error',
          employee_name: sh.employee_name,
          date: dateLabel,
          message: `${sh.employee_name} — משמרת ${netHours.toFixed(1)} שעות ב-${dateLabel} ללא הפסקה מספקת (נדרש ${rule.requiredMinutes} דקות)`,
        });
        break;
      }
    }

    // 3. Friday / Saturday premium
    if ((isFriday || isSaturday) && netHours > 0) {
      alerts.push({
        type: 'friday_rate',
        severity: 'info',
        employee_name: sh.employee_name,
        date: dateLabel,
        message: `${sh.employee_name} עבד ב${isSaturday ? 'שבת' : 'שישי'} (${dateLabel}) — בדוק תוספת 150% שכר`,
      });
    }

    // 4. Youth worker limits
    if (isYouth && netHours > YOUTH_MAX_DAILY) {
      alerts.push({
        type: 'youth_daily',
        severity: 'error',
        employee_name: sh.employee_name,
        date: dateLabel,
        message: `${sh.employee_name} (קטין) עבד ${netHours.toFixed(1)} שעות ב-${dateLabel} — חורג ממכסה יומית של ${YOUTH_MAX_DAILY} שעות`,
      });
    }
  }

  // ── Cross-shift checks per employee ──────────────────────
  for (const empShifts of Object.values(byEmployee)) {
    // Sort by start time
    empShifts.sort((a, b) => new Date(a.actual_start) - new Date(b.actual_start));

    for (let i = 1; i < empShifts.length; i++) {
      const prev = empShifts[i - 1];
      const curr = empShifts[i];
      const restHours = (new Date(curr.actual_start) - new Date(prev.actual_end)) / 3_600_000;

      if (restHours < MIN_REST_BETWEEN_SHIFTS) {
        const dateLabel = new Date(curr.actual_start).toLocaleDateString('he-IL');
        alerts.push({
          type: 'insufficient_rest',
          severity: 'error',
          employee_name: curr.employee_name,
          date: dateLabel,
          message: `${curr.employee_name} — מנוחה של ${restHours.toFixed(1)} שעות בלבד בין משמרות (${new Date(prev.actual_end).toLocaleDateString('he-IL')} → ${dateLabel}) — נדרשות לפחות 11 שעות`,
        });
      }
    }

    // Weekly hour totals for youth workers
    const emp = empShifts[0];
    // Use the last shift date in the window (empShifts is sorted by start time above),
    // not today — otherwise an employee who just turned 18 would wrongly skip the check
    // for weeks when they were still under 18.
    const lastShift = empShifts[empShifts.length - 1];
    const isYouth = emp.birth_date && _ageAt(emp.birth_date, new Date(lastShift.actual_start)) < 18;
    if (isYouth) {
      const weeklyHours = _groupByIsoWeek(empShifts);
      for (const [week, hours] of Object.entries(weeklyHours)) {
        if (hours > YOUTH_MAX_WEEKLY) {
          alerts.push({
            type: 'youth_weekly',
            severity: 'error',
            employee_name: emp.employee_name,
            date: `שבוע ${week}`,
            message: `${emp.employee_name} (קטין) עבד ${hours.toFixed(1)} שעות בשבוע ${week} — חורג ממכסה שבועית של ${YOUTH_MAX_WEEKLY} שעות`,
          });
        }
      }
    }
  }

  // Deduplicate & sort by severity
  const severityOrder = { error: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  return alerts;
}

function _ageAt(birthDate, refDate) {
  const birth = new Date(birthDate);
  const ref   = new Date(refDate);
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
}

function _groupByIsoWeek(shifts) {
  const result = {};
  for (const sh of shifts) {
    const d = new Date(sh.actual_start);
    const week = _isoWeek(d);
    const hours = parseFloat(sh.duration_hours) || 0;
    result[week] = (result[week] || 0) + hours;
  }
  return result;
}

function _isoWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

module.exports = { getLaborAlerts };
