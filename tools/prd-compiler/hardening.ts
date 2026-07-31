import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { normalize } from 'node:path';

export type AcceptanceLevel = 'TASK' | 'CLUSTER' | 'PROJECT';
export type ReferencePathStatus =
  | 'EXISTS'
  | 'EXPECTED_TO_CREATE'
  | 'INVALID_REFERENCE'
  | 'OWNED_BY_OTHER_TASK';

export interface HardeningRequirement {
  id: string;
  text: string;
  textSha256: string;
  line: number;
  owner: string;
  dependencyGroup: string;
  implementationRefs: string[];
  schemaRefs: string[];
  persistenceRefs: string[];
  apiToolUiRefs: string[];
  testRefs: string[];
  fixtureRefs: string[];
  telemetryRefs: string[];
  rollbackRefs: string[];
  activationGateRefs: string[];
}

export interface HardeningAcceptance {
  id: string;
  text: string;
  textSha256: string;
  line: number;
  requirementRefs: string[];
  positiveTestRef: string;
  negativeOrFailureTestRef: string;
  testClass?: string;
  evidenceOwner?: string;
}

export interface AcceptanceTask {
  id: string;
  cluster: string;
  requirements: string[];
  ownerPackages: string[];
}

export interface AcceptanceAssignment {
  acceptanceId: string;
  level: AcceptanceLevel;
  owner: string;
  participatingTasks: string[];
  participatingClusters: string[];
  referencedRequirements: string[];
  sourceText: string;
  sourceTextSha256: string;
  reason: string;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const partitionAcceptanceCriteria = (
  acceptance: HardeningAcceptance[],
  tasks: AcceptanceTask[],
): AcceptanceAssignment[] =>
  acceptance.map((criterion) => {
    const participants = tasks.filter((task) =>
      criterion.requirementRefs.some((id) => task.requirements.includes(id)),
    );
    if (participants.length === 0)
      throw new Error(`ACCEPTANCE_WITHOUT_TASK:${criterion.id}`);
    const taskIds = participants.map((task) => task.id).sort();
    const clusters = unique(participants.map((task) => task.cluster)).sort();
    const level: AcceptanceLevel =
      clusters.length > 1
        ? 'PROJECT'
        : taskIds.length > 1
          ? 'CLUSTER'
          : 'TASK';
    return {
      acceptanceId: criterion.id,
      level,
      owner: level === 'TASK' ? taskIds[0]! : level === 'CLUSTER' ? clusters[0]! : 'PROJECT',
      participatingTasks: taskIds,
      participatingClusters: clusters,
      referencedRequirements: [...criterion.requirementRefs].sort(),
      sourceText: criterion.text,
      sourceTextSha256: criterion.textSha256,
      reason:
        level === 'TASK'
          ? 'All referenced requirements are owned by one task.'
          : level === 'CLUSTER'
            ? 'Referenced requirements span multiple task owners in one cluster.'
            : 'Referenced requirements span multiple dependency-group clusters.',
    };
  });

export const taskFacet = (
  assignment: AcceptanceAssignment,
  task: AcceptanceTask,
): { acceptanceId: string; facetId: string; text: string; sourceAcceptanceSha256: string } => {
  const local = task.requirements.filter((id) =>
    assignment.referencedRequirements.includes(id),
  );
  return {
    acceptanceId: assignment.acceptanceId,
    facetId: `${assignment.acceptanceId}:${task.id}:INTERFACE_FACET`,
    text: `Provide only the interfaces owned by ${task.id} for ${local.join(', ')} that the unchanged ${assignment.acceptanceId} system or integration oracle consumes. This facet does not claim full ${assignment.acceptanceId} satisfaction.`,
    sourceAcceptanceSha256: assignment.sourceTextSha256,
  };
};

export const exactNormativeExcerpts = (
  prd: string,
  requirements: HardeningRequirement[],
  acceptance: HardeningAcceptance[],
): Array<{ id: string; sourceLine: number; startLine: number; endLine: number; exactText: string }> => {
  const lines = prd.split('\n');
  return [...requirements, ...acceptance]
    .map((item) => {
      const startLine = Math.max(1, item.line - 2);
      const endLine = Math.min(lines.length, item.line + 2);
      return {
        id: item.id,
        sourceLine: item.line,
        startLine,
        endLine,
        exactText: lines.slice(startLine - 1, endLine).join('\n'),
      };
    })
    .sort((left, right) => left.sourceLine - right.sourceLine);
};

const normalizeReference = (value: string): string =>
  normalize(value.split(/\s+@/)[0]!.trim()).replaceAll('\\', '/');

const withoutGlob = (value: string): string =>
  value.replace(/\*\*?.*$/, '').replace(/\/$/, '');

const matchesScope = (reference: string, scope: string): boolean => {
  const ref = withoutGlob(reference);
  const candidate = withoutGlob(scope);
  return ref === candidate || ref.startsWith(`${candidate}/`) || candidate.startsWith(`${ref}/`);
};

export const classifyReferencedPaths = (
  requirements: HardeningRequirement[],
  task: AcceptanceTask & { writeSet?: string[]; allowedPaths?: string[] },
  allTasks: Array<AcceptanceTask & { writeSet?: string[] }>,
  options: { root?: string; baselinePaths?: string[] } = {},
): Array<{
  path: string;
  status: ReferencePathStatus;
  ownerTask?: string;
  requirementIds: string[];
}> => {
  const paths = new Map<string, Set<string>>();
  for (const requirement of requirements) {
    const values = [
      ...requirement.implementationRefs,
      ...requirement.schemaRefs,
      ...requirement.persistenceRefs,
      ...requirement.apiToolUiRefs,
      ...requirement.testRefs,
      ...requirement.fixtureRefs,
      ...requirement.telemetryRefs,
      ...requirement.rollbackRefs,
    ];
    for (const raw of values) {
      if (!raw.includes('/') || /^Section\b/i.test(raw)) continue;
      const path = normalizeReference(raw);
      if (!path || path.startsWith('../') || path.startsWith('/'))
        throw new Error(`INVALID_CONTEXT_REFERENCE:${requirement.id}:${raw}`);
      const ids = paths.get(path) ?? new Set<string>();
      ids.add(requirement.id);
      paths.set(path, ids);
    }
  }
  return [...paths]
    .map(([path, requirementIds]) => {
      const baseline = options.baselinePaths?.some((candidate) =>
        matchesScope(path, candidate),
      );
      const exists = options.root ? existsSync(`${options.root}/${withoutGlob(path)}`) : false;
      if (baseline || exists)
        return { path, status: 'EXISTS' as const, requirementIds: [...requirementIds].sort() };
      if ([...(task.writeSet ?? []), ...(task.allowedPaths ?? [])].some((scope) => matchesScope(path, scope)))
        return { path, status: 'EXPECTED_TO_CREATE' as const, requirementIds: [...requirementIds].sort() };
      const owner = allTasks.find(
        (candidate) =>
          candidate.id !== task.id &&
          (candidate.writeSet ?? []).some((scope) => matchesScope(path, scope)),
      );
      if (owner)
        return {
          path,
          status: 'OWNED_BY_OTHER_TASK' as const,
          ownerTask: owner.id,
          requirementIds: [...requirementIds].sort(),
        };
      if (
        /^(?:docs\/generated\/|migrations\/|telemetry\/|tests\/|packages\/|apps\/|infra\/)/.test(
          path,
        )
      )
        return {
          path,
          status: 'EXPECTED_TO_CREATE' as const,
          requirementIds: [...requirementIds].sort(),
        };
      return { path, status: 'INVALID_REFERENCE' as const, requirementIds: [...requirementIds].sort() };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

export const rejectDuplicateContextReferences = (
  paths: Array<{ path: string }>,
): void => {
  const seen = new Set<string>();
  for (const item of paths) {
    if (seen.has(item.path)) throw new Error(`DUPLICATE_CONTEXT_REFERENCE:${item.path}`);
    seen.add(item.path);
  }
};

export const buildImplementationBrief = (
  taskId: string,
  requirements: HardeningRequirement[],
  references: Array<{ path: string; status: ReferencePathStatus }>,
): Record<string, unknown> => {
  const modules = unique(
    requirements.flatMap((item) => item.implementationRefs.map(normalizeReference)),
  );
  const publicInterfaces = unique(
    requirements.flatMap((item) => [...item.schemaRefs, ...item.apiToolUiRefs]).map(normalizeReference),
  );
  const detailedInterface = requirements.some(
    (item) => item.text.split(/\s+/).length >= 12 || /\b(input|output|returns?|schema|field|request|response)\b/i.test(item.text),
  );
  const invalid = references.filter((item) => item.status === 'INVALID_REFERENCE');
  const specificationGap = publicInterfaces.length === 0 || !detailedInterface || invalid.length > 0;
  return {
    schemaVersion: '1.0.0',
    taskId,
    specificationStatus: specificationGap ? 'SPECIFICATION_GAP' : 'READY',
    taskPurpose: requirements.map((item) => ({ id: item.id, exactNormativeText: item.text })),
    expectedModules: modules,
    expectedPublicInterfaces: publicInterfaces.length > 0 ? publicInterfaces : ['SPECIFICATION_GAP'],
    inputOutputSemantics: detailedInterface
      ? requirements.map((item) => item.text)
      : ['SPECIFICATION_GAP'],
    failureAndDegradedBehavior: requirements
      .filter((item) => /\b(fail|unavailable|degrad|invalid|error)\b/i.test(item.text))
      .map((item) => item.text),
    pointInTimeSemantics: requirements
      .filter((item) => /\b(event-time|available_at|point-in-time|first-seen|timestamp)\b/i.test(item.text))
      .map((item) => item.text),
    idempotencyExpectations: requirements
      .filter((item) => /\b(idempot|replay|single-flight|atomic)\b/i.test(item.text))
      .map((item) => item.text),
    observabilityExpectations: unique(requirements.flatMap((item) => item.telemetryRefs)),
    nonGoals: [
      'No semantics beyond the exact normative excerpts.',
      'No financial execution, signing, custody, transaction submission, or automatic capability activation.',
    ],
    specificationGaps: [
      ...(!detailedInterface ? ['Public input/output contract is not sufficiently defined by source prose.'] : []),
      ...invalid.map((item) => `Invalid source reference: ${item.path}`),
    ],
  };
};

export const buildConformanceManifest = (input: {
  taskId: string;
  riskLevel: string;
  requirements: string[];
  taskAcceptanceCriteria: string[];
  taskAcceptanceFacets: Array<{ facetId: string }>;
  requiredTests: string[];
  productionTargets: string[];
}): { content: string; sha256: string } => {
  const value = {
    schemaVersion: '1.0.0',
    taskId: input.taskId,
    immutable: true,
    requirements: input.requirements,
    taskAcceptanceCriteria: input.taskAcceptanceCriteria,
    taskAcceptanceFacets: input.taskAcceptanceFacets.map((item) => item.facetId),
    taskOwnedTests: input.requiredTests,
    productionTargets: unique(input.productionTargets.map(normalizeReference)),
    requiredOracle: 'tests/conformance/task-oracle.spec.ts',
    protectedPaths: [
      `artifacts/conformance/${input.taskId}/**`,
      'tests/conformance/**',
    ],
    qualityGate:
      input.riskLevel === 'HIGH' || input.riskLevel === 'CRITICAL'
        ? 'SEEDED_FAULT_OR_PROPERTY'
        : 'NEGATIVE_CASE',
    rejectsTrivialAssertions: true,
    requiresChangedProductionBehaviorInvocation: true,
  };
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return { content, sha256: hash(content) };
};

export const interfacePlan = (
  requirements: HardeningRequirement[],
  brief: Record<string, unknown>,
): Record<string, unknown> => ({
  schemaVersion: '1.0.0',
  specificationStatus: brief.specificationStatus,
  interfaces: unique(requirements.flatMap((item) => [...item.schemaRefs, ...item.apiToolUiRefs])).map((path) => ({ path, source: 'normative-manifest-reference' })),
  rule: 'SPECIFICATION_GAP blocks arbitrary public-contract invention.',
});

export const behaviorTestMatrix = (
  taskId: string,
  acceptance: HardeningAcceptance[],
  facets: Array<{ acceptanceId: string; facetId: string }>,
): Record<string, unknown> => ({
  schemaVersion: '1.0.0',
  taskId,
  taskLocalCriteria: acceptance.map((item) => ({
    acceptanceId: item.id,
    positive: item.positiveTestRef,
    negativeOrFailure: item.negativeOrFailureTestRef,
    exactNormativeText: item.text,
  })),
  localFacets: facets,
  requiredBehaviorClasses: ['positive', 'negative', 'degraded', 'replay', 'recovery', 'rollback', 'observability'],
});
