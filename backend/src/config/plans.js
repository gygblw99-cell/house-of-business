/**
 * Shared plan definitions — single source of truth for billing.routes.js
 * and scripts/charge_recurring.js. Changing a price here updates both.
 */
const PLANS = {
  starter:    { name: 'Starter',    price: 299  },
  pro:        { name: 'Pro',        price: 599  },
  enterprise: { name: 'Enterprise', price: 1199 },
};

module.exports = { PLANS };
