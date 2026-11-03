import api from './client';

export const exportApi = {
  employees: () => api.get('/export/employees', { responseType: 'blob' }),
  inventory: () => api.get('/export/inventory', { responseType: 'blob' }),
  invoices:  () => api.get('/export/invoices', { responseType: 'blob' }),
  shifts:    (month?: string) => api.get('/export/shifts', { params: { month }, responseType: 'blob' }),
  finance:   (year?: string, month?: string) => api.get('/export/finance', { params: { year, month }, responseType: 'blob' }),
  pl:        (year: number, month: number) => api.get('/export/pl', { params: { year, month }, responseType: 'blob' }),
  all:       (year: number, month: number) => api.get('/export/all', { params: { year, month }, responseType: 'blob' }),
};
