import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/service/**/*.spec.ts'],
      exclude: ['tests/e2e/**'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);

