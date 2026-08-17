import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@ciag/agent-runtime': resolve(__dirname, 'packages/agent-runtime/src/index.ts'),
      '@ciag/alerts': resolve(__dirname, 'packages/alerts/src/index.ts'),
      '@ciag/capability-registry': resolve(__dirname, 'packages/capability-registry/src/index.ts'),
      '@ciag/collector-core': resolve(__dirname, 'packages/collector-core/src/index.ts'),
      '@ciag/collector-solana': resolve(__dirname, 'packages/collector-solana/src/index.ts'),
      '@ciag/config': resolve(__dirname, 'packages/config/src/index.ts'),
      '@ciag/domain': resolve(__dirname, 'packages/domain/src/index.ts'),
      '@ciag/evaluation': resolve(__dirname, 'packages/evaluation/src/index.ts'),
      '@ciag/evidence': resolve(__dirname, 'packages/evidence/src/index.ts'),
      '@ciag/mcp-adapter': resolve(__dirname, 'packages/mcp-adapter/src/index.ts'),
      '@ciag/object-store': resolve(__dirname, 'packages/object-store/src/index.ts'),
      '@ciag/observability': resolve(__dirname, 'packages/observability/src/index.ts'),
      '@ciag/persistence': resolve(__dirname, 'packages/persistence/src/index.ts'),
      '@ciag/program-decoders': resolve(__dirname, 'packages/program-decoders/src/index.ts'),
      '@ciag/provider-contracts': resolve(__dirname, 'packages/provider-contracts/src/index.ts'),
      '@ciag/runtime-cache': resolve(__dirname, 'packages/runtime-cache/src/index.ts'),
      '@ciag/scheduler': resolve(__dirname, 'packages/scheduler/src/index.ts'),
      '@ciag/security': resolve(__dirname, 'packages/security/src/index.ts'),
      '@ciag/shared-schemas': resolve(__dirname, 'packages/shared-schemas/src/index.ts'),
      '@ciag/test-fixtures': resolve(__dirname, 'packages/test-fixtures/src/index.ts'),
      '@ciag/tool-core': resolve(__dirname, 'packages/tool-core/src/index.ts'),
      '@ciag/workflow-runtime': resolve(__dirname, 'packages/workflow-runtime/src/index.ts'),
      '@ciag/signal-intelligence': resolve(__dirname, 'packages/signal-intelligence/src/index.ts'),
      '@ciag/pool-adapter': resolve(__dirname, 'packages/pool-adapter/src/index.ts'),
    },
  },
  test: {
    include: ['tests/service/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});


