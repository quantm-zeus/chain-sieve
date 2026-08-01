import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../lib/errors.js';
import type { CommandRunner } from '../lib/types.js';

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
    throw new AgentError('CLIPBOARD_FAILED', result.stderr.trim());
};

export const openZCodeWorkspace = (
  runner: CommandRunner,
  application: string,
  workspace: string,
): void => {
  const result = runner.run('open', ['-a', application, workspace]);
  if (result.status !== 0)
    throw new AgentError('ZCODE_OPEN_FAILED', result.stderr.trim());
};
