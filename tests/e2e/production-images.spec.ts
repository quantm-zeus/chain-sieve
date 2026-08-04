import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const read = (path: string): Promise<string> => readFile(path, 'utf8');

test('production image definitions preserve the bounded runtime contract', async () => {
  const [api, dashboard, compose, ignore, workflow] = await Promise.all([
    read('apps/api/Dockerfile'),
    read('apps/dashboard/Dockerfile'),
    read('docker-compose.production.yml'),
    read('.dockerignore'),
    read('.github/workflows/ci.yml'),
  ]);

  for (const [dockerfile, port] of [[api, '3000'], [dashboard, '3001']] as const) {
    expect(dockerfile.match(/^FROM node:22-alpine/gm)).toHaveLength(2);
    const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
    expect(runtime).toContain('USER node');
    expect(runtime).toContain(`EXPOSE ${port}`);
    expect(runtime).toContain('HEALTHCHECK');
    expect(runtime).not.toContain('pnpm install');
    expect(runtime).not.toContain('node_modules');
    expect(runtime).not.toContain('playwright');
    expect(runtime).not.toContain('chromium');
  }

  expect(compose).toContain('read_only: true');
  expect(compose).toContain('tmpfs:');
  expect(ignore).toContain('test-data');
  expect(ignore).toContain('playwright-report');
  expect(workflow).toContain('--platform linux/amd64');
  expect(workflow).not.toContain('linux/arm64');
  expect(workflow).not.toContain('docker/setup-qemu-action');
  expect(workflow).toContain('--file "apps/${{ matrix.service }}/Dockerfile"');
});
