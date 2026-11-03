/**
 * normalizeParsedLines — ההצלבה בין מה שה-AI החזיר מתיאור חופשי לבין יחידת
 * פריט המלאי.
 *
 * למה זה קריטי: שורה שיחידתה לא ניתנת להמרה ליחידת הפריט מאבדת את הקישור
 * **בשקט** ב-setIngredients, נראית תקינה בדף המנות, ולא מנכה גרם אחד.
 * הפרומפט מתיר ל-AI 15 יחידות ספירה, אבל convertQty דורש אותה יחידה קנונית —
 * ובפועל כל פריטי הספירה מנוהלים ב"יחידה"/"יח'", כך ש-14 מתוך 15 הפילו את
 * הקישור. "2 ביצים", דוגמה מתוך הפרומפט עצמו, לא ניכתה כלום.
 */

const { normalizeParsedLines } = require('../src/utils/parsedIngredientLines');

const CATALOG = [
  { id: 'i-rice',  name: 'אורז יסמין',  unit: 'ק"ג',   cost_per_unit: 12 },
  { id: 'i-oil',   name: 'שמן חמניות',  unit: 'ליטר',  cost_per_unit: 20 },
  { id: 'i-egg',   name: 'ביצים',       unit: "יח'",   cost_per_unit: 1.2 },
  { id: 'i-cola',  name: 'קולה פחיות',  unit: 'יחידה', cost_per_unit: 3 },
  { id: 'i-weird', name: 'פריט מוזר',   unit: 'ל',     cost_per_unit: 5 }, // יחידה שהמערכת לא מכירה
];

const one = (line) => normalizeParsedLines([line], CATALOG)[0];

describe('יחידות משקל ונפח — ההמרה נעשית בשמירה, היחידה נשמרת כפי שהיא', () => {
  it('גרם על פריט בק"ג נשאר גרם ומקושר', () => {
    const l = one({ name: 'אורז', matchedItemId: 'i-rice', qty: 250, unit: 'גרם' });
    expect(l.matchedItemId).toBe('i-rice');
    expect(l.qty).toBe(250);
    expect(l.unit).toBe('גרם');
    expect(l.unitMismatch).toBe(false);
  });

  it('מ"ל על פריט בליטר נשאר מקושר', () => {
    const l = one({ name: 'שמן', matchedItemId: 'i-oil', qty: 20, unit: 'מיליליטר' });
    expect(l.matchedItemId).toBe('i-oil');
    expect(l.qty).toBe(20);
    expect(l.unitMismatch).toBe(false);
  });

  it('כוס על פריט בליטר נשאר מקושר (אותה משפחה)', () => {
    const l = one({ name: 'שמן', matchedItemId: 'i-oil', qty: 1, unit: 'כוס' });
    expect(l.matchedItemId).toBe('i-oil');
    expect(l.unitMismatch).toBe(false);
  });
});

describe('יחידות ספירה — הכמות נכונה, היחידה מוצמדת לפריט', () => {
  it('"2 ביצים" כ-ביצה על פריט ב-יח\' → מוצמד ל-יח\' ונשאר מקושר', () => {
    // זו הרגרסיה: לפני התיקון הקישור נפל והשורה לא ניכתה כלום
    const l = one({ name: 'ביצים', matchedItemId: 'i-egg', qty: 2, unit: 'ביצה' });
    expect(l.matchedItemId).toBe('i-egg');
    expect(l.qty).toBe(2);
    expect(l.unit).toBe("יח'");
    expect(l.unitCoerced).toBe(true);
    expect(l.isApproximate).toBe(true);   // מסומן כדי שהמשתמש יאשר
  });

  it('"פחית קולה" כ-פחית על פריט ב-יחידה → מוצמד ל-יחידה', () => {
    const l = one({ name: 'קולה', matchedItemId: 'i-cola', qty: 1, unit: 'פחית' });
    expect(l.matchedItemId).toBe('i-cola');
    expect(l.qty).toBe(1);
    expect(l.unit).toBe('יחידה');
    expect(l.unitCoerced).toBe(true);
  });

  it('יחידה תואמת מראש — לא מוצמד ולא מסומן משוער', () => {
    const l = one({ name: 'קולה', matchedItemId: 'i-cola', qty: 2, unit: 'יחידה' });
    expect(l.unitCoerced).toBe(false);
    expect(l.isApproximate).toBe(false);
  });
});

describe('משפחה שונה — הקישור מבוטל במפורש, הכמות לא מוצמדת', () => {
  it('"150 גרם" על פריט שנמדד ביחידות → לא מקושר, לא 150 יחידות', () => {
    const l = one({ name: 'ביצים', matchedItemId: 'i-egg', qty: 150, unit: 'גרם' });
    expect(l.matchedItemId).toBeNull();
    expect(l.unitMismatch).toBe(true);
    expect(l.qty).toBe(150);        // הכמות נשמרת לתצוגה
    expect(l.unit).toBe('גרם');     // אבל לא הוצמדה ליחידה
  });

  it('"2 יחידות" על פריט שנמדד בק"ג → לא מקושר', () => {
    const l = one({ name: 'אורז', matchedItemId: 'i-rice', qty: 2, unit: 'יחידה' });
    expect(l.matchedItemId).toBeNull();
    expect(l.unitMismatch).toBe(true);
  });

  it('יחידת פריט שהמערכת לא מכירה → לא מקושר', () => {
    const l = one({ name: 'מוזר', matchedItemId: 'i-weird', qty: 1, unit: 'ליטר' });
    expect(l.matchedItemId).toBeNull();
    expect(l.unitMismatch).toBe(true);
  });

  it('יחידה שה-AI המציא → לא מקושר', () => {
    const l = one({ name: 'אורז', matchedItemId: 'i-rice', qty: 1, unit: 'חופן' });
    expect(l.matchedItemId).toBeNull();
    expect(l.unitMismatch).toBe(true);
  });
});

describe('תיאור לפי עלות בשקלים', () => {
  it('מחשב כמות מעלות הפריט ולוקח את יחידת הפריט', () => {
    const l = one({ name: 'אורז', matchedItemId: 'i-rice', qty: null, unit: null, costShekels: 6 });
    expect(l.qty).toBe(0.5);          // 6 ₪ / 12 ₪ לק"ג
    expect(l.unit).toBe('ק"ג');
    expect(l.matchedItemId).toBe('i-rice');
    expect(l.isApproximate).toBe(true);
  });

  it('עלות בלי פריט מותאם — לא ממציא כמות', () => {
    const l = one({ name: 'תבלינים', matchedItemId: null, qty: null, unit: null, costShekels: 3 });
    expect(l.qty).toBeNull();
    expect(l.costShekels).toBe(3);
    expect(l.matchedItemId).toBeNull();
  });
});

describe('קלט פגום מה-AI', () => {
  it('כמות שלילית / אפס / לא מספר → null', () => {
    expect(one({ name: 'אורז', matchedItemId: 'i-rice', qty: -5, unit: 'גרם' }).qty).toBeNull();
    expect(one({ name: 'אורז', matchedItemId: 'i-rice', qty: 0, unit: 'גרם' }).qty).toBeNull();
    expect(one({ name: 'אורז', matchedItemId: 'i-rice', qty: '250', unit: 'גרם' }).qty).toBeNull();
  });

  it('מזהה פריט שלא קיים בקטלוג → לא מקושר', () => {
    const l = one({ name: 'משהו', matchedItemId: 'i-nope', qty: 1, unit: 'גרם' });
    expect(l.matchedItemId).toBeNull();
  });

  it('שורה בלי שם מסוננת', () => {
    expect(normalizeParsedLines([{ name: '', qty: 1, unit: 'גרם' }], CATALOG)).toHaveLength(0);
  });

  it('מערך ריק / null לא מפיל', () => {
    expect(normalizeParsedLines([], CATALOG)).toEqual([]);
    expect(normalizeParsedLines(null, CATALOG)).toEqual([]);
    expect(normalizeParsedLines([{ name: 'אורז' }], null)).toHaveLength(1);
  });
});
