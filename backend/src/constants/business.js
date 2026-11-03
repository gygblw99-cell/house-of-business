'use strict';

const PRICE_CHANGE_THRESHOLD = 0.10; // 10% variance triggers price alert
const VAT_RATE = 0.18;               // Israeli VAT rate (18% since 2025)

const CACHE_TTL = {
  SHORT:    120,  // 2 min — frequently updated data (salary calc, drafts)
  MEDIUM:   300,  // 5 min — business context, insights, AI analyses
  LONG:     600,  // 10 min — forecast, analytics
  EXTENDED: 900,  // 15 min — expensive or rarely-changing analyses
};

module.exports = { PRICE_CHANGE_THRESHOLD, VAT_RATE, CACHE_TTL };
