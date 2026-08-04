import { errorCode } from '../agent/lib/errors.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { AgentProviderId } from '../agent/lib/types.js';
import { runAutopilot } from './autopilot.js';

const has = (value: string): boolean => process.argv.includes(value);
const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const provider = (): AgentProviderId | undefined => {
  const selected = value('--provider');
  if (selected === undefined) return undefined;
  if (
    selected !== 'antigravity' &&
    selected !== 'codex' &&
    selected !== 'zcode'
  )
    throw new Error(`UNKNOWN_AGENT_PROVIDER:${selected}`);
  return selected;
};

try {
  const runner = new SystemCommandRunner();
  const result = await runAutopilot(
    value('--root') ?? findRepositoryRoot(),
    runner,
    {
      dryRun: has('--dry-run') || has('--status'),
      issueReceiptOnly: has('--issue-receipt-only'),
      ...(value('--max-cycles')
        ? { maxCycles: Number(value('--max-cycles')) }
        : {}),
      ...(provider() ? { providerId: provider() } : {}),
    },
  );
  console.log(result);
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
