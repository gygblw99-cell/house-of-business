/**
 * Config Validator Agent
 *
 * Detects unrealistic/suspicious business configurations using statistical methods.
 * Returns insights in the same format as autoInsights so they appear in the dashboard panel.
 *
 * Checks:
 *  1. Dish selling price outliers (IQR method)
 *  2. Dish cost >= selling price (impossible margin)
 *  3. Employee salary below Israeli legal minimum wage
 *  4. Employee salary outliers (possible typo — e.g. 50,000 NIS/month)
 *  5. Inventory items with cost_per_unit = 0 (missing cost data)
 */

const db     = require('../utils/db');
const logger = require('../utils/logger');

// Israeli minimum wage (update annually)
const MIN_HOURLY_WAGE  = 32.30;  // NIS per hour
const MIN_MONTHLY_WAGE = 5_571;  // NIS per month

// ── IQR outlier detection ─────────────────────────────────────────────────────
// Returns fence values, or null if the dataset is too uniform to detect outliers.
function _iqrFences(values) {
  if (values.length < 3) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const q1 = s[Math.floor(n * 0.25)];
  const q3 = s[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  if (iqr < 5) return null; // All values too similar — no meaningful outliers
  return { q1, q3, lower: q1 - 1.5 * iqr, upper: q3 + 1.5 * iqr };
}

// ── 1. Dish price outliers ────────────────────────────────────────────────────
async function _checkDishPrices(businessId, out) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, selling_price FROM dishes WHERE business_id = $1 AND selling_price > 0 AND (is_active IS NULL OR is_active = TRUE) ORDER BY selling_price`,
      [businessId]
    );
    if (rows.length < 3) return;

    const prices = rows.map(r => parseFloat(r.selling_price));
    const f = _iqrFences(prices);
    if (!f) return;

    for (const row of rows) {
      const p = parseFloat(row.selling_price);
      if (p < f.lower || p > f.upper) {
        const dir = p > f.upper ? 'גבוה' : 'נמוך';
        out.push({
          type:     'config_warning',
          title:    `מחיר ${dir} חריג: "${row.name}"`,
          body:     `המחיר של "${row.name}" הוא ₪${p.toFixed(0)}, בעוד רוב המנות נעות בין ₪${Math.round(f.q1)} ל-₪${Math.round(f.q3)}. ודא שהמחיר הוזן נכון.`,
          impact:   null,
          severity: 'warning',
        });
      }
    }
  } catch (err) {
    logger.warn('[configValidator] dish prices check failed', { err: err.message });
  }
}

// ── 2. Dish cost >= selling price (negative or zero margin) ──────────────────
async function _checkDishMargins(businessId, out) {
  try {
    const { rows } = await db.query(
      `SELECT
         d.id, d.name, d.selling_price,
         COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0) AS calc_cost
       FROM dishes d
       LEFT JOIN dish_ingredients di ON di.dish_id = d.id
       LEFT JOIN inventory_items  ii ON ii.id = di.inventory_item_id AND ii.business_id = $1
       WHERE d.business_id = $1 AND d.selling_price > 0 AND (d.is_active IS NULL OR d.is_active = TRUE)
       GROUP BY d.id, d.name, d.selling_price
       HAVING COALESCE(SUM(di.qty * COALESCE(ii.cost_per_unit, di.manual_cost, 0)), 0) > 0`,
      [businessId]
    );

    for (const row of rows) {
      const cost  = parseFloat(row.calc_cost);
      const price = parseFloat(row.selling_price);
      if (cost >= price) {
        out.push({
          type:     'config_warning',
          title:    `עלות גבוהה ממחיר: "${row.name}"`,
          body:     `עלות הייצור של "${row.name}" (₪${cost.toFixed(2)}) גבוהה ממחיר המכירה (₪${price.toFixed(2)}). מכל מכירה תפסיד כסף. בדוק את המרכיבים או עדכן את המחיר.`,
          impact:   Math.round((cost - price) * 10), // estimated weekly loss (×10 sales)
          severity: 'critical',
        });
      } else if (cost / price > 0.75) {
        // Food cost > 75% — margin below 25%
        out.push({
          type:     'config_warning',
          title:    `מרג'ין קיצוני: "${row.name}"`,
          body:     `עלות חומרי הגלם של "${row.name}" עומדת על ${((cost / price) * 100).toFixed(0)}% ממחיר המכירה — פחות מ-25% רווח גולמי. יעד תעשייתי הוא מתחת ל-35%.`,
          impact:   null,
          severity: 'warning',
        });
      }
    }
  } catch (err) {
    logger.warn('[configValidator] dish margins check failed', { err: err.message });
  }
}

// ── 3 & 4. Employee salary issues ─────────────────────────────────────────────
async function _checkEmployeeSalaries(businessId, out) {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, salary_type, salary_amount FROM users
       WHERE business_id = $1 AND salary_amount > 0 AND role != 'owner'`,
      [businessId]
    );
    if (!rows.length) return;

    const hourly  = rows.filter(r => r.salary_type === 'hourly');
    const global  = rows.filter(r => r.salary_type === 'global');

    // Below minimum wage
    for (const r of hourly) {
      const rate = parseFloat(r.salary_amount);
      if (rate < MIN_HOURLY_WAGE) {
        out.push({
          type:     'config_warning',
          title:    `שכר מינימום: ${r.full_name}`,
          body:     `שכר השעה של ${r.full_name} (₪${rate.toFixed(2)}) נמוך משכר המינימום החוקי (₪${MIN_HOURLY_WAGE}). עדכן את השכר כדי להימנע מהפרת חוק.`,
          impact:   null,
          severity: 'critical',
        });
      }
    }
    for (const r of global) {
      const amt = parseFloat(r.salary_amount);
      if (amt < MIN_MONTHLY_WAGE) {
        out.push({
          type:     'config_warning',
          title:    `שכר מינימום: ${r.full_name}`,
          body:     `השכר החודשי של ${r.full_name} (₪${amt.toFixed(0)}) נמוך משכר המינימום החוקי (₪${MIN_MONTHLY_WAGE.toLocaleString()}). עדכן את השכר.`,
          impact:   null,
          severity: 'critical',
        });
      }
    }

    // Salary outliers — compare within same type
    for (const group of [hourly, global]) {
      if (group.length < 3) continue;
      const amounts = group.map(r => parseFloat(r.salary_amount));
      const f = _iqrFences(amounts);
      if (!f) continue;
      for (const r of group) {
        const amt = parseFloat(r.salary_amount);
        if (amt > f.upper) {
          const unit = r.salary_type === 'hourly' ? 'ש"ח/שעה' : 'ש"ח/חודש';
          out.push({
            type:     'config_warning',
            title:    `שכר גבוה חריג: ${r.full_name}`,
            body:     `השכר של ${r.full_name} (₪${amt.toFixed(0)} ${unit}) גבוה משמעותית מהממוצע בצוות. ודא שהוזן נכון.`,
            impact:   null,
            severity: 'warning',
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[configValidator] employee salary check failed', { err: err.message });
  }
}

// ── 5. Inventory items missing cost ──────────────────────────────────────────
async function _checkInventoryCosts(businessId, out) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM inventory_items
       WHERE business_id = $1 AND (cost_per_unit IS NULL OR cost_per_unit = 0)`,
      [businessId]
    );
    const cnt = rows[0]?.cnt || 0;
    if (cnt >= 3) {
      out.push({
        type:     'config_warning',
        title:    `${cnt} פריטי מלאי ללא עלות`,
        body:     `${cnt} פריטי מלאי מוגדרים ללא עלות ליחידה. ללא עלות, המערכת לא יכולה לחשב עלות מנות, רווחיות, או לזהות דליפות. עדכן את העלויות בדף המלאי.`,
        impact:   null,
        severity: 'warning',
      });
    }
  } catch (err) {
    logger.warn('[configValidator] inventory cost check failed', { err: err.message });
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
async function validateBusinessConfig(businessId) {
  const warnings = [];
  await Promise.allSettled([
    _checkDishPrices(businessId, warnings),
    _checkDishMargins(businessId, warnings),
    _checkEmployeeSalaries(businessId, warnings),
    _checkInventoryCosts(businessId, warnings),
  ]);
  return warnings;
}

module.exports = { validateBusinessConfig };
