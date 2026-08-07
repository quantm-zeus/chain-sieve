import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  MUSE_ARGS_ENV,
  MUSE_PERMISSION_ENV,
} from '../../tools/agent/providers/muse.js';
import {
  assertAutopilotDoctor,
  runAutopilotDoctor,
} from '../../tools/autopilot/doctor.js';

const roots: string[] = [];
const previousArgs = process.env[MUSE_ARGS_ENV];
const previousPermission = process.env[MUSE_PERMISSION_ENV];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (previousArgs === undefined) delete process.env[MUSE_ARGS_ENV];
  else process.env[MUSE_ARGS_ENV] = previousArgs;
  if (previousPermission === undefined) delete process.env[MUSE_PERMISSION_ENV];
  else process.env[MUSE_PERMISSION_ENV] = previousPermission;
});

const rootWithPolicy = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'chainsieve-muse-doctor-'));
  roots.push(root);
  await mkdir(join(root, 'config'));
  await writeFile(
    join(root, 'config', 'autonomy-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        mode: 'FULL_AUTONOMY',
        humanReviewRequired: false,
        humanApprovalRequired: false,
        automatedIndependentReviewRequired: true,
        deterministicVerificationRequired: true,
        allowAutonomousSpecificationResolution: true,
        allowAutonomousCiRepair: true,
        allowAutonomousMerge: true,
        safeDefaults: {
          liveTradingEnabled: false,
          externalWriteCapabilitiesEnabled: false,
          secretMaterializationEnabled: false,
          irreversibleMigrationsEnabled: false,
        },
        limits: {
          taskCorrectionRounds: 3,
          clusterCiCorrectionRounds: 5,
          infrastructureRetryRounds: 3,
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
};

class Runner implements CommandRunner {
  run(command: string, args: string[], options?: CommandOptions) {
    void options;
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git branch --show-current')
      return { status: 0, stdout: 'main\n', stderr: '' };
    if (key === 'git status --porcelain=v1')
      return { status: 0, stdout: '', stderr: '' };
    if (key === 'node --version')
      return { status: 0, stdout: 'v22.23.1\n', stderr: '' };
    if (key === 'pnpm --version')
      return { status: 0, stdout: '10.13.1\n', stderr: '' };
    if (key === 'muse --version')
      return { status: 0, stdout: 'muse-code beta\n', stderr: '' };
    if (key === 'muse --help')
      return { status: 0, stdout: 'Muse Code help\n', stderr: '' };
    if (key === 'gh api repos/{owner}/{repo} --jq .permissions.push')
      return { status: 0, stdout: 'true\n', stderr: '' };
    return { status: 0, stdout: 'ok\n', stderr: '' };
  }
}

describe('Muse Code autopilot doctor', () => {
  it('passes only after headless launch and permissions are configured once', async () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const root = await rootWithPolicy();
    const checks = await runAutopilotDoctor(root, new Runner(), 'muse');
    expect(checks.find((check) => check.name === 'muse-code-cli')?.status).toBe(
      'PASS',
    );
    expect(
      checks.find((check) => check.name === 'muse-headless-launch')?.status,
    ).toBe('PASS');
    expect(checks.find((check) => check.name === 'muse-permissions')?.status).toBe(
      'PASS',
    );
    await expect(
      assertAutopilotDoctor(root, new Runner(), 'muse'),
    ).resolves.toEqual(checks);
  });

  it('fails before work starts when permission preapproval is absent', async () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    delete process.env[MUSE_PERMISSION_ENV];
    const root = await rootWithPolicy();
    await expect(assertAutopilotDoctor(root, new Runner(), 'muse')).rejects.toThrow(
      'AUTOPILOT_DOCTOR_FAILED:muse-permissions',
    );
  });
});
