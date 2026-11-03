/**
 * Daily WhatsApp summary service.
 * Compiles an end-of-day business summary and returns a wa.me deep-link
 * that opens a pre-filled WhatsApp message.
 * No Business API needed — uses the standard wa.me URL scheme.
 */
const db    = require('../../utils/db');
const cache = require('../../utils/cache');
const { todayIL } = require('../../utils/dateIL');

async function buildDailySummary(businessId) {
  const cacheKey = `daily-summary:${businessId}:${todayIL()}`;
  return cache.wrap(cacheKey, () => _buildDailySummaryRaw(businessId), 300);
}

async function _buildDailySummaryRaw(businessId) {
  const todayStr = todayIL();

  // Sales today (smart: Z-report counts if no individual sales today)
  // Compares in Asia/Jerusalem local time, not server/UTC time — avoids
  // "today" resolving to the wrong calendar day between 00:00-03:00 IL time.
  const { rows: sales } = await db.query(`
    WITH day_smart AS (
      SELECT *, (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
      FROM sales
      WHERE business_id = $1 AND DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') = $2::date
    ),
    ind_count AS (SELECT COUNT(*) AS c FROM day_smart WHERE is_ind)
    SELECT COUNT(*)::int AS tx_count, COALESCE(SUM(total_amount), 0)::float AS total
    FROM day_smart, ind_count
    WHERE (ind_count.c > 0 AND is_ind) OR ind_count.c = 0
  `, [businessId, todayStr]).catch(() => ({ rows: [{ tx_count: 0, total: 0 }] }));

  // Active shifts today (any shift started today)
  const { rows: shifts } = await db.query(`
    SELECT COUNT(*)::int AS shift_count
    FROM shifts
    WHERE business_id = $1
      AND DATE(actual_start AT TIME ZONE 'Asia/Jerusalem') = $2::date
  `, [businessId, todayStr]).catch(() => ({ rows: [{ shift_count: 0 }] }));

  // Open (unclosed) shifts — employees who forgot to clock out
  const { rows: openShifts } = await db.query(`
    SELECT u.full_name
    FROM shifts sh
    JOIN users u ON u.id = sh.employee_id
    WHERE sh.business_id = $1
      AND sh.actual_end IS NULL
      AND DATE(sh.actual_start AT TIME ZONE 'Asia/Jerusalem') <= $2::date
    ORDER BY sh.actual_start
  `, [businessId, todayStr]).catch(() => ({ rows: [] }));

  // Low inventory items (below min_quantity)
  const { rows: lowStock } = await db.query(`
    SELECT name, current_qty AS quantity, min_qty AS min_quantity, unit
    FROM inventory_items
    WHERE business_id = $1
      AND min_qty > 0
      AND current_qty <= min_qty
    ORDER BY current_qty
    LIMIT 5
  `, [businessId]).catch(() => ({ rows: [] }));

  const revenue    = parseFloat(sales[0]?.total || 0);
  const txCount    = sales[0]?.tx_count || 0;
  const shiftCount = shifts[0]?.shift_count || 0;
  const openCount  = openShifts.length;

  const dateLabel = new Date(`${todayStr}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' });

  // Build the message
  let lines = [
    `📊 *סיכום יומי — ${dateLabel}*`,
    '',
    `💰 מכירות: ₪${revenue.toLocaleString('he-IL', { maximumFractionDigits: 0 })} (${txCount} עסקאות)`,
    `👥 משמרות: ${shiftCount} עובדים עבדו היום`,
  ];

  if (openCount > 0) {
    const names = openShifts.map(s => s.full_name).join(', ');
    lines.push(`⚠️ משמרות פתוחות: ${names} — לא שכחו לצאת?`);
  }

  if (lowStock.length > 0) {
    lines.push('');
    lines.push('📦 *מלאי נמוך:*');
    for (const item of lowStock) {
      lines.push(`  • ${item.name}: ${item.quantity} ${item.unit} (מינימום: ${item.min_quantity})`);
    }
  }

  lines.push('');
  lines.push('_נשלח מ-House of Business_');

  const message = lines.join('\n');
  const waLink  = `https://wa.me/?text=${encodeURIComponent(message)}`;

  return {
    date: todayStr,
    revenue,
    tx_count: txCount,
    shift_count: shiftCount,
    open_shifts: openShifts.map(s => s.full_name),
    low_stock: lowStock,
    message,
    wa_link: waLink,
  };
}

module.exports = { buildDailySummary };
