import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts'
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    // Most suites here hit real shared infrastructure (a single Postgres container, the real
    // Docker daemon) rather than mocks — running test files in parallel caused transient
    // connection-pool/resource contention (a passing-in-isolation test intermittently 500'd when
    // several Docker-heavy files ran concurrently). Sequential execution trades some wall-clock
    // time for determinism, which matters more here.
    fileParallelism: false
  }
});
