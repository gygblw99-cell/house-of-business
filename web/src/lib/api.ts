// Barrel re-export — all API clients now live in ./api/ domain files.
// All existing imports from '@/lib/api' continue to work unchanged.
export { default } from './api/client';
export * from './api/auth';
export * from './api/employees';
export * from './api/finance';
export * from './api/operations';
export * from './api/suppliers';
export * from './api/content';
export * from './api/communication';
export * from './api/analytics';
export * from './api/ai';
export * from './api/export';
export * from './api/legacy';
