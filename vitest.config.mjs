import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/unit/**/*.test.js'],
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers: 4,
  },
});
