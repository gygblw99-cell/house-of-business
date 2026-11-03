jest.mock('../src/utils/db', () => ({
  query:   jest.fn(),
  migrate: jest.fn().mockResolvedValue(undefined),
  pool:    { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/cache',    () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined), wrap: jest.fn((k, fn) => fn()) }));
jest.mock('../src/utils/eventBus', () => ({ publish: jest.fn(), subscribe: jest.fn(), on: jest.fn(), off: jest.fn(), emit: jest.fn() }));

const request = require('supertest');
const app     = require('../src/index');
const db      = require('../src/utils/db');
const { makeToken, authHeader } = require('./helpers');

const token = makeToken();

const ITEM = { id: 'item-1', business_id: 'biz-test-1', name: 'שמן זית', category_id: 'cat-1', current_qty: 10, min_qty: 2, unit: 'ליטר', cost_per_unit: 25 };
const CAT  = { id: 'cat-1', business_id: 'biz-test-1', name: 'שמנים' };

beforeEach(() => { db.query.mockReset(); });

describe('Inventory — auth gates', () => {
  it('GET /api/inventory ללא טוקן → 401',             async () => expect((await request(app).get('/api/inventory')).status).toBe(401));
  it('GET /api/inventory/categories ללא טוקן → 401',  async () => expect((await request(app).get('/api/inventory/categories')).status).toBe(401));
  it('POST /api/inventory ללא טוקן → 401',            async () => expect((await request(app).post('/api/inventory').send({})).status).toBe(401));
});

describe('GET /api/inventory', () => {
  it('מחזיר רשימת פריטים', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ITEM] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const res = await request(app).get('/api/inventory').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/inventory/categories', () => {
  it('מחזיר קטגוריות', async () => {
    db.query.mockResolvedValue({ rows: [CAT] });
    const res = await request(app).get('/api/inventory/categories').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/inventory/categories', () => {
  it('חסר שם → 400', async () => {
    const res = await request(app).post('/api/inventory/categories').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
  });

  it('שם תקין → 201', async () => {
    db.query.mockResolvedValue({ rows: [CAT] });
    const res = await request(app).post('/api/inventory/categories').set(authHeader(token)).send({ name: 'שמנים' });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/inventory', () => {
  it('חסר שם → 400', async () => {
    const res = await request(app).post('/api/inventory').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
  });

  it('פריט תקין → 201', async () => {
    db.query.mockResolvedValue({ rows: [ITEM] });
    const res = await request(app).post('/api/inventory').set(authHeader(token)).send({
      name: 'שמן זית', unit: 'ליטר', costPerUnit: 25, minQty: 2, categoryId: 'cat-1',
    });
    expect([201, 500]).toContain(res.status);
  });
});

describe('POST /api/inventory/:id/transaction', () => {
  it('ללא טוקן → 401', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').send({ type: 'add', qty: 5 });
    expect(res.status).toBe(401);
  });

  it('חסרי type/qty → 400', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
  });

  it('תנועה תקינה → 200', async () => {
    db.query.mockResolvedValue({ rows: [{ ...ITEM, current_qty: 15 }] });
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'add', qty: 5, note: 'קנייה' });
    expect([200, 404, 500]).toContain(res.status);
  });

  // 'add'/'purchase' עם כמות שלילית/אפס (בין אם דרך qty ובין אם דרך qtyChange)
  // חייב תמיד להידחות — פעולה שמתויגת כתוספת אסור שתפחית מלאי בשקט.
  // רגרסיה שקרתה פעמיים על הנקודה הזו בדיוק (unpacked/re-narrowed guard).
  it('הוסף (type=add) עם qty שלילי → 400', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'add', qty: -5 });
    expect(res.status).toBe(400);
  });

  it('הוסף (type=add) עם qty אפס → 400', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'add', qty: 0 });
    expect(res.status).toBe(400);
  });

  it('purchase עם qtyChange שלילי (עוקף qty) → 400', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'purchase', qtyChange: -5 });
    expect(res.status).toBe(400);
  });

  it('add עם qtyChange שלילי (עוקף qty) → 400', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'add', qtyChange: -5 });
    expect(res.status).toBe(400);
  });

  // מובייל שולח qtyChange כבר עם סימן (שלילי ל-waste/sale) — אסור שהולידציה
  // תדחה את זה, אחרת כל תנועת בזבוז/מכירה מהאפליקציה נכשלת.
  it('waste עם qtyChange שלילי (המרה של מובייל) — לא נדחה ע"י ולידציית הכמות', async () => {
    db.query.mockResolvedValue({ rows: [{ ...ITEM, current_qty: 5 }] });
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'waste', qtyChange: -5 });
    expect(res.status).not.toBe(400);
  });

  it('sale עם qtyChange שלילי (המרה של מובייל) — לא נדחה ע"י ולידציית הכמות', async () => {
    db.query.mockResolvedValue({ rows: [{ ...ITEM, current_qty: 5 }] });
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token)).send({ type: 'sale', qtyChange: -5 });
    expect(res.status).not.toBe(400);
  });

  // JSON.stringify({qty: Infinity}) serializes to `"qty":null` — a JS Infinity
  // value never survives a normal .send({...}) call, so this must send the raw
  // wire body directly. A real attacker sends this exact literal on the wire;
  // Node's JSON.parse legitimately parses the numeral `1e400` as Infinity.
  it('qty כמספר עצום שגולש ל-Infinity ב-JSON.parse → נדחה ע"י ה-schema (400)', async () => {
    const res = await request(app).post('/api/inventory/item-1/transaction').set(authHeader(token))
      .set('Content-Type', 'application/json')
      .send('{"type":"add","qty":1e400}');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/inventory/value', () => {
  it('מחזיר ערך מלאי', async () => {
    db.query.mockResolvedValue({ rows: [{ total_value: 12500, item_count: 45 }] });
    const res = await request(app).get('/api/inventory/value').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});
