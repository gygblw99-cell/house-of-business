/**
 * Business Audit Agent
 * משתמש ב-Claude API לניתוח עסקי מעמיק
 * מחזיר: ניקוד (0-100) + בעיות + המלצות ספציפיות
 */

const Anthropic   = require('@anthropic-ai/sdk');
const db          = require('../utils/db');
const logger      = require('../utils/logger');
const { collectAuditData, hasEnoughData } = require('../services/audit/audit.data');
const { logTokenUsage }       = require('../utils/logTokenUsage');
const { verifyAuditResponse } = require('../utils/groundingVerifier');
const { createWithRetry } = require('../utils/anthropicRetry');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const { sanitizeField } = require('../utils/aiSanitize');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

db.migrate(`
  CREATE TABLE IF NOT EXISTS business_audit_scores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    score               SMALLINT NOT NULL,
    score_profitability SMALLINT,
    score_inventory     SMALLINT,
    score_employees     SMALLINT,
    score_avg_order     SMALLINT,
    issues              JSONB,
    recommendations     JSONB,
    is_manual_run       BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )
`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_audit_scores_business ON business_audit_scores(business_id, created_at DESC)`);

// ── משקלי הניקוד (לפי מסמך התכנון) ────────────────────────
const WEIGHTS = {
  profitability: 0.40,   // רווחיות — משקל הכי גבוה
  inventory:     0.30,   // ניהול מלאי (אפס בזבוז)
  employees:     0.20,   // עובדים
  avgOrder:      0.10,   // ממוצע הזמנה
};

// ── חישוב ניקוד לוקאלי (לפני Claude) ────────────────────────
function calculateScores(data) {
  // ניקוד רווחיות — לפי יחס הוצאות/הכנסות בפועל לתקופה המבוקשת.
  // monthly_fixed_expenses הוא נתון חודשי קבוע — יש לפרוס אותו לפי מספר
  // הימים בפועל בטווח הביקורת (periodDays), אחרת ביקורת על טווח קצר
  // מחודש (למשל שבוע) תשווה תמיד הוצאה של חודש שלם מול הכנסה של כמה
  // ימים בלבד ותחזיר כמעט תמיד 0, גם כשהעסק רווחי בפועל.
  const periodDays      = data.periodDays || 30;
  const totalRevenue    = data.salesStats.reduce((sum, r) => sum + (r.total_revenue || 0), 0);
  const monthlyExpenses = data.expenseStats?.monthly_fixed_expenses || 0;
  const hasExpenseData  = monthlyExpenses > 0;
  const proratedExpenses = monthlyExpenses * (periodDays / 30);
  const expenseRatio  = totalRevenue > 0 ? proratedExpenses / totalRevenue : 1;
  // Without expense data the ratio is 0→score 100, which is artificially perfect.
  // Use 50 (neutral/unknown) so the UI and Claude don't praise non-existent profitability.
  const profitScore   = !hasExpenseData
    ? 50
    : Math.max(0, Math.min(100, Math.round((1 - expenseRatio) * 100)));

  // ניקוד מלאי — בזבוז + חסר + מלאי מת + היעדר מעקב בזבוז
  const wasteCount     = data.inventoryWaste.length;
  const lowCount       = data.lowInventory.length;
  const deadStockCount = data.deadStock?.length || 0;
  const invStats       = data.inventoryStats || {};
  const hasInventoryData = (invStats.total_items || 0) > 0;

  // קנס מלאי מת: כל פריט ללא תנועה מוריד 8 נקודות (מקסימום 30)
  const deadStockPenalty = Math.min(30, deadStockCount * 8);

  // קנס היעדר מעקב בזבוז: 15 נקודות כשיש מלאי אבל אפס דיווחי בזבוז
  const wasteNotTracked  = hasInventoryData && invStats.waste_entries_30d === 0;
  const wastePenalty     = wasteNotTracked ? 15 : 0;

  // כשאין מלאי מוגדר כלל — ניטרלי (50), לא מושלם (100)
  const inventoryScore = !hasInventoryData
    ? 50
    : Math.max(0, Math.min(100,
        100 - wasteCount * 10 - lowCount * 5 - deadStockPenalty - wastePenalty
      ));

  // ניקוד עובדים — 4 פרמטרים
  // 1. היעדרויות (25%) | 2. עלות מול תועלת (40%) | 3. נוכחות בשיא (20%) | 4. השלמת משמרות (15%)
  const totalShifts = data.shiftStats?.total_shifts;
  let employeeScore;
  if (!totalShifts || totalShifts === 0) {
    employeeScore = 50; // no data — neutral
  } else {
    // 1. היעדרויות (25%) — 0% היעדרות=100, 50% היעדרות=0
    const absentRate = (data.shiftStats.absent_count || 0) / totalShifts;
    const absenceScore = Math.max(0, 100 - absentRate * 200);

    // 2. עלות מול תועלת (40%) — עלות עובדים % מהכנסות
    // benchmark ישראלי: ≤20%=מצוין, 28%=סביר, ≥40%=גרוע
    let laborScore = 50; // neutral if no labor cost data
    const lcp = data.laborCostPct;
    if (lcp !== null && lcp !== undefined) {
      if (lcp <= 20)      laborScore = 100;
      else if (lcp <= 28) laborScore = Math.round(100 - (lcp - 20) * 5);  // 100→60
      else if (lcp <= 40) laborScore = Math.round(60  - (lcp - 28) * 5);  // 60→0
      else                laborScore = 0;
      laborScore = Math.max(0, Math.min(100, laborScore));
    }

    // 3. נוכחות בימי שיא (20%) — האם העובדים נמצאים כשהמסעדה עמוסה?
    let peakScore = 50; // neutral if no pos sales data for peak calc
    const peakTotal = data.shiftStats.peak_total_shifts || 0;
    if (peakTotal > 0) {
      const peakPresent = peakTotal - (data.shiftStats.peak_absent_shifts || 0);
      peakScore = Math.round((peakPresent / peakTotal) * 100);
    }

    // 4. השלמת משמרות (15%) — % משמרות שהסתיימו כרגיל (לא נגמרו בפתאומיות)
    let completionScore = 50; // neutral if no data
    const nonAbsent = data.shiftStats.non_absent_shifts || 0;
    if (nonAbsent > 0) {
      completionScore = Math.round(((data.shiftStats.completed_shifts || 0) / nonAbsent) * 100);
    }

    employeeScore = Math.round(
      absenceScore    * 0.25 +
      laborScore      * 0.40 +
      peakScore       * 0.20 +
      completionScore * 0.15
    );
  }

  // ניקוד ממוצע הזמנה — טווח ±20 ₪ מהממוצע ההיסטורי
  // baseline_avg = ממוצע היסטורי (כל הזמן) — הבסיס האמיתי
  // ציון 100 = שווה לבסיס ומעלה | ציון 0 = 20 ₪ מתחת לבסיס ומטה
  const AVG_ORDER_RANGE = 20; // ₪ — טווח מלא מ-0 ל-100
  const currentAvg    = data.avgOrderValue?.current_avg || 0;
  const baselineAvg   = data.avgOrderValue?.baseline_avg || currentAvg;
  const avgOrderScore = baselineAvg > 0
    ? Math.max(0, Math.min(100, Math.round(((currentAvg - (baselineAvg - AVG_ORDER_RANGE)) / AVG_ORDER_RANGE) * 100)))
    : 50;

  const totalScore = Math.round(
    profitScore   * WEIGHTS.profitability +
    inventoryScore * WEIGHTS.inventory +
    employeeScore  * WEIGHTS.employees +
    avgOrderScore  * WEIGHTS.avgOrder
  );

  return {
    total:          totalScore,
    profitability:  profitScore,
    inventory:      inventoryScore,
    employees:      employeeScore,
    avgOrder:       avgOrderScore,
    hasExpenseData,
  };
}

// ── Static system prompt (cached) ────────────────────────────
const AUDIT_SYSTEM_PROMPT = `אתה יועץ עסקי מומחה לעסקים קטנים בישראל. נתח את הנתונים שבהודעת המשתמש וספק ניתוח מעמיק.

החזר JSON בלבד בפורמט הבא:

\`\`\`json
{
  "issues": [
    {
      "type": "profitability|inventory|employees|avg_order",
      "severity": "high|medium|low",
      "title": "כותרת קצרה בעברית",
      "description": "תיאור ספציפי עם מספרים"
    }
  ],
  "recommendations": [
    {
      "priority": 1,
      "type": "profitability|inventory|employees|avg_order",
      "action": "פעולה ספציפית שבעל העסק יכול לבצע מחר בבוקר",
      "impact": "השפעה כספית צפויה — לדוגמה: +₪1,200 בחודש"
    }
  ]
}
\`\`\`

כתוב בעברית תקנית, ברורה ופשוטה. היה ספציפי עם מספרים. אל תמציא נתונים שלא קיימים בנתונים שסיפקתי.

## כללי שפה עברית — חובה מוחלטת
- כתוב עברית יומיומית תקנית כפי שדוברת בישראל — אל תמציא מילים
- "בירה" (לא "ביר"), "קפה" (לא "קפ"), "שנתיים" (לא "שני שנים")
- פעלים מותרים להמלצה: "הצע", "צור", "הפעל", "הוסף", "שנה", "הפחת", "בדוק", "הכנס"
- אסור: "החק", "לאיברו", "ויהלכו", "דלק ערך" — מילים שאינן קיימות בעברית
- אם אינך בטוח שמילה קיימת בעברית — החלף אותה במילה פשוטה יותר שאתה בטוח בה
- כותרת (title) = עד 6 מילים, בעברית פשוטה וברורה
- action = משפט אחד פעולתי, ישיר, ללא תחביר מסורבל

## חוק מספרים ריאליים — חובה מוחלטת
- **אסור להניח מספר לקוחות** — השתמש אך ורק בנתוני עסקאות שסופקו
- אם סופק "ממוצע X עסקאות ביום" — זה הבסיס לכל חישוב, אין לסטות ממנו
- אחוז שיפור ריאלי מהמלצה אחת: 5%-20% מהכנסה קיימת (לא 200%-300%)
- השפעה כספית: כתוב טווח (לדוגמה: ₪500–₪1,500 בחודש) ולא מספר מדויק בודד
- אסור לכתוב "₪100,000 בחודש" לעסק שהכנסתו ₪50,000 בחודש

## הגדרת מדדים — חובה לקרוא
- **ממוצע הזמנה לסועד** = הסכום הממוצע שסועד בודד משלם בביקור אחד (לא סכום יומי, לא סכום שולחן)
- אם מסופק "ממוצע הזמנה לסועד: ₪X" — כל ספים, בונוסים ומינימומי הזמנה חייבים להיות ב-1.5×–5× של X
- אסור בתכלית לציין מספרים כמו ₪10,000 / ₪15,000 / ₪18,000 כ"ממוצע הזמנה" — אלה הם סכומי יומיים של עסק שלם, לא הזמנה של סועד בודד

## חוק ריאליות חובה
כל המלצה חייבת לעמוד בכל הקריטריונים הבאים לפני שתכתוב אותה:
- ריאלי לעסק מסעדנות קטן-בינוני בישראל? (כן/לא)
- יועץ מסעדות בכיר היה מסכים? (כן/לא)
- החישוב הכספי מדויק מתמטית? (כן/לא)
- ניתן ליישום תפעולי? (כן/לא)
אם כל התשובות אינן "כן" — אל תכלול את ההמלצה.

## חוק סף כספי — חובה מוחלטת
כל סף כספי שתציין (בונוס, הנחה, מינימום הזמנה, מבצע) חייב להיות מחושב ישירות מממוצע הזמנה לסועד שסיפקתי:
- סף מינימלי ריאלי: 1.5× ממוצע הזמנה לסועד
- סף מקסימלי ריאלי: 5× ממוצע הזמנה לסועד
- אם ממוצע הזמנה לסועד הוא ₪70 — הסף הריאלי הוא ₪105–₪350. סף של ₪500+ הוא בלתי ריאלי ואסור לציינו.
- אין להמציא מספרים עגולים גדולים (₪1,000 / ₪5,000 / ₪10,000) — הם אינם מבוססים על נתוני העסק.

## בנצ'מרק ריאלי ישראלי
- עלות מזון: 28-35% מההכנסות (אזור סכנה: >38%)
- עלות עבודה: 25-35% מההכנסות
- שכ"ד: 5-10% מההכנסות
- רווח נקי: 5-15% מההכנסות
- העלאת מחיר ריאלית מקסימלית: 15-25% (מעבר לכך — המלץ להוריד עלויות, לא להעלות מחיר)

## חוק מלאי מת
- מלאי מת = פריט עם כמות > 0 שלא זזה 30+ יום
- כל פריט מלאי מת = הון תקוע + סיכון קלקול
- אם יש 3+ פריטי מלאי מת — זו בעיה ב-severity "medium" לפחות
- אם ערך מלאי מת > 20% מהכנסות חודשיות — severity "high"
- אם לא דווח אף בזבוז אבל יש מלאי — ציין שהמעקב לא פעיל ומומלץ להתחיל לרשום בזבוז`;

// ── ה-Agent הראשי ─────────────────────────────────────────────
async function runAudit(businessId, { isManual = false, fromDate, toDate } = {}) {
  // בדיקת נתונים מינימליים
  const enoughData = await hasEnoughData(businessId).catch(() => false);
  if (!enoughData) {
    return {
      hasData:  false,
      message:  'המערכת זקוקה לשבוע נתונים לפחות לפני שניתן להריץ ביקורת עסקית',
    };
  }

  // איסוף נתונים
  const data   = await collectAuditData(businessId, { fromDate, toDate });
  const scores = calculateScores(data);

  // שליחה ל-Claude לניתוח עמוק
  const { issues, recommendations } = await _analyzeWithClaude(data, scores, businessId);

  // שמירה ב-DB — תמיד טווח התאריכים שבאמת חושב (data.fromDateStr/toDateStr),
  // כולל כשה-caller לא סיפק fromDate/toDate מפורשים (למשל הרצה מתוזמנת) —
  // אחרת ריצות אוטומטיות (הרוב) נשמרות עם from_date/to_date ריקים לצמיתות.
  const fromDateVal = data.fromDateStr || null;
  const toDateVal   = data.toDateStr   || null;

  const { rows } = await db.query(
    `INSERT INTO business_audit_scores
       (business_id, score, score_profitability, score_inventory,
        score_employees, score_avg_order, issues, recommendations, is_manual_run, from_date, to_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, created_at`,
    [
      businessId,
      scores.total,
      scores.profitability,
      scores.inventory,
      scores.employees,
      scores.avgOrder,
      JSON.stringify(issues),
      JSON.stringify(recommendations),
      isManual,
      fromDateVal,
      toDateVal,
    ]
  );

  return {
    hasData:   true,
    id:        rows[0].id,
    scores,
    issues,
    recommendations,
    createdAt: rows[0].created_at,
    fromDate:  fromDateVal,
    toDate:    toDateVal,
  };
}

// ── ניתוח עם Claude ──────────────────────────────────────────
async function _analyzeWithClaude(data, scores, businessId) {
  const prompt = _buildPrompt(data, scores);

  const response = await createWithRetry(client, {
    model:      'claude-haiku-4-5',
    max_tokens: 2000,
    // cache_control is set but is currently INERT for this call: Claude Haiku's
    // minimum cacheable prefix (~4096 tokens, verified empirically 2026-09) is
    // larger than this ~2000-token system prompt, so nothing is cached. It is
    // left in place so caching engages automatically if the prompt ever grows
    // past the threshold. Deliberately NOT padding the prompt to reach it —
    // audits are sparse/on-demand, so the cache would rarely be hit and the
    // extra tokens would cost more than they save.
    system: [{ type: 'text', text: AUDIT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }, { context: { agent: 'businessAudit', businessId } });

  logTokenUsage({ businessId, feature: 'business_audit', model: 'claude-haiku-4-5', usage: response.usage });

  try {
    const parsed = parseClaudeJSON(response, { agent: 'businessAudit', businessId });
    if (!parsed) return _fallbackAnalysis(data);

    // ── Detection layer: strip ungrounded claims ──────────────
    // Pass benchmark avg so verifier can apply proportionality guard even when real avg = 0
    const bm = _getBenchmarks(data.businessType);
    const dataForVerifier = { ...data, benchmarkAvgOrder: bm.avgOrderILS };
    const { issues, recommendations, stripped } =
      verifyAuditResponse(
        { issues: parsed.issues || [], recommendations: parsed.recommendations || [] },
        dataForVerifier,
      );

    if (stripped > 0) {
      logger.warn('[businessAudit] grounding verifier stripped unverifiable claims', { stripped });
    }

    return { issues, recommendations };
  } catch {
    // fallback — ניתוח בסיסי בלי Claude
    return _fallbackAnalysis(data);
  }
}

// ── Benchmark data by business type (Israeli industry averages) ───────────────
const INDUSTRY_BENCHMARKS = {
  'מסעדה':          { foodCostPct: 30, laborPctRevenue: 28, avgOrderILS: 120, wasteTarget: 3  },
  'קפה / בית קפה': { foodCostPct: 28, laborPctRevenue: 30, avgOrderILS: 55,  wasteTarget: 4  },
  'מזון מהיר':      { foodCostPct: 25, laborPctRevenue: 25, avgOrderILS: 45,  wasteTarget: 2  },
  'מאפייה':         { foodCostPct: 32, laborPctRevenue: 26, avgOrderILS: 35,  wasteTarget: 5  },
  'בר':             { foodCostPct: 22, laborPctRevenue: 32, avgOrderILS: 90,  wasteTarget: 3  },
  default:          { foodCostPct: 30, laborPctRevenue: 28, avgOrderILS: 80,  wasteTarget: 4  },
};

function _getBenchmarks(businessType) {
  return INDUSTRY_BENCHMARKS[businessType] || INDUSTRY_BENCHMARKS.default;
}

// ── בניית Prompt ─────────────────────────────────────────────
function _buildPrompt(data, scores) {
  const bm = _getBenchmarks(data.businessType);

  const realAvg      = data.avgOrderValue?.current_avg  || 0;
  const baselineAvg  = data.avgOrderValue?.baseline_avg || 0;
  // effectiveAvg: תקופה נבחרת; אם אין — ממוצע היסטורי; אם אין — benchmark ענף
  const effectiveAvg = realAvg > 0 ? realAvg : (baselineAvg > 0 ? baselineAvg : bm.avgOrderILS);
  const effectiveBaseline = baselineAvg > 0 ? baselineAvg : bm.avgOrderILS;
  const isEstimated  = realAvg <= 0 && baselineAvg <= 0;

  // חישוב נפח עסקאות אמיתי
  const distinctDays   = new Set(data.salesStats.map(r => r.sale_date)).size || 1;
  const totalSales     = data.salesStats.reduce((s, r) => s + (r.total_sales || 1), 0);
  const avgDailySales  = Math.round(totalSales / distinctDays);
  const totalRevenue30 = data.salesStats.reduce((s, r) => s + (r.total_revenue || 0), 0);
  const avgDailyRevenue = Math.round(totalRevenue30 / distinctDays);

  return `## נתוני העסק (30 יום אחרונים)

**ניקוד ראשוני:**
- רווחיות: ${scores.profitability}/100${!scores.hasExpenseData ? ' (ניטרלי — הוצאות קבועות לא הוזנו)' : ''}
- ניהול מלאי: ${scores.inventory}/100
- עובדים: ${scores.employees}/100
- ממוצע הזמנה לסועד: ${scores.avgOrder}/100
- ניקוד כולל: ${scores.total}/100

**מכירות:**
- ממוצע עסקאות ביום: ${avgDailySales} (זהו המספר הריאלי — אין לחרוג ממנו בחישובים)
- הכנסה יומית ממוצעת: ₪${avgDailyRevenue.toLocaleString('he-IL')}
- הכנסה חודשית כוללת: ₪${Math.round(totalRevenue30).toLocaleString('he-IL')}
- ממוצע הזמנה לסועד (תקופה נבחרת)${isEstimated ? ' (הערכה לפי ממוצע ענף)' : ''}: ₪${effectiveAvg.toFixed(2)}
- ממוצע היסטורי (כל הזמן — הבסיס): ₪${effectiveBaseline.toFixed(2)}
- סטייה מהבסיס: ${effectiveBaseline > 0 ? ((effectiveAvg - effectiveBaseline) >= 0 ? '+' : '') + (effectiveAvg - effectiveBaseline).toFixed(2) + ' ₪ (' + ((effectiveAvg / effectiveBaseline - 1) * 100).toFixed(1) + '%)' : '—'}
- ⚠️ כל סף בונוס/הנחה/מבצע שתציין חייב להיות בין ₪${(effectiveAvg * 1.5).toFixed(0)} ל-₪${(effectiveAvg * 5).toFixed(0)} (1.5×–5× ממוצע הזמנה לסועד). אין לחרוג מהגבולות האלה.
- ⚠️ כל חישוב השפעה חייב להתבסס על ${avgDailySales} עסקאות ביום בלבד — אסור להניח מספר גבוה יותר.

**מנות חלשות (לא נמכרו 7+ ימים):**
${data.weakItems.map(i => {
  const daysSince = i.last_sold_at ? Math.round((Date.now() - new Date(i.last_sold_at)) / 86400000) : null;
  return `- ${sanitizeField(i.name)}: ${daysSince !== null ? `${daysSince} ימים ללא מכירה` : 'מעולם לא נמכרה בתקופה זו'}`;
}).join('\n') || '- אין'}

**שעות חלשות:**
${data.weakHours.map(h => `- שעה ${h.hour}:00 — ירידה של ${h.drop_pct}% מהממוצע`).join('\n') || '- אין'}

**בזבוז מלאי (דווח ידנית):**
${data.inventoryWaste.map(w => `- ${sanitizeField(w.name)}: ${w.wasted_qty} ${w.unit} (הפסד: ₪${w.estimated_loss?.toFixed(2) || '?'})`).join('\n') || '- אין דיווחי בזבוז בתקופה'}
${(data.inventoryStats?.total_items > 0 && data.inventoryStats?.waste_entries_30d === 0) ? '⚠️ יש מלאי במערכת אך לא דווח אף בזבוז — ייתכן שהמעקב לא פעיל' : ''}

**מלאי חסר (מתחת לסף מינימום):**
${data.lowInventory.map(i => `- ${sanitizeField(i.name)}: ${i.current_qty}/${i.min_qty} ${i.unit}`).join('\n') || '- אין'}

**מלאי מת (ללא תנועה 30+ יום):**
${data.deadStock?.length > 0
  ? data.deadStock.map(d => {
      const daysSince = d.last_movement
        ? Math.round((Date.now() - new Date(d.last_movement)) / 86400000)
        : null;
      const val = d.estimated_value > 0 ? ` — ערך משוער: ₪${d.estimated_value.toFixed(0)}` : '';
      const age  = daysSince ? ` (${daysSince} ימים ללא תנועה)` : ' (אף פעם לא נרשמה תנועה)';
      return `- ${sanitizeField(d.name)}: ${d.current_qty} ${d.unit}${age}${val}`;
    }).join('\n')
  : '- אין'}
${data.inventoryStats ? `
**סיכום מלאי:**
- סה"כ פריטים: ${data.inventoryStats.total_items} (${data.inventoryStats.items_with_stock} עם כמות > 0)
- ערך מלאי כולל: ₪${data.inventoryStats.total_stock_value?.toFixed(0) || 0}
- פריטים פעילים ב-30 יום: ${data.inventoryStats.active_items_30d} מתוך ${data.inventoryStats.items_with_stock}
- דיווחי בזבוז ב-30 יום: ${data.inventoryStats.waste_entries_30d}` : ''}

**עובדים:**
- היעדרויות: ${data.shiftStats?.absent_count || 0} מתוך ${data.shiftStats?.total_shifts || 0} משמרות
- עלות עובדים מההכנסות: ${data.laborCostPct !== null && data.laborCostPct !== undefined ? data.laborCostPct.toFixed(1) + '%' : 'לא ידוע'} (benchmark ישראלי: 25–35%)
- נוכחות בימי שיא: ${(() => { const t = data.shiftStats?.peak_total_shifts || 0; if (!t) return 'אין נתוני POS'; const p = t - (data.shiftStats?.peak_absent_shifts || 0); return `${p}/${t} משמרות (${Math.round(p/t*100)}%)`; })()}
- השלמת משמרות: ${(() => { const n = data.shiftStats?.non_absent_shifts || 0; if (!n) return 'אין נתונים'; const c = data.shiftStats?.completed_shifts || 0; return `${c}/${n} (${Math.round(c/n*100)}%)`; })()}

**הוצאות קבועות חודשיות:** ${(data.expenseStats?.monthly_fixed_expenses || 0) > 0
  ? `₪${data.expenseStats.monthly_fixed_expenses.toFixed(2)}`
  : '⚠️ לא הוזנו — יש להזין שכ"ד, חשמל, ביטוח וכו\' לקבלת ניקוד רווחיות מדויק'}

**איכות נתונים:**
- ימי דוח Z שיובאו: ${data.totalZDays || 0}
${data.totalZDays < 14 ? '- ⚠️ פחות מ-14 ימי נתונים — הניתוח מוגבל, המלץ על שיפורים זהירים בלבד' : '- ✅ מספיק נתונים לניתוח אמין'}
- כיסוי פירוט מנות בדוחות התקופה: ${data.itemDataCoveragePct ?? 0}%${data.menuFoodCostPct === null ? ' — לא מספיק כדי לחשב עלות מזון אמינה לתקופה זו, אל תמציא ערך' : ' — עלות מזון % למטה מחושבת ממה שבאמת נמכר בתקופה הזו (מנות/מתכונים ועלויות מרכיבים עדכניות)'}

${data.cogsGapVsTheoretical !== null ? `**פער בין רכש בפועל לצריכה תיאורטית:**
- נרכש בפועל (חשבוניות ספק בתקופה): ₪${data.invoiceCogs.toFixed(0)}
- היה אמור להיצרך לפי המנות שנמכרו בפועל: ₪${data.theoreticalFoodCostValue.toFixed(0)}
- פער: ₪${Math.abs(data.cogsGapVsTheoretical).toFixed(0)} ${data.cogsGapVsTheoretical > 0 ? '(נרכש יותר ממה שנצרך תיאורטית — יתכן בזבוז, גניבה, מלאי עודף, או מתכונים לא מעודכנים)' : '(נצרך תיאורטית יותר ממה שנרכש בתקופה — יתכן שהמלאי נרכש קודם לכן)'}
זהו ממצא אמיתי מבוסס נתונים — אם הפער משמעותי (מעל ~15% מהרכש), ציין אותו כאתגר/המלצה קונקרטית.` : ''}

---

## Benchmark — הערכה כללית ארצית לענף (${data.businessType || 'עסק כללי'})
⚠️ המספרים בטבלה הזו הם ממוצע ארצי גס לפי סוג עסק בלבד — הם **לא** מותאמים לעיר/שכונה, רמת מחירים, או מיקום ספציפי של העסק. אסור להציג אותם כעובדה מדויקת — תמיד נסח את ההשוואה כ"הערכה כללית" או "בנצ'מרק ארצי", לא כ"הממוצע שלך".
| מדד | העסק שלך | הערכה ארצית כללית | הפרש |
|-----|----------|-----------|------|
| עלות מזון % | ${data.menuFoodCostPct ? data.menuFoodCostPct.toFixed(1)+'%' : 'לא ידוע'} | ${bm.foodCostPct}% | ${data.menuFoodCostPct ? (data.menuFoodCostPct - bm.foodCostPct > 0 ? '+' : '') + (data.menuFoodCostPct - bm.foodCostPct).toFixed(1)+'%' : '—'} |
| עלות עובדים % מהכנסות | ${data.laborCostPct !== null ? data.laborCostPct.toFixed(1)+'%' : 'לא ידוע'} | ${bm.laborPctRevenue}% | ${data.laborCostPct !== null ? (data.laborCostPct - bm.laborPctRevenue > 0 ? '+' : '') + (data.laborCostPct - bm.laborPctRevenue).toFixed(1)+'%' : '—'} |
${(() => {
  if (isEstimated) return `| ממוצע הזמנה לסועד | ~₪${bm.avgOrderILS} (הערכה) | ₪${effectiveBaseline.toFixed(0)} (בסיס היסטורי) | — |`;
  const diffFromBaseline = realAvg - effectiveBaseline;
  return `| ממוצע הזמנה לסועד (תקופה) | ₪${realAvg.toFixed(0)} | ₪${effectiveBaseline.toFixed(0)} (בסיס היסטורי) | ${(diffFromBaseline > 0 ? '+' : '')}₪${diffFromBaseline.toFixed(0)} |`;
})()}
| יעד פסולת % | — | ${bm.wasteTarget}% | — |

השתמש בנתוני ההערכה הארצית כדי לספק כיוון כללי בלבד. ציין היכן העסק נראה טוב/פחות טוב ביחס להערכה הזו, אבל הדגש בבירור שזו נקודת ייחוס גסה ולא מדד מדויק לעסק הספציפי הזה.

## חוק איכות נתונים
${(data.totalZDays || 0) < 14
  ? `⚠️ יש פחות מ-14 ימי דיווח. אל תיתן המלצות מבוססות trend — ציין מפורשות שהנתונים אינם מספיקים לניתוח מלא ובקש להמשיך לדווח דוחות Z.`
  : `✅ ${data.totalZDays} ימי נתונים — ניתוח אמין.`}`;
}

// ── fallback ללא Claude ───────────────────────────────────────
function _fallbackAnalysis(data) {
  const issues = [];
  const recommendations = [];

  if (data.weakItems.length > 0) {
    issues.push({
      type:        'profitability',
      severity:    'medium',
      title:       'מנות שלא נמכרות',
      description: `${data.weakItems.length} מנות לא נמכרו ב-7 ימים האחרונים`,
    });
    recommendations.push({
      priority: 1,
      type:     'profitability',
      action:   `שקול להסיר מהתפריט: ${data.weakItems.slice(0, 3).map(i => i.name).join(', ')}`,
      impact:   'חיסכון בעלויות מלאי',
    });
  }

  if (data.inventoryWaste.length > 0) {
    const totalLoss = data.inventoryWaste.reduce((s, w) => s + (w.estimated_loss || 0), 0);
    issues.push({
      type:        'inventory',
      severity:    'high',
      title:       'בזבוז מלאי גבוה',
      description: `הפסד של ₪${totalLoss.toFixed(2)} מבזבוז מלאי החודש`,
    });
  }

  if (data.lowInventory.length > 0) {
    issues.push({
      type:        'inventory',
      severity:    'high',
      title:       'מלאי חסר',
      description: `${data.lowInventory.length} פריטים מתחת לסף המינימום`,
    });
  }

  if (data.deadStock?.length > 0) {
    const deadValue = data.deadStock.reduce((s, d) => s + (d.estimated_value || 0), 0);
    issues.push({
      type:        'inventory',
      severity:    data.deadStock.length >= 5 ? 'high' : 'medium',
      title:       'מלאי מת — הון תקוע',
      description: `${data.deadStock.length} פריטים ללא תנועה ב-30 יום${deadValue > 0 ? ` — ערך משוער: ₪${deadValue.toFixed(0)}` : ''}`,
    });
    recommendations.push({
      priority: 2,
      type:     'inventory',
      action:   `בדוק ומכור / צמצם: ${data.deadStock.slice(0, 3).map(d => d.name).join(', ')}`,
      impact:   deadValue > 0 ? `שחרור הון של ₪${deadValue.toFixed(0)}` : 'צמצום הון תקוע',
    });
  }

  const invStats = data.inventoryStats;
  if (invStats?.total_items > 0 && invStats?.waste_entries_30d === 0) {
    issues.push({
      type:        'inventory',
      severity:    'low',
      title:       'מעקב בזבוז לא פעיל',
      description: 'יש מלאי במערכת אך לא דווח אף בזבוז — עשוי להסתיר הפסדים',
    });
  }

  return { issues, recommendations };
}

module.exports = { runAudit, calculateScores };
