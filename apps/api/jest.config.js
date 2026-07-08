module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*(\\.e2e-spec|create-memory-admin-repository\\.single-instance\\.spec)\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  }
};
