const db = require('../utils/db');

const findById = async (id) => {
  const { rows } = await db.query(
    'SELECT id, name, business_type, address, vat_number, email, phone, logo_url, currency, timezone, close_hour, open_days, open_hours, closed_dates, primary_email, onboarding_completed, delivery_fee_pct, wolt_commission_pct, ten_bis_commission_pct, z_report_includes_delivery_platforms, created_at, updated_at FROM businesses WHERE id = $1',
    [id]
  );
  return rows[0] || null;
};

const BUSINESS_UPDATABLE = new Set([
  'name', 'address', 'vat_number', 'phone', 'logo_url',
  'close_hour', 'open_days', 'open_hours', 'closed_dates', 'primary_email',
  'onboarding_completed', 'delivery_fee_pct',
  'wolt_commission_pct', 'ten_bis_commission_pct', 'z_report_includes_delivery_platforms',
]);

// עמודות jsonb — חייבות להגיע למסד כ-string JSON, לא כ-JS object/array
const JSONB_FIELDS = new Set(['open_days', 'open_hours', 'closed_dates']);

const update = async (id, fields) => {
  const filtered = Object.fromEntries(
    Object.entries(fields).filter(([k]) => BUSINESS_UPDATABLE.has(k))
  );

  // serialize jsonb fields — מונע שגיאת 22P02 ללא תלות ב-route
  for (const key of JSONB_FIELDS) {
    if (key in filtered && filtered[key] !== null && typeof filtered[key] !== 'string') {
      filtered[key] = JSON.stringify(filtered[key]);
    }
  }

  const keys   = Object.keys(filtered);
  const values = Object.values(filtered);
  if (!keys.length) throw new Error('No updatable fields provided');
  const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

  const { rows } = await db.query(
    `UPDATE businesses SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, id]
  );
  return rows[0];
};

module.exports = { findById, update };
