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
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

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

const HashedPathSchema = z.object({ path: z.string().min(1), sha256: Sha256Schema });
const ChangedFileSchema = HashedPathSchema.extend({ status: z.enum(['A', 'C', 'M', 'R', 'T', 'U', 'X', 'B', 'D']) });
const CommandEvidenceSchema = z.object({ command: z.string().min(1), exitCode: z.number().int(), outputSha256: Sha256Schema, artifactPath: z.string().min(1), artifactSha256: Sha256Schema });
export const TaskResultSchema = z.object({
  schemaVersion: z.literal('2.0.0'), taskId: z.string().min(1), status: z.enum(['PASS', 'FAIL', 'BLOCKED']),
  bindings: z.object({
    taskContractSha256: Sha256Schema, prdSha256: Sha256Schema, requirementManifestSha256: Sha256Schema, auditSha256: Sha256Schema,
    baseCommitSha: GitShaSchema, headCommitSha: GitShaSchema, headTreeSha: GitShaSchema,
    changedFiles: z.array(ChangedFileSchema).min(1),
    requirementToCode: z.array(z.object({ requirementId: z.string().min(1), files: z.array(HashedPathSchema).min(1) })).min(1),
    acceptanceToTests: z.array(z.object({ acceptanceId: z.string().min(1), tests: z.array(HashedPathSchema).min(1) })).min(1),
    requiredTestArtifacts: z.array(CommandEvidenceSchema).min(1), dependencyInterfaceHashes: z.record(z.string(), Sha256Schema),
    verifierVersion: z.string().min(1), verificationPolicyVersion: z.string().min(1), leaseId: z.string().min(1), leaseFencingVersion: z.number().int().positive(), verificationTimestamp: z.string().datetime(), selfReviewPath: z.string().min(1), selfReviewSha256: Sha256Schema,
  }),
  commandEvidence: z.array(CommandEvidenceSchema).min(1),
});
export const TaskReviewSchema = z.object({
  schemaVersion: z.literal('2.0.0'),
  taskId: z.string(),
  reviewer: z.string().min(1),
  reviewedBaseCommit: GitShaSchema,
  reviewedCommit: GitShaSchema,
  reviewedTree: GitShaSchema,
  changedFiles: z.array(ChangedFileSchema).min(1),
  dependencyInterfaceHashes: z.record(z.string(), Sha256Schema),
  acceptanceTestArtifacts: z.array(HashedPathSchema).min(1),
  leaseId: z.string().min(1),
  leaseFencingVersion: z.number().int().positive(),
  reviewedAt: z.string().datetime(),
  rebase: z.object({
    previousHeadCommit: GitShaSchema.optional(),
    conflictsDetected: z.boolean(),
    semanticChangesDetected: z.boolean(),
  }),
  passes: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.literal('PASS'),
        evidence: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  verdict: z.enum(['PASS', 'CHANGES_REQUIRED']),
  findings: z.array(
    z.object({
      severity: z.enum(['P0', 'P1', 'P2', 'P3']),
      text: z.string().min(1),
      resolved: z.boolean(),
    }),
  ),
});
export const TaskAmendmentSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), reason: z.string(), changedFields: IdList, approvedBy: z.string(), sourceHashes: SourceHashesSchema });
export const TaskLeaseSchema = z.object({ schemaVersion: z.literal('2.0.0'), taskId: z.string(), holder: z.string(), leaseId: z.string().min(1), fencingVersion: z.number().int().positive(), version: z.number().int().positive(), acquiredAt: z.string().datetime(), expiresAt: z.string().datetime(), state: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED', 'COMPLETED']) });
export const ClusterContractSchema = z.object({ schemaVersion: z.literal('1.0.0'), id: z.string(), group: z.string(), title: z.string(), sourceHashes: SourceHashesSchema, dependencies: IdList, tasks: IdList.min(1), requirements: IdList.min(1), acceptanceCriteria: IdList, invariants: IdList, entryCriteria: IdList, exitCriteria: IdList, verificationCommands: z.array(VerificationCommandSchema), rollback: z.string() });
export const ClusterResultSchema = z.object({ schemaVersion: z.literal('2.0.0'), clusterId: z.string(), status: z.enum(['PASS', 'FAIL', 'BLOCKED']), clusterContractSha256: Sha256Schema, headCommitSha: GitShaSchema, headTreeSha: GitShaSchema, taskAttestations: z.array(z.object({ taskId: z.string().min(1), taskCommitSha: GitShaSchema, taskTreeSha: GitShaSchema, resultSha256: Sha256Schema })).min(1), commandEvidence: z.array(CommandEvidenceSchema).min(1), verifierVersion: z.string().min(1), verificationPolicyVersion: z.string().min(1), verificationTimestamp: z.string().datetime() });
export const ClusterReviewSchema = z.object({ schemaVersion: z.literal('1.0.0'), clusterId: z.string(), verdict: z.enum(['PASS', 'CHANGES_REQUIRED']), architecturalDiff: z.string(), findings: z.array(z.string()) });
export const ArchitecturalDiffSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), importsAdded: IdList, importsRemoved: IdList, publicInterfacesChanged: IdList, migrationsAdded: IdList, capabilityChanges: IdList });
export const ContextManifestSchema = z.object({ schemaVersion: z.literal('1.0.0'), taskId: z.string(), sourceHashes: SourceHashesSchema, files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })), generatedAt: z.string() });
export const ReadyQueueSchema = z.object({ schemaVersion: z.literal('1.0.0'), generatedFrom: z.string(), ready: IdList, blocked: z.array(z.object({ taskId: z.string(), dependencies: IdList })) });
export const LifecycleManifestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  harness: z.literal('production-lifecycle'),
  repository: z.literal('isolated-temporary-git-repository'),
  scenarios: z
    .array(
      z.object({
        scenarioId: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']),
        commandsExecuted: z.array(
          z.object({
            command: z.string().min(1),
            exitCode: z.number().int(),
            outputSha256: Sha256Schema,
            expectedRejection: z.string().min(1).optional(),
          }),
        ),
        stateTransitionsObserved: z.array(z.string().min(1)),
        commitShas: z.array(GitShaSchema),
        gitTreeShas: z.array(GitShaSchema),
        leaseVersions: z.array(z.number().int().positive()),
        evidenceHashes: z.array(Sha256Schema),
        queueOperations: z.array(z.string().min(1)),
        rebaseResult: z.string().min(1),
        verificationResult: z.string().min(1),
        mergeResult: z.string().min(1),
        revertResult: z.string().min(1),
        cleanupResult: z.string().min(1),
      }),
    )
    .length(8),
  generatedAt: z.string().datetime(),
});

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
  'lifecycle-manifest': LifecycleManifestSchema,
} as const;

export type TaskContract = z.infer<typeof TaskContractSchema>;
export type ClusterContract = z.infer<typeof ClusterContractSchema>;
