import { errorCode } from '../agent/lib/errors.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { AgentProviderId } from '../agent/lib/types.js';
import {
  isAutonomousMaintenanceEligible,
  normalizeMaintenanceFailure,
  runAutonomousMaintenance,
} from './maintenance-supervisor.js';
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

const MAX_MAINTENANCE_RESUMES_PER_PROCESS = 12;

try {
  const runner = new SystemCommandRunner();
  const root = value('--root') ?? findRepositoryRoot();
  const providerId = provider();
  const options = {
    providerId,
    ...(value('--max-product-corrections')
      ? { maxCorrectionRounds: Number(value('--max-product-corrections')) }
      : {}),
  };

  for (let maintenanceResume = 0; ; maintenanceResume += 1) {
    try {
      const result = await runSupervisedProductFactory(root, runner, options);
      console.log(result);
      break;
    } catch (error) {
      const failure = normalizeMaintenanceFailure(error);
      if (!isAutonomousMaintenanceEligible(failure)) throw error;
      if (maintenanceResume >= MAX_MAINTENANCE_RESUMES_PER_PROCESS)
        throw new Error(
          `PRODUCT_FACTORY_MAINTENANCE_GLOBAL_LIMIT:${maintenanceResume}:${failure}`,
        );
      console.error(`CHAINSIEVE_AUTO_MAINTENANCE_TRIGGER:${failure}`);
      await runAutonomousMaintenance(root, runner, failure, { providerId });
      console.log('CHAINSIEVE_AUTO_MAINTENANCE_RESUME');
    }
  }
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
