/**
 * Business Audit Agent Tests
 */

jest.mock('@anthropic-ai/sdk', () => class {
  messages = {
    create: jest.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          issues: [{ title: 'רווחיות נמוכה', description: 'המרווח הנמוך...' }],
          recommendations: ['הגדל מחירים ב-5%'],
        }),
      }],
      stop_reason: 'end_turn',
    }),
  };
});

jest.mock('../src/utils/db', () => ({
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
}));

const { calculateScores } = require('../src/agents/businessAudit.agent');

describe('calculateScores', () => {
  it('נתונים ריקים → ציון בין 0-100', () => {
    const data = {
      salesStats:     [],
      inventoryWaste: [],
      lowInventory:   [],
      shiftStats:     { total_shifts: 0, absent_count: 0 },
      expenseStats:   { monthly_fixed_expenses: 0 },
      avgOrderValue:  { current_avg: 0, p75_avg: 0 },
    };
    const scores = calculateScores(data);
    expect(scores.total).toBeGreaterThanOrEqual(0);
    expect(scores.total).toBeLessThanOrEqual(100);
    expect(scores.profitability).toBeDefined();
  });

  it('נתונים טובים → ציון גבוה', () => {
    const data = {
      salesStats:     [{ total_revenue: 50000 }],
      inventoryWaste: [],
      lowInventory:   [],
      shiftStats:     { total_shifts: 20, absent_count: 0 },
      expenseStats:   { monthly_fixed_expenses: 5000 },
      avgOrderValue:  { current_avg: 85, p75_avg: 85 },
    };
    const scores = calculateScores(data);
    expect(scores.total).toBeGreaterThan(50);
  });
});
