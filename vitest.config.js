// vitest.config.js — root vitest config
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['server/src/tests/**/*.test.js', 'client/src/**/*.test.js'],
    globalSetup: ['./server/src/tests/globalSetup.js'],
    // Sequentially run to avoid DB contention
    sequence: { concurrent: false },
  },
});

