/**
 * Payslip PDF Generator
 * מייצר תלוש שכר PDF בעברית (RTL) עם כל הפרטים הנדרשים
 */

const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');

const UPLOADS_DIR = path.join(__dirname, '../../../uploads/payslips');

// Created on first use, not at import. Doing it at module load took the whole
// server down: attaching a Railway volume at /app/uploads made the mount
// root-owned, this mkdir threw EACCES during require(), and the process
// crash-looped before the HTTP listener ever started. A payslip directory
// that can't be created should fail the payslip request, not the deploy.
function ensureUploadsDir() {
  if (fs.existsSync(UPLOADS_DIR)) return;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const MONTH_NAMES = [
  'ינואר','פברואר','מרץ','אפריל','מאי','יוני',
  'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר',
];

/**
 * מייצר PDF ומחזיר Buffer + נתיב שמירה
 * @param {object} d — payslipData מ-generatePayslip
 * @returns {{ buffer: Buffer, filePath: string }}
 */
async function buildPayslipPdf(d) {
  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'תלוש שכר' } });
    const chunks = [];

    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 595 - 100; // רוחב תוכן (A4 - margins)
    const period = `${MONTH_NAMES[d.periodMonth - 1]} ${d.periodYear}`;

    // ── כותרת ──────────────────────────────────────────────────
    doc.rect(50, 40, W, 70).fill('#1e40af');

    doc.fontSize(22).fillColor('#ffffff')
      .text('תלוש שכר', 50, 52, { align: 'center', width: W });

    doc.fontSize(12).fillColor('#bfdbfe')
      .text(period, 50, 80, { align: 'center', width: W });

    doc.fillColor('#000000');
    let y = 130;

    // ── שורת פרטים (עובד | מעסיק) ─────────────────────────────
    _sectionTitle(doc, 'פרטים', y);  y += 20;

    const col1x = 50, col2x = 310;

    _row(doc, col1x, y, 'שם עובד',  d.employeeName);
    _row(doc, col2x, y, 'שם מעסיק', d.businessName);
    y += 18;
    _row(doc, col1x, y, 'אימייל',   d.employeeEmail || '—');
    _row(doc, col2x, y, 'ח.פ / ע.מ', d.businessVat || '—');
    y += 18;
    _row(doc, col1x, y, 'תפקיד',    d.role || '—');
    _row(doc, col2x, y, 'כתובת',    d.businessAddress || '—');
    y += 30;

    // ── רכיבי שכר ─────────────────────────────────────────────
    _sectionTitle(doc, 'רכיבי שכר', y);  y += 8;
    y = _tableHeader(doc, y, ['רכיב', 'כמות', 'תעריף', 'סכום']);

    if (d.salaryType === 'hourly') {
      y = _tableRow(doc, y, [
        'שעות רגילות',
        `${_num(d.regularHours)} שעות`,
        `₪${_num(d.hourlyRate)}`,
        `₪${_num(d.regularHours * d.hourlyRate)}`,
      ]);
      if (d.overtime125 > 0) {
        y = _tableRow(doc, y, [
          'שעות נוספות 125%',
          `${_num(d.overtime125)} שעות`,
          `₪${_num(d.hourlyRate * 1.25)}`,
          `₪${_num(d.overtime125 * d.hourlyRate * 1.25)}`,
        ]);
      }
      if (d.overtime150 > 0) {
        y = _tableRow(doc, y, [
          'שעות נוספות 150%',
          `${_num(d.overtime150)} שעות`,
          `₪${_num(d.hourlyRate * 1.5)}`,
          `₪${_num(d.overtime150 * d.hourlyRate * 1.5)}`,
        ]);
      }
    } else {
      y = _tableRow(doc, y, ['שכר גלובלי קבוע', '—', '—', `₪${_num(d.grossSalary)}`]);
    }

    // סה"כ ברוטו
    doc.rect(50, y, W, 22).fill('#eff6ff');
    doc.fillColor('#1e40af').fontSize(11)
      .text('סה״כ ברוטו', 55, y + 6)
      .text(`₪${_num(d.grossSalary)}`, 50, y + 6, { align: 'right', width: W - 5 });
    doc.fillColor('#000000');
    y += 30;

    // ── ניכויים ────────────────────────────────────────────────
    _sectionTitle(doc, 'ניכויים', y);  y += 8;
    y = _tableHeader(doc, y, ['ניכוי', 'אחוז / נק\'', 'סכום', '']);

    const deductions = [
      ['מס הכנסה',      `${d.taxCreditPoints} נק' זיכוי`, `₪${_num(d.incomeTax)}`],
      ['ביטוח לאומי',   '3.5% / 12%',                    `₪${_num(d.nationalInsurance)}`],
      ['ביטוח בריאות',  '3.1% / 5%',                     `₪${_num(d.healthInsurance)}`],
      ['פנסיה (עובד)',   '6%',                             `₪${_num(d.pension)}`],
    ];

    const totalDed = d.incomeTax + d.nationalInsurance + d.healthInsurance + d.pension;
    for (const [label, pct, amount] of deductions) {
      y = _tableRow(doc, y, [label, pct, amount, '']);
    }

    // סה"כ ניכויים
    doc.rect(50, y, W, 22).fill('#fef2f2');
    doc.fillColor('#dc2626').fontSize(11)
      .text('סה״כ ניכויים', 55, y + 6)
      .text(`₪${_num(totalDed)}`, 50, y + 6, { align: 'right', width: W - 5 });
    doc.fillColor('#000000');
    y += 30;

    // ── נטו לתשלום ────────────────────────────────────────────
    doc.rect(50, y, W, 40).fill('#f0fdf4').stroke('#16a34a');
    doc.fillColor('#15803d').fontSize(14).font('Helvetica-Bold')
      .text('נטו לתשלום', 55, y + 12)
      .text(`₪${_num(d.netSalary)}`, 50, y + 12, { align: 'right', width: W - 5 });
    doc.font('Helvetica').fillColor('#000000');
    y += 55;

    // ── ימי חופשה ומחלה ───────────────────────────────────────
    if (y < 680) {
      _sectionTitle(doc, 'ימי חופשה ומחלה', y);  y += 20;
      const halfW = (W - 10) / 2;

      _smallBox(doc, 50,       y, halfW, 'חופשה', d.vacationDaysUsed, d.vacationDaysAccrued);
      _smallBox(doc, 55 + halfW, y, halfW, 'מחלה',   d.sickDaysUsed,    d.sickDaysAccrued);
      y += 60;
    }

    // ── פוטר ───────────────────────────────────────────────────
    doc.fontSize(8).fillColor('#9ca3af')
      .text('תלוש זה הופק אוטומטית על ידי מערכת House of Business', 50, 770, {
        align: 'center', width: W,
      });

    doc.end();
  });
}

/** שמירה לקובץ ומחזיר נתיב */
async function savePayslipPdf(payslipData, payslipId) {
  const buffer   = await buildPayslipPdf(payslipData);
  const fileName = `payslip_${payslipId}.pdf`;
  ensureUploadsDir();
  const filePath = path.join(UPLOADS_DIR, fileName);
  await fs.promises.writeFile(filePath, buffer);
  return { buffer, filePath, fileName };
}

// ── עזר ─────────────────────────────────────────────────────────

function _sectionTitle(doc, title, y) {
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e40af')
    .text(title, 50, y);
  doc.moveTo(50, y + 14).lineTo(545, y + 14).strokeColor('#dbeafe').stroke();
  doc.font('Helvetica').fillColor('#000000');
}

function _row(doc, x, y, label, value) {
  doc.fontSize(9).fillColor('#6b7280').text(label + ':', x, y, { width: 80 });
  doc.fillColor('#111827').text(String(value), x + 85, y, { width: 150 });
}

function _tableHeader(doc, y, cols) {
  doc.rect(50, y, 495, 20).fill('#1e3a8a');
  const colW = 495 / cols.length;
  cols.forEach((col, i) => {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
      .text(col, 50 + i * colW, y + 5, { width: colW, align: 'center' });
  });
  doc.font('Helvetica').fillColor('#000000');
  return y + 22;
}

function _tableRow(doc, y, cols, bg = null) {
  if (bg) doc.rect(50, y, 495, 18).fill(bg);
  const colW = 495 / cols.length;
  cols.forEach((col, i) => {
    doc.fontSize(9).fillColor('#374151')
      .text(String(col), 50 + i * colW, y + 4, { width: colW, align: 'center' });
  });
  doc.moveTo(50, y + 18).lineTo(545, y + 18).strokeColor('#f3f4f6').stroke();
  return y + 20;
}

function _smallBox(doc, x, y, w, title, used, accrued) {
  doc.rect(x, y, w, 50).fill('#f9fafb').stroke('#e5e7eb');
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151')
    .text(title, x + 8, y + 8);
  doc.fontSize(9).font('Helvetica').fillColor('#6b7280')
    .text(`שימוש: ${_num(used)} ימים`, x + 8, y + 24)
    .text(`צבירה: ${_num(accrued)} ימים`, x + 8, y + 36);
  doc.fillColor('#000000');
}

function _num(n, dec = 2) {
  if (n === null || n === undefined) return '0.00';
  return parseFloat(n).toFixed(dec);
}

module.exports = { buildPayslipPdf, savePayslipPdf };
