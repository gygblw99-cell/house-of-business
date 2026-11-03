const express = require('express');
const router  = express.Router();
const { requireAuth, requireManager } = require('../middleware/auth');
const dashboardData   = require('../services/dashboard/dashboard.data');
const { detectProfitLeaks }       = require('../agents/profitLeak.agent');
const { buildDailySummary }       = require('../services/notifications/dailySummary.service');
const { detectIngredientLeakage }  = require('../agents/ingredientLeakage.agent');
const { analyzeMenuEngineering, analyzePriceElasticity, getMonthlyFoodCost } = require('../agents/menuEngineering.agent');
const { analyzeSurvivalMode }      = require('../agents/survivalMode.agent');
const { get: cacheGet, set: cacheSet, del: cacheDel, wrap: cacheWrap, wrapWithLock } = require('../utils/cache');
const cache = { get: cacheGet, set: cacheSet, del: cacheDel, wrap: cacheWrap, wrapWithLock };
const db    = require('../utils/db');
const { parseIntRange } = require('../utils/parseQuery');
const eventBus = require('../utils/eventBus');

// Menu Engineering cache is invalidated per-business when recipes/sales change
// (see onRecipeChanged in sync.service.js) — no server-start global wipe needed

// ── Auto-create missing tables + performance indexes ─────────────────────────
db.migrate(`
  CREATE TABLE IF NOT EXISTS weekly_tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    done        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`);

// Critical composite indexes — speed up every dashboard/finance/audit query
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_business_date        ON sales(business_id, sold_at DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_business_type_date   ON sales(business_id, sale_type, sold_at DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id         ON sale_items(sale_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inventory_items_business   ON inventory_items(business_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_invoices_business_date     ON invoices(business_id, invoice_date DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inv_tx_business_date       ON inventory_transactions(business_id, created_at DESC)`);

// Additional FK + JOIN indexes
db.migrate(`CREATE INDEX IF NOT EXISTS idx_suppliers_business         ON suppliers(business_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inventory_supplier         ON inventory_items(business_id, supplier_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sale_items_recipe          ON sale_items(recipe_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_item    ON recipe_ingredients(item_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_invoice_items_inv_item     ON invoice_items(inventory_item_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_daily_order_items_inv_item ON daily_order_items(inventory_item_id)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_shifts_business_date       ON shifts(business_id, actual_start DESC)`);

// Performance indexes added after profiling
db.migrate(`CREATE INDEX IF NOT EXISTS idx_shifts_biz_emp_start       ON shifts(business_id, employee_id, actual_start DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_shifts_planned_biz         ON shifts(business_id, planned_start DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_sales_non_z                ON sales(business_id, sold_at DESC) WHERE pos_sale_id IS NULL`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_users_business_active      ON users(business_id, is_active) WHERE is_active = TRUE`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_inv_items_low_stock        ON inventory_items(business_id, current_qty, min_qty) WHERE min_qty > 0`);

// Round-2 performance indexes
db.migrate(`CREATE INDEX IF NOT EXISTS idx_customers_biz_last_visit   ON customers(business_id, last_visit DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_customers_biz_points       ON customers(business_id, points DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_reminders_user_biz         ON reminders(user_id, business_id, remind_at ASC) WHERE deleted_at IS NULL`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_support_tickets_biz_date   ON support_tickets(business_id, created_at DESC)`);
db.migrate(`CREATE INDEX IF NOT EXISTS idx_invoices_supplier_date     ON invoices(supplier_id, invoice_date DESC) WHERE total_amount IS NOT NULL`);

// Single owner of the profit-leak cache. The dashboard route used to bake its
// own copy of detectProfitLeaks() into the `dashboard:` key at a 600s TTL while
// /profit-leaks cached the same computation under `profit-leaks:` at 300s — so
// the work ran twice, and for up to five minutes the dashboard badge and the
// leak page could show two different numbers for the same thing. Both now read
// through this one key, and sync.service.js already busts it on every mutation.
function getProfitLeaks(businessId) {
  return wrapWithLock(`profit-leaks:${businessId}`, () => detectProfitLeaks(businessId), 300);
}

// GET /api/dashboard — כל הדשבורד בקריאה אחת (cache 10 דקות)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const key = `dashboard:${req.user.businessId}`;
    // profitLeaks is fetched OUTSIDE the dashboard cache entry so the two keep
    // their own TTLs instead of one freezing the other. allSettled preserves the
    // original behaviour where either half failing still renders the other.
    const [dashResult, leaksResult] = await Promise.allSettled([
      wrapWithLock(key, () => dashboardData.getDashboardData(req.user.businessId), 600),
      getProfitLeaks(req.user.businessId),
    ]);
    res.json({
      ...(dashResult.status === 'fulfilled' ? dashResult.value : {}),
      profitLeaks: leaksResult.status === 'fulfilled' ? leaksResult.value : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/profit-leaks — דליפות רווח בלבד (cache 5 דקות)
router.get('/profit-leaks', requireAuth, async (req, res, next) => {
  try {
    res.json(await getProfitLeaks(req.user.businessId));
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/menu-engineering?days=30 — ניתוח Menu Engineering
// Cache is per-business; invalidated by onRecipeChanged (sync.service.js) on recipe/ingredient mutations
router.get('/menu-engineering', requireAuth, async (req, res, next) => {
  try {
    const days = parseIntRange(req.query.days, 1, 365, 30);
    // No cache.wrap here: it used the SAME key as the agent's own cache but a
    // 180s TTL, so the two layers overwrote each other's entries under one key
    // with two different lifetimes. The agent caches this itself (wrapWithLock,
    // 30 min) and every mutation path already busts that key.
    const result = await analyzeMenuEngineering(req.user.businessId, days);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/dashboard/food-cost-monthly — עלות מזון מצטברת לחודש הקלנדרי הנוכחי,
// מתחילה מ-0 בכל חודש ומתעדכנת יומית. ימים בלי פירוט-מנות בדוח Z מוערכים לפי
// אחוז עלות-מזון ממוצע של התפריט (ראה getMonthlyFoodCost).
router.get('/food-cost-monthly', requireAuth, async (req, res, next) => {
  try {
    const result = await getMonthlyFoodCost(req.user.businessId);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/dashboard/price-elasticity — ניתוח אלסטיות מחיר והמלצות חבילות
router.get('/price-elasticity', requireAuth, async (req, res, next) => {
  try {
    const result = await analyzePriceElasticity(req.user.businessId);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/dashboard/ingredient-leakage?days=7|14|30 — ניתוח דליפות לפי מרכיב
router.get('/ingredient-leakage', requireAuth, async (req, res, next) => {
  try {
    const days = parseIntRange(req.query.days, 1, 90, 7);
    const key  = `ingredient-leakage:${req.user.businessId}:${days}`;
    const result = await cache.wrap(key, () =>
      detectIngredientLeakage(req.user.businessId, days), 300
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/chart?days=7|30 — גרף מורחב (cache 10 דקות)
router.get('/chart', requireAuth, async (req, res, next) => {
  try {
    const days = parseIntRange(req.query.days, 1, 30, 7);
    const key  = `dashboard-chart:${req.user.businessId}:${days}`;
    const chart = await cache.wrap(key, () =>
      dashboardData.getWeeklyChart(req.user.businessId, days), 600
    );
    res.json(chart);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/orders?limit=5 — הזמנות אחרונות (cache 30 שניות)
router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const limit = parseIntRange(req.query.limit, 1, 20, 5);
    const key   = `dashboard-orders:${req.user.businessId}:${limit}`;
    const orders = await cache.wrap(key, () =>
      dashboardData.getLastOrders(req.user.businessId, limit), 30
    );
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/tables — שולחנות פתוחים (real-time, max 200)
router.get('/tables', requireAuth, async (req, res, next) => {
  try {

    const { rows } = await db.query(
      `SELECT id, table_number, total_amount, sold_at
       FROM sales
       WHERE business_id=$1 AND (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%')
         AND sale_type='table' AND status='open' AND table_number IS NOT NULL
       ORDER BY table_number ASC
       LIMIT 200`,
      [req.user.businessId]
    );
    res.json({ tables: rows });
  } catch (err) { next(err); }
});

// POST /api/dashboard/tables — פתיחת שולחן
router.post('/tables', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { tableNumber, amount } = req.body;
    if (!tableNumber) return res.status(400).json({ error: 'מספר שולחן חסר' });

    const { rows } = await db.query(
      `INSERT INTO sales (business_id, sale_type, table_number, total_amount, status, sold_at)
       VALUES ($1,'table',$2,$3,'open',NOW()) RETURNING id, table_number, total_amount, sold_at`,
      [req.user.businessId, tableNumber, amount || 0]
    );
    if (!rows[0]) return res.status(500).json({ error: 'שגיאה ביצירת שולחן' });
    res.status(201).json(rows[0]);
    // The main dashboard (GET /) caches openTables for 10 minutes — without
    // busting it here, a newly-opened table wouldn't show up there (or on
    // other connected clients, via dashboard.refresh) until the TTL expires.
    cache.del(`dashboard:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'dashboard.refresh', { action: 'table_opened' });
  } catch (err) { next(err); }
});

// PUT /api/dashboard/tables/:id/close — סגירת שולחן
router.put('/tables/:id/close', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { finalAmount } = req.body;

    const { rowCount } = await db.query(
      `UPDATE sales SET status='done', total_amount=COALESCE($1,total_amount), updated_at=NOW()
       WHERE id=$2 AND business_id=$3`,
      [finalAmount != null ? finalAmount : null, req.params.id, req.user.businessId]
    );
    if (!rowCount) return res.status(404).json({ error: 'שולחן לא נמצא' });
    res.json({ message: 'שולחן נסגר' });
    cache.del(`dashboard:${req.user.businessId}`).catch(() => {});
    eventBus.publish(req.user.businessId, 'dashboard.refresh', { action: 'table_closed' });
  } catch (err) { next(err); }
});

// GET /api/dashboard/weekly-tasks — משימות שבועיות (max 100)
router.get('/weekly-tasks', requireAuth, async (req, res, next) => {
  try {

    const { rows } = await db.query(
      `SELECT id, text, done, created_at FROM weekly_tasks
       WHERE business_id=$1 ORDER BY created_at ASC
       LIMIT 100`,
      [req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/dashboard/weekly-tasks
router.post('/weekly-tasks', requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'טקסט חסר' });

    const { rows } = await db.query(
      `INSERT INTO weekly_tasks (business_id, text) VALUES ($1,$2) RETURNING *`,
      [req.user.businessId, text.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/dashboard/weekly-tasks/:id — סימון בוצע
router.put('/weekly-tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const { done } = req.body;

    await db.query(
      `UPDATE weekly_tasks SET done=$1 WHERE id=$2 AND business_id=$3`,
      [!!done, req.params.id, req.user.businessId]
    );
    res.json({ message: 'עודכן' });
  } catch (err) { next(err); }
});

// DELETE /api/dashboard/weekly-tasks/:id
router.delete('/weekly-tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(`DELETE FROM weekly_tasks WHERE id=$1 AND business_id=$2`,
      [req.params.id, req.user.businessId]);
    if (!rowCount) return res.status(404).json({ error: 'משימה לא נמצאה' });
    res.json({ message: 'נמחק' });
  } catch (err) { next(err); }
});

// GET /api/dashboard/survival-mode?days=30 — מצב הישרדות
router.get('/survival-mode', requireAuth, async (req, res, next) => {
  try {
    const days   = parseIntRange(req.query.days, 1, 90, 30);
    const key    = `survival-mode:${req.user.businessId}:${days}`;
    const result = await cache.wrap(key, () =>
      analyzeSurvivalMode(req.user.businessId, days), 300
    );
    res.json(result);
  } catch (err) { next(err); }
});


// GET /api/dashboard/daily-summary — WhatsApp daily summary (cache 5 דקות)
// Date included in key so midnight rollover always fetches fresh data.
// Must be Israel's calendar date, not UTC — toISOString() rolls over at UTC
// midnight (Israel 02:00/03:00), so the cache key kept pointing at
// "yesterday" and served stale data for the first hours of each new day.
router.get('/daily-summary', requireAuth, async (req, res, next) => {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const key   = `daily-summary:${req.user.businessId}:${today}`;
    const summary = await cache.wrap(key, () => buildDailySummary(req.user.businessId), 300);
    res.json(summary);
  } catch (err) { next(err); }
});

module.exports = router;
