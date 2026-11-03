const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../utils/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

// GET /api/fraud/alerts?days=30
router.get('/alerts', requireAuth, requirePermission('audit'), async (req, res, next) => {
  try {
    const biz  = req.user.businessId;
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);

    const cacheKey = `fraud-alerts:${biz}:${days}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Minimum sample size before a percentage-based check is meaningful — a
    // new/quiet business with e.g. 1 total sale and 1 refund would otherwise
    // show a "50-100% fraud rate" alert off a single, statistically
    // meaningless transaction.
    const MIN_SAMPLE_TX      = 20;
    const MIN_SAMPLE_REVENUE = 500;

    const alerts = [];
    // A check that could not run is not a check that found nothing. Several
    // of these are structurally inapplicable to a business whose only sales
    // data is Z-reports: Z rows carry one daily total with a single
    // timestamp, so per-transaction and per-hour analysis has nothing to bite
    // on, and the BeePort format in use populates neither the discount /
    // cancellation fields nor the payment-channel split. Reporting those as
    // "0 anomalies" reads as an all-clear the data never justified, so each
    // check now states whether it ran and, if not, why.
    const checks = [];
    const noteCheck = (name, label, status, reason = null) =>
      checks.push({ name, label, status, reason });
    // Every check below is individually catch-guarded so one failing SQL
    // query doesn't 500 the whole alerts list — but a swallowed failure must
    // not look identical to "checked, found nothing" on a fraud-detection
    // page. Track which checks actually failed and surface it in the response.
    const failedChecks = [];
    const guardCheck = (name) => (err) => {
      logger.warn(`[Fraud] check failed: ${name}`, { err: err.message, businessId: biz });
      failedChecks.push(name);
      return null; // caller supplies its own per-check fallback shape below
    };

    // ── Check 1: Negative / void transactions (refunds, cancellations) ────────
    const { rows: negatives } = await db.query(`
      SELECT
        COUNT(*)::int                        AS count,
        COALESCE(SUM(ABS(total_amount)),0)::float AS total_voided,
        MIN(sold_at)                         AS first_at,
        MAX(sold_at)                         AS last_at
      FROM sales
      WHERE business_id = $1
        AND sold_at >= NOW() - ($2 || ' days')::interval
        AND total_amount < 0
    `, [biz, days]).catch(err => { guardCheck('negative_transactions')(err); return { rows: [{ count: 0 }] }; });

    const negRow = negatives[0];
    if (negRow && negRow.count > 0) {
      const totalTx = await db.query(
        `SELECT COUNT(*)::int AS total FROM sales WHERE business_id=$1 AND sold_at >= NOW() - ($2 || ' days')::interval`,
        [biz, days]
      ).catch(err => { guardCheck('negative_transactions_total')(err); return { rows: [{ total: 1 }] }; });
      const total = totalTx.rows[0]?.total || 1;
      if (total < MIN_SAMPLE_TX) {
        // Too few transactions for a percentage to mean anything — fall
        // through without alerting rather than showing a misleading rate.
        noteCheck('negative_transactions', 'עסקאות שליליות וביטולים', 'skipped',
          `רק ${total} עסקאות בתקופה — נדרשות לפחות ${MIN_SAMPLE_TX} כדי שאחוז יהיה משמעותי`);
      } else {
        noteCheck('negative_transactions', 'עסקאות שליליות וביטולים', 'ran');
      const negPct  = (negRow.count / total * 100).toFixed(1);
      alerts.push({
        type: 'negative_transactions',
        severity: negRow.count >= 10 ? 'critical' : negRow.count >= 3 ? 'high' : 'medium',
        title: `עסקאות שליליות / ביטולים — ${negRow.count} מקרים`,
        description: `נמצאו ${negRow.count} עסקאות עם סכום שלילי (${negPct}% מסה"כ העסקאות) בסך ₪${negRow.total_voided.toFixed(0)}. מומלץ לבדוק התאמה ב-Z Report`,
        value: negRow.count,
        unit: 'עסקאות',
      });
      }
    } else {
      noteCheck('negative_transactions', 'עסקאות שליליות וביטולים', 'ran');
    }

    // ── Check 1b: High cancellation / discount ratio from Z-report fields ───────
    const { rows: cancelDiscount } = await db.query(`
      SELECT
        COALESCE(SUM(cancellation_amount),0)::float AS total_cancellations,
        COALESCE(SUM(discount_amount),0)::float     AS total_discounts,
        COALESCE(SUM(total_amount),0)::float        AS total_revenue
      FROM sales
      WHERE business_id = $1
        AND sold_at >= NOW() - ($2 || ' days')::interval
        AND total_amount > 0
    `, [biz, days]).catch(err => { guardCheck('cancellation_discount_ratio')(err); return { rows: [] }; });

    const cdRow = cancelDiscount[0];
    const CD_LABEL = 'ביטולים והנחות חריגים';
    if (!cdRow) {
      noteCheck('cancellation_discount_ratio', CD_LABEL, 'skipped', 'לא הצלחנו לקרוא את נתוני המכירות');
    } else if (cdRow.total_revenue < MIN_SAMPLE_REVENUE) {
      noteCheck('cancellation_discount_ratio', CD_LABEL, 'skipped',
        `מחזור של ₪${cdRow.total_revenue.toFixed(0)} בתקופה — נדרש לפחות ₪${MIN_SAMPLE_REVENUE}`);
    } else if (cdRow.total_cancellations === 0 && cdRow.total_discounts === 0) {
      // Not "no cancellations happened" — the fields simply aren't in the file.
      noteCheck('cancellation_discount_ratio', CD_LABEL, 'skipped',
        'דוחות ה-Z שמתקבלים לא כוללים שדות ביטולים והנחות, כך שאין מה להשוות');
    } else {
      noteCheck('cancellation_discount_ratio', CD_LABEL, 'ran');
    }
    if (cdRow && cdRow.total_revenue >= MIN_SAMPLE_REVENUE) {
      const cancelPct  = (cdRow.total_cancellations / cdRow.total_revenue) * 100;
      const discountPct = (cdRow.total_discounts / cdRow.total_revenue) * 100;
      if (cancelPct >= 5 && cdRow.total_cancellations > 0) {
        alerts.push({
          type: 'negative_transactions',
          severity: cancelPct >= 15 ? 'critical' : cancelPct >= 8 ? 'high' : 'medium',
          title: `ביטולים גבוהים — ${cancelPct.toFixed(1)}% ממחזור המכירות`,
          description: `סך ביטולים: ₪${cdRow.total_cancellations.toFixed(0)} מתוך מחזור ₪${cdRow.total_revenue.toFixed(0)} — ${cancelPct.toFixed(1)}% מהמחזור הכולל. שיעור ביטולים גבוה עשוי להצביע על זיכויים לא מורשים`,
          value: cdRow.total_cancellations,
          unit: '₪',
        });
      }
      if (discountPct >= 10 && cdRow.total_discounts > 0) {
        alerts.push({
          type: 'negative_transactions',
          severity: discountPct >= 25 ? 'high' : 'medium',
          title: `הנחות גבוהות — ${discountPct.toFixed(1)}% ממחזור המכירות`,
          description: `סך הנחות: ₪${cdRow.total_discounts.toFixed(0)} מתוך מחזור ₪${cdRow.total_revenue.toFixed(0)} — ${discountPct.toFixed(1)}% מהמחזור הכולל. מומלץ לוודא שהכל מורשה`,
          value: cdRow.total_discounts,
          unit: '₪',
        });
      }
    }

    // ── Check 2: Days with zero revenue (possible unreported cash days) ───────
    // Includes Z-report days too (deduped the same way as elsewhere in the
    // app: individual POS rows win for a day if present, otherwise the
    // Z-report row for that day) — daily revenue is daily revenue regardless
    // of which import path produced it, so excluding Z-report-only days
    // meant this check found nothing at all for any business without live
    // POS integration.
    const { rows: dailyRevenue } = await db.query(`
      WITH smart AS (
        SELECT total_amount,
               DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
               (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
        FROM sales WHERE business_id=$1 AND sold_at >= NOW() - ($2 || ' days')::interval
          AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') < (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
      ),
      ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
      SELECT
        sale_day AS day,
        SUM(total_amount)::float AS daily_revenue,
        COUNT(*)::int            AS tx_count
      FROM smart
      WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
      GROUP BY sale_day
      ORDER BY sale_day ASC
    `, [biz, days]).catch(err => { guardCheck('zero_revenue_days')(err); return { rows: [] }; });

    if (dailyRevenue.length <= 3) {
      noteCheck('revenue_gap_days', 'ימים עם הכנסה חריגה', 'skipped',
        `רק ${dailyRevenue.length} ימי מכירה בתקופה — נדרשים לפחות 4 כדי לחשב ממוצע`);
    } else {
      noteCheck('revenue_gap_days', 'ימים עם הכנסה חריגה', 'ran');
    }
    if (dailyRevenue.length > 3) {
      const avg = dailyRevenue.reduce((s, r) => s + r.daily_revenue, 0) / dailyRevenue.length;
      const threshold = avg * 0.1; // less than 10% of average = suspicious
      const lowDays = dailyRevenue.filter(r => r.daily_revenue < threshold && r.daily_revenue >= 0);
      if (lowDays.length >= 2) {
        alerts.push({
          type: 'revenue_gap_days',
          severity: lowDays.length >= 5 ? 'high' : 'medium',
          title: `${lowDays.length} ימים עם הכנסה נמוכה מהרגיל`,
          description: `${lowDays.length} ימים עם הכנסה מתחת ל-10% מהממוצע היומי (₪${avg.toFixed(0)}). תאריכים: ${lowDays.slice(0,3).map(d => new Date(d.day).toLocaleDateString('he-IL')).join(', ')}${lowDays.length > 3 ? ' ועוד...' : ''}`,
          value: lowDays.length,
          unit: 'ימים',
        });
      }
    }

    // ── Check 3: Sale-type distribution shift (first half vs second half) ─────
    const half = Math.floor(days / 2);
    if (half > 0) { // Skip period-comparison checks when days=1 — no meaningful "previous period"
    const [recentTypes, prevTypes] = await Promise.all([
      db.query(`
        SELECT sale_type, COUNT(*)::int AS cnt, COALESCE(SUM(total_amount),0)::float AS rev
        FROM sales
        WHERE business_id=$1 AND sold_at >= NOW() - ($2 || ' days')::interval
          AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
        GROUP BY sale_type
      `, [biz, half]),
      db.query(`
        SELECT sale_type, COUNT(*)::int AS cnt, COALESCE(SUM(total_amount),0)::float AS rev
        FROM sales
        WHERE business_id=$1
          AND sold_at >= NOW() - ($2 || ' days')::interval
          AND sold_at < NOW() - ($3 || ' days')::interval
          AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
        GROUP BY sale_type
      `, [biz, days, half]),
    ]).catch(err => { guardCheck('sale_type_shift')(err); return [{ rows: [] }, { rows: [] }]; });

    const toMap = rows => Object.fromEntries((rows || []).map(r => [r.sale_type, r]));
    const recentMap = toMap(recentTypes?.rows);
    const prevMap   = toMap(prevTypes?.rows);

    const recentTotal = Object.values(recentMap).reduce((s, r) => s + r.rev, 0);
    const prevTotal   = Object.values(prevMap).reduce((s, r) => s + r.rev, 0);

    if (recentTotal > 0 && prevTotal > 0) {
      noteCheck('sale_type_shift', 'שינוי בתמהיל ערוצי המכירה', 'ran');
      for (const type of Object.keys({ ...recentMap, ...prevMap })) {
        const recentPct = ((recentMap[type]?.rev || 0) / recentTotal) * 100;
        const prevPct   = ((prevMap[type]?.rev   || 0) / prevTotal)   * 100;
        const shift     = Math.abs(recentPct - prevPct);
        if (shift > 25 && (recentMap[type]?.rev || 0) > 0) {
          alerts.push({
            type: 'sale_type_shift',
            severity: 'medium',
            title: `שינוי חריג בערוץ מכירה — ${type}`,
            description: `ערוץ "${type}" עבר מ-${prevPct.toFixed(0)}% ל-${recentPct.toFixed(0)}% מהמחזור (שינוי של ${shift.toFixed(0)} נקודות אחוז). שינוי פתאומי בתמהיל המכירות עשוי להצביע על חריגה`,
            value: shift,
            unit: 'נקודות אחוז',
          });
        }
      }
    } else {
      // This check reads only non-Z rows, so for a business whose sales come
      // entirely from Z-reports there is nothing here by construction.
      noteCheck('sale_type_shift', 'שינוי בתמהיל ערוצי המכירה', 'skipped',
        'הבדיקה דורשת מכירות ברמת עסקה בודדת; לעסק יש רק דוחות Z (סיכום יומי)');
    }

    // ── Check 3b: Payment-channel mix shift (cash/credit/Wolt/Ten-Bis) ────────
    // sale_type is always 'z_report' for Z-report rows (no differentiation),
    // so check 3 above never fires for a Z-report-only business. The payment
    // breakdown columns ARE populated per-row for Z-report imports though,
    // so they give the same kind of "mix shift" signal check 3 looks for.
    const [recentChannels, prevChannels] = await Promise.all([
      db.query(`
        SELECT COALESCE(SUM(cash_amount),0)::float AS cash, COALESCE(SUM(credit_amount),0)::float AS credit,
               COALESCE(SUM(wolt_amount),0)::float AS wolt, COALESCE(SUM(ten_bis_amount),0)::float AS ten_bis
        FROM sales WHERE business_id=$1 AND sold_at >= NOW() - ($2 || ' days')::interval
      `, [biz, half]),
      db.query(`
        SELECT COALESCE(SUM(cash_amount),0)::float AS cash, COALESCE(SUM(credit_amount),0)::float AS credit,
               COALESCE(SUM(wolt_amount),0)::float AS wolt, COALESCE(SUM(ten_bis_amount),0)::float AS ten_bis
        FROM sales WHERE business_id=$1
          AND sold_at >= NOW() - ($2 || ' days')::interval AND sold_at < NOW() - ($3 || ' days')::interval
      `, [biz, days, half]),
    ]).catch(err => { guardCheck('payment_channel_shift')(err); return [{ rows: [{}] }, { rows: [{}] }]; });

    const recentCh = recentChannels.rows[0] || {};
    const prevCh   = prevChannels.rows[0]   || {};
    const CHANNEL_LABEL = { cash: 'מזומן', credit: 'אשראי', wolt: 'Wolt', ten_bis: 'תן ביס' };
    const recentChTotal = ['cash','credit','wolt','ten_bis'].reduce((s, k) => s + (recentCh[k] || 0), 0);
    const prevChTotal   = ['cash','credit','wolt','ten_bis'].reduce((s, k) => s + (prevCh[k]   || 0), 0);

    if (recentChTotal > 0 && prevChTotal > 0) {
      noteCheck('payment_channel_shift', 'שינוי בתמהיל אמצעי התשלום', 'ran');
      for (const k of ['cash', 'credit', 'wolt', 'ten_bis']) {
        const recentPct = ((recentCh[k] || 0) / recentChTotal) * 100;
        const prevPct   = ((prevCh[k]   || 0) / prevChTotal)   * 100;
        const shift     = Math.abs(recentPct - prevPct);
        if (shift > 25 && (recentCh[k] || 0) > 0) {
          alerts.push({
            type: 'payment_channel_shift',
            severity: 'medium',
            title: `שינוי חריג בערוץ תשלום — ${CHANNEL_LABEL[k]}`,
            description: `ערוץ תשלום "${CHANNEL_LABEL[k]}" עבר מ-${prevPct.toFixed(0)}% ל-${recentPct.toFixed(0)}% מהמחזור (שינוי של ${shift.toFixed(0)} נקודות אחוז). שינוי פתאומי בתמהיל התשלומים עשוי להצביע על חריגה`,
            value: shift,
            unit: 'נקודות אחוז',
          });
        }
      }
    } else {
      noteCheck('payment_channel_shift', 'שינוי בתמהיל אמצעי התשלום', 'skipped',
        'דוחות ה-Z שמתקבלים לא כוללים פילוח לפי אמצעי תשלום (מזומן/אשראי/Wolt/תן ביס)');
    }

    } else {
      noteCheck('sale_type_shift',        'שינוי בתמהיל ערוצי המכירה',   'skipped', 'התקופה קצרה מדי להשוואה בין שתי מחציות');
      noteCheck('payment_channel_shift',  'שינוי בתמהיל אמצעי התשלום',  'skipped', 'התקופה קצרה מדי להשוואה בין שתי מחציות');
    } // end if (half > 0)

    // ── Check 4: Unusually large single transactions / days ───────────────────
    // Also includes Z-report rows now — for a Z-report-only business each
    // row already IS a whole day's total, so flagging it against the mean of
    // OTHER days is the natural analogue of "unusually large transaction"
    // rather than something that needs POS-level detail to detect.
    // Threshold lowered from 4σ/6σ to 2σ/3.5σ — 4σ is an extremely high bar
    // (~0.006% under a normal distribution) that a small sample (a business
    // with only a couple weeks of Z-reports) will rarely ever cross even
    // when a day is genuinely unusual by any practical standard.
    // A 2σ test needs enough points for σ to describe anything. With a handful
    // of Z-report days the standard deviation is dominated by the sample
    // itself, so the check would either never fire or fire arbitrarily.
    const MIN_SAMPLE_STATS = 10;
    const { rows: [txStats] } = await db.query(
      `SELECT COUNT(*)::int AS n, STDDEV(total_amount)::float AS sd
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - ($2 || ' days')::interval AND total_amount > 0`,
      [biz, days]
    ).catch(err => { guardCheck('large_transaction')(err); return { rows: [{ n: 0, sd: null }] }; });

    const LT_LABEL = 'עסקאות או ימים חריגים בסכום';
    if (!txStats || txStats.n < MIN_SAMPLE_STATS) {
      noteCheck('large_transaction', LT_LABEL, 'skipped',
        `רק ${txStats?.n ?? 0} רשומות מכירה בתקופה — נדרשות לפחות ${MIN_SAMPLE_STATS} לחישוב סטיית תקן`);
    } else if (!txStats.sd || txStats.sd <= 0) {
      noteCheck('large_transaction', LT_LABEL, 'skipped', 'כל הסכומים בתקופה זהים — אין פיזור לבדוק');
    } else {
      noteCheck('large_transaction', LT_LABEL, 'ran');
    }

    const { rows: bigTx } = (!txStats || txStats.n < MIN_SAMPLE_STATS) ? { rows: [] } : await db.query(`
      WITH stats AS (
        SELECT
          AVG(total_amount)    AS mean,
          STDDEV(total_amount) AS sd
        FROM sales
        WHERE business_id = $1
          AND sold_at >= NOW() - ($2 || ' days')::interval
          AND total_amount > 0
      )
      SELECT
        s.id,
        s.total_amount::float,
        s.sold_at,
        s.sale_type,
        s.pos_sale_id,
        stats.mean::float,
        stats.sd::float
      FROM sales s, stats
      WHERE s.business_id = $1
        AND s.sold_at >= NOW() - ($2 || ' days')::interval
        AND stats.sd > 0
        AND s.total_amount > stats.mean + stats.sd * 2
      ORDER BY s.total_amount DESC
      LIMIT 5
    `, [biz, days]).catch(err => { guardCheck('large_transaction')(err); return { rows: [] }; });

    for (const row of bigTx) {
      const multiple = (row.total_amount / row.mean).toFixed(1);
      const isZReport = !!(row.pos_sale_id && row.pos_sale_id.startsWith('Z-'));
      alerts.push({
        type: 'large_transaction',
        severity: row.total_amount > row.mean + row.sd * 3.5 ? 'high' : 'medium',
        title: isZReport
          ? `יום מכירות חריג — ₪${row.total_amount.toFixed(0)}`
          : `עסקה חריגה בגובה ₪${row.total_amount.toFixed(0)}`,
        description: isZReport
          ? `דוח Z ב-${new Date(row.sold_at).toLocaleDateString('he-IL')} על סך ₪${row.total_amount.toFixed(0)} — פי ${multiple} מהממוצע היומי (₪${row.mean.toFixed(0)})`
          : `עסקה מסוג "${row.sale_type}" ב-${new Date(row.sold_at).toLocaleDateString('he-IL')} על סך ₪${row.total_amount.toFixed(0)} — פי ${multiple} מהממוצע (₪${row.mean.toFixed(0)})`,
        value: row.total_amount,
        unit: '₪',
      });
    }

    // ── Check 5: Sales spikes at unusual hours (3+ σ above mean) ─────────────
    const { rows: hourlyStats } = await db.query(`
      SELECT
        EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
        COUNT(*)::int                                                   AS tx_count,
        COALESCE(SUM(total_amount),0)::float                           AS revenue
      FROM sales
      WHERE business_id = $1
        AND sold_at >= NOW() - ($2 || ' days')::interval
        AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
      GROUP BY hour
      ORDER BY revenue DESC
    `, [biz, days]).catch(err => { guardCheck('unusual_hour_spike')(err); return { rows: [] }; });

    if (hourlyStats.length === 0) {
      // Same structural limit as check 3: a Z-report is one row for a whole
      // day, so there is no hour-by-hour distribution to look at.
      noteCheck('unusual_hour_spike', 'מכירות בשעות חריגות', 'skipped',
        'הבדיקה דורשת חותמת שעה לכל עסקה; דוח Z מסכם יום שלם בשורה אחת');
    } else {
      noteCheck('unusual_hour_spike', 'מכירות בשעות חריגות', 'ran');
    }
    if (hourlyStats.length > 0) {
      const revenues = hourlyStats.map(r => r.revenue);
      const mean   = revenues.reduce((s, v) => s + v, 0) / revenues.length;
      const stddev = Math.sqrt(revenues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / revenues.length);
      // TODO: read business open_hours from settings for per-business thresholds
      const afterHoursStart = 23; // default: after 11pm is suspicious
      const afterHoursEnd = 6;    // default: before 6am is suspicious
      const outliers = hourlyStats.filter(r =>
        r.revenue > mean + stddev * 3 &&
        (r.hour < afterHoursEnd || r.hour >= afterHoursStart)
      );
      for (const h of outliers) {
        alerts.push({
          type: 'unusual_hour_spike',
          severity: 'medium',
          title: `מכירות חריגות בשעה ${h.hour}:00`,
          description: `₪${h.revenue.toFixed(0)} ב-${h.tx_count} עסקאות בשעה ${h.hour}:00 — גבוה מהממוצע ב-3 סטיות תקן`,
          value: h.revenue,
          unit: '₪',
        });
      }
    }

    // Sort: critical first, then high, then medium
    const order = { critical: 0, high: 1, medium: 2 };
    alerts.sort((a, b) => (order[a.severity] || 2) - (order[b.severity] || 2));

    const result = {
      alerts,
      summary: {
        total:    alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        high:     alerts.filter(a => a.severity === 'high').length,
        medium:   alerts.filter(a => a.severity === 'medium').length,
      },
      // Lets the page distinguish "we looked and it's clean" from "most of
      // these checks never ran". Without it, both render as a bare 0.
      checks,
      checks_ran:     checks.filter(c => c.status === 'ran').length,
      checks_skipped: checks.filter(c => c.status === 'skipped').length,
      period_days: days,
      generated_at: new Date().toISOString(),
      // If any individual check failed, "no alerts" doesn't mean "clean" —
      // it may mean that specific check never ran. Surfaced so the frontend
      // can show a degraded-results notice instead of a false all-clear.
      degraded: failedChecks.length > 0,
      failed_checks: failedChecks,
    };

    // Don't cache a degraded result — a transient DB error shouldn't keep
    // showing "results incomplete" for 5 minutes after it's already recovered.
    // 2-minute TTL (reduced from 5) to catch post-import state faster.
    // (fraud-alerts:* is already in sync.service.js's _allCacheKeys, busted
    // by onSaleCreated/onInvoiceApproved/fullCacheBust on every data import.)
    if (!result.degraded) await cache.set(cacheKey, result, 120);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
