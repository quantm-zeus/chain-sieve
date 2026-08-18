import { defineConfig } from 'vitest/config';
import { packageAliases } from './vitest.config.ts';

export default defineConfig({
  resolve: {
    alias: packageAliases,
  },
  test: {
    include: ['tests/service/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});



