/**
 * Ingredient-Level Profit Leakage Detection Agent
 *
 * Algorithm:
 *  Step 1: Expected usage  = SUM(qty_sold × qty_per_recipe) per ingredient
 *  Step 2: Actual usage    = opening_stock + purchases − closing_stock
 *  Step 3: Variance        = actual − expected
 *  Step 4: Loss ₪          = max(0, variance) × cost_per_unit
 *  Step 5: Severity        = OK (<5%) | Warning (5-15%) | Critical (>15%)
 *  Step 6: Root cause      = rule-based logic per ingredient category
 *  Step 7: Leak score      = total_loss / total_food_cost
 *
 * + Full Hebrew AI explanation engine (no LLM required — rule-based)
 */

const db = require('../utils/db');
const { INGREDIENT_SOURCE_CTE } = require('../utils/ingredientSource');

// ── Ingredient category patterns ─────────────────────────────────────────────
const CATEGORY_PATTERNS = {
  oil:       /שמן|חמאה|מרגרינה|שומן/i,
  meat:      /עוף|בשר|סטייק|כבד|נקניק|קבב|המבורגר|דג|סלמון|טונה|שניצל|פרגית|אסאדו|אנטריקוט/i,
  dairy:     /גבינה|שמנת|יוגורט|חלב|קוטג|לבנה|ריקוטה|מוצרלה|פרמזן/i,
  produce:   /עגבניה|חסה|מלפפון|בצל|שום|פלפל|גזר|תפוח|עשב|כוסברה|פטרוזיליה|רוקט|תרד|ברוקולי|כרוב/i,
  grain:     /לחם|קמח|אורז|פסטה|קינואה|בורגול|עדשים|חומוס|שעועית|טורטיה|פיתה/i,
  beverage:  /קפה|תה|מיץ|לימון|סוכר|סירופ|שוקו|קקאו/i,
  spice:     /מלח|פלפל שחור|כמון|פפריקה|כורכום|קינמון|הל|זעתר|בהרט/i,
  egg:       /ביצה|ביצים/i,
  alcohol:   /יין|בירה|וודקה|רום|ויסקי|קוניאק|ליקר|אלכוהול/i,
};

function getCategory(name) {
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(name)) return cat;
  }
  return 'other';
}

// ── Hebrew AI Explanation Engine ─────────────────────────────────────────────
function generateHebrewExplanation({ ingredient, unit, expectedQty, actualQty, variance, variancePct, lossValue, severity, costPerUnit, wasteQty = 0, wasteValue = 0 }) {
  // variancePct is a ratio (0.15 = 15%) — multiply by 1000/10 to get one-decimal %
  const pct = Math.round(variancePct * 1000) / 10;
  const category = getCategory(ingredient);
  const lossFormatted = lossValue.toFixed(2);
  const varianceFormatted = Math.abs(variance).toFixed(1);

  // ── מה קרה ──────────────────────────────────────────────────────
  let whatHappened = '';
  if (severity === 'critical') {
    whatHappened = `יש חריגה חמורה של ${pct}% בצריכת ${ingredient}. השתמשת ב-${actualQty.toFixed(1)} ${unit} בפועל, לעומת ${expectedQty.toFixed(1)} ${unit} שהמערכת ציפתה לפי המכירות — פער של ${varianceFormatted} ${unit}.`;
  } else {
    whatHappened = `יש חריגה של ${pct}% בצריכת ${ingredient}. השתמשת ב-${actualQty.toFixed(1)} ${unit} בפועל לעומת ${expectedQty.toFixed(1)} ${unit} צפויים — פער של ${varianceFormatted} ${unit}.`;
  }

  // ── כמה כסף זה עולה ──────────────────────────────────────────────
  let moneyImpact = '';
  if (lossValue >= 100) {
    moneyImpact = `המשמעות היא הפסד של ₪${lossFormatted} רק על חומר גלם זה בתקופה הנבדקת. זה סכום משמעותי שדורש טיפול מיידי.`;
  } else if (lossValue >= 20) {
    moneyImpact = `המשמעות היא הפסד של כ-₪${lossFormatted} על חומר גלם זה. לאורך חודש, זה יכול להצטבר לסכום ניכר.`;
  } else {
    moneyImpact = `ההפסד כרגע עומד על כ-₪${lossFormatted}. למרות שהסכום קטן, כדאי לעקוב שלא יתרחב.`;
  }

  // Waste already reported through the inventory feature is excluded from
  // the leak/loss figures above — surfaced here for transparency only, so
  // the reader understands the gap isn't a double-count of what they
  // already told the system about.
  if (wasteQty > 0) {
    moneyImpact += ` (בנוסף, נרשמה זריקת מלאי מדווחת של ${wasteQty.toFixed(1)} ${unit} (₪${wasteValue.toFixed(2)}) על חומר גלם זה בתקופה — זו כבר לא נחשבת כאן כדליפה, מכיוון שהיא ידועה ומתועדת.)`;
  }

  // ── למה זה קורה ───────────────────────────────────────────────────
  const causes = getCausesForCategory(category, pct, ingredient);

  // ── מה כדאי לעשות ────────────────────────────────────────────────
  const actions = getActionsForCategory(category, pct, severity);

  return { whatHappened, moneyImpact, causes, actions };
}

function getCausesForCategory(category, pct, ingredient) {
  const highPct = pct > 25;

  const base = {
    oil: [
      'שימוש יתר בבישול — שפים משתמשים ביותר שמן ממה שמוגדר במתכון',
      'שפיכה ורסס שמן שלא נספרים בדוחות',
      'הסחיות במדידת כמות בעת טיגון',
    ],
    meat: [
      'מנות לא אחידות — חתיכות גדולות מהסטנדרט שמוגדר במתכון',
      'פסולת חיתוך גדולה מהממוצע (עצמות, שומן שנוצל)',
      'בישול יתר שגורם לצמצום גדול יותר מהמצופה',
    ],
    dairy: [
      'מנות גבינה/שמנת גדולות מהמוגדר',
      'פגות תוקף של מוצרי חלב שנזרקו',
      'שימוש ב"גניבות טעימה" של הצוות',
    ],
    produce: [
      'בזבוז בהכנה — קילוף וחיתוך מסירים יותר מהצפוי',
      'ירקות שנקלקלו לפני שהספיקו לשמש',
      'מנות עם כמות ירקות גדולה מהסטנדרט',
    ],
    grain: [
      'פחת הכנה גבוה — לחם/אורז שנפסל לפני הגשה',
      'מנות גדולות מהמוגדר במתכון',
      'הכנה עודפת שלא נמכרה ונזרקה',
    ],
    beverage: [
      'מזיגת יתר בכוסות (מעבר לנפח המוגדר)',
      'אובדן בהכנה — שפיכות ושאריות בהכנה',
      'שתייה עצמית של הצוות שלא מדווחת',
    ],
    spice: [
      'שימוש ידני בתבלינים ללא מדידה מדויקת',
      'מינונים גדולים מהמתכון לפי טעם השף',
      'בזבוז בפתיחת אריזות ושפיכות',
    ],
    egg: [
      'ביצים שנשברו ונזרקו בהכנה',
      'מנות גדולות מהמוגדר (שתי ביצים במקום אחת)',
      'ביצים שנפסלו בבדיקה ונזרקו',
    ],
    alcohol: [
      'מזיגת יתר בקוקטיילים ומשקאות (מעבר למידה המוגדרת)',
      'שתייה עצמית של הצוות',
      'שבירה ואובדן בטיפול',
    ],
    other: [
      'שימוש יתר לעומת המוגדר במתכון',
      'אובדן בהכנה גבוה מהממוצע',
      'אי-דיוק בשקילה ומדידה',
    ],
  };

  let catCauses = base[category] || base.other;

  if (highPct) {
    catCauses = [
      ...catCauses,
      `חריגה גבוהה במיוחד (${Math.round(pct)}%) — ייתכן גם גניבה או טעות רישום במלאי`,
    ];
  }

  return catCauses;
}

function getActionsForCategory(category, pct, severity) {
  const urgency = severity === 'critical';

  const base = {
    oil: [
      'הגדר כמות שמן קבועה לכל מנה ועדכן במתכון',
      'השתמש במכלים עם פיה מדודה בכל תחנות הבישול',
      'ערוך ספירת מלאי שמן בכל משמרת',
    ],
    meat: [
      'שקול כל מנה לפני הגשה — לא לפי עין',
      'עדכן את המתכון לכלול את אחוז ה"פסולת" הצפוי בחישוב',
      'הדרך את הצוות על גדלי מנות עם דוגמאות פיזיות',
    ],
    dairy: [
      'השתמש בכפות/כוסות מדידה לגבינה ושמנת',
      'הגדר מדיניות ברורה לגבי תוקף מוצרי חלב ומועד השלכה',
      'תעד כל השלכה של מוצרי חלב בטפסים',
    ],
    produce: [
      'עדכן את המתכון לכלול אחוז הפסד הכנה ריאלי',
      'הכשר את הצוות על שיטות חיתוך יעילות להפחתת פחת',
      'ספור מלאי ירקות פעמיים ביום (בוקר/ערב)',
    ],
    grain: [
      'הכן רק לפי כמות המוזמנת — לא מראש',
      'הגדר כמות מנה סטנדרטית ומדוד אותה',
      'השלך הכנה שנותרת יותר מ-2 שעות',
    ],
    beverage: [
      'השתמש במידות מדויקות (jigger) לכל מזיגה',
      'רשום כל שפיכה ואובדן בדוח המשמרת',
      'הגדר מדיניות ברורה לגבי שתיית הצוות',
    ],
    spice: [
      'הכן תבלינים מראש בכמויות מדודות לכל משמרת',
      'עדכן מתכונים עם מינונים מדויקים בגרמים',
      'הפסק שימוש בקצבה "לפי טעם" ללא כלים מדידה',
    ],
    egg: [
      'ספור ביצים בתחילת ובסוף משמרת',
      'תעד ביצים שבורות בדוח יומי',
      'בדוק שגדלי המנות עם ביצים תואמים את המתכון',
    ],
    alcohol: [
      'השתמש במידות מדויקות (jigger) ואסור לשפוך ללא מדידה',
      'ספור בקבוקים בפתיחה ובסגירת הבר',
      'התקן מנעול על מחסן האלכוהול עם גישה מוגבלת',
    ],
    other: [
      'עדכן את המתכון לכמויות ריאליות',
      'ערוך ספירת מלאי שבועית לחומר הגלם הזה',
      'בדוק אם יש טעות ברישום כניסות מלאי',
    ],
  };

  let catActions = base[category] || base.other;

  if (urgency) {
    catActions = [`⚡ פעולה דחופה — פנה לצוות המטבח היום ובדוק את הנושא`, ...catActions];
  }

  return catActions;
}

// ── Summary Generator ────────────────────────────────────────────────────────
function generateSummary(results, totalLoss, mostProblematic, days, window = {}, coverage = {}) {
  // An empty result set has two completely different meanings, and the old
  // version reported the flattering one unconditionally: it declared "אין
  // דליפות — המתכונים מיושמים כראוי" even when the agent had no way to observe
  // consumption at all. That is the single most misleading sentence the
  // platform can print, because it tells the owner to stop looking.
  if (results.length === 0) {
    if (window.basis !== 'counted') {
      return {
        headline: 'לא ניתן לזהות דליפות — חסרה ספירת מלאי',
        detail: 'כדי לזהות דליפה צריך להשוות בין מה שהמתכונים אומרים שנצרך לבין מה שבאמת ירד מהמדף. '
              + 'ללא שתי ספירות מלאי פיזיות, הצריכה "בפועל" מחושבת מהמתכונים עצמם — כלומר המערכת משווה '
              + 'את החישוב לעצמו ולא תמצא פער לעולם. בצע ספירת מלאי, וחזור לכאן אחרי הספירה הבאה.',
        riskLevel: 'unknown',
        verified: false,
      };
    }
    if ((coverage.salesLinkedPct ?? 0) < 60) {
      return {
        headline: 'הכיסוי חלקי — חלק גדול מהמכירות לא מחובר למתכון',
        detail: `רק ${coverage.salesLinkedPct}% מהכמות שנמכרה מחוברת לרשימת מרכיבים, כך שרוב המכירות `
              + 'כלל לא נכנסו לחישוב. חבר את המנות החסרות למרכיבים כדי שהבדיקה תהיה מלאה.',
        riskLevel: 'unknown',
        // The window IS counted here — it's the recipe/sales linkage that's
        // incomplete. Two different kinds of "can't fully trust this".
        verified: window.basis === 'counted',
      };
    }
    return {
      headline: 'אין דליפות רווח מחומרי גלם בתקופה הנבדקת',
      detail: `המערכת השוותה את הצריכה בין שתי ספירות מלאי ולא זוהו חריגות משמעותיות. המתכונים מיושמים כראוי.`,
      riskLevel: 'low',
      verified: true,
    };
  }

  const criticalItems = results.filter(r => r.severity === 'critical');
  const warningItems  = results.filter(r => r.severity === 'warning');

  let headline = '';
  let detail   = '';
  let riskLevel = 'low';

  // Findings without a counted window are estimates built on the recipe math,
  // not measurements. They're still worth showing — but presenting them in the
  // same confident voice as a count-verified figure is how a rough signal turns
  // into a wrong accusation against the kitchen staff.
  const caveat = window.basis !== 'counted'
    ? ' ⚠️ הנתונים מבוססים על תנועות מלאי בלבד ולא על ספירה פיזית — ראה אותם כהערכה לכיוון, לא כמדידה. '
      + 'ספירת מלאי תהפוך את זה למספר מאומת.'
    : '';

  if (criticalItems.length > 0) {
    riskLevel = 'high';
    headline = `עיקר הבעיה שלך ב-${days} הימים האחרונים היא בצריכת ${criticalItems[0].name}`;
    detail = `זוהו ${criticalItems.length} חומרי גלם עם חריגה חמורה. `
           + `ההפסד הכולל עומד על ₪${totalLoss.toFixed(2)} — `
           + `מרביתו מגיע מ${criticalItems.slice(0, 3).map(i => i.name).join(', ')}. `
           + `כדאי לבדוק אם מדובר בגדלי מנות, פחת, או בעיה בצוות.`;
  } else if (warningItems.length > 0) {
    riskLevel = 'medium';
    headline = `יש כמה חריגות שדורשות תשומת לב — אך המצב אינו קריטי`;
    detail = `זוהו ${warningItems.length} חומרי גלם עם חריגה מתונה. `
           + `ההפסד הכולל עומד על ₪${totalLoss.toFixed(2)}. `
           + `מומלץ לבדוק את נהלי ההכנה ולוודא שהמתכונים מעודכנים.`;
  } else if (results.length > 0) {
    // ok-severity items exist but none are warning/critical — show a positive summary
    riskLevel = 'low';
    headline = `כל המרכיבים בטווח תקין — לא זוהו חריגות משמעותיות`;
    detail = `בדקנו ${results.length} חומרי גלם ב-${days} הימים האחרונים. `
           + `החריגות שנמצאו קטנות (מתחת ל-5%) ואינן דורשות טיפול דחוף. `
           + `ממשיכים לעקוב אחר המגמה.`;
  }

  return { headline, detail: detail + caveat, riskLevel, verified: window.basis === 'counted' };
}

// ── Measurement window ───────────────────────────────────────────────────────
/**
 * Decides what period this analysis can actually speak about.
 *
 * `counted` — two or more physical stock counts fall inside the requested
 *   period, so the window is [first count, last count] and actual consumption
 *   is a real measurement: opening + purchases − closing − waste.
 *
 * `derived` — no pair of counts. Actual usage then has to be inferred from the
 *   automatic per-sale deductions, which are themselves computed from the
 *   recipes — the same input "expected" comes from. The comparison is a
 *   tautology in that mode and can only ever produce a NEGATIVE variance, which
 *   is exactly why this agent used to report "no leaks" on every business
 *   forever. The mode is returned to the caller so the UI can say so out loud
 *   instead of presenting an empty list as a clean bill of health.
 */
async function _resolveWindow(businessId, days) {
  let sessions = [];
  try {
    const { rows } = await db.query(
      `SELECT DATE_TRUNC('hour', created_at) AS ts
       FROM inventory_transactions
       WHERE business_id = $1
         AND type = 'stocktake'
         AND created_at >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY 1
       ORDER BY 1 ASC`,
      [businessId, days]
    );
    sessions = rows.map(r => r.ts);
  } catch {
    // Pre-migration database (no 'stocktake' in the type CHECK) — fall through
    // to derived mode rather than failing the whole report.
    sessions = [];
  }

  if (sessions.length >= 2) {
    return {
      basis:          'counted',
      from:           sessions[0],
      to:             sessions[sessions.length - 1],
      stocktakeCount: sessions.length,
      lastStocktake:  sessions[sessions.length - 1],
    };
  }

  return {
    basis:          'derived',
    from:           null,           // → NOW() - days
    to:             null,           // → NOW()
    days,
    stocktakeCount: sessions.length,
    lastStocktake:  sessions[sessions.length - 1] || null,
  };
}

// SQL bounds for a window, plus the params to append. Keeps every query in this
// file on one definition of "the period" — expected and actual reading
// different ranges is what produced the phantom −80% variances (expected over
// 30 days of sales vs actual over the 5 days since deductions began).
function _windowSql(win, col, startIdx) {
  if (win.basis === 'counted') {
    return { sql: `${col} > $${startIdx} AND ${col} <= $${startIdx + 1}`, params: [win.from, win.to] };
  }
  return { sql: `${col} >= NOW() - ($${startIdx} || ' days')::INTERVAL`, params: [String(win.days)] };
}

// ── Main Detection Function ──────────────────────────────────────────────────
async function detectIngredientLeakage(businessId, days = 7) {
  const window = await _resolveWindow(businessId, days);

  const [expectedRows, actualRows, trendRows, dishBreakdownRows, priceChangeRows, coverage] = await Promise.all([
    _getExpectedUsage(businessId, window),
    _getActualUsage(businessId, window),
    _getWeeklyTrend(businessId),
    _getDishBreakdown(businessId, window),
    _getPriceChanges(businessId, days),
    _getCoverage(businessId, window),
  ]);

  const actualMap = new Map(actualRows.map(r => [r.item_id, r]));

  // Trend map: item_id → [{ week, variancePct }]
  const trendMap = new Map();
  for (const row of trendRows) {
    if (!trendMap.has(row.item_id)) trendMap.set(row.item_id, []);
    trendMap.get(row.item_id).push({
      week:        parseInt(row.week_num),
      variancePct: row.variance_pct !== null ? parseFloat(row.variance_pct) : null,
    });
  }

  // Dish breakdown map: item_id → [{ dishName, qtySold, qtyPerDish, contribution }]
  const dishMap = new Map();
  for (const row of dishBreakdownRows) {
    if (!dishMap.has(row.item_id)) dishMap.set(row.item_id, []);
    dishMap.get(row.item_id).push({
      dishName:     row.dish_name,
      qtySold:      Math.round(parseFloat(row.qty_sold)     * 10)   / 10,
      qtyPerDish:   Math.round(parseFloat(row.qty_per_dish)  * 1000) / 1000,
      contribution: Math.round(parseFloat(row.contribution)  * 10)   / 10,
    });
  }

  // Price change map: item_id → { recentPrice, histPrice, changePct }
  const priceMap = new Map(priceChangeRows.map(r => [r.item_id, {
    recentPrice: Math.round(parseFloat(r.recent_price) * 100) / 100,
    histPrice:   Math.round(parseFloat(r.hist_price)   * 100) / 100,
    changePct:   Math.round(parseFloat(r.change_pct)   * 10)  / 10,
  }]));

  // Build sorted 4-week history array (week 3 = oldest → week 0 = newest)
  function buildHistory(itemId) {
    const data = trendMap.get(itemId) || [];
    return [3, 2, 1, 0].map(wk => {
      const found = data.find(t => t.week === wk);
      return { week: wk, variancePct: found ? found.variancePct : null };
    });
  }

  const results = [];

  for (const exp of expectedRows) {
    const actual = actualMap.get(exp.item_id);

    // Ingredient was used in sold dishes (expected > 0) but has no inventory
    // transactions in the period — the system can't verify actual consumption.
    // Flag as a data gap rather than silently skipping.
    if (!actual) {
      const expectedQty = parseFloat(exp.expected_qty) || 0;
      if (expectedQty <= 0) continue;
      results.push({
        itemId:        exp.item_id,
        name:          exp.name,
        unit:          exp.unit,
        costPerUnit:   parseFloat(exp.cost_per_unit) || 0,
        expectedQty:   Math.round(expectedQty * 100) / 100,
        actualQty:     null,
        variance:      null,
        variancePct:   null,
        lossValue:     0,
        wasteQty:      0,
        wasteValue:    0,
        severity:      'warning',
        untracked:     true,
        weeklyHistory: buildHistory(exp.item_id),
        dishBreakdown: dishMap.get(exp.item_id) || [],
        priceChange:   priceMap.get(exp.item_id) || null,
        explanation: {
          whatHappened: `${exp.name} שימש ב-${expectedQty.toFixed(1)} ${exp.unit} לפי חישוב המתכון, אך לא נמצאו עדכוני מלאי לתקופה זו.`,
          moneyImpact:  'לא ניתן לאמוד הפסד ללא נתוני מלאי — ייתכן שהמלאי לא עודכן.',
          causes:  ['המלאי לא עודכן בתקופה הנבחרת', 'המרכיב אולי לא מחובר לפריט מלאי'],
          actions: ['עדכן את כמות המלאי הנוכחית לחומר גלם זה', 'ודא שהמרכיב במתכון מחובר לפריט מלאי בהגדרות'],
        },
      });
      continue;
    }

    const expectedQty  = parseFloat(exp.expected_qty)  || 0;
    const actualQty    = parseFloat(actual.actual_qty)   || 0;
    const costPerUnit  = parseFloat(exp.cost_per_unit)  || 0;
    const wasteQty     = parseFloat(actual.waste_qty)    || 0;

    if (expectedQty <= 0) continue;

    const variance     = actualQty - expectedQty;
    const variancePct  = variance / expectedQty;         // ratio
    const lossValue    = Math.max(0, variance) * costPerUnit;
    const wasteValue   = wasteQty * costPerUnit;

    // Only report over-usage (positive variance) — actualQty already
    // excludes recorded waste, so this is the gap purchases/sales can't
    // explain even after accounting for waste that was reported
    if (variancePct <= 0.005) continue;  // ignore ≤0.5% noise

    const severity = variancePct < 0.05 ? 'ok'
                   : variancePct < 0.15 ? 'warning'
                   : 'critical';

    const explanation = generateHebrewExplanation({
      ingredient: exp.name,
      unit:       exp.unit,
      expectedQty,
      actualQty,
      variance,
      variancePct,
      lossValue,
      severity,
      costPerUnit,
      wasteQty,
      wasteValue,
    });

    results.push({
      itemId:        exp.item_id,
      name:          exp.name,
      unit:          exp.unit,
      costPerUnit:   Math.round(costPerUnit  * 100) / 100,
      expectedQty:   Math.round(expectedQty  * 100) / 100,
      actualQty:     Math.round(actualQty    * 100) / 100,
      variance:      Math.round(variance     * 100) / 100,
      variancePct:   Math.round(variancePct  * 1000) / 10,  // percentage, 1 decimal
      lossValue:     Math.round(lossValue    * 100) / 100,
      wasteQty:      Math.round(wasteQty     * 100) / 100,
      wasteValue:    Math.round(wasteValue   * 100) / 100,
      severity,
      weeklyHistory: buildHistory(exp.item_id),
      dishBreakdown: dishMap.get(exp.item_id) || [],
      priceChange:   priceMap.get(exp.item_id) || null,
      explanation,
    });
  }

  // Sort: critical first, then by loss value desc
  results.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, ok: 2 };
    const sOrder = severityOrder[a.severity] - severityOrder[b.severity];
    if (sOrder !== 0) return sOrder;
    return b.lossValue - a.lossValue;
  });

  const totalLoss      = results.reduce((s, r) => s + r.lossValue, 0);
  const totalFoodCost  = actualRows.reduce((s, r) => s + (parseFloat(r.actual_qty) || 0) * (parseFloat(r.cost_per_unit) || 0), 0);
  const leakScore      = totalFoodCost > 0 ? (totalLoss / totalFoodCost) * 100 : 0;
  const criticalCount  = results.filter(r => r.severity === 'critical').length;
  const warningCount   = results.filter(r => r.severity === 'warning').length;
  const mostProblematic = results[0] || null;

  const summary = generateSummary(results, totalLoss, mostProblematic, days, window, coverage);

  // Extrapolate daily loss rate to monthly / annual projections
  const dailyLoss = days > 0 ? totalLoss / days : 0;
  const projection = {
    monthly: Math.round(dailyLoss * 30  * 100) / 100,
    annual:  Math.round(dailyLoss * 365 * 100) / 100,
  };

  return {
    items:           results,
    totalLoss:       Math.round(totalLoss  * 100) / 100,
    leakScore:       Math.round(leakScore  * 10)  / 10,   // %
    criticalCount,
    warningCount,
    totalItems:      results.length,
    mostProblematic: mostProblematic?.name || null,
    summary,
    projection,
    days,
    // How much of the business's activity this analysis could actually see, and
    // on what kind of evidence. An empty `items` list means one of two very
    // different things — "nothing is leaking" or "I can't see anything" — and
    // without this block the UI had no way to tell them apart, so it always
    // rendered the reassuring one.
    coverage: {
      ...coverage,
      basis:          window.basis,          // 'counted' | 'derived'
      verifiable:     window.basis === 'counted',
      stocktakeCount: window.stocktakeCount,
      lastStocktake:  window.lastStocktake,
      windowFrom:     window.from,
      windowTo:       window.to,
    },
  };
}

// ── Coverage: what share of the business this analysis can actually see ───────
// Three independent gaps, each of which silently zeroes out part of the report:
//   • sale_items with no resolvable ingredient list → contribute no expected usage
//   • recipes/dishes with no ingredients at all     → same, plus ₪0 cost
//   • inventory items with no cost                  → variance can't be priced
async function _getCoverage(businessId, win) {
  const w = _windowSql(win, 's.sold_at', 2);
  try {
    const [{ rows: [sales] }, { rows: [defs] }] = await Promise.all([
      db.query(
        `WITH ${INGREDIENT_SOURCE_CTE}
         SELECT
           COALESCE(SUM(si.qty), 0)::float AS qty_total,
           COALESCE(SUM(si.qty) FILTER (
             WHERE EXISTS (SELECT 1 FROM ingredients ing WHERE ing.recipe_id = si.recipe_id)
           ), 0)::float AS qty_linked,
           COUNT(DISTINCT si.name)::int AS names_total,
           COUNT(DISTINCT si.name) FILTER (
             WHERE EXISTS (SELECT 1 FROM ingredients ing WHERE ing.recipe_id = si.recipe_id)
           )::int AS names_linked
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.business_id = $1 AND ${w.sql}`,
        [businessId, ...w.params]
      ),
      db.query(
        `WITH ${INGREDIENT_SOURCE_CTE}
         SELECT
           (SELECT COUNT(*) FROM recipes WHERE business_id = $1)::int AS recipes_total,
           (SELECT COUNT(DISTINCT recipe_id) FROM ingredients)::int   AS recipes_with_ingredients,
           (SELECT COUNT(*) FROM inventory_items WHERE business_id = $1)::int AS items_total,
           (SELECT COUNT(*) FROM inventory_items
             WHERE business_id = $1 AND cost_per_unit > 0)::int       AS items_costed,
           -- Two inventory rows with the same name split one real ingredient in
           -- half: purchases land on one id, recipe usage on the other, and both
           -- halves then show a variance that is an artefact of the duplication
           -- rather than anything that happened in the kitchen.
           (SELECT COALESCE(ARRAY_AGG(nm), '{}') FROM (
              SELECT trim(name) AS nm FROM inventory_items
              WHERE business_id = $1
              GROUP BY trim(name) HAVING COUNT(*) > 1
              LIMIT 20
            ) dup)                                                    AS duplicate_item_names`,
        [businessId]
      ),
    ]);

    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      salesLinkedPct:      pct(sales?.qty_linked || 0, sales?.qty_total || 0),
      unlinkedSaleNames:   Math.max(0, (defs && sales ? sales.names_total - sales.names_linked : 0)),
      recipesWithIngredientsPct: pct(defs?.recipes_with_ingredients || 0, defs?.recipes_total || 0),
      itemsCostedPct:      pct(defs?.items_costed || 0, defs?.items_total || 0),
      recipesTotal:        defs?.recipes_total || 0,
      recipesWithIngredients: defs?.recipes_with_ingredients || 0,
      itemsTotal:          defs?.items_total || 0,
      duplicateItemNames:  defs?.duplicate_item_names || [],
    };
  } catch {
    return {
      salesLinkedPct: 0, unlinkedSaleNames: 0, recipesWithIngredientsPct: 0,
      itemsCostedPct: 0, recipesTotal: 0, recipesWithIngredients: 0, itemsTotal: 0,
      duplicateItemNames: [],
    };
  }
}

// ── Step 1: Expected Usage ───────────────────────────────────────────────────
// Smart dedup: for days that have individual POS sale_items, use those only.
// For days with only Z-report aggregates, use Z-report sale_items.
// This prevents double-counting when both exist for the same day.
//
// The ingredient list per recipe comes from utils/ingredientSource.js. The old
// inline version preferred recipe_ingredients and only fell back to a same-name
// dish when the recipe had NO rows at all, so a stale partial recipe (rows
// present but every item_id NULL) beat a fully-linked dish and contributed ZERO
// expected usage — silently erasing the business's best-selling items from the
// analysis. See that module's header for the measured damage.
async function _getExpectedUsage(businessId, win) {
  const w = _windowSql(win, 's.sold_at', 2);
  const { rows } = await db.query(
    `WITH ${INGREDIENT_SOURCE_CTE},
     day_sales AS (
       SELECT si.qty, si.recipe_id,
              DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
              (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
       FROM sale_items si
       INNER JOIN sales s ON s.id = si.sale_id
       WHERE s.business_id = $1
         AND ${w.sql}
         AND si.recipe_id IS NOT NULL
     ),
     ind_days AS (SELECT DISTINCT sale_day FROM day_sales WHERE is_ind),
     filtered AS (
       SELECT * FROM day_sales
       WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
     )
     SELECT
       ing.item_id,
       ii.name,
       ii.unit,
       ii.cost_per_unit,
       SUM(f.qty * ing.qty)::float AS expected_qty
     FROM filtered f
     INNER JOIN ingredients ing    ON ing.recipe_id = f.recipe_id
     INNER JOIN inventory_items ii ON ii.id = ing.item_id
     GROUP BY ing.item_id, ii.name, ii.unit, ii.cost_per_unit
     HAVING SUM(f.qty * ing.qty) > 0`,
    [businessId, ...w.params]
  );
  return rows;
}

// ── Step 2: Actual Usage ─────────────────────────────────────────────────────
// Recorded waste (the inventory feature's "discarded inventory" batch report)
// is excluded from actual_qty and reported separately as wasteQty — it's a
// KNOWN, already-explained loss, not a mystery leak. Without this split,
// throwing away spoiled stock through the proper feature would inflate the
// same variance this agent reports as an unexplained "leak," punishing
// businesses for the exact transparency the waste feature is meant to reward.
//
// Two modes, and the difference between them decides whether this agent is
// measuring anything at all:
//
//   counted  — bounded by two physical stock counts:
//                actual = opening_count + purchases − closing_count − waste
//              Automatic per-sale deductions are deliberately IGNORED here;
//              the counted shelf already accounts for whatever left.
//
//   derived  — no pair of counts, so consumption is inferred from stock
//              movements: purchases − net_change(excl. waste). On a business
//              whose only movements are the automatic per-sale deductions this
//              is circular — those deductions are computed FROM the recipes,
//              i.e. from `expected` — so variance can only come out ≤ 0 and no
//              leak can ever be reported. Kept as a degraded fallback, flagged
//              via coverage.basis so the UI stops calling it a clean result.
async function _getActualUsage(businessId, win) {
  if (win.basis === 'counted') {
    const { rows } = await db.query(
      `WITH opening AS (
         SELECT DISTINCT ON (item_id) item_id, qty_after::float AS qty
         FROM inventory_transactions
         WHERE business_id = $1 AND type = 'stocktake'
           AND created_at >= $2 AND created_at < $2 + INTERVAL '1 hour'
         ORDER BY item_id, created_at DESC
       ),
       closing AS (
         SELECT DISTINCT ON (item_id) item_id, qty_after::float AS qty
         FROM inventory_transactions
         WHERE business_id = $1 AND type = 'stocktake'
           AND created_at >= $3 AND created_at < $3 + INTERVAL '1 hour'
         ORDER BY item_id, created_at DESC
       ),
       moves AS (
         SELECT item_id,
           -- Stock that came IN during the window. 'stocktake' rows are excluded:
           -- a count is a correction of the books, not a delivery, and counting
           -- it as a purchase would manufacture consumption out of thin air.
           SUM(CASE WHEN type IN ('purchase','manual_adjust') AND qty_change > 0
                    THEN qty_change ELSE 0 END)::float AS purchases,
           SUM(CASE WHEN type = 'waste' THEN -qty_change ELSE 0 END)::float AS waste_qty
         FROM inventory_transactions
         WHERE business_id = $1 AND created_at > $2 AND created_at <= $3
         GROUP BY item_id
       )
       SELECT
         ii.id             AS item_id,
         ii.name,
         ii.unit,
         ii.cost_per_unit,
         GREATEST(0, o.qty + COALESCE(m.purchases, 0) - c.qty - COALESCE(m.waste_qty, 0)) AS actual_qty,
         COALESCE(m.waste_qty, 0) AS waste_qty
       FROM inventory_items ii
       INNER JOIN opening o ON o.item_id = ii.id
       INNER JOIN closing c ON c.item_id = ii.id
       LEFT  JOIN moves   m ON m.item_id = ii.id
       WHERE ii.business_id = $1`,
      [businessId, win.from, win.to]
    );
    return rows;
  }

  const w = _windowSql(win, 'created_at', 2);
  const { rows } = await db.query(
    `WITH period AS (
       SELECT
         item_id,
         SUM(CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END)::float          AS purchases,
         SUM(CASE WHEN type <> 'waste' THEN qty_change ELSE 0 END)::float         AS net_change_excl_waste,
         SUM(CASE WHEN type = 'waste' THEN -qty_change ELSE 0 END)::float         AS waste_qty
       FROM inventory_transactions
       WHERE business_id = $1
         AND ${w.sql}
       GROUP BY item_id
     )
     SELECT
       ii.id              AS item_id,
       ii.name,
       ii.unit,
       ii.cost_per_unit,
       -- actual_usage = purchases − net_change(excl. waste) = unexplained outflow
       GREATEST(0, COALESCE(p.purchases, 0) - COALESCE(p.net_change_excl_waste, 0)) AS actual_qty,
       COALESCE(p.waste_qty, 0) AS waste_qty
     FROM inventory_items ii
     INNER JOIN period p ON p.item_id = ii.id
     WHERE ii.business_id = $1`,
    [businessId, ...w.params]
  );
  return rows;
}

// ── Weekly Trend: last 4 weeks variance % per ingredient ────────────────────
// Returns rows: { item_id, week_num (0=this week … 3=3 weeks ago), variance_pct }
// Used to populate the sparkline in each ingredient card.
// Skips the Z-report dedup to keep the query lightweight — trend values are
// approximate; they're for visual direction, not precise accounting.
async function _getWeeklyTrend(businessId) {
  try {
    const { rows } = await db.query(
      `WITH ${INGREDIENT_SOURCE_CTE},
       week_bucket AS (
         SELECT
           si.qty,
           si.recipe_id,
           CASE
             WHEN s.sold_at >= NOW() - '7 days'::INTERVAL  THEN 0
             WHEN s.sold_at >= NOW() - '14 days'::INTERVAL THEN 1
             WHEN s.sold_at >= NOW() - '21 days'::INTERVAL THEN 2
             ELSE 3
           END AS wk
         FROM sale_items si
         INNER JOIN sales s ON s.id = si.sale_id
         WHERE s.business_id = $1
           AND s.sold_at >= NOW() - '28 days'::INTERVAL
           AND si.recipe_id IS NOT NULL
       ),
       exp AS (
         SELECT ing.item_id, wb.wk,
                SUM(wb.qty * ing.qty)::float AS expected_qty
         FROM week_bucket wb
         INNER JOIN ingredients ing ON ing.recipe_id = wb.recipe_id
         GROUP BY ing.item_id, wb.wk
         HAVING SUM(wb.qty * ing.qty) > 0
       ),
       act_raw AS (
         SELECT
           item_id, qty_change, type,
           CASE
             WHEN created_at >= NOW() - '7 days'::INTERVAL  THEN 0
             WHEN created_at >= NOW() - '14 days'::INTERVAL THEN 1
             WHEN created_at >= NOW() - '21 days'::INTERVAL THEN 2
             ELSE 3
           END AS wk
         FROM inventory_transactions
         WHERE business_id = $1
           AND created_at >= NOW() - '28 days'::INTERVAL
       ),
       act AS (
         SELECT
           item_id, wk,
           GREATEST(0,
             SUM(CASE WHEN qty_change > 0 THEN qty_change ELSE 0 END) -
             SUM(CASE WHEN type <> 'waste' THEN qty_change ELSE 0 END)
           )::float AS actual_qty
         FROM act_raw
         GROUP BY item_id, wk
       )
       SELECT
         COALESCE(e.item_id, a.item_id)::text AS item_id,
         COALESCE(e.wk, a.wk)                 AS week_num,
         CASE WHEN COALESCE(e.expected_qty, 0) > 0
           THEN GREATEST(0,
                  ROUND(((COALESCE(a.actual_qty, 0) - e.expected_qty)
                         / e.expected_qty * 100)::numeric, 1))::float
           ELSE NULL
         END AS variance_pct
       FROM exp e
       FULL OUTER JOIN act a ON a.item_id = e.item_id AND a.wk = e.wk`,
      [businessId]
    );
    return rows;
  } catch {
    return [];
  }
}

// ── Dish Breakdown: which dishes drove expected usage per ingredient ──────────
// Returns rows: { item_id, dish_name, qty_sold, qty_per_dish, contribution }
// Applies the same Z-report dedup as _getExpectedUsage.
async function _getDishBreakdown(businessId, win) {
  const w = _windowSql(win, 's.sold_at', 2);
  try {
    const { rows } = await db.query(
      `WITH ${INGREDIENT_SOURCE_CTE},
       day_sales AS (
         SELECT si.qty, si.recipe_id,
                DATE(s.sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
                (s.pos_sale_id IS NULL OR s.pos_sale_id NOT LIKE 'Z-%') AS is_ind
         FROM sale_items si
         INNER JOIN sales s ON s.id = si.sale_id
         WHERE s.business_id = $1
           AND ${w.sql}
           AND si.recipe_id IS NOT NULL
       ),
       ind_days AS (SELECT DISTINCT sale_day FROM day_sales WHERE is_ind),
       filtered AS (
         SELECT * FROM day_sales
         WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
       )
       SELECT
         ing.item_id,
         r.name              AS dish_name,
         SUM(f.qty)::float   AS qty_sold,
         ing.qty::float      AS qty_per_dish,
         SUM(f.qty * ing.qty)::float AS contribution
       FROM filtered f
       INNER JOIN ingredients ing ON ing.recipe_id = f.recipe_id
       INNER JOIN recipes r       ON r.id          = f.recipe_id
       GROUP BY ing.item_id, r.name, ing.qty
       HAVING SUM(f.qty * ing.qty) > 0
       ORDER BY ing.item_id, contribution DESC`,
      [businessId, ...w.params]
    );
    return rows;
  } catch {
    return [];
  }
}

// ── Price Changes: supplier cost increase/decrease detected from invoices ────
// Compares average unit_price in the current period against the prior 90-day
// baseline. Returns items where the price shifted ≥ 3 %.
// Wrapped in try/catch — if invoice tables are absent the feature degrades
// gracefully rather than crashing the whole leakage report.
async function _getPriceChanges(businessId, days) {
  try {
    const { rows } = await db.query(
      `WITH recent AS (
         SELECT
           ii2.inventory_item_id                    AS item_id,
           AVG(ii2.unit_price)::float               AS avg_price
         FROM invoice_items ii2
         INNER JOIN invoices inv ON inv.id = ii2.invoice_id
         WHERE inv.business_id      = $1
           AND inv.invoice_date    >= NOW() - ($2 || ' days')::INTERVAL
           AND ii2.unit_price       > 0
           AND ii2.inventory_item_id IS NOT NULL
         GROUP BY ii2.inventory_item_id
       ),
       hist AS (
         -- Fixed baseline window: always 180 days back from "now minus the
         -- analysis period".  Using a dynamic window of (now-90d … now-Nd)
         -- would produce an empty range when days >= 90, silently killing all
         -- price-change detections.  180 days gives a robust historical sample
         -- regardless of whether the caller passes days = 7, 14, or 30.
         SELECT
           ii2.inventory_item_id                    AS item_id,
           AVG(ii2.unit_price)::float               AS avg_price
         FROM invoice_items ii2
         INNER JOIN invoices inv ON inv.id = ii2.invoice_id
         WHERE inv.business_id      = $1
           AND inv.invoice_date    <  NOW() - ($2 || ' days')::INTERVAL
           AND inv.invoice_date    >= NOW() - '180 days'::INTERVAL
           AND ii2.unit_price       > 0
           AND ii2.inventory_item_id IS NOT NULL
         GROUP BY ii2.inventory_item_id
       )
       SELECT
         r.item_id::text                                                        AS item_id,
         ROUND(r.avg_price::numeric, 4)::float                                 AS recent_price,
         ROUND(h.avg_price::numeric, 4)::float                                 AS hist_price,
         ROUND(((r.avg_price - h.avg_price) / NULLIF(h.avg_price, 0) * 100)::numeric, 1)::float
                                                                                AS change_pct
       FROM recent r
       INNER JOIN hist h ON h.item_id = r.item_id
       WHERE h.avg_price > 0
         AND ABS((r.avg_price - h.avg_price) / NULLIF(h.avg_price, 0)) * 100 >= 3`,
      [businessId, days]
    );
    return rows;
  } catch {
    return [];
  }
}

module.exports = { detectIngredientLeakage };
