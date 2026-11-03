const db = require('../utils/db');

// ── כל המשמרות של העסק (מנהל) ───────────────────────────────
const findByBusiness = async (businessId, { fromDate, toDate, employeeId } = {}) => {
  const conditions = ['sh.business_id = $1'];
  const params     = [businessId];
  let   idx        = 2;

  if (fromDate)    { conditions.push(`sh.actual_start >= $${idx++}`);  params.push(fromDate); }
  if (toDate)      { conditions.push(`sh.actual_start <= $${idx++}`);  params.push(toDate); }
  if (employeeId)  { conditions.push(`sh.employee_id = $${idx++}`);    params.push(employeeId); }

  const { rows } = await db.query(
    `SELECT
       sh.*,
       sh.actual_start                                                    AS start_time,
       sh.actual_end                                                      AS end_time,
       sh.status = 'active'                                               AS is_open,
       u.full_name    AS employee_name,
       u.salary_type,
       u.salary_amount,
       ROUND((EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600)::numeric, 2) AS hours_worked,
       CASE WHEN u.salary_type = 'hourly' AND sh.actual_end IS NOT NULL
            THEN ROUND((EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600 * u.salary_amount)::numeric, 0)
            ELSE NULL
       END AS gross_pay
     FROM shifts sh
     INNER JOIN users u ON u.id = sh.employee_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sh.actual_start DESC NULLS LAST`,
    params
  );
  return rows;
};

// ── משמרת פעילה נוכחית של עובד ──────────────────────────────
const findActiveShift = async (employeeId, businessId) => {
  const { rows } = await db.query(
    `SELECT id, business_id, employee_id, planned_start, planned_end, actual_start, actual_end, status, absence_reason, location_verified, edit_note, created_at, updated_at FROM shifts
     WHERE employee_id = $1 AND business_id = $2
       AND status = 'active' AND actual_end IS NULL
     LIMIT 1`,
    [employeeId, businessId]
  );
  return rows[0] || null;
};

// ── כניסה למשמרת ─────────────────────────────────────────────
const clockIn = async (employeeId, businessId, { lat, lng } = {}) => {
  const { rows } = await db.query(
    `INSERT INTO shifts (business_id, employee_id, actual_start, status, location_verified)
     VALUES ($1, $2, NOW(), 'active', $3) RETURNING *`,
    [businessId, employeeId, !!(lat && lng)]
  );
  return rows[0];
};

// ── יציאה ממשמרת ─────────────────────────────────────────────
const clockOut = async (shiftId, businessId) => {
  const { rows } = await db.query(
    `UPDATE shifts
     SET actual_end = NOW(), status = 'completed', updated_at = NOW()
     WHERE id = $1 AND business_id = $2 RETURNING *`,
    [shiftId, businessId]
  );
  return rows[0];
};

// ── עריכת שעות (מנהל) ────────────────────────────────────────
// Sets status='completed', same as clockOut() — this route is also how a
// manager closes a shift an employee forgot to clock out of. Without this,
// the shift kept whatever status it had before (often still 'active'), so
// it kept showing as "open" (is_open in findByBusiness) and — more
// importantly — getMonthlySummary's shifts_count (COUNT(*) FILTER (WHERE
// status = 'completed')) silently undercounted it, skewing the employee's
// monthly hours/shift-count stats used for salary display.
const editHours = async (shiftId, businessId, { actualStart, actualEnd, editedBy, editNote }) => {
  const { rows } = await db.query(
    `UPDATE shifts
     SET actual_start = $1, actual_end = $2, status = 'completed',
         edited_by = $3, edit_note = $4, updated_at = NOW()
     WHERE id = $5 AND business_id = $6 RETURNING *`,
    [actualStart, actualEnd, editedBy, editNote || null, shiftId, businessId]
  );
  return rows[0];
};

// ── סימון היעדרות ─────────────────────────────────────────────
const markAbsent = async (employeeId, businessId, date, absenceReason) => {
  const { rows } = await db.query(
    `INSERT INTO shifts (business_id, employee_id, planned_start, status, absence_reason)
     VALUES ($1, $2, $3::date, 'absent', $4)
     ON CONFLICT (employee_id, planned_start) WHERE status = 'absent' DO NOTHING RETURNING *`,
    [businessId, employeeId, date, absenceReason]
  );
  return rows[0];
};

// ── סיכום שעות לעובד לחודש ───────────────────────────────────
const getMonthlySummary = async (employeeId, businessId, year, month) => {
  const { rows } = await db.query(
    `SELECT
       SUM(EXTRACT(EPOCH FROM (actual_end - actual_start)) / 3600)::float AS total_hours,
       COUNT(*) FILTER (WHERE status = 'completed')::int                  AS shifts_count,
       COUNT(*) FILTER (WHERE absence_reason = 'vacation')::int           AS vacation_days,
       COUNT(*) FILTER (WHERE absence_reason = 'sick')::int               AS sick_days,
       JSON_AGG(
         JSON_BUILD_OBJECT(
           'id',          id,
           'date',        DATE(actual_start AT TIME ZONE 'Asia/Jerusalem'),
           'start',       actual_start,
           'end',         actual_end,
           'hours',       EXTRACT(EPOCH FROM (actual_end - actual_start)) / 3600,
           'status',      status,
           'absence',     absence_reason
         ) ORDER BY actual_start
       ) AS shifts
     FROM shifts
     WHERE employee_id = $1 AND business_id = $2
       AND EXTRACT(YEAR  FROM actual_start AT TIME ZONE 'Asia/Jerusalem') = $3
       AND EXTRACT(MONTH FROM actual_start AT TIME ZONE 'Asia/Jerusalem') = $4`,
    [employeeId, businessId, year, month]
  );
  return rows[0];
};

// ── הוספת משמרת ידנית (היסטורית או עתידית, ללא הגבלת תאריך) ───
const createManual = async (businessId, employeeId, { actualStart, actualEnd, editNote }) => {
  const { rows } = await db.query(
    `INSERT INTO shifts (business_id, employee_id, actual_start, actual_end, status, edit_note)
     SELECT $1, u.id, $3, $4, 'completed', $5
       FROM users u
      WHERE u.id = $2 AND u.business_id = $1
     RETURNING *`,
    [businessId, employeeId, actualStart, actualEnd, editNote || null]
  );
  return rows[0] || null;
};

// ── תכנון משמרות עתידיות (עד שבועיים) ───────────────────────
const planShift = async (businessId, employeeId, { plannedStart, plannedEnd }) => {
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 14);
  if (new Date(plannedStart) > maxDate) {
    const err = new Error('לא ניתן לתכנן משמרות מעבר לשבועיים קדימה');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.query(
    `INSERT INTO shifts (business_id, employee_id, planned_start, planned_end, status)
     SELECT $1, u.id, $3, $4, 'planned'
       FROM users u
      WHERE u.id = $2 AND u.business_id = $1
     RETURNING *`,
    [businessId, employeeId, plannedStart, plannedEnd]
  );
  return rows[0] || null;
};

module.exports = {
  findByBusiness, findActiveShift, clockIn, clockOut,
  editHours, markAbsent, getMonthlySummary, planShift, createManual,
};
