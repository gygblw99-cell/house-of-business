import api from './client';

export const posApi = {
  status:              () => api.get('/pos/status'),
  connect:             (data: object) => api.post('/pos/connect', data),
  sync:                () => api.post('/pos/sync'),
  disconnect:          () => api.delete('/pos/disconnect'),
  sales:               (params?: object) => api.get('/pos/sales', { params }),
  import:              (formData: FormData) =>
    api.post('/pos/import', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  importZReport:       (formData: FormData) =>
    api.post('/zreport/import', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  zreportEmployees:    () => api.get('/zreport/employees'),
  zreportSyncEmployees:() => api.post('/zreport/sync-employees'),
  zreportSummary:      () => api.get('/zreport/summary'),
  // email-config (per-business Z-report auto-fetch)
  getEmailConfig:      () => api.get('/zreport/email-config'),
  saveEmailConfig:     (data: object) => api.post('/zreport/email-config', data),
  deleteEmailConfig:   () => api.delete('/zreport/email-config'),
  testEmailConfig:     (data: object) => api.post('/zreport/email-config/test', data),
  fetchEmailNow:       () => api.post('/zreport/email-config/fetch'),
};

export const deliveriesApi = {
  import:       (rows: object[]) => api.post('/deliveries/import', { rows }),
  today:        () => api.get('/deliveries/today'),
  history:      (from: string, to: string) => api.get('/deliveries/history', { params: { from, to } }),
  add:          (data: { platform: string; amount: number; notes?: string }) => api.post('/deliveries', data),
  updateStatus: (id: string, status: string) => api.patch(`/deliveries/${id}/status`, { status }),
  uploadFile:   (file: File, platform: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('platform', platform);
    return api.post('/deliveries/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  getEmailConfig:    () => api.get('/deliveries/email-config'),
  saveEmailConfig:   (data: object) => api.post('/deliveries/email-config', data),
  deleteEmailConfig: () => api.delete('/deliveries/email-config'),
  testEmailConfig:   (data: object) => api.post('/deliveries/email-config/test', data),
  fetchEmail:        (daysBack?: number) => api.post('/deliveries/email-fetch', { daysBack }),
};

export const tablesApi = {
  list:  () => api.get('/dashboard/tables'),
  open:  (data: { tableNumber: number; amount?: number }) => api.post('/dashboard/tables', data),
  close: (id: string, finalAmount?: number) => api.put(`/dashboard/tables/${id}/close`, { finalAmount }),
};

export const calendarApi = {
  smartInsights: () => api.get('/calendar/smart-insights'),
};

export const queueApi = {
  list:    () => api.get('/queue'),
  history: () => api.get('/queue/history'),
  add:     (data: object) => api.post('/queue', data),
  ready:   (id: string) => api.put(`/queue/${id}/ready`),
  seated:  (id: string) => api.put(`/queue/${id}/seated`),
  cancel:  (id: string) => api.delete(`/queue/${id}`),
  joinInfo:(businessId: string) => api.get(`/queue/join/${businessId}`),
  join:    (businessId: string, data: object) => api.post(`/queue/join/${businessId}`, data),
};
