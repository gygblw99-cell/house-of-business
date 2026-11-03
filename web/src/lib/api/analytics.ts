import api from './client';

export const dashboardApi = {
  get:                () => api.get('/dashboard'),
  profitLeaks:        () => api.get('/dashboard/profit-leaks'),
  ingredientLeakage:  (days = 7) => api.get('/dashboard/ingredient-leakage', { params: { days } }),
  menuEngineering:    (days = 30) => api.get('/dashboard/menu-engineering', { params: { days } }),
  priceElasticity:    () => api.get('/dashboard/price-elasticity'),
  foodCostMonthly:    () => api.get('/dashboard/food-cost-monthly'),
  survivalMode:       (days = 30) => api.get('/dashboard/survival-mode', { params: { days } }),
  dailySummary:       () => api.get('/dashboard/daily-summary'),
};

export const auditApi = {
  run:     (params?: { fromDate?: string; toDate?: string }) => api.post('/audit/run', params || {}, { timeout: 150_000 }),
  latest:  () => api.get('/audit/latest'),
  history: () => api.get('/audit/history'),
  score:   () => api.get('/audit/score'),
};

export const activityApi = {
  list:    (params?: object) => api.get('/activity', { params }),
  actions: () => api.get('/activity/actions'),
};

export const insightsApi = {
  list:       () => api.get('/insights'),
  generate:   () => api.post('/insights/generate'),
  markRead:   (id: string) => api.put(`/insights/${id}/read`),
  markAllRead:() => api.put('/insights/read-all'),
};

export const customersApi = {
  list:        (params?: { search?: string; sort?: string; limit?: number }) => api.get('/customers', { params }),
  stats:       () => api.get('/customers/stats'),
  leaderboard: () => api.get('/customers/leaderboard'),
  lookup:      (phone: string) => api.get('/customers/lookup', { params: { phone } }),
  get:         (id: string) => api.get(`/customers/${id}`),
  create:      (data: object) => api.post('/customers', data),
  update:      (id: string, data: object) => api.put(`/customers/${id}`, data),
  visit:       (id: string, data: { amount?: number; note?: string }) => api.post(`/customers/${id}/visit`, data),
  remove:      (id: string) => api.delete(`/customers/${id}`),
  getSettings: () => api.get('/customers/settings'),
  saveSettings:(data: object) => api.put('/customers/settings', data),
};

export const weeklyTasksApi = {
  list:   () => api.get('/dashboard/weekly-tasks'),
  create: (text: string) => api.post('/dashboard/weekly-tasks', { text }),
  toggle: (id: string, done: boolean) => api.put(`/dashboard/weekly-tasks/${id}`, { done }),
  delete: (id: string) => api.delete(`/dashboard/weekly-tasks/${id}`),
};

export interface ForecastSettings {
  staffRatio: number;
  minStaff: number;
  cogsBreakdown: { meat: number; fish: number; produce: number; dairy: number; dry: number; beverages: number };
  customEvents: { date: string; label: string; multiplier: number }[];
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {
  staffRatio: 25,
  minStaff: 2,
  cogsBreakdown: { meat: 36, fish: 14, produce: 21, dairy: 12, dry: 0, beverages: 17 },
  customEvents: [],
};

export const forecastApi = {
  demand: (days = 14, settings?: ForecastSettings, axiosConfig?: { signal?: AbortSignal }) =>
    api.post('/forecast/demand', {
      days,
      staffRatio:    settings?.staffRatio,
      minStaff:      settings?.minStaff,
      cogsBreakdown: settings?.cogsBreakdown,
      customEvents:  settings?.customEvents,
    }, axiosConfig),
  smartOrder: (horizon = 7) => api.get('/forecast/smart-order', { params: { horizon } }),
  getSettings: () => api.get('/forecast/settings'),
  saveSettings: (data: Partial<ForecastSettings>) => api.put('/forecast/settings', data),
};

export const fraudApi = {
  alerts: (days = 30) => api.get('/fraud/alerts', { params: { days } }),
};
