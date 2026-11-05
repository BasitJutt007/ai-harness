import { defineConfig } from 'vitest/config';

/** The fail-closed mutation audit (test/audit): full checks on mutated copies of a shipped API, too slow for `npm test`. */
export default defineConfig({
  test: {
    include: ['test/audit/**/*.audit.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    maxConcurrency: 4,
    pool: 'forks',
    // Governed runs need an approved backlog item: the suite gets its own items root (test/setup/items.ts).
    setupFiles: ['test/setup/env.ts', 'test/setup/items.ts'],
  },
});
