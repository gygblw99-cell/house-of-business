import { resolveUnit, pricePerRecipeUnit, getDefaultRecipeUnit, lineCost } from './unitConversion';

describe('resolveUnit', () => {
  it('resolves a plain Hebrew unit', () => {
    expect(resolveUnit('גרם')?.family).toBe('weight');
    expect(resolveUnit('קילוגרם')?.family).toBe('weight');
    expect(resolveUnit('ליטר')?.family).toBe('volume');
    expect(resolveUnit('ארגז')?.family).toBe('unit');
  });

  it('normalizes typographic quote variants to the same key', () => {
    // ק״ג (Hebrew gershayim, U+05F4) must resolve the same as ק"ג (ASCII quote)
    expect(resolveUnit('ק״ג')?.label).toBe('קילוגרם');
    expect(resolveUnit('ק"ג')?.label).toBe('קילוגרם');
  });

  it('returns null for unknown units and empty input', () => {
    expect(resolveUnit('משהו-לא-קיים')).toBeNull();
    expect(resolveUnit('')).toBeNull();
    expect(resolveUnit(null)).toBeNull();
    expect(resolveUnit(undefined)).toBeNull();
  });
});

describe('pricePerRecipeUnit', () => {
  it('converts correctly within the weight family (kg -> g)', () => {
    // 50 ₪/kg -> 0.05 ₪/g
    expect(pricePerRecipeUnit(50, 'קילוגרם', 'גרם')).toBeCloseTo(0.05);
  });

  it('converts correctly within the volume family (liter -> ml)', () => {
    expect(pricePerRecipeUnit(10, 'ליטר', 'מיליליטר')).toBeCloseTo(0.01);
  });

  it('returns null across mismatched families (weight vs volume)', () => {
    expect(pricePerRecipeUnit(50, 'קילוגרם', 'ליטר')).toBeNull();
  });

  // Regression test for the real production bug found 2026-08-03: a case of
  // Coke invoiced at ₪63 (unit "ארגז") showed as ₪63 for a single can after
  // switching the recipe unit to "פחית" — because every packaging unit
  // shares factor:1, so same-family was wrongly treated as freely
  // convertible. Only true aliases of the exact same unit may convert;
  // different packaging types must not.
  it('does NOT convert between different packaging units even though they share the "unit" family', () => {
    expect(pricePerRecipeUnit(63, 'ארגז', 'פחית')).toBeNull();
    expect(pricePerRecipeUnit(63, 'ארגז', 'יחידה')).toBeNull();
  });

  it('DOES convert between true aliases of the same unit (same canonical label)', () => {
    // "יח'" and "יחידה" are different raw strings but the same real unit
    expect(pricePerRecipeUnit(10, "יח'", 'יחידה')).toBe(10);
    expect(pricePerRecipeUnit(10, 'יחידה', "יח'")).toBe(10);
  });

  it('returns null when either unit is unresolvable', () => {
    expect(pricePerRecipeUnit(10, 'לא-קיים', 'גרם')).toBeNull();
    expect(pricePerRecipeUnit(10, 'גרם', 'לא-קיים')).toBeNull();
  });
});

describe('getDefaultRecipeUnit', () => {
  it('defaults weight/volume invoice units to the base recipe unit (gram/ml)', () => {
    expect(getDefaultRecipeUnit('קילוגרם')).toBe('גרם');
    expect(getDefaultRecipeUnit('ליטר')).toBe('מיליליטר');
  });

  // Regression test for the same 2026-08-03 bug: previously this returned a
  // generic 'יחידה' for ANY packaging unit, which silently broke the price
  // (see pricePerRecipeUnit test above) as soon as the line was added.
  it('defaults a packaging-family invoice unit to itself, not a generic יחידה', () => {
    expect(getDefaultRecipeUnit('ארגז')).toBe('ארגז');
    expect(getDefaultRecipeUnit('פחית')).toBe('פחית');
  });

  it('falls back to the raw string when the unit is unrecognized', () => {
    expect(getDefaultRecipeUnit('משהו-מוזר')).toBe('משהו-מוזר');
  });
});

describe('lineCost', () => {
  it('multiplies quantity by cost per unit', () => {
    expect(lineCost(3, 2.5)).toBe(7.5);
  });

  it('treats a null cost-per-unit as zero (no computed price yet)', () => {
    expect(lineCost(3, null)).toBe(0);
  });
});
