/**
 * Ingredient leakage — measurement window and coverage reporting.
 *
 * The behaviour under test is the one that made this feature useless: with no
 * physical stock counts, "actual usage" is derived from the automatic per-sale
 * deductions, which are themselves computed from the recipes — the same input
 * "expected usage" comes from. Variance could then only ever be ≤ 0, so the
 * agent reported "אין דליפות — המתכונים מיושמים כראוי" on every business,
 * forever, and the owner was told to stop looking.
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));

const db = require('../src/utils/db');
const { detectIngredientLeakage } = require('../src/agents/ingredientLeakage.agent');

const COUNT_A = new Date('2026-08-01T08:00:00Z');
const COUNT_B = new Date('2026-08-08T08:00:00Z');

/** Routes each of the agent's parallel queries by a fragment unique to it. */
function mockDb({ stocktakes = [], expected = [], actual = [], coverageSales = null, coverageDefs = null }) {
  db.query.mockImplementation((sql) => {
    if (sql.includes("type = 'stocktake'") && sql.includes('GROUP BY 1'))
      return Promise.resolve({ rows: stocktakes.map(ts => ({ ts })) });
    if (sql.includes('expected_qty') && sql.includes('HAVING'))
      return Promise.resolve({ rows: expected });
    if (sql.includes('actual_qty'))
      return Promise.resolve({ rows: actual });
    if (sql.includes('qty_linked'))
      return Promise.resolve({ rows: [coverageSales || { qty_total: 100, qty_linked: 90, names_total: 10, names_linked: 9 }] });
    if (sql.includes('recipes_total'))
      return Promise.resolve({ rows: [coverageDefs || {
        recipes_total: 10, recipes_with_ingredients: 9,
        items_total: 20, items_costed: 20, duplicate_item_names: [],
      }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => db.query.mockReset());

describe('measurement basis', () => {
  it('ללא ספירות מלאי → derived, ולא מוצג כ"אין דליפות"', async () => {
    mockDb({ stocktakes: [] });

    const res = await detectIngredientLeakage('biz-1', 7);

    expect(res.coverage.basis).toBe('derived');
    expect(res.coverage.verifiable).toBe(false);
    expect(res.summary.riskLevel).toBe('unknown');
    expect(res.summary.headline).toContain('חסרה ספירת מלאי');
    // The reassuring wording must not appear — it is what stopped owners looking
    expect(res.summary.headline).not.toContain('אין דליפות רווח');
  });

  it('כל ענפי הסיכום מחזירים verified מפורש', async () => {
    // The frontend maps riskLevel to a colour and picks the green "מצב תקין"
    // for anything it doesn't recognise, so a branch that forgets `verified`
    // or emits an unmapped riskLevel renders an unmeasurable result as an
    // all-clear — the precise failure this whole change removes.
    for (const stocktakes of [[], [COUNT_A, COUNT_B]]) {
      mockDb({ stocktakes });
      const res = await detectIngredientLeakage('biz-1', 7);
      expect(typeof res.summary.verified).toBe('boolean');
      expect(['low', 'medium', 'high', 'unknown']).toContain(res.summary.riskLevel);
    }
  });

  it('ספירה אחת בלבד עדיין אינה מספיקה — צריך שתיים כדי לחסום תקופה', async () => {
    mockDb({ stocktakes: [COUNT_A] });

    const res = await detectIngredientLeakage('biz-1', 7);

    expect(res.coverage.basis).toBe('derived');
    expect(res.coverage.stocktakeCount).toBe(1);
  });

  it('שתי ספירות → counted, והחלון נקבע לפיהן', async () => {
    mockDb({ stocktakes: [COUNT_A, COUNT_B] });

    const res = await detectIngredientLeakage('biz-1', 30);

    expect(res.coverage.basis).toBe('counted');
    expect(res.coverage.verifiable).toBe(true);
    expect(res.coverage.windowFrom).toEqual(COUNT_A);
    expect(res.coverage.windowTo).toEqual(COUNT_B);
    expect(res.summary.headline).toContain('אין דליפות');
  });
});

describe('window is shared by expected and actual', () => {
  it('שתי השאילתות מוגבלות לאותו טווח בדיוק', async () => {
    mockDb({ stocktakes: [COUNT_A, COUNT_B] });
    await detectIngredientLeakage('biz-1', 30);

    // Expected ran over 30 days of sales while actual ran over however long
    // deductions had existed — that mismatch alone produced permanent −80%
    // variances that silently suppressed every finding.
    //
    // _getWeeklyTrend is deliberately excluded: it uses its own fixed 4×7-day
    // buckets for the sparkline and is documented as approximate, so it takes
    // businessId only. Matched on HAVING / opening, which only the two
    // window-bound queries carry.
    const params = db.query.mock.calls
      .filter(([sql]) => sql.includes('f.qty * ing.qty') || sql.includes('opening AS ('))
      .map(([, p]) => p);

    expect(params.length).toBeGreaterThanOrEqual(2);
    for (const p of params) {
      expect(p).toContain(COUNT_A);
      expect(p).toContain(COUNT_B);
    }
  });

  it('במצב counted, הצריכה נמדדת כפתיחה + רכישות − סגירה − פחת', async () => {
    mockDb({ stocktakes: [COUNT_A, COUNT_B] });
    await detectIngredientLeakage('biz-1', 30);

    const sql = db.query.mock.calls.map(c => c[0]).find(s => s.includes('actual_qty'));
    expect(sql).toContain('opening');
    expect(sql).toContain('closing');
    // A count corrects the books; treating it as an inbound delivery would
    // manufacture consumption that never happened.
    expect(sql).toContain("type IN ('purchase','manual_adjust')");
  });
});

describe('coverage reporting', () => {
  it('מדווח כיסוי חלקי כשרוב המכירות לא מחוברות למתכון', async () => {
    mockDb({
      stocktakes:    [COUNT_A, COUNT_B],
      coverageSales: { qty_total: 100, qty_linked: 30, names_total: 40, names_linked: 12 },
    });

    const res = await detectIngredientLeakage('biz-1', 30);

    expect(res.coverage.salesLinkedPct).toBe(30);
    expect(res.coverage.unlinkedSaleNames).toBe(28);
    expect(res.summary.riskLevel).toBe('unknown');
    expect(res.summary.headline).toContain('הכיסוי חלקי');
  });

  it('חושף פריטי מלאי כפולים בשם זהה', async () => {
    mockDb({
      stocktakes:   [COUNT_A, COUNT_B],
      coverageDefs: {
        recipes_total: 10, recipes_with_ingredients: 9,
        items_total: 20, items_costed: 20, duplicate_item_names: ['גבטה'],
      },
    });

    const res = await detectIngredientLeakage('biz-1', 30);

    expect(res.coverage.duplicateItemNames).toEqual(['גבטה']);
  });

  it('ממצא במצב derived מסומן כהערכה ולא כמדידה', async () => {
    mockDb({
      stocktakes: [],
      expected: [{ item_id: 'i1', name: 'שמן', unit: 'ליטר', cost_per_unit: 30, expected_qty: 10 }],
      actual:   [{ item_id: 'i1', name: 'שמן', unit: 'ליטר', cost_per_unit: 30, actual_qty: 14, waste_qty: 0 }],
    });

    const res = await detectIngredientLeakage('biz-1', 7);

    expect(res.items).toHaveLength(1);
    expect(res.summary.verified).toBe(false);
    expect(res.summary.detail).toContain('הערכה');
  });
});
