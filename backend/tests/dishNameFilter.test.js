/**
 * _isValidDishName — the gate that decides whether a name seen in a Z report
 * becomes a dish.
 *
 * Why this file exists: the guard meant to reject "a name with no letters at
 * all" was written as /^[\W\d]+$/. In JS without the /u flag \w is [A-Za-z0-9_],
 * so every Hebrew letter matches \W and "שניצל" looked like it had no letters.
 * From the day that filter shipped (6.8.2026) until it was fixed, NOT ONE dish
 * was auto-created from a Z report in any business — an empty dishes page for
 * every new business, and therefore no inventory deduction at all, with no error
 * logged anywhere (the caller wraps the sync in `.catch(() => {})`).
 *
 * A Hebrew dish name MUST pass. That is the whole point of these tests.
 */

const { isValidDishName } = require('../src/services/zreport.import.service');

describe('שמות עבריים חייבים לעבור — הרגרסיה שהשביתה יצירת מנות', () => {
  const HEBREW_DISHES = [
    'שניצל',
    'סלט ירקות',
    'מגש עוף',
    'פסטה רוזה',
    'המבורגר קלאסי',
    'כריך אסאדו',
    'מנה בשרית במגש',
    'שווארמה בלאפה',
    'קפה הפוך',
  ];
  it.each(HEBREW_DISHES)('"%s" → מנה חוקית', (name) => {
    expect(isValidDishName(name)).toBe(true);
  });

  it('שם עברי עם ספרות עובר', () => {
    expect(isValidDishName('אונטריב 100 גר')).toBe(true);
    expect(isValidDishName('פיצה 32 ס"מ')).toBe(true);
  });

  it('שם באנגלית ומעורב עובר', () => {
    expect(isValidDishName('RICEBOWL')).toBe(true);
    expect(isValidDishName('Rice Bowl בקר')).toBe(true);
  });
});

describe('מה שאינו שם מנה נדחה', () => {
  it('ריק / קצר מדי', () => {
    expect(isValidDishName('')).toBe(false);
    expect(isValidDishName(null)).toBe(false);
    expect(isValidDishName(undefined)).toBe(false);
    expect(isValidDishName('א')).toBe(false);
    expect(isValidDishName(' ')).toBe(false);
  });

  it('מספר טהור', () => {
    expect(isValidDishName('42')).toBe(false);
    expect(isValidDishName('3.50')).toBe(false);
    expect(isValidDishName('1,20')).toBe(false);
  });

  it('בלי אף אות — פיסוק/סמלים בלבד', () => {
    expect(isValidDishName('---')).toBe(false);
    expect(isValidDishName('###')).toBe(false);
    expect(isValidDishName('12 + 34')).toBe(false);
    expect(isValidDishName('₪₪')).toBe(false);
  });

  it('אמצעי תשלום שקופות רושמות כפריט', () => {
    expect(isValidDishName('מזומן')).toBe(false);
    expect(isValidDishName('אשראי')).toBe(false);
    expect(isValidDishName('וולט')).toBe(false);
    expect(isValidDishName('תן ביס')).toBe(false);
    expect(isValidDishName('משלוח')).toBe(false);
  });

  it('שורות סיכום של דוח Z', () => {
    expect(isValidDishName('סה"כ')).toBe(false);
    expect(isValidDishName('מע"מ')).toBe(false);
    expect(isValidDishName('Z-604')).toBe(false);
    expect(isValidDishName('TOTAL')).toBe(false);
  });
});
