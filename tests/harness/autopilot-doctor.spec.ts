import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  assertAutopilotDoctor,
  runAutopilotDoctor,
} from '../../tools/autopilot/doctor.js';
import { loadAutonomyPolicy } from '../../tools/autopilot/policy.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const policy = {
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
};

const rootWithPolicy = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'chainsieve-doctor-'));
  roots.push(root);
  await mkdir(join(root, 'config'));
  await writeFile(
    join(root, 'config', 'autonomy-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  return root;
};

class DoctorRunner implements CommandRunner {
  constructor(private readonly fail = '') {}

  run(command: string, args: string[], _options: CommandOptions = {}) {
    const key = `${command} ${args.join(' ')}`;
    if (this.fail && key.includes(this.fail))
      return { status: 1, stdout: '', stderr: 'denied' };
    if (key === 'git branch --show-current')
      return { status: 0, stdout: 'main\n', stderr: '' };
    if (key === 'git status --porcelain=v1')
      return { status: 0, stdout: '', stderr: '' };
    if (key === 'node --version')
      return { status: 0, stdout: 'v22.23.1\n', stderr: '' };
    if (key === 'pnpm --version')
      return { status: 0, stdout: '10.13.1\n', stderr: '' };
    if (key === 'agy --help')
      return {
        status: 0,
        stdout: '--model MODEL --mode MODE --cwd PATH -p PROMPT\n',
        stderr: '',
      };
    if (key === 'codex exec --help')
      return {
        status: 0,
        stdout: '--cd PATH --sandbox MODE\n',
        stderr: '',
      };
    if (key === 'gh api repos/{owner}/{repo} --jq .permissions.push')
      return { status: 0, stdout: 'true\n', stderr: '' };
    return { status: 0, stdout: 'ok\n', stderr: '' };
  }
}

describe('autopilot full autonomy doctor', () => {
  it('loads the owner full-autonomy policy', async () => {
    const root = await rootWithPolicy();
    await expect(loadAutonomyPolicy(root)).resolves.toMatchObject({
      mode: 'FULL_AUTONOMY',
      humanReviewRequired: false,
      humanApprovalRequired: false,
      automatedIndependentReviewRequired: true,
    });
  });

  it('passes only when local Antigravity and GitHub prerequisites are available', async () => {
    const root = await rootWithPolicy();
    const checks = await runAutopilotDoctor(
      root,
      new DoctorRunner(),
      'antigravity',
    );
    expect(checks).toHaveLength(12);
    expect(checks.every((check) => check.status === 'PASS')).toBe(true);
    await expect(
      assertAutopilotDoctor(root, new DoctorRunner(), 'antigravity'),
    ).resolves.toHaveLength(12);
  });

  it('checks the selected provider instead of requiring Antigravity', async () => {
    const root = await rootWithPolicy();
    const checks = await runAutopilotDoctor(root, new DoctorRunner(), 'codex');
    expect(checks.find((check) => check.name === 'codex-cli')?.status).toBe(
      'PASS',
    );
    expect(checks.some((check) => check.name === 'antigravity-cli')).toBe(
      false,
    );
  });

  it('fails closed before acquiring work when GitHub authentication is missing', async () => {
    const root = await rootWithPolicy();
    await expect(
      assertAutopilotDoctor(
        root,
        new DoctorRunner('gh auth status'),
        'antigravity',
      ),
    ).rejects.toThrow('AUTOPILOT_DOCTOR_FAILED:github-auth');
  });

  it('rejects malformed, unbounded, or dangerous policy values', async () => {
    const root = await rootWithPolicy();
    await writeFile(
      join(root, 'config', 'autonomy-policy.json'),
      `${JSON.stringify({
        ...policy,
        allowAutonomousMerge: 'yes',
        safeDefaults: {
          ...policy.safeDefaults,
          liveTradingEnabled: true,
        },
        limits: { ...policy.limits, clusterCiCorrectionRounds: 10_000 },
      })}\n`,
    );
    await expect(loadAutonomyPolicy(root)).rejects.toThrow(
      'AUTONOMY_POLICY_INVALID',
    );
  });
});
