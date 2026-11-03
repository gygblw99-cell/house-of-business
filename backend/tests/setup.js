// משתני סביבה לבדיקות
process.env.NODE_ENV        = 'test';
process.env.JWT_SECRET      = 'test-secret-key-for-jest-tests-minimum-32-chars';
process.env.DATABASE_URL    = 'postgresql://test:test@localhost:5432/hob_test';
process.env.ANTHROPIC_API_KEY = 'test-key';

// דיכוי console.error בבדיקות
jest.spyOn(console, 'error').mockImplementation(() => {});
