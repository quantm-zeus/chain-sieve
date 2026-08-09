import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  isAutonomousMaintenanceEligible,
  maintenancePathAllowed,
  normalizeMaintenanceFailure,
  parseMaintenanceReview,
  runAutonomousMaintenance,
} from '../../tools/product-factory/maintenance-supervisor.js';
import { classifyAutonomyFailure } from '../../tools/product-factory/recovery-contract.js';

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

class MaintenanceLifecycleRunner implements CommandRunner {
  readonly calls: string[] = [];
  readonly committed = new Set<string>();
  merged = false;
  rootHead = 'base-head';

  constructor(private readonly root: string) {}

  run(command: string, args: string[], options: CommandOptions = {}): CommandResult {
    const cwd = options.cwd ?? this.root;
    this.calls.push(`${command} ${args.join(' ')}`);

    if (command === 'which' && args[0] === 'agy') return ok('/usr/bin/agy\n');
    if (command === 'which') return { status: 1, stdout: '', stderr: 'missing' };

    if (command === 'agy') {
      const promptIndex = args.indexOf('-p');
      const prompt = promptIndex >= 0 ? (args[promptIndex + 1] ?? '') : '';
      if (prompt.includes('fresh-context independent ChainSieve MAINTENANCE reviewer')) {
        writeFileSync(
          join(cwd, '.chainsieve-maintenance-review.json'),
          `${JSON.stringify({
            status: 'PASS',
            findings: [],
            summary: 'scope-safe maintenance change with deterministic checks already passing',
          })}\n`,
        );
      } else {
        mkdirSync(join(cwd, 'tools/product-factory'), { recursive: true });
        writeFileSync(
          join(cwd, 'tools/product-factory/self-heal-fixture.ts'),
          'export const selfHealFixture = true;\n',
        );
      }
      return ok();
    }

    if (command === 'pnpm') return ok();

    if (command === 'gh') {
      if (args[0] === 'pr' && args[1] === 'create') return ok();
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        args.includes('number,url,state,mergeStateStatus,statusCheckRollup')
      )
        return ok(
          JSON.stringify({
            number: 47,
            url: 'https://example.test/pr/47',
            state: 'OPEN',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }],
          }),
        );
      if (args[0] === 'pr' && args[1] === 'view')
        return ok(JSON.stringify({ number: 47, url: 'https://example.test/pr/47' }));
      if (args[0] === 'pr' && args[1] === 'merge') {
        this.merged = true;
        return ok();
      }
      return ok();
    }

    if (command !== 'git') return ok();

    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir')
      return ok(`${join(this.root, '.git')}\n`);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD')
      return ok(`${cwd === this.root ? this.rootHead : 'maintenance-head'}\n`);
    if (args[0] === 'status' && args[1] === '--porcelain=v1') {
      if (cwd === this.root) return ok();
      if (existsSync(join(cwd, '.chainsieve-maintenance-review.json')))
        return ok('?? .chainsieve-maintenance-review.json\n');
      if (
        existsSync(join(cwd, 'tools/product-factory/self-heal-fixture.ts')) &&
        !this.committed.has(cwd)
      )
        return ok('?? tools/product-factory/self-heal-fixture.ts\n');
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const workspace = args[2] === '--detach' ? args[3] : args[4];
      if (!workspace) return { status: 1, stdout: '', stderr: 'workspace missing' };
      mkdirSync(workspace, { recursive: true });
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'remove') return ok();
    if (args[0] === 'add') return ok();
    if (args[0] === 'commit') {
      this.committed.add(cwd);
      return ok();
    }
    if (args[0] === 'push') return ok();
    if (args[0] === 'fetch') return ok();
    if (args[0] === 'merge') {
      this.rootHead = 'merged-head';
      return ok();
    }
    if (args[0] === 'branch' && args[1] === '-D') return ok();
    return ok();
  }
}

describe('autonomous maintenance policy', () => {
  it('normalizes empty throws and sends them out of product recovery without a Muse diagnosis', () => {
    expect(normalizeMaintenanceFailure(undefined)).toBe(
      'PRODUCT_FACTORY_UNKNOWN_FAILURE:undefined',
    );
    expect(normalizeMaintenanceFailure(null)).toBe('PRODUCT_FACTORY_UNKNOWN_FAILURE:null');
    expect(classifyAutonomyFailure('undefined')).toBe('AUTONOMY_GAP');
    expect(classifyAutonomyFailure('null')).toBe('AUTONOMY_GAP');
    expect(classifyAutonomyFailure('PRODUCT_FACTORY_UNKNOWN_FAILURE:undefined')).toBe(
      'AUTONOMY_GAP',
    );
  });

  it('keeps safety/permanent blockers out of autonomous maintenance', () => {
    expect(isAutonomousMaintenanceEligible('PRODUCT_FACTORY_RECOVERY_SCOPE:tools/x.ts')).toBe(
      true,
    );
    expect(isAutonomousMaintenanceEligible('PRODUCT_FACTORY_SUPERVISOR_CHECK_FAILED:build')).toBe(
      true,
    );
    expect(isAutonomousMaintenanceEligible('SPECIFICATION_DRIFT:docs/spec')).toBe(false);
    expect(isAutonomousMaintenanceEligible('GITHUB_AUTH_FAILED')).toBe(false);
    expect(isAutonomousMaintenanceEligible('PROHIBITED_CAPABILITY:live-trading')).toBe(false);
  });

  it('allows bounded maintenance surfaces but never normative or policy authority', () => {
    expect(maintenancePathAllowed('tools/product-factory/recovery-supervisor.ts')).toBe(true);
    expect(maintenancePathAllowed('tests/unit/example.spec.ts')).toBe(true);
    expect(maintenancePathAllowed('packages/config/src/index.ts')).toBe(true);
    expect(maintenancePathAllowed('AGENTS.md')).toBe(false);
    expect(maintenancePathAllowed('config/autonomy-policy.json')).toBe(false);
    expect(maintenancePathAllowed('.github/workflows/ci.yml')).toBe(false);
    expect(maintenancePathAllowed('docs/spec/PRD.md')).toBe(false);
    expect(maintenancePathAllowed('tasks/G0/T-1.contract.json')).toBe(false);
  });

  it('requires strict independent maintenance review evidence', () => {
    expect(
      parseMaintenanceReview({ status: 'PASS', findings: [], summary: 'verified' }),
    ).toEqual({ status: 'PASS', findings: [], summary: 'verified' });
    expect(() =>
      parseMaintenanceReview({ status: 'PASS', findings: 'none', summary: 'bad' }),
    ).toThrow('PRODUCT_FACTORY_MAINTENANCE_REVIEW_INVALID');
  });
});

describe('autonomous maintenance lifecycle', () => {
  it('uses Antigravity, independently reviews, merges, and advances main without Muse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-maintenance-lifecycle-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const runner = new MaintenanceLifecycleRunner(root);
    try {
      const merged = await runAutonomousMaintenance(
        root,
        runner,
        'PRODUCT_FACTORY_RECOVERY_SCOPE:tools/product-factory/factory.ts',
        { providerId: 'muse', pollMilliseconds: 1 },
      );
      expect(merged).toBe('merged-head');
      expect(runner.merged).toBe(true);
      expect(runner.calls.some((call) => call.startsWith('agy '))).toBe(true);
      expect(runner.calls.some((call) => call.startsWith('muse '))).toBe(false);
      expect(runner.calls.some((call) => call.startsWith('gh pr create'))).toBe(true);
      expect(runner.calls.some((call) => call.startsWith('gh pr merge'))).toBe(true);
      expect(
        runner.calls.filter((call) => call === 'pnpm --silent build').length,
      ).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
