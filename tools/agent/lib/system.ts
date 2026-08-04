import { spawnSync } from 'node:child_process';
import type { CommandOptions, CommandRunner } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
type StreamingCommandOptions = CommandOptions & { streamOutput?: boolean };

export class SystemCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): { status: number; stdout: string; stderr: string; timedOut?: boolean } {
    const timeout = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS;
    const streamOutput =
      (options as StreamingCommandOptions).streamOutput === true;
    const result = spawnSync(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      killSignal: 'SIGTERM',
      ...(streamOutput ? { stdio: 'inherit' as const } : {}),
    });
    const timedOut =
      result.error instanceof Error &&
      'code' in result.error &&
      result.error.code === 'ETIMEDOUT';
    return {
      status: result.status ?? 1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr:
        typeof result.stderr === 'string'
          ? result.stderr
          : result.error
            ? result.error.message
            : timedOut
              ? 'command timed out'
              : '',
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}
