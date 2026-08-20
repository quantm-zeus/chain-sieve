import { z } from 'zod';
import { CandidateLifecycleSchema, CandidateRiskStateSchema } from './sig.js';
import { MissingDataItemSchema, type MissingDataItem } from './alert.js';

export const ModelClassSchema = z.enum([
  'TRIAGE',
  'DEEP_RESEARCH',
  'SKEPTIC',
  'ADMIN_CHAT',
  'REPAIR',
]);
export type ModelClass = z.infer<typeof ModelClassSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  modelClass: ModelClassSchema,
  provider: z.string().min(1),
  modelId: z.string().min(1),
  declaredTools: z.array(z.string().min(1)),
  maxTokens: z.number().int().positive(),
  maxContextTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).default(0),
  topP: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
  costPerInputTokenUsd: z.number().nonnegative().optional(),
  costPerOutputTokenUsd: z.number().nonnegative().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const AgentBudgetSchema = z.object({
  maxCandidates: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxToolCallsPerCandidate: z.number().int().positive().optional(),
  maxProviderCalls: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxModelCostUsd: z.number().nonnegative().optional(),
  maxProviderCostUnits: z.number().nonnegative().optional(),
  deadlineAt: z.string().datetime().optional(),
});
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const ToolAuthorizationEnvelopeSchema = z.object({
  allowedTools: z.array(z.string().min(1)).min(1),
  allowedProviders: z.array(z.string().min(1)).optional(),
  allowedDomains: z.array(z.string().min(1)).optional(),
  allowedChains: z.array(z.string().min(1)).optional(),
  allowedAddresses: z.array(z.string().min(1)).optional(),
  timeRange: z
    .object({
      minTimestamp: z.string().datetime().optional(),
      maxTimestamp: z.string().datetime(),
    })
    .optional(),
  maxOutputSizeBytes: z.number().int().positive().optional(),
  maxLimit: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
});
export type ToolAuthorizationEnvelope = z.infer<typeof ToolAuthorizationEnvelopeSchema>;

export const EvidenceAcquisitionDecisionSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  runId: z.string().min(1),
  evidenceFamily: z.string().min(1),
  policyVersion: z.string().min(1),
  state: z.enum([
    'NOT_REQUESTED_BY_POLICY',
    'REQUESTED',
    'COST_BLOCKED',
    'QUOTA_BLOCKED',
    'RIGHTS_BLOCKED',
    'UNSUPPORTED',
    'PROVIDER_UNAVAILABLE',
    'FAILED',
    'RETURNED_EMPTY',
    'RETURNED',
  ]),
  requestedFields: z.array(z.string().min(1)),
  expectedDecisionImpact: z.string().optional(),
  estimatedCost: z
    .object({
      monetaryCostUsd: z.number().nonnegative().optional(),
      quotaCostUnits: z.number().nonnegative().optional(),
    })
    .optional(),
  randomized: z.boolean().default(false),
  assignmentProbability: z.string().optional(),
  randomizationStratum: z.string().optional(),
  randomizationSeedRef: z.string().optional(),
  decidedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  actualDecisionChange: z
    .enum(['NONE', 'RANK', 'LIFECYCLE', 'RISK', 'ALERT', 'ABSTENTION'])
    .optional(),
  evidenceIds: z.array(z.string().min(1)).default([]),
  reasonCodes: z.array(z.string().min(1)).default([]),
});
export type EvidenceAcquisitionDecision = z.infer<typeof EvidenceAcquisitionDecisionSchema>;

export const ModelExecutionManifestSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  modelRevision: z.string().optional(),
  requestParameters: z.record(z.string(), z.unknown()),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  seed: z.number().optional(),
  systemPromptHash: z.string().min(1),
  promptHash: z.string().min(1),
  toolSchemaHashes: z.record(z.string(), z.string()).optional(),
  inputArtifactHashes: z.array(z.string()).optional(),
  outputHash: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  latencyMs: z.number().nonnegative(),
  executedAt: z.string().datetime(),
});
export type ModelExecutionManifest = z.infer<typeof ModelExecutionManifestSchema>;

export const ClaimRefSchema = z.object({
  claim: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
});
export type ClaimRef = z.infer<typeof ClaimRefSchema>;

export const AgentDecisionSchema = z.object({
  candidate: z.object({
    assetId: z.string().min(1),
    chainId: z.string().min(1),
    contractAddress: z.string().min(1),
    symbol: z.string().optional(),
  }),
  profileId: z.string().min(1),
  decision: z.enum(['ALERT', 'WATCH', 'IGNORE', 'REJECT', 'INSUFFICIENT_DATA']),
  alertClassRecommendation: z
    .enum([
      'EARLY_WATCH',
      'CONFIRMED_OPPORTUNITY',
      'THESIS_STRENGTHENING',
      'THESIS_WEAKENING',
      'OPPORTUNITY_EXPIRED',
      'RISK_ALERT',
    ])
    .optional(),
  executionScenarioId: z.string().optional(),
  tradabilityAssessmentId: z.string().optional(),
  validUntil: z.string().datetime().optional(),
  costPolicyResult: z.enum(['PASS', 'BLOCKED', 'DEGRADED']),
  socialCapabilityState: z.string().optional(),
  alphaEvidencePackId: z.string().optional(),
  multiViewState: z
    .enum([
      'CONSENSUS_POSITIVE',
      'CONSENSUS_NEGATIVE',
      'MIXED_NONCRITICAL',
      'HIGH_DISAGREEMENT',
      'CRITICAL_CONTRADICTION',
      'INSUFFICIENT_INDEPENDENCE',
      'INSUFFICIENT_DATA',
    ])
    .optional(),
  failureHazardState: z.string().optional(),
  noveltyState: z
    .enum(['IN_DISTRIBUTION', 'WEAKLY_NOVEL', 'HIGHLY_NOVEL', 'UNSUPPORTED'])
    .optional(),
  patternMatchIds: z.array(z.string()).optional(),
  alphaArtifactVersionIds: z.array(z.string()).optional(),
  lifecycleRecommendation: CandidateLifecycleSchema,
  riskRecommendation: CandidateRiskStateSchema,
  thesis: z.string(),
  counterThesis: z.string(),
  observedFacts: z.array(ClaimRefSchema).default([]),
  derivedFacts: z.array(ClaimRefSchema).default([]),
  inferences: z.array(ClaimRefSchema).default([]),
  hypotheses: z.array(ClaimRefSchema).default([]),
  positiveSignals: z.array(z.string()).default([]),
  riskSignals: z.array(z.string()).default([]),
  missingData: z.array(MissingDataItemSchema).default([]),
  providerConflicts: z.array(z.string()).default([]),
  thesisInvalidationConditions: z.array(z.string()).default([]),
  recommendedNextCheckMinutes: z.number().int().positive().optional(),
  reasoningAssessment: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  abstentionReason: z.string().optional(),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
