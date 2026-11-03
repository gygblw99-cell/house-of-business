const crypto = require('crypto');
const db = require('../utils/db');
const logger = require('../utils/logger');

// POS provider API keys used to be stored in plaintext, unlike this
// codebase's established pattern for equivalent secrets (e.g.
// zreport.emailConfig.service.js encrypts the IMAP app password the same
// way) — any DB-level exposure (backup leak, read replica, direct SELECT)
// would hand over live Bikoum/Aviv API keys for every connected business.
const ALGO = 'aes-256-cbc';

function _key() {
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'fallback-key').digest();
}

function encrypt(text) {
  if (!text) return text;
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  if (!data) return data;
  try {
    const [ivHex, encHex] = data.split(':');
    if (!ivHex || !encHex) return data; // pre-encryption plaintext row — return as-is
    const d = crypto.createDecipheriv(ALGO, _key(), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
  } catch (err) {
    logger.warn('[POS] api_key decryption failed — JWT_SECRET may have changed', { err: err.message });
    return null;
  }
}

const findByBusiness = async (businessId) => {
  const { rows } = await db.query(
    'SELECT id, business_id, provider, api_key, api_url, is_connected, last_sync_at, connected_at, created_at FROM pos_connections WHERE business_id = $1',
    [businessId]
  );
  if (!rows[0]) return null;
  return { ...rows[0], api_key: decrypt(rows[0].api_key) };
};

const upsert = async (businessId, { provider, apiKey, apiUrl }) => {
  const encryptedKey = encrypt(apiKey);
  const { rows } = await db.query(
    `INSERT INTO pos_connections (business_id, provider, api_key, api_url, is_connected, connected_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW())
     ON CONFLICT (business_id)
     DO UPDATE SET provider = $2, api_key = $3, api_url = $4,
                   is_connected = TRUE, connected_at = NOW()
     RETURNING *`,
    [businessId, provider, encryptedKey, apiUrl]
  );
  return { ...rows[0], api_key: apiKey };
};

const setDisconnected = async (businessId) => {
  await db.query(
    'UPDATE pos_connections SET is_connected = FALSE WHERE business_id = $1',
    [businessId]
  );
};

const updateLastSync = async (businessId) => {
  await db.query(
    'UPDATE pos_connections SET last_sync_at = NOW() WHERE business_id = $1',
    [businessId]
  );
};

module.exports = { findByBusiness, upsert, setDisconnected, updateLastSync };
