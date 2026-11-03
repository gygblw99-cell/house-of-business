// מחזיר תאריך YYYY-MM-DD בשעון ירושלים (לא UTC) — שימוש בכל מקום שצריך "היום"
// לצרכים עסקיים, כדי למנוע יום שגוי בין 00:00-03:00 שעון ישראל (UTC מפגר 2-3 שעות).
// sv-SE locale is guaranteed by the ECMA-262 spec to produce YYYY-MM-DD on all ICU builds.
function todayIL() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
}

module.exports = { todayIL };
