import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/scenarios/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // Real-claude scenarios (1d, 2a1, 2a2) race on ~/.claude.json trust
    // injection under parallel file execution — Windows `rename` isn't atomic
    // under contention. Force sequential file execution so only one spawn
    // touches the trust file at a time.
    fileParallelism: false,
  },
});
