import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: [
    { command: 'API_PORT=33003 DATABASE_URL=postgres://ciag:unavailable@127.0.0.1:65432/ciag OBJECT_STORE_ROOT=.local/e2e-object-store pnpm --filter @ciag/api start', port: 33003, reuseExistingServer: true },
    { command: 'PUBLIC_API_BASE_URL=http://127.0.0.1:33003 pnpm --filter @ciag/dashboard preview --host 127.0.0.1', port: 4173, reuseExistingServer: true }
  ]
});
