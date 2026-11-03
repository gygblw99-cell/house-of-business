/**
 * Extras routes — communal/shared items not tied to any specific dish
 * (e.g. a hot-pepper plate, bread basket, oil).
 *
 * GET    /extras                — list all active extras for this business
 * POST   /extras                — create a new extra
 * PUT    /extras/:id            — update name/unit/inventory link/is_active
 * DELETE /extras/:id            — hard-delete (or soft-deactivate) an extra
 * POST   /extras/:id/log        — log daily consumption (deducts from inventory)
 * GET    /extras/:id/log        — recent consumption log for one extra
 * GET    /extras/consumption    — today's total consumption across all extras
 */

const express = require('express');
const router  = express.Router();
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { requireAuth, requireManager } = require('../middleware/auth');
const syncService = require('../services/sync.service');
const { todayIL } = require('../utils/dateIL');

// ── GET /extras ───────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT be.id, be.item_name, be.unit, be.is_active,
              be.inventory_item_id,
              ii.name AS inventory_name,
              COALESCE(ii.current_qty, 0)::float  AS current_qty,
              COALESCE(ii.cost_per_unit, 0)::float AS cost_per_unit,
              be.created_at
       FROM business_extras be
       LEFT JOIN inventory_items ii ON ii.id = be.inventory_item_id
       WHERE be.business_id = $1
       ORDER BY be.is_active DESC, be.item_name`,
      [req.user.businessId]
    );
    res.json({ extras: rows });
  } catch (err) { next(err); }
});

// ── POST /extras ──────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { itemName, unit, inventoryItemId } = req.body;
    if (!itemName?.trim()) return res.status(400).json({ error: 'שם הפריט חסר' });

    // Validate inventoryItemId belongs to this business
    let ownedItemId = null;
    if (inventoryItemId) {
      const { rows } = await db.query(
        'SELECT id FROM inventory_items WHERE id = $1 AND business_id = $2',
        [inventoryItemId, req.user.businessId]
      );
      if (rows.length) ownedItemId = inventoryItemId;
    }

    const { rows } = await db.query(
      `INSERT INTO business_extras (business_id, item_name, unit, inventory_item_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, item_name, unit, inventory_item_id, is_active, created_at`,
      [req.user.businessId, itemName.trim(), unit || null, ownedItemId]
    );
    res.status(201).json({ extra: rows[0] });
  } catch (err) { next(err); }
});

// ── PUT /extras/:id ───────────────────────────────────────────────────────────
router.put('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { itemName, unit, inventoryItemId, isActive } = req.body;

    // Validate ownership
    const { rows: existing } = await db.query(
      'SELECT id FROM business_extras WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!existing.length) return res.status(404).json({ error: 'אקסטרה לא נמצאה' });

    let ownedItemId = undefined; // undefined = don't change
    if (inventoryItemId !== undefined) {
      if (!inventoryItemId) {
        ownedItemId = null;
      } else {
        const { rows } = await db.query(
          'SELECT id FROM inventory_items WHERE id = $1 AND business_id = $2',
          [inventoryItemId, req.user.businessId]
        );
        ownedItemId = rows.length ? inventoryItemId : null;
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (itemName   !== undefined) { sets.push(`item_name=$${i++}`);          vals.push(itemName.trim()); }
    if (unit       !== undefined) { sets.push(`unit=$${i++}`);               vals.push(unit || null); }
    if (ownedItemId !== undefined) { sets.push(`inventory_item_id=$${i++}`); vals.push(ownedItemId); }
    if (isActive   !== undefined) { sets.push(`is_active=$${i++}`);          vals.push(Boolean(isActive)); }
    if (!sets.length) return res.status(400).json({ error: 'אין שדות לעדכון' });

    sets.push(`updated_at=NOW()`);
    vals.push(req.params.id, req.user.businessId);

    const { rows } = await db.query(
      `UPDATE business_extras SET ${sets.join(',')}
       WHERE id=$${i} AND business_id=$${i+1}
       RETURNING id, item_name, unit, inventory_item_id, is_active, updated_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'אקסטרה לא נמצאה' });
    res.json({ extra: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /extras/:id ────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireManager, async (req, res, next) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM business_extras WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!rowCount) return res.status(404).json({ error: 'אקסטרה לא נמצאה' });
    res.json({ message: 'נמחק' });
  } catch (err) { next(err); }
});

// ── POST /extras/:id/log — log daily consumption ──────────────────────────────
// Deducts qty from linked inventory item (if set), then records the log entry.
router.post('/:id/log', requireAuth, requireManager, async (req, res, next) => {
  try {
    const qty = parseFloat(req.body.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'כמות לא תקינה' });
    const notes   = req.body.notes   || null;
    const logDate = req.body.logDate || null; // ISO date string or null (defaults to today in DB)

    // Verify ownership + get inventory link
    const { rows: extraRows } = await db.query(
      `SELECT be.id, be.item_name, be.inventory_item_id, ii.current_qty, ii.min_qty, ii.unit, ii.name AS inv_name
       FROM business_extras be
       LEFT JOIN inventory_items ii ON ii.id = be.inventory_item_id
       WHERE be.id = $1 AND be.business_id = $2`,
      [req.params.id, req.user.businessId]
    );
    if (!extraRows.length) return res.status(404).json({ error: 'אקסטרה לא נמצאה' });
    const extra = extraRows[0];

    // Deduct from inventory inside a transaction (best-effort — log succeeds even if deduction fails)
    if (extra.inventory_item_id) {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const { rows: locked } = await client.query(
          `SELECT id, current_qty, min_qty FROM inventory_items
           WHERE id = $1 AND business_id = $2 FOR UPDATE`,
          [extra.inventory_item_id, req.user.businessId]
        );
        if (locked.length) {
          const currentQty = parseFloat(locked[0].current_qty) || 0;
          if (currentQty < qty) {
            logger.warn('[extras] מלאי לא מספיק לאקסטרה', { extra: extra.item_name, required: qty, current: currentQty });
          }
          const { rows: updated } = await client.query(
            `UPDATE inventory_items
             SET current_qty = GREATEST(0, current_qty - $1), updated_at = NOW()
             WHERE id = $2 AND business_id = $3
             RETURNING current_qty`,
            [qty, extra.inventory_item_id, req.user.businessId]
          );
          const qtyAfter = parseFloat(updated[0]?.current_qty) || 0;

          await client.query(
            `INSERT INTO inventory_transactions (business_id, item_id, type, qty_change, qty_after, reason)
             VALUES ($1, $2, 'sale', $3, $4, $5)`,
            [req.user.businessId, extra.inventory_item_id, -Math.abs(qty), qtyAfter, `אקסטרה — ${extra.item_name}`]
          ).catch(() => {});

          if (locked[0].min_qty > 0 && qtyAfter <= parseFloat(locked[0].min_qty)) {
            setImmediate(() => syncService.saveLowInventoryNotification(req.user.businessId, {
              id: extra.inventory_item_id,
              name: extra.inv_name || extra.item_name,
              current_qty: qtyAfter,
              unit: extra.unit,
              min_qty: locked[0].min_qty,
            }).catch(() => {}));
          }
        }
        await client.query('COMMIT');
      } catch (deductErr) {
        await client.query('ROLLBACK').catch(() => {});
        logger.warn('[extras] ניכוי מלאי נכשל — ממשיך לשמור לוג', { err: deductErr.message });
      } finally {
        client.release();
      }
    }

    // Insert log entry — use Israel local date so midnight-to-03:00 ILT
    // doesn't file the entry under the previous UTC day.
    const effectiveDate = logDate || todayIL();
    const { rows: logRow } = await db.query(
      `INSERT INTO extras_consumption_log (extra_id, qty, log_date, notes)
       VALUES ($1, $2, $3::date, $4)
       RETURNING id, qty, log_date, notes, created_at`,
      [req.params.id, qty, effectiveDate, notes]
    );
    res.status(201).json({ log: logRow[0] });
  } catch (err) { next(err); }
});

// ── GET /extras/:id/log ───────────────────────────────────────────────────────
router.get('/:id/log', requireAuth, async (req, res, next) => {
  try {
    const { rows: extra } = await db.query(
      'SELECT id FROM business_extras WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    if (!extra.length) return res.status(404).json({ error: 'אקסטרה לא נמצאה' });

    const days  = Math.min(parseInt(req.query.days) || 30, 90);
    const { rows } = await db.query(
      `SELECT id, qty::float, log_date, notes, created_at
       FROM extras_consumption_log
       WHERE extra_id = $1 AND log_date >= CURRENT_DATE - ($2 || ' days')::interval
       ORDER BY log_date DESC, created_at DESC`,
      [req.params.id, days]
    );
    res.json({ logs: rows });
  } catch (err) { next(err); }
});

// ── GET /extras/consumption — today's consumption summary ────────────────────
router.get('/consumption', requireAuth, async (req, res, next) => {
  try {
    // Use todayIL() so the date matches what POST /:id/log inserts —
    // between midnight and ~03:00 ILT, CURRENT_DATE (UTC) lags by one day.
    const today = todayIL();
    const { rows } = await db.query(
      `SELECT be.id, be.item_name, be.unit,
              COALESCE(SUM(ecl.qty), 0)::float AS qty_today,
              COALESCE(ii.current_qty, 0)::float AS inventory_qty
       FROM business_extras be
       LEFT JOIN extras_consumption_log ecl
              ON ecl.extra_id = be.id AND ecl.log_date = $2::date
       LEFT JOIN inventory_items ii ON ii.id = be.inventory_item_id
       WHERE be.business_id = $1 AND be.is_active = TRUE
       GROUP BY be.id, be.item_name, be.unit, ii.current_qty
       ORDER BY be.item_name`,
      [req.user.businessId, today]
    );
    res.json({ consumption: rows });
  } catch (err) { next(err); }
});

module.exports = router;
