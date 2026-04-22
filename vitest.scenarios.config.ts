import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/scenarios/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
