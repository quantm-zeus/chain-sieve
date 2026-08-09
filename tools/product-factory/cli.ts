import { errorCode } from '../agent/lib/errors.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { AgentProviderId } from '../agent/lib/types.js';
import { runSupervisedProductFactory } from './recovery-supervisor.js';

const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const provider = (): AgentProviderId => {
  const selected = value('--provider') ?? 'muse';
  if (
    selected !== 'antigravity' &&
    selected !== 'claude-deepseek' &&
    selected !== 'codex' &&
    selected !== 'muse' &&
    selected !== 'zcode'
  )
    throw new Error(`UNKNOWN_AGENT_PROVIDER:${selected}`);
  return selected;
};

try {
  const runner = new SystemCommandRunner();
  const root = value('--root') ?? findRepositoryRoot();
  const result = await runSupervisedProductFactory(root, runner, {
    providerId: provider(),
    ...(value('--max-product-corrections')
      ? { maxCorrectionRounds: Number(value('--max-product-corrections')) }
      : {}),
  });
  console.log(result);
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
