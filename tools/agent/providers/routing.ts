import type { AgentProvider, CommandRunner } from '../lib/types.js';
import { AntigravityProvider } from './antigravity.js';

export type AgentWorkRole = 'SEMANTIC' | 'MAINTENANCE';

const SEMANTIC_FAILURE_MARKERS = [
  'CONVERGENCE_LIMIT',
  'CONVERGENCE_REPORT_INVALID',
  'CONVERGENCE_AUDIT',
  'SPECIFICATION_DRIFT',
  'REQUIREMENTS_COVERAGE',
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
  'CHECK_FAILED:TEST',
  'CHECK_FAILED:INSTALL',
  'COMMAND_FAILED:BUILD',
  'COMMAND_FAILED:LINT',
  'COMMAND_FAILED:TYPECHECK',
  'COMMAND_FAILED:TEST',
  'COMMAND_FAILED:INSTALL',
] as const;

/** Unknown failures stay semantic. This intentionally biases toward Muse when
 * there is any ambiguity about product meaning or requirement interpretation.
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

const between = (value: string, start: string, end: string): string | undefined => {
  const from = value.indexOf(start);
  if (from < 0) return undefined;
  const contentStart = from + start.length;
  const to = value.indexOf(end, contentStart);
  return (to < 0 ? value.slice(contentStart) : value.slice(contentStart, to)).trim();
};

/**
 * Route only prompts whose role is explicitly mechanical. Task implementation,
 * specification work, convergence correction, and independent review remain on
 * Muse. Recovery diagnosis is routed from the embedded raw failure rather than
 * from generic prompt prose about PRDs/requirements.
 */
export const shouldRouteMusePayloadToMaintenance = (payload: string): boolean => {
  if (payload.includes('You are isolated CI repair session ')) return true;
  if (payload.startsWith('Recovery PR CI failed:')) return true;

  if (payload.includes('independent fresh-context recovery diagnostician')) {
    const failure = between(payload, 'Failure: ', '. Fingerprint:');
    return failure ? isMechanicalFailure(failure) : false;
  }

  if (payload.includes('executing approved ChainSieve recovery action REPAIR'))
    return isMechanicalFailure(payload);

  return false;
};

/**
 * Prefer Antigravity only when its real blocking headless `agy` CLI is
 * available. Otherwise keep the already-authorized semantic provider so hybrid
 * routing never introduces a new availability blocker.
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
    detection.command &&
    antigravity.executePayload
  )
    return antigravity;
  return semanticProvider;
};
