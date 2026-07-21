import { z } from 'zod';

export const HealthSchema = z.object({ status: z.literal('ok'), service: z.string(), time: z.string().datetime() });
export const ReadinessDependencySchema = z.object({ name: z.string(), ready: z.boolean(), detail: z.string() });
export const ReadinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  capabilityMode: z.literal('SYNTHETIC_SHADOW'),
  dependencies: z.array(ReadinessDependencySchema),
});

export const SourceHashesSchema = z.object({ prd: z.string().regex(/^[a-f0-9]{64}$/), requirements: z.string().regex(/^[a-f0-9]{64}$/), audit: z.string().regex(/^[a-f0-9]{64}$/) });
const IdList = z.array(z.string().min(1));
const VerificationCommandSchema = z.object({ command: z.string().min(1), expected: z.string().min(1) });

export const TaskContractSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  id: z.string().regex(/^T-G[0-7]-[A-Z0-9-]+$/),
  title: z.string().min(1),
  sourceHashes: SourceHashesSchema,
  dependencyGroup: z.string().regex(/^G[0-7]$/),
  cluster: z.string().regex(/^C-G[0-7]-[A-Z0-9-]+$/),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  autonomyLevel: z.enum(['AUTONOMOUS', 'REVIEW_REQUIRED', 'OWNER_APPROVAL_REQUIRED']),
  dependencies: IdList,
  requirements: IdList.min(1),
  acceptanceCriteria: IdList,
  invariants: IdList,
  adrs: IdList,
  ownerPackages: IdList.min(1),
  readSet: IdList,
  writeSet: IdList,
  allowedPaths: IdList.min(1),
  forbiddenPaths: IdList,
  exclusiveLocks: IdList,
  interfaceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  deliverables: IdList.min(1),
  constraints: IdList.min(1),
  nonGoals: IdList.min(1),
  degradedBehavior: z.string().min(1),
  rollback: z.string().min(1),
  requiredTests: IdList.min(1),
  verificationCommands: z.array(VerificationCommandSchema).min(1),
  complexityBudget: z.object({ maxFiles: z.number().int().positive(), maxChangedLines: z.number().int().positive(), maxCyclomaticComplexity: z.number().int().positive() }),
  changeBudget: z.object({ maxMigrations: z.number().int().nonnegative(), maxPublicInterfaces: z.number().int().nonnegative(), requiresSplitAboveBudget: z.literal(true) }),
  stopConditions: IdList.min(1),
  completionDefinition: IdList.min(1),
  sourceReferences: z.array(z.object({ path: z.string(), line: z.number().int().positive(), id: z.string() })).min(1),
});

export const TaskResultSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), leaseVersion: z.number().int().positive(), commit: z.string(), evidence: z.array(z.object({ command: z.string(), exitCode: z.number().int(), outputSha256: z.string() })), status: z.enum(['PASS', 'FAIL', 'BLOCKED']) });
export const TaskReviewSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), reviewer: z.string(), verdict: z.enum(['PASS', 'CHANGES_REQUIRED']), findings: z.array(z.object({ severity: z.enum(['P0', 'P1', 'P2', 'P3']), text: z.string() })) });
export const TaskAmendmentSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), reason: z.string(), changedFields: IdList, approvedBy: z.string(), sourceHashes: SourceHashesSchema });
export const TaskLeaseSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), holder: z.string(), version: z.number().int().positive(), acquiredAt: z.string().datetime(), expiresAt: z.string().datetime(), state: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED', 'COMPLETED']) });
export const ClusterContractSchema = z.object({ schemaVersion: z.literal('1.0.0'), id: z.string(), group: z.string(), title: z.string(), sourceHashes: SourceHashesSchema, dependencies: IdList, tasks: IdList.min(1), requirements: IdList.min(1), acceptanceCriteria: IdList, invariants: IdList, entryCriteria: IdList, exitCriteria: IdList, verificationCommands: z.array(VerificationCommandSchema), rollback: z.string() });
export const ClusterResultSchema = z.object({ schemaVersion: z.literal('1.0.0'), clusterId: z.string(), taskResults: IdList, evidenceHash: z.string(), status: z.enum(['PASS', 'FAIL', 'BLOCKED']) });
export const ClusterReviewSchema = z.object({ schemaVersion: z.literal('1.0.0'), clusterId: z.string(), verdict: z.enum(['PASS', 'CHANGES_REQUIRED']), architecturalDiff: z.string(), findings: z.array(z.string()) });
export const ArchitecturalDiffSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), importsAdded: IdList, importsRemoved: IdList, publicInterfacesChanged: IdList, migrationsAdded: IdList, capabilityChanges: IdList });
export const ContextManifestSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), sourceHashes: SourceHashesSchema, files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })), generatedAt: z.string() });
export const ReadyQueueSchema = z.object({ schemaVersion: z.literal('1.0.0'), generatedFrom: z.string(), ready: IdList, blocked: z.array(z.object({ taskId: z.string(), dependencies: IdList })) });

export const ContractSchemas = {
  'task-contract': TaskContractSchema,
  'task-result': TaskResultSchema,
  'task-review': TaskReviewSchema,
  'task-amendment': TaskAmendmentSchema,
  'task-lease': TaskLeaseSchema,
  'cluster-contract': ClusterContractSchema,
  'cluster-result': ClusterResultSchema,
  'cluster-review': ClusterReviewSchema,
  'architectural-diff': ArchitecturalDiffSchema,
  'context-manifest': ContextManifestSchema,
  'ready-queue': ReadyQueueSchema,
} as const;

export type TaskContract = z.infer<typeof TaskContractSchema>;
export type ClusterContract = z.infer<typeof ClusterContractSchema>;
