import api from './client';

export const authApi = {
  login: (username: string, password: string, totpCode?: string) =>
    api.post('/auth/login', { username, password, ...(totpCode ? { totpCode } : {}) }),
  loginEmployee: (username: string, password: string, totpCode?: string) =>
    api.post('/auth/login/employee', { username, password, ...(totpCode ? { totpCode } : {}) }),
  register: (data: object) => api.post('/auth/register', data),
  me: () => api.get('/auth/me'),
  updateMe: (data: object) => api.put('/auth/me', data),
  logout: () => api.post('/auth/logout'),
  imgToken: () => api.post<{ token: string }>('/auth/img-token'),
  twoFA: {
    status:  ()             => api.get('/auth/2fa/status'),
    setup:   ()             => api.post('/auth/2fa/setup'),
    enable:  (code: string) => api.post('/auth/2fa/enable', { code }),
    disable: (code: string) => api.post('/auth/2fa/disable', { code }),
  },
};

export const businessApi = {
  get:                () => api.get('/business/me'),
  update:             (data: object) => api.put('/business/me', data),
  updateProfile:      (data: object) => api.put('/auth/me', data),
  changePassword:     (data: object) => api.put('/auth/change-password', data),
  users:              () => api.get('/business/users'),
  updatePermissions:  (userId: string, perms: object) => api.put(`/business/users/${userId}/permissions`, perms),
  deactivateUser:     (userId: string) => api.delete(`/business/users/${userId}`),
  completeOnboarding: (data: object) => api.put('/business/onboarding', data),
};
