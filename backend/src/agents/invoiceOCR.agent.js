/**
 * Invoice OCR Agent
 * מקבל קבצי חשבונית (תמונות / PDF) → Gemini Vision מחלץ נתונים →
 * משייך לספק → בודק כפילות → שומר ב-DB
 */

const fs           = require('fs');
const path         = require('path');
const sharp        = require('sharp');
const Anthropic    = require('@anthropic-ai/sdk');
const logger       = require('../utils/logger');
const { logTokenUsage } = require('../utils/logTokenUsage');
const db             = require('../utils/db');
const invoiceModel   = require('../models/invoice.model');
const supplierModel  = require('../models/supplier.model');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { sanitizeAIOutput } = require('../utils/aiSanitize');
const { createWithRetry } = require('../utils/anthropicRetry');
const { parseClaudeJSON } = require('../utils/parseClaudeJSON');
const { withTimeout } = require('../utils/withTimeout');

const EXTRACT_PROMPT = `אתה מומחה OCR לחשבוניות עסקיות ישראליות. משימתך: לחלץ נתונים מהתמונה ולהחזיר JSON בלבד.

═══════════════════════════════════════════
פורמט הפלט — JSON בלבד, ללא טקסט נוסף:
═══════════════════════════════════════════
{
  "supplierName": "...",
  "invoiceNumber": "...",
  "invoiceDate": "YYYY-MM-DD",
  "totalAmount": 0.00,
  "vatAmount": 0.00,
  "preTaxAmount": 0.00,
  "paymentTerms": null,
  "items": [
    { "name": "...", "qty": 1.0, "unit": "יח'", "unitPrice": 0.00, "totalPrice": 0.00 }
  ],
  "notes": null,
  "confidence": 0.95
}

═══════════════════════════════════════════
חוק עליון — ציות מוחלט:
═══════════════════════════════════════════
אסור להמציא, לנחש, לתרגם, לשנות, לפרש, לקצר, או לנסח מחדש שום שדה.
אם לא קראת משהו במפורש מהתמונה — אל תכתוב אותו.

═══════════════════════════════════════════
supplierName — מיהו הספק?
═══════════════════════════════════════════
• הספק = החברה שהנפיקה את החשבונית = שם החברה שמודפס בראש הדף (לוגו / כותרת).
• הלקוח = מי שמופיע ב"לכבוד" / "נמען" — לא לכתוב אותו כ-supplierName.
• דוגמה: בחשבונית של "אר-אל אריזות בע"מ" ללקוח "זוקו" — supplierName = "אר-אל אריזות בע"מ".

═══════════════════════════════════════════
טבלת פריטים — קריאת עמודות
═══════════════════════════════════════════
בחשבוניות ישראליות הטבלה כתובה מימין לשמאל. העמודות הנפוצות מימין לשמאל:
  פריט/קוד | תיאור המוצר | כמות | מחיר יחידה | סכום שורה

חוקי קריאת עמודות — חובה:

name     = עמודת "תיאור" בלבד. העתק VERBATIM כל תו כפי שמודפס. אל תשנה.
qty      = עמודת "כמות". לעולם אל תכתוב 1 אם הכמות שבטבלה שונה מ-1.
unitPrice = עמודת "מחיר יחידה" / "מחיר יח'" / "מחיר". זהו המחיר לפריט בודד.
totalPrice = עמודת "סכום" / "סה"כ שורה". זהו qty × unitPrice.

⚠ אזהרה קריטית על מחירים:
• unitPrice ≠ totalPrice. לעולם אל תכתוב את הסכום כ-unitPrice.
• בדיקת תקינות: qty × unitPrice ≈ totalPrice. אם לא — בדוק שוב את העמודות.
• פורמט מחיר ישראלי — הנקודה היא תמיד מפריד עשרוני. העתק את המספר EXACTLY כפי שהוא:
    7.95   → 7.95    (שבע שקל ותשעים וחמש אגורות — אסור לעגל ל-8!)
    15.00  → 15.00   (חמישה עשר שקל)
    150.50 → 150.50  (מאה וחמישים שקל וחמישים אגורות — שתי ספרות עשרוניות שמרות)
    7.90   → 7.9     (ספרת אפס עודפת בסוף — ניתן להשמיט)
    1500.0 → 1500.0  (אלף וחמש מאות שקל)
• 🚫 אסור לעגל מחיר לשלם! 7.95 הוא 7.95, לא 8, לא 7.9, לא 8.0.
• 🚫 אסור בהחלט להכפיל ב-10, ב-100, או ב-1000. 150.00 הוא 150 שקל, לא 15000.
• אם כתוב "1,500.00" — הפסיק הוא מפריד אלפים, הערך הוא 1500.0.
• אם כתוב "1.500,00" (פורמט אירופאי) — הנקודה היא מפריד אלפים, הערך הוא 1500.0.
• כלל מפתח: הסר רק אפסים עודפים בסוף הספרות העשרוניות (7.950 → 7.95), אך שמור ספרות משמעותיות.

⚠ אזהרה קריטית על שמות:
• name = עמודת התיאור בלבד. אל תערבב תוכן מעמודת הקוד/מחיר/כמות לתוך השם.

🚫 אסור לגדר — בחר קריאה אחת:
• אם אתה מתלבט בין שתי קריאות אפשריות — כתוב את הסבירה יותר בלבד.
• ❌ "עסים / אסם חומץ טבעי"   ✅ "אסם חומץ טבעי"
• ❌ "רוטב שזיפים הלמנס \\ קנור"   ✅ "רוטב שזיפים קנור"
• לעולם אל תכתוב שתי אפשרויות מופרדות ב-/ או ב-\\ בתוך name.
• שם עם שתי אפשרויות הוא חסר תועלת למשתמש — עדיף ניחוש אחד סביר.
• זה החריג היחיד לכלל "אל תנחש": בבחירה בין שתי קריאות של אותן אותיות — הכרע.

🚫 אסור לגרור עמודות שכנות לתוך השם:
• מספר בודד עם X (כמו "X1", "2X") הוא עמודת כמות — לא חלק מהשם.
• מילה בסוגריים שהיא הערת מחיר ("(זול)", "(מבצע)") היא עמודת מחיר — לא חלק מהשם.
• אם ה-name יצא קצר מ-3 תווים או שהוא רק מספר — דלג על השורה, היא כנראה לא פריט.
• אם שורה מכילה רק סכומי ביניים ("סה\"כ", "הנחה", "מע\"מ") — אל תכלול אותה ב-items.
• קוד פריט (4-8 ספרות בעמודה שמאלית נפרדת) — לא לכתוב אותו ב-name. דוגמה: "1234 | שניצל עוף פריך 500ג | 3 | 18.00 | 54.00" → name="שניצל עוף פריך 500ג", קוד 1234 אינו חלק מה-name.
• ⛔ אסור לקצר שמות ארוכים. "שניצל עוף פריך 500 גרם קפוא" אסור לקצר ל"שניצל עוף". העתק את המילים VERBATIM עד הסוף.
• אם כתוב "מיכל מלבני 750 מ"ל קרפט חום א-300" — כתוב בדיוק זה, לא פירוש שלו.
• אסור להמיר מילה שאינך בטוח בה — אם אינך בטוח, כתוב את מה שאתה קורא כמו שהוא.

⚠ אזהרה על אותיות עבריות דומות — קרא בזהירות:
• ר (ריש) ≠ א (אלף) — "אר-אל" ≠ "אל-אל"
• מ ≠ נ — "מלח" ≠ "נלח"
• צ ≠ פ — "ניגוב" ≠ "נינוב"
• ו ≠ ז — "לרוטב" ≠ "לזוטב"
• ה ≠ ח — "כלים" ≠ "חלים"
• supplierName — קרא בזהירות את שם החברה בלוגו/כותרת. הבדל בין ר לא הוא קריטי.

unit = אם כתוב בטבלה — העתק. אם לא — כתוב "יח'".

═══════════════════════════════════════════
סכומים כלליים
═══════════════════════════════════════════
totalAmount  = הסכום הסופי כולל מע"מ. חפש תוויות: "סכום כולל מע"מ" / "סה"כ לתשלום" / "לתשלום" / "סה"כ כולל מע"מ" / "סה"כ חשבונית" / "סך הכל לתשלום" / "Total". זהו המספר הגדול ביותר בתחתית הדף.
vatAmount    = סכום המע"מ בלבד. תוויות: "מע"מ" / "מס ערך מוסף" / "VAT".
preTaxAmount = הסכום לפני מע"מ. תוויות: "סכום לפני מע"מ" / "סה"כ לפני מע"מ" / "סכום חייב" / "Pre-tax" / "Net".

═══════════════════════════════════════════
confidence
═══════════════════════════════════════════
0.95 — כל השדות ברורים וניתן לאמת qty × unitPrice = totalPrice לכל שורה.
0.75 — רוב השדות ברורים, אחד-שניים לא ודאיים.
0.50 — תמונה לא ברורה / חסרים נתונים מרכזיים.

החזר JSON בלבד — ללא הסברים, ללא markdown, ללא טקסט לפני או אחרי.`;

// ── processInvoice ────────────────────────────────────────────
async function processInvoice(businessId, filePaths, { mergePages = true, uploadedBy } = {}) {
  if (!filePaths?.length) throw Object.assign(new Error('לא הועלו קבצים'), { status: 400 });

  // חשבונית מרובת עמודים — עיבוד כל עמוד בנפרד
  if (!mergePages && filePaths.length > 1) {
    try {
      const results = await Promise.all(
        filePaths.map(p => processInvoice(businessId, [p], { mergePages: true, uploadedBy }))
      );
      return { multiPage: true, invoices: results };
    } catch (err) {
      logger.error('[OCR] Multi-page partial failure', { err: err.message, businessId, pages: filePaths.length });
      return {
        status:       'manual_required',
        imageUrls:    [],
        aiConfidence: 0,
        extracted:    null,
        error:        'שגיאה בעיבוד חשבונית מרובת עמודים — חלק מהעמודים נכשל',
      };
    }
  }

  // בניית תוכן לשליחה ל-Claude
  let parts;
  try {
    parts = await Promise.all(filePaths.map(p => _buildPart(p)));
  } catch (err) {
    logger.error('[OCR] Failed to read uploaded files', { err: err.message });
    await _cleanupFiles(filePaths);
    return {
      status:       'manual_required',
      imageUrls:    filePaths.map(p => path.basename(p)),
      aiConfidence: 0,
      extracted:    null,
      error:        'שגיאה בקריאת הקבצים שהועלו',
    };
  }

  // שליחה ל-Claude Vision
  let extracted    = null;
  let aiConfidence = 0;

  try {
    const raw    = await _extractWithGemini(parts, businessId);
    extracted    = sanitizeAIOutput(raw);
    aiConfidence = _parseConfidence(extracted.confidence);
    if (!Array.isArray(extracted?.items) || extracted.items.length === 0) {
      logger.warn('[OCR] AI returned no items — inventory update will be skipped', { businessId, confidence: aiConfidence });
    }
  } catch (err) {
    logger.error('[OCR] Vision extraction failed', { err: err.message });
    await _cleanupFiles(filePaths);
    return {
      status:       'manual_required',
      imageUrls:    filePaths.map(p => path.basename(p)),
      aiConfidence: 0,
      extracted:    null,
      error:        err.message,
    };
  }

  // שיוך לספק, בדיקת כפילות ושמירה ב-DB — אם נכשל, מנקים קבצים
  try {
    let supplierId   = await _matchSupplier(businessId, extracted.supplierName);
    let supplierAutoCreated = false;
    if (!supplierId && extracted.supplierName) {
      supplierId = await _autoCreateSupplier(businessId, extracted.supplierName);
      supplierAutoCreated = !!supplierId;
    }

    // בדיקת כפילות — invoiceModel.findDuplicate כבר יודע ליפול חזרה להתאמה לפי
    // סכום+תאריך כשאין מספר חשבונית (נפוץ אצל ספקים לא-פורמליים); לפני התיקון
    // הבדיקה כולה דולגה כשלא היה מספר חשבונית, אז כפילות כזו מעולם לא זוהתה.
    // הרצה תמיד (גם כש-supplierId ריק) — findDuplicate משתמש ב-IS NOT DISTINCT
    // FROM כדי להשוות נכון גם ספק לא-מזוהה מול חשבוניות אחרות ללא ספק.
    {
      const duplicate = await invoiceModel.findDuplicate(businessId, {
        supplierId,
        invoiceNumber: extracted.invoiceNumber,
        totalAmount:   extracted.totalAmount,
        invoiceDate:   extracted.invoiceDate,
      });

      if (duplicate) {
        await _cleanupFiles(filePaths);
        return {
          status:      'duplicate',
          duplicateId: duplicate.id,
          message:     `חשבונית כפולה — כבר קיימת (${duplicate.id})`,
        };
      }
    }

    // שמירת הקבצים כ-URLs
    const imageUrls = filePaths.map(p => path.basename(p));

    // שמירת החשבונית ב-DB
    const invoice = await invoiceModel.create(
      businessId,
      {
        supplierId,
        invoiceNumber: extracted.invoiceNumber || null,
        invoiceDate:   extracted.invoiceDate   || null,
        totalAmount:   extracted.totalAmount != null ? extracted.totalAmount : null,
        vatAmount:     extracted.vatAmount   != null ? extracted.vatAmount   : null,
        aiConfidence,
        aiRawData:     extracted,
        imageUrls,
        notes: extracted.notes || null,
      },
      uploadedBy
    );

    // שמירת פריטים בלבד — עדכון המלאי בפועל קורה רק באישור החשבונית
    // (PUT /api/invoices/:id/approve → syncInventoryFromInvoice), לא כאן.
    // חשבונית שעדיין לא אושרה עלולה להיות שגויה/כפולה/נדחית, ועדכון מלאי
    // כפול בהעלאה + באישור היה מכפיל את הכמות שנוספה למלאי בכל חשבונית.
    if (extracted.items?.length > 0) {
      const itemsWithIds = await _matchInventoryItems(businessId, extracted.items, supplierId);
      await invoiceModel.addItems(invoice.id, businessId, itemsWithIds);
    }

    // יומן פעילות
    try {
      await db.query(
        `INSERT INTO activity_log (business_id, user_id, action, module, entity_id, entity_name)
         VALUES ($1,$2,'invoice_uploaded','finance',$3,$4)`,
        [businessId, uploadedBy, invoice.id, extracted.supplierName || 'לא ידוע']
      );
    } catch { /* לא קריטי */ }

    return {
      status:              supplierId ? (supplierAutoCreated ? 'supplier_created' : 'matched') : 'unmatched',
      invoiceId:           invoice.id,
      supplierId,
      supplierName:        extracted.supplierName,
      supplierAutoCreated,
      invoiceNumber:       extracted.invoiceNumber,
      invoiceDate:         extracted.invoiceDate,
      totalAmount:         extracted.totalAmount,
      vatAmount:           extracted.vatAmount,
      itemsCount:          extracted.items?.length || 0,
      aiConfidence,
      requiresManualMatch: !supplierId,
    };
  } catch (err) {
    logger.error('[OCR] Post-extraction DB error, cleaning up files', { err: err.message, businessId });
    await _cleanupFiles(filePaths);
    return {
      status:       'manual_required',
      imageUrls:    [],
      aiConfidence: 0,
      extracted:    null,
      error:        'שגיאת מסד נתונים בשמירת החשבונית',
    };
  }
}

// ── בניית part לפי סוג קובץ ───────────────────────────────────
async function _buildPart(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  let buffer;
  if (ext === '.pdf') {
    // PDF — שולחים כ-inlineData
    buffer = await fs.promises.readFile(filePath);
    return {
      inlineData: {
        mimeType: 'application/pdf',
        data: buffer.toString('base64'),
      },
    };
  }

  // תמונה — אופטימיזציה + המרת HEIC; resize תמיד כדי לא לשלוח תמונות ענק
  //
  // The cap is chosen from the page's shape, not fixed at 2048. A tall invoice
  // squeezed into 2048px leaves roughly 30 pixels per row once it carries 20+
  // line items — marginal for Hebrew, and exactly where extraction started
  // producing merged columns and two-candidate readings like "עסים / אסם".
  // Short receipts keep 2048, which is ample for them and cheaper to send.
  const _dims = await sharp(filePath).metadata().catch(() => null);
  const _ratio = _dims?.height && _dims?.width ? _dims.height / _dims.width : 1;
  // A4 is ~1.41; anything meaningfully taller is a long itemised invoice.
  const MAX_DIM = _ratio >= 2.2 ? 4096 : _ratio >= 1.6 ? 3072 : 2048;

  if (ext === '.png') {
    // PNG: resize only, stay lossless — JPEG compression degrades fine text and harms OCR accuracy
    buffer = await sharp(filePath)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer();
    return { inlineData: { mimeType: 'image/png', data: buffer.toString('base64') } };
  }

  buffer = await sharp(filePath)
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    // Sharpened before compression: printed Hebrew on thermal/dot-matrix paper
    // loses stroke definition when downscaled, and ר/א and מ/נ differ by a few
    // pixels of stroke.
    .sharpen()
    .jpeg({ quality: 95 })
    .toBuffer();

  return {
    inlineData: {
      mimeType: 'image/jpeg',
      data: buffer.toString('base64'),
    },
  };
}

// ── Claude Vision — חילוץ נתונים ────────────────────────────
async function _extractWithGemini(parts, businessId) {
  // בניית תוכן לקלוד — תמונות + PDF
  const contentBlocks = parts.map(part => {
    const { mimeType, data } = part.inlineData;
    if (mimeType === 'application/pdf') {
      return {
        type:   'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      };
    }
    return {
      type:   'image',
      source: { type: 'base64', media_type: mimeType, data },
    };
  });

  const headers = parts.some(p => p.inlineData.mimeType === 'application/pdf')
    ? { 'anthropic-beta': 'pdfs-2024-09-25' }
    : {};

  const userContent = [...contentBlocks, { type: 'text', text: 'חלץ את נתוני החשבונית מהמסמך לפי ההוראות. החזר JSON בלבד.' }];
  const callOptions = { requestOptions: { headers }, context: { agent: 'invoiceOCR', businessId } };

  // הזרקת רשימת ספקים קיימים — Claude מתאים את supplierName לשם המדויק מהמאגר
  const { rows: knownSuppliers } = await db.query(
    `SELECT name FROM suppliers WHERE business_id = $1 ORDER BY name LIMIT 60`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  const supplierSection = knownSuppliers.length
    ? `\n\n═══════════════════════════════════════════\nספקים קיימים במערכת — התאם אם אפשר\n═══════════════════════════════════════════\n` +
      knownSuppliers.map(s => `• ${s.name}`).join('\n') +
      `\n\nאם שם הספק בחשבונית זהה או דומה מאוד לאחד מהרשימה — החזר את השם המדויק מהרשימה. אם אינך בטוח — החזר את מה שכתוב בחשבונית.`
    : '';

  // הזרקת שמות פריטים שנלמדו מחשבוניות קודמות — עוזרת ל-Claude לזהות שמות מוכרים.
  // multiplier מושמט כאן כי הוא תלוי-ספק ואיננו יודעים עדיין מהו הספק בחשבונית זו.
  const { rows: learnedTemplates } = await db.query(
    `SELECT t.raw_name, ii.name AS inventory_name, s.name AS supplier_name
     FROM invoice_item_templates t
     JOIN inventory_items ii ON ii.id = t.inventory_item_id
     LEFT JOIN suppliers s ON s.id = t.supplier_id
     WHERE t.business_id = $1 AND t.inventory_item_id IS NOT NULL
     ORDER BY t.use_count DESC, t.last_seen_at DESC
     LIMIT 60`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  const templateSection = learnedTemplates.length
    ? `\n\n═══════════════════════════════════════════\nפריטים שנראו בחשבוניות קודמות של עסק זה\n═══════════════════════════════════════════\nרשימה לעזרה בזיהוי שמות בלבד — אל תשנה כמויות על פיה:\n` +
      learnedTemplates.map(t => {
        const supStr = t.supplier_name ? ` (${t.supplier_name})` : '';
        return `• "${t.raw_name}"${supStr} → "${t.inventory_name}"`;
      }).join('\n')
    : '';

  // ── Vocabulary of item names this business has actually bought ─────────────
  // invoice_item_templates only gains a row when an item is matched to
  // inventory during approval, so it stays nearly empty for a long time — one
  // row against 63 distinct item names already on record here. invoice_items is
  // the far richer source, and approving an invoice writes back whatever the
  // owner corrected on screen (invoiceModel.replaceItems), so every manual fix
  // becomes part of this list for the next extraction. That is the learning
  // loop, and it needs no new table to close.
  //
  // Approved invoices come first because a human looked at those names. The
  // rest are ordered by how often they recur — a name seen on five invoices is
  // far more likely to be right than one seen once.
  const { rows: seenItems } = await db.query(
    `SELECT it.name,
            BOOL_OR(i.approved_at IS NOT NULL) AS verified,
            COUNT(*)::int AS times
     FROM invoice_items it
     JOIN invoices i ON i.id = it.invoice_id
     WHERE i.business_id = $1
       AND it.name IS NOT NULL AND LENGTH(TRIM(it.name)) >= 3
       -- Anything the model previously hedged on ("עסים / אסם") is exactly what
       -- must not be fed back as a reference. chr(92) rather than a literal
       -- backslash in LIKE: backslash is LIKE's own escape character, so the
       -- pattern has to survive both JS and SQL escaping and silently matched
       -- the wrong thing — it excluded every row and left the list empty.
       AND strpos(it.name, '/') = 0
       AND strpos(it.name, chr(92)) = 0
     GROUP BY it.name
     ORDER BY verified DESC, times DESC, it.name
     LIMIT 80`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  const vocabSection = seenItems.length
    ? `\n\n═══════════════════════════════════════════\nמוצרים שהעסק הזה קנה בעבר — התאם אליהם\n═══════════════════════════════════════════\n` +
      seenItems.map(v => `• ${v.name}${v.verified ? ' ✓' : ''}`).join('\n') +
      `\n\nכלל: אם שורה בחשבונית תואמת או דומה מאוד לאחד מהשמות ברשימה — כתוב את השם המדויק מהרשימה.\n` +
      `שמות המסומנים ב-✓ אושרו על ידי בעל העסק — העדף אותם.\n` +
      `זו רשימת עזר לזיהוי אותיות מטושטשות בלבד. אם הפריט בחשבונית אינו ברשימה — כתוב מה שקראת, אל תכריח התאמה.`
    : '';

  const systemBlocks = [
    { type: 'text', text: EXTRACT_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(supplierSection ? [{ type: 'text', text: supplierSection }] : []),
    ...(templateSection ? [{ type: 'text', text: templateSection }] : []),
    ...(vocabSection ? [{ type: 'text', text: vocabSection }] : []),
  ];

  // Step 1 — Haiku (8× cheaper). Fall back to Sonnet only if required fields are missing.
  try {
    const haikuRes = await withTimeout(
    createWithRetry(anthropic, {
        model:      'claude-haiku-4-5',
        max_tokens: 4096,
        system:     systemBlocks,
        messages:   [{ role: 'user', content: userContent }],
      }, callOptions),
    50_000, "Haiku OCR");
    logTokenUsage({ businessId, feature: 'invoice_ocr_haiku', model: 'claude-haiku-4-5', usage: haikuRes.usage });
    const haikuParsed = parseClaudeJSON(haikuRes, { agent: 'invoiceOCR', businessId });
    const missing = haikuParsed ? [
      !haikuParsed.supplierName        && 'supplierName',
      haikuParsed.totalAmount == null  && 'totalAmount',
      !haikuParsed.invoiceDate         && 'invoiceDate',
    ].filter(Boolean) : ['supplierName', 'totalAmount', 'invoiceDate'];
    if (haikuParsed && missing.length === 0) return haikuParsed;
    logger.info('[OCR] Haiku missing fields → Sonnet', { businessId, missing });
  } catch (haikuErr) {
    logger.warn('[OCR] Haiku failed → Sonnet', { businessId, err: haikuErr.message });
  }

  // Step 2 — Sonnet fallback (only when Haiku incomplete or failed)
  const res = await withTimeout(
    createWithRetry(anthropic, {
      model:      'claude-sonnet-5',
      max_tokens: 4096,
      system:     systemBlocks,
      messages:   [{ role: 'user', content: userContent }],
    }, callOptions),
    70_000, "OCR timeout — נסה שוב (השרת עמוס כרגע)");

  logTokenUsage({ businessId, feature: 'invoice_ocr', model: 'claude-sonnet-5', usage: res.usage });

  // parseClaudeJSON also warns when stop_reason==='max_tokens' — a long
  // multi-page invoice can get truncated mid-array, which previously surfaced
  // as an opaque "AI החזיר JSON לא תקין" with no hint that the real cause was
  // a token-limit cutoff rather than a genuinely malformed response.
  const parsed = parseClaudeJSON(res, { agent: 'invoiceOCR', businessId });
  if (!parsed) {
    const text = res.content.find(b => b.type === 'text')?.text?.trim() || '';
    throw new Error(`AI החזיר JSON לא תקין: ${text.slice(0, 120)}`);
  }
  return parsed;
}

// הסרת סיומות חברה ("בע"מ", "ח.פ." וכו') — הופכת "X בע"מ" ל"X" לפני השוואה
function _normalizeName(name) {
  return (name || '')
    .replace(/\s*(בע["״׳']מ|בעמ|בע''מ|ב\.ע\.מ\.)\s*/gi, '')
    .replace(/\s*(ח\.פ\.|ח["״׳']פ|חפ)\s*/gi, '')
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── שיוך לספק לפי שם (fuzzy match) ──────────────────────────
async function _matchSupplier(businessId, supplierName) {
  if (!supplierName) return null;

  const normalized = _normalizeName(supplierName);

  try {
    // ניסיון 1: SIMILARITY עם שם מנורמל מול DB מנורמל (מנטרל הבדלי "בע"מ")
    const { rows } = await db.query(
      `SELECT id FROM suppliers
       WHERE business_id = $1
         AND SIMILARITY(
           LOWER(REGEXP_REPLACE(name, $$\s*(בע["״’’]מ|בעמ|ח\.פ\.|ח["״’’]פ)\s*$$, ‘’, ‘gi’)),
           LOWER($2)
         ) > 0.3
       ORDER BY SIMILARITY(
         LOWER(REGEXP_REPLACE(name, $$\s*(בע["״’’]מ|בעמ|ח\.פ\.|ח["״’’]פ)\s*$$, ‘’, ‘gi’)),
         LOWER($2)
       ) DESC
       LIMIT 1`,
      [businessId, normalized]
    );
    if (rows[0]) return rows[0].id;
  } catch { /* pg_trgm לא זמין */ }

  // ניסיון 2: ILIKE על המילה הראשונה המשמעותית של השם המנורמל
  const words = normalized.split(/\s+/).filter(w => w.length >= 3);
  if (!words.length) return null;

  const { rows } = await db.query(
    `SELECT id FROM suppliers
     WHERE business_id = $1 AND LOWER(name) ILIKE $2
     LIMIT 1`,
    [businessId, `%${words[0].toLowerCase()}%`]
  );
  return rows[0]?.id || null;
}

// ── שיוך פריטים לפריטי מלאי ──────────────────────────────────
async function _matchInventoryItems(businessId, items, supplierId = null) {
  // Load learned templates for this supplier — used as the highest-priority match
  const templateMap = new Map(); // raw_name → inventory_item_id
  if (supplierId) {
    const { rows: tpls } = await db.query(
      `SELECT raw_name, inventory_item_id
       FROM invoice_item_templates
       WHERE business_id = $1 AND supplier_id = $2 AND inventory_item_id IS NOT NULL`,
      [businessId, supplierId]
    ).catch(() => ({ rows: [] }));
    for (const t of tpls) templateMap.set(t.raw_name, t.inventory_item_id);
  }

  // טוען את כל פריטי המלאי פעם אחת
  const { rows: invItems } = await db.query(
    `SELECT id, name FROM inventory_items WHERE business_id = $1`,
    [businessId]
  ).catch(() => ({ rows: [] }));

  return Promise.all(items.map(async (item) => {
    const itemNameLower = item.name.toLowerCase().trim();

    // ניסיון 0: תבנית שנלמדה מחשבוניות קודמות של אותו ספק — הכי מהיר ומדויק
    const tplId = templateMap.get(itemNameLower);
    if (tplId) return { ...item, inventoryItemId: tplId, fromTemplate: true };

    // ניסיון 1: SIMILARITY (pg_trgm) — הכי מדויק
    try {
      const { rows } = await db.query(
        `SELECT id FROM inventory_items
         WHERE business_id = $1
           AND SIMILARITY(LOWER(name), LOWER($2)) > 0.3
         ORDER BY SIMILARITY(LOWER(name), LOWER($2)) DESC
         LIMIT 1`,
        [businessId, item.name]
      );
      if (rows[0]) return { ...item, inventoryItemId: rows[0].id };
    } catch { /* pg_trgm לא זמין */ }

    // ניסיון 2: שם המלאי מופיע בתוך שם הפריט בחשבונית
    // לדוגמה: "אורז" נמצא בתוך "אורז יסמין שקקח 5 קג מחוילק"
    const substrMatch = invItems.find(inv => {
      const invName = inv.name.toLowerCase();
      return invName.length >= 3 && itemNameLower.includes(invName);
    });
    if (substrMatch) return { ...item, inventoryItemId: substrMatch.id };

    // ניסיון 3: המילה הראשונה של שם הפריט מופיעה בשם המלאי
    const firstWord = itemNameLower.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3) {
      const wordMatch = invItems.find(inv =>
        inv.name.toLowerCase().includes(firstWord)
      );
      if (wordMatch) return { ...item, inventoryItemId: wordMatch.id };
    }

    return { ...item, inventoryItemId: null };
  }));
}

// ── יצירת ספק אוטומטית מחשבונית ─────────────────────────────
async function _autoCreateSupplier(businessId, supplierName) {
  if (!supplierName?.trim()) return null;
  try {
    const supplier = await supplierModel.create(businessId, {
      name:             supplierName.trim(),
      categories:       [],
      preferredChannel: 'email',
      notes:            'נוצר אוטומטית מסריקת חשבונית',
    });
    logger.info('[OCR] ספק נוצר אוטומטית', { supplierName, id: supplier.id });
    return supplier.id;
  } catch (err) {
    logger.error('[OCR] שגיאה ביצירת ספק אוטומטי', { supplierName, err: err.message });
    return null;
  }
}

function _parseConfidence(raw) {
  const n = parseFloat(raw);
  if (isNaN(n)) return 0.8;
  return Math.min(1, Math.max(0, n));
}

async function _cleanupFiles(paths) {
  for (const p of paths) {
    try { await fs.promises.unlink(p); } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('[OCR] cleanup error', { p, err: err.message });
    }
  }
}

module.exports = { processInvoice };
