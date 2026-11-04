import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', '.harness/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Governed runs need an approved backlog item: the suite gets its own items root (test/setup/items.ts).
    setupFiles: ['test/setup/items.ts'],
  },
});
