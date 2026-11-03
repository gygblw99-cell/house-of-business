const express   = require('express');
const router    = express.Router();
const logger    = require('../utils/logger');
const { requireAuth, requirePermission } = require('../middleware/auth');
const db        = require('../utils/db');
const eventBus  = require('../utils/eventBus');
const { sendEmailFromBusiness } = require('../services/notifications/email.service');
const { searchPrice } = require('../services/priceComparison/priceSearch.service');
const https     = require('https');
const XLSX      = require('xlsx');
const { ssrfSafeIp: _ssrfSafeIp } = require('../utils/ssrfGuard');
const { rateLimitAI } = require('../middleware/rateLimitAI');
const { withTransaction } = require('../utils/transaction');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Bound on the daily scheduler's SerpAPI spend — see the note at the creation
// endpoint below. Env-overridable so it can be raised with the plan.
const MAX_ACTIVE_PRICE_ALERTS = parseInt(process.env.MAX_ACTIVE_PRICE_ALERTS || '3', 10);

// ── POST /api/price-comparison/search-prices ──────────────────
// (handler defined as searchPricesHandler below — function declaration is hoisted)
router.post('/search-prices', requireAuth, requirePermission('suppliers'), rateLimitAI(), searchPricesHandler);

// ── POST /api/price-comparison/extract-email ─────────────────
// חולץ כתובות מייל מאתר ספק
router.post('/extract-email', requireAuth, requirePermission('suppliers'), async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'חסר url' });

  if (!await _ssrfSafeIp(url)) {
    return res.status(400).json({ error: 'כתובת לא מורשית' });
  }

  const fetchPage = async (pageUrl, depth = 0) => {
    if (depth > 1) return '';
    // Resolve once and pin the request to that IP — a second, independent
    // resolution (e.g. passing the raw URL to http(s).get) would reopen the
    // DNS-rebinding window this check exists to close.
    const safeIp = await _ssrfSafeIp(pageUrl);
    if (!safeIp) return '';
    let parsedUrl;
    try { parsedUrl = new URL(pageUrl); } catch { return ''; }
    return new Promise((resolve) => {
      try {
        const mod = parsedUrl.protocol === 'https:' ? https : require('http');
        const req2 = mod.get({
          hostname: safeIp,
          port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path:     `${parsedUrl.pathname}${parsedUrl.search}`,
          // TLS SNI/cert validation and virtual-hosting still target the real hostname —
          // only the DNS resolution itself is pinned to the pre-validated IP.
          servername: parsedUrl.hostname,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HobBot/1.0)', Host: parsedUrl.hostname },
          timeout: 8000,
        }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth === 0) {
            fetchPage(r.headers.location, 1).then(resolve).catch(() => resolve(''));
            return;
          }
          let data = '';
          r.setEncoding('utf8');
          r.on('data', c => { if (data.length < 300000) data += c; });
          r.on('end', () => resolve(data));
        });
        req2.on('error', () => resolve(''));
        req2.on('timeout', () => { req2.destroy(); resolve(''); });
      } catch { resolve(''); }
    });
  };

  try {
    const html = await fetchPage(url);
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}/g;
    const found = [...new Set((html.match(emailRegex) || []))];
    const filtered = found.filter(e => {
      const lower = e.toLowerCase();
      return !lower.includes('example') && !lower.includes('sentry') &&
             !lower.includes('schema') && !lower.includes('google') &&
             !lower.includes('jquery') && !lower.includes('webpack') &&
             !lower.match(/\.(png|jpg|gif|svg|css|js)@/) &&
             !lower.startsWith('no-reply@') && !lower.startsWith('noreply@');
    });

    const priority = ['order', 'info', 'contact', 'office', 'sales', 'supply', 'purchase'];
    filtered.sort((a, b) => {
      const aScore = priority.findIndex(p => a.toLowerCase().includes(p));
      const bScore = priority.findIndex(p => b.toLowerCase().includes(p));
      if (aScore === -1 && bScore === -1) return 0;
      if (aScore === -1) return 1;
      if (bScore === -1) return -1;
      return aScore - bScore;
    });

    res.json({ email: filtered[0] || null, allEmails: filtered.slice(0, 5) });
  } catch (err) {
    res.json({ email: null, allEmails: [] });
  }
});

// ── POST /api/price-comparison/ai-find-suppliers (legacy) ─────
router.post('/ai-find-suppliers', requireAuth, requirePermission('suppliers'), rateLimitAI(), async (req, res, next) => {
  try {
    const { searchQuery } = req.body;
    if (!searchQuery?.trim()) return res.status(400).json({ error: 'חסר שם המוצר' });
    const q = searchQuery.trim();
    const body = `שלום,\n\nאנו מעוניינים לקבל הצעת מחיר עבור: ${q}.\n\nנשמח לקבל:\n• מחיר ליחידה/ק"ג\n• כמות מינימום להזמנה\n• תנאי אספקה\n\nתודה רבה`;
    res.json({
      searchQueries: [],
      knownBrands: [],
      emailDraft: { subject: `בקשת הצעת מחיר — ${q}`, body },
      priceInsight: '',
    });
  } catch (err) { next(err); }
});

// ── Shared handler for /search-prices and /search alias ───────
// Function declaration (not const) so it is hoisted and reachable by the
// /search-prices route registered above.
async function searchPricesHandler(req, res, next) {
  try {
    const { searchQuery } = req.body;
    if (!searchQuery?.trim()) return res.status(400).json({ error: 'חסר שם המוצר' });
    const q = searchQuery.trim().slice(0, 100).replace(/[`\\]/g, '');

    // שמירה מוקדמת ל-DB לפני החיפוש (Task 1)
    const { rows: insertRows } = await db.query(
      `INSERT INTO price_comparison_requests (business_id, search_type, search_query, status)
       VALUES ($1, 'item', $2, 'searching') RETURNING id`,
      [req.user.businessId, q]
    );
    const requestId = insertRows[0].id;

    // שליפת כתובת העסק לסינון גיאוגרפי ועלויות משלוח
    const { rows: bizRows } = await db.query(
      `SELECT address FROM businesses WHERE id = $1`,
      [req.user.businessId]
    );
    const businessAddress = bizRows[0]?.address || '';

    const result = await searchPrice(q, { businessAddress, businessId: req.user.businessId });

    // שמירת result_data ל-DB (Task 1)
    const finalStatus = result.confidence === 'low' ? 'no_result' : 'completed';
    await db.query(
      `UPDATE price_comparison_requests
         SET result_data = $1, status = $2, updated_at = NOW()
       WHERE id = $3`,
      [result, finalStatus, requestId]
    );

    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'search_completed', requestId });

    res.json({ ...result, requestId });
  } catch (err) { next(err); }
}

// ── POST /api/price-comparison/search (alias for mobile) ─────
// Mobile sends { query } → map to { searchQuery } — same middleware as /search-prices
router.post('/search', requireAuth, requirePermission('suppliers'), rateLimitAI(), (req, res, next) => {
  if (req.body.query && !req.body.searchQuery) {
    req.body.searchQuery = req.body.query;
  }
  searchPricesHandler(req, res, next);
});

// ── GET /api/price-comparison/history (mobile) ────────────────
router.get('/history', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const { rows } = await db.query(
      `SELECT id, search_query, status, result_data, created_at
         FROM price_comparison_requests
        WHERE business_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [req.user.businessId, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/price-comparison/export — ייצוא ל-Excel (Task 9) ──
router.get('/export', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.search_query,
              r.status,
              r.created_at,
              r.result_data,
              COUNT(o.id)::int                                      AS outreach_count,
              COUNT(o.id) FILTER (WHERE o.replied_at IS NOT NULL)::int AS replies_count
         FROM price_comparison_requests r
         LEFT JOIN price_comparison_outreach o ON o.request_id = r.id
        WHERE r.business_id = $1
        GROUP BY r.id
        ORDER BY r.created_at DESC`,
      [req.user.businessId]
    );

    const STATUS_HE = {
      searching: 'בחיפוש', awaiting_reply: 'ממתין לתשובות',
      completed: 'הושלם', no_result: 'אין תוצאות',
    };

    const sheetData = rows.map(r => {
      const rd = r.result_data || {};
      return {
        'תאריך':           new Date(r.created_at).toLocaleDateString('he-IL'),
        'שאילתה':          r.search_query,
        'סטטוס':           STATUS_HE[r.status] || r.status,
        'מחיר זול ביותר': rd.cheapestPrice?.price || '',
        'מקור המחיר':      rd.cheapestPrice?.source || '',
        'טווח מחירים':     rd.priceRange ? `${rd.priceRange.min || ''}–${rd.priceRange.max || ''} ${rd.priceRange.unit || ''}` : '',
        'ספקים שנמצאו':    (rd.suppliers || []).map(s => `${s.name}: ${s.price}`).join('; '),
        'סיכום AI':        rd.summary || '',
        'רמת ביטחון':      rd.confidence || '',
        'פניות לספקים':    r.outreach_count,
        'תשובות שהתקבלו': r.replies_count,
      };
    });

    const wb  = XLSX.utils.book_new();
    const ws  = XLSX.utils.json_to_sheet(sheetData);
    // RTL column widths
    ws['!cols'] = [
      { wch: 12 }, { wch: 25 }, { wch: 18 }, { wch: 18 },
      { wch: 20 }, { wch: 20 }, { wch: 40 }, { wch: 50 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'השוואת מחירים');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="price-comparison-${new Date().toISOString().slice(0,10)}.xlsx"`,
    });
    res.send(buf);
  } catch (err) { next(err); }
});

// ── GET /api/price-comparison/alerts — קבל התראות מחיר (Task 7) ──
router.get('/alerts', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, search_query, target_price, unit, notify_email, is_active,
              last_checked_at, last_triggered_at, created_at
         FROM price_comparison_alerts
        WHERE business_id = $1
        ORDER BY created_at DESC`,
      [req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/price-comparison/alerts — צור התראת מחיר ─────────
router.post('/alerts', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { searchQuery, targetPrice, unit, notifyEmail } = req.body;
    if (!searchQuery?.trim()) return res.status(400).json({ error: 'חסר שם המוצר' });
    if (!targetPrice || isNaN(parseFloat(targetPrice))) return res.status(400).json({ error: 'חסר מחיר יעד' });

    // Each active alert costs a full price lookup every morning. On SerpAPI's
    // Free Plan (250 searches/month) at 3 searches per lookup that is ~90
    // searches per alert per month, so a handful of alerts consumes the entire
    // plan — and creation was previously unbounded. Raise MAX_ACTIVE_PRICE_ALERTS
    // together with the SerpAPI plan, not before it.
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM price_comparison_alerts
        WHERE business_id = $1 AND is_active = TRUE`,
      [req.user.businessId]
    );
    if (countRows[0].n >= MAX_ACTIVE_PRICE_ALERTS) {
      return res.status(409).json({
        error: `הגעת למגבלת ההתראות הפעילות (${MAX_ACTIVE_PRICE_ALERTS}). מחק התראה קיימת כדי להוסיף חדשה.`,
        limit: MAX_ACTIVE_PRICE_ALERTS,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO price_comparison_alerts
         (business_id, search_query, target_price, unit, notify_email, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
      [req.user.businessId, searchQuery.trim(), parseFloat(targetPrice), unit || 'ק"ג', notifyEmail || null]
    );
    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'alert_created', alertId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/price-comparison/alerts/:alertId — מחק התראה ───
router.delete('/alerts/:alertId', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM price_comparison_alerts WHERE id = $1 AND business_id = $2',
      [req.params.alertId, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'alert_deleted', alertId: req.params.alertId });
    res.json({ message: 'התראה נמחקה' });
  } catch (err) { next(err); }
});

// ── PATCH /api/price-comparison/alerts/:alertId — עדכון פעיל/לא פעיל
router.patch('/alerts/:alertId', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { isActive } = req.body;
    // Re-activating counts against the same cap as creating — otherwise the
    // limit is trivially bypassed by deactivating, creating, and toggling back.
    if (isActive) {
      const { rows: countRows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM price_comparison_alerts
          WHERE business_id = $1 AND is_active = TRUE AND id <> $2`,
        [req.user.businessId, req.params.alertId]
      );
      if (countRows[0].n >= MAX_ACTIVE_PRICE_ALERTS) {
        return res.status(409).json({
          error: `הגעת למגבלת ההתראות הפעילות (${MAX_ACTIVE_PRICE_ALERTS}).`,
          limit: MAX_ACTIVE_PRICE_ALERTS,
        });
      }
    }
    const { rows } = await db.query(
      `UPDATE price_comparison_alerts SET is_active = $1 WHERE id = $2 AND business_id = $3 RETURNING *`,
      [!!isActive, req.params.alertId, req.user.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'התראה לא נמצאה' });
    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'alert_toggled', alertId: req.params.alertId });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/price-comparison — כל הבקשות ────────────────────
router.get('/', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*,
              COALESCE(o.outreach_count, 0) AS outreach_count,
              COALESCE(o.replies_count, 0)  AS replies_count
         FROM price_comparison_requests r
         LEFT JOIN (
           SELECT request_id,
                  COUNT(*) AS outreach_count,
                  COUNT(*) FILTER (WHERE replied_at IS NOT NULL) AS replies_count
           FROM price_comparison_outreach
           GROUP BY request_id
         ) o ON o.request_id = r.id
        WHERE r.business_id = $1
        ORDER BY r.created_at DESC`,
      [req.user.businessId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/price-comparison/:id — בקשה ספציפית עם outreach ─
router.get('/:id', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const [reqRow, outreach] = await Promise.all([
      db.query(
        'SELECT * FROM price_comparison_requests WHERE id = $1 AND business_id = $2',
        [req.params.id, req.user.businessId]
      ),
      db.query(
        'SELECT * FROM price_comparison_outreach WHERE request_id = $1 ORDER BY created_at',
        [req.params.id]
      ),
    ]);
    if (!reqRow.rows[0]) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    res.json({ ...reqRow.rows[0], outreach: outreach.rows });
  } catch (err) { next(err); }
});

// ── POST /api/price-comparison — יצירת בקשה + שליחת מיילים ─────
// מקבל requestId אופציונלי — אם סופק, משתמש ברשומה קיימת (Task 1)
router.post('/', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { searchType, searchQuery, suppliers, emailDraft, requestId } = req.body;
    if (!searchQuery) return res.status(400).json({ error: 'חסר שאילתת חיפוש' });

    let request;
    // אם נשלח requestId — שימוש ברשומה שנוצרה ב-search-prices
    if (requestId) {
      const { rows: existing } = await db.query(
        `SELECT id FROM price_comparison_requests WHERE id = $1 AND business_id = $2`,
        [requestId, req.user.businessId]
      );
      if (existing[0]) request = existing[0];
    }
    // אחרת — יצירה חדשה
    if (!request) {
      const { rows } = await db.query(
        `INSERT INTO price_comparison_requests (business_id, search_type, search_query, status)
         VALUES ($1, $2, $3, 'searching') RETURNING *`,
        [req.user.businessId, searchType || 'item', searchQuery]
      );
      request = rows[0];
    }

    // יצירת רשומות outreach + שליחת מיילים
    if (Array.isArray(suppliers) && suppliers.length > 0) {
      const bizRow = await db.query(
        `SELECT name FROM businesses WHERE id = $1`,
        [req.user.businessId]
      );
      const businessName = bizRow.rows[0]?.name || 'לקוח';

      const emailSubject = emailDraft?.subject || `בקשת מחיר — ${searchQuery} | ${businessName}`;
      const emailBodyText = emailDraft?.body || '';

      await Promise.allSettled(
        suppliers.filter(sup => sup.email).map(async sup => {
          const emailHtml = emailBodyText
            ? `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;white-space:pre-wrap">${escapeHtml(emailBodyText).replace(/\n/g, '<br>')}</div>`
            : `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <h2>שלום ${escapeHtml(sup.name || '')},</h2>
              <p><strong>${escapeHtml(businessName)}</strong> מעוניין לקבל הצעת מחיר עבור:</p>
              <p style="font-size:18px;font-weight:bold;background:#f3f4f6;padding:12px;border-radius:8px">${escapeHtml(searchQuery)}</p>
              <p>אנא ענו למייל זה עם המחיר והתנאים שלכם.</p>
              <p style="color:#6b7280;font-size:12px">House of Business — מערכת ניהול עסקים</p>
            </div>`;

          const { rows: outRows } = await db.query(
            `INSERT INTO price_comparison_outreach (request_id, supplier_name, supplier_email, is_existing, attempt_count, last_attempt_at)
             VALUES ($1, $2, $3, $4, 1, NOW()) RETURNING id`,
            [request.id, sup.name || sup.email, sup.email, !!sup.isExisting]
          );

          sendEmailFromBusiness(req.user.businessId, {
            to: sup.email,
            subject: emailSubject,
            html: emailHtml,
          }).catch(e => logger.error('[PriceComparison] email failed', { err: e.message }));

          await db.query(
            'UPDATE price_comparison_outreach SET last_attempt_at = NOW() WHERE id = $1',
            [outRows[0].id]
          );
        })
      );

      await db.query(
        `UPDATE price_comparison_requests SET status = 'awaiting_reply' WHERE id = $1`,
        [request.id]
      );
    }

    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'request_created', requestId: request.id });

    res.status(201).json(request);
  } catch (err) { next(err); }
});

// ── PUT /api/price-comparison/:id/result — עדכון תוצאה ────────
router.put('/:id/result', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { resultData, status } = req.body;
    // Must match price_comparison_requests.status's actual CHECK constraint
    // (and every other write to this column in this file — searchPricesHandler,
    // POST /, the outreach-reply handler) — this whitelist previously allowed
    // 'pending'/'cancelled'/'failed', none of which the DB accepts, so a
    // request using those values would pass this check and then fail with an
    // unhandled constraint-violation 500 instead of a clean 400.
    const VALID_STATUSES = ['searching', 'awaiting_reply', 'completed', 'no_result'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא חוקי' });
    }
    const { rows } = await db.query(
      `UPDATE price_comparison_requests
         SET result_data = $1, status = $2, updated_at = NOW()
       WHERE id = $3 AND business_id = $4 RETURNING *`,
      [resultData || null, status || 'completed', req.params.id, req.user.businessId]
    );
    // Every sibling route in this file 404s when the id isn't the caller's.
    // This one returned 200 with an empty body, so a request for someone else's
    // id looked like a successful update that silently changed nothing.
    if (!rows[0]) return res.status(404).json({ error: 'בקשה לא נמצאה' });
    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'result_updated', requestId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/price-comparison/:id/outreach/:outreachId — תגובת ספק + התראה (Task 3)
router.put('/:id/outreach/:outreachId', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    const { replyContent, approved } = req.body;

    // Recording the reply and deciding whether the request is finished have to be
    // one atomic step, serialized per request.
    //
    // Two suppliers replying at the same time each counted the outstanding
    // replies before the other had committed, so both saw one still pending and
    // neither marked the request completed — it stayed "in progress" forever with
    // every supplier answered. SELECT ... FOR UPDATE on the request row makes the
    // second reply wait for the first, so exactly one of them sees a zero count.
    const rows = await withTransaction(async (client) => {
      const { rows: reqRows } = await client.query(
        'SELECT id FROM price_comparison_requests WHERE id = $1 AND business_id = $2 FOR UPDATE',
        [req.params.id, req.user.businessId]
      );
      if (!reqRows.length) return [];

      const { rows: updated } = await client.query(
        `UPDATE price_comparison_outreach o
           SET reply_content = $1, replied_at = NOW(), approved = $2
         FROM price_comparison_requests r
         WHERE o.id = $3 AND o.request_id = $4
           AND r.id = $4 AND r.business_id = $5
         RETURNING o.*, r.search_query`,
        [replyContent, approved ?? null, req.params.outreachId, req.params.id, req.user.businessId]
      );
      if (!updated.length) return [];

      // כל הספקים ענו → סמן כ-completed
      const { rows: pending } = await client.query(
        'SELECT id FROM price_comparison_outreach WHERE request_id = $1 AND replied_at IS NULL',
        [req.params.id]
      );
      if (pending.length === 0) {
        await client.query(
          `UPDATE price_comparison_requests SET status = 'completed', updated_at = NOW() WHERE id = $1 AND business_id = $2`,
          [req.params.id, req.user.businessId]
        );
      }
      return updated;
    });

    if (!rows.length) return res.status(404).json({ error: 'פנייה לא נמצאה' });

    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'outreach_replied', requestId: req.params.id, outreachId: req.params.outreachId });

    // Task 3: שלח התראה לבעל העסק שספק ענה
    try {
      const bizCfgRow = await db.query(
        `SELECT
           -- business_email_configs first, fall back to owner user's email
           COALESCE(ec.email, owner_u.email) AS owner_email,
           b.name AS biz_name
         FROM businesses b
         LEFT JOIN business_email_configs ec ON ec.business_id = b.id
         LEFT JOIN users owner_u ON owner_u.business_id = b.id AND owner_u.role = 'owner'
         WHERE b.id = $1
         LIMIT 1`,
        [req.user.businessId]
      );
      const { owner_email: ownerEmail, biz_name: bizName } = bizCfgRow.rows[0] || {};
      if (ownerEmail) {
        const supplierName  = rows[0].supplier_name;
        const searchQuery   = rows[0].search_query;
        await sendEmailFromBusiness(req.user.businessId, {
          to: ownerEmail,
          subject: `💬 ספק ענה — ${supplierName} | ${searchQuery}`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#059669">✅ ספק ענה על בקשת המחיר</h2>
            <p><strong>ספק:</strong> ${escapeHtml(supplierName)}</p>
            <p><strong>מוצר:</strong> ${escapeHtml(searchQuery)}</p>
            ${replyContent ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin-top:12px">
              <p style="font-weight:bold;margin:0 0 8px 0">תשובת הספק:</p>
              <p style="margin:0;white-space:pre-wrap">${escapeHtml(replyContent)}</p>
            </div>` : ''}
            <p style="margin-top:16px"><a href="${process.env.PLATFORM_URL || 'https://app.houseofbusiness.co.il'}/price-comparison" style="background:#059669;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">פתח את המערכת לאישור</a></p>
            <p style="color:#6b7280;font-size:12px;margin-top:20px">House of Business — מערכת ניהול עסקים</p>
          </div>`,
        });
      }
    } catch (notifErr) {
      logger.warn('[PriceComparison] notification email failed', { err: notifErr.message });
    }

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/price-comparison/:id — מחיקת בקשה ──────────────
router.delete('/:id', requireAuth, requirePermission('suppliers'), async (req, res, next) => {
  try {
    await db.query(
      'DELETE FROM price_comparison_requests WHERE id = $1 AND business_id = $2',
      [req.params.id, req.user.businessId]
    );
    eventBus.publish(req.user.businessId, 'price_comparison.updated', { action: 'request_deleted', requestId: req.params.id });
    res.json({ message: 'בקשה נמחקה' });
  } catch (err) { next(err); }
});

module.exports = router;
