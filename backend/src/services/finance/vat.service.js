const db = require('../../utils/db');

// Israeli VAT rate = 18% (effective 1 January 2025). Selling prices assumed VAT-inclusive.
const VAT_RATE = 0.18;

// ── Which fixed expenses may have their VAT deducted ─────────────────────────
// Input VAT is deductible only against a tax invoice (חשבונית מס). This used to
// claim 18/118 of EVERY active expense, which on real data meant deducting VAT
// from ארנונה — a municipal levy that never carries VAT — and from rent, which
// carries VAT only when the landlord is a registered עוסק מורשה. On one business
// that was ₪5,797 of input VAT per bi-monthly filing that likely doesn't exist,
// i.e. an under-declaration, not a display bug.
//
// has_tax_invoice is the owner's explicit answer and always wins. When it's
// unset we only auto-decide the cases that aren't a judgement call:
//   NO  — statutorily exempt or not a taxable supply at all
//   YES — categories that in practice always arrive as a tax invoice
// Everything else (rent above all) stays UNKNOWN: excluded from the claim and
// reported back so the UI can ask. Excluding costs the owner money on paper;
// claiming wrongly costs them money to the Tax Authority, with interest.
const NO_VAT_PATTERNS = [
  /ארנונ/, /אגרה/, /אגרות/, /היטל/, /מס\s/, /ביטוח/, /ביטוח\s*לאומי/,
  /משכורת/, /שכר\s*עבודה/, /ריבית/, /עמלת\s*בנק/, /עמלות\s*בנק/, /הלוואה/,
  // Deliberately the two-word form, not a bare /רישיון/: a business licence is
  // a municipal fee with no VAT, but a software licence carries it. Left as a
  // bare word this would have quietly reclassified רישיון תוכנה as no-VAT.
  // Without it, a ₪2,400 licence sat in "unknown" and inflated the recoverable
  // figure the UI offers by ~₪366 the owner can never actually claim.
  /רישיון\s*עסק/,
];
const NO_VAT_CATEGORIES  = ['tax', 'taxes', 'arnona', 'insurance', 'salary', 'salaries', 'bank', 'loan', 'municipal'];
const VAT_CATEGORIES     = ['utilities', 'electricity', 'water', 'gas', 'telecom', 'phone', 'internet',
                            'accounting', 'maintenance', 'cleaning', 'marketing', 'advertising',
                            'software', 'subscriptions', 'equipment', 'supplies'];
const VAT_NAME_PATTERNS  = [/חשמל/, /מים/, /גז/, /טלפון/, /אינטרנט/, /בזק/, /סלקום/, /פרטנר/, /הוט/, /ביקום/,
                            /רואה\s*חשבון/, /הנהלת\s*חשבונות/, /ניקיון/, /אחזקה/, /תחזוקה/, /פרסום/, /שיווק/];

function _expenseVatStatus(exp) {
  if (exp.has_tax_invoice === true)  return 'yes';
  if (exp.has_tax_invoice === false) return 'no';
  const cat  = String(exp.category || '').toLowerCase().trim();
  const name = String(exp.name || '');
  if (NO_VAT_CATEGORIES.includes(cat))            return 'no';
  if (NO_VAT_PATTERNS.some(re => re.test(name)))  return 'no';
  if (VAT_CATEGORIES.includes(cat))               return 'yes';
  if (VAT_NAME_PATTERNS.some(re => re.test(name))) return 'yes';
  return 'unknown';
}

// Monthly-equivalent rate for a recurring expense. one_time is handled
// separately because it's an absolute amount tied to one period, not a rate.
function _monthlyRate(exp) {
  switch (exp.frequency) {
    case 'monthly':   return Number(exp.amount);
    case 'weekly':    return Number(exp.amount) * (52 / 12);
    case 'yearly':    return Number(exp.amount) / 12;
    case 'bimonthly': return Number(exp.amount) / 2;
    default:          return 0;
  }
}

// period=1 = monthly, period=2 = bi-monthly (combines month + month+1)
async function getVatReport(businessId, year, month, period = 1) {
  // Read business-specific VAT rate; fall back to the Israeli statutory default.
  const { rows: [bizRow] } = await db.query(
    `SELECT COALESCE(vat_rate, $1) AS vat_rate FROM businesses WHERE id = $2`,
    [VAT_RATE, businessId]
  ).catch(() => ({ rows: [{ vat_rate: VAT_RATE }] }));
  const vatRate = parseFloat(bizRow?.vat_rate ?? VAT_RATE);

  // Israeli bi-monthly VAT filing periods are FIXED legal pairs — Jan-Feb,
  // Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec — not a sliding two-month
  // window. Normalize the selected month down to its pair's first month
  // before computing bounds, so picking e.g. "February" reports Jan-Feb
  // (the real filing period) instead of Feb-Mar (which isn't a legal period).
  const periodStartMonth = period === 2 ? (month % 2 === 0 ? month - 1 : month) : month;
  const monthEnd = period === 2 ? periodStartMonth + 1 : month;

  const pad = n => String(n).padStart(2, '0');
  const startDate = `${year}-${pad(periodStartMonth)}-01`;
  // Built from arithmetic, not from a Date. `new Date(year, monthEnd, 1)` is
  // local midnight, and .toISOString() then converts to UTC — so anywhere east
  // of Greenwich it rolled back a day and the period ended on the 30th instead
  // of starting the 31st/1st. Since the bound is exclusive (< endDate), the
  // final day of every filing period silently dropped out of BOTH output and
  // input VAT. Production has no TZ set (UTC, correct by accident); any host
  // with TZ=Asia/Jerusalem — the natural setting for this app — got it wrong.
  const endMonthExclusive = monthEnd + 1;
  const endYear  = endMonthExclusive > 12 ? year + 1 : year;
  const endMonth = endMonthExclusive > 12 ? 1 : endMonthExclusive;
  const endDate  = `${endYear}-${pad(endMonth)}-01`;

  // sold_at is TIMESTAMPTZ, so the period bounds must be anchored to Israel
  // midnight, not UTC midnight — otherwise sales in the first ~2-3 hours of
  // the period's first day are excluded (and the symmetric error at the end
  // pulls in ~2-3 hours of the following month), misstating declared VAT.
  const { rows: [{ from_ts, to_ts }] } = await db.query(
    `SELECT
       ($1::timestamp AT TIME ZONE 'Asia/Jerusalem') AS from_ts,
       ($2::timestamp AT TIME ZONE 'Asia/Jerusalem') AS to_ts`,
    [startDate, endDate]
  );

  const V = vatRate;
  const V1 = 1 + vatRate;
  const { rows: [salesRow] } = await db.query(`
    WITH smart AS (
      SELECT *,
             DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
             (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
      FROM sales
      WHERE business_id = $1 AND sold_at >= $2 AND sold_at < $3
        -- A cancelled delivery (deliveries.routes.js PATCH /:id/status) must
        -- not be declared as taxable revenue — it was never actually fulfilled.
        AND status IS DISTINCT FROM 'cancelled'
    ),
    ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
    valid_sales AS (
      SELECT * FROM smart
      WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
    )
    SELECT
      COALESCE(SUM(total_amount),0)::float                        AS gross_sales,
      COALESCE(SUM(total_amount / ${V1} * ${V}),0)::float         AS output_vat,
      COALESCE(SUM(total_amount / ${V1}),0)::float                AS net_sales,
      COUNT(*)::int                                               AS tx_count
    FROM valid_sales
  `, [businessId, from_ts, to_ts]);

  // vat_amount when the invoice actually carries one, the standard-rate
  // derivation only as a fallback. Deriving it for every invoice silently
  // claims 18/118 of zero-rated purchases too (fresh produce is exempt in
  // Israel), so derived_count is reported back rather than blended away.
  //
  // approved_at is NOT used as a filter here on purpose: every invoice in the
  // database is currently unapproved, and excluding them would erase real money
  // that genuinely left the business. It's counted and surfaced instead, so the
  // owner can see how much of the claim rests on un-reviewed OCR output.
  const { rows: [invoiceRow] } = await db.query(`
    WITH inv AS (
      SELECT total_amount, approved_at,
             -- A stored vat_amount is only trusted when it could physically be
             -- the VAT on this invoice: not negative, and not more than the
             -- total. It arrives from OCR, and a misread decimal point would
             -- otherwise inflate the deduction without limit — the exact
             -- failure this whole change exists to prevent. Implausible values
             -- fall back to rate derivation and are counted as derived.
             CASE WHEN vat_amount >= 0 AND vat_amount <= total_amount
                  THEN vat_amount END AS usable_vat
      FROM invoices
      WHERE business_id = $1
        AND invoice_date >= $2 AND invoice_date < $3
    )
    SELECT
      COALESCE(SUM(total_amount),0)::float                                        AS gross_purchases,
      COALESCE(SUM(COALESCE(usable_vat, total_amount / ${V1} * ${V})),0)::float    AS input_vat,
      COALESCE(SUM(total_amount - COALESCE(usable_vat, total_amount / ${V1} * ${V})),0)::float AS net_purchases,
      COUNT(*)::int                                                               AS invoice_count,
      COUNT(*) FILTER (WHERE usable_vat IS NULL)::int                             AS derived_count,
      COUNT(*) FILTER (WHERE approved_at IS NULL)::int                            AS unapproved_count,
      COALESCE(SUM(total_amount) FILTER (WHERE approved_at IS NULL),0)::float     AS unapproved_amount
    FROM inv
  `, [businessId, startDate, endDate]);

  // Rows, not a SUM: each expense has to be judged individually for whether its
  // VAT is deductible at all (see _expenseVatStatus). The previous version
  // summed everything and multiplied by 18/118 in one step, which is what let
  // ארנונה and rent into the claim.
  const { rows: expenseRows } = await db.query(`
    SELECT name, category, amount::float AS amount, frequency, has_tax_invoice,
           -- הוצאה חד-פעמית היא סכום מוחלט לתקופה שבה נרשמה (created_at) — לא
           -- קצב-חודשי. בלי הבדיקה הזו היא נספרה בכל תקופת מע"מ לנצח כל עוד
           -- end_date לא הועבר, ואף הוכפלה בדו-חודשי.
           (frequency = 'one_time' AND created_at >= $2 AND created_at < $3) AS one_time_in_period
    FROM fixed_expenses
    WHERE business_id = $1 AND is_active = TRUE
      -- end_date was already honoured here; start_date was not, anywhere in the
      -- codebase, so an expense dated to begin next year was deducted today.
      AND (end_date   IS NULL OR end_date   >= $4)
      AND (start_date IS NULL OR start_date <  $5)
  `, [businessId, from_ts, to_ts, startDate, endDate]);

  const periodMonths = period === 2 ? 2 : 1;
  const spend = { yes: 0, no: 0, unknown: 0 };
  const unknownItems = [];
  for (const e of expenseRows) {
    // Recurring costs are a monthly RATE and scale with period length; a
    // one-time expense is an absolute amount already scoped to this exact
    // filing period and must NOT be scaled again.
    const amountForPeriod = e.frequency === 'one_time'
      ? (e.one_time_in_period ? Number(e.amount) : 0)
      : _monthlyRate(e) * periodMonths;
    if (!(amountForPeriod > 0)) continue;
    const status = _expenseVatStatus(e);
    spend[status] += amountForPeriod;
    if (status === 'unknown') unknownItems.push({ name: e.name, amount: Math.round(amountForPeriod * 100) / 100 });
  }

  const vatFactor       = vatRate / (1 + vatRate);
  const fixedExpenses   = spend.yes + spend.no + spend.unknown;
  const fixedExpenseVat = spend.yes * vatFactor;
  // What the owner could still legitimately claim once they confirm which of
  // the unknown expenses arrive with a tax invoice. Surfaced rather than
  // assumed in either direction.
  const unclaimedVat    = spend.unknown * vatFactor;

  const outputVat    = parseFloat((salesRow?.output_vat || 0).toFixed(2));
  const inputVatInv  = parseFloat((invoiceRow?.input_vat || 0).toFixed(2));
  const inputVatExp  = parseFloat(fixedExpenseVat.toFixed(2));
  const totalInputVat = parseFloat((inputVatInv + inputVatExp).toFixed(2));
  const netVat = parseFloat((outputVat - totalInputVat).toFixed(2));

  const { rows: byType } = await db.query(`
    WITH smart AS (
      SELECT *,
             DATE(sold_at AT TIME ZONE 'Asia/Jerusalem') AS sale_day,
             (pos_sale_id IS NULL OR pos_sale_id NOT LIKE 'Z-%') AS is_ind
      FROM sales
      WHERE business_id = $1 AND sold_at >= $2 AND sold_at < $3
        -- A cancelled delivery (deliveries.routes.js PATCH /:id/status) must
        -- not be declared as taxable revenue — it was never actually fulfilled.
        AND status IS DISTINCT FROM 'cancelled'
    ),
    ind_days AS (SELECT DISTINCT sale_day FROM smart WHERE is_ind),
    valid_sales AS (
      SELECT * FROM smart
      WHERE is_ind OR sale_day NOT IN (SELECT sale_day FROM ind_days)
    )
    SELECT sale_type,
           COALESCE(SUM(total_amount),0)::float                    AS gross,
           COALESCE(SUM(total_amount / ${V1} * ${V}),0)::float     AS vat
    FROM valid_sales
    GROUP BY sale_type
  `, [businessId, from_ts, to_ts]);

  return {
    period: { year, month, period, month_end: monthEnd, start_date: startDate, end_date: endDate },
    output: {
      gross_sales:  parseFloat((salesRow?.gross_sales || 0).toFixed(2)),
      net_sales:    parseFloat((salesRow?.net_sales || 0).toFixed(2)),
      output_vat:   outputVat,
      tx_count:     salesRow?.tx_count || 0,
      by_type:      byType,
    },
    input: {
      gross_purchases: parseFloat((invoiceRow?.gross_purchases || 0).toFixed(2)),
      net_purchases:   parseFloat((invoiceRow?.net_purchases || 0).toFixed(2)),
      input_vat_invoices: inputVatInv,
      input_vat_expenses: inputVatExp,
      total_input_vat:    totalInputVat,
      invoice_count:   invoiceRow?.invoice_count || 0,
      // Everything the figure above is resting on, so the screen can stop
      // presenting a derived number as a filed one.
      invoices_vat_derived: invoiceRow?.derived_count || 0,
      unapproved_count:     invoiceRow?.unapproved_count || 0,
      unapproved_amount:    parseFloat((invoiceRow?.unapproved_amount || 0).toFixed(2)),
      expenses_breakdown: {
        total:            parseFloat(fixedExpenses.toFixed(2)),
        vat_bearing:      parseFloat(spend.yes.toFixed(2)),
        no_vat:           parseFloat(spend.no.toFixed(2)),
        unknown:          parseFloat(spend.unknown.toFixed(2)),
        unknown_count:    unknownItems.length,
        unknown_items:    unknownItems.sort((a, b) => b.amount - a.amount).slice(0, 8),
        potential_extra_vat: parseFloat(unclaimedVat.toFixed(2)),
      },
    },
    net_vat:    netVat,
    payable:    netVat > 0,
    vat_rate:   vatRate * 100,
    // This report is a computed estimate, not a filed return. The UI shows the
    // net figure at 4xl in a red box labelled "מע\"מ לתשלום לרשות המסים"; it
    // needs something to hang a caveat on.
    is_estimate: true,
  };
}

module.exports = { getVatReport, VAT_RATE };
