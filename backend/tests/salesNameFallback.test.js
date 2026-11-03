/**
 * salesNameFallback — ניכוי מלאי לפי שם הפריט הנמכר כשאין מנה/מתכון.
 *
 * הטסטים האלה שומרים בעיקר על הצד ה*שלילי*: המודול כותב ישר ל-inventory_items,
 * ולכן כל התאמה שגויה היא מלאי שנמחק בשקט. רוב המקרים כאן הם דווקא "אסור לנכות".
 */

const {
  normalizeName, distinctiveTokens, parseQtyFromName, unitFamily,
  matchInventoryItem, resolveFallbackDeduction,
} = require('../src/utils/salesNameFallback');

// קטלוג מלאי אמיתי-בקטנה, כולל פריט אריזה עם שם משובש מ-OCR — הוא זה שחשף
// את ההתאמה השגויה "סלט בקר" → "...שקיות בקרטון".
const ITEMS = [
  { id: 'i-rice',    name: 'אורז יסמין שוקחה 5 קג מחולק (מדליה)', unit: 'ק"ג' },
  { id: 'i-chicken', name: 'חזה עוף טרי עטרה',                     unit: 'ק"ג' },
  { id: 'i-beans',   name: 'שעועית ירוקה שלמה אי',                 unit: 'ק"ג' },
  { id: 'i-oil',     name: 'שמן חמניות 5 ליטר',                    unit: 'ליטר' },
  { id: 'i-cola',    name: 'קולה פחיות',                           unit: 'יחידה' },
  { id: 'i-pita',    name: 'גבטה',                                 unit: 'יחידה' },
  { id: 'i-carton',  name: 'מיליק מיסולית לדלי - 4 שקיות בקרטון',  unit: 'יח\'' },
];

describe('parseQtyFromName', () => {
  it('גרמים → ק"ג', () => {
    expect(parseQtyFromName('אונטריב | 100 גר')).toEqual({ amount: 0.1, family: 'mass' });
    expect(parseQtyFromName('תוספת 50 גרם בשר')).toEqual({ amount: 0.05, family: 'mass' });
  });

  it('קילוגרם ומיליליטר/ליטר', () => {
    expect(parseQtyFromName('אורז 1 קג')).toEqual({ amount: 1, family: 'mass' });
    expect(parseQtyFromName('שמן 500 מל')).toEqual({ amount: 0.5, family: 'volume' });
    expect(parseQtyFromName('מים 1.5 ליטר')).toEqual({ amount: 1.5, family: 'volume' });
  });

  it('מספר בלי יחידת מידה אינו משקל', () => {
    expect(parseQtyFromName('תוספת סלט 5 שח')).toBeNull();
    expect(parseQtyFromName('X1')).toBeNull();
    expect(parseQtyFromName('מנה בשרית במגש + 2 תוספות')).toBeNull();
  });
});

describe('unitFamily', () => {
  it('מזהה משקל / נפח / יחידות', () => {
    expect(unitFamily('ק"ג')).toBe('mass');
    expect(unitFamily('קילוגרם')).toBe('mass');
    expect(unitFamily('ליטר')).toBe('volume');
    expect(unitFamily('יחידה')).toBe('count');
    expect(unitFamily("יח'")).toBe('count');
  });

  it('יחידה לא מוכרת → null', () => {
    expect(unitFamily('מגש')).toBeNull();
    expect(unitFamily('')).toBeNull();
  });
});

describe('distinctiveTokens', () => {
  it('מסלק מילים גנריות, מספרים ויחידות מידה', () => {
    expect(distinctiveTokens('תוספת 50 גרם בשר')).toEqual(['בשר']);
    expect(distinctiveTokens('פחית קוקה קולה')).toEqual(['קוקה', 'קולה']);
    expect(distinctiveTokens('בריסקט במשקל')).toEqual(['בריסקט']);
  });

  it('מנרמל גרשיים ומפרידים', () => {
    expect(normalizeName('אונטריב | 100 גר')).toBe('אונטריב 100 גר');
    expect(distinctiveTokens("תוספות 100 גר'")).toEqual([]);
  });
});

describe('matchInventoryItem — הצד השלילי', () => {
  it('לא מתאים על סמך תחילית מדומה (בקר ≠ בקרטון)', () => {
    // הרגרסיה שהתגלתה על נתוני אמת: היה מנכה 60 יחידות מפריט אריזה.
    expect(matchInventoryItem('סלט בקר', ITEMS)).toBeNull();
    expect(matchInventoryItem('כריך קציצות בקר', ITEMS)).toBeNull();
  });

  it('לא מתאים על סמך מילה גנרית בלבד', () => {
    // "פחית" גנרית, ולכן "ספרייט" הוא הטוקן היחיד — ואין לו פריט מלאי.
    expect(matchInventoryItem('פחית ספרייט', ITEMS)).toBeNull();
  });

  it('חומר גלם שלא קיים במלאי → null', () => {
    expect(matchInventoryItem('בריסקט במשקל', ITEMS)).toBeNull();
    expect(matchInventoryItem('אונטריב | 100 גר', ITEMS)).toBeNull();
  });

  it('מתאים כשיש טוקן מזהה משותף', () => {
    expect(matchInventoryItem('אורז יסמין 1 קג', ITEMS).id).toBe('i-rice');
    expect(matchInventoryItem('שעועית ירוקה', ITEMS).id).toBe('i-beans');
    expect(matchInventoryItem('תוספת עוף 50 גרם', ITEMS).id).toBe('i-chicken');
  });

  it('ריבוי/נטייה אינם מתאימים — החלטה מכוונת', () => {
    // ההשוואה היא זהות מדויקת. ריבוי עברי אינו תחילית ("שעועיות" לא מתחיל
    // ב"שעועית"), וכל כלל מקל שנבדק יצר התאמות שקר מסוכנות יותר משהועיל.
    // עדיף שהמנה תישאר בהתראת "מרכיבים חסרים" מלאנכות מפריט הלא נכון.
    const items = [{ id: 'x', name: 'שעועיות ירוקות', unit: 'ק"ג' }];
    expect(matchInventoryItem('שעועית ירוקה 200 גרם', items)).toBeNull();
  });
});

describe('resolveFallbackDeduction', () => {
  it('משקל בשם + פריט במשקל → מנכה משקל × כמות', () => {
    const r = resolveFallbackDeduction('תוספת עוף 50 גרם', 7, ITEMS);
    expect(r.itemId).toBe('i-chicken');
    expect(r.qty).toBeCloseTo(0.35, 6);
  });

  it('פריט ביחידות בלי משקל בשם → יחידה אחת למכירה', () => {
    const r = resolveFallbackDeduction('גבטה', 12, ITEMS);
    expect(r.itemId).toBe('i-pita');
    expect(r.qty).toBe(12);
  });

  it('פריט במשקל בלי משקל בשם → לא מנכה (גודל מנה לא ידוע)', () => {
    expect(resolveFallbackDeduction('שעועית ירוקה', 9, ITEMS)).toBeNull();
    expect(resolveFallbackDeduction('כריך עוף', 4, ITEMS)).toBeNull();
  });

  it('אי-התאמה בין משפחות מידה → לא מנכה', () => {
    // 100 גרם מול פריט שנמדד בליטר
    const items = [{ id: 'v', name: 'רוטב שזיפים', unit: 'ליטר' }];
    expect(resolveFallbackDeduction('רוטב שזיפים 100 גרם', 1, items)).toBeNull();
  });

  it('מנה מורכבת → לא מנכה', () => {
    expect(resolveFallbackDeduction('מנה בשרית במגש + 2 תוספות', 40, ITEMS)).toBeNull();
  });

  it('כמות לא חוקית → לא מנכה', () => {
    expect(resolveFallbackDeduction('גבטה', 0, ITEMS)).toBeNull();
    expect(resolveFallbackDeduction('גבטה', -3, ITEMS)).toBeNull();
    expect(resolveFallbackDeduction('גבטה', null, ITEMS)).toBeNull();
  });

  it('קטלוג מלאי ריק → לא מנכה', () => {
    expect(resolveFallbackDeduction('אורז יסמין 1 קג', 5, [])).toBeNull();
  });

  it('שתי התאמות שוות → לא מנכה (דו-משמעי)', () => {
    const items = [
      { id: 'a', name: 'עוף שלם', unit: 'ק"ג' },
      { id: 'b', name: 'עוף פרוס', unit: 'ק"ג' },
    ];
    expect(resolveFallbackDeduction('עוף 100 גרם', 1, items)).toBeNull();
  });
});
