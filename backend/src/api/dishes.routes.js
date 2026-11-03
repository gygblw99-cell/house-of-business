const express    = require('express');
const router     = express.Router();
const logger     = require('../utils/logger');
const { requireAuth, requireManager, requirePermission } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const { rateLimitAI } = require('../middleware/rateLimitAI');
const dishModel  = require('../models/dish.model');
const { bulkRemove, setPackaging, setAccompaniments } = dishModel;
const db         = require('../utils/db');
const Anthropic  = require('@anthropic-ai/sdk');
const cache      = require('../utils/cache');
const eventBus   = require('../utils/eventBus');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { logTokenUsage } = require('../utils/logTokenUsage');
const { generateInsights, storeInsights } = require('../agents/autoInsights.agent');
const { bustContextCache } = require('../services/ai/business.context');

const CHEF_SYSTEM_PROMPT = `You are an expert AI culinary advisor and restaurant business consultant.

You are integrated into a restaurant management system that includes:
* ingredient cost data (price per gram / ml / unit)
* recipes with quantities
* supplier data
* inventory

### Interaction Model:
The user interacts with you using 3 main action modes:
1. "improve_dish" (שפר לי מנה)
2. "increase_profit" (הגדל רווחיות)
3. "reduce_cost" (הוזל עלות)

### Behavior per Mode:

#### 1. improve_dish
Goal: Make the dish better without significantly increasing cost.
Focus on: flavor balance, presentation, ingredient pairing, modern improvements.
Rules: cost increase must be minimal or justified; maintain dish identity.

#### 2. increase_profit
Goal: Increase profitability of the dish.
Focus on: increasing perceived value, adjusting portion size smartly, upsell components, slight cost reduction.
Must include: suggested selling price, food cost percentage, profit margin improvement.

#### 3. reduce_cost
Goal: Reduce dish cost as much as possible WITHOUT hurting quality significantly.
Focus on: replacing expensive ingredients, reducing quantities, simplifying the recipe.
Must include: original cost vs new cost, savings in ₪ and %.

### Always Do (for ALL modes):
1. Analyze the dish: identify expensive ingredients, identify inefficiencies
2. Use actual cost data provided
3. Return structured output: Mode used, Key insights, Changes made, New recipe version, Cost comparison, Business impact

### Important Rules:
* Be practical for real restaurant kitchens
* Keep suggestions actionable
* Think like a chef AND a business owner
* Respond in Hebrew

Act like a top-tier restaurant consultant used by multi-location restaurant chains.`;

// migration — runs on startup, creates all dish-related tables if missing
db.migrate(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS dish_type VARCHAR(20) DEFAULT 'both'`);
db.migrate(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS category VARCHAR(100)`);
db.migrate(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
db.migrate(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
db.migrate(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS recipe_text TEXT`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS dish_packaging (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id           UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    order_type        VARCHAR(20) NOT NULL DEFAULT 'both',
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    item_name         VARCHAR(255),
    qty               NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit              VARCHAR(50)
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS business_extras (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
    item_name         VARCHAR(255)  NOT NULL,
    unit              VARCHAR(50),
    is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS extras_consumption_log (
    id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    extra_id   UUID          NOT NULL REFERENCES business_extras(id) ON DELETE CASCADE,
    qty        NUMERIC(10,4) NOT NULL,
    log_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    notes      TEXT,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS dishes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    selling_price NUMERIC(10,2) DEFAULT 0,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS dish_accompaniments (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id           UUID          NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    order_type        VARCHAR(20)   NOT NULL DEFAULT 'both',
    inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
    item_name         VARCHAR(255),
    qty               NUMERIC(10,4) NOT NULL DEFAULT 1,
    unit              VARCHAR(50),
    manual_cost       NUMERIC(10,4)
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS dish_recipes (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id   UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    qty       NUMERIC(10,3) NOT NULL DEFAULT 1,
    UNIQUE (dish_id, recipe_id)
  )
`);

db.migrate(`
  CREATE TABLE IF NOT EXISTS dish_ingredients (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dish_id           UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name              VARCHAR(255),
    qty               NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit              VARCHAR(50),
    manual_cost       NUMERIC(10,4)
  )
`);

// שמירת מרכיבים ישירים על מנה — עוטף dishModel.setIngredients (מאמת בעלות
// לפי business_id בעצמו) ומוסיף את מגבלת ה-200 מרכיבים הספציפית ל-route הזה
async function saveDishIngredients(dishId, businessId, ingredients) {
  if (!Array.isArray(ingredients)) return;
  if (ingredients.length > 200) throw Object.assign(new Error('יותר מדי מרכיבים'), { status: 400 });
  await dishModel.setIngredients(dishId, businessId, ingredients);
}

// כל מסך/דוח שתלוי בעלות מנה (dashboard, menu-engineering, profit-leaks
// וכו') חייב להתנקות בכל שינוי מנה — לא רק ב-PUT. Create/delete/bulk-delete
// היו מנקים רק תת-קבוצה חלקית מהרשימה, מה שהשאיר נתונים מיושנים בדוחות
// האלה אחרי הוספת/מחיקת מנה, עד שמישהו גם עדכן (PUT) אותה או שה-TTL פג.
async function bustDishCaches(businessId) {
  await Promise.allSettled([
    cache.del(`dashboard:${businessId}`),
    cache.del(`menu-engineering:${businessId}:*`),
    cache.del(`menu-elasticity:${businessId}`),
    cache.del(`profit-leaks:${businessId}`),
    cache.del(`survival-mode:${businessId}:30`),
    cache.del(`ingredient-leakage:${businessId}:*`),
    cache.del(`ingredient-cost:${businessId}:*`),
    cache.del(`marketing-ctx:${businessId}`),
    bustContextCache(businessId),
  ]);
}

// POST /api/dishes/chef-chat — צ'אט עם טבח יועץ (stateless, history מה-client)
router.post('/chef-chat', requireAuth, rateLimitAI(), async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'הודעה ריקה' });

    // בנה context קצר מהמנות (לא חובה — ממשיכים גם אם ה-DB לא זמין)
    let dishSummary = 'אין מנות מוגדרות עדיין';
    try {
      const dishes = await dishModel.findAllByBusiness(req.user.businessId);
      if (dishes.length) {
        dishSummary = dishes.map(d =>
          `• ${d.name} — מחיר ₪${d.selling_price}, עלות ₪${(d.cost || 0).toFixed(2)}, מרג'ין ${(d.margin || 0).toFixed(1)}%`
        ).join('\n');
      }
    } catch { /* DB unavailable — continue without dish context */ }

    const systemWithContext = CHEF_SYSTEM_PROMPT + `\n\n### מנות העסק הנוכחיות:\n${dishSummary}`;

    const safeHistory = Array.isArray(history) ? history : [];
    const messages = [
      ...safeHistory.filter(m => m?.role && m?.content).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message.trim() },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await anthropic.messages.create({
          model:      'claude-haiku-4-5',
          max_tokens: 2000,
          system:     systemWithContext,
          messages,
        });
        const reply = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'chef_chat', model: 'claude-haiku-4-5', usage: result.usage });
        return res.json({ reply });
      } catch (aiErr) {
        logger.error('[chef-chat] AI error', { attempt: attempt + 1, status: aiErr.status, err: aiErr.message });
        const overloaded = aiErr.status === 529 || aiErr.status === 503 || aiErr.status === 429;
        if (attempt === 0 && overloaded) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return res.status(503).json({ error: 'יועץ ה-AI לא זמין כרגע — נסה שוב בעוד מספר שניות' });
      }
    }
  } catch (err) {
    logger.error('[chef-chat] unexpected error', { err: err.message });
    if (!res.headersSent) res.status(503).json({ error: 'שגיאה פנימית — נסה שנית' });
  }
});

// GET /api/dishes
router.get('/', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const dishes = await dishModel.findAllByBusiness(req.user.businessId);
    res.json({ dishes });
  } catch (err) { next(err); }
});

// POST /api/dishes/:id/advise — טבח יועץ AI
router.post('/:id/advise', requireAuth, async (req, res) => { try {
  const { mode, dishContext } = req.body || {};

  if (!['improve_dish', 'increase_profit', 'reduce_cost'].includes(mode)) {
    return res.status(400).json({ error: 'mode חייב להיות: improve_dish / increase_profit / reduce_cost' });
  }

  // ── 1. Fetch dish (with retry + client-context fallback) ──────────────────
  let dish = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      dish = await dishModel.findById(req.params.id, req.user.businessId);
      break;
    } catch (dbErr) {
      logger.error('[advise] DB error', { attempt: attempt + 1, err: dbErr.code || dbErr.message });
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  // Use client-provided fallback when DB unavailable
  if (!dish && dishContext) {
    logger.warn('[advise] Using dishContext fallback');
    dish = dishContext;
  }

  if (!dish) {
    return res.status(503).json({ error: 'מסד הנתונים לא זמין כרגע — נסה שנית בעוד מספר שניות' });
  }

  // ── 2. Build prompt ───────────────────────────────────────────────────────
  const modeLabel = { improve_dish: 'שפר לי מנה', increase_profit: 'הגדל רווחיות', reduce_cost: 'הוזל עלות' }[mode];
  const ings    = Array.isArray(dish.ingredients) ? dish.ingredients : [];
  const recipes = Array.isArray(dish.recipes) ? dish.recipes : [];

  const ingredientLines = ings.map(i =>
    `• ${i.ingredient_name || i.name || 'מרכיב'}: ${i.qty || ''} ${i.unit || ''} — ₪${Number(i.unit_cost || 0).toFixed(3)} ליחידה — עלות שורה: ₪${Number(i.line_cost || 0).toFixed(2)}`
  ).join('\n') || (recipes.length ? '' : '(אין מרכיבים מוגדרים)');

  const recipeLines = recipes.map(r =>
    `• תת-מתכון ${r.recipe_name || 'ללא שם'}: ${r.qty || 1}x — עלות שורה: ₪${(Number(r.recipe_cost || 0) * Number(r.qty || 1)).toFixed(2)}`
  ).join('\n');

  const totalCost = (
    ings.reduce((s, i) => s + Number(i.line_cost || 0), 0) +
    recipes.reduce((s, r) => s + Number(r.recipe_cost || 0) * Number(r.qty || 1), 0)
  ).toFixed(2);

  const recipeTextSection = dish.recipe_text
    ? `\nמתכון / הרכב חופשי:\n${dish.recipe_text}` : '';

  const userMessage = `מצב: ${modeLabel}

מנה: ${dish.name}
מחיר מכירה: ₪${dish.selling_price || 0}
הערות: ${dish.notes || 'אין'}
${recipeTextSection}
מרכיבים מובנים:
${ingredientLines}${recipeLines ? `\n${recipeLines}` : ''}

עלות כוללת: ₪${totalCost}`;

  // ── 3. Call AI (with retry) ───────────────────────────────────────────────
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await anthropic.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 2000,
        system:     CHEF_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      });
      const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'chef_advise', model: 'claude-haiku-4-5', usage: result.usage });
      return res.json({ advice: text, mode, dishName: dish.name });
    } catch (aiErr) {
      logger.error('[advise] AI error', { attempt: attempt + 1, status: aiErr.status, err: aiErr.message });
      const overloaded = aiErr.status === 529 || aiErr.status === 503 || aiErr.status === 429;
      if (attempt === 0 && overloaded) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return res.status(503).json({ error: 'יועץ ה-AI לא זמין כרגע — נסה שוב בעוד מספר שניות' });
    }
  }
} catch (err) {
  logger.error('[advise] unexpected error', { err: err.message });
  if (!res.headersSent) res.status(503).json({ error: 'שגיאה פנימית — נסה שנית' });
}});

// GET /api/dishes/ingredient-cost — עלות ריאלית של מרכיבים מחשבוניות
router.get('/ingredient-cost', requireAuth, async (req, res, next) => {
  try {
    const biz    = req.user.businessId;
    const limit  = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const cacheKey = `ingredient-cost:${biz}:${limit}:${offset}`;
    const cached   = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Latest invoice price per ingredient name (last 90 days)
    const { rows: invoicePrices } = await db.query(`
      SELECT DISTINCT ON (LOWER(ii.name))
        LOWER(ii.name) AS ingredient_key,
        ii.name        AS ingredient_name,
        ii.unit_price  AS invoice_price,
        ii.unit,
        inv.invoice_date,
        s.name         AS supplier_name
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      LEFT JOIN suppliers s ON s.id = inv.supplier_id
      WHERE inv.business_id = $1
        AND ii.unit_price > 0
        AND inv.invoice_date >= NOW() - INTERVAL '90 days'
      ORDER BY LOWER(ii.name), inv.invoice_date DESC
    `, [biz]);

    const priceMap = Object.fromEntries(invoicePrices.map(r => [r.ingredient_key, r]));

    // Dish count for pagination metadata — deleted dishes excluded, matching
    // dish.model.js's own findAllByBusiness. This is a forward-looking cost-
    // audit tool (compares current dish cost to latest invoice price), so a
    // deleted dish shouldn't keep appearing here indefinitely.
    const { rows: countRows } = await db.query(
      `SELECT COUNT(DISTINCT d.id)::int AS total
       FROM dishes d
       JOIN dish_ingredients di ON di.dish_id = d.id
       WHERE d.business_id = $1 AND d.selling_price > 0
         AND (d.is_active IS NULL OR d.is_active = TRUE)`,
      [biz]
    );
    const total = countRows[0]?.total || 0;

    // Dish ingredients with manual costs — paginated
    const { rows: dishIngredients } = await db.query(`
      SELECT
        d.id AS dish_id, d.name AS dish_name, d.selling_price,
        di.name AS ingredient_name, di.qty, di.unit, di.manual_cost,
        di.inventory_item_id
      FROM dishes d
      JOIN dish_ingredients di ON di.dish_id = d.id
      WHERE d.business_id = $1 AND d.selling_price > 0
        AND (d.is_active IS NULL OR d.is_active = TRUE)
        AND d.id IN (
          SELECT id FROM dishes WHERE business_id = $1 AND selling_price > 0
            AND (is_active IS NULL OR is_active = TRUE)
          ORDER BY name LIMIT $2 OFFSET $3
        )
      ORDER BY d.name, di.name
    `, [biz, limit, offset]);

    // Group by dish and compute real vs estimated costs
    const dishMap = {};
    for (const row of dishIngredients) {
      if (!dishMap[row.dish_id]) {
        dishMap[row.dish_id] = {
          dish_id: row.dish_id,
          dish_name: row.dish_name,
          selling_price: parseFloat(row.selling_price),
          ingredients: [],
          estimated_cost: 0,
          real_cost: 0,
          has_real_data: false,
        };
      }
      const invoiceData = priceMap[row.ingredient_name.toLowerCase()];
      const qty          = parseFloat(row.qty) || 0;
      const manualCost   = parseFloat(row.manual_cost) || 0;
      const invoicePrice = invoiceData ? parseFloat(invoiceData.invoice_price) : null;
      const realLineCost = invoicePrice !== null ? invoicePrice * qty : null;
      const estLineCost  = manualCost * qty;

      dishMap[row.dish_id].ingredients.push({
        name:           row.ingredient_name,
        qty,
        unit:           row.unit,
        manual_cost:    manualCost,
        invoice_price:  invoicePrice,
        estimated_line: parseFloat(estLineCost.toFixed(3)),
        real_line:      realLineCost !== null ? parseFloat(realLineCost.toFixed(3)) : null,
        supplier_name:  invoiceData?.supplier_name || null,
        invoice_date:   invoiceData?.invoice_date || null,
        variance_pct:   invoicePrice !== null && manualCost > 0
          ? parseFloat((((invoicePrice - manualCost) / manualCost) * 100).toFixed(1))
          : null,
      });

      dishMap[row.dish_id].estimated_cost += estLineCost;
      if (realLineCost !== null) {
        dishMap[row.dish_id].real_cost    += realLineCost;
        dishMap[row.dish_id].has_real_data = true;
      }
    }

    const dishes = Object.values(dishMap).map(d => {
      const estCost  = parseFloat(d.estimated_cost.toFixed(2));
      const realCost = d.has_real_data ? parseFloat(d.real_cost.toFixed(2)) : null;
      const costDiff = realCost !== null ? parseFloat((realCost - estCost).toFixed(2)) : null;
      return {
        ...d,
        estimated_cost:  estCost,
        real_cost:       realCost,
        cost_difference: costDiff,
        cost_variance_pct: costDiff !== null && estCost > 0
          ? parseFloat(((costDiff / estCost) * 100).toFixed(1))
          : null,
        est_margin_pct:  d.selling_price > 0
          ? parseFloat(((d.selling_price - estCost) / d.selling_price * 100).toFixed(1))
          : null,
        real_margin_pct: realCost !== null && d.selling_price > 0
          ? parseFloat(((d.selling_price - realCost) / d.selling_price * 100).toFixed(1))
          : null,
      };
    });

    // Summary
    const dishesWithReal = dishes.filter(d => d.has_real_data);
    const avgVariance    = dishesWithReal.length
      ? parseFloat((dishesWithReal.reduce((s, d) => s + (d.cost_variance_pct || 0), 0) / dishesWithReal.length).toFixed(1))
      : 0;
    const overpricedIngredients = dishIngredients
      .filter(r => {
        const inv = priceMap[r.ingredient_name.toLowerCase()];
        if (!inv || !r.manual_cost) return false;
        return parseFloat(inv.invoice_price) > parseFloat(r.manual_cost) * 1.1;
      })
      .map(r => ({
        name: r.ingredient_name,
        dish: r.dish_name,
        manual_cost: parseFloat(r.manual_cost),
        invoice_price: parseFloat(priceMap[r.ingredient_name.toLowerCase()].invoice_price),
      }));

    const result = {
      dishes,
      avgVariance,
      overpricedIngredients,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
    await cache.set(cacheKey, result, 300); // 5 דקות
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/dishes/archived — מנות שנמחקו, עם כמה הן עדיין נמכרות בקופה.
// חייב להיות רשום לפני GET /:id, אחרת ה-route הפרמטרי יתפוס את "archived".
router.get('/archived', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const dishes = await dishModel.findArchivedByBusiness(req.user.businessId);
    res.json({ dishes });
  } catch (err) { next(err); }
});

// POST /api/dishes/:id/restore — ביטול מחיקה
router.post('/:id/restore', requireAuth, requireManager, async (req, res, next) => {
  try {
    const restored = await dishModel.restore(req.params.id, req.user.businessId);
    if (!restored) return res.status(404).json({ error: 'מנה מחוקה לא נמצאה' });
    res.json({ message: 'המנה שוחזרה', dish: restored });

    const bizId = req.user.businessId;
    bustDishCaches(bizId).then(() => {
      eventBus.publish(bizId, 'inventory.updated', { action: 'dish_restored', dishId: restored.id });
      return generateInsights(bizId);
    })
      .then(fresh => storeInsights(bizId, fresh))
      .catch(() => {});
  } catch (err) { next(err); }
});

// GET /api/dishes/:id
router.get('/:id', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const dish = await dishModel.findById(req.params.id, req.user.businessId);
    if (!dish) return res.status(404).json({ error: 'מנה לא נמצאה' });
    res.json({ dish });
  } catch (err) { next(err); }
});

// POST /api/dishes
router.post('/', requireAuth, requireManager, validate({ body: schemas.createDishSchema }), async (req, res, next) => {
  try {
    const { name, sellingPrice, notes, dishType, recipeText, category, recipes, ingredients, packaging, accompaniments } = req.body;
    if (!name) return res.status(400).json({ error: 'שם מנה חסר' });
    // Dish <-> shadow-recipe linking (see dish.model.js remove()/update()) and
    // several AI agents/reports (aiAdvisor, survivalMode, ingredientLeakage,
    // zreport auto-sync) all match dishes by LOWER(name) alone — two dishes
    // with the same name in one business would make those joins/lookups
    // silently ambiguous (wrong dish deactivated, wrong sales attributed).
    const { rows: dupe } = await db.query(
      `SELECT 1 FROM dishes WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND (is_active IS NULL OR is_active = TRUE)`,
      [req.user.businessId, name.trim()]
    );
    if (dupe.length) return res.status(409).json({ error: 'כבר קיימת מנה בשם הזה' });
    const dish = await dishModel.create(req.user.businessId, { name, sellingPrice, notes, dishType, recipeText, category });
    if (recipes?.length) await dishModel.setRecipes(dish.id, req.user.businessId, recipes);
    await saveDishIngredients(dish.id, req.user.businessId, ingredients || []);
    if (packaging !== undefined) await setPackaging(dish.id, req.user.businessId, packaging || []);
    if (accompaniments !== undefined) await setAccompaniments(dish.id, req.user.businessId, accompaniments || []);
    const full = await dishModel.findById(dish.id, req.user.businessId);
    res.status(201).json({ dish: full });

    const bizId = req.user.businessId;
    bustDishCaches(bizId).then(() => {
      eventBus.publish(bizId, 'inventory.updated', { action: 'dish_created', dishId: dish.id });
      return generateInsights(bizId);
    })
      .then(fresh => storeInsights(bizId, fresh))
      .catch(() => {});
  } catch (err) { next(err); }
});

// PUT /api/dishes/:id
router.put('/:id', requireAuth, requireManager, validate({ body: schemas.updateDishSchema }), async (req, res, next) => {
  try {
    const { recipes, ingredients, packaging, accompaniments, ...fields } = req.body;
    if (fields.name) {
      const { rows: dupe } = await db.query(
        `SELECT 1 FROM dishes WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND id != $3 AND (is_active IS NULL OR is_active = TRUE)`,
        [req.user.businessId, fields.name.trim(), req.params.id]
      );
      if (dupe.length) return res.status(409).json({ error: 'כבר קיימת מנה בשם הזה' });
    }
    // fields now includes recipeText if provided — passed through to model.update
    const updated = await dishModel.update(req.params.id, req.user.businessId, fields);
    if (!updated) return res.status(404).json({ error: 'מנה לא נמצאה' });
    if (recipes !== undefined) await dishModel.setRecipes(req.params.id, req.user.businessId, recipes);
    if (ingredients !== undefined) await saveDishIngredients(req.params.id, req.user.businessId, ingredients);
    if (packaging !== undefined) await setPackaging(req.params.id, req.user.businessId, packaging || []);
    if (accompaniments !== undefined) await setAccompaniments(req.params.id, req.user.businessId, accompaniments || []);
    const full = await dishModel.findById(req.params.id, req.user.businessId);
    res.json({ dish: full });

    // Bust stale caches then publish sync event — fire-and-forget so a Redis
    // timeout doesn't delay the response or block the SSE event from firing.
    const bizId = req.user.businessId;
    bustDishCaches(bizId).then(() => {
      eventBus.publish(bizId, 'inventory.updated', { action: 'dish_updated', dishId: req.params.id });
      return generateInsights(bizId);
    })
      .then(fresh => storeInsights(bizId, fresh))
      .catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/dishes/bulk-delete — soft-delete multiple dishes at once
router.post('/bulk-delete', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'נדרש מערך של מזהי מנות' });
    if (ids.length > 100)
      return res.status(400).json({ error: 'ניתן למחוק עד 100 מנות בפעולה אחת' });

    const deleted = await bulkRemove(ids, req.user.businessId);
    res.json({ deleted: deleted.length, names: deleted.map(r => r.name) });

    const bizId = req.user.businessId;
    bustDishCaches(bizId).then(() => {
      eventBus.publish(bizId, 'inventory.updated', { action: 'dishes_bulk_deleted', count: deleted.length });
      return generateInsights(bizId);
    })
      .then(fresh => storeInsights(bizId, fresh))
      .catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/dishes/:id
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    await dishModel.remove(req.params.id, req.user.businessId);
    res.json({ message: 'מנה נמחקה' });

    const bizId = req.user.businessId;
    bustDishCaches(bizId).then(() => {
      eventBus.publish(bizId, 'inventory.updated', { action: 'dish_deleted', dishId: req.params.id });
      return generateInsights(bizId);
    })
      .then(fresh => storeInsights(bizId, fresh))
      .catch(() => {});
  } catch (err) { next(err); }
});

module.exports = router;
