'use strict';

const MODEL = {
  HAIKU:  'claude-haiku-4-5',
  SONNET: 'claude-sonnet-5',
};

const DAILY_LIMITS = {
  owner:    100,
  partner:  100,
  manager:   50,
  employee:  20,
  default:   10,
};

module.exports = { MODEL, DAILY_LIMITS };
