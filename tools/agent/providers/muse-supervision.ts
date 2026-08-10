import { AgentError } from '../lib/errors.js';

export const MUSE_HARD_TIMEOUT_ENV = 'CHAINSIEVE_MUSE_HARD_TIMEOUT_MS' as const;
export const MUSE_RETRY_STORM_LIMIT_ENV = 'CHAINSIEVE_MUSE_RETRY_STORM_LIMIT' as const;
export const MUSE_RETRY_STALL_ENV = 'CHAINSIEVE_MUSE_RETRY_STALL_MS' as const;
export const MUSE_COMMIT_GRACE_ENV = 'CHAINSIEVE_MUSE_COMMIT_GRACE_MS' as const;
export const MUSE_CIRCUIT_COOLDOWN_ENV = 'CHAINSIEVE_MUSE_CIRCUIT_COOLDOWN_MS' as const;

export const DEFAULT_MUSE_HARD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MUSE_RETRY_STORM_LIMIT = 4;
export const DEFAULT_MUSE_RETRY_STALL_MS = 90_000;
export const DEFAULT_MUSE_COMMIT_GRACE_MS = 30_000;
export const DEFAULT_MUSE_CIRCUIT_COOLDOWN_MS = 15 * 60_000;

export interface MuseSupervisionConfig {
  hardTimeoutMilliseconds: number;
  retryStormLimit: number;
  retryStallMilliseconds: number;
  commitGraceMilliseconds: number;
  circuitCooldownMilliseconds: number;
}

const configuredInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new AgentError(
      'MUSE_SUPERVISION_CONFIG_INVALID',
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  return value;
};

export const resolveMuseSupervision = (
  environment: NodeJS.ProcessEnv = process.env,
): MuseSupervisionConfig => ({
  hardTimeoutMilliseconds: configuredInteger(
    environment,
    MUSE_HARD_TIMEOUT_ENV,
    DEFAULT_MUSE_HARD_TIMEOUT_MS,
    5 * 60_000,
    2 * 60 * 60_000,
  ),
  retryStormLimit: configuredInteger(
    environment,
    MUSE_RETRY_STORM_LIMIT_ENV,
    DEFAULT_MUSE_RETRY_STORM_LIMIT,
    2,
    100,
  ),
  retryStallMilliseconds: configuredInteger(
    environment,
    MUSE_RETRY_STALL_ENV,
    DEFAULT_MUSE_RETRY_STALL_MS,
    30_000,
    30 * 60_000,
  ),
  commitGraceMilliseconds: configuredInteger(
    environment,
    MUSE_COMMIT_GRACE_ENV,
    DEFAULT_MUSE_COMMIT_GRACE_MS,
    15_000,
    30 * 60_000,
  ),
  circuitCooldownMilliseconds: configuredInteger(
    environment,
    MUSE_CIRCUIT_COOLDOWN_ENV,
    DEFAULT_MUSE_CIRCUIT_COOLDOWN_MS,
    60_000,
    60 * 60_000,
  ),
});

const retryPatterns = [
  /retrying meta model stream/i,
  /rate.?limit/i,
  /temporar(?:y|ily) unavailable/i,
  /overload(?:ed)?/i,
  /upstream.*(?:timeout|unavailable)/i,
] as const;

export const museOutputIsRetrySignal = (line: string): boolean =>
  retryPatterns.some((pattern) => pattern.test(line));

export const museLifecycleIsDurableCheckpoint = (state?: string): boolean =>
  Boolean(
    state &&
      ['SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED'].includes(
        state,
      ),
  );
