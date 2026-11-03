import api from './client';

export const employeesApi = {
  list:        (params?: { activeOnly?: boolean }) => api.get('/employees', { params }),
  create:      (data: object) => api.post('/employees', data),
  update:      (id: string, data: object) => api.put(`/employees/${id}`, data),
  bulkStatus:  (ids: string[], isActive: boolean) => api.put('/employees/bulk-status', { ids, isActive }),
  delete:      (id: string) => api.delete(`/employees/${id}`),
  invite:      (id: string) => api.post(`/employees/${id}/invite`),
  performance: (year: number, month: number) => api.get('/employees/performance', { params: { year, month } }),
  laborAlerts: () => api.get('/employees/labor-alerts'),
};

export const shiftsApi = {
  list:            (params?: object) => api.get('/employees/shifts', { params }),
  create:          (data: object) => api.post('/employees/shifts/plan', data),
  update:          (id: string, data: object) => api.put(`/employees/shifts/${id}`, data),
  delete:          (id: string) => api.delete(`/employees/shifts/${id}`),
  openShifts:      () => api.get('/employees/shifts/active'),
  myActive:        () => api.get('/employees/shifts/my-active'),
  myHistory:       () => api.get('/employees/shifts/my-history'),
  clockIn:         (data: object) => api.post('/employees/shifts/clock-in', data),
  clockOut:        (_shiftId: string, data: object) => api.post('/employees/shifts/clock-out', data),
  salaryPreview:   (params?: object) => api.get('/employees/shifts/salary-preview', { params }),
  openForEmployee: (data: object) => api.post('/employees/shifts/open', data),
  clockInQR:       (token: string) => api.post('/employees/shifts/clock-in-qr', { token }),
  getQR:           () => api.get('/employees/qr'),
  absent:          (data: object) => api.post('/employees/shifts/absent', data),
  monthly:         (id: string, year: number, month: number) =>
    api.get(`/employees/${id}/shifts/monthly`, { params: { year, month } }),
  uploadReport:    (formData: FormData) =>
    api.post('/employees/shifts/upload-report', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

export const shiftPlannerApi = {
  suggestions: () => api.get('/employees/schedule-suggestions'),
};

export const tipsApi = {
  list:           (params?: { month?: number; year?: number }) => api.get('/tips', { params }),
  preview:        (data: object) => api.post('/tips/preview', data),
  create:         (data: object) => api.post('/tips', data),
  delete:         (id: string)   => api.delete(`/tips/${id}`),
  monthlySummary: (month: number, year: number) => api.get('/tips/monthly-summary', { params: { month, year } }),
  poolStatus:     () => api.get('/tips/pool-status'),
  poolSetup:      (employeeIds: string[]) => api.post('/tips/pool-setup', { employeeIds }),
};
