const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission, requireManager } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validateInput');
const { rateLimitAI } = require('../middleware/rateLimitAI');
const recipeModel = require('../models/recipe.model');
const db = require('../utils/db');
const { onRecipeChanged } = require('../services/sync.service');
const eventBus = require('../utils/eventBus');
const Anthropic = require('@anthropic-ai/sdk');
const { logTokenUsage } = require('../utils/logTokenUsage');
const logger = require('../utils/logger');
const grokService   = require('../services/ai/grokService');
const geminiService = require('../services/ai/geminiService');
const { normalizeParsedLines } = require('../utils/parsedIngredientLines');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// הוסף עמודות manual_cost/manual_name לטבלת recipe_ingredients אם לא קיימות —
// נדרשות ל-recipe.model.js (מרכיב ידני בלי item_id מקושר למלאי)
db.migrate(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS manual_cost NUMERIC(10,4)`);
db.migrate(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS manual_name VARCHAR(255)`);
db.migrate(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
db.migrate(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
// ודא FK עם ON DELETE SET NULL כדי שמחיקת recipe לא תשבור sale_items היסטוריים
db.migrate(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.referential_constraints
      WHERE constraint_name = 'sale_items_recipe_id_fkey'
    ) THEN
      ALTER TABLE sale_items ADD CONSTRAINT sale_items_recipe_id_fkey
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL;
    END IF;
  END $$
`);

// GET /api/recipes — כל המתכונים
router.get('/', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const recipes = await recipeModel.findAllByBusiness(req.user.businessId);
    res.json({ recipes });
  } catch (err) { next(err); }
});

// GET /api/recipes/analysis — ניתוח רווחיות
router.get('/analysis', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const analysis = await recipeModel.getProfitAnalysis(req.user.businessId);
    res.json(analysis);
  } catch (err) { next(err); }
});

// GET /api/recipes/categories — קטגוריות
router.get('/categories', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const cats = await recipeModel.getCategories(req.user.businessId);
    res.json(cats);
  } catch (err) { next(err); }
});

// POST /api/recipes/categories — קטגוריה חדשה
router.post('/categories', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { name, posCategoryId } = req.body;
    if (!name) return res.status(400).json({ error: 'שם קטגוריה חסר' });
    const cat = await recipeModel.createCategory(req.user.businessId, { name, posCategoryId });
    eventBus.publish(req.user.businessId, 'menu.changed', { action: 'category_created', categoryId: cat.id });
    res.status(201).json(cat);
  } catch (err) { next(err); }
});

// GET /api/recipes/catalog — פריטים מהמלאי
router.get('/catalog', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         ii.id::text                           AS key,
         ii.name                               AS name,
         ii.unit                               AS unit,
         ii.unit                               AS latest_unit,
         ii.cost_per_unit::float               AS latest_price,
         ii.cost_per_unit::float               AS avg_price,
         ii.cost_per_unit::float               AS min_price,
         ii.cost_per_unit::float               AS max_price,
         ii.updated_at::date                   AS last_invoice_date,
         ii.current_qty::float                 AS current_qty,
         c.name                                AS category_name
       FROM inventory_items ii
       LEFT JOIN inventory_categories c ON c.id = ii.category_id
       WHERE ii.business_id = $1
       ORDER BY ii.name ASC`,
      [req.user.businessId]
    );
    res.json({ ingredients: rows });
  } catch (err) { next(err); }
});

const _RECIPE_PARSE_PROMPT = `אתה מנתח טקסט חופשי בעברית המתאר הרכב של מנה/מתכון, ומחלץ ממנו רשימת מרכיבים מובנית.

הטקסט עשוי לתאר כמה מרכיבים ברצף (מופרדים בפסיקים, נקודות, שורות חדשות, "ו-" וכו').
כל מרכיב מתואר באחת מהצורות:
1. כמות מדויקת + יחידה: "חזה עוף 150 גרם", "שמן 10 מ"ל", "2 ביצים", "כוס קמח"
2. כמות משוערת (מסומנת ב"כ-"/"בערך"/"בסביבות"): "שמן כ-10 מ"ל"
3. לפי עלות בשקלים בלבד (ללא כמות): "פירורי לחם בשווי 3 שקל", "רוטב ב-2 ₪", "תבלינים בעלות 1.5 שקל"

עבור כל מרכיב, התאם אותו לפריט המתאים ביותר מרשימת המלאי שסופקה (השוואה לפי שם, כולל התאמה חלקית/נרדפת/סדר מילים שונה). אם אין התאמה סבירה — החזר matchedItemId: null.
רשימת המלאי כוללת גם את יחידת המדידה שבה כל פריט מנוהל במלאי (משקל/נפח/ספירה).

יחידות מוכרות בלבד — נרמל כל יחידה שמופיעה בטקסט לאחת מאלה בדיוק:
משקל: גרם, קילוגרם, מיליגרם, טון
נפח: מיליליטר, ליטר, כוס, כף, כפית, סנטיליטר, דציליטר
ספירה: יחידה, חבילה, קרטון, ארגז, בקבוק, פחית, שקית, ביצה, שן שום, פרוסה, עלה, ראש, כיכר, צרור, ענף

חשוב מאוד — התאמת סוג יחידה (משקל/נפח) לפריט המלאי שמצאת:
המרה בין משקל לנפח (למשל גרם↔מ"ל) אינה אפשרית באופן מדויק במערכת — לכן כשמצאת התאמה במלאי (matchedItemId), חובה להחזיר unit מאותו סוג מדידה (family) שבו הפריט מנוהל במלאי, גם אם בטקסט המקורי תואר במידה מסוג אחר. השתמש בידע קולינרי כללי כדי להעריך:
- אם הפריט מנוהל במלאי לפי משקל אך בטקסט תואר לפי נפח (למשל "כוס אורז" כשאורז מנוהל בק"ג) — המר לפי אומדן קולינרי מקובל למשקל (כוס אורז ≈ 200 גרם, כוס קמח ≈ 130 גרם, כף ≈ 15 גרם לנוזלים סמיכים וכו') והחזר unit במשקל, עם isApproximate: true.
- אם הפריט מנוהל במלאי לפי נפח אך תואר לפי משקל — בצע את ההמרה ההפוכה באותו אופן, עם isApproximate: true.
- אם לא נמצאה התאמה במלאי (matchedItemId: null) — השאר את היחידה כפי שתוארה בטקסט, ללא צורך בהתאמה.

אל תמיר בעצמך בין יחידות מאותה משפחה:
אם הטקסט אומר "20 מ"ל" — החזר qty: 20, unit: "מיליליטר". אל תחזיר 0.02 ליטר. אם הטקסט אומר "250 גרם" — החזר qty: 250, unit: "גרם", לא 0.25 קילוגרם.
המערכת מבצעת את ההמרה בין גרם לק"ג ובין מ"ל לליטר בעצמה ובדיוק מלא; חישוב שלך עלול לעגל (נצפה בפועל: "20 מ"ל" הוחזר כ-0.018 ליטר במקום 0.02).
ההמרה היחידה שמוטלת עליך היא בין **משפחות** שונות (נפח↔משקל, למשל "כוס אורז" → גרם), כי לזו אין נוסחה במערכת.

יחידות ספירה — כלל מחמיר יותר:
ליחידות ספירה אין יחס מוגדר זו לזו (ארגז אינו מספר קבוע של יחידות), ולכן המערכת אינה יכולה להמיר ביניהן כלל.
כשמצאת התאמה במלאי (matchedItemId) והפריט מנוהל לפי יחידת ספירה — חובה להחזיר unit **בדיוק** כמחרוזת יחידת הניהול של אותו פריט כפי שהופיעה ברשימה (למשל "יח'" או "יחידה"), ולהביע את הכמות באותה יחידה.
דוגמה: "2 ביצים" כשהפריט "ביצים" מנוהל לפי "יח'" → qty: 2, unit: "יח'" (ולא "ביצה").
דוגמה: "פחית קולה" כשהפריט "קולה פחיות" מנוהל לפי "יחידה" → qty: 1, unit: "יחידה" (ולא "פחית").

החזר אך ורק מערך JSON בפורמט הזה, ללא טקסט נוסף לפני/אחרי:
[
  {
    "rawText": "הקטע המקורי בטקסט שמתאר את המרכיב הזה",
    "name": "שם המרכיב כפי שמופיע בטקסט (בלי כמות/יחידה/מחיר)",
    "matchedItemId": "המזהה מרשימת המלאי שסופקה, או null",
    "qty": מספר או null,
    "unit": "אחת מהיחידות המוכרות למעלה, או null",
    "costShekels": מספר או null,
    "isApproximate": true או false
  }
]

חשוב:
- אם תואר לפי עלות ("בשווי X שקל") — החזר costShekels ו-qty=null, unit=null.
- אם תוארה כמות מפורשת — החזר qty ו-unit, costShekels=null.
- אל תמציא מרכיבים שלא הוזכרו בטקסט. אל תמציא מזהה — רק מזהה שקיים ברשימה שסופקה.`;

// Extracts a JSON array from a raw model response — strips ```json fences,
// tolerates a trailing comma. Shared across all 3 provider tiers below since
// the prompt/expected-shape is identical regardless of which one answered.
function _extractJsonArray(responseText) {
  const text = (responseText || '').trim();
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ||
                    text.match(/```\s*([\s\S]*?)\s*```/) ||
                    text.match(/(\[[\s\S]*\])/);
  const jsonStr = jsonMatch ? jsonMatch[1] : text;
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(jsonStr.replace(/,(\s*[\]}])/g, '$1'));
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
}

// POST /api/recipes/parse-ingredients-text — פענוח AI של תיאור מרכיבים בטקסט חופשי
router.post('/parse-ingredients-text', requireAuth, requirePermission('recipes'), rateLimitAI(), async (req, res, next) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'טקסט חסר' });
    if (text.length > 2000) return res.status(400).json({ error: 'הטקסט ארוך מדי (מקסימום 2000 תווים)' });

    const { rows: catalog } = await db.query(
      `SELECT id::text AS id, name, unit, cost_per_unit::float AS cost_per_unit
         FROM inventory_items WHERE business_id = $1 ORDER BY name ASC`,
      [req.user.businessId]
    );

    const catalogList = catalog.length
      ? catalog.map(c => `${c.id} | ${c.name} | מנוהל במלאי לפי: ${c.unit}`).join('\n')
      : '(אין פריטי מלאי רשומים עדיין)';

    const userPrompt = `רשימת פריטי מלאי זמינים (id | שם | יחידת ניהול במלאי):\n${catalogList}\n\nהטקסט לניתוח:\n"""\n${text}\n"""\n\nהחזר JSON בלבד.`;

    // This is a fixed structured-extraction task, not open-ended reasoning —
    // try the free/cheap tiers already used platform-wide (aiOrchestrator.
    // service.js) before paid Claude, and only fall back when a tier genuinely
    // can't produce a valid result (API error, or output that doesn't parse
    // as the expected JSON array).
    let parsed = null;

    try {
      const g = await grokService.chat(_RECIPE_PARSE_PROMPT, [{ role: 'user', content: userPrompt }], { maxTokens: 2000 });
      parsed = _extractJsonArray(g.text);
      if (parsed) {
        logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'recipe_ingredient_parse', model: g.model, usage: { input_tokens: g.inputTokens, output_tokens: g.outputTokens } });
      }
    } catch (err) {
      logger.warn('[recipes] parse-ingredients-text: Groq (free tier) failed, trying Gemini', { err: err.message });
    }

    if (!parsed) {
      try {
        const gem = await geminiService.chat(_RECIPE_PARSE_PROMPT, [{ role: 'user', content: userPrompt }], { maxTokens: 2000 });
        parsed = _extractJsonArray(gem.text);
        if (parsed) {
          logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'recipe_ingredient_parse', model: gem.model, usage: { input_tokens: gem.inputTokens, output_tokens: gem.outputTokens } });
        }
      } catch (err) {
        logger.warn('[recipes] parse-ingredients-text: Gemini (cheap tier) failed, trying Claude', { err: err.message });
      }
    }

    if (!parsed) {
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await anthropic.messages.create({
            model:      'claude-haiku-4-5',
            max_tokens: 2000,
            system:     _RECIPE_PARSE_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
          });
          break;
        } catch (aiErr) {
          logger.error('[recipes] parse-ingredients-text: all 3 providers failed', { attempt: attempt + 1, status: aiErr.status, err: aiErr.message });
          const overloaded = aiErr.status === 529 || aiErr.status === 503 || aiErr.status === 429;
          if (attempt === 0 && overloaded) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          // A 400 mentioning "credit balance" means the account needs billing
          // attention, not a transient blip — telling the user to "try again
          // in a few seconds" would be actively misleading in that case.
          const isBilling = aiErr.status === 400 && /credit balance/i.test(aiErr.message || '');
          return res.status(503).json({
            error: isBilling
              ? 'בעיית חיוב בחשבון ה-AI — נדרש להוסיף קרדיט (לא ייפתר לבד, נסיון חוזר לא יעזור)'
              : 'שירות ה-AI לא זמין כרגע — נסה שוב בעוד מספר שניות',
          });
        }
      }

      logTokenUsage({ businessId: req.user.businessId, userId: req.user.userId, feature: 'recipe_ingredient_parse', model: 'claude-haiku-4-5', usage: result.usage });

      const responseText = result.content.find(b => b.type === 'text')?.text?.trim() || '';
      parsed = _extractJsonArray(responseText);
      if (!parsed) {
        logger.error('[recipes] parse-ingredients-text: invalid JSON from AI', { snippet: responseText.slice(0, 200) });
        return res.status(502).json({ error: 'לא הצלחנו לפענח את הטקסט — נסה לנסח מחדש' });
      }
    }

    // ההצלבה מול יחידות המלאי מרוכזת ב-utils/parsedIngredientLines.js —
    // שורה שיחידתה לא ניתנת להמרה ליחידת הפריט מאבדת את הקישור בשקט בשמירה
    // (setIngredients), ולכן היא מטופלת שם במפורש לפני שהמשתמש רואה אותה.
    const lines = normalizeParsedLines(parsed, catalog);

    res.json({ lines });
  } catch (err) {
    logger.error('[recipes] parse-ingredients-text failed', { err: err.message });
    next(err);
  }
});

// GET /api/recipes/:id — מתכון בודד
router.get('/:id', requireAuth, requirePermission('recipes'), async (req, res, next) => {
  try {
    const recipe = await recipeModel.findById(req.params.id, req.user.businessId);
    if (!recipe) return res.status(404).json({ error: 'מתכון לא נמצא' });
    res.json(recipe);
  } catch (err) { next(err); }
});

// POST /api/recipes — מתכון חדש
router.post('/', requireAuth, requireManager, validate({ body: schemas.createRecipeSchema }), async (req, res, next) => {
  try {
    const { name, sellingPrice, categoryId, posItemId, ingredients } = req.body;
    if (!name) return res.status(400).json({ error: 'שם מתכון חסר' });

    // Dishes are linked to their shadow recipe row by LOWER(name) alone (see
    // dish.model.js remove()/update()), and several AI agents/reports also
    // join dishes<->recipes by name — two recipes sharing a name in one
    // business would make those lookups silently ambiguous.
    const { rows: dupe } = await db.query(
      `SELECT 1 FROM recipes WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND (is_active IS NULL OR is_active = TRUE)`,
      [req.user.businessId, name.trim()]
    );
    if (dupe.length) return res.status(409).json({ error: 'כבר קיים מתכון בשם הזה' });

    const recipe = await recipeModel.create(req.user.businessId, {
      name, sellingPrice, categoryId, posItemId,
    });

    if (ingredients?.length) {
      await recipeModel.setIngredients(recipe.id, req.user.businessId, ingredients);
    }

    const full = await recipeModel.findById(recipe.id, req.user.businessId);
    onRecipeChanged(req.user.businessId, recipe.id).catch(() => {});
    res.status(201).json(full);
  } catch (err) { next(err); }
});

// PUT /api/recipes/:id — עדכון מתכון
router.put('/:id', requireAuth, requireManager, validate({ body: schemas.updateRecipeSchema }), async (req, res, next) => {
  try {
    const { ingredients, ...fields } = req.body;

    const recipe = await recipeModel.findById(req.params.id, req.user.businessId);
    if (!recipe) return res.status(404).json({ error: 'מתכון לא נמצא' });

    if (fields.name) {
      const { rows: dupe } = await db.query(
        `SELECT 1 FROM recipes WHERE business_id = $1 AND LOWER(name) = LOWER($2) AND id != $3 AND (is_active IS NULL OR is_active = TRUE)`,
        [req.user.businessId, fields.name.trim(), req.params.id]
      );
      if (dupe.length) return res.status(409).json({ error: 'כבר קיים מתכון בשם הזה' });
    }

    await recipeModel.update(req.params.id, req.user.businessId, fields);

    if (ingredients !== undefined) {
      await recipeModel.setIngredients(req.params.id, req.user.businessId, ingredients);
    }

    const full = await recipeModel.findById(req.params.id, req.user.businessId);
    onRecipeChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json(full);
  } catch (err) { next(err); }
});

// DELETE /api/recipes/:id — מחיקת מתכון
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const recipe = await recipeModel.findById(req.params.id, req.user.businessId);
    if (!recipe) return res.status(404).json({ error: 'מתכון לא נמצא' });
    await recipeModel.remove(req.params.id, req.user.businessId);
    onRecipeChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json({ message: 'מתכון נמחק' });
  } catch (err) { next(err); }
});

// PUT /api/recipes/:id/ingredients — עדכון מרכיבים בלבד
router.put('/:id/ingredients', requireAuth, requireManager, validate({ body: schemas.updateRecipeSchema }), async (req, res, next) => {
  try {
    const { ingredients } = req.body;
    if (!Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'ingredients חייב להיות מערך' });
    }
    const existing = await recipeModel.findById(req.params.id, req.user.businessId);
    if (!existing) return res.status(404).json({ error: 'מתכון לא נמצא' });
    const savedCount = await recipeModel.setIngredients(req.params.id, req.user.businessId, ingredients);
    const full = await recipeModel.findById(req.params.id, req.user.businessId);
    // Use what was actually persisted, not what was submitted — setIngredients
    // silently drops rows referencing an unowned/stale inventory item, so a
    // submission that ends up saving zero ingredients must not clear the
    // "missing ingredients" alert as if the recipe were now complete.
    if (savedCount > 0 && full?.name) {
      const escapedName = full.name.replace(/[%_\\]/g, '\\$&');
      await db.query(
        `DELETE FROM notifications WHERE business_id=$1 AND type='missing_ingredients' AND body LIKE $2`,
        [req.user.businessId, `%${escapedName}%`]
      ).catch(() => {});
    }
    onRecipeChanged(req.user.businessId, req.params.id).catch(() => {});
    res.json(full);
  } catch (err) { next(err); }
});

module.exports = router;
