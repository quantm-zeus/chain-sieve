import type { AgentProvider, CommandRunner } from '../lib/types.js';
import { AntigravityProvider } from './antigravity.js';

export type AgentWorkRole = 'SEMANTIC' | 'MAINTENANCE';

const SEMANTIC_FAILURE_MARKERS = [
  'CONVERGENCE_LIMIT',
  'CONVERGENCE_REPORT_INVALID',
  'CONVERGENCE_AUDIT',
  'SPECIFICATION',
  'REQUIREMENT',
  'ACCEPTANCE_CRITER',
  'REPLAN',
  'SPLIT_TASK',
  'REGENERATE_DERIVED_TASKS',
] as const;

const MAINTENANCE_FAILURE_MARKERS = [
  'ENOTDIR',
  'ENOENT',
  'EACCES',
  'EPERM',
  'WORKTREE',
  'LOCKFILE',
  'MUSE_CODE_MISSING',
  'ANTIGRAVITY_HEADLESS_MISSING',
  'GIT_FAILED',
  'GITHUB_FAILED',
  'CI_FAILED',
  'CI_TIMEOUT',
  'CHECK_FAILED:BUILD',
  'CHECK_FAILED:LINT',
  'CHECK_FAILED:TYPECHECK',
  'CHECK_FAILED:INSTALL',
  'COMMAND_FAILED:BUILD',
  'COMMAND_FAILED:LINT',
  'COMMAND_FAILED:TYPECHECK',
  'COMMAND_FAILED:INSTALL',
] as const;

/**
 * Conservatively route only deterministic/tooling-shaped failures away from
 * the semantic product agent. Unknown failures stay semantic by default.
 */
export const classifyAgentWork = (failure: string): AgentWorkRole => {
  const upper = failure.toUpperCase();
  if (SEMANTIC_FAILURE_MARKERS.some((marker) => upper.includes(marker)))
    return 'SEMANTIC';
  if (MAINTENANCE_FAILURE_MARKERS.some((marker) => upper.includes(marker)))
    return 'MAINTENANCE';
  return 'SEMANTIC';
};

export const isMechanicalFailure = (failure: string): boolean =>
  classifyAgentWork(failure) === 'MAINTENANCE';

/**
 * Prefer the cheaper maintenance provider when the real headless `agy` CLI is
 * available. Fall back to the already-authorized semantic provider so routing
 * never creates a new availability blocker.
 */
export const selectMaintenanceProvider = (
  runner: CommandRunner,
  semanticProvider: AgentProvider,
): AgentProvider => {
  if (semanticProvider.id === 'antigravity') return semanticProvider;
  const antigravity = new AntigravityProvider(runner);
  const detection = antigravity.detect();
  if (
    detection.available &&
    detection.mechanism === 'command' &&
    detection.command?.endsWith('agy') &&
    antigravity.executePayload
  )
    return antigravity;
  return semanticProvider;
};
