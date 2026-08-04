import { errorCode } from '../agent/lib/errors.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { AgentProviderId } from '../agent/lib/types.js';
import {
  DEFAULT_AUTONOMOUS_PROVIDER,
  runAutopilot,
} from './autopilot.js';
import {
  assertAutopilotDoctor,
  renderDoctor,
  runAutopilotDoctor,
} from './doctor.js';

const has = (value: string): boolean => process.argv.includes(value);
const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const provider = (): AgentProviderId => {
  const selected = value('--provider') ?? DEFAULT_AUTONOMOUS_PROVIDER;
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
  const root = value('--root') ?? findRepositoryRoot();
  const selectedProvider = provider();
  if (has('--doctor')) {
    const checks = await runAutopilotDoctor(root, runner, selectedProvider);
    console.log(renderDoctor(checks));
    if (checks.some((check) => check.status === 'FAIL')) process.exitCode = 1;
  } else {
    await assertAutopilotDoctor(root, runner, selectedProvider);
    const result = await runAutopilot(root, runner, {
      dryRun: has('--dry-run') || has('--status'),
      issueReceiptOnly: has('--issue-receipt-only'),
      providerId: selectedProvider,
      ...(value('--max-cycles')
        ? { maxCycles: Number(value('--max-cycles')) }
        : {}),
    });
    console.log(result);
  }
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
