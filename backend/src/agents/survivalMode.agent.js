/**
 * Survival Mode Agent
 *
 * מנתח את מצב העסק ומחזיר תוכנית חירום כשהעסק מפסיד כסף.
 *
 * מה הוא עושה:
 *  1. מחשב רווח/הפסד של 30 הימים האחרונים
 *  2. מדרג את המנות לפי רווחיות — רק המנות שמרוויחות
 *  3. מזהה הוצאות שאפשר לקצץ (ספקים יקרים, עובדים יתר)
 *  4. מייצר תוכנית פעולה דחופה בעברית
 *  5. מחשב "ציון הישרדות" 0-100
 */

const db = require('../utils/db');
const inventoryModel = require('../models/inventory.model');
const { detectDataWarning } = require('./menuEngineering.agent');
const { EXPENSE_ACTIVE_TODAY } = require('../utils/expenseWindow');
const { INGREDIENT_COST_CTE } = require('../utils/ingredientSource');

const TARGET_MARGIN = 0.68;

async function analyzeSurvivalMode(businessId, days = 30) {
  const [financial, dishes, expenses, staffCost, zDays] = await Promise.all([
    _getFinancialSummary(businessId, days),
    _getDishProfitability(businessId, days),
    _getFixedExpenses(businessId),
    _getStaffCost(businessId, days),
    _getZDaysCount(businessId, days),
  ]);

  // ── חישוב רווח/הפסד ───────────────────────────────────────
  const revenue      = financial.revenue || 0;
  const foodCost     = financial.food_cost || 0;
  const totalExpenses = expenses.monthly_total || 0;
  // _getStaffCost already scopes its result to `days` (monthly salaries are
  // pro-rated by days/30 inside the query, hourly pay is summed from actual
  // shifts in that window) — it is NOT a monthly rate like totalExpenses, so
  // it must not be scaled by (days/30) again below.
  const staffForPeriod = staffCost.total || 0;

  const grossProfit  = revenue - foodCost;
  const netProfit    = grossProfit - (totalExpenses * (days / 30)) - staffForPeriod;
  const grossMargin  = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  // ── ציון הישרדות ───────────────────────────────────────────
  // 100 = עסק בריא, 0 = בסכנה קריטית
  // עסק חדש לגמרי (אין עדיין נתוני מכירות) הוא "אין מספיק נתונים", לא
  // "קריטי" — 0/critical נראה זהה לעסק שבאמת מפסיד כסף, וזה מטעה בעליל
  // עבור בעל עסק שרק נרשם ועדיין לא חיבר קופה/הזין מכירות.
  const noDataYet = revenue === 0 && zDays === 0;
  let score = 100;
  if (!noDataYet) {
    if (grossMargin < 20) score -= 40;
    else if (grossMargin < 35) score -= 20;
    else if (grossMargin < 50) score -= 10;
    if (netProfit < 0) score -= 30;
    if (revenue === 0) score = 0;
    score = Math.max(0, Math.min(100, score));
    // Force score lower when financials are severely negative — bounded deductions
    // above can still leave the score at 30 even when grossMargin is negative.
    if (grossMargin < 0) score = Math.min(score, 20);
    const netProfitPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    if (netProfitPct < -20) score = Math.min(score, 10);
    score = Math.max(0, score);
  }

  // ── אמינות עלות הסחורה ─────────────────────────────────────
  // כשה-COGS מבוסס הערכה (כי לא הועלו חשבוניות, או שהועלו כל כך מעט שהיחס
  // המשתמע בלתי אפשרי) — הרווח הגולמי, הרווח הנקי והציון כולם נשענים על
  // ניחוש. במקרה הזה אסור להכריז "בריא": חוסר חשבוניות תמיד מטה את הציון
  // כלפי מעלה, כך שדווקא העסק שלא מזין נתונים מקבל את הציון הגבוה ביותר.
  const cogsReliable = financial.cogsBasis === 'invoices';
  const cogsWarning  = cogsReliable ? null
    : financial.cogsBasis === 'estimated_invoices_incomplete'
      ? `עלות הסחורה מוערכת — הועלו ${financial.invoiceCount} חשבוניות בסך ₪${Math.round(financial.invoiceCogs)} מול מחזור של ₪${Math.round(revenue)}, יחס בלתי אפשרי. העלה את חשבוניות הספקים לתקופה כדי לקבל תמונה אמיתית.`
      : 'עלות הסחורה מוערכת ממתכונים — לא נמצאו חשבוניות ספק לתקופה. העלה חשבוניות כדי לאמת את הרווחיות.';

  const status = noDataYet ? 'no_data'
               : (!cogsReliable && score >= 70) ? 'unverified'
               : score >= 70 ? 'healthy'
               : score >= 40 ? 'warning'
               : 'critical';

  // ── מנות מצילות ↔ מנות מזיקות ────────────────────────────
  // רק מנות פעילות מוצגות כהמלצה קדימה-מסתכלת (מנה שנמחקה עדיין נכללת
  // בחישוב ה-SQL ההיסטורי למעלה, אבל לא צריכה להופיע כ"התמקד במנה הזו"
  // כשהיא כבר לא בתפריט) — אותו דפוס בדיוק כמו ב-menuEngineering.agent.js.
  const activeDishes = dishes.filter(d => d.is_active !== false);

  const profitableDishes = activeDishes
    .filter(d => d.margin_pct >= 50 && d.qty_sold > 0)
    .sort((a, b) => b.profit_contribution - a.profit_contribution)
    .slice(0, 6)
    .map(d => ({ ...d, dataWarning: detectDataWarning(d) }));

  const damagingDishes = activeDishes
    .filter(d => d.margin_pct < 25 && d.qty_sold > 0)
    .sort((a, b) => a.margin_pct - b.margin_pct)
    .slice(0, 4)
    .map(d => ({ ...d, dataWarning: detectDataWarning(d) }));

  // ── פעולות חירום ───────────────────────────────────────────
  const actions = _buildActions({ grossMargin, netProfit, revenue, profitableDishes, damagingDishes, staffForPeriod, totalExpenses, days });

  // ── חיסכון פוטנציאלי ───────────────────────────────────────
  const potentialSaving = _calcPotentialSaving(damagingDishes, totalExpenses, days);

  return {
    score,
    status,
    days,
    dataQuality: {
      zDaysInPeriod: zDays,
      // עלות סחורה לא מאומתת שוללת אמינות בדיוק כמו מעט ימי נתונים — היא
      // נכנסת ישירות לרווח הגולמי, לרווח הנקי ולציון עצמו
      reliable: zDays >= 7 && revenue > 0 && cogsReliable,
      cogsBasis: financial.cogsBasis || null,
      cogsReliable,
      warning: zDays < 7
        ? `מבוסס על ${zDays} ימי נתונים בלבד — הניתוח עלול להיות לא מייצג`
        : cogsWarning,
    },
    financial: {
      revenue:       Math.round(revenue * 100) / 100,
      foodCost:      Math.round(foodCost * 100) / 100,
      // true כשעלות המזון מבוססת הערכה תיאורטית ממתכונים (אין חשבוניות
      // ספק לתקופה) ולא רכישות אמיתיות שנרשמו — לשקיפות בממשק
      isEstimated:   !!financial.isEstimated,
      grossProfit:   Math.round(grossProfit * 100) / 100,
      grossMargin:   Math.round(grossMargin * 10) / 10,
      netProfit:     Math.round(netProfit * 100) / 100,
      totalExpenses: Math.round((totalExpenses * (days / 30) + staffForPeriod) * 100) / 100,
    },
    profitableDishes,
    damagingDishes,
    actions,
    potentialSaving,
  };
}

// ── SQL Queries ────────────────────────────────────────────────────────────────

async function _getFinancialSummary(businessId, days) {
  const pad = (n) => String(n).padStart(2, '0');
  const toDate   = new Date();
  const fromDate = new Date(Date.now() - days * 86400000);
  const fromDateStr = `${fromDate.getFullYear()}-${pad(fromDate.getMonth() + 1)}-${pad(fromDate.getDate())}`;
  const toDateStr   = `${toDate.getFullYear()}-${pad(toDate.getMonth() + 1)}-${pad(toDate.getDate())}`;

  const { rows: [zFlagRow] } = await db.query(
    `SELECT z_report_includes_delivery_platforms AS flag FROM businesses WHERE id = $1`,
    [businessId]
  ).catch(() => ({ rows: [{ flag: false }] }));
  const zIncludesDelivery = !!zFlagRow?.flag;

  const [revenueRes, invoiceRes, theo] = await Promise.all([
    db.query(
      `WITH smart AS (
         SELECT *,
                DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sales
         WHERE business_id = $1 AND sold_at >= NOW() - ($2 || ' days')::INTERVAL
           AND NOT ($3 AND sale_type = 'delivery' AND delivery_platform IN ('wolt', 'tenbis'))
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
       filtered AS (SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days))
       SELECT COALESCE(SUM(total_amount), 0)::float AS revenue
       FROM filtered`,
      [businessId, days, zIncludesDelivery]
    ),
    // עלות סחורה אמיתית (חשבוניות ספק) — עדיפה על ההערכה התיאורטית כשקיימת,
    // אותו עיקרון עדיפות שכבר מיושם ב-weeklyReportCrew.agent.js וב-audit.data.js
    db.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS total, COUNT(*)::int AS count
       FROM invoices
       WHERE business_id = $1 AND invoice_date >= (NOW() - ($2 || ' days')::INTERVAL)::date`,
      [businessId, days]
    ),
    // עלות מזון תיאורטית ממה שנמכר בפועל — כולל את אותו fallback ל-dish_ingredients
    // כשלמתכון אין recipe_ingredients משלו (ראה inventory.model.js)
    inventoryModel.getConsumptionAnalysis(businessId, fromDateStr, toDateStr)
      .catch(() => ({ itemDataCoveragePct: 0, totalConsumedValue: 0, items: [] })),
  ]);

  const revenue      = revenueRes.rows[0]?.revenue || 0;
  const invoiceCount = invoiceRes.rows[0]?.count || 0;
  const invoiceCogs  = invoiceRes.rows[0]?.total || 0;
  const hasInvoices  = invoiceCount > 0;

  // ── עלות תיאורטית ממה שנמכר ─────────────────────────────────
  // מחושבת תמיד (לא רק כשאין חשבוניות), כדי שתהיה אמת-מידה להשוואה מול
  // עלות החשבוניות. רוב דוחות ה-Z מכסים רק חלק מהמכירות בפירוט-מנות —
  // מקרינים (extrapolate) את יחס העלות/הכנסה שנצפה בחלק המכוסה על כלל
  // ההכנסה, במקום לזרוק החוצה נתון היסטורי אמיתי חלקי. אותו עיקרון בדיוק
  // כמו ב-getMonthlyFoodCost/דוח שבועי/cashflow.service.js.
  const coveragePct = theo.itemDataCoveragePct || 0;
  let theoreticalCost;
  if (coveragePct > 0 && revenue > 0) {
    const coveredRevenue = revenue * (coveragePct / 100);
    const ratio = coveredRevenue > 0 ? theo.totalConsumedValue / coveredRevenue : 0;
    theoreticalCost = ratio * revenue;
  } else {
    theoreticalCost = theo.totalConsumedValue || 0;
  }

  // ── בדיקת שפיות על עלות החשבוניות ───────────────────────────
  // חשבוניות ספק הן המקור המדויק — אבל רק אם הן באמת הועלו. עסק שהעלה
  // 2 חשבוניות בסך ₪1,704 מול מחזור של ₪85,815 מייצר יחס עלות-מזון של 2%,
  // ומכאן מרווח גולמי "98%" וציון הישרדות 100 — כלומר המסך שנועד להתריע
  // שהעסק קורס הכריז שהוא הבריא בעולם, רק מפני שלא הוזנו חשבוניות.
  // מסעדה עם עלות מזון מתחת ל-12% לא קיימת; יחס כזה הוא עדות לחוסר נתונים,
  // לא לרווחיות. במקרה כזה לוקחים את הגבוה מבין השניים ומסמנים כהערכה.
  const MIN_PLAUSIBLE_FC_RATIO = 0.12;
  const invoiceRatio  = revenue > 0 ? invoiceCogs / revenue : 0;
  const invoicesLookComplete = hasInvoices && invoiceRatio >= MIN_PLAUSIBLE_FC_RATIO;

  const foodCost = invoicesLookComplete
    ? invoiceCogs
    : Math.max(invoiceCogs, theoreticalCost);

  return {
    revenue,
    food_cost:   foodCost,
    isEstimated: !invoicesLookComplete,
    // נחשף למעלה כדי שהציון והממשק יוכלו לומר שהמספר אינו מאומת, במקום
    // להציג "מצב בריא" שנשען על היעדר נתונים
    cogsBasis:   invoicesLookComplete ? 'invoices'
               : hasInvoices          ? 'estimated_invoices_incomplete'
               : 'estimated_no_invoices',
    invoiceCount,
    invoiceCogs,
    theoreticalCost,
  };
}

async function _getDishProfitability(businessId, days) {
  const { rows } = await db.query(
    `WITH ${INGREDIENT_COST_CTE},
     dish_sales AS (
       -- לא מסננים לפי is_active כאן: מנה שנמחקה עדיין צריכה להיספר בהיסטוריה
       -- (החישוב הכולל של financial/revenue למעלה כבר כולל אותה) — הסינון
       -- לפי is_active קורה רק בהמשך, ב-JS, לפני בניית ההמלצות קדימה-מסתכלות.
       SELECT
         r.id, r.name, r.selling_price, COALESCE(r.is_active, TRUE) AS is_active,
         COALESCE(SUM(si.qty), 0)::float AS qty_sold,
         COALESCE(SUM(si.qty * si.unit_price), 0)::float AS total_revenue
       FROM recipes r
       LEFT JOIN sale_items si ON si.recipe_id = r.id
       LEFT JOIN sales s ON s.id = si.sale_id
         AND s.business_id = $1
         AND s.sold_at >= NOW() - ($2 || ' days')::INTERVAL
       WHERE r.business_id = $1
       GROUP BY r.id, r.name, r.selling_price, r.is_active
     ),
     -- עלות המתכון מגיעה מ-recipe_cost_source (utils/ingredientSource.js),
     -- שבוחר בין recipe_ingredients ל-dish_ingredients לפי איזו רשימה מקושרת
     -- יותר לפריטי מלאי.
     --
     -- הגרסה הקודמת העדיפה את recipe_ingredients לפי has_own_cost, שהיה TRUE
     -- גם כשכל השורות מנותקות מהמלאי ונשען עליהן רק manual_cost ישן — כלומר
     -- כפילות חלקית ומיושנת גברה על הגדרת מנה מלאה ומקושרת. בנתונים אמיתיים
     -- זה תמחר "כריך אסאדו" ב-₪4.78 במקום ₪18.03, וניפח את המרווח מ-67% ל-91%
     -- בדיוק במסך שנועד להגיד לבעל העסק אם הוא שורד.
     dish_costs AS (
       SELECT recipe_id AS id, cost_price AS cost_per_dish
       FROM recipe_cost_source
     ),
     -- מנות שאין להן מתכון תואם בשם — נכללות בנפרד כדי שלא יחמקו מהחישוב
     pure_dish_sales AS (
       SELECT
         d.id, d.name, COALESCE(d.selling_price, 0)::float AS selling_price,
         COALESCE(d.is_active, TRUE) AS is_active,
         COALESCE(SUM(si.qty), 0)::float AS qty_sold,
         COALESCE(SUM(si.qty * si.unit_price), 0)::float AS total_revenue
       FROM dishes d
       LEFT JOIN sale_items si ON LOWER(si.name) = LOWER(d.name) AND si.recipe_id IS NULL
       LEFT JOIN sales s ON s.id = si.sale_id
         AND s.business_id = $1
         AND s.sold_at >= NOW() - ($2 || ' days')::INTERVAL
       WHERE d.business_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM recipes r WHERE r.business_id = $1 AND LOWER(r.name) = LOWER(d.name)
         )
       GROUP BY d.id, d.name, d.selling_price, d.is_active
     ),
     pure_dish_costs AS (
       SELECT d.id,
         COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0)::float AS cost_per_dish
       FROM dishes d
       LEFT JOIN dish_ingredients di ON di.dish_id = d.id
       LEFT JOIN inventory_items ii ON ii.id = di.inventory_item_id
       WHERE d.business_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM recipes r WHERE r.business_id = $1 AND LOWER(r.name) = LOWER(d.name)
         )
       GROUP BY d.id
     )
     SELECT
       ds.id, ds.name, ds.selling_price::float AS selling_price, ds.is_active, ds.qty_sold, ds.total_revenue,
       COALESCE(dc.cost_per_dish, 0) AS cost_per_dish,
       CASE WHEN ds.selling_price > 0
         THEN ROUND((((ds.selling_price - COALESCE(dc.cost_per_dish, 0)) / ds.selling_price) * 100)::numeric, 1)::float
         ELSE 0 END AS margin_pct,
       ROUND((ds.qty_sold * (ds.selling_price - COALESCE(dc.cost_per_dish, 0)))::numeric, 2)::float AS profit_contribution
     FROM dish_sales ds
     LEFT JOIN dish_costs dc ON dc.id = ds.id
     WHERE ds.selling_price > 0
     UNION ALL
     SELECT
       pds.id, pds.name, pds.selling_price, pds.is_active, pds.qty_sold, pds.total_revenue,
       COALESCE(pdc.cost_per_dish, 0) AS cost_per_dish,
       CASE WHEN pds.selling_price > 0
         THEN ROUND((((pds.selling_price - COALESCE(pdc.cost_per_dish, 0)) / pds.selling_price) * 100)::numeric, 1)::float
         ELSE 0 END AS margin_pct,
       ROUND((pds.qty_sold * (pds.selling_price - COALESCE(pdc.cost_per_dish, 0)))::numeric, 2)::float AS profit_contribution
     FROM pure_dish_sales pds
     LEFT JOIN pure_dish_costs pdc ON pdc.id = pds.id
     WHERE pds.selling_price > 0
     ORDER BY profit_contribution DESC`,
    [businessId, days]
  );
  return rows;
}

async function _getFixedExpenses(businessId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(
       CASE WHEN frequency='monthly'   THEN amount
            WHEN frequency='weekly'    THEN amount*(52.0/12)
            WHEN frequency='yearly'    THEN amount/12
            WHEN frequency='bimonthly' THEN amount/2
            -- one_time is a single charge, not a rate. This was the only file
            -- in the codebase with ELSE amount here — every other one has an
            -- explicit one_time branch and ELSE 0 — so a one-off purchase was
            -- billed as a permanent monthly cost, forever. In THIS agent that
            -- directly shortens the survival runway it reports, telling an
            -- owner they have fewer months left than they actually do.
            WHEN frequency='one_time'
                 AND date_trunc('month', created_at) = date_trunc('month', NOW() AT TIME ZONE 'Asia/Jerusalem') THEN amount
            ELSE 0 END
     ), 0)::float AS monthly_total
     FROM fixed_expenses
     WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}`,
    [businessId]
  );
  return rows[0] || { monthly_total: 0 };
}

async function _getStaffCost(businessId, days) {
  // Use actual shift hours for hourly employees instead of assumed 173h/month
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(
       CASE u.salary_type
         WHEN 'monthly' THEN u.salary_amount * ($2::float / 30.0)
         WHEN 'hourly'  THEN u.salary_amount * COALESCE(sh_hours.total_hours, 0)
         ELSE u.salary_amount * ($2::float / 30.0)
       END
     ), 0)::float AS total
     FROM users u
     LEFT JOIN (
       SELECT employee_id, SUM(EXTRACT(EPOCH FROM (actual_end - actual_start)) / 3600.0)::float AS total_hours
       FROM shifts
       WHERE business_id = $1
         AND actual_end IS NOT NULL
         AND actual_start >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY employee_id
     ) sh_hours ON sh_hours.employee_id = u.id
     WHERE u.business_id = $1 AND u.role != 'owner' AND u.is_active = TRUE`,
    [businessId, days]
  );
  return rows[0] || { total: 0 };
}

// ── Build action plan ──────────────────────────────────────────────────────────

function _buildActions({ grossMargin, netProfit, revenue, profitableDishes, damagingDishes, staffForPeriod, totalExpenses, days }) {
  const actions = [];

  if (revenue === 0) {
    actions.push({
      priority: 'critical',
      icon: '🚨',
      title: 'אין מכירות בתקופה זו',
      detail: 'לא נרשמו מכירות. בדוק שהקופה מחוברת ושהנתונים מסתנכרנים.',
    });
    return actions;
  }

  // מנות רווחיות — התמקד בהן
  if (profitableDishes.length > 0) {
    const topNames = profitableDishes.slice(0, 3).map(d => `"${d.name}"`).join(', ');
    actions.push({
      priority: 'high',
      icon: '⭐',
      title: `התמקד במנות הרווחיות`,
      detail: `המנות ${topNames} מרוויחות הכי הרבה. שים אותן בראש התפריט, הכשר את הצוות להמליץ עליהן, ודאג לזמינות מלאה שלהן.`,
    });
  }

  // מנות מזיקות — הסר/שפר
  if (damagingDishes.length > 0) {
    const topDamaging = damagingDishes.slice(0, 2).map(d => `"${d.name}" (מרג'ין ${d.margin_pct?.toFixed(0)}%)`).join(', ');
    actions.push({
      priority: 'high',
      icon: '✂️',
      title: `הסר מנות בעייתיות`,
      detail: `${topDamaging} — כמעט לא מרוויחות. הסרתן תשחרר מלאי ותפשט את המטבח.`,
    });
  }

  // מרג'ין נמוך — העלאת מחירים
  if (grossMargin < 35) {
    actions.push({
      priority: 'critical',
      icon: '💰',
      title: 'העלה מחירים מיידית',
      detail: `מרג'ין גולמי של ${grossMargin.toFixed(0)}% נמוך מדי (יעד: 65%+). העלאה של 10-15% על המנות הנמכרות ביותר יכולה להחזיר את העסק לרווחיות תוך שבוע.`,
    });
  }

  // הפסד נקי
  if (netProfit < 0) {
    const lossPerDay = Math.abs(netProfit) / days;
    actions.push({
      priority: 'critical',
      icon: '🔴',
      title: `הפסד של ₪${Math.abs(netProfit).toFixed(0)} ב-${days} ימים`,
      detail: `העסק מפסיד כ-₪${lossPerDay.toFixed(0)} ביום. פעל מיידית: צמצם הוצאות קבועות, הפסק הזמנות מיותרות, ובדוק אם יש ספקים שניתן להחליף.`,
    });
  }

  // עלות עובדים גבוהה
  const staffPct = revenue > 0 ? (staffForPeriod / revenue) * 100 : 0;
  if (staffPct > 35) {
    actions.push({
      priority: 'medium',
      icon: '👥',
      title: `עלות עובדים גבוהה (${staffPct.toFixed(0)}% מהכנסות)`,
      detail: `יעד תעשייתי: 25-30%. שקול לצמצם משמרות בשעות שפל, להגדיל שעות של עובדים חלקיים, או לשלב תפקידים.`,
    });
  }

  // הוצאות קבועות
  const expensesPct = revenue > 0 ? ((totalExpenses * (days / 30)) / revenue) * 100 : 0;
  if (expensesPct > 20) {
    actions.push({
      priority: 'medium',
      icon: '📋',
      title: `הוצאות קבועות גבוהות (${expensesPct.toFixed(0)}%)`,
      detail: `בדוק כל הוצאה קבועה — שכר דירה, מנויים, ביטוחים. שוחח עם בעל הבית על הנחה זמנית. בטל מנויים שלא בשימוש.`,
    });
  }

  // אם הכל טוב
  if (actions.length === 0 || (netProfit > 0 && grossMargin >= 50)) {
    actions.push({
      priority: 'low',
      icon: '✅',
      title: 'העסק ברווחיות תקינה',
      detail: `מרג'ין גולמי ${grossMargin.toFixed(0)}%. המשך לנטר דליפות מלאי ומחירי ספקים לשמירה על הביצועים.`,
    });
  }

  return actions.slice(0, 5);
}

async function _getZDaysCount(businessId, days) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))::int AS z_days
     FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
       AND sold_at >= NOW() - ($2 || ' days')::INTERVAL`,
    [businessId, days]
  ).catch(() => ({ rows: [{ z_days: 0 }] }));
  return rows[0]?.z_days || 0;
}

function _calcPotentialSaving(damagingDishes, totalExpenses, days) {
  const fromDishes = damagingDishes.reduce((sum, d) => {
    // אם מסירים מנה מזיקה — חוסכים בעלות מלאי
    return sum + (d.cost_per_dish || 0) * (d.qty_sold || 0) * 0.3;
  }, 0);
  const fromExpenses = (totalExpenses * (days / 30)) * 0.1; // 10% קיצוץ פוטנציאלי
  return Math.round((fromDishes + fromExpenses) * 100) / 100;
}

module.exports = { analyzeSurvivalMode };
