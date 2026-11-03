/**
 * נרמול השורות שחוזרות מפענוח ה-AI של תיאור מנה בטקסט חופשי
 * (POST /api/recipes/parse-ingredients-text) לפני שהן מוצגות למשתמש.
 *
 * ── למה זה קיים בנפרד ───────────────────────────────────────────────────────
 * השורה שה-AI מחזיר נשמרת בסוף דרך `dishModel.setIngredients`, וזה ממיר את
 * הכמות ליחידת פריט המלאי בעזרת `convertQty`. אם ההמרה בלתי אפשרית,
 * setIngredients **מאפס את הקישור לפריט המלאי בשקט** — השורה נשמרת, נראית
 * תקינה בדף המנות, ולא מנכה גרם אחד לנצח.
 *
 * זה לא תרחיש תיאורטי. הפרומפט מתיר ל-AI להחזיר 15 יחידות ספירה שונות
 * (ביצה, פחית, חבילה, ארגז...), אבל `convertQty` דורש ליחידות ספירה **אותה
 * יחידה קנונית בדיוק** — כי לארגז אין מספר קבוע של יחידות. בפועל כל פריטי
 * המלאי במשפחת הספירה מנוהלים ב"יחידה"/"יח'"/"יח", ולכן 14 מתוך 15 היחידות
 * שהפרומפט מתיר הפילו את הקישור. גם "2 ביצים" — דוגמה שמופיעה בפרומפט עצמו —
 * נשמר ללא קישור ולא ניכה כלום.
 *
 * ── שני סוגי אי-התאמה, שתי תגובות שונות ────────────────────────────────────
 * ההבדל קריטי, וטיפול אחיד בשניהם הוא באג:
 *
 *   • אותה משפחה, יחידה קנונית אחרת ("ביצה" → פריט ב"יח'"):
 *     הכמות **נכונה** — 2 ביצים הן 2 יחידות. מצמידים את היחידה ליחידת הפריט,
 *     שומרים את הכמות, ומסמנים כמשוער כדי שהמשתמש יראה שהמערכת התאימה.
 *
 *   • משפחה אחרת לגמרי ("150 גרם" → פריט ב"יחידה"):
 *     הכמות **חסרת משמעות** ביחידת היעד. הצמדה כאן הייתה מנכה 150 יחידות
 *     במקום 150 גרם. לכן מבטלים את הקישור במפורש ומחזירים את השורה כלא-מותאמת,
 *     כדי שתופיע למשתמש כדורשת טיפול — ולא תיראה מקושרת ואז תתנתק בשקט בשמירה.
 */

const { convertQty, resolveUnit } = require('./unitConversion');

const _num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const _str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * @param {Array<object>} parsed  המערך הגולמי מה-AI
 * @param {Array<{id:string,name:string,unit:string,cost_per_unit:number}>} catalog פריטי המלאי של העסק
 * @returns {Array<object>} שורות מנורמלות למשתמש
 */
function normalizeParsedLines(parsed, catalog = []) {
  const byId = new Map((catalog || []).map(c => [String(c.id), c]));

  return (parsed || []).map(line => {
    const item = line && line.matchedItemId ? byId.get(String(line.matchedItemId)) : null;

    let qty  = _num(line?.qty);
    let unit = _str(line?.unit);
    const costShekels = _num(line?.costShekels);

    let matchedItemId = item ? item.id : null;
    let unitCoerced   = false;
    let unitMismatch  = false;

    // תואר לפי עלות בלבד — גוזרים כמות משוערת מעלות הפריט במלאי.
    // היחידה נלקחת מהפריט עצמו, ולכן ההמרה תמיד אפשרית.
    const isCostDerived = qty === null && costShekels !== null;
    if (isCostDerived && item && item.cost_per_unit > 0) {
      qty  = parseFloat((costShekels / item.cost_per_unit).toFixed(4));
      unit = item.unit;
    }

    // ההצלבה מול יחידת פריט המלאי — כאן נמנעת ההתנתקות השקטה בשמירה
    if (item && qty !== null && unit) {
      const from = resolveUnit(unit);
      const to   = resolveUnit(item.unit);

      if (!from || !to) {
        // יחידה שהמערכת לא מכירה בכלל (בשום צד) — אין שום דרך להמיר
        matchedItemId = null;
        unitMismatch  = true;
      } else if (from.family !== to.family) {
        // משקל מול ספירה וכדומה — הכמות לא ניתנת לתרגום, אסור להצמיד
        matchedItemId = null;
        unitMismatch  = true;
      } else if (convertQty(1, unit, item.unit) === null) {
        // אותה משפחה אך יחידה קנונית אחרת (ספירה) — הכמות נכונה, מצמידים
        unit        = item.unit;
        unitCoerced = true;
      }
    }

    return {
      rawText:       line?.rawText || line?.name || '',
      name:          item?.name || line?.name || '',
      matchedItemId,
      qty, unit,
      costShekels,
      // "משוער" — או שה-AI סימן ככה, או שהכמות חושבה לאחור מעלות, או
      // שהיחידה הוצמדה ליחידת הפריט ולכן ראויה לאישור המשתמש
      isApproximate: !!line?.isApproximate || isCostDerived || unitCoerced,
      unitCoerced,
      unitMismatch,
    };
  }).filter(l => l.name);
}

module.exports = { normalizeParsedLines };
