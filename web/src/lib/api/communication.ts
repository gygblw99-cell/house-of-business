import api from './client';

export const messagesApi = {
  list:        () => api.get('/messages'),
  history:     () => api.get('/messages/history'),
  unreadCount: () => api.get('/messages/unread-count'),
  send:        (data: object) => api.post('/messages', data),
  markRead:    (id: string) => api.put(`/messages/${id}/read`),
  delete:      (id: string) => api.delete(`/messages/${id}`),
};

export const remindersApi = {
  list:         () => api.get('/reminders'),
  history:      () => api.get('/reminders/history'),
  create:       (data: object) => api.post('/reminders', data),
  update:       (id: string, data: object) => api.put(`/reminders/${id}`, data),
  delete:       (id: string) => api.delete(`/reminders/${id}`),
  smartSuggest: () => api.get('/reminders/smart-suggest'),
};

export const notificationsApi = {
  list:        () => api.get('/notifications'),
  unreadCount: () => api.get('/notifications/unread-count'),
  markRead:    (id: string) => api.put(`/notifications/${id}/read`),
  markAllRead: () => api.put('/notifications/read-all'),
  delete:      (id: string) => api.delete(`/notifications/${id}`),
};

export const reviewsApi = {
  list:                () => api.get('/reviews'),
  analyze:             (platform: string, text: string) => api.post('/reviews/analyze', { platform, text }),
  delete:              (id: string) => api.delete(`/reviews/${id}`),
  createTasksFromBatch: (batchId: string) => api.post(`/reviews/batch/${batchId}/create-tasks`),
};

export const tasksApi = {
  list:            () => api.get('/tasks'),
  aiSuggest:       () => api.get('/tasks/ai-suggest'),
  create:          (data: object) => api.post('/tasks', data),
  update:          (id: string, data: object) => api.put(`/tasks/${id}`, data),
  delete:          (id: string) => api.delete(`/tasks/${id}`),
  addSubtask:      (taskId: string, title: string) => api.post(`/tasks/${taskId}/subtasks`, { title }),
  deleteSubtask:   (taskId: string, subId: string) => api.delete(`/tasks/${taskId}/subtasks/${subId}`),
  completeSubtask: (taskId: string, subId: string, photo: File) => {
    const form = new FormData();
    form.append('photo', photo);
    return api.post(`/tasks/${taskId}/subtasks/${subId}/complete`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  completeTask: (taskId: string, photo: File) => {
    const form = new FormData();
    form.append('photo', photo);
    return api.post(`/tasks/${taskId}/complete`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  approve: (taskId: string) => api.post(`/tasks/${taskId}/approve`),
  history: () => api.get('/tasks?history=1'),
};
