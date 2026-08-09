import { errorCode } from '../agent/lib/errors.js';
import { findRepositoryRoot } from '../agent/lib/paths.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { AgentProviderId } from '../agent/lib/types.js';
import { runBootstrapCompatibilityMigrations } from './bootstrap-migration.js';
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

const MAX_MAINTENANCE_GENERATIONS = 12;
const MAINTENANCE_GENERATION_ENV = 'CHAINSIEVE_MAINTENANCE_GENERATION';
const CHILD_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

const maintenanceGeneration = (): number => {
  const raw = process.env[MAINTENANCE_GENERATION_ENV]?.trim() ?? '0';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`PRODUCT_FACTORY_MAINTENANCE_GENERATION_INVALID:${raw}`);
  return parsed;
};

const isEvidenceFreeFailure = (failure: string): boolean =>
  failure.startsWith('PRODUCT_FACTORY_UNKNOWN_FAILURE:') ||
  failure.includes('AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED');

try {
  const runner = new SystemCommandRunner();
  const root = value('--root') ?? findRepositoryRoot();
  const providerId = provider();
  const maxProductCorrections = value('--max-product-corrections');
  const options = {
    providerId,
    ...(maxProductCorrections
      ? { maxCorrectionRounds: Number(maxProductCorrections) }
      : {}),
  };

  await runBootstrapCompatibilityMigrations(root, runner);

  try {
    const result = await runSupervisedProductFactory(root, runner, options);
    console.log(result);
  } catch (error) {
    const failure = normalizeMaintenanceFailure(error);
    if (isEvidenceFreeFailure(failure)) throw new Error(failure);
    if (!isAutonomousMaintenanceEligible(failure)) throw error;

    const generation = maintenanceGeneration();
    if (generation >= MAX_MAINTENANCE_GENERATIONS)
      throw new Error(
        `PRODUCT_FACTORY_MAINTENANCE_GLOBAL_LIMIT:${generation}:${failure}`,
      );

    console.error(`CHAINSIEVE_AUTO_MAINTENANCE_TRIGGER:${failure}`);
    await runAutonomousMaintenance(root, runner, failure, { providerId });

    const childArgs = [
      '--silent',
      'exec',
      'tsx',
      'tools/product-factory/cli.ts',
      '--root',
      root,
      '--provider',
      providerId,
      ...(maxProductCorrections
        ? ['--max-product-corrections', maxProductCorrections]
        : []),
    ];
    console.log(
      `CHAINSIEVE_AUTO_MAINTENANCE_REEXEC:${generation + 1}:${MAX_MAINTENANCE_GENERATIONS}`,
    );
    const resumed = runner.run('pnpm', childArgs, {
      cwd: root,
      timeoutMilliseconds: CHILD_TIMEOUT_MS,
      streamOutput: true,
      environment: {
        [MAINTENANCE_GENERATION_ENV]: String(generation + 1),
      },
    });
    if (resumed.status !== 0)
      throw new Error(
        `PRODUCT_FACTORY_MAINTENANCE_REEXEC_FAILED:${resumed.timedOut ? 'TIMEOUT' : resumed.status}:${resumed.stderr || resumed.stdout}`,
      );
    console.log('CHAINSIEVE_AUTO_MAINTENANCE_RESUME_COMPLETE');
  }
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
