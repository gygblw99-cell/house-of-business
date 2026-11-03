import api from './client';

export const recipesApi = {
  list:                    () => api.get('/recipes'),
  get:                     (id: string) => api.get(`/recipes/${id}`),
  create:                  (data: object) => api.post('/recipes', data),
  update:                  (id: string, data: object) => api.put(`/recipes/${id}`, data),
  delete:                  (id: string) => api.delete(`/recipes/${id}`),
  setIngredients:          (id: string, ingredients: object[]) =>
    api.put(`/recipes/${id}/ingredients`, { ingredients }),
  analysis:                () => api.get('/recipes/analysis'),
  categories:              () => api.get('/recipes/categories'),
  ingredientsFromInvoices: () => api.get('/inventory'),
  parseIngredientsText:    (text: string) => api.post('/recipes/parse-ingredients-text', { text }),
};

export const dishesApi = {
  list:           () => api.get('/dishes'),
  get:            (id: string) => api.get(`/dishes/${id}`),
  create:         (data: object) => api.post('/dishes', data),
  update:         (id: string, data: object) => api.put(`/dishes/${id}`, data),
  delete:         (id: string) => api.delete(`/dishes/${id}`),
  bulkDelete:     (ids: string[]) => api.post('/dishes/bulk-delete', { ids }),
  listArchived:   () => api.get('/dishes/archived'),
  restore:        (id: string) => api.post(`/dishes/${id}/restore`),
  advise:         (id: string, mode: string, dishContext?: object) => api.post(`/dishes/${id}/advise`, { mode, dishContext }),
  chefChat:       (message: string, history: { role: string; content: string }[]) =>
    api.post('/dishes/chef-chat', { message, history }),
  ingredientCost: (params?: { limit?: number; offset?: number }) =>
    api.get('/dishes/ingredient-cost', { params }),
};

export const extrasApi = {
  list:        () => api.get('/extras'),
  create:      (data: object) => api.post('/extras', data),
  update:      (id: string, data: object) => api.put(`/extras/${id}`, data),
  delete:      (id: string) => api.delete(`/extras/${id}`),
  log:         (id: string, data: { qty: number; notes?: string; logDate?: string }) =>
    api.post(`/extras/${id}/log`, data),
  getLogs:     (id: string, params?: { days?: number }) =>
    api.get(`/extras/${id}/log`, { params }),
  consumption: () => api.get('/extras/consumption'),
};

export const gmailApi = {
  getStatus:       () => api.get('/gmail/status'),
  getAuthUrl:      (returnTo?: string) => api.get('/gmail/auth-url', { params: returnTo ? { returnTo } : undefined }),
  disconnect:      () => api.post('/gmail/disconnect', {}),
  fetchNow:        (days = 14) => api.post('/gmail/fetch-now', { days }),
  importHistory:   (months = 24) => api.post('/gmail/import-history', { months }),
  confirmSubjects: (subjects: string[]) => api.post('/gmail/confirm-subjects', { subjects }),
  resetSubjects:   () => api.post('/gmail/reset-subjects', {}),
  diagnose:        () => api.get('/gmail/diagnose'),
};

// Deliveries' own import-status on the SAME shared Gmail connection as gmailApi above —
// connect/disconnect are reused from gmailApi, only the import scan/history are feature-specific.
export const deliveryGmailApi = {
  getStatus:     () => api.get('/deliveries/gmail-status'),
  fetchNow:      () => api.post('/deliveries/gmail-fetch-now', {}),
  importHistory: (months = 12) => api.post('/deliveries/gmail-import-history', { months }),
};

export const inventoryApi = {
  list:           () => api.get('/inventory'),
  get:            (id: string) => api.get(`/inventory/${id}`),
  create:         (data: object) => api.post('/inventory', data),
  update:         (id: string, data: object) => api.put(`/inventory/${id}`, data),
  delete:         (id: string) => api.delete(`/inventory/${id}`),
  deleteBySupplier: (supplierId: string) => api.delete(`/inventory/by-supplier/${supplierId}`),
  transaction:    (id: string, data: object) => api.post(`/inventory/${id}/transaction`, data),
  value:          () => api.get('/inventory/value'),
  waste:          (params?: object) => api.get('/inventory/waste', { params }),
  categories:     () => api.get('/inventory/categories'),
  createCategory: (data: object) => api.post('/inventory/categories', data),
  bySupplier:         () => api.get('/inventory/by-supplier'),
  expiring:           (days = 3) => api.get('/inventory/expiring', { params: { days } }),
  reorderSuggestions: () => api.get('/inventory/reorder-suggestions'),
  consumptionAnalysis: (dateFrom: string, dateTo: string) =>
    api.get('/inventory/consumption-analysis', { params: { dateFrom, dateTo } }),
  // ספירת מלאי פיזית — הקלט היחיד שאינו נגזר מהמתכונים, ולכן היחיד
  // שמאפשר לזהות דליפה במקום להשוות את חישוב המתכונים לעצמו
  stocktake:      (items: { itemId: string; countedQty: number }[], note?: string) =>
    api.post('/inventory/stocktake', { items, note }),
  stocktakeDates: () => api.get('/inventory/stocktake/dates'),
};
