import api from './client';
import type { Supplier } from '@/types';

// תואם ל-backend/src/utils/apiResponse.js:paginated() — שינוי כאן חייב להתעדכן שם וגם ב-Supplier[] בשרת
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export const suppliersApi = {
  list:         () => api.get<PaginatedResponse<Supplier>>('/suppliers'),
  get:          (id: string) => api.get(`/suppliers/${id}`),
  create:       (data: object) => api.post('/suppliers', data),
  update:       (id: string, data: object) => api.put(`/suppliers/${id}`, data),
  delete:       (id: string) => api.delete(`/suppliers/${id}`),  sendOrder:    (id: string, data: object) => api.post(`/suppliers/orders/daily/${id}/confirm`, data),
  dailyOrders:  () => api.get('/suppliers/orders/daily'),
  pendingOrders:() => api.get('/suppliers/orders/pending'),
  updateOrder:  (id: string, data: object) => api.put(`/suppliers/orders/${id}`, data),
  sendOrder2:   (id: string) => api.post(`/suppliers/orders/${id}/send`),
  markOrderSent: (orderId: string) => api.put(`/suppliers/orders/${orderId}/mark-sent`),
};

export const invoicesApi = {
  list:           (params?: object) => api.get('/invoices', { params }),
  aiSearch:       (query: string) => api.post('/invoices/ai-search', { query }),
  get:            (id: string) => api.get(`/invoices/${id}`),
  upload:         (formData: FormData) =>
    api.post('/invoices/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 90_000 }),
  approve:        (id: string, data: object) => api.put(`/invoices/${id}/approve`, data),
  reject:         (id: string) => api.put(`/invoices/${id}/reject`),
  markPaid:       (id: string) => api.put(`/invoices/${id}/mark-paid`),
  partialPayment: (id: string, amount: number) => api.put(`/invoices/${id}/partial-payment`, { amount }),
  delete:         (id: string) => api.delete(`/invoices/${id}`),
  stats:          () => api.get('/invoices/stats'),
  supplierTrends: () => api.get('/invoices/supplier-trends'),
  confirmMerge:   (tempFiles: string[], merge: boolean) =>
    api.post('/invoices/upload/confirm-merge', { tempFiles, merge }),
  syncInventoryPreview: () => api.post('/invoices/sync-inventory/preview'),
  syncInventory:  (mappings: object[]) => api.post('/invoices/sync-inventory', { mappings }),
  syncInventoryAuto: () => api.post('/invoices/sync-inventory/auto'),
};

export const supplierLedgerApi = {
  list:           () => api.get('/supplier-ledger'),
  get:            (supplierId: string) => api.get(`/supplier-ledger/${supplierId}`),
  addPayment:     (supplierId: string, data: object) => api.post(`/supplier-ledger/${supplierId}/payment`, data),
  deletePayment:  (paymentId: string) => api.delete(`/supplier-ledger/payment/${paymentId}`),
};

export const priceComparisonApi = {
  list:           () => api.get('/price-comparison'),
  get:            (id: string) => api.get(`/price-comparison/${id}`),
  create:         (data: object) => api.post('/price-comparison', data),
  searchPrices:   (data: { searchQuery: string }) => api.post('/price-comparison/search-prices', data),
  extractEmail:   (data: { url: string }) => api.post('/price-comparison/extract-email', data),
  findSuppliers:  (data: { searchQuery: string }) => api.post('/price-comparison/ai-find-suppliers', data),
  updateResult:   (id: string, data: object) => api.put(`/price-comparison/${id}/result`, data),
  updateOutreach: (id: string, outreachId: string, data: object) =>
    api.put(`/price-comparison/${id}/outreach/${outreachId}`, data),
  delete:         (id: string) => api.delete(`/price-comparison/${id}`),
  // Task 7: Price alerts
  getAlerts:      () => api.get('/price-comparison/alerts'),
  createAlert:    (data: object) => api.post('/price-comparison/alerts', data),
  deleteAlert:    (id: string) => api.delete(`/price-comparison/alerts/${id}`),
  toggleAlert:    (id: string, isActive: boolean) => api.patch(`/price-comparison/alerts/${id}`, { isActive }),
  // Task 9: Excel export
  exportXlsx:     () => api.get('/price-comparison/export', { responseType: 'blob' }),
};
