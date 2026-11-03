/**
 * Supplier Negotiation Crew — 3-Agent Pipeline
 *
 * Agent 1 — Price Researcher  : analyzes invoice history & price trends
 * Agent 2 — Negotiation Strategist: identifies leverage & arguments
 * Agent 3 — Email Writer      : drafts professional negotiation email in Hebrew
 */

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../utils/db');
const logger    = require('../utils/logger');
const { createWithRetry } = require('../utils/anthropicRetry');
const { logTokenUsage }   = require('../utils/logTokenUsage');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const { sanitizeField } = require('../utils/aiSanitize');
const { withTimeout } = require('../utils/withTimeout');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Gather supplier data from DB ─────────────────────────────────────────────
async function gatherSupplierData(businessId, supplierId) {
  const [supplierRes, invoicesRes, itemsRes, altSuppliersRes] = await Promise.all([
    // Supplier details
    db.query(`
      SELECT id, name, contact_name, email, phone, preferred_channel, categories
      FROM suppliers WHERE id=$1 AND business_id=$2
    `, [supplierId, businessId]),

    // Invoice history — last 6 months
    db.query(`
      SELECT invoice_date, total_amount, notes
      FROM invoices
      WHERE business_id=$1 AND supplier_id=$2
        AND invoice_date >= NOW()-INTERVAL '6 months'
      ORDER BY invoice_date DESC
      LIMIT 20
    `, [businessId, supplierId]),

    // Items purchased from this supplier (from daily order history)
    db.query(`
      SELECT DISTINCT doi.name AS item_name
      FROM daily_order_items doi
      INNER JOIN daily_orders dord ON dord.id = doi.order_id
      WHERE dord.business_id=$1 AND dord.supplier_id=$2
      ORDER BY doi.name
      LIMIT 15
    `, [businessId, supplierId]).catch(() => ({ rows: [] })),

    // Other active suppliers (for comparison leverage)
    db.query(`
      SELECT name, categories FROM suppliers
      WHERE business_id=$1 AND id<>$2 AND is_active=TRUE
      LIMIT 5
    `, [businessId, supplierId]),
  ]);

  if (!supplierRes.rows[0]) throw new Error('Supplier not found');

  const invoices = invoicesRes.rows;
  const totalSpend = invoices.reduce((s, r) => s + Number(r.total_amount), 0);

  // Monthly spend trend — invoice_date comes as string 'YYYY-MM-DD' from pg
  const monthly = {};
  invoices.forEach(inv => {
    const m = inv.invoice_date ? String(inv.invoice_date).slice(0, 7) : '0000-00';
    monthly[m] = (monthly[m] || 0) + Number(inv.total_amount);
  });
  const monthlyArr = Object.entries(monthly).sort(([a],[b]) => a.localeCompare(b));
  const trend = monthlyArr.length >= 2 && monthlyArr[0][1] !== 0
    ? ((monthlyArr.at(-1)[1] - monthlyArr[0][1]) / monthlyArr[0][1] * 100).toFixed(1)
    : null;

  return {
    supplier: supplierRes.rows[0],
    invoices: {
      count:       invoices.length,
      totalSpend,
      avgPerInvoice: invoices.length > 0 ? totalSpend / invoices.length : 0,
      monthlyTrend: trend,
      recent:      invoices.slice(0, 5),
      monthly:     monthlyArr,
    },
    items:          itemsRes.rows.map(r => r.item_name).filter(Boolean),
    altSuppliers:   altSuppliersRes.rows,
  };
}

// ── Agent 1: Price Researcher ────────────────────────────────────────────────
async function runPriceResearcher(supplierData) {
  const fmt = n => new Intl.NumberFormat('he-IL', { style:'currency', currency:'ILS', maximumFractionDigits:0 }).format(n);
  const { supplier, invoices, items } = supplierData;
  const safeSupplierName = sanitizeField(String(supplier.name || '').replace(/[\r\n`]/g, ' '), 100);

  const prompt = `אתה מחקר מחירים ורכש. נתח את היסטוריית הרכישות מהספק "${safeSupplierName}":

**סיכום רכישות (6 חודשים):**
- סה"כ הוצאה: ${fmt(invoices.totalSpend)}
- מספר חשבוניות: ${invoices.count}
- ממוצע לחשבונית: ${fmt(invoices.avgPerInvoice)}
- מגמת הוצאות: ${invoices.monthlyTrend !== null ? (Number(invoices.monthlyTrend) > 0 ? `עלייה של ${invoices.monthlyTrend}%` : `ירידה של ${Math.abs(Number(invoices.monthlyTrend))}%`) : 'אין מספיק נתונים'}

**חשבוניות אחרונות:**
${invoices.recent.map(i => `- ${i.invoice_date ? new Date(i.invoice_date).toLocaleDateString('he-IL') : 'N/A'}: ${fmt(i.total_amount)}`).join('\n') || 'אין'}

**פריטים שנרכשו:**
${items.length > 0 ? items.map(i => sanitizeField(i, 60)).join(', ') : 'לא זוהו'}

זהה: (1) האם ההוצאות עולות? (2) האם יש עונתיות? (3) מה הנקודות החזקות שלנו במשא ומתן? היה ספציפי וממוקד בנתונים.`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  }, { context: { agent: 'supplierNegotiation', step: 'priceResearcher', supplier: safeSupplierName } });
  logTokenUsage({ businessId: supplierData.businessId, feature: 'supplier_negotiation_research', model: 'claude-haiku-4-5', usage: msg.usage });
  return msg.content[0].text;
}

// ── Agent 2: Negotiation Strategist ──────────────────────────────────────────
async function runNegotiationStrategist(supplierData, priceAnalysis) {
  const { supplier, invoices, altSuppliers } = supplierData;
  const fmt = n => new Intl.NumberFormat('he-IL', { style:'currency', currency:'ILS', maximumFractionDigits:0 }).format(n);
  const safeSupplierName = sanitizeField(String(supplier.name || '').replace(/[\r\n`]/g, ' '), 100);

  const prompt = `אתה מומחה למשא ומתן עסקי. בהתבסס על הניתוח הבא, בנה אסטרטגיית משא ומתן מול הספק "${safeSupplierName}".

**ניתוח מחירים:**
${priceAnalysis}

**נתונים נוספים:**
- ספקים חלופיים זמינים: ${altSuppliers.map(s => sanitizeField(s.name, 60)).join(', ') || 'אין'}
- נאמנות לספק: ${invoices.count} חשבוניות ב-6 חודשים (לקוח קבוע)
- היקף שנתי משוער: ${fmt(invoices.totalSpend * 2)}

בנה ב-JSON:
{
  "mainAsk": "מה לבקש (% הנחה / תנאי תשלום / מחיר קבוע)",
  "leverage": ["נקודת מינוף 1", "נקודת מינוף 2", "נקודת מינוף 3"],
  "concessions": ["ויתור שנוכל להציע 1", "ויתור 2"],
  "tone": "professional|firm|friendly",
  "suggestedDiscount": "X%",
  "fallbackPosition": "מה נקבל אם לא מקבלים הנחה"
}`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  }, { context: { agent: 'supplierNegotiation', step: 'negotiationStrategist', supplier: safeSupplierName } });
  logTokenUsage({ businessId: supplierData.businessId, feature: 'supplier_negotiation_strategy', model: 'claude-haiku-4-5', usage: msg.usage });

  const parsed = parseClaudeJSON(msg, { agent: 'supplierNegotiation', step: 'negotiationStrategist' });
  return parsed || { mainAsk: 'הנחה 10%', leverage: [], concessions: [], tone: 'professional', suggestedDiscount: '10%', fallbackPosition: 'תנאי תשלום טובים יותר' };
}

// ── Agent 3: Email Writer ─────────────────────────────────────────────────────
async function runEmailWriter(supplierData, priceAnalysis, strategy) {
  const { supplier, invoices } = supplierData;
  const fmt = n => new Intl.NumberFormat('he-IL', { style:'currency', currency:'ILS', maximumFractionDigits:0 }).format(n);
  const safeSupplierName = sanitizeField(String(supplier.name || '').replace(/[\r\n`]/g, ' '), 100);
  const safeContactName  = supplier.contact_name ? sanitizeField(String(supplier.contact_name).replace(/[\r\n`]/g, ' '), 60) : null;

  const prompt = `אתה כותב מקצועי למיילים עסקיים. כתוב מייל משא ומתן בעברית לספק.

**פרטי ספק:** ${safeSupplierName}${safeContactName ? `, לידי ${safeContactName}` : ''}
**אסטרטגיה:** ${JSON.stringify(strategy, null, 2)}
**נתוני רכש:** הוצאה של ${fmt(invoices.totalSpend)} ב-6 חודשים, ${invoices.count} חשבוניות

הנחיות:
- גוף מכובד ומקצועי אך תקיף
- הדגש את הנאמנות ארוכת הטווח
- ציין מספרים ספציפיים
- בקש בצורה ישירה את ה: ${strategy.mainAsk}
- אל תתנצל, אל תהיה אגרסיבי
- סיים עם call to action ברור (מתי ניפגש/נדבר)
- אורך: 150-220 מילה

החזר JSON:
{
  "subject": "נושא המייל",
  "body": "גוף המייל המלא",
  "followUpNote": "הערה פנימית — מה לעשות אם אין תגובה תוך 3 ימים"
}`;

  const msg = await createWithRetry(client, {
    model: 'claude-haiku-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  }, { context: { agent: 'supplierNegotiation', step: 'emailWriter', supplier: safeSupplierName } });
  logTokenUsage({ businessId: supplierData.businessId, feature: 'supplier_negotiation_email', model: 'claude-haiku-4-5', usage: msg.usage });

  const parsed = parseClaudeJSON(msg, { agent: 'supplierNegotiation', step: 'emailWriter' });
  if (parsed) return parsed;

  return { subject: `בקשה לעדכון תנאי רכש — ${supplier.name}`, body: msg.content[0]?.text || '', followUpNote: '' };
}

// ── Main Crew Runner ─────────────────────────────────────────────────────────
async function _runPipeline(businessId, supplierId) {
  const supplierData = await gatherSupplierData(businessId, supplierId);
  supplierData.businessId = businessId; // carried so each agent can log its AI token usage
  logger.info('[NegotiationCrew] Agent 1 (Data) done');

  const priceAnalysis = await runPriceResearcher(supplierData);
  logger.info('[NegotiationCrew] Agent 2 (Researcher) done');

  const strategy = await runNegotiationStrategist(supplierData, priceAnalysis);
  logger.info('[NegotiationCrew] Agent 3 (Strategist) done');

  const email = await runEmailWriter(supplierData, priceAnalysis, strategy);
  logger.info('[NegotiationCrew] Agent 4 (Email Writer) done');

  return {
    supplier:      supplierData.supplier,
    priceAnalysis,
    strategy,
    email,
    stats: {
      totalSpend:    supplierData.invoices.totalSpend,
      invoiceCount:  supplierData.invoices.count,
      monthlyTrend:  supplierData.invoices.monthlyTrend,
    },
  };
}

async function runSupplierNegotiationCrew(businessId, supplierId) {
  logger.info('[NegotiationCrew] Starting 3-agent pipeline', { supplierId });

  return withTimeout(
    _runPipeline(businessId, supplierId),
    40000, "Negotiation pipeline");
}

module.exports = { runSupplierNegotiationCrew };
