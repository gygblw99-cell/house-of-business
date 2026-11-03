const nextJest = require('next/jest');

const createJestConfig = nextJest({
  // Path to the Next.js app — loads next.config.js and .env files
  dir: './',
});

const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/'],
  // .next/standalone/package.json duplicates the root package.json's "name"
  // field, which trips jest-haste-map's naming-collision warning — exclude
  // the whole build output from module resolution, not just test discovery.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
};

// next/jest returns an async function that merges in Next's own SWC-based
// transform config — must be exported as-is, not wrapped further.
module.exports = createJestConfig(customJestConfig);
