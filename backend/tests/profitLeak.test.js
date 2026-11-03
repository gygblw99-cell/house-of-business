/**
 * Profit-leak detection — unit tests for the behaviours that were silently
 * broken before: the loss/revenue-gap split, the materiality floors, the
 * closed-day guard, and the cost-source resolution that decides whether a dish
 * is costed from a stale partial recipe or from its fully-linked dish record.
 */

jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));

const db = require('../src/utils/db');
const { detectProfitLeaks } = require('../src/agents/profitLeak.agent');
const {
  INGREDIENT_SOURCE_CTE, INGREDIENT_COST_CTE, DISH_COST_BY_NAME_CTE,
} = require('../src/utils/ingredientSource');

/**
 * detectProfitLeaks fires four queries in parallel via Promise.all, so the
 * results can't be queued positionally — they're matched on a fragment unique
 * to each query instead.
 */
function mockQueries({ priceDrops = [], todayRevenue = 0, weakHours = [], waste = [], belowCost = [] }) {
  db.query.mockImplementation((sql) => {
    if (sql.includes('avg_price_base'))        return Promise.resolve({ rows: priceDrops });
    if (sql.includes('COALESCE(SUM(total_amount), 0)::float AS revenue'))
                                               return Promise.resolve({ rows: [{ revenue: todayRevenue }] });
    if (sql.includes('historical_avg'))        return Promise.resolve({ rows: weakHours });
    if (sql.includes('historical_z'))          return Promise.resolve({ rows: [] });
    if (sql.includes("it.type = 'waste'"))     return Promise.resolve({ rows: waste });
    if (sql.includes('recipe_cost_source'))    return Promise.resolve({ rows: belowCost });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => db.query.mockReset());

describe('loss vs revenue-gap separation', () => {
  it('שעה חלשה נספרת כפער הכנסה ולא כהפסד', async () => {
    mockQueries({
      todayRevenue: 3000,
      weakHours: [{ hour: 14, expected_revenue: 800, actual_revenue: 200, drop_pct: 75 }],
    });

    const res = await detectProfitLeaks('biz-1');

    // The old agent folded this ₪600 into totalLoss, so a slow afternoon read
    // as money lost — no money left the business, none was ever spent on it.
    expect(res.totalLoss).toBe(0);
    expect(res.revenueGap).toBe(600);
    expect(res.leaks[0].bucket).toBe('revenue_gap');
  });

  it('סחורה שנזרקה ומכירה מתחת לעלות נספרות כהפסד אמיתי', async () => {
    mockQueries({
      todayRevenue: 3000,
      waste:     [{ name: 'חזה עוף', estimated_loss: 120 }],
      belowCost: [{ name: 'כריך', cost_price: 20, selling_price: 15, qty_today: 4, loss: 20 }],
    });

    const res = await detectProfitLeaks('biz-1');

    expect(res.totalLoss).toBe(140);
    expect(res.revenueGap).toBe(0);
    expect(res.breakdown).toEqual({ waste: 120, belowCost: 20, priceDrop: 0 });
  });
});

describe('materiality floors', () => {
  it('מסנן דליפה זניחה מתחת לסף', async () => {
    mockQueries({
      todayRevenue: 3000,
      // ₪0.30 total — used to render as a full leak card
      priceDrops: [{ name: 'קפה', qty_today: 3, avg_price_today: 11.9, price_diff: -0.1, drop_pct: -0.8 }],
      belowCost:  [{ name: 'עוגה', cost_price: 10.5, selling_price: 10, qty_today: 2, loss: 1 }],
    });

    const res = await detectProfitLeaks('biz-1');

    expect(res.leaks).toHaveLength(0);
    expect(res.hasLeaks).toBe(false);
  });

  it('מדווח דליפה מהותית', async () => {
    mockQueries({
      todayRevenue: 3000,
      priceDrops: [{ name: 'סטייק', qty_today: 20, avg_price_today: 80, price_diff: -12, drop_pct: -13 }],
    });

    const res = await detectProfitLeaks('biz-1');

    expect(res.leaks).toHaveLength(1);
    expect(res.leaks[0].type).toBe('recipe_price_drop');
    expect(res.totalLoss).toBe(240);
  });
});

describe('closed-day guard', () => {
  it('יום ללא מכירות כלל לא מייצר עשרות "שעות חלשות"', async () => {
    // Every historical hour would otherwise read as a 100% drop and the agent
    // emitted a full day's turnover as a "loss" on any day the business shut.
    const allHoursWeak = Array.from({ length: 12 }, (_, i) => ({
      hour: i + 9, expected_revenue: 500, actual_revenue: 0, drop_pct: 100,
    }));
    mockQueries({ todayRevenue: 0, weakHours: allHoursWeak });

    const res = await detectProfitLeaks('biz-1');

    expect(res.leaks).toHaveLength(0);
    expect(res.revenueGap).toBe(0);
  });
});

describe('below-cost query shape', () => {
  it('משתמש במחיר שנמכר בפועל ולא במחיר התפריט', async () => {
    mockQueries({ todayRevenue: 100 });
    await detectProfitLeaks('biz-1');

    const sql = db.query.mock.calls.map(c => c[0]).find(s => s.includes('recipe_cost_source'));
    expect(sql).toContain('si.unit_price');
    // recipes.selling_price was the old source — the menu price, not the price
    // the customer actually paid, so discounts below cost were invisible.
    expect(sql).not.toContain('MAX(r.selling_price)');
  });

  it('מבצע dedup של דוחות Z מול מכירות קופה בודדות', async () => {
    mockQueries({ todayRevenue: 100 });
    await detectProfitLeaks('biz-1');

    const sql = db.query.mock.calls.map(c => c[0]).find(s => s.includes('recipe_cost_source'));
    expect(sql).toContain('deduped_sales');
    expect(sql).toContain('ind_days');
  });
});

describe('ingredient source resolution (shared SQL)', () => {
  it('מעדיף את הרשימה שמחוברת יותר לפריטי מלאי', () => {
    // The whole point: a recipe whose lines are all unlinked must NOT beat a
    // fully-linked dish. That inversion costed "כריך אסאדו" at ₪4.78
    // instead of ₪18.03 across the entire platform.
    expect(INGREDIENT_SOURCE_CTE).toContain('s.recipe_linked >= s.dish_linked');
    expect(INGREDIENT_SOURCE_CTE).toContain('s.dish_linked > s.recipe_linked');
    // The old disqualifying guard must be gone.
    expect(INGREDIENT_SOURCE_CTE).not.toContain('NOT EXISTS (SELECT 1 FROM recipe_ingredients');
  });

  it('סופר רק שורות שמקושרות לפריט מלאי', () => {
    expect(INGREDIENT_SOURCE_CTE).toContain('ri.item_id IS NOT NULL');
    expect(INGREDIENT_SOURCE_CTE).toContain('di.inventory_item_id IS NOT NULL');
  });

  it('חישוב העלות כולל שורות ידניות, כדי לא לדווח עלות 0', () => {
    // An unlinked line still carries manual_cost. Dropping it would report the
    // dish as infinitely profitable rather than as partially unknown.
    expect(INGREDIENT_COST_CTE).toContain('ri.manual_cost');
    expect(INGREDIENT_COST_CTE).toContain('di.manual_cost');
  });

  it('עלות לפי שם מנה מכווצת כפילויות שם לשורה אחת', () => {
    // Two dishes sharing a name used to duplicate every sale row joined to them.
    expect(DISH_COST_BY_NAME_CTE).toContain('GROUP BY dname');
    expect(DISH_COST_BY_NAME_CTE).toContain('MAX(cost_price)');
  });
});
