import { createHash } from 'node:crypto';
import type { CommandRunner } from '../agent/lib/types.js';

export type CorrectionLaneType =
  | 'PRODUCT_CODE'
  | 'TEST'
  | 'DEPENDENCY'
  | 'MIGRATION'
  | 'CONFIG'
  | 'SPECIFICATION'
  | 'GENERATED_CONTRACT'
  | 'INFRASTRUCTURE';

export interface CorrectionLaneDefinition {
  type: CorrectionLaneType;
  allowedPrefixes: string[];
  allowedExactFiles?: string[];
  forbiddenPrefixes: string[];
  deterministicChecks: string[][];
}

export const CORRECTION_LANES: Record<CorrectionLaneType, CorrectionLaneDefinition> = {
  PRODUCT_CODE: {
    type: 'PRODUCT_CODE',
    allowedPrefixes: ['apps/', 'packages/'],
    forbiddenPrefixes: ['tests/', 'docs/spec/', '.github/', 'tools/'],
    deterministicChecks: [
      ['build'],
      ['lint'],
      ['typecheck'],
      ['test'],
      ['architecture:verify'],
      ['placeholders:scan'],
      ['prohibited-capabilities:scan'],
    ],
  },
  TEST: {
    type: 'TEST',
    allowedPrefixes: ['tests/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/', 'tools/'],
    deterministicChecks: [['lint'], ['typecheck'], ['test'], ['harness:verify']],
  },
  DEPENDENCY: {
    type: 'DEPENDENCY',
    allowedPrefixes: ['apps/', 'packages/'],
    allowedExactFiles: ['package.json', 'pnpm-lock.yaml'],
    forbiddenPrefixes: ['docs/spec/', '.github/', 'tools/'],
    deterministicChecks: [['install', '--frozen-lockfile'], ['build'], ['typecheck'], ['test']],
  },
  MIGRATION: {
    type: 'MIGRATION',
    allowedPrefixes: ['drizzle/', 'packages/persistence/src/db/migrations/'],
    forbiddenPrefixes: ['docs/spec/', 'apps/', 'tools/'],
    deterministicChecks: [['migration:verify'], ['build'], ['typecheck'], ['test']],
  },
  CONFIG: {
    type: 'CONFIG',
    allowedPrefixes: ['config/', 'docs/operations/'],
    forbiddenPrefixes: ['docs/spec/', 'apps/', 'packages/', 'tools/'],
    deterministicChecks: [['build'], ['lint'], ['typecheck'], ['test'], ['placeholders:scan']],
  },
  SPECIFICATION: {
    type: 'SPECIFICATION',
    allowedPrefixes: ['docs/spec/', 'docs/adr/', 'tasks/', 'clusters/', 'artifacts/spec/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'tests/', 'tools/'],
    deterministicChecks: [['prd:compile'], ['spec:verify'], ['prd:drift-check'], ['requirements:coverage']],
  },
  GENERATED_CONTRACT: {
    type: 'GENERATED_CONTRACT',
    allowedPrefixes: ['tasks/', 'clusters/', 'artifacts/context/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/', 'tools/'],
    deterministicChecks: [['spec:verify'], ['prd:drift-check']],
  },
  INFRASTRUCTURE: {
    type: 'INFRASTRUCTURE',
    allowedPrefixes: ['.github/', 'config/', 'docs/operations/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/', 'tools/'],
    deterministicChecks: [['build'], ['lint'], ['typecheck']],
  },
};

export const FORBIDDEN_CONTROL_PLANE_PREFIXES = ['tools/', '.github/', 'secrets/'];
export const FORBIDDEN_CONTROL_PLANE_EXACT = ['config/autonomy-policy.json'];

export const pathMatchesLane = (path: string, laneType: CorrectionLaneType): boolean => {
  if (
    FORBIDDEN_CONTROL_PLANE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    FORBIDDEN_CONTROL_PLANE_EXACT.includes(path)
  ) {
    return false;
  }
  const lane = CORRECTION_LANES[laneType];
  if (!lane) return false;
  const isForbidden = lane.forbiddenPrefixes.some((prefix) => path.startsWith(prefix));
  if (isForbidden) return false;
  const matchesPrefix = lane.allowedPrefixes.some((prefix) => path.startsWith(prefix));
  const matchesExact = lane.allowedExactFiles?.includes(path) ?? false;
  return matchesPrefix || matchesExact;
};

export const classifyPathLane = (path: string): CorrectionLaneType => {
  if (path === 'package.json' || path === 'pnpm-lock.yaml' || path.endsWith('/package.json'))
    return 'DEPENDENCY';
  if (path.startsWith('drizzle/') || path.includes('/migrations/')) return 'MIGRATION';
  if (path.startsWith('tests/')) return 'TEST';
  if (path.startsWith('config/') || path.startsWith('docs/operations/')) return 'CONFIG';
  if (path.startsWith('docs/spec/') || path.startsWith('docs/adr/')) return 'SPECIFICATION';
  if (path.startsWith('tasks/') || path.startsWith('clusters/')) return 'GENERATED_CONTRACT';
  if (path.startsWith('.github/')) return 'INFRASTRUCTURE';
  return 'PRODUCT_CODE';
};

export type AutonomyStateClassification =
  | 'SUCCESS'
  | 'AUTO_RECOVERABLE'
  | 'SAFETY_TERMINAL'
  | 'EXTERNAL_BLOCKER'
  | 'AUTONOMY_GAP';

export interface FailureFingerprint {
  code: string;
  targetId: string;
  hash: string;
}

export const computeFailureFingerprint = (
  code: string,
  targetId: string,
  details: string[] = [],
): FailureFingerprint => {
  const normalized = details
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d.length > 200 ? d.slice(0, 200) : d))
    .slice(0, 20)
    .sort();
  const raw = `${code}:${targetId}:${normalized.join('|')}`;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { code, targetId, hash: `${code}:${targetId}:${digest}` };
};

export const classifyAutonomyFailure = (code: string): AutonomyStateClassification => {
  const normalized = code.trim();
  if (
    normalized.length === 0 ||
    /^(?:undefined|null)$/i.test(normalized) ||
    normalized.includes('PRODUCT_FACTORY_UNKNOWN_FAILURE')
  ) {
    return 'AUTONOMY_GAP';
  }
  if (normalized.startsWith('AUTOPILOT_COMPLETE') || normalized.startsWith('PRODUCT_FACTORY_COMPLETE')) {
    return 'SUCCESS';
  }
  if (
    normalized.includes('NO_HEADLESS_EXECUTOR') ||
    normalized.includes('AUTONOMOUS_MERGE_DISABLED') ||
    normalized.includes('PROHIBITED_CAPABILITY') ||
    normalized.includes('SECRET_EXPOSURE') ||
    normalized.includes('SPECIFICATION_DRIFT') ||
    normalized.includes('MUSE_TASK_CALL_BUDGET_EXHAUSTED') ||
    normalized.includes('MUSE_DUPLICATE_TASK_EVIDENCE_BLOCKED') ||
    normalized.includes('MUSE_SEMANTIC_CALL_BUDGET_EXHAUSTED') ||
    normalized.includes('MUSE_DUPLICATE_SEMANTIC_EVIDENCE_BLOCKED')
  ) {
    return 'SAFETY_TERMINAL';
  }
  if (
    normalized.includes('GITHUB_FAILED') ||
    normalized.includes('PR_CLOSED') ||
    normalized.includes('CI_TIMEOUT') ||
    normalized.includes('FINAL_MAIN_CI_FAILED') ||
    normalized.includes('INFRASTRUCTURE_RETRY_EXHAUSTED')
  ) {
    return 'EXTERNAL_BLOCKER';
  }
  if (
    normalized.includes('CORRECTION_SCOPE') ||
    normalized.includes('CONVERGENCE_AUDIT_SCOPE') ||
    normalized.includes('CONVERGENCE_REPORT_INVALID') ||
    normalized.includes('RECOVERY_SCOPE')
  ) {
    return 'AUTONOMY_GAP';
  }
  return 'AUTO_RECOVERABLE';
};

export type RecoveryAction =
  | 'REPAIR'
  | 'SPLIT_TASK'
  | 'REPLAN'
  | 'REGENERATE_DERIVED_TASKS'
  | 'REOPEN_CORRECTION'
  | 'RETRY_INFRASTRUCTURE'
  | 'SAFETY_TERMINAL'
  | 'EXTERNAL_BLOCKER';

export const parsePorcelainLine = (line: string): string | null => {
  const trimmed = line.replace(/[\r\n]/g, '');
  if (trimmed.length < 3) return null;
  const rawPathPart = trimmed.slice(2).trim();
  if (!rawPathPart) return null;
  const target = rawPathPart.split(' -> ').at(-1)?.trim() ?? rawPathPart;
  const unquoted = target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target;
  return unquoted || null;
};

export const changedPaths = (runner: CommandRunner, cwd: string): string[] => {
  const result = runner.run('git', ['status', '--porcelain=v1'], {
    cwd,
    timeoutMilliseconds: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `PRODUCT_FACTORY_GIT_FAILED:status:--porcelain=v1:${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout
    .split('\n')
    .map(parsePorcelainLine)
    .filter((p): p is string => Boolean(p))
    .sort();
};