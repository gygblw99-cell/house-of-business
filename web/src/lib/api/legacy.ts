import api from './client';

// Kept for any lingering references — feature was removed from UI
export const dynamicPricingApi = {
  suggestions: () => api.get('/dishes/dynamic-pricing'),
};
