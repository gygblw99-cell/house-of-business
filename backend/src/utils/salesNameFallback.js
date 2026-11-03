/**
 * ניכוי מלאי חלופי לפי שם הפריט הנמכר — כשאין מנה/מתכון מוגדרים.
 *
 * ── למה זה קיים ─────────────────────────────────────────────────────────────
 * דוח Z מנכה מלאי רק דרך מנה מקושרת (dish_ingredients) או מתכון
 * (recipe_ingredients). פריט שנמכר בקופה ואין לו אף אחד מהשניים — מנה שנמחקה,
 * מנה שטרם הוגדרה, או פריט משקל שהקופה מוכרת ישר — לא מנכה גרם אחד. בעסק
 * אמיתי זה יכול להיות רוב הפדיון, והדוחות מדווחים עלות סחורה נמוכה מהאמת.
 *
 * המודול הזה הוא רשת ביטחון צרה ומכוונת: הוא מנכה **רק** כשהשם עצמו מספק את
 * שני הנתונים החסרים — *מה* לנכות (התאמה לפריט מלאי קיים) ו*כמה* (משקל/נפח
 * שכתוב בשם, למשל "אונטריב | 100 גר"), או כשהפריט נמדד ביחידות ואז יחידה
 * אחת למכירה היא הפירוש היחיד ההגיוני ("פחית קוקה קולה" → פחית אחת).
 *
 * ── מה הוא מסרב לעשות ───────────────────────────────────────────────────────
 * זה ניחוש מדוד, לא AI. כל מקרה שבו הפירוש לא חד-משמעי מוחזר כ-null ומשאיר את
 * ההתראה על "מרכיבים חסרים" במקומה — עדיף פער גלוי על ניכוי שגוי שקט:
 *   • אין התאמה ייחודית לפריט מלאי (שני פריטים מתאימים באותה מידה) → null
 *   • ההתאמה נשענת רק על מילה גנרית ("תוספת", "פחית", "טרי") → null
 *   • פריט שנמדד בק"ג/ליטר בלי משקל בשם ("בריסקט במשקל") → null,
 *     כי גודל המנה לא ידוע ואין שום בסיס לנחש אותו
 *   • מנה מורכבת ("מנה בשרית במגש + 2 תוספות") → null, כי שם אחד לא יכול
 *     להצביע על מספר חומרי גלם בכמויות שונות. זה מה שמתכון קיים בשבילו.
 *
 * ── מגבלה שחשוב להכיר ───────────────────────────────────────────────────────
 * המודול מנכה רק מחומרי גלם שכבר קיימים ב-inventory_items. אם הבשר המרכזי של
 * העסק לא הוזן למלאי בכלל, אין מה לנכות ממנו — ואז הפער נסגר רק בהזנת הפריט
 * למלאי, לא כאן.
 */

// מילים שאינן מזהות חומר גלם. בלעדיהן "פחית ספרייט" לא יתפוס את "קולה פחיות"
// רק בגלל המילה "פחית", ו"תוספת סלט" לא יתפוס כל פריט שיש בשמו "תוספת".
const GENERIC_TOKENS = new Set([
  // תיאורי מנה/הגשה
  'תוספת', 'תוספות', 'אקסטרה', 'מנה', 'מנות', 'ארוחה', 'ארוחת', 'עסקית', 'עסקי',
  'במגש', 'מגש', 'במשקל', 'משקל', 'בצלחת', 'צלחת', 'אישי', 'אישית', 'כוס',
  'פחית', 'פחיות', 'בקבוק', 'מיכל', 'שקית', 'דלי', 'קרטון',
  // תיאורי מצב/איכות — מופיעים בשמות מלאי מספקים ולא מזהים כלום
  'טרי', 'טרייה', 'קפוא', 'קפואה', 'מבושל', 'מבושלת', 'שלם', 'שלמה', 'חתוך',
  'מחולק', 'כשר', 'כשרה', 'גדול', 'קטן', 'בינוני',
  // יחידות מידה
  'גר', 'גרם', 'ג', 'קג', 'קילו', 'קילוגרם', 'ליטר', 'מל', 'יח', 'יחידה', 'יחידות',
  // מילות קישור
  'של', 'עם', 'ללא', 'בלי', 'או', 'עד', 'לפי',
]);

/** מנרמל שם לצורך השוואה: אותיות קטנות, בלי פיסוק/גרשיים, רווח בודד. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/["'`׳״]/g, '')                    // גרשיים עבריים ולטיניים
    .replace(/(\d),(\d)/g, '$1.$2')             // 1,5 → 1.5 (פסיק עשרוני)
    // הנקודה והפסיק נשארים כשהם בין ספרות, אחרת "1.5 ליטר" היה הופך ל-"1 5 ליטר"
    // ומשקל של 1.5 נקרא כ-5. הבאג הזה נתפס בטסט על "מים 1.5 ליטר".
    .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
    .replace(/[|/\\_\-()[\]{}+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** טוקנים מזהים בלבד — בלי מילים גנריות, בלי מספרים, באורך 2 ומעלה. */
function distinctiveTokens(name) {
  return normalizeName(name)
    .split(' ')
    .filter(t => t.length >= 2 && !GENERIC_TOKENS.has(t) && !/^\d+(\.\d+)?$/.test(t));
}

/**
 * מחלץ כמות מתוך השם והופך אותה ליחידת בסיס (ק"ג / ליטר).
 * "אונטריב | 100 גר" → { amount: 0.1, family: 'mass' }
 * "מים 1.5 ליטר"     → { amount: 1.5, family: 'volume' }
 * מספר בלי יחידה מוחזר כ-null — "X1" או "סלט 5 שח" הם לא משקל.
 */
function parseQtyFromName(name) {
  const n = normalizeName(name);
  // גרמים — נבדק לפני ק"ג כדי ש"גרם" לא ייבלע ע"י תחילית אחרת
  let m = n.match(/(\d+(?:\.\d+)?)\s*(?:גרם|גר|ג)(?:\s|$)/);
  if (m) return { amount: parseFloat(m[1]) / 1000, family: 'mass' };
  m = n.match(/(\d+(?:\.\d+)?)\s*(?:קילוגרם|קילו|קג)(?:\s|$)/);
  if (m) return { amount: parseFloat(m[1]), family: 'mass' };
  m = n.match(/(\d+(?:\.\d+)?)\s*(?:מל|מיליליטר)(?:\s|$)/);
  if (m) return { amount: parseFloat(m[1]) / 1000, family: 'volume' };
  m = n.match(/(\d+(?:\.\d+)?)\s*(?:ליטר|ל)(?:\s|$)/);
  if (m) return { amount: parseFloat(m[1]), family: 'volume' };
  return null;
}

/** משפחת המידה של יחידת פריט מלאי. */
function unitFamily(unit) {
  const u = normalizeName(unit);
  if (/^(קג|ק ג|קילו|קילוגרם|kg)$/.test(u) || u === 'גרם' || u === 'גר') return 'mass';
  if (/^(ליטר|ל|מל|מ ל|liter|l|ml)$/.test(u)) return 'volume';
  if (/^(יחידה|יח|יחידות|unit|pcs)$/.test(u)) return 'count';
  return null;
}

/**
 * מאתר פריט מלאי יחיד שהשם מצביע עליו.
 * מחזיר null גם כשאין התאמה וגם כששתי התאמות טובות באותה מידה — אי-ודאות
 * מחזירה null ולא "הניחוש הסביר יותר".
 *
 * @param {string} name שם הפריט הנמכר
 * @param {Array<{id:string,name:string,unit:string}>} items פריטי המלאי של העסק
 */
function matchInventoryItem(name, items) {
  const saleTokens = distinctiveTokens(name);
  if (!saleTokens.length) return null;

  const scored = [];
  for (const item of items) {
    const itemTokens = distinctiveTokens(item.name);
    if (!itemTokens.length) continue;
    // השוואת טוקנים היא **זהות מדויקת בלבד**, במכוון.
    //
    // הייתה כאן התאמה מקילה לפי תחילית, והיא נכשלה בשני הכיוונים כשנבדקה על
    // נתוני אמת:
    //   • יצרה התאמות שקר — "סלט בקר" תפס את "מיליק מיסולית לדלי - 4 שקיות
    //     בקרטון" כי "בקרטון" מתחיל ב"בקר", והניכוי היה מוריד 60 יחידות מפריט
    //     אריזה. תחיליות ב-/ל-/ה- בעברית הופכות כל תחילית קצרה למלכודת.
    //   • ולא תפסה את מה שנועדה לתפוס — ריבוי עברי אינו תחילית: "שעועיות" לא
    //     מתחיל ב"שעועית", וגם "ירוקות" לא ב"ירוקה" ו"פחיות" לא ב"פחית".
    // כלומר היא הוסיפה רק סיכון. בהרצה על 49 שמות אמיתיים היא לא הוסיפה אף
    // התאמה נכונה אחת. פער גלוי עדיף על ניכוי שקט ושגוי.
    const shared = saleTokens.filter(st => itemTokens.includes(st));
    // דורש טוקן משותף מזהה באמת — טוקן באורך 2 לבד חלש מדי.
    if (!shared.some(t => t.length >= 3)) continue;
    scored.push({ item, score: shared.length, shared });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[1].score === scored[0].score) return null; // דו-משמעי
  return scored[0].item;
}

/**
 * מחשב ניכוי חלופי לפריט נמכר בודד.
 *
 * @param {string} saleName שם הפריט כפי שהקופה רשמה אותו
 * @param {number} qtySold  כמה נמכרו
 * @param {Array<{id:string,name:string,unit:string}>} items פריטי המלאי של העסק
 * @returns {{itemId:string, itemName:string, qty:number, basis:string}|null}
 */
function resolveFallbackDeduction(saleName, qtySold, items) {
  const sold = parseFloat(qtySold);
  if (!Number.isFinite(sold) || sold <= 0) return null;

  const item = matchInventoryItem(saleName, items);
  if (!item) return null;

  const family = unitFamily(item.unit);
  if (!family) return null;

  const parsed = parseQtyFromName(saleName);

  // משקל/נפח כתוב בשם ותואם את יחידת הפריט — הפירוש חד-משמעי.
  if (parsed && parsed.family === family) {
    return {
      itemId: item.id, itemName: item.name,
      qty: parsed.amount * sold,
      basis: `${parsed.amount} ${item.unit} × ${sold}`,
    };
  }

  // פריט שנמדד ביחידות ואין משקל בשם — יחידה אחת לכל מכירה.
  if (family === 'count' && !parsed) {
    return {
      itemId: item.id, itemName: item.name,
      qty: sold,
      basis: `1 ${item.unit} × ${sold}`,
    };
  }

  // כל השאר: גודל המנה לא ידוע. משאירים את הפער גלוי.
  return null;
}

module.exports = {
  normalizeName,
  distinctiveTokens,
  parseQtyFromName,
  unitFamily,
  matchInventoryItem,
  resolveFallbackDeduction,
  GENERIC_TOKENS,
};
