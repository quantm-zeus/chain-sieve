import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import { runBootstrapCompatibilityMigrations } from '../../tools/product-factory/bootstrap-migration.js';

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });

class BootstrapRunner implements CommandRunner {
  readonly calls: string[] = [];

  constructor(
    private readonly root: string,
    private readonly g0Head = '29bbd83bde714c61c25f4bcd23c0a23264b39171',
  ) {}

  run(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): CommandResult {
    this.calls.push(`${command} ${args.join(' ')}`);
    if (command !== 'git') return ok();
    if (args[0] === 'branch' && args[1] === '--show-current') return ok('main\n');
    if (args[0] === 'status') return ok();
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir')
      return ok(`${join(this.root, '.git')}\n`);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('current-main\n');
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return ok();
    if (args[0] === 'worktree' && args[1] === 'list')
      return ok(`worktree ${this.root}\nHEAD current-main\nbranch refs/heads/main\n`);
    if (args[0] === 'fetch') return ok();
    if (
      args[0] === 'rev-parse' &&
      args[1] === '--verify' &&
      (args[2] === 'refs/heads/cluster/g0' ||
        args[2] === 'refs/remotes/origin/cluster/g0')
    )
      return ok(`${this.g0Head}\n`);
    if (args[0] === 'show-ref' && args[1] === '--verify')
      return { status: 1, stdout: '', stderr: 'missing' };
    return ok();
  }
}

const statePath = (root: string): string =>
  join(root, '.git', 'ciag-runtime', 'task-state.json');

describe('product factory bootstrap compatibility migration', () => {
  it('restores the already-merged framework task and archives/resets pristine legacy G0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-bootstrap-migration-'));
    await mkdir(join(root, '.git'), { recursive: true });
    const runner = new BootstrapRunner(root);
    try {
      await runBootstrapCompatibilityMigrations(root, runner);
      const state = JSON.parse(await readFile(statePath(root), 'utf8')) as {
        schemaVersion: string;
        tasks: Record<string, { state: string; leaseVersion: number }>;
      };
      expect(state.schemaVersion).toBe('2.0.0');
      expect(state.tasks['T-FW-AUTOPILOT']).toMatchObject({
        state: 'MERGED',
        leaseVersion: 0,
      });
      expect(
        runner.calls.some((call) =>
          call.includes('branch archive/pre-autopilot/cluster-g0-remote-29bbd83bde71'),
        ),
      ).toBe(true);
      expect(
        runner.calls.some((call) =>
          call.includes(
            'push --force-with-lease=refs/heads/cluster/g0:29bbd83bde714c61c25f4bcd23c0a23264b39171 origin refs/heads/cluster/g0:refs/heads/cluster/g0',
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not normalize G0 after trusted lifecycle activity has started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-bootstrap-active-'));
    await mkdir(join(root, '.git', 'ciag-runtime'), { recursive: true });
    await writeFile(
      statePath(root),
      `${JSON.stringify({
        schemaVersion: '2.0.0',
        tasks: {
          'T-FW-AUTOPILOT': {
            taskId: 'T-FW-AUTOPILOT',
            state: 'MERGED',
            leaseVersion: 0,
            history: [],
          },
          'T-G0-CORE': {
            taskId: 'T-G0-CORE',
            state: 'IMPLEMENTING',
            leaseVersion: 1,
            leaseId: 'lease-1',
            holder: 'agent-orchestrator',
            history: [],
          },
        },
      }, null, 2)}\n`,
    );
    const runner = new BootstrapRunner(root);
    try {
      await runBootstrapCompatibilityMigrations(root, runner);
      expect(runner.calls.some((call) => call.startsWith('git push '))).toBe(false);
      expect(runner.calls.some((call) => call === 'git fetch origin --prune')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
