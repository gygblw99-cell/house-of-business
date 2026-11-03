/**
 * Invoice OCR Agent Tests — בדיקות לוגיקה ללא קריאות API אמיתיות
 */

// mock Anthropic
jest.mock('@anthropic-ai/sdk', () => class {
  messages = {
    create: jest.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          invoice_number: 'INV-001',
          invoice_date:   '2026-03-01',
          total_amount:   500,
          supplier_name:  'ספק Test',
          items: [{ description: 'בשר', qty: 5, unit_price: 100 }],
        }),
      }],
      stop_reason: 'end_turn',
    }),
  };
});

// mock db
jest.mock('../src/utils/db', () => ({
  query:   jest.fn().mockResolvedValue({ rows: [] }),
  migrate: jest.fn().mockReturnValue(Promise.resolve()),
}));

describe('Invoice OCR — supplier matching', () => {
  it('מייבא את המודול בלי שגיאות', () => {
    expect(() => require('../src/agents/invoiceOCR.agent')).not.toThrow();
  });
});
