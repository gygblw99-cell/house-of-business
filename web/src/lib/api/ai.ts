import api from './client';

// Backend allows up to 55s for these (AI_TIMEOUT_MS in ai.routes.js) — the
// client timeout must exceed that or a genuinely-slow-but-successful AI
// response gets killed client-side before the backend's own timeout fires.
const AI_CLIENT_TIMEOUT_MS = 60_000;

export const aiApi = {
  chat:         (message: string, isOffline?: boolean) => api.post('/ai/chat', { message, isOffline }, { timeout: AI_CLIENT_TIMEOUT_MS }),
  history:      () => api.get('/ai/history'),
  clearHistory: () => api.delete('/ai/history'),
  marketing:    (action: string, context?: { extra?: string }) => api.post('/ai/marketing', { action, ...context }, { timeout: AI_CLIENT_TIMEOUT_MS }),
};
