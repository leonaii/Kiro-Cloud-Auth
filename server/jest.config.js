export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'claude-compat/**/*.js',
    '!claude-compat/__tests__/**',
    '!claude-compat/index.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
  testTimeout: 10000,
  moduleFileExtensions: ['js', 'json'],
  clearMocks: true,
  resetMocks: true
};
