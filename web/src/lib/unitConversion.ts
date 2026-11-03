// ═══════════════════════════════════════════════════════════
//  UNIT CONVERSION ENGINE
//  Shared by the recipe/dish ingredient editors (weight ↔ volume ↔
//  packaging-unit conversion, invoice-price → recipe-unit-price math).
//  Extracted out of recipes/page.tsx so this pure logic can be unit-tested
//  independently of the page component — see unitConversion.test.ts.
// ═══════════════════════════════════════════════════════════

export type UnitFamily = 'weight' | 'volume' | 'unit';

export interface UnitDef { family: UnitFamily; factor: number; label: string; short: string; }

export const UNIT_MAP: Record<string, UnitDef> = {
  // משקל (בסיס = גרם)
  'גרם':       { family: 'weight', factor: 1,        label: 'גרם',           short: 'גרם'   },
  'מיליגרם':   { family: 'weight', factor: 0.001,    label: 'מיליגרם',       short: 'מ"ג'  },
  'קילוגרם':   { family: 'weight', factor: 1000,     label: 'קילוגרם',       short: 'ק"ג'  },
  'טון':       { family: 'weight', factor: 1000000,  label: 'טון',           short: 'טון'   },
  // aliases
  g:           { family: 'weight', factor: 1,        label: 'גרם',           short: 'גרם'   },
  mg:          { family: 'weight', factor: 0.001,    label: 'מיליגרם',       short: 'מ"ג'  },
  kg:          { family: 'weight', factor: 1000,     label: 'קילוגרם',       short: 'ק"ג'  },
  "ק\"ג":      { family: 'weight', factor: 1000,     label: 'קילוגרם',       short: 'ק"ג'  },
  // נפח (בסיס = מ"ל)
  'מיליליטר':  { family: 'volume', factor: 1,        label: 'מיליליטר',      short: 'מ"ל'  },
  'סנטיליטר':  { family: 'volume', factor: 10,       label: 'סנטיליטר',      short: 'סמ"ל' },
  'דציליטר':   { family: 'volume', factor: 100,      label: 'דציליטר',       short: 'ד"ל'  },
  'ליטר':      { family: 'volume', factor: 1000,     label: 'ליטר',          short: 'ל׳'   },
  'כוס':       { family: 'volume', factor: 240,      label: 'כוס (240 מ"ל)', short: 'כוס'   },
  'כף':        { family: 'volume', factor: 15,       label: 'כף (15 מ"ל)',   short: 'כף'    },
  'כפית':      { family: 'volume', factor: 5,        label: 'כפית (5 מ"ל)',  short: 'כפית'  },
  'כף גדולה':  { family: 'volume', factor: 20,       label: 'כף גדולה',      short: 'כ"ג'  },
  // aliases
  ml:          { family: 'volume', factor: 1,        label: 'מיליליטר',      short: 'מ"ל'  },
  cl:          { family: 'volume', factor: 10,       label: 'סנטיליטר',      short: 'סמ"ל' },
  l:           { family: 'volume', factor: 1000,     label: 'ליטר',          short: 'ל׳'   },
  "מ\"ל":      { family: 'volume', factor: 1,        label: 'מיליליטר',      short: 'מ"ל'  },
  // ספירה / אריזות (בסיס = יחידה)
  'יחידה':     { family: 'unit',   factor: 1,        label: 'יחידה',         short: 'יח׳'  },
  'חבילה':     { family: 'unit',   factor: 1,        label: 'חבילה',         short: 'חבילה' },
  'קרטון':     { family: 'unit',   factor: 1,        label: 'קרטון',         short: 'קרטון' },
  'ארגז':      { family: 'unit',   factor: 1,        label: 'ארגז',          short: 'ארגז'  },
  'בקבוק':     { family: 'unit',   factor: 1,        label: 'בקבוק',         short: 'בקבוק' },
  'פחית':      { family: 'unit',   factor: 1,        label: 'פחית',          short: 'פחית'  },
  'שקית':      { family: 'unit',   factor: 1,        label: 'שקית',          short: 'שקית'  },
  'צרור':      { family: 'unit',   factor: 1,        label: 'צרור',          short: 'צרור'  },
  'ענף':       { family: 'unit',   factor: 1,        label: 'ענף',           short: 'ענף'   },
  'ראש':       { family: 'unit',   factor: 1,        label: 'ראש',           short: 'ראש'   },
  'פרוסה':     { family: 'unit',   factor: 1,        label: 'פרוסה',         short: 'פרוסה' },
  'כיכר':      { family: 'unit',   factor: 1,        label: 'כיכר',          short: 'כיכר'  },
  'ביצה':      { family: 'unit',   factor: 1,        label: 'ביצה',          short: 'ביצה'  },
  'שן שום':    { family: 'unit',   factor: 1,        label: 'שן שום',        short: 'שן'    },
  'עלה':       { family: 'unit',   factor: 1,        label: 'עלה',           short: 'עלה'   },
  // aliases
  "יח'":       { family: 'unit',   factor: 1,        label: 'יחידה',         short: 'יח׳'  },
  יח:          { family: 'unit',   factor: 1,        label: 'יחידה',         short: 'יח׳'  },
  unit:        { family: 'unit',   factor: 1,        label: 'יחידה',         short: 'יח׳'  },
  pcs:         { family: 'unit',   factor: 1,        label: 'יחידה',         short: 'יח׳'  },
};

export const UNITS_BY_FAMILY: Record<UnitFamily, string[]> = {
  weight: ['גרם', 'קילוגרם', 'מיליגרם', 'טון'],
  volume: ['מיליליטר', 'ליטר', 'כוס', 'כף', 'כפית', 'סנטיליטר', 'דציליטר', 'כף גדולה'],
  unit:   ['יחידה', 'חבילה', 'קרטון', 'ארגז', 'בקבוק', 'פחית', 'שקית', 'צרור', 'ענף', 'ראש', 'פרוסה', 'כיכר', 'ביצה', 'שן שום', 'עלה'],
};

// מנרמל תווי פיסוק עבריים/טיפוגרפיים חלופיים (גרשיים ״ / גרש ׳ / מרכאות מעוצבות)
// לצורת ASCII הרגילה, כדי ש"ק״ג" (AI/הקלדה עברית) יתאים לאותו מפתח כמו "ק"ג".
export function normalizeUnitPunctuation(s: string): string {
  return s.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'");
}

export function resolveUnit(raw: string | null | undefined): UnitDef | null {
  if (!raw) return null;
  const norm = normalizeUnitPunctuation(raw.trim());
  return UNIT_MAP[norm] || UNIT_MAP[norm.toLowerCase()] || null;
}

/** price per recipe-unit from invoice price-per-invoice-unit */
export function pricePerRecipeUnit(invoicePrice: number, invoiceUnit: string, recipeUnit: string): number | null {
  const inv = resolveUnit(invoiceUnit);
  const rec = resolveUnit(recipeUnit);
  if (!inv || !rec || inv.family !== rec.family) return null;
  // Every entry in the 'unit' family (יחידה/חבילה/קרטון/ארגז/בקבוק/פחית/...)
  // is defined with factor:1 — there's no universal ratio between a case and
  // a single can the way there is between kg and g, so treating same-family
  // as automatically convertible silently carried a case/pack price over as
  // if it were the price of one piece (e.g. "ארגז קולה ₪63" shown as ₪63 per
  // single פחית after switching units). Only true aliases of the exact same
  // unit (same canonical label — e.g. "יח'"↔"יחידה") are safe to convert;
  // anything else needs a manual price.
  if (inv.family === 'unit' && inv.label !== rec.label) return null;
  // e.g. inv=kg(1000), rec=g(1), invoicePrice=50 → 50*(1/1000) = 0.05 ₪/g
  return invoicePrice * (rec.factor / inv.factor);
}

export function lineCost(qty: number, costPerRecipeUnit: number | null): number {
  return qty * (costPerRecipeUnit ?? 0);
}

export function getDefaultRecipeUnit(invoiceUnit: string): string {
  const u = resolveUnit(invoiceUnit);
  if (!u) return invoiceUnit || 'יחידה';
  if (u.family === 'weight') return 'גרם';
  if (u.family === 'volume') return 'מיליליטר';
  // Unlike weight/volume, the 'unit' family (יחידה/חבילה/קרטון/ארגז/פחית/...)
  // has no real conversion factor between its members (see pricePerRecipeUnit)
  // — defaulting every packaged item to a generic 'יחידה' used to silently
  // carry the invoice's case/pack price over as if it priced a single piece
  // (e.g. "ארגז קולה ₪63" shown as ₪63/יחידה). Default to the invoice's own
  // unit instead, so the line starts with a genuinely correct price; the
  // dropdown still lets the user pick a different unit and enter its real price.
  return u.label;
}
