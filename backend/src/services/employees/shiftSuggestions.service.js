/**
 * Smart shift scheduling suggestions.
 *
 * Data signals used:
 *  1. Revenue forecast by day-of-week (last 8 weeks)
 *  2. Queue/covers history by day-of-week (table_queue, last 8 weeks)
 *  3. Historical absence rates by day-of-week (last 90 days)
 *  4. Calibrated revenue-per-staff from actual completed shifts + sales
 *
 * Result per day:
 *  - recommended_staff: adjusted for absence buffer
 *  - queue_signal: avg covers that day historically
 *  - absence_risk: % chance someone won't show (by DOW)
 *  - absence_buffer: extra staff added to cover expected absences
 *  - history_reason: one-line Hebrew explanation of the recommendation
 */

const db = require('../../utils/db');
const { todayIL } = require('../../utils/dateIL');

const REVENUE_PER_STAFF_DEFAULT = 800;
const MIN_STAFF = 2;
const MAX_STAFF = 12;

// ── 1. Queue/covers history by DOW ────────────────────────────
async function _getQueueStatsByDow(businessId) {
  const { rows } = await db.query(`
    WITH daily AS (
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Jerusalem')           AS d,
        EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
        COUNT(*)::int                                            AS entries,
        SUM(COALESCE(party_size, 1))::int                       AS covers
      FROM table_queue
      WHERE business_id = $1
        AND created_at >= NOW() - INTERVAL '365 days'
        AND status IN ('seated', 'waiting', 'ready', 'cancelled')
      GROUP BY d, dow
    )
    SELECT
      dow,
      COUNT(DISTINCT d)::int          AS sample_days,
      ROUND(AVG(covers))::int         AS avg_daily_covers,
      ROUND(AVG(entries))::int        AS avg_daily_entries
    FROM daily
    GROUP BY dow
    ORDER BY dow
  `, [businessId]).catch(() => ({ rows: [] }));

  const map = {};
  for (const r of rows) map[r.dow] = r;
  return map;
}

// ── 2. Absence rate by DOW (last 90 days) ────────────────────
async function _getAbsenceRateByDow(businessId) {
  const { rows } = await db.query(`
    SELECT
      EXTRACT(DOW FROM planned_start AT TIME ZONE 'Asia/Jerusalem')::int AS dow,
      COUNT(*)::int                                              AS total_shifts,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END)::int  AS absent_count
    FROM shifts
    WHERE business_id = $1
      AND planned_start >= NOW() - INTERVAL '90 days'
      AND planned_start < NOW()
    GROUP BY dow
    ORDER BY dow
  `, [businessId]).catch(() => ({ rows: [] }));

  const map = {};
  for (const r of rows) {
    const rate = r.total_shifts > 0 ? r.absent_count / r.total_shifts : 0;
    map[r.dow] = {
      total:   r.total_shifts,
      absent:  r.absent_count,
      rate,
      rateLabel: `${Math.round(rate * 100)}%`,
    };
  }
  return map;
}

// ── 3. Calibrate revenue-per-staff from actual history ────────
async function _calibrateRevPerStaff(businessId) {
  // Try shifts + sales join first (365 days)
  const { rows } = await db.query(`
    SELECT
      s_day.d,
      s_day.actual_staff,
      r_day.daily_rev,
      (r_day.daily_rev / NULLIF(s_day.actual_staff, 0))::float AS rps
    FROM (
      SELECT
        DATE(planned_start AT TIME ZONE 'Asia/Jerusalem') AS d,
        COUNT(CASE WHEN status = 'completed' THEN 1 END)::int AS actual_staff
      FROM shifts
      WHERE business_id = $1
        AND planned_start >= NOW() - INTERVAL '365 days'
        AND planned_start < NOW()
      GROUP BY d
      HAVING COUNT(CASE WHEN status = 'completed' THEN 1 END) > 0
    ) s_day
    JOIN (
      SELECT
        DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d,
        SUM(total_amount)::float                    AS daily_rev
      FROM sales
      WHERE business_id = $1
        AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
        AND sold_at >= NOW() - INTERVAL '365 days'
        AND sold_at < NOW()
      GROUP BY d
    ) r_day ON r_day.d = s_day.d
    WHERE r_day.daily_rev > 0
  `, [businessId]).catch(() => ({ rows: [] }));

  if (rows.length < 3) {
    // Fallback: use Z-report shifts + Z-report sales to estimate rps
    const { rows: zRows } = await db.query(`
      SELECT
        zs.d,
        zs.total_staff,
        sr.daily_rev,
        (sr.daily_rev / NULLIF(zs.total_staff, 0))::float AS rps
      FROM (
        SELECT
          report_date::date             AS d,
          COUNT(DISTINCT employee_name)::int AS total_staff
        FROM z_report_shifts
        WHERE business_id = $1
          AND report_date >= NOW() - INTERVAL '365 days'
        GROUP BY report_date::date
        HAVING COUNT(DISTINCT employee_name) > 0
      ) zs
      JOIN (
        SELECT
          DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS d,
          SUM(total_amount)::float                    AS daily_rev
        FROM sales
        WHERE business_id = $1
          AND pos_sale_id LIKE 'Z-%'
          AND sold_at >= NOW() - INTERVAL '365 days'
        GROUP BY DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')
      ) sr ON sr.d = zs.d
      WHERE sr.daily_rev > 0
    `, [businessId]).catch(() => ({ rows: [] }));

    if (zRows.length >= 3) {
      const valid = zRows
        .map(r => parseFloat(r.rps))
        .filter(rps => rps > 100 && rps < 8000)
        .sort((a, b) => a - b);
      if (valid.length >= 3) {
        const mid = Math.floor(valid.length / 2);
        const median = valid.length % 2 === 0
          ? (valid[mid - 1] + valid[mid]) / 2
          : valid[mid];
        return Math.round(median / 50) * 50;
      }
    }
    return REVENUE_PER_STAFF_DEFAULT;
  }

  // Use median to avoid outlier days
  const valid = rows
    .map(r => parseFloat(r.rps))
    .filter(rps => rps > 100 && rps < 8000)
    .sort((a, b) => a - b);

  if (valid.length === 0) return REVENUE_PER_STAFF_DEFAULT;

  const mid    = Math.floor(valid.length / 2);
  const median = valid.length % 2 === 0
    ? (valid[mid - 1] + valid[mid]) / 2
    : valid[mid];

  return Math.round(median / 50) * 50; // round to nearest ₪50
}

// ── 4. Build one-line Hebrew reason ──────────────────────────
function _buildReason({ forecastRevenue, queueStats, absenceStats, recommendedBase, absenceBuffer, calibratedRps, isForecastFromHistory, sampleDays }) {
  const parts = [];

  if (forecastRevenue > 0) {
    const src = sampleDays ? ` (${sampleDays} ימי דוח Z)` : '';
    parts.push(`תחזית הכנסה ₪${Math.round(forecastRevenue).toLocaleString('he')}${src} · ₪${calibratedRps} לעובד`);
  }

  if (queueStats?.avg_daily_covers > 0) {
    parts.push(`ממוצע ${queueStats.avg_daily_covers} סועדים ביום זה`);
  }

  if (absenceStats?.rate > 0.1 && absenceBuffer > 0) {
    parts.push(`חיץ ${absenceBuffer} עובד — ${absenceStats.rateLabel} היעדרות היסטורית`);
  }

  if (!isForecastFromHistory) {
    return 'אין נתוני מכירות — מינימום עובדים מומלץ (ייבא דוחות Z לקבל המלצה מדויקת)';
  }

  return parts.length > 0 ? parts.join(' · ') : 'מבוסס על היסטוריית מכירות';
}

// ── Main export ───────────────────────────────────────────────
async function getShiftSuggestions(businessId) {
  const [historicByDowRows, employees, scheduled, queueByDow, absenceByDow, calibratedRps] =
    await Promise.all([
      // Revenue history — look back up to 365 days so Z-reports are included
      db.query(`
        SELECT
          dow,
          ROUND(AVG(daily_rev)::numeric, 0)::float AS avg_revenue,
          COUNT(DISTINCT d)::int                    AS sample_days
        FROM (
          SELECT
            DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')                            AS d,
            EXTRACT(DOW FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int           AS dow,
            SUM(total_amount)                                                       AS daily_rev
          FROM sales
          WHERE business_id = $1
            AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
            AND sold_at >= NOW() - INTERVAL '365 days'
          GROUP BY d, dow
        ) sub
        GROUP BY dow
        ORDER BY dow
      `, [businessId]).then(r => r.rows).catch(() => []),

      // Active employees
      db.query(`
        SELECT id, full_name, phone, role, salary_type, salary_amount
        FROM users
        WHERE business_id = $1
          AND is_active = true
          AND role != 'owner'
        ORDER BY full_name
      `, [businessId]).then(r => r.rows).catch(() => []),

      // Already-scheduled shifts next 7 days
      db.query(`
        SELECT
          DATE(sh.planned_start AT TIME ZONE 'Asia/Jerusalem') AS day,
          COUNT(*)::int                                        AS scheduled_count,
          ARRAY_AGG(u.id)                                      AS employee_ids
        FROM shifts sh
        JOIN users u ON u.id = sh.employee_id
        WHERE sh.business_id = $1
          AND sh.planned_start >= NOW()
          AND sh.planned_start < NOW() + INTERVAL '7 days'
        GROUP BY day
      `, [businessId]).then(r => r.rows).catch(() => []),

      _getQueueStatsByDow(businessId),
      _getAbsenceRateByDow(businessId),
      _calibrateRevPerStaff(businessId),
    ]);

  // Build DOW → avg revenue map (including sample count for reason string)
  const dowRevMap    = {};
  const dowSampleMap = {};
  for (const r of historicByDowRows) {
    dowRevMap[r.dow]    = r.avg_revenue;
    dowSampleMap[r.dow] = r.sample_days || 0;
  }

  // Build scheduled-by-day map
  const scheduledByDay = {};
  for (const s of scheduled) {
    const key = s.day.toISOString().split('T')[0];
    scheduledByDay[key] = { count: s.scheduled_count, employeeIds: s.employee_ids };
  }

  const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  const suggestions = [];

  // עוגן בצהריים UTC של "היום" בישראל — נמנע מהחלפת יום שגויה בזמן חישוב
  // תאריכים עתידיים על שרת שרץ ב-UTC (בניגוד ל-new Date() + setHours מקומי,
  // שהיה עלול לפגר יום אחד מול השעון הישראלי בשעות 00:00-03:00).
  const todayAnchor = new Date(`${todayIL()}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const date = new Date(todayAnchor);
    date.setUTCDate(date.getUTCDate() + i + 1);
    const dateStr = date.toISOString().split('T')[0];
    const dow     = date.getUTCDay();
    const isFri   = dow === 5;
    const isSat   = dow === 6;

    const forecastRevenue        = dowRevMap[dow] || 0;
    const sampleDays             = dowSampleMap[dow] || 0;
    const isForecastFromHistory  = forecastRevenue > 0 && sampleDays >= 1;
    const queueStats             = queueByDow[dow] || null;
    const absenceStats           = absenceByDow[dow] || null;

    // Base recommendation from revenue
    const recommendedBase = isForecastFromHistory
      ? Math.min(MAX_STAFF, Math.max(MIN_STAFF, Math.ceil(forecastRevenue / calibratedRps)))
      : MIN_STAFF;

    // Absence buffer: if DOW has >15% absence rate, add 1 extra
    const absenceBuffer = (absenceStats?.rate || 0) > 0.15 ? 1 : 0;

    // Queue boost: if avg covers > 30 and would require more staff, add 1
    const queueBoost = (queueStats?.avg_daily_covers || 0) > 30 &&
                       recommendedBase + absenceBuffer < MAX_STAFF ? 1 : 0;

    const recommendedStaff = Math.min(MAX_STAFF, recommendedBase + absenceBuffer + queueBoost);

    const existing = scheduledByDay[dateStr] || { count: 0, employeeIds: [] };
    const gap      = Math.max(0, recommendedStaff - existing.count);

    // Suggest employees not yet scheduled
    const alreadySet = new Set(existing.employeeIds || []);
    const available  = employees.filter(e => !alreadySet.has(e.id));

    const toInvite = available.slice(0, gap).map(emp => {
      const dateLabel = date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });
      const message   = `שלום ${emp.full_name}! 👋\nאנחנו צריכים אותך למשמרת ב-${dateLabel}.\nאנא אשר/י הגעה בהקדם האפשרי 🙏`;
      const phone     = (emp.phone || '').replace(/\D/g, '').replace(/^0/, '972');
      return {
        employee_id:   emp.id,
        employee_name: emp.full_name,
        phone:         emp.phone,
        wa_link:       phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null,
        message,
      };
    });

    const history_reason = _buildReason({
      forecastRevenue,
      queueStats,
      absenceStats,
      recommendedBase,
      absenceBuffer,
      calibratedRps,
      isForecastFromHistory,
      sampleDays,
    });

    suggestions.push({
      date:               dateStr,
      date_label:         date.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }),
      dow,
      dow_name:           DAYS_HE[dow],
      is_weekend:         isFri || isSat,
      forecast_revenue:   parseFloat((forecastRevenue || 0).toFixed(0)),
      recommended_staff:  recommendedStaff,
      recommended_base:   recommendedBase,
      absence_buffer:     absenceBuffer,
      queue_boost:        queueBoost,
      scheduled_count:    existing.count,
      gap,
      status:             gap <= 0 ? 'ok' : gap === 1 ? 'warning' : 'critical',
      invite_suggestions: toInvite,
      // ── new intelligence fields ──
      queue_signal: queueStats ? {
        avg_covers:  queueStats.avg_daily_covers,
        avg_entries: queueStats.avg_daily_entries,
        sample_days: queueStats.sample_days,
      } : null,
      absence_risk: absenceStats ? {
        rate:      parseFloat(absenceStats.rate.toFixed(3)),
        rate_label: absenceStats.rateLabel,
        total:     absenceStats.total,
        absent:    absenceStats.absent,
      } : null,
      history_reason,
    });
  }

  const totalGap = suggestions.reduce((s, d) => s + d.gap, 0);

  return {
    suggestions,
    employees:          employees.map(e => ({ id: e.id, name: e.full_name, phone: e.phone })),
    total_gap:          totalGap,
    revenue_per_staff:  calibratedRps,
    calibrated_from_history: calibratedRps !== REVENUE_PER_STAFF_DEFAULT,
  };
}

module.exports = { getShiftSuggestions };
