'use strict';

function parseIntRange(val, min, max, defaultVal) {
  const n = parseInt(val);
  if (isNaN(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

module.exports = { parseIntRange };
