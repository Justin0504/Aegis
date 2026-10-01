/** ts-jest over src/. The package had no test runner wired; provenance is
 *  the first thing in it whose behaviour is a claim, so it gets one. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
};
