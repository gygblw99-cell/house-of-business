/**
 * GET /api/data-quality
 * Runs real-time SQL checks against the business's data and returns
 * a list of data-quality issues that could harm platform reliability.
 * Results are computed live — they self-heal the moment the user fixes the data.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../utils/db');
const { EXPENSE_ACTIVE_TODAY } = require('../utils/expenseWindow');

// ── Check definitions ──────────────────────────────────────────────────────
// Each check receives (db, businessId) and returns:
//   { count: number, details?: string }
// count = 0 means "no issue"

const CHECKS = [

  // ── 1. Recipes: all ingredients have zero/null cost (profit shows 100%) ──
  {
    id:          'recipe_zero_cost',
    severity:    'critical',
    title:       'מנות ללא עלות ייצור',
    description: 'יש לחשב עלות אמיתית עבור כל מנה — כל עוד העלות היא אפס, הרווחיות מוצגת כ-100% ונתוני הP&L אינם אמינים.',
    fix_hint:    'כנסו למנות, בחרו מנה ועדכנו את עלות הרכיבים',
    fix_route:   '/recipes',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT ri.recipe_id)::int AS count
        FROM recipe_ingredients ri
        LEFT JOIN inventory_items ii ON ii.id = ri.item_id
        WHERE ri.recipe_id IN (
          SELECT id FROM recipes WHERE business_id = $1
        )
        GROUP BY ri.recipe_id
        HAVING SUM(COALESCE(ri.manual_cost, ii.cost_per_unit, 0)) = 0
      `, [businessId]);
      const count = rows.length;
      return { count, details: count > 0 ? `${count} מנות` : null };
    },
  },

  // ── 2. Recipes with no ingredients at all ──────────────────────────────
  {
    id:          'recipe_no_ingredients',
    severity:    'critical',
    title:       'מנות ריקות ללא רכיבים',
    description: 'מנות שלא הוגדרו להן רכיבים — עלות המנה היא אפס והרווחיות אינה ניתנת לחישוב. הנדסת תפריט וP&L לא יעבדו כראוי.',
    fix_hint:    'כנסו למנות, בחרו מנה והוסיפו רכיבים עם כמויות',
    fix_route:   '/recipes',
    async run(businessId) {
      // Only flag if the business has configured ingredients for at least some recipes.
      // Businesses that haven't set up ingredient tracking at all (e.g. Z-report only)
      // have auto-created recipe stubs — alerting about them is noise, not an action item.
      const { rows } = await db.query(`
        WITH has_any_ingredients AS (
          SELECT 1 FROM recipe_ingredients ri
          JOIN recipes r2 ON r2.id = ri.recipe_id
          WHERE r2.business_id = $1
          LIMIT 1
        )
        SELECT COUNT(r.id)::int AS count
        FROM recipes r
        WHERE r.business_id = $1
          AND EXISTS (SELECT 1 FROM has_any_ingredients)
          AND NOT EXISTS (
            SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id = r.id
          )
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 3. Employees with no salary ────────────────────────────────────────
  {
    id:          'employee_no_salary',
    severity:    'critical',
    title:       'עובדים ללא שכר מוגדר',
    description: 'עובדים שאין להם שכר שעתי או חודשי — עלות העבודה בP&L אינה נכונה ותלושי שכר לא יכולים להיות מחושבים.',
    fix_hint:    'כנסו לעובדים, בחרו עובד ועדכנו את השכר',
    fix_route:   '/employees',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count
        FROM users
        WHERE business_id = $1
          AND role IN ('employee','manager')
          AND is_active = TRUE
          AND pending_invite = FALSE
          AND (salary_amount IS NULL OR salary_amount = 0)
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 4. No Z-reports in the last 14 days ───────────────────────────────
  {
    id:          'zreport_stale',
    severity:    'critical',
    title:       'אין דוחות Z מהשבועיים האחרונים',
    description: 'לא הועלו דוחות Z ב-14 הימים האחרונים — נתוני מכירות חסרים, חיזוי ביקוש לא מדויק ודוח P&L אינו עדכני.',
    fix_hint:    'העלו דוחות Z דרך עמוד דוחות Z',
    fix_route:   '/zreport',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count
        FROM sales
        WHERE business_id = $1
          AND pos_sale_id LIKE 'Z-%'
          AND sold_at >= NOW() - INTERVAL '14 days'
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0, details: rows[0].count === 0 ? '0 דוחות ב-14 יום' : null };
    },
  },

  // ── 5. No fixed expenses at all ────────────────────────────────────────
  {
    id:          'no_fixed_expenses',
    severity:    'high',
    title:       'אין הוצאות קבועות מוגדרות',
    description: 'לא הוגדרו שכר דירה, חשמל, ארנונה או הוצאות קבועות אחרות — הרווח הנקי בP&L גבוה בהרבה מהאמת.',
    fix_hint:    'כנסו לפיננסים והוסיפו הוצאות קבועות',
    fix_route:   '/finance',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM fixed_expenses
        WHERE business_id = $1 AND is_active = TRUE${EXPENSE_ACTIVE_TODAY}
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 6. Inventory items with no purchase cost ───────────────────────────
  {
    id:          'inventory_no_cost',
    severity:    'high',
    title:       'פריטי מלאי ללא מחיר קנייה',
    description: 'מוצרים במלאי שלא הוזן להם מחיר קנייה — עלות המזון לא ניתנת לחישוב אמיתי ונתוני ה-COGS שגויים.',
    fix_hint:    'כנסו למלאי ועדכנו מחיר קנייה לכל מוצר',
    fix_route:   '/inventory',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM inventory_items
        WHERE business_id = $1
          AND (cost_per_unit IS NULL OR cost_per_unit = 0)
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 7. Recipes with selling price = 0 ─────────────────────────────────
  {
    id:          'recipe_no_price',
    severity:    'high',
    title:       'מנות ללא מחיר מכירה',
    description: 'מנות שמחיר המכירה שלהן הוא אפס — הנדסת תפריט, חיזוי הכנסות וניתוח רווחיות לא ניתנים לביצוע.',
    fix_hint:    'כנסו למנות ועדכנו מחיר מכירה',
    fix_route:   '/recipes',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM recipes
        WHERE business_id = $1
          AND (selling_price IS NULL OR selling_price = 0)
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 8. No suppliers defined ────────────────────────────────────────────
  {
    id:          'no_suppliers',
    severity:    'high',
    title:       'אין ספקים מוגדרים',
    description: 'לא הוגדרו ספקים — השוואת מחירים, מעקב הזמנות וניתוח עלויות רכש אינם פועלים.',
    fix_hint:    'כנסו לספקים והוסיפו לפחות ספק אחד',
    fix_route:   '/suppliers',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM suppliers WHERE business_id = $1
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 9. Fewer than 30 days of Z-reports ────────────────────────────────
  {
    id:          'zreport_insufficient',
    severity:    'medium',
    title:       'נתוני מכירות לא מספיקים לחיזוי',
    description: 'יש פחות מ-30 ימים של דוחות Z — מודל חיזוי הביקוש זקוק לנתוני היסטוריה מינימליים כדי להיות מדויק.',
    fix_hint:    'העלו דוחות Z נוספים מהתקופה האחרונה',
    fix_route:   '/zreport',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT DATE(sold_at))::int AS count
        FROM sales
        WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
      `, [businessId]);
      const days = rows[0].count;
      return { count: days < 30 && days > 0 ? 1 : 0, details: days > 0 ? `רק ${days} ימים` : null };
    },
  },

  // ── 10. No inventory items ─────────────────────────────────────────────
  {
    id:          'no_inventory',
    severity:    'medium',
    title:       'מלאי ריק',
    description: 'לא הוגדרו פריטי מלאי — עלות המזון לא ניתנת לחישוב, התראות מלאי לא יעבדו ורכישות לא ניתנות למעקב.',
    fix_hint:    'כנסו למלאי והוסיפו את חומרי הגלם שלכם',
    fix_route:   '/inventory',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM inventory_items WHERE business_id = $1
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 11. Inventory items with no min_qty (no low-stock alerts possible) ─
  {
    id:          'inventory_no_min',
    severity:    'medium',
    title:       'פריטי מלאי ללא כמות מינימום',
    description: 'מוצרים שלא הוגדרה להם כמות מינימום — התראות מלאי נמוך לא יופעלו ועלול להיגמר מלאי ללא אזהרה.',
    fix_hint:    'כנסו למלאי ועדכנו כמות מינימום לכל מוצר',
    fix_route:   '/inventory',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM inventory_items
        WHERE business_id = $1 AND (min_qty IS NULL OR min_qty = 0)
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 12. Employees worked shifts but have no salary ─────────────────────
  {
    id:          'shift_employees_no_wage',
    severity:    'medium',
    title:       'עובדים שעבדו ללא שכר מוגדר',
    description: 'עובדים שיש להם משמרות מתועדות אך לא הוגדר להם שכר — עלות עבודה בדוחות שגויה לחלוטין.',
    fix_hint:    'כנסו לעובדים ועדכנו שכר לכל עובד שעובד משמרות',
    fix_route:   '/employees',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT u.id)::int AS count
        FROM users u
        WHERE u.business_id = $1
          AND u.role IN ('employee','manager')
          AND u.pending_invite = FALSE
          AND (u.salary_amount IS NULL OR u.salary_amount = 0)
          AND EXISTS (
            SELECT 1 FROM shifts s WHERE s.employee_id = u.id AND s.business_id = $1
          )
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 13. No invoices in last 30 days ───────────────────────────────────
  {
    id:          'no_recent_invoices',
    severity:    'medium',
    title:       'אין חשבוניות ב-30 הימים האחרונים',
    description: 'לא הוקלדו חשבוניות ספקים בחודש האחרון — עלויות רכש חסרות מהדוחות הפיננסיים.',
    fix_hint:    'כנסו לחשבוניות והוסיפו את חשבוניות הספקים',
    fix_route:   '/invoices',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM invoices
        WHERE business_id = $1
          AND invoice_date >= CURRENT_DATE - INTERVAL '30 days'
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 14. Dishes with no ingredients (dish_ingredients is empty) ─────────
  {
    id:          'dish_no_ingredients',
    severity:    'medium',
    title:       'מאכלים ללא רכיבים (Dishes)',
    description: 'מאכלים שלא הוגדרו להם רכיבים — עלות המנה בתפריט היא אפס וחישובי הרווחיות לא מדויקים.',
    fix_hint:    'כנסו למנות, בחרו מאכל והוסיפו רכיבים',
    fix_route:   '/recipes',
    async run(businessId) {
      // Only flag if the business has configured at least one dish with ingredients.
      // Auto-created dish stubs from Z-report import never have ingredients.
      const { rows } = await db.query(`
        WITH has_any_dish_ing AS (
          SELECT 1 FROM dish_ingredients di
          JOIN dishes d2 ON d2.id = di.dish_id
          WHERE d2.business_id = $1
          LIMIT 1
        )
        SELECT COUNT(d.id)::int AS count FROM dishes d
        WHERE d.business_id = $1
          AND (d.is_active IS NULL OR d.is_active = TRUE)
          AND EXISTS (SELECT 1 FROM has_any_dish_ing)
          AND NOT EXISTS (
            SELECT 1 FROM dish_ingredients di WHERE di.dish_id = d.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM dish_recipes dr WHERE dr.dish_id = d.id
          )
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 15. No sales data at all ───────────────────────────────────────────
  {
    id:          'no_sales_data',
    severity:    'critical',
    title:       'אין נתוני מכירות כלל',
    description: 'לא הועלו דוחות מכירות — כל ניתוחי הרווחיות, חיזוי הביקוש ודוח P&L אינם ניתנים לביצוע. הפלטפורמה לא מביאה ערך עסקי.',
    fix_hint:    'העלו דוחות Z דרך עמוד דוחות Z או הזינו מכירות ידנית',
    fix_route:   '/zreport',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM sales WHERE business_id = $1
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 16. Recipes selling below cost ─────────────────────────────────────
  {
    id:          'recipe_selling_below_cost',
    severity:    'critical',
    title:       'מנות שנמכרות מתחת לעלות',
    description: 'מנות שעלות המרכיבים עולה על מחיר המכירה — כל מכירה יוצרת הפסד מצטבר.',
    fix_hint:    'עדכנו מחיר מכירה למנות אלה, או הפחיתו עלויות מרכיבים',
    fix_route:   '/recipes',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(DISTINCT r.id)::int AS count
        FROM recipes r
        JOIN (
          SELECT ri.recipe_id,
                 SUM(COALESCE(ri.manual_cost, ri.qty * COALESCE(ii.cost_per_unit, 0))) AS total_cost
          FROM recipe_ingredients ri
          LEFT JOIN inventory_items ii ON ii.id = ri.item_id
          GROUP BY ri.recipe_id
        ) costs ON costs.recipe_id = r.id
        WHERE r.business_id = $1
          AND r.selling_price > 0
          AND costs.total_cost > r.selling_price
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 17. No completed shifts in last 30 days ────────────────────────────
  {
    id:          'no_shifts_last_30_days',
    severity:    'high',
    title:       'אין נתוני משמרות ב-30 הימים האחרונים',
    description: 'לא נרשמו משמרות עובדים בחודש האחרון — עלות העבודה בP&L היא 0 ושולי הרווח מנופחים.',
    fix_hint:    'ודאו שעובדים מבצעים כניסה/יציאה ממשמרות, או ייבאו משמרות ידנית',
    fix_route:   '/shifts',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM shifts
        WHERE business_id = $1
          AND actual_end IS NOT NULL
          AND actual_start >= NOW() - INTERVAL '30 days'
      `, [businessId]);
      return { count: rows[0].count === 0 ? 1 : 0 };
    },
  },

  // ── 18. Z-report current gap > 7 days ─────────────────────────────────
  // Checks only the CURRENT gap (days since last upload), not historical gaps.
  // Historical gaps (e.g. a holiday break 3 weeks ago) are not actionable once
  // the business has resumed uploading — only the active gap matters.
  // zreport_stale (check #4) already covers 14+ days; this covers 7-13 days.
  {
    id:          'zreport_gap_7days',
    severity:    'high',
    title:       'לא הועלו דוחות Z מעל 7 ימים',
    description: 'הדוח האחרון שהועלה הוא מלפני יותר מ-7 ימים — נתוני מכירות חסרים ותחזיות עלולות להיות מוטות.',
    fix_hint:    'העלו את הדוחות החסרים',
    fix_route:   '/zreport',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COALESCE(
          (CURRENT_DATE - MAX(DATE(sold_at AT TIME ZONE 'Asia/Jerusalem')))::int,
          999
        ) AS days_since_last
        FROM sales
        WHERE business_id = $1 AND pos_sale_id LIKE 'Z-%'
      `, [businessId]);
      const gap = rows[0]?.days_since_last ?? 999;
      // 7–13 days: fire (14+ is already covered by zreport_stale as critical)
      const fire = gap >= 7 && gap < 14;
      return { count: fire ? 1 : 0, details: fire ? `${gap} ימים מהדוח האחרון` : null };
    },
  },

  // ── 19. Stuck open shifts > 16 hours ──────────────────────────────────
  {
    id:          'open_shifts_stuck',
    severity:    'high',
    title:       'משמרות פתוחות מעל 16 שעות',
    description: 'משמרות שלא נסגרו — שעות אלו לא ייחשבו בתלוש השכר ועלות העבודה בP&L מוטה.',
    fix_hint:    'כנסו למשמרות וסגרו ידנית משמרות תקועות',
    fix_route:   '/shifts',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM shifts
        WHERE business_id = $1
          AND actual_end IS NULL
          AND actual_start < NOW() - INTERVAL '16 hours'
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 20. Inventory items with negative quantity ─────────────────────────
  {
    id:          'inventory_negative_qty',
    severity:    'high',
    title:       'מלאי בכמות שלילית',
    description: 'פריטי מלאי עם כמות שלילית — אי-התאמה בין המלאי הפיזי לנתוני המערכת. הזמנות חכמות יהיו שגויות.',
    fix_hint:    'בצעו ספירת מלאי ועדכנו כמויות ידנית',
    fix_route:   '/inventory',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM inventory_items
        WHERE business_id = $1 AND current_qty < 0
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

  // ── 21. Inventory items without supplier ───────────────────────────────
  {
    id:          'inventory_no_supplier',
    severity:    'medium',
    title:       'פריטי מלאי ללא ספק משויך',
    description: 'פריטים ללא ספק — הזמנות חכמות לא יוכלו לשלוח הזמנה אוטומטית לספק.',
    fix_hint:    'ערכו כל פריט מלאי ושייכו לו ספק',
    fix_route:   '/inventory',
    async run(businessId) {
      const { rows } = await db.query(`
        SELECT COUNT(id)::int AS count FROM inventory_items
        WHERE business_id = $1 AND supplier_id IS NULL
      `, [businessId]);
      return { count: rows[0].count };
    },
  },

];

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

// ── GET /api/data-quality ──────────────────────────────────────────────────
router.get('/', requireAuth, requirePermission('finance'), async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const results = await Promise.all(
      CHECKS.map(async (check) => {
        try {
          const { count, details } = await check.run(businessId);
          if (count === 0) return null;
          return {
            id:          check.id,
            severity:    check.severity,
            title:       check.title,
            description: check.description + (details ? ` (${details})` : ''),
            fix_hint:    check.fix_hint,
            fix_route:   check.fix_route,
            count,
          };
        } catch {
          return null; // don't crash the whole list if one check fails
        }
      })
    );

    const issues = results
      .filter(Boolean)
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

    res.json({ issues, total: issues.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
