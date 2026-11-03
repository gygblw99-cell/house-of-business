// Backend mirror of web/src/lib/unitConversion.ts — only what's needed to
// normalize a recipe/dish ingredient's qty+unit into the SAME specific unit
// the linked inventory item is priced in (see recipe.model.js/dish.model.js
// setIngredients for why: the cost SQL does qty * ii.cost_per_unit with no
// conversion, so qty must already be in ii.unit's terms before it's stored).

const UNIT_MAP = {
  // משקל (בסיס = גרם)
  'גרם':       { family: 'weight', factor: 1 },
  'מיליגרם':   { family: 'weight', factor: 0.001 },
  'קילוגרם':   { family: 'weight', factor: 1000 },
  'טון':       { family: 'weight', factor: 1000000 },
  g:           { family: 'weight', factor: 1 },
  mg:          { family: 'weight', factor: 0.001 },
  kg:          { family: 'weight', factor: 1000 },
  'ק"ג':       { family: 'weight', factor: 1000 },
  // נפח (בסיס = מ"ל)
  'מיליליטר':  { family: 'volume', factor: 1 },
  'סנטיליטר':  { family: 'volume', factor: 10 },
  'דציליטר':   { family: 'volume', factor: 100 },
  'ליטר':      { family: 'volume', factor: 1000 },
  'כוס':       { family: 'volume', factor: 240 },
  'כף':        { family: 'volume', factor: 15 },
  'כפית':      { family: 'volume', factor: 5 },
  'כף גדולה':  { family: 'volume', factor: 20 },
  ml:          { family: 'volume', factor: 1 },
  cl:          { family: 'volume', factor: 10 },
  l:           { family: 'volume', factor: 1000 },
  'מ"ל':       { family: 'volume', factor: 1 },
  // ספירה / אריזות — אין יחס אמיתי בין חברי המשפחה (ראה pricePerRecipeUnit
  // ב-web/src/lib/unitConversion.ts), רק כינויים לאותה יחידה ממש נחשבים תואמים
  'יחידה':     { family: 'unit', factor: 1, canonical: 'יחידה' },
  "יח'":       { family: 'unit', factor: 1, canonical: 'יחידה' },
  יח:          { family: 'unit', factor: 1, canonical: 'יחידה' },
  unit:        { family: 'unit', factor: 1, canonical: 'יחידה' },
  pcs:         { family: 'unit', factor: 1, canonical: 'יחידה' },
  'חבילה':     { family: 'unit', factor: 1, canonical: 'חבילה' },
  'קרטון':     { family: 'unit', factor: 1, canonical: 'קרטון' },
  'ארגז':      { family: 'unit', factor: 1, canonical: 'ארגז' },
  'בקבוק':     { family: 'unit', factor: 1, canonical: 'בקבוק' },
  'פחית':      { family: 'unit', factor: 1, canonical: 'פחית' },
  'שקית':      { family: 'unit', factor: 1, canonical: 'שקית' },
  'צרור':      { family: 'unit', factor: 1, canonical: 'צרור' },
  'ענף':       { family: 'unit', factor: 1, canonical: 'ענף' },
  'ראש':       { family: 'unit', factor: 1, canonical: 'ראש' },
  'פרוסה':     { family: 'unit', factor: 1, canonical: 'פרוסה' },
  'כיכר':      { family: 'unit', factor: 1, canonical: 'כיכר' },
  'ביצה':      { family: 'unit', factor: 1, canonical: 'ביצה' },
  'שן שום':    { family: 'unit', factor: 1, canonical: 'שן שום' },
  'עלה':       { family: 'unit', factor: 1, canonical: 'עלה' },
};

function normalizeUnitPunctuation(s) {
  return s.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'");
}

function resolveUnit(raw) {
  if (!raw) return null;
  const norm = normalizeUnitPunctuation(String(raw).trim());
  return UNIT_MAP[norm] || UNIT_MAP[norm.toLowerCase()] || null;
}

// Converts qty (in fromUnit) into the equivalent qty in toUnit.
// Returns null when the two units aren't safely convertible (unknown unit,
// different family, or same-family-but-different-package-size in the
// 'unit' family — e.g. ארגז vs פחית have no fixed ratio).
function convertQty(qty, fromUnit, toUnit) {
  const from = resolveUnit(fromUnit);
  const to   = resolveUnit(toUnit);
  if (!from || !to || from.family !== to.family) return null;
  if (from.family === 'unit' && from.canonical !== to.canonical) return null;
  return qty * (from.factor / to.factor);
}

module.exports = { resolveUnit, convertQty };
