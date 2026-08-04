import type { CommandRunner } from '../agent/lib/types.js';
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
  const result = runner.run(command, args, { cwd });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return result.status === 0 && validate(output)
    ? { name, status: 'PASS', detail: output.split('\n')[0] ?? 'ok' }
    : {
        name,
        status: 'FAIL',
        detail: output.split('\n').filter(Boolean).slice(-1)[0] ?? `${command} failed`,
      };
};

export const runAutopilotDoctor = async (
  root: string,
  runner: CommandRunner,
): Promise<DoctorCheck[]> => {
  await loadAutonomyPolicy(root);
  const checks: DoctorCheck[] = [
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
    commandCheck(runner, 'pnpm', 'pnpm', ['--version'], root),
    commandCheck(runner, 'antigravity-cli', 'agy', ['--version'], root),
    commandCheck(
      runner,
      'antigravity-headless-flags',
      'agy',
      ['--help'],
      root,
      (output) =>
        ['--model', '--mode', '--cwd', '-p'].every((flag) => output.includes(flag)),
    ),
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
      'origin-reachable',
      'git',
      ['fetch', '--dry-run', 'origin'],
      root,
    ),
  ];
  return checks;
};

export const assertAutopilotDoctor = async (
  root: string,
  runner: CommandRunner,
): Promise<DoctorCheck[]> => {
  const checks = await runAutopilotDoctor(root, runner);
  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length > 0)
    throw new Error(
      `AUTOPILOT_DOCTOR_FAILED:${failed.map((check) => `${check.name}:${check.detail}`).join('|')}`,
    );
  return checks;
};

export const renderDoctor = (checks: DoctorCheck[]): string =>
  checks
    .map((check) => `${check.status === 'PASS' ? '✓' : '✗'} ${check.name}: ${check.detail}`)
    .join('\n');
