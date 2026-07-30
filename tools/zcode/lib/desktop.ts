import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ZCodeError } from './errors.js';
import type { CommandRunner } from './types.js';

export const detectZCodeApplication = (
  candidates?: string[],
): string | undefined => {
  const paths = candidates ?? [
    '/Applications/ZCode.app',
    join(homedir(), 'Applications', 'ZCode.app'),
  ];
  return paths.find((path) => existsSync(path));
};

export const copyPayload = (runner: CommandRunner, payload: string): void => {
  const result = runner.run('pbcopy', [], { input: payload });
  if (result.status !== 0)
    throw new ZCodeError('CLIPBOARD_FAILED', result.stderr.trim());
};

export const openZCodeWorkspace = (
  runner: CommandRunner,
  application: string,
  workspace: string,
): void => {
  const result = runner.run('open', ['-a', application, workspace]);
  if (result.status !== 0)
    throw new ZCodeError('ZCODE_OPEN_FAILED', result.stderr.trim());
};
