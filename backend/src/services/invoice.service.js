'use strict';

const db = require('../utils/db');
const logger = require('../utils/logger');
const { withTransaction } = require('../utils/transaction');
const { PRICE_CHANGE_THRESHOLD } = require('../constants/business');

const MIN_PRICE_CHANGE_PCT = 0.01; // 1% — any noticeable change

// Trigram similarity — Hebrew-compatible, no SQL extension needed
// Returns 0..1 where 1 = identical
function strSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ngrams = s => {
    const p = ` ${s} `;
    const g = new Set();
    for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
    return g;
  };
  const ga = ngrams(a), gb = ngrams(b);
  let hits = 0;
  for (const t of ga) if (gb.has(t)) hits++;
  return (2 * hits) / (ga.size + gb.size);
}

// score >= AUTO  → auto-apply match + info alert
// score >= WARN  → create new item + warning alert ("maybe same?")
const FUZZY_AUTO = 0.80;
const FUZZY_WARN = 0.60;

// WAC: weighted average cost
function calcWAC(oldQty, oldPrice, newQty, newPrice) {
  const total = (oldQty || 0) + (newQty || 0);
  if (total <= 0 || !(newPrice > 0)) return oldPrice || 0;
  return ((oldQty || 0) * (oldPrice || 0) + (newQty || 0) * newPrice) / total;
}

// Record a stock-IN movement so an invoice restock shows up in the inventory
// transaction log alongside sale deductions — otherwise current_qty rises with
// no visible entry, which reads as "inventory only ever goes down". Reads the
// (already-updated) current_qty via subquery so no extra round-trip is needed.
// Non-critical: a failure here must never abort the inventory sync itself.
async function _recordPurchaseTx(c, businessId, itemId, qtyChange, note = 'קבלה מחשבונית') {
  if (!(qtyChange > 0)) return;
  try {
    await c.query(
      `INSERT INTO inventory_transactions (business_id, item_id, type, qty_change, qty_after, reason)
       SELECT $1, $2, 'purchase', $3, current_qty, $4 FROM inventory_items WHERE id = $2`,
      [businessId, itemId, qtyChange, note]
    );
  } catch { /* non-critical — the stock update already committed */ }
}

// Detect packaging unit → inventory unit conversion.
// Applies only when the invoice item is sold in packages (יח', שק, קרטון, etc.)
// while the inventory tracks in a divisible unit (ק"ג, ליטר, יח').
// Examples:
//   "שק אורז 25 ק'ג" invoiced at qty=1,  inventory unit=ק'ג  → multiplier=25
//   "בקבוק שמן 5 ליטר" invoiced at qty=1,  inventory unit=ליטר → multiplier=5
//   "קרטון ביצים 30 יח'" invoiced at qty=1, inventory unit=יח'  → multiplier=30
// Returns the number of inventory-units per invoice-unit (1 = no conversion).
function _pkgMultiplier(invItemName, invItemUnit, inventoryUnit) {
  const normUnit = s => (s || '').toLowerCase().replace(/['"׳״]/g, '').trim();
  const invU  = normUnit(invItemUnit);
  const rowU  = normUnit(inventoryUnit);

  const KG_RE    = /^(קג|קילו|kg|gram|גרם|gr)$/;
  const LITER_RE = /^(ליטר|לר|liter|l)$/;
  const UNIT_RE  = /^(יח|יחידה|unit|pc|pcs|יח')$/;

  const rowIsKg    = KG_RE.test(rowU);
  const rowIsLiter = LITER_RE.test(rowU);
  const rowIsUnit  = UNIT_RE.test(rowU);

  // If invoice and inventory share the same unit — no conversion needed
  if (invU && rowU && invU === rowU) return 1;
  // If invoice unit is already the same dimensionality — no conversion
  if (rowIsKg    && KG_RE.test(invU))    return 1;
  if (rowIsLiter && LITER_RE.test(invU)) return 1;

  const name = (invItemName || '').replace(/['"׳״]/g, '');

  if (rowIsKg) {
    const m = name.match(/(\d+(?:\.\d+)?)\s*(?:ק ?ג|קילו|kg)/i);
    if (m) return parseFloat(m[1]);
  }
  if (rowIsLiter) {
    const m = name.match(/(\d+(?:\.\d+)?)\s*(?:ל ?ר|ליטר|liter)/i);
    if (m) return parseFloat(m[1]);
  }
  if (rowIsUnit) {
    // e.g. "קרטון ביצים 30 יח'"
    const m = name.match(/(\d+(?:\.\d+)?)\s*(?:יח|יחידות|unit|pcs)/i);
    if (m) return parseFloat(m[1]);
  }
  return 1;
}

async function checkPriceChanges(businessId, invoiceId, items) {
  const validItems = items.filter(i => i.name?.trim() && i.unit_price > 0);
  if (!validItems.length) return [];

  const names = validItems.map(i => i.name.trim().toLowerCase());
  const { rows } = await db.query(
    `SELECT LOWER(ii.name) AS name_key,
            AVG(ii.unit_price)::float AS avg_price,
            COUNT(*)::int AS times
     FROM invoice_items ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE inv.business_id = $1
       AND ii.invoice_id != $2
       AND LOWER(ii.name) = ANY($3)
       AND ii.unit_price > 0
       AND inv.invoice_date >= NOW() - INTERVAL '6 months'
     GROUP BY LOWER(ii.name)`,
    [businessId, invoiceId, names]
  );

  const avgMap = Object.fromEntries(rows.map(r => [r.name_key, r]));

  return validItems.reduce((alerts, item) => {
    const hist = avgMap[item.name.trim().toLowerCase()];
    if (!hist || !hist.avg_price || hist.times < 2) return alerts;
    const changePct = (item.unit_price - hist.avg_price) / hist.avg_price;
    if (Math.abs(changePct) >= PRICE_CHANGE_THRESHOLD) {
      alerts.push({ name: item.name, currentPrice: item.unit_price, avgPrice: hist.avg_price, changePct });
    }
    return alerts;
  }, []);
}

async function syncInventoryFromInvoice(businessId, supplierId, items, client = null) {
  const validItems = items.filter(i => i.name?.trim());
  if (!validItems.length) return;

  const run = async (c) => {
    // Wraps optional template writes in a savepoint so a FK or any other error
    // cannot abort the parent transaction — template writes are best-effort.
    const _tplWrite = async (sql, params) => {
      await c.query('SAVEPOINT tpl_write');
      try {
        await c.query(sql, params);
        await c.query('RELEASE SAVEPOINT tpl_write');
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT tpl_write').catch(() => {});
      }
    };

    // Fetch all existing inventory for fuzzy matching
    const { rows: existing } = await c.query(
      `SELECT id, name, LOWER(name) AS name_lower,
              current_qty::float AS current_qty,
              cost_per_unit::float AS cost_per_unit,
              unit
       FROM inventory_items WHERE business_id = $1`,
      [businessId]
    );

    // Load learned templates for this supplier (one query, used as fast-path before fuzzy)
    const templateMap = new Map(); // raw_name → { inventory_item_id, pkg_multiplier }
    if (supplierId) {
      const { rows: tpls } = await c.query(
        `SELECT raw_name, inventory_item_id, pkg_multiplier::float AS pkg_multiplier
         FROM invoice_item_templates
         WHERE business_id = $1 AND supplier_id = $2 AND inventory_item_id IS NOT NULL`,
        [businessId, supplierId]
      ).catch(() => ({ rows: [] }));
      for (const t of tpls) templateMap.set(t.raw_name, t);
    }

    const templateMatches = []; // { invItem, row, mult } — pre-learned from approved history
    const exactUpdates    = []; // { invItem, row }
    const fuzzyAuto       = []; // { invItem, row, score } — auto-apply + info alert
    const fuzzyWarn       = []; // { invItem, row, score } — warn only, still create new
    const newItems        = []; // { invItem }

    for (const invItem of validItems) {
      const nameLower = invItem.name.trim().toLowerCase();

      // 0. Template match — highest confidence, learned from previous approved invoices
      const tpl = templateMap.get(nameLower);
      if (tpl) {
        const row = existing.find(r => r.id === tpl.inventory_item_id);
        if (row) { templateMatches.push({ invItem, row, mult: parseFloat(tpl.pkg_multiplier) || 1 }); continue; }
      }

      // 1. Exact match (fast path)
      const exact = existing.find(r => r.name_lower === nameLower);
      if (exact) { exactUpdates.push({ invItem, row: exact }); continue; }

      // 2. Best fuzzy match
      let bestScore = 0, bestRow = null;
      for (const row of existing) {
        const s = strSimilarity(nameLower, row.name_lower);
        if (s > bestScore) { bestScore = s; bestRow = row; }
      }

      if (bestScore >= FUZZY_AUTO) {
        fuzzyAuto.push({ invItem, row: bestRow, score: bestScore });
      } else if (bestScore >= FUZZY_WARN) {
        fuzzyWarn.push({ invItem, row: bestRow, score: bestScore });
        newItems.push({ invItem });
      } else {
        newItems.push({ invItem });
      }
    }

    // UPDATE template-learned matches — use stored pkg_multiplier directly
    for (const { invItem, row, mult } of templateMatches) {
      const addQty   = (parseFloat(invItem.qty)        || 0) * mult;
      const invPrice = (parseFloat(invItem.unit_price) || 0) / mult;
      const wac      = calcWAC(row.current_qty, row.cost_per_unit, addQty, invPrice);
      await c.query(
        `UPDATE inventory_items
         SET current_qty   = current_qty + $1,
             cost_per_unit = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE cost_per_unit END,
             supplier_id   = COALESCE($3::uuid, supplier_id),
             item_type     = COALESCE($5, item_type),
             updated_at    = NOW()
         WHERE id = $4`,
        [addQty, wac || null, supplierId || null, row.id, invItem.item_type || null]
      );
      await _recordPurchaseTx(c, businessId, row.id, addQty);
      // Refresh use_count so the most-used templates rank higher in the OCR prompt
      await _tplWrite(
        `UPDATE invoice_item_templates
         SET use_count = use_count + 1, last_seen_at = NOW()
         WHERE business_id = $1 AND supplier_id = $2 AND raw_name = LOWER(TRIM($3))`,
        [businessId, supplierId, invItem.name]
      );
    }

    // UPDATE exact matches — WAC price
    for (const { invItem, row } of exactUpdates) {
      const mult     = _pkgMultiplier(invItem.name, invItem.unit, row.unit);
      const addQty   = (parseFloat(invItem.qty)        || 0) * mult;
      const invPrice = (parseFloat(invItem.unit_price) || 0) / mult;
      if (mult !== 1) logger.debug('[Invoice] pkg conversion', { item: invItem.name, invoiceUnit: invItem.unit, inventoryUnit: row.unit, mult, addQty, invPrice });
      const wac     = calcWAC(row.current_qty, row.cost_per_unit, addQty, invPrice);
      await c.query(
        `UPDATE inventory_items
         SET current_qty   = current_qty + $1,
             cost_per_unit = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE cost_per_unit END,
             supplier_id   = COALESCE($3::uuid, supplier_id),
             item_type     = COALESCE($5, item_type),
             updated_at    = NOW()
         WHERE id = $4`,
        [addQty, wac || null, supplierId || null, row.id, invItem.item_type || null]
      );
      await _recordPurchaseTx(c, businessId, row.id, addQty);
      // Learn: persist this mapping so the next invoice from the same supplier uses it directly
      if (supplierId) {
        await _tplWrite(
          `INSERT INTO invoice_item_templates (business_id, supplier_id, raw_name, inventory_item_id, pkg_multiplier)
           VALUES ($1, $2, LOWER(TRIM($3)), $4, $5)
           ON CONFLICT (business_id, supplier_id, raw_name)
           DO UPDATE SET inventory_item_id = EXCLUDED.inventory_item_id,
                         pkg_multiplier    = CASE WHEN EXCLUDED.pkg_multiplier <> 1
                                                  THEN EXCLUDED.pkg_multiplier
                                                  ELSE invoice_item_templates.pkg_multiplier END,
                         use_count         = invoice_item_templates.use_count + 1,
                         last_seen_at      = NOW()`,
          [businessId, supplierId, invItem.name.trim(), row.id, mult]
        );
      }
    }

    // UPDATE fuzzy-auto matches — WAC price + info alert
    for (const { invItem, row, score } of fuzzyAuto) {
      const mult     = _pkgMultiplier(invItem.name, invItem.unit, row.unit);
      const addQty   = (parseFloat(invItem.qty)        || 0) * mult;
      const invPrice = (parseFloat(invItem.unit_price) || 0) / mult;
      if (mult !== 1) logger.debug('[Invoice] pkg conversion (fuzzy)', { item: invItem.name, mult, addQty, invPrice });
      const wac      = calcWAC(row.current_qty, row.cost_per_unit, addQty, invPrice);
      await c.query(
        `UPDATE inventory_items
         SET current_qty   = current_qty + $1,
             cost_per_unit = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE cost_per_unit END,
             supplier_id   = COALESCE($3::uuid, supplier_id),
             item_type     = COALESCE($5, item_type),
             updated_at    = NOW()
         WHERE id = $4`,
        [addQty, wac || null, supplierId || null, row.id, invItem.item_type || null]
      );
      await _recordPurchaseTx(c, businessId, row.id, addQty);
      // Avoid duplicate alerts for same pair in last 24h
      await c.query(
        `INSERT INTO ai_insights (business_id, type, title, body, severity)
         SELECT $1, 'inventory_fuzzy_match', $2, $3, 'info'
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_insights
           WHERE business_id = $1 AND type = 'inventory_fuzzy_match' AND title = $2
             AND created_at > NOW() - INTERVAL '24 hours'
         )`,
        [
          businessId,
          `התאמה אוטומטית: "${invItem.name.trim()}"`,
          `הפריט "${invItem.name.trim()}" מהחשבונית זוהה כ-"${row.name}" במלאי (דמיון ${Math.round(score * 100)}%). המלאי עודכן אוטומטית. אם ההתאמה שגויה — ערוך את שמות הפריטים.`,
        ]
      );
      // Learn: save fuzzy match so next time it's a direct hit
      if (supplierId) {
        await _tplWrite(
          `INSERT INTO invoice_item_templates (business_id, supplier_id, raw_name, inventory_item_id, pkg_multiplier)
           VALUES ($1, $2, LOWER(TRIM($3)), $4, $5)
           ON CONFLICT (business_id, supplier_id, raw_name)
           DO UPDATE SET inventory_item_id = EXCLUDED.inventory_item_id,
                         pkg_multiplier    = CASE WHEN EXCLUDED.pkg_multiplier <> 1
                                                  THEN EXCLUDED.pkg_multiplier
                                                  ELSE invoice_item_templates.pkg_multiplier END,
                         use_count         = invoice_item_templates.use_count + 1,
                         last_seen_at      = NOW()`,
          [businessId, supplierId, invItem.name.trim(), row.id, mult]
        );
      }
    }

    // Warning alerts for near-matches (item created as new)
    for (const { invItem, row, score } of fuzzyWarn) {
      await c.query(
        `INSERT INTO ai_insights (business_id, type, title, body, severity)
         SELECT $1, 'inventory_fuzzy_suggestion', $2, $3, 'warning'
         WHERE NOT EXISTS (
           SELECT 1 FROM ai_insights
           WHERE business_id = $1 AND type = 'inventory_fuzzy_suggestion' AND title = $2
             AND created_at > NOW() - INTERVAL '24 hours'
         )`,
        [
          businessId,
          `פריט דומה אפשרי: "${invItem.name.trim()}"`,
          `הפריט "${invItem.name.trim()}" מהחשבונית דומה ל-"${row.name}" במלאי (דמיון ${Math.round(score * 100)}%). נוצר פריט חדש — אם מדובר באותו פריט, מחק את הכפיל ואחד את השמות.`,
        ]
      );
    }

    // INSERT genuinely new items
    if (!newItems.length) return;
    const vals   = newItems.map((_, j) => { const b = j * 7 + 1; return `($${b},$${b+1},$${b+2},$${b+3},0,$${b+4},$${b+5},$${b+6})`; });
    const params = newItems.flatMap(({ invItem }) => [
      businessId,
      invItem.name.trim().slice(0, 255),
      invItem.unit?.trim() || "יח'",
      parseFloat(invItem.qty)        || 0,
      parseFloat(invItem.unit_price) || 0,
      supplierId || null,
      invItem.item_type || 'מזון',
    ]);
    const insertedRows = await c.query(
      `INSERT INTO inventory_items (business_id, name, unit, current_qty, min_qty, cost_per_unit, supplier_id, item_type)
       VALUES ${vals.join(',')}
       ON CONFLICT DO NOTHING
       RETURNING id, LOWER(TRIM(name)) AS raw_name`,
      params
    );
    // Log the opening stock-in for each newly created item, so the movement log
    // reconciles (new item's whole quantity is a stock-in, same as a restock).
    for (const nr of insertedRows.rows) {
      const ni = newItems.find(n => n.invItem.name.trim().toLowerCase() === nr.raw_name);
      if (ni) await _recordPurchaseTx(c, businessId, nr.id, parseFloat(ni.invItem.qty) || 0, 'קבלה מחשבונית (פריט חדש)');
    }
    // Learn: batch-insert templates for newly created items (pkg_multiplier=1 — no conversion info yet)
    if (supplierId && insertedRows.rows.length) {
      const tplVals   = insertedRows.rows.map((_, j) => { const b = j * 4 + 1; return `($${b},$${b+1},$${b+2},$${b+3},1)`; });
      const tplParams = insertedRows.rows.flatMap(nr => [businessId, supplierId, nr.raw_name, nr.id]);
      await _tplWrite(
        `INSERT INTO invoice_item_templates (business_id, supplier_id, raw_name, inventory_item_id, pkg_multiplier)
         VALUES ${tplVals.join(',')}
         ON CONFLICT (business_id, supplier_id, raw_name) DO NOTHING`,
        tplParams
      );
    }
  };

  if (client) await run(client);
  else await withTransaction(run);
}

// Detect near-duplicate inventory items across the whole business.
// Returns pairs sorted by similarity desc.
async function detectInventoryDuplicates(businessId) {
  const { rows } = await db.query(
    `SELECT id, name, current_qty::float AS current_qty, cost_per_unit::float AS cost_per_unit
     FROM inventory_items WHERE business_id = $1 ORDER BY name`,
    [businessId]
  );

  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const score = strSimilarity(rows[i].name, rows[j].name);
      if (score >= 0.75) {
        pairs.push({ a: rows[i], b: rows[j], score: Math.round(score * 100) });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

// Save duplicate alerts for newly-found pairs (skip if alerted in last 7 days)
async function storeDuplicateAlerts(businessId, pairs) {
  if (!pairs.length) return;
  for (const { a, b, score } of pairs) {
    const title = `פריטי מלאי כפולים: "${a.name}" / "${b.name}"`;
    await db.query(
      `INSERT INTO ai_insights (business_id, type, title, body, severity)
       SELECT $1, 'inventory_duplicate', $2, $3, 'warning'
       WHERE NOT EXISTS (
         SELECT 1 FROM ai_insights
         WHERE business_id = $1 AND type = 'inventory_duplicate' AND title = $2
           AND created_at > NOW() - INTERVAL '7 days'
       )`,
      [
        businessId,
        title,
        `הפריטים "${a.name}" ו-"${b.name}" דומים מאוד (${score}%). ייתכן שמדובר באותו מוצר שנרשם בשתי צורות. כדאי לאחד את הפריטים כדי שחישובי COGS יהיו מדויקים.`,
      ]
    );
  }
}

async function storePriceAlerts(businessId, alerts, supplierName) {
  if (!alerts.length) return;
  const vals   = [];
  const params = [];
  alerts.forEach((alert, i) => {
    const direction = alert.changePct > 0 ? 'עלה' : 'ירד';
    const pct       = Math.abs(alert.changePct * 100).toFixed(1);
    const title     = `שינוי מחיר: ${alert.name}`;
    const body      = `מחיר ${alert.name} ${direction} ב-${pct}% לעומת ממוצע 6 חודשים אחרונים. מחיר נוכחי: ₪${alert.currentPrice.toFixed(2)}, ממוצע: ₪${alert.avgPrice.toFixed(2)}${supplierName ? ` (ספק: ${supplierName})` : ''}.`;
    const severity  = Math.abs(alert.changePct) >= 0.25 ? 'critical' : 'warning';
    const base      = i * 5;
    vals.push(`($${base+1},'price_alert',$${base+2},$${base+3},$${base+4},$${base+5})`);
    params.push(businessId, title, body, null, severity);
  });
  await db.query(
    `INSERT INTO ai_insights (business_id, type, title, body, impact, severity) VALUES ${vals.join(',')}`,
    params
  );
}

// ── Supplier price-change notifications ──────────────────────────────────────
// Compares each item in the current invoice against the LAST approved invoice
// for the same item from the same supplier. Any change ≥ 1% creates a
// notifications row with % change and projected monthly cash-flow impact.
//
// supplierName is optional — pass it from the route to avoid a redundant DB query.
async function notifyPriceChanges(businessId, invoiceId, supplierId, items, supplierName = null) {
  if (!supplierId || !items?.length) return;
  const validItems = items.filter(i => i.name?.trim() && i.unit_price > 0 && i.qty > 0);
  if (!validItems.length) return;

  // Deduplicate by normalized name — prevents contradictory up/down notifications
  // when OCR splits one product into two line items with slightly different prices.
  const seenNames = new Set();
  const dedupedItems = validItems.filter(i => {
    const k = i.name.trim().toLowerCase();
    if (seenNames.has(k)) return false;
    seenNames.add(k);
    return true;
  });
  const names = [...seenNames];

  // Last approved price per item from this supplier (one query, batched by name).
  // NULLS LAST: NULL invoice_date must not sort before dated rows (PostgreSQL DESC = NULLS FIRST).
  const { rows: lastPrices } = await db.query(
    `SELECT DISTINCT ON (LOWER(TRIM(ii.name)))
       LOWER(TRIM(ii.name)) AS name_key,
       ii.unit_price::float  AS unit_price,
       ii.qty::float         AS last_qty
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.business_id  = $1
       AND i.supplier_id  = $2
       AND i.approved_at  IS NOT NULL
       AND i.id           != $3
       AND ii.unit_price  > 0
       AND LOWER(TRIM(ii.name)) = ANY($4)
     ORDER BY LOWER(TRIM(ii.name)), i.invoice_date DESC NULLS LAST, i.approved_at DESC NULLS LAST`,
    [businessId, supplierId, invoiceId, names]
  );
  if (!lastPrices.length) return;
  const lastPriceMap = Object.fromEntries(lastPrices.map(r => [r.name_key, r]));

  // Secondary pass: fuzzy name matching for items that had no exact name match.
  // Handles OCR variants like "גבינה לבנה 5%" vs "גבינה לבנה" across invoices.
  const unmatchedItems = dedupedItems.filter(i => !lastPriceMap[i.name.trim().toLowerCase()]);
  if (unmatchedItems.length > 0) {
    const { rows: supplierHistory } = await db.query(
      `SELECT DISTINCT ON (LOWER(TRIM(ii.name)))
         LOWER(TRIM(ii.name))  AS name_key,
         ii.unit_price::float  AS unit_price,
         ii.qty::float         AS last_qty
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.business_id = $1
         AND i.supplier_id = $2
         AND i.approved_at IS NOT NULL
         AND i.id          != $3
         AND ii.unit_price > 0
       ORDER BY LOWER(TRIM(ii.name)), i.invoice_date DESC NULLS LAST, i.approved_at DESC NULLS LAST
       LIMIT 300`,
      [businessId, supplierId, invoiceId]
    ).catch(() => ({ rows: [] }));

    if (supplierHistory.length > 0) {
      for (const item of unmatchedItems) {
        const key = item.name.trim().toLowerCase();
        let bestScore = 0.70;
        let bestMatch = null;
        for (const hist of supplierHistory) {
          const score = strSimilarity(item.name, hist.name_key);
          if (score > bestScore) { bestScore = score; bestMatch = hist; }
        }
        if (bestMatch) lastPriceMap[key] = bestMatch;
      }
    }
  }

  // Resolve the target user (owner/partner), monthly freq, and supplier name in parallel.
  // Freq query is scoped to names that have a prior price (exact or fuzzy).
  // COUNT(DISTINCT invoice_date) avoids double-counting multi-attachment uploads of the same delivery.
  const changedNames = Object.keys(lastPriceMap);
  const [freqResult, supResult, userResult] = await Promise.all([
    db.query(
      `SELECT LOWER(TRIM(ii.name))                    AS name_key,
              COUNT(DISTINCT i.invoice_date)::float / 3.0 AS monthly_freq
       FROM invoices i
       JOIN invoice_items ii ON ii.invoice_id = i.id
       WHERE i.business_id  = $1
         AND i.supplier_id  = $2
         AND i.approved_at  IS NOT NULL
         AND i.invoice_date >= NOW() - INTERVAL '3 months'
         AND LOWER(TRIM(ii.name)) = ANY($3)
       GROUP BY LOWER(TRIM(ii.name))`,
      [businessId, supplierId, changedNames]
    ),
    supplierName
      ? Promise.resolve({ rows: [{ name: supplierName }] })
      : db.query('SELECT name FROM suppliers WHERE id=$1 AND business_id=$2', [supplierId, businessId])
          .catch(() => ({ rows: [] })),
    db.query(
      `SELECT id FROM users
       WHERE business_id = $1 AND role IN ('owner', 'partner') AND is_active = TRUE
       ORDER BY role LIMIT 1`,
      [businessId]
    ).catch(() => ({ rows: [] })),
  ]);

  const freqMap       = Object.fromEntries(freqResult.rows.map(r => [r.name_key, r.monthly_freq]));
  const resolvedName  = supResult.rows[0]?.name || '';
  const userId        = userResult.rows[0]?.id ?? null;

  // Remove expired price-change notifications for this business before inserting new ones.
  // Required so the UNIQUE INDEX (which prevents concurrent double-inserts) doesn't permanently
  // block re-notification for the same item after the 30-day expiry window.
  await db.query(
    `DELETE FROM notifications
     WHERE business_id = $1 AND type = 'supplier_price_change' AND expires_at < NOW()`,
    [businessId]
  ).catch(() => {});

  // Build and insert one notification per changed item
  for (const item of dedupedItems) {
    const key  = item.name.trim().toLowerCase();
    const hist = lastPriceMap[key];
    if (!hist) continue;

    const changePct = (item.unit_price - hist.unit_price) / hist.unit_price;
    if (Math.abs(changePct) < MIN_PRICE_CHANGE_PCT) continue;

    const isIncrease  = changePct > 0;
    const monthlyFreq = freqMap[key] ?? 0;
    // Use the historical quantity as the steady-state order size for impact projection.
    // The current delivery may be a one-off bulk purchase and would overstate the impact.
    const refQty      = hist.last_qty > 0 ? hist.last_qty : item.qty;
    const pctStr      = `${isIncrease ? '+' : ''}${(changePct * 100).toFixed(1)}%`;

    let impactStr;
    if (monthlyFreq === 0) {
      impactStr = '(לא הוזמן ב-3 חודשים אחרונים — השפעה לא ידועה)';
    } else {
      const monthlyImpact = (item.unit_price - hist.unit_price) * refQty * monthlyFreq;
      const impactAbs     = Math.abs(monthlyImpact).toFixed(0);
      impactStr = monthlyImpact > 0
        ? `+₪${impactAbs}/חודש (עלות נוספת)`
        : monthlyImpact < 0
          ? `-₪${impactAbs}/חודש (חיסכון)`
          : '₪0 (ללא השפעה)';
    }

    const itemName = item.name.trim(); // normalize so dedup title matches across invoices
    const title = isIncrease ? `עליית מחיר: ${itemName}` : `ירידת מחיר: ${itemName}`;
    const body  = [
      resolvedName ? `ספק: ${resolvedName}` : null,
      `המחיר ${isIncrease ? 'עלה' : 'ירד'} מ-₪${hist.unit_price.toFixed(2)} ל-₪${item.unit_price.toFixed(2)} (${pctStr})`,
      `השפעה על תזרים: ${impactStr}`,
      monthlyFreq > 0 ? `(${monthlyFreq.toFixed(1)} הזמנות/חודש × ${refQty} ${item.unit || 'יח׳'})` : null,
    ].filter(Boolean).join('\n');

    await db.query(
      `INSERT INTO notifications (business_id, user_id, type, title, body, expires_at)
       SELECT $1, $2, 'supplier_price_change', $3, $4, NOW() + INTERVAL '30 days'
       WHERE NOT EXISTS (
         SELECT 1 FROM notifications
         WHERE business_id = $1
           AND user_id     IS NOT DISTINCT FROM $2
           AND type        = 'supplier_price_change'
           AND title       = $3
           AND created_at  >= NOW() - INTERVAL '7 days'
       )
       ON CONFLICT (business_id, user_id, type, title)
         WHERE type = 'supplier_price_change' AND user_id IS NOT NULL
         DO NOTHING`,
      [businessId, userId, title, body]
    ).catch(e => logger.warn('[Invoice] Price-change notification failed', { err: e.message }));
  }
}

// Sanity check: validate that cost_per_unit seems reasonable for the unit type.
// Israeli POS/invoice OCR commonly stores the carton/case price as the per-unit price.
// Examples: a can (פחית) at 63₪ is a carton price, not per-can; 1.5L bottle at 65₪ same.
function checkInventoryCostSanity(items) {
  const suspicious = [];
  for (const item of items) {
    const cost = parseFloat(item.unit_price || 0);
    if (!cost || cost <= 0) continue;
    const unit = String(item.unit || '').trim().toLowerCase();
    const name = String(item.name || '').trim().toLowerCase();

    let reason = null;

    if ((unit.includes('פחית') || name.includes('פחית')) && cost > 20) {
      reason = `פחית ב-₪${cost.toFixed(2)} — נראה כמחיר לקרטון/אריזה (${Math.round(24)} יח׳ ≈ ₪${(cost / 24).toFixed(2)} ליחידה)`;
    } else if ((unit.includes('בקבוק') || name.match(/\d+\.?\d*\s*ל(יטר)?/) || unit.includes('ליטר')) && cost > 30) {
      reason = `בקבוק/ליטר ב-₪${cost.toFixed(2)} — בדוק אם זה מחיר ליחידה או לאריזה`;
    } else if (cost > 400 && !['קרטון','אריזה','box','case','pack','שק','שקית גדולה'].some(k => unit.includes(k) || name.includes(k))) {
      reason = `מחיר גבוה מאוד ₪${cost.toFixed(2)} ליחידה — ייתכן שזה מחיר לאריזה`;
    }

    if (reason) {
      suspicious.push({ name: item.name, unit: item.unit || '', cost_per_unit: cost, reason });
    }
  }
  return suspicious;
}

module.exports = {
  checkPriceChanges,
  syncInventoryFromInvoice,
  detectInventoryDuplicates,
  storeDuplicateAlerts,
  storePriceAlerts,
  notifyPriceChanges,
  checkInventoryCostSanity,
  strSimilarity,
  PRICE_CHANGE_THRESHOLD,
};
