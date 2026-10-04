import { defineConfig } from 'vitest/config';

/** The fail-closed mutation audit (test/audit): full checks on mutated copies of a shipped API, too slow for `npm test`. */
export default defineConfig({
  test: {
    include: ['test/audit/**/*.audit.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    maxConcurrency: 4,
    pool: 'forks',
  },
});
