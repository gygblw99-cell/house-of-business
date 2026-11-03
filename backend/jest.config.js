module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/tests/**/*.test.js'],
  collectCoverage: false,
  setupFiles:      ['<rootDir>/tests/setup.js'],
  // Closes the pg.Pool each suite opened — see tests/afterEnv.js. Must be
  // setupFilesAfterEnv, not setupFiles: afterAll does not exist in the latter.
  setupFilesAfterEnv: ['<rootDir>/tests/afterEnv.js'],
};
