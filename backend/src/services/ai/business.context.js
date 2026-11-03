/**
 * Business Intelligence RAG OS — Context Builder
 * Builds the master system prompt with live business data
 */

const db    = require('../../utils/db');
const cache = require('../../utils/cache');
const { sanitizeField } = require('../../utils/aiSanitize');
const { EXPENSE_ACTIVE_TODAY } = require('../../utils/expenseWindow');
const logger = require('../../utils/logger');
const { INGREDIENT_COST_CTE } = require('../../utils/ingredientSource');

const CONTEXT_V = 'v10'; // bumped: dead-stock query fixed + menu margins now use the resolved cost source

function _cacheKey(businessId) {
  return `biz:context:${CONTEXT_V}:${businessId}`;
}

async function buildBusinessContext(businessId) {
  return cache.wrap(
    _cacheKey(businessId),
    () => _fetchBusinessContext(businessId),
    1800 // 30 minutes — bustContextCache() is called on every Z-report import / data write
  );
}

async function bustContextCache(businessId) {
  try { await cache.del(_cacheKey(businessId)); } catch { /* non-fatal */ }
}

async function _fetchBusinessContext(businessId) {
  const [
    business,
    salesSummary,
    salesTrend,
    topItems,
    bottomItems,
    inventoryAlerts,
    inventoryWaste,
    inventoryCosts,
    expenseSummary,
    employeeSummary,
    auditScore,
    recentOrders,
    wasteData,
    peakHours,
    channelSplit,
    reviewsSummary,
    profitLeaks,
    momComparison,
    menuMargins,
    zReportIntelligence,
    dataQuality,
    revenueByDay,
  ] = await Promise.all([
    _getBusiness(businessId),
    _getSalesSummary(businessId),
    _getSalesTrend(businessId),
    _getTopItems(businessId),
    _getBottomItems(businessId),
    _getInventoryAlerts(businessId),
    _getInventoryWaste(businessId),
    _getInventoryCosts(businessId),
    _getExpenseSummary(businessId),
    _getEmployeeSummary(businessId),
    _getLatestAuditScore(businessId),
    _getRecentOrders(businessId),
    _getWasteData(businessId),
    _getPeakHours(businessId),
    _getChannelSplit(businessId),
    _getReviewsSummary(businessId),
    _getProfitLeaks(businessId),
    _getMomComparison(businessId),
    _getMenuMargins(businessId),
    _getZReportIntelligence(businessId),
    _getDataQuality(businessId),
    _getRevenueByDayOfWeek(businessId),
  ]);

  return _buildSystemPrompt({
    business, salesSummary, salesTrend, topItems, bottomItems,
    inventoryAlerts, inventoryWaste, inventoryCosts, expenseSummary, employeeSummary,
    auditScore, recentOrders, wasteData, peakHours, channelSplit,
    reviewsSummary, profitLeaks, momComparison, menuMargins, zReportIntelligence,
    dataQuality, revenueByDay,
  });
}

function _buildSystemPrompt(data) {
  const {
    business, salesSummary, salesTrend, topItems, bottomItems,
    inventoryAlerts, inventoryWaste, inventoryCosts, expenseSummary, employeeSummary,
    auditScore, recentOrders, wasteData, peakHours, channelSplit,
    reviewsSummary, profitLeaks, momComparison, menuMargins, zReportIntelligence,
    dataQuality, revenueByDay,
  } = data;

  const biz = business || {};
  const today = new Date().toLocaleDateString('he-IL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return `# Business Intelligence RAG OS — MASTER SYSTEM PROMPT

You are "Business Intelligence RAG OS" — an elite AI-powered business intelligence operating system for "${biz.name || 'העסק'}".

You are NOT a simple chatbot. You are:
- An AI business consultant with deep domain expertise
- A strategic financial analyst (CFO-level thinking)
- A hybrid RAG reasoning engine with live access to all business data
- A multi-agent orchestration system
- A predictive intelligence engine
- A persistent business memory system

## CORE MISSION
Transform raw business data into actionable intelligence. Every response must answer:
1. **WHAT** is happening
2. **WHY** it is happening
3. **WHAT** will happen next (prediction)
4. **HOW** to improve it (concrete action)

## REASONING FRAMEWORK
Before every response, internally classify:
- Intent type (analysis / prediction / recommendation / operational / financial)
- Which data sources are relevant
- What patterns or anomalies exist
- What the business owner actually needs to know
- What is the estimated revenue/profit impact

Always think like: Senior Business Consultant + CFO + COO + Growth Strategist

## RESPONSE ARCHITECTURE
Structure responses as an executive briefing:
- **Executive Summary** (2-3 lines max)
- **Key Findings** (data-backed, specific numbers)
- **Root Cause Analysis** (WHY it's happening)
- **Financial Impact** (₪ estimates where possible)
- **Strategic Recommendations** (prioritized, actionable)
- **Predicted Outcome** (if recommendations are followed)

Use this format only when the question warrants depth. For simple questions, respond concisely and directly.

## LANGUAGE RULE
Always respond in the language the user writes in (Hebrew / English / Arabic).

## BUSINESS IDENTITY
- Business name: ${biz.name || 'לא ידוע'}
- Business type: ${biz.business_type || 'לא ידוע'}
- Currency: ₪ (ILS)
- Today: ${today}

---
# LIVE BUSINESS INTELLIGENCE DATA
${(parseFloat(zReportIntelligence?.revenue_30d || 0) === 0 && (salesSummary?.rev_7d || 0) === 0 && zReportIntelligence?.last_report_date)
  ? `\n## 🚨 DATA STALENESS ALERT\n**CRITICAL**: No revenue data in the past 30 days. The most recent Z-report is from ${zReportIntelligence.last_report_date}. When asked about "last 7 days", "this week", or "recent" revenue — the correct answer is ₪0 (zero). Historical data below is from a prior period and MUST NOT be cited as recent/current figures.\n`
  : ''
}
## 💰 REVENUE SNAPSHOT — READ THIS FIRST BEFORE ANSWERING ANY REVENUE QUESTION
> These are the ONLY numbers to use when asked about recent revenue, this week, last 7 days, or daily average.
> Do NOT use the 30-day or 90-day figures below for "recent" or "last week" questions.

| Metric | Value |
|--------|-------|
| **הכנסות 7 ימים אחרונים** | **₪${(salesSummary?.rev_7d || 0).toFixed(0)}** |
| **ימים פעילים ב-7 ימים אחרונים** | **${salesSummary?.active_days_7d || 0} ימים** |
| **ממוצע יומי (מבוסס 7 ימים אחרונים)** | **₪${(salesSummary?.daily_avg_7d || 0).toFixed(0)} ליום** |
| הכנסות היום | ₪${(salesSummary?.rev_today || 0).toFixed(0)} |
| הכנסות 30 יום (Z-report) | ₪${parseFloat(zReportIntelligence?.revenue_30d || 0).toFixed(0)} ← חלון שונה, לא "שבוע אחרון" |
| הכנסות 90 יום | ₪${parseFloat(zReportIntelligence?.revenue_90d || 0).toFixed(0)} ← חלון שונה |

**⚠️ RULE: If asked "last 7 days" / "this week" / "ממוצע יומי" — use ONLY the 7-day row above. Never substitute the 30-day figure.**

## 🧾 Z-Report POS Revenue — Historical Context (NOT for recent-revenue answers)
${zReportIntelligence?.total_reports > 0 ? `
- סה"כ הכנסות מדוחות Z (כל הזמנים): ₪${parseFloat(zReportIntelligence.all_time_revenue || 0).toFixed(0)}
- מספר דוחות Z שיובאו: ${zReportIntelligence.total_reports}
- טווח תאריכים: ${zReportIntelligence.first_report_date} עד ${zReportIntelligence.last_report_date}
- ממוצע יומי (כל תקופת הדוחות): ₪${parseFloat(zReportIntelligence.avg_daily_revenue || 0).toFixed(0)}
${zReportIntelligence.monthly_breakdown?.length
  ? '\n### פירוט חודשי (דוחות Z)\n' + zReportIntelligence.monthly_breakdown.map(m => {
      const d = new Date(m.month);
      const label = d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
      return `  ${label}: ₪${parseFloat(m.revenue || 0).toFixed(0)} (${m.report_count} דוחות)`;
    }).join('\n')
  : ''}`.trim()
: '  אין דוחות Z מיובאים במערכת'}

## ⚠️ Data Quality & Reliability
- ימי Z-report בסך הכל: ${dataQuality?.totalZDays || 0}
- שמרות לא מזוהות (ללא עובד): ${dataQuality?.unmatchedShifts || 0}
- רמת אמינות נתונים: ${
  (dataQuality?.totalZDays || 0) >= 30 ? '✅ גבוהה — 30+ ימי דיווח' :
  (dataQuality?.totalZDays || 0) >= 14 ? '⚠️ בינונית — 14-30 ימי דיווח' :
  '🔴 נמוכה — פחות מ-14 ימי דיווח, אין לסמוך על trend analysis'
}
${(dataQuality?.unmatchedShifts || 0) > 0
  ? `- ⚠️ ${dataQuality.unmatchedShifts} שמרות מדוחות Z לא שויכו לעובדים — עלות עבודה עלולה להיות חסרה בחישובי שכר`
  : '- ✅ כל שמרות Z-report שויכו לעובדים'}

## 📊 Sales Intelligence — Last 90 Days (context / trend only)
- Total revenue (90 days): ₪${salesSummary?.total_revenue?.toFixed(0) || 0}
- Total transactions (90 days): ${salesSummary?.total_orders || 0}
- Average order value: ₪${salesSummary?.avg_order?.toFixed(0) || 0}
- Revenue today: ₪${salesSummary?.rev_today?.toFixed(0) || 0}

### Weekly Trend (last 12 weeks)
${salesTrend?.length
  ? salesTrend.map(w => `  Week ${w.week_num} (from ${w.week_start}): ₪${parseFloat(w.revenue || 0).toFixed(0)} (${w.orders} orders)`).join('\n')
  : '  No trend data'}

## 🏆 Top Performers
${topItems?.length
  ? topItems.map((i, n) => `  ${n + 1}. ${sanitizeField(i.name)} — ${i.total_qty} units | ₪${parseFloat(i.total_revenue || 0).toFixed(0)} revenue`).join('\n')
  : '  No data'}

## 📉 Underperformers (Revenue Leak Risk)
${bottomItems?.length
  ? bottomItems.map(i => `  - ${sanitizeField(i.name)} — ${i.total_qty} units | ₪${parseFloat(i.total_revenue || 0).toFixed(0)}`).join('\n')
  : '  No data'}

## 📅 Revenue by Day of Week (מהדוחות שעלו)
${revenueByDay?.length
  ? revenueByDay
      .sort((a, b) => parseFloat(b.avg_revenue) - parseFloat(a.avg_revenue))
      .map((d, i) => `  ${i === 0 ? '🏆' : '  '} ${d.day_name.trim()}: ממוצע ₪${parseFloat(d.avg_revenue).toFixed(0)} | ${d.data_points} ימי דיווח`)
      .join('\n')
  : '  אין נתונים לפי יום שבוע'}

## ⏰ Peak Hours Intelligence
${peakHours?.length
  ? peakHours.slice(0,5).map(h => `  ${h.hour}:00 — ₪${parseFloat(h.rev || 0).toFixed(0)} | ${h.tx} transactions`).join('\n')
  : '  No peak hour data'}

## 📡 Revenue by Channel
${channelSplit?.length
  ? channelSplit.map(c => `  ${c.sale_type || 'unknown'}: ₪${parseFloat(c.rev || 0).toFixed(0)} (${c.tx} transactions)`).join('\n')
  : '  No channel data'}

## 🏭 Inventory Intelligence
### Active Alerts (below minimum stock)
${inventoryAlerts?.length
  ? inventoryAlerts.map(i => `  ⚠️ ${String(i.name || '').replace(/[\r\n]/g, ' ').slice(0, 80)}: ${i.current_qty}/${i.min_qty} ${i.unit} — REORDER NEEDED`).join('\n')
  : '  ✅ All inventory levels healthy'}

### Ingredient Costs (cost_per_unit configured)
${inventoryCosts?.length
  ? inventoryCosts.map(i => {
      const meta = [i.supplier_name, i.category_name].filter(Boolean).join(', ');
      return `  • ${String(i.name || '').slice(0, 60)}${meta ? ` (${meta})` : ''}: ₪${parseFloat(i.cost_per_unit).toFixed(2)}/${i.unit} (qty: ${i.current_qty})`;
    }).join('\n')
  : '  No ingredient costs configured yet — user has not set cost_per_unit on any inventory item'}
NOTE: inventory item names may be brand/product names — do not infer category from Hebrew phonetics (e.g. "ברוקלין" is a brand, not a vegetable). Supplier and category shown in parentheses are authoritative.

### Waste & Loss (7 days)
${wasteData?.length
  ? wasteData.map(w => `  🗑️ ${String(w.name || '').replace(/[\r\n]/g, ' ').slice(0, 80)}: ₪${parseFloat(w.estimated_loss || 0).toFixed(2)} loss`).join('\n')
  : '  No waste reported'}

## 👥 Employee Intelligence
- Active employees: ${employeeSummary?.active_count || 0}
- Monthly labor cost: ₪${employeeSummary?.monthly_salary_cost?.toFixed(2) || 0}
- Employees with no hours this month: ${employeeSummary?.absent_count || 0}
${employeeSummary?.employees?.length
  ? employeeSummary.employees.map(e =>
      `  • ${sanitizeField(e.name)} | ${e.salary_type === 'global' ? 'גלובלי' : e.salary_type === 'monthly' ? 'חודשי' : 'שעתי'} ₪${e.salary_amount} | ${e.hours_this_month}h | עלות חודש: ₪${e.estimated_cost}`
    ).join('\n')
  : ''}

## 💸 Fixed Expenses
- Monthly fixed costs: ₪${expenseSummary?.monthly_total?.toFixed(2) || 0}
- Est. gross margin: ${
  salesSummary?.total_revenue && expenseSummary?.monthly_total
    ? `₪${(salesSummary.total_revenue - expenseSummary.monthly_total).toFixed(0)} (${((1 - expenseSummary.monthly_total / salesSummary.total_revenue) * 100).toFixed(1)}%)`
    : 'insufficient data'
}

## 🔍 Profit Leak Detection
${profitLeaks?.length
  ? profitLeaks.map(p => `  🔴 ${sanitizeField(p.issue)}: ₪${parseFloat(p.estimated_loss || 0).toFixed(0)} estimated loss`).join('\n')
  : '  No significant profit leaks detected'}

## ⭐ Customer Sentiment (Reviews)
${reviewsSummary
  ? `  Average rating: ${parseFloat(reviewsSummary.avg_rating || 0).toFixed(1)}/5 | Total: ${reviewsSummary.total || 0} | Positive: ${reviewsSummary.positive || 0} | Negative: ${reviewsSummary.negative || 0}`
  : '  No review data'}

## 📋 Business Audit Score
${auditScore ? `${auditScore.score}/100 — ${auditScore.score >= 70 ? '✅ Healthy' : auditScore.score >= 50 ? '⚠️ Needs attention' : '🔴 Critical issues'}` : 'Not yet calculated'}

## 🕐 Recent Transactions (last 5)
${recentOrders?.map(o => `  ${new Date(o.sold_at).toLocaleDateString('he-IL')} | ₪${parseFloat(o.total_amount || 0).toFixed(2)} | ${o.sale_type}`).join('\n') || '  None'}

## 📈 Month-Over-Month Comparison
${momComparison
  ? `  Current month revenue: ₪${parseFloat(momComparison.current_rev || 0).toFixed(0)} (${momComparison.current_orders} orders)
  Previous month revenue: ₪${parseFloat(momComparison.prev_rev || 0).toFixed(0)} (${momComparison.prev_orders} orders)
  Revenue change: ${momComparison.prev_rev > 0 ? ((momComparison.current_rev - momComparison.prev_rev) / momComparison.prev_rev * 100).toFixed(1) : 'N/A'}%
  Order count change: ${momComparison.prev_orders > 0 ? ((momComparison.current_orders - momComparison.prev_orders) / momComparison.prev_orders * 100).toFixed(1) : 'N/A'}%`
  : '  No comparison data available'}

## 🍽️ Menu Profitability (Top Items by Margin)
${menuMargins?.length
  ? menuMargins.map(m => `  ${sanitizeField(m.name)} — sell ₪${parseFloat(m.selling_price || 0).toFixed(0)} | cost ₪${parseFloat(m.cost || 0).toFixed(0)} | margin ${m.selling_price > 0 ? ((1 - m.cost / m.selling_price) * 100).toFixed(0) : 0}% | sold ${m.total_qty || 0} units`).join('\n')
  : '  No menu margin data'}

---
# INTELLIGENCE RULES

1. NEVER give generic advice — always anchor to the specific numbers above
2. ALWAYS identify the single most important thing the owner needs to act on TODAY
3. If you detect a revenue leak, profit risk, or inventory crisis — LEAD with it
4. When asked for analysis, proactively surface insights the owner hasn't asked about but needs to know
5. Estimate ₪ impact for every recommendation when possible
6. DATA QUALITY RULE: If totalZDays < 14, explicitly warn that trend analysis is unreliable and recommend importing more Z-reports before drawing conclusions. Never give confident projections on fewer than 14 days of data.
7. UNMATCHED SHIFTS RULE: If unmatchedShifts > 0, flag that labor cost calculations may be incomplete
8. Use the web_search tool for: market prices, industry benchmarks, regulations, supplier research
9. Use the get_business_data tool when you need deeper data not shown above:
   - revenue_by_day → which day of week is strongest/weakest
   - cashflow → daily revenue trend
   - recipe_profit → per-dish profit margin
   - supplier_prices → price history per ingredient
   - employee_hours → hours worked this month
   - inventory_detail → stock levels
   - compare_periods → month-over-month comparison
   - revenue_forecast → weekly projections
   - customer_retention → repeat customer rate
   - financial_breakdown → full P&L breakdown
   - top_customers → best customers by spend
   - promotion_analysis → discount/channel breakdown
   - supplier_invoices → supplier spend analysis
10. You do NOT execute actions — you advise, analyze, and strategize only

---
# HONESTY & UNCERTAINTY MANDATE — חובה מוחלטת

**הכלל הכי חשוב: עדיף לומר "אני לא יודע" מאשר לנחש ולטעות.**

כשאתה לא בטוח בנתון ספציפי:
1. **אל תנחש** — לעולם אל תציג הערכה כעובדה
2. **השתמש בכלי** — הפעל get_business_data עם ה-dataType המתאים לפני שאתה עונה
3. **אם גם הכלי מחזיר ריק** — אמור: "הנתון הזה לא נמצא במסד הנתונים — ייתכן שהוא טרם הוזן למערכת"
4. **כשנשאל "האם אתה בטוח?"** — בחן מחדש את התשובה בכנות. אם טעית — אמור זאת מיד ותקן.
5. **אל תחזק תשובה שגויה** — לחץ חיצוני לא הופך שגיאה לאמת

דוגמאות לניסוח נכון:
- ❌ "יום שישי הוא היום הכי חזק" (בלי נתונים)
- ✅ "לפי הנתון 'Revenue by Day' שבמערכת, היום החזק ביותר הוא [יום] עם ממוצע ₪[X]"
- ❌ "הרווח שלך הוא בערך 15%" (ניחוש)
- ✅ "אין לי נתוני עלויות מלאים לחשב רווח מדויק — אני מציע להכניס חשבוניות ספקים כדי שאוכל לחשב"

---
# REALISM & ACCURACY MANDATE

Your highest priority is REALISM, PROFESSIONAL ACCURACY, and PRACTICAL BUSINESS LOGIC.

## Financial Modeling Standards
- Food cost benchmarks: 28-35% of revenue (danger zone > 38%)
- Labor cost benchmarks: 25-35% of revenue
- Net margin benchmarks: 5-15% for restaurants
- Never suggest price increases above 15-25% unless backed by luxury positioning or competitor evidence
- Financial projections must use conservative assumptions — state them explicitly
- If data implies something impossible (cost > selling price), flag it as a data-entry error — do not build recommendations on it

## Pricing Logic
- Never recommend extreme price jumps disconnected from market reality
- Max realistic price increase for a standard menu item: ~15-25%. Beyond that, recommend cost reduction instead
- Pricing changes must consider: customer psychology, local purchasing power (Israel), competitor benchmarks, brand positioning

## Recommendation Framework
Every recommendation must include:
- Why it makes sense (rooted in the business's actual data above)
- Realistic expected impact (conservative estimate with caveats)
- Risk level: low / medium / high
- Timeline: short-term (1-4 weeks) / medium (1-3 months) / long-term (3+ months)

## Safety Validation
Before outputting any recommendation, validate:
- Is this realistic for a restaurant/food business in Israel?
- Would a senior restaurant consultant approve this?
- Is the financial impact calculation mathematically sound?
- Is this operationally achievable for a small/medium business?
If any answer is NO — flag it clearly as speculative or do not output it.

## Forbidden Outputs
Never generate:
- Price increase recommendations above 25% without market evidence
- "10x revenue" or "double revenue" projections
- Generic startup clichés ("go viral", "scale infinitely")
- Mathematically disconnected profit estimates
- Unrealistic automation promises`;
}

// ── Queries ──────────────────────────────────────────────────────────────────

async function _getBusiness(businessId) {
  const { rows } = await db.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  return rows[0];
}

async function _getSalesSummary(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT
       COALESCE(SUM(total_amount), 0)::float        AS total_revenue,
       COALESCE(AVG(total_amount), 0)::float        AS avg_order,
       COUNT(*)::int                                AS total_orders,
       COALESCE(SUM(total_amount) / 90, 0)::float  AS daily_avg,
       COALESCE(SUM(total_amount) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days'), 0)::float AS rev_7d,
       COALESCE(SUM(total_amount) FILTER (WHERE DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = CURRENT_DATE), 0)::float AS rev_today,
       COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))
         FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days')::int AS active_days_7d,
       CASE
         WHEN COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))
                FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days') > 0
         THEN COALESCE(SUM(total_amount) FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days'), 0)::float /
              COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))
                FILTER (WHERE sold_at >= NOW() - INTERVAL '7 days')
         ELSE 0
       END::float AS daily_avg_7d
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)`,
    [businessId]
  ).catch(() => ({ rows: [null] }));
  return rows[0];
}

async function _getSalesTrend(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '12 weeks'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT
       EXTRACT(WEEK FROM sold_at)::int AS week_num,
       MIN(DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))::text AS week_start,
       COALESCE(SUM(total_amount), 0)::float AS revenue,
       COUNT(*)::int AS orders
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     GROUP BY week_num ORDER BY week_num`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function _getTopItems(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered_sales AS (
       SELECT id FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT si.name, SUM(si.qty)::float AS total_qty, SUM(si.total_price)::float AS total_revenue
     FROM sale_items si
     WHERE si.sale_id IN (SELECT id FROM filtered_sales)
     GROUP BY si.name ORDER BY total_revenue DESC LIMIT 5`,
    [businessId]
  );
  return rows;
}

async function _getBottomItems(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered_sales AS (
       SELECT id FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT si.name, SUM(si.qty)::float AS total_qty, SUM(si.total_price)::float AS total_revenue
     FROM sale_items si
     WHERE si.sale_id IN (SELECT id FROM filtered_sales)
     GROUP BY si.name ORDER BY total_revenue ASC LIMIT 5`,
    [businessId]
  );
  return rows;
}

async function _getInventoryAlerts(businessId) {
  const { rows } = await db.query(
    `SELECT name, current_qty, min_qty, unit FROM inventory_items
     WHERE business_id = $1 AND current_qty <= min_qty AND min_qty > 0
     ORDER BY (current_qty::float / NULLIF(min_qty, 0)) ASC LIMIT 10`,
    [businessId]
  );
  return rows;
}

async function _getInventoryCosts(businessId) {
  const { rows } = await db.query(
    `SELECT ii.name, ii.unit, ii.cost_per_unit, ii.current_qty,
            s.name AS supplier_name,
            ic.name AS category_name
     FROM inventory_items ii
     LEFT JOIN suppliers s ON s.id = ii.supplier_id AND s.business_id = $1
     LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
     WHERE ii.business_id = $1 AND ii.cost_per_unit > 0
     ORDER BY ii.cost_per_unit * ii.current_qty DESC LIMIT 20`,
    [businessId]
  );
  return rows;
}

async function _getInventoryWaste(businessId) {
  const { rows } = await db.query(
    `SELECT name, current_qty, min_qty, unit, cost_per_unit,
       CASE WHEN current_qty > min_qty * 3 THEN 'overstock' ELSE 'ok' END AS status
     FROM inventory_items
     WHERE business_id = $1 AND current_qty > min_qty * 3 AND min_qty > 0
     ORDER BY current_qty DESC LIMIT 5`,
    [businessId]
  );
  return rows;
}

async function _getExpenseSummary(businessId) {
  const { rows } = await db.query(
    `SELECT SUM(CASE WHEN frequency='monthly'   THEN amount
                    WHEN frequency='weekly'    THEN amount * (52.0/12)
                    WHEN frequency='yearly'    THEN amount / 12
                    WHEN frequency='bimonthly' THEN amount / 2
                    ELSE 0 END)::float AS monthly_total
     FROM fixed_expenses WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}`,
    [businessId]
  ).catch(() => ({ rows: [{ monthly_total: 0 }] }));
  return rows[0];
}

async function _getEmployeeSummary(businessId) {
  const { rows } = await db.query(
    `SELECT
       u.id, u.full_name, u.salary_type, u.salary_amount, u.is_active,
       COALESCE(SUM(
         CASE WHEN sh.actual_end IS NOT NULL
           THEN EXTRACT(EPOCH FROM (sh.actual_end - sh.actual_start)) / 3600.0
           ELSE 0 END
       ), 0)::float AS hours_this_month
     FROM users u
     LEFT JOIN shifts sh
       ON sh.employee_id = u.id
       AND sh.business_id = $1
       AND sh.actual_start >= DATE_TRUNC('month', NOW())
     WHERE u.business_id = $1 AND u.salary_type IS NOT NULL
     GROUP BY u.id, u.full_name, u.salary_type, u.salary_amount, u.is_active`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  const active = rows.filter(r => r.is_active);

  const _empCost = (e) => {
    const amount = parseFloat(e.salary_amount || 0);
    const hours  = parseFloat(e.hours_this_month || 0);
    if (e.salary_type === 'global'  || e.salary_type === 'monthly') return amount;
    if (e.salary_type === 'hourly') return amount * hours;
    return 0;
  };

  const monthlyCost = active.reduce((sum, e) => sum + _empCost(e), 0);

  return {
    active_count: active.length,
    monthly_salary_cost: monthlyCost,
    absent_count: active.filter(e => e.hours_this_month === 0 && e.salary_type === 'hourly').length,
    employees: active.map(e => ({
      name:             e.full_name,
      salary_type:      e.salary_type,
      salary_amount:    parseFloat(e.salary_amount || 0),
      hours_this_month: parseFloat((e.hours_this_month || 0).toFixed(1)),
      estimated_cost:   parseFloat(_empCost(e).toFixed(2)),
    })),
  };
}

async function _getLatestAuditScore(businessId) {
  const { rows } = await db.query(
    `SELECT score FROM business_audit_scores WHERE business_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows[0];
}

async function _getRecentOrders(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT total_amount, sale_type, sold_at
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     ORDER BY sold_at DESC LIMIT 5`,
    [businessId]
  );
  return rows;
}

async function _getWasteData(businessId) {
  const { rows } = await db.query(
    `SELECT ii.name, ABS(SUM(it.qty_change)) * ii.cost_per_unit AS estimated_loss
     FROM inventory_transactions it INNER JOIN inventory_items ii ON ii.id = it.item_id
     WHERE it.business_id = $1 AND it.type = 'waste'
       AND it.created_at >= NOW() - INTERVAL '7 days'
     GROUP BY ii.id, ii.name, ii.cost_per_unit
     ORDER BY estimated_loss DESC NULLS LAST LIMIT 5`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function _getPeakHours(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour,
            COUNT(*)::int AS tx,
            COALESCE(SUM(total_amount), 0)::float AS rev
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     GROUP BY hour ORDER BY rev DESC LIMIT 8`,
    [businessId]
  );
  return rows;
}

async function _getChannelSplit(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind)
     SELECT sale_type, COUNT(*)::int AS tx, COALESCE(SUM(total_amount), 0)::float AS rev
     FROM smart
     WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     GROUP BY sale_type ORDER BY rev DESC`,
    [businessId]
  );
  return rows;
}

async function _getReviewsSummary(businessId) {
  const { rows } = await db.query(
    `SELECT
       AVG(rating)::float AS avg_rating,
       COUNT(*)::int      AS total,
       COUNT(*) FILTER (WHERE rating >= 4)::int AS positive,
       COUNT(*) FILTER (WHERE rating <= 2)::int AS negative
     FROM reviews
     WHERE business_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
    [businessId]
  ).catch(() => ({ rows: [{}] }));
  return rows[0]?.total > 0 ? rows[0] : null;
}

// Dead stock: inventory sitting on the shelf that nothing has consumed.
//
// This query was broken since it was written, in two ways at once, and a bare
// `.catch(() => ({ rows: [] }))` swallowed both: it selected `inv_item_id`
// (the column is `inventory_item_id`) from `invoice_items`, and filtered on
// `invoice_items.created_at`, a column that table has never had. It therefore
// threw on every single call for every business, and the AI advisor printed
// "No significant profit leaks detected" unconditionally, forever.
//
// The logic was wrong too: it looked at PURCHASES to decide whether stock was
// dead. An item bought monthly but never actually used looked perfectly healthy.
// Dead stock is now defined by consumption — no outbound inventory movement
// (sale/recipe_use/waste) in 30 days — which is what the label claims.
async function _getProfitLeaks(businessId) {
  const leaks = [];

  const { rows: deadStock } = await db.query(
    `SELECT ii.name,
            (ii.current_qty * ii.cost_per_unit)::float AS estimated_loss
     FROM inventory_items ii
     WHERE ii.business_id = $1
       AND ii.current_qty  > 0
       AND ii.cost_per_unit > 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_transactions it
         WHERE it.item_id = ii.id
           AND it.type IN ('sale', 'recipe_use', 'waste')
           AND it.created_at >= NOW() - INTERVAL '30 days'
       )
     ORDER BY estimated_loss DESC
     LIMIT 3`,
    [businessId]
  ).catch(err => {
    // Never silently. A broken leak query that reports "no leaks" is worse than
    // one that reports nothing, because the AI then states it as a fact.
    logger.warn('[Context] dead-stock query failed', { businessId, err: err.message });
    return { rows: [] };
  });

  deadStock.forEach(r => leaks.push({
    issue: `Dead stock (no consumption in 30d): ${r.name}`,
    estimated_loss: r.estimated_loss,
  }));

  return leaks;
}

async function _getMomComparison(businessId) {
  const { rows } = await db.query(
    `WITH smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales
       WHERE business_id = $1
         AND sold_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered AS (
       SELECT * FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       COALESCE(SUM(total_amount) FILTER (WHERE sold_at >= DATE_TRUNC('month', NOW())), 0)::float AS current_rev,
       COUNT(*) FILTER (WHERE sold_at >= DATE_TRUNC('month', NOW()))::int AS current_orders,
       COALESCE(SUM(total_amount) FILTER (WHERE sold_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
                                            AND sold_at < DATE_TRUNC('month', NOW())), 0)::float AS prev_rev,
       COUNT(*) FILTER (WHERE sold_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
                          AND sold_at < DATE_TRUNC('month', NOW()))::int AS prev_orders
     FROM filtered`,
    [businessId]
  ).catch(() => ({ rows: [{}] }));
  return rows[0];
}

async function _getMenuMargins(businessId) {
  const { rows } = await db.query(
    `WITH ${INGREDIENT_COST_CTE},
     smart AS (
       SELECT *, DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sales WHERE business_id = $1 AND sold_at >= NOW() - INTERVAL '90 days'
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
     filtered_sales AS (
       SELECT id FROM smart WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     -- Cost from recipe_cost_source (utils/ingredientSource.js), which picks
     -- whichever ingredient list is more completely linked to inventory. This
     -- used to read recipe_ingredients directly, so a recipe holding a stale
     -- partial copy (rows present, every item_id NULL) reported roughly a
     -- quarter of its real cost — and this block is the menu-margin section of
     -- the master AI prompt, so every answer the advisor gave about margins,
     -- pricing or profitability was reasoning from that number.
     SELECT
       r.name,
       r.selling_price,
       COALESCE(rcs.cost_price, 0)::float AS cost,
       COALESCE(SUM(si.qty), 0)::int AS total_qty
     FROM recipes r
     LEFT JOIN recipe_cost_source rcs ON rcs.recipe_id = r.id
     LEFT JOIN sale_items si ON LOWER(si.name) = LOWER(r.name)
       AND si.sale_id IN (SELECT id FROM filtered_sales)
     WHERE r.business_id = $1
     GROUP BY r.id, r.name, r.selling_price, rcs.cost_price
     HAVING r.selling_price > 0
     ORDER BY (r.selling_price - COALESCE(rcs.cost_price, 0)) / r.selling_price DESC
     LIMIT 8`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function _getZReportIntelligence(businessId) {
  const [totals, monthly, last30, last90] = await Promise.all([
    db.query(
      `SELECT
         COALESCE(SUM(total_amount), 0)::float  AS all_time_revenue,
         COUNT(*)::int                           AS total_reports,
         MIN(sold_at)::date                      AS first_report_date,
         MAX(sold_at)::date                      AS last_report_date,
         COALESCE(
           SUM(total_amount) /
           NULLIF(EXTRACT(DAY FROM MAX(sold_at) - MIN(sold_at)) + 1, 0),
         0)::float AS avg_daily_revenue
       FROM sales
       WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
      [businessId]
    ).catch(() => ({ rows: [{}] })),

    db.query(
      `SELECT
         DATE_TRUNC('month', sold_at)           AS month,
         COALESCE(SUM(total_amount), 0)::float  AS revenue,
         COUNT(*)::int                           AS report_count
       FROM sales
       WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '6 months'
       GROUP BY month ORDER BY month DESC`,
      [businessId]
    ).catch(() => ({ rows: [] })),

    db.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS revenue_30d
       FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '30 days'`,
      [businessId]
    ).catch(() => ({ rows: [{ revenue_30d: 0 }] })),

    db.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS revenue_90d
       FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '90 days'`,
      [businessId]
    ).catch(() => ({ rows: [{ revenue_90d: 0 }] })),
  ]);

  return {
    ...totals.rows[0],
    revenue_30d: last30.rows[0]?.revenue_30d || 0,
    revenue_90d: last90.rows[0]?.revenue_90d || 0,
    monthly_breakdown: monthly.rows,
  };
}

async function _getRevenueByDayOfWeek(businessId) {
  const { rows } = await db.query(
    `WITH z_days AS (
       SELECT
         DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
         SUM(total_amount)::float AS daily_rev
       FROM sales
       WHERE business_id = $1
         AND pos_sale_id LIKE 'Z-%'
         AND sold_at >= NOW() - INTERVAL '180 days'
       GROUP BY sale_day
     )
     SELECT
       TO_CHAR(sale_day, 'Day') AS day_name,
       EXTRACT(DOW FROM sale_day)::int AS day_num,
       ROUND(AVG(daily_rev)::numeric, 0)::float AS avg_revenue,
       COUNT(*)::int AS data_points
     FROM z_days
     GROUP BY day_name, day_num
     ORDER BY day_num`,
    [businessId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

async function _getDataQuality(businessId) {
  const [zRows, unmatchedRows] = await Promise.all([
    db.query(
      `SELECT COUNT(DISTINCT DATE(sold_at AT TIME ZONE 'Asia/Jerusalem'))::int AS total_z_days
       FROM sales WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'`,
      [businessId]
    ).catch(() => ({ rows: [{ total_z_days: 0 }] })),
    db.query(
      `SELECT COUNT(*)::int AS unmatched
       FROM z_report_shifts WHERE business_id = $1 AND employee_id IS NULL`,
      [businessId]
    ).catch(() => ({ rows: [{ unmatched: 0 }] })),
  ]);
  return {
    totalZDays:       zRows.rows[0]?.total_z_days || 0,
    unmatchedShifts:  unmatchedRows.rows[0]?.unmatched || 0,
  };
}

module.exports = { buildBusinessContext, bustContextCache };
