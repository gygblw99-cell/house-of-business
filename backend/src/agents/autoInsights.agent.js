/**
 * AI Auto-Insights Agent
 *
 * Generates rule-based Hebrew insights daily for each business.
 * Analyzes real data and creates actionable push insights without LLM calls.
 *
 * Insight types:
 *   food_cost_high     — Food cost % exceeds 35% (standard danger zone)
 *   waste_alert        — Ingredient leakage > 15% on high-value item
 *   star_drop          — A star dish lost >30% sales vs prior period
 *   profit_opportunity — A puzzle dish (high margin, low sales) not promoted
 *   cost_data_missing  — A sold dish shows a fake 100% margin (no cost configured)
 *   sales_trend        — Revenue down >20% week-over-week
 *   revenue_milestone  — Revenue up >30% week-over-week (positive)
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');

const fmt = (n) => Math.round(n || 0).toLocaleString('he-IL');
const { analyzeMenuEngineering, getMonthlyFoodCost } = require('./menuEngineering.agent');
const { detectIngredientLeakage } = require('./ingredientLeakage.agent');
const { validateBusinessConfig }  = require('./configValidator.agent');

// ── Main Export ───────────────────────────────────────────────────────────────
async function generateInsights(businessId) {
  const insights = [];

  const [menuData, monthlyFoodCost, leakageData, weekTrend, configData, zInsights] = await Promise.allSettled([
    analyzeMenuEngineering(businessId, 7),
    getMonthlyFoodCost(businessId),
    detectIngredientLeakage(businessId, 7),
    _getWeekTrend(businessId),
    validateBusinessConfig(businessId),
    _getZReportInsights(businessId),
  ]);

  // Computed once and reused by all menu-based insight checks below.
  // Prevents false positives for new users or businesses with minimal/test data:
  //   - revenue < ₪500 → too few real transactions for any meaningful %
  //   - item-level coverage < 15% → most sales came in as daily Z-report totals (no dish breakdown)
  //   - avgFoodCostPct > 200 → clearly a data-entry/setup error, not a real metric
  //   - hasCostData false → not one dish has an ingredient cost, so the 0% here
  //     means "nothing measured", not "food costs nothing". Without this the
  //     0 sails past the <= 200 ceiling and every menu insight below fires on it.
  const menuSummary = menuData.status === 'fulfilled' ? menuData.value?.summary : null;
  const hasMenuData = !!(menuSummary &&
    menuSummary.totalDishes > 0 &&
    menuSummary.totalRevenue >= 500 &&
    (menuSummary.itemDataCoveragePct ?? 100) >= 15 &&
    menuSummary.hasCostData !== false &&
    menuSummary.avgFoodCostPct <= 200);

  // ── 1. Food Cost % alert ─────────────────────────────────────────────────
  // Uses the exact same calendar-month-to-date figure as the dashboard's
  // food-cost tile (getMonthlyFoodCost) — this used to compute its own
  // separate 7-day-rolling number here, so the insight and the dashboard
  // tile could show two different "food cost %" values for the same
  // business at the same time.
  const monthlyFC = monthlyFoodCost.status === 'fulfilled' ? monthlyFoodCost.value : null;
  if (monthlyFC?.hasData && monthlyFC.foodCostPct !== null && monthlyFC.totalRevenue >= 500 && monthlyFC.foodCostPct > 38) {
    const { foodCostPct, totalRevenue } = monthlyFC;
    insights.push({
      type: 'food_cost_high',
      title: `עלות מזון גבוהה — ${foodCostPct}%`,
      body: `עלות חומרי הגלם שלך עמדה על ${foodCostPct}% מההכנסות מתחילת החודש${monthlyFC.hasAnyEstimate ? ' (כולל הערכה לימים ללא פירוט מנות בדוח)' : ''}. יעד תעשייתי הוא 28-32%. עבור לדף הנדסת תפריט כדי לראות אילו מנות גוררות את הממוצע למעלה.`,
      impact: Math.round((foodCostPct - 32) / 100 * totalRevenue),
      severity: foodCostPct > 45 ? 'critical' : 'warning',
    });
  }

  // ── 2. Waste / Ingredient Leakage alert ─────────────────────────────────
  if (leakageData.status === 'fulfilled' && leakageData.value?.items) {
    const criticals = leakageData.value.items
      .filter(i => i.severity === 'critical' && i.lossValue > 50)
      .sort((a, b) => b.lossValue - a.lossValue)
      .slice(0, 2);

    for (const item of criticals) {
      insights.push({
        type: 'waste_alert',
        title: `דליפה חריגה: ${item.name}`,
        body: `${item.name} מציג דליפה של ${item.variancePct?.toFixed(1)}% — הפסד כספי מוערך ₪${fmt(item.lossValue)} ב-7 ימים. בדוק תהליכי הכנה, מדידות, ופסולת מטבח.`,
        impact: Math.round(item.lossValue || 0),
        severity: 'critical',
      });
    }
  }

  // ── 3. Puzzle dish opportunity ───────────────────────────────────────────
  // Guard: same hasMenuData check — avoids firing with 1-2 test orders.
  // Never pick a dish flagged with a dataWarning (e.g. missing cost data) —
  // a fake 100% margin always sorts first by margin_pct and must not be
  // mistaken for a genuine "promote this dish" opportunity.
  if (hasMenuData && menuData.value?.quadrants) {
    const puzzles = (menuData.value.quadrants.puzzle || []).filter(d => !d.dataWarning);
    const bestPuzzle = puzzles.sort((a, b) => b.margin_pct - a.margin_pct)[0];
    if (bestPuzzle) {
      const weeklyGain = bestPuzzle.qty_sold > 0
        ? Math.round(bestPuzzle.total_revenue * (bestPuzzle.margin_pct / 100))
        : null;

      insights.push({
        type: 'profit_opportunity',
        title: `הזדמנות רווח: "${bestPuzzle.name}"`,
        body: `המנה "${bestPuzzle.name}" מציגה מרג'ין של ${bestPuzzle.margin_pct?.toFixed(1)}% — אחת הגבוהות שלך — אבל מכירות נמוכות מהממוצע. קידום בתפריט, שלטים, או המלצה פעילה של הצוות יכולים להכפיל את הרווח.`,
        impact: weeklyGain,
        severity: 'info',
      });
    }
  }

  // ── 3b. Missing cost data → fake 100% margin alert ───────────────────────
  // A dish/recipe with zero configured ingredient cost shows a mathematically
  // "perfect" 100% margin — that's not a real number, it means its cost was
  // never entered. Surfaced as its own explicit alert (separate from the
  // puzzle-opportunity insight above) so it's never confused with a genuine
  // high-margin dish, and so the underlying data gap gets fixed.
  if (hasMenuData && menuData.value?.dishes) {
    const zeroCostDishes = menuData.value.dishes
      .filter(d => d.qty_sold > 0 && d.cost_per_dish <= 0 && (d.effective_price || d.selling_price) > 0)
      .sort((a, b) => b.total_revenue - a.total_revenue);
    const worst = zeroCostDishes[0];
    if (worst) {
      insights.push({
        type: 'cost_data_missing',
        title: `מרג'ין 100% לא הגיוני: "${worst.name}"`,
        body: `יש מנה שמציגה 100% רווח מרג'ין — "${worst.name}". דבר זה לא הגיוני ומעיד שלא הוגדרו לה מרכיבים/עלות בכלל, כך שכל חישובי הרווחיות והדוחות עבורה אינם מדויקים. אנא טפל במנה הזאת — הגדר את עלות המרכיבים שלה בעמוד המנות.${zeroCostDishes.length > 1 ? ` (עוד ${zeroCostDishes.length - 1} מנות עם אותה בעיה)` : ''}`,
        impact: null,
        severity: 'warning',
      });
    }
  }

  // ── 4. Revenue trend ─────────────────────────────────────────────────────
  if (weekTrend.status === 'fulfilled' && weekTrend.value) {
    const { thisWeek, lastWeek } = weekTrend.value;

    if (lastWeek > 0) {
      const changePct = ((thisWeek - lastWeek) / lastWeek) * 100;

      if (changePct <= -20) {
        insights.push({
          type: 'sales_trend',
          title: `ירידה במכירות — ${Math.abs(changePct).toFixed(0)}% השבוע`,
          body: `המכירות השבוע עמדו על ₪${fmt(thisWeek)} לעומת ₪${fmt(lastWeek)} בשבוע שעבר — ירידה של ${Math.abs(changePct).toFixed(0)}%. בדוק: ימי שיא חסרים, ביקורות שליליות, או בעיות תפעוליות.`,
          impact: Math.round(lastWeek - thisWeek),
          severity: changePct <= -35 ? 'critical' : 'warning',
        });
      } else if (changePct >= 30) {
        insights.push({
          type: 'revenue_milestone',
          title: `שיא מכירות — עלייה של ${changePct.toFixed(0)}%`,
          body: `מכירות השבוע עלו ב-${changePct.toFixed(0)}% לעומת השבוע שעבר — ₪${fmt(thisWeek)} לעומת ₪${fmt(lastWeek)}. כדאי לנצל את המומנטום להגדלת מלאי ולתגמל את הצוות.`,
          impact: Math.round(thisWeek - lastWeek),
          severity: 'info',
        });
      }
    }
  }

  // ── 5. Dog dish warning (low-margin + low-sales) ─────────────────────────
  // Guard: same hasMenuData check — avoids firing with 1-2 test orders.
  if (hasMenuData && menuData.value?.quadrants) {
    const dogs = (menuData.value.quadrants.dog || [])
      .filter(d => d.qty_sold >= 1) // only if it sold at all — pure dead dishes skipped
      .sort((a, b) => a.margin_pct - b.margin_pct)
      .slice(0, 1);

    for (const dog of dogs) {
      insights.push({
        type: 'dog_dish',  // was 'food_cost_high' — wrong type caused dedup collision
        title: `מנה בעייתית: "${dog.name}"`,
        body: `"${dog.name}" נמכרת מעט (${dog.qty_sold} פעמים) ומרג'ין נמוך (${dog.margin_pct?.toFixed(1)}%). כל מכירה כמעט לא מכסה את העלות. שקול להסיר מהתפריט או לשפר את המתכון.`,
        impact: null,
        severity: 'warning',
      });
    }
  }

  // ── 6. Z-Report based insights (always generated when Z-report data exists) ─
  if (zInsights.status === 'fulfilled') {
    const existingTypes = new Set(insights.map(i => i.type));
    insights.push(...zInsights.value.filter(i =>
      i.type === 'zreport_summary' || !existingTypes.has(i.type)
    ));
  }

  // ── 7. Anomaly Detection ──────────────────────────────────────────────────
  const anomalies = await _detectAnomalies(businessId);
  insights.push(...anomalies);

  // ── 8. Configuration warnings (outlier prices, salary, missing costs) ─────
  if (configData.status === 'fulfilled') {
    insights.push(...configData.value);
  }

  return insights;
}

// ── Store insights to DB ───────────────────────────────────────────────────────
async function storeInsights(businessId, insights) {
  // Delete ALL existing insights for this business before inserting fresh ones.
  // This ensures no stale insights from prior days ever linger.
  // (Previously only deleted today's, so bad insights from yesterday remained.)
  // Wrapped in a transaction so the window between DELETE and INSERT is never
  // visible to concurrent readers (prevents a moment of zero insights showing).
  await db.query('BEGIN');
  try {
    await db.query(
      `DELETE FROM ai_insights WHERE business_id = $1`,
      [businessId]
    );

    if (insights.length === 0) {
      await db.query('COMMIT');
      return [];
    }

    const vals   = insights.map((_, i) => { const b = i * 6; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`; }).join(',');
    const params = insights.flatMap(ins => [businessId, ins.type, ins.title, ins.body, ins.impact ?? null, ins.severity]);
    const { rows } = await db.query(
      `INSERT INTO ai_insights (business_id, type, title, body, impact, severity) VALUES ${vals} RETURNING *`,
      params
    );
    await db.query('COMMIT');
    return rows;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────
async function _getWeekTrend(businessId) {
  // Smart dedup: for days with individual POS sales, use those; otherwise use Z-report totals.
  // This prevents double-counting and ensures Z-report-only businesses get accurate trends.
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *,
              DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '14 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered AS (
       SELECT * FROM smart
       WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '7 days' THEN total_amount END), 0)::float AS this_week,
       COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '14 days' AND sold_at < NOW() - INTERVAL '7 days' THEN total_amount END), 0)::float AS last_week
     FROM filtered`,
    [businessId]
  );
  return { thisWeek: rows[0].this_week, lastWeek: rows[0].last_week };
}

// ── Z-Report specific insights ────────────────────────────────────────────────
async function _getZReportInsights(businessId) {
  const insights = [];
  try {
    const { rows } = await db.query(
      `SELECT
         -- 7-day-only stats so insight body matches "7 הימים האחרונים"
         COUNT(*) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days')::int                                        AS report_count,
         COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '7 days' THEN total_amount    END), 0)::float         AS total_revenue,
         COALESCE(AVG(CASE WHEN sold_at >= NOW() - INTERVAL '7 days' THEN total_amount    END), 0)::float         AS avg_daily,
         COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '7 days' THEN orders_count    END), 0)::int           AS total_orders,
         COALESCE(AVG(CASE WHEN sold_at >= NOW() - INTERVAL '7 days' THEN NULLIF(avg_per_order,0) END), 0)::float AS avg_per_order,
         -- previous week for WoW comparison
         COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '14 days'
                            AND sold_at <  NOW() - INTERVAL '7 days'
                       THEN total_amount END), 0)::float      AS prev_week_revenue,
         COALESCE(SUM(CASE WHEN sold_at >= NOW() - INTERVAL '7 days'
                       THEN total_amount END), 0)::float      AS this_week_revenue
       FROM sales
       WHERE business_id = $1
         AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '14 days'`,
      [businessId]
    );

    const z = rows[0];
    if (!z || z.report_count === 0) return [];

    // Average daily revenue insight (always shown when Z-report data exists)
    if (z.avg_daily > 0) {
      insights.push({
        type: 'zreport_summary',
        title: `ממוצע יומי ₪${fmt(z.avg_daily)} — ${z.report_count} ימים`,
        body: `ב-7 הימים האחרונים הכנסות העסק עמדו על ₪${fmt(z.this_week_revenue)} ב-${z.report_count} יום פעיל.` +
              (z.total_orders > 0 ? ` ${fmt(z.total_orders)} הזמנות בסך הכל — ממוצע ₪${fmt(z.avg_per_order)} להזמנה.` : ''),
        impact: null,
        severity: 'info',
      });
    }

    // Week-over-week comparison (when both weeks have data)
    if (z.prev_week_revenue > 0 && z.this_week_revenue > 0) {
      const pct = ((z.this_week_revenue - z.prev_week_revenue) / z.prev_week_revenue) * 100;
      if (pct <= -15) {
        insights.push({
          type: 'sales_trend',
          title: `ירידה במכירות — ${Math.abs(pct).toFixed(0)}% לעומת השבוע שעבר`,
          body: `הכנסות השבוע ₪${fmt(z.this_week_revenue)} לעומת ₪${fmt(z.prev_week_revenue)} בשבוע שעבר — ירידה של ${Math.abs(pct).toFixed(0)}%.`,
          impact: Math.round(z.prev_week_revenue - z.this_week_revenue),
          severity: pct <= -30 ? 'critical' : 'warning',
        });
      } else if (pct >= 20) {
        insights.push({
          type: 'revenue_milestone',
          title: `עלייה במכירות — +${pct.toFixed(0)}% לעומת השבוע שעבר`,
          body: `מכירות השבוע ₪${fmt(z.this_week_revenue)} לעומת ₪${fmt(z.prev_week_revenue)} בשבוע שעבר — עלייה של ${pct.toFixed(0)}%.`,
          impact: Math.round(z.this_week_revenue - z.prev_week_revenue),
          severity: 'info',
        });
      }
    }
  } catch (err) {
    logger.warn('[autoInsights] Z-report insights error', { err: err.message });
  }
  return insights;
}

// ── Anomaly Detection ─────────────────────────────────────────────────────────
// Compares current week vs rolling 4-week average for:
//   1. Invoice spending per supplier
//   2. Waste volume
//   3. Top inventory item consumption rate
async function _detectAnomalies(businessId) {
  const anomalies = [];

  try {
    // ── A. Invoice spending anomaly ──────────────────────────────────────────
    const { rows: spendRows } = await db.query(`
      SELECT
        supplier_id,
        s.name AS supplier_name,
        COALESCE(SUM(CASE WHEN i.invoice_date >= NOW() - INTERVAL '7 days' THEN i.total_amount END), 0)::float  AS this_week,
        COALESCE(SUM(CASE WHEN i.invoice_date <  NOW() - INTERVAL '7 days'
                           AND i.invoice_date >= NOW() - INTERVAL '35 days' THEN i.total_amount END), 0)::float / 4 AS avg_week
      FROM invoices i
      JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.business_id = $1
        AND i.invoice_date >= NOW() - INTERVAL '35 days'
      GROUP BY supplier_id, s.name
      HAVING SUM(CASE WHEN i.invoice_date <  NOW() - INTERVAL '7 days'
                       AND i.invoice_date >= NOW() - INTERVAL '35 days' THEN i.total_amount END) > 0
    `, [businessId]);

    for (const row of spendRows) {
      if (row.avg_week > 500 && row.this_week > row.avg_week * 1.4) {
        const pct = Math.round(((row.this_week - row.avg_week) / row.avg_week) * 100);
        anomalies.push({
          type:     'spend_anomaly',
          title:    `הוצאה חריגה: ${row.supplier_name} (+${pct}%)`,
          body:     `השבוע הוצאת ₪${fmt(row.this_week)} אצל ${row.supplier_name} — ${pct}% מעל הממוצע של 4 השבועות האחרונים (₪${fmt(row.avg_week)}). בדוק אם מדובר בהזמנה חד-פעמית או שינוי מחירים.`,
          impact:   Math.round(row.this_week - row.avg_week),
          severity: pct >= 80 ? 'critical' : 'warning',
        });
      }
    }

    // ── B. Waste spike ───────────────────────────────────────────────────────
    const { rows: wasteRows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN it.created_at >= NOW() - INTERVAL '7 days' AND it.type='waste' THEN ABS(it.qty_change) END), 0)::float  AS this_week,
        COALESCE(SUM(CASE WHEN it.created_at <  NOW() - INTERVAL '7 days'
                           AND it.created_at >= NOW() - INTERVAL '35 days' AND it.type='waste' THEN ABS(it.qty_change) END), 0)::float / 4 AS avg_week,
        COALESCE(SUM(CASE WHEN it.created_at >= NOW() - INTERVAL '7 days' AND it.type='waste'
                          THEN ABS(it.qty_change) * COALESCE(ii.cost_per_unit, 0) END), 0)::float AS this_week_cost
      FROM inventory_transactions it
      LEFT JOIN inventory_items ii ON ii.id = it.item_id AND ii.business_id = $1
      WHERE it.business_id = $1
    `, [businessId]);

    if (wasteRows[0]) {
      const { this_week, avg_week, this_week_cost } = wasteRows[0];
      if (avg_week > 0 && this_week > avg_week * 1.5 && this_week_cost > 80) {
        const pct = Math.round(((this_week - avg_week) / avg_week) * 100);
        anomalies.push({
          type:     'waste_spike',
          title:    `עלייה חדה בפסולת — ${pct}% מעל הרגיל`,
          body:     `הפסולת השבוע עלתה ב-${pct}% מעל הממוצע הרגיל — הפסד כספי מוערך ₪${fmt(this_week_cost)}. בדוק אחסון לא תקין, חוסר הכשרה, או ספירת מלאי שגויה.`,
          impact:   Math.round(this_week_cost),
          severity: pct >= 100 ? 'critical' : 'warning',
        });
      }
    }

    // ── C. Inventory consumption rate spike ─────────────────────────────────
    const { rows: conRows } = await db.query(`
      SELECT
        ii.name,
        COALESCE(SUM(CASE WHEN t.created_at >= NOW() - INTERVAL '7 days'  AND t.type='sale' THEN ABS(t.qty_change) END), 0)::float AS this_week,
        COALESCE(SUM(CASE WHEN t.created_at <  NOW() - INTERVAL '7 days'
                           AND t.created_at >= NOW() - INTERVAL '35 days' AND t.type='sale' THEN ABS(t.qty_change) END), 0)::float / 4 AS avg_week,
        ii.cost_per_unit
      FROM inventory_transactions t
      JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.business_id = $1
        AND t.type = 'sale'
        AND t.created_at >= NOW() - INTERVAL '35 days'
      GROUP BY ii.id, ii.name, ii.cost_per_unit
      HAVING SUM(CASE WHEN t.created_at <  NOW() - INTERVAL '7 days'
                       AND t.created_at >= NOW() - INTERVAL '35 days' AND t.type='sale' THEN ABS(t.qty_change) END) > 0
      ORDER BY (COALESCE(SUM(CASE WHEN t.created_at >= NOW() - INTERVAL '7 days' AND t.type='sale' THEN ABS(t.qty_change) END),0)
                / NULLIF(COALESCE(SUM(CASE WHEN t.created_at < NOW() - INTERVAL '7 days' AND t.created_at >= NOW() - INTERVAL '35 days' AND t.type='sale' THEN ABS(t.qty_change) END),0)/4, 0)) DESC
      LIMIT 3
    `, [businessId]);

    for (const row of conRows) {
      if (row.avg_week > 0 && row.this_week > row.avg_week * 1.5) {
        const pct    = Math.round(((row.this_week - row.avg_week) / row.avg_week) * 100);
        const impact = Math.round((row.this_week - row.avg_week) * (row.cost_per_unit || 0));
        if (impact > 40) {
          anomalies.push({
            type:     'consumption_spike',
            title:    `צריכה חריגה: ${row.name} (+${pct}%)`,
            body:     `השבוע נצרכו ${row.this_week.toFixed(1)} יחידות של ${row.name} — ${pct}% מעל הממוצע הרגיל. פחד מגניבה, שגיאות מדידה, או שינוי בתפריט. הפסד מוערך: ₪${fmt(impact)}.`,
            impact,
            severity: pct >= 100 ? 'critical' : 'warning',
          });
        }
      }
    }
  } catch (err) {
    // Anomaly detection failure must not crash the insights pipeline
    logger.warn('[autoInsights] anomaly detection error', { err: err.message });
  }

  return anomalies;
}

module.exports = { generateInsights, storeInsights };
