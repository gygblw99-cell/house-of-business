const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET missing or too short — set a random 64+ char secret in .env');
}

const sign = (payload, expiresIn = EXPIRES_IN) => jwt.sign(payload, SECRET, { expiresIn });

const verify = (token) => jwt.verify(token, SECRET, { algorithms: ['HS256'] });

module.exports = { sign, verify };
