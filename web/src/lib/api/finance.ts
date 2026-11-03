import api from './client';

export const financeApi = {
  daily:          (date?: string) => api.get('/finance/daily', { params: { date } }),
  cashflow:       (params?: object) => api.get('/finance/cashflow', { params }),
  forecast:       () => api.get('/finance/forecast'),
  monthly:        (params?: object) => api.get('/finance/monthly', { params }),
  expenses:       () => api.get('/finance/expenses'),
  createExpense:  (data: object) => api.post('/finance/expenses', data),
  updateExpense:  (id: string, data: object) => api.put(`/finance/expenses/${id}`, data),
  deleteExpense:  (id: string) => api.delete(`/finance/expenses/${id}`),
  income:         (year?: number, month?: number) => api.get('/finance/income', { params: { year, month } }),
  createIncome:   (data: object) => api.post('/finance/income', data),
  deleteIncome:   (id: string) => api.delete(`/finance/income/${id}`),
  dailyBreakdown: (year: number, month: number) =>
    api.get('/finance/daily-breakdown', { params: { year, month } }),
  forecast90: () => api.get('/finance/forecast90'),
  plStreams:   (months?: number) => api.get('/finance/pl-streams', { params: { months } }),
  sendReport:  (to: string, year: number, month: number) =>
    api.post('/finance/send-report', { to, year, month }),
};

export const vatApi = {
  report: (params: { year: number; month: number; period?: 1 | 2 }) =>
    api.get('/finance/vat', { params }),
  // The handoff to whoever actually files the return. The finance tab's
  // "download" button used to call window.print().
  exportExcel: (params: { year: number; month: number; period?: 1 | 2 }) =>
    api.get('/export/vat', { params, responseType: 'blob' }),
};

