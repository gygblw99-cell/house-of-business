const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../utils/db');
const { todayIL } = require('../utils/dateIL');

const DOW_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// GET /api/calendar/smart-insights
router.get('/smart-insights', requireAuth, async (req, res, next) => {
  try {
    const biz = req.user.businessId;

    // Day-of-week averages — last 90 days
    const { rows: dowRows } = await db.query(`
      SELECT
        EXTRACT(DOW FROM report_date)::int AS dow,
        ROUND(AVG(total_revenue)::numeric, 0) AS avg_revenue,
        COUNT(*)::int AS sample_count
      FROM z_reports
      WHERE business_id = $1
        AND report_date >= NOW() - INTERVAL '90 days'
        AND total_revenue > 0
      GROUP BY dow
      ORDER BY dow
    `, [biz]);

    // Weekly revenue totals — last 4 weeks
    const { rows: weeklyTrend } = await db.query(`
      SELECT
        DATE_TRUNC('week', report_date) AS week_start,
        ROUND(SUM(total_revenue)::numeric, 0) AS total
      FROM z_reports
      WHERE business_id = $1
        AND report_date >= NOW() - INTERVAL '28 days'
      GROUP BY week_start
      ORDER BY week_start
    `, [biz]);

    // All-time revenue record
    const { rows: recordRows } = await db.query(`
      SELECT total_revenue AS record, report_date
      FROM z_reports
      WHERE business_id = $1
      ORDER BY total_revenue DESC
      LIMIT 1
    `, [biz]);

    // Build insights
    const insights = [];

    if (dowRows.length > 0) {
      const sorted = [...dowRows].sort((a, b) => b.avg_revenue - a.avg_revenue);
      const best  = sorted[0];
      const worst = sorted[sorted.length - 1];

      if (parseFloat(best.avg_revenue) > 0) {
        insights.push({
          type:  'best_day',
          icon:  'TrendingUp',
          title: `יום ${DOW_HE[best.dow]} — היום החזק ביותר`,
          body:  `ממוצע ₪${Number(best.avg_revenue).toLocaleString('he-IL')} (${best.sample_count} שבועות)`,
          color: 'green',
        });
      }

      if (worst.dow !== best.dow && parseFloat(worst.avg_revenue) > 0) {
        insights.push({
          type:  'slow_day',
          icon:  'TrendingDown',
          title: `יום ${DOW_HE[worst.dow]} — יום שקט`,
          body:  `ממוצע ₪${Number(worst.avg_revenue).toLocaleString('he-IL')} — שקול מבצע למשיכת לקוחות`,
          color: 'amber',
        });
      }
    }

    if (weeklyTrend.length >= 2) {
      const last = weeklyTrend[weeklyTrend.length - 1];
      const prev = weeklyTrend[weeklyTrend.length - 2];
      const pct  = prev.total > 0 ? Math.round((last.total - prev.total) / prev.total * 100) : 0;
      if (Math.abs(pct) >= 5) {
        insights.push({
          type:  'weekly_trend',
          icon:  pct > 0 ? 'ArrowUpRight' : 'ArrowDownRight',
          title: `שבוע אחרון: ${pct > 0 ? '+' : ''}${pct}% לעומת השבוע הקודם`,
          body:  `₪${Number(last.total).toLocaleString('he-IL')} לעומת ₪${Number(prev.total).toLocaleString('he-IL')}`,
          color: pct > 0 ? 'green' : 'red',
        });
      }
    }

    if (recordRows[0]?.record > 0) {
      insights.push({
        type:  'record',
        icon:  'Trophy',
        title: `שיא הכנסה: ₪${Number(recordRows[0].record).toLocaleString('he-IL')}`,
        body:  `הושג ב-${new Date(recordRows[0].report_date).toLocaleDateString('he-IL')}`,
        color: 'gold',
      });
    }

    // Upcoming busy DOWs — next 7 days where historical avg is in top 40%
    const maxAvg = dowRows.length > 0 ? Math.max(...dowRows.map(r => parseFloat(r.avg_revenue))) : 0;
    const threshold = maxAvg * 0.6;
    const upcomingBusyDates = [];
    // Anchor on todayIL(), not a naive new Date() — the server runs in UTC,
    // 2-3 hours behind Israel's calendar date around midnight, which shifted
    // this whole 7-day window by a day during that window (see dateIL.js).
    const [ty, tm, td] = todayIL().split('-').map(Number);
    const todayUtcMidnight = Date.UTC(ty, tm - 1, td);
    for (let i = 1; i <= 7; i++) {
      const dt  = new Date(todayUtcMidnight + i * 86_400_000);
      const dow = dt.getUTCDay();
      const match = dowRows.find(r => r.dow === dow && parseFloat(r.avg_revenue) >= threshold);
      if (match) upcomingBusyDates.push(dt.toISOString().slice(0, 10));
    }

    res.json({
      dow_averages: dowRows.map(r => ({
        dow:          r.dow,
        name:         DOW_HE[r.dow],
        avg_revenue:  parseFloat(r.avg_revenue),
        sample_count: r.sample_count,
      })),
      insights,
      upcoming_busy_dates: upcomingBusyDates,
    });
  } catch (err) { next(err); }
});

module.exports = router;
