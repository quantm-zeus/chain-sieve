import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**', 'tests/service/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
