import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    include: ['server/src/tests/authRegistration.offline.test.js'],
  },
});
