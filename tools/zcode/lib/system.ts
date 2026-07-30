import { spawnSync } from 'node:child_process';
import type { CommandRunner } from './types.js';

export class SystemCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (result.error ? result.error.message : ''),
    };
  }
}
