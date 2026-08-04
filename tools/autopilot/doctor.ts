import type {
  AgentProviderId,
  CommandRunner,
} from '../agent/lib/types.js';
import { resolveAntigravityAutopilotModel } from '../agent/providers/antigravity.js';
import { loadAutonomyPolicy } from './policy.js';

export interface DoctorCheck {
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const commandCheck = (
  runner: CommandRunner,
  name: string,
  command: string,
  args: string[],
  cwd: string,
  validate: (output: string) => boolean = () => true,
): DoctorCheck => {
  const result = runner.run(command, args, { cwd, timeoutMilliseconds: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return result.status === 0 && validate(output)
    ? { name, status: 'PASS', detail: output.split('\n')[0] ?? 'ok' }
    : {
        name,
        status: 'FAIL',
        detail:
          output.split('\n').filter(Boolean).slice(-1)[0] ??
          `${command} failed`,
      };
};

const supportedAntigravityVersion = (output: string): boolean => {
  const match = output.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 1 && (minor > 1 || (minor === 1 && patch >= 1));
};

const providerChecks = (
  root: string,
  runner: CommandRunner,
  provider: AgentProviderId,
): DoctorCheck[] => {
  if (provider === 'antigravity') {
    const model = resolveAntigravityAutopilotModel();
    return [
      commandCheck(
        runner,
        'antigravity-cli',
        'agy',
        ['--version'],
        root,
        supportedAntigravityVersion,
      ),
      commandCheck(
        runner,
        'antigravity-model-access',
        'agy',
        ['models'],
        root,
        (output) =>
          output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .includes(model),
      ),
    ];
  }
  if (provider === 'codex')
    return [
      commandCheck(runner, 'codex-cli', 'codex', ['--version'], root),
      commandCheck(
        runner,
        'codex-headless-flags',
        'codex',
        ['exec', '--help'],
        root,
        (output) =>
          ['--cd', '--sandbox'].every((flag) => output.includes(flag)),
      ),
    ];
  return [commandCheck(runner, 'zcode-cli', 'zcode', ['--version'], root)];
};

export const runAutopilotDoctor = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProviderId = 'antigravity',
): Promise<DoctorCheck[]> => {
  await loadAutonomyPolicy(root);
  return [
    commandCheck(runner, 'git-root', 'git', ['rev-parse', '--show-toplevel'], root),
    commandCheck(
      runner,
      'root-main',
      'git',
      ['branch', '--show-current'],
      root,
      (output) => output.trim() === 'main',
    ),
    commandCheck(
      runner,
      'root-clean',
      'git',
      ['status', '--porcelain=v1'],
      root,
      (output) => output.trim() === '',
    ),
    commandCheck(
      runner,
      'node-22',
      'node',
      ['--version'],
      root,
      (output) => /^v22\./.test(output.trim()),
    ),
    commandCheck(
      runner,
      'pnpm-10.13.1',
      'pnpm',
      ['--version'],
      root,
      (output) => output.trim() === '10.13.1',
    ),
    ...providerChecks(root, runner, provider),
    commandCheck(runner, 'github-auth', 'gh', ['auth', 'status'], root),
    commandCheck(
      runner,
      'github-repository-access',
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner'],
      root,
    ),
    commandCheck(
      runner,
      'github-write-access',
      'gh',
      ['api', 'repos/{owner}/{repo}', '--jq', '.permissions.push'],
      root,
      (output) => output.trim() === 'true',
    ),
    commandCheck(
      runner,
      'origin-reachable',
      'git',
      ['fetch', '--dry-run', 'origin'],
      root,
    ),
  ];
};

export const assertAutopilotDoctor = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProviderId = 'antigravity',
): Promise<DoctorCheck[]> => {
  const checks = await runAutopilotDoctor(root, runner, provider);
  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length > 0)
    throw new Error(
      `AUTOPILOT_DOCTOR_FAILED:${failed
        .map((check) => `${check.name}:${check.detail}`)
        .join('|')}`,
    );
  return checks;
};

export const renderDoctor = (checks: DoctorCheck[]): string =>
  checks
    .map(
      (check) =>
        `${check.status === 'PASS' ? '✓' : '✗'} ${check.name}: ${check.detail}`,
    )
    .join('\n');
