/**
 * Shared test helpers — JWT generation + mock factories
 */
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

/**
 * Generate a signed JWT for tests.
 * @param {object} overrides — merge into default owner payload
 */
function makeToken(overrides = {}) {
  const payload = {
    userId:      'user-test-1',
    businessId:  'biz-test-1',
    role:        'owner',
    permissions: {
      dashboard:      true,
      inventory:      true,
      finance:        true,
      employees:      true,
      invoices:       true,
      suppliers:      true,
      deliveries:     true,
      customers:      true,
      recipes:        true,
      tasks:          true,
      messages:       true,
      pos:            true,
      reports:        true,
      ai:             true,
    },
    ...overrides,
  };
  return jwt.sign(payload, SECRET, { expiresIn: '1h' });
}

/** Authenticated request header */
function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/** Generic paginated rows mock */
function mockRows(rows = []) {
  return { rows };
}

/** Single row mock */
function mockRow(row = {}) {
  return { rows: [row] };
}

/** Empty result mock */
function mockEmpty() {
  return { rows: [] };
}

/** Count row mock */
function mockCount(n = 0) {
  return { rows: [{ count: String(n), total: n }] };
}

module.exports = { makeToken, authHeader, mockRows, mockRow, mockEmpty, mockCount };
