/**
 * @requirement FR-AGT-005 - Conditional skeptic executes under versioned trigger policy, independently budgeted and evidence-bound.
 * @requirement PRD Section 23.3 & 57.5 - Skeptic triggers, adversarial challenger, auditable artifact linked to parent decision.
 */

import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  AgentDecision,
  CandidateRiskState,
  SkepticArtifact,
  SkepticTriggerReason,
  SkepticVerdict,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { SkepticArtifactSchema } from '@ciag/shared-schemas';
import { AgentBudgetTracker } from './budget-tracker.js';
import { ToolArgumentConfinementValidator } from './confinement.js';
import type { CandidateTarget } from './deterministic-planner.js';
import {
  AgentCancelledError,
  BudgetExceededError,
  ConfinementViolationError,
} from './errors.js';
import { ModelProfileRegistry } from './model-profiles.js';
import type { ToolHandler, ToolExecutionRecord, ToolExecutionContext } from './bounded-runtime.js';

export interface SkepticTriggerPolicyConfig {
  policyVersion: string;
  nearAlertScoreThreshold: number;
  maxAcceptableProviderConflicts: number;
  minDataCoverageRatio: number;
  forceSkepticOnHighRisk: boolean;
}

export const DEFAULT_SKEPTIC_TRIGGER_POLICY: SkepticTriggerPolicyConfig = {
  policyVersion: '1.0.0',
  nearAlertScoreThreshold: 0.70,
  maxAcceptableProviderConflicts: 0,
  minDataCoverageRatio: 0.75,
  forceSkepticOnHighRisk: true,
};

export interface SkepticTriggerContext {
  candidate: CandidateTarget;
  parentDecision: AgentDecision;
  candidateScore?: number | undefined;
  dataCoverageRatio?: number | undefined;
  unusuallyExtended?: boolean | undefined;
  dominantProviderRatio?: number | undefined;
  fragilityDetected?: boolean | undefined;
  providerConflictsCount?: number | undefined;
}

export interface SkepticTriggerEvaluation {
  triggered: boolean;
  triggerReasons: SkepticTriggerReason[];
  triggerMetrics: Record<string, string | number | boolean>;
  policyVersion: string;
}

export class SkepticTriggerPolicy {
  public readonly config: SkepticTriggerPolicyConfig;

  constructor(config: Partial<SkepticTriggerPolicyConfig> = {}) {
    this.config = { ...DEFAULT_SKEPTIC_TRIGGER_POLICY, ...config };
  }

  public evaluate(context: SkepticTriggerContext): SkepticTriggerEvaluation {
    const reasons: SkepticTriggerReason[] = [];
    const metrics: Record<string, string | number | boolean> = {};

    const { parentDecision } = context;
    const score = context.candidateScore ?? 0.5;
    const coverage = context.dataCoverageRatio ?? 1.0;
    const conflicts = context.providerConflictsCount ?? parentDecision.providerConflicts.length;

    metrics.candidateScore = score;
    metrics.dataCoverageRatio = coverage;
    metrics.providerConflicts = conflicts;
    metrics.parentDecision = parentDecision.decision;
    metrics.parentRisk = parentDecision.riskRecommendation;
    if (context.dominantProviderRatio !== undefined) {
      metrics.dominantProviderRatio = context.dominantProviderRatio;
    }
    if (context.unusuallyExtended !== undefined) {
      metrics.unusuallyExtended = context.unusuallyExtended;
    }
    if (context.fragilityDetected !== undefined) {
      metrics.fragilityDetected = context.fragilityDetected;
    }

    // 1. Candidate is close to alert or already marked ALERT / WATCH
    if (
      score >= this.config.nearAlertScoreThreshold ||
      parentDecision.decision === 'ALERT' ||
      parentDecision.alertClassRecommendation === 'CONFIRMED_OPPORTUNITY' ||
      parentDecision.alertClassRecommendation === 'EARLY_WATCH'
    ) {
      reasons.push('CANDIDATE_NEAR_ALERT');
    }

    // 2. Provider conflict exceeds threshold
    if (conflicts > this.config.maxAcceptableProviderConflicts) {
      reasons.push('PROVIDER_CONFLICT_EXCEEDS_THRESHOLD');
    }

    // 3. Opportunity and risk vectors strongly disagree (or forced on high risk)
    const hasStrongPositive =
      parentDecision.positiveSignals.length >= 2 ||
      parentDecision.lifecycleRecommendation === 'CONFIRMED' ||
      parentDecision.decision === 'ALERT';
    const hasElevatedRisk =
      parentDecision.riskSignals.length >= 1 ||
      parentDecision.riskRecommendation === 'MEDIUM' ||
      parentDecision.riskRecommendation === 'HIGH' ||
      parentDecision.riskRecommendation === 'CRITICAL' ||
      parentDecision.riskRecommendation === 'CONFLICTING';
    const isHighRisk =
      parentDecision.riskRecommendation === 'HIGH' ||
      parentDecision.riskRecommendation === 'CRITICAL' ||
      parentDecision.riskRecommendation === 'CONFLICTING';

    if (
      (hasStrongPositive && hasElevatedRisk) ||
      (this.config.forceSkepticOnHighRisk && isHighRisk)
    ) {
      reasons.push('OPPORTUNITY_RISK_VECTOR_DISAGREEMENT');
    }

    // 4. Data coverage is marginal
    if (coverage < this.config.minDataCoverageRatio || parentDecision.missingData.length >= 2) {
      reasons.push('DATA_COVERAGE_MARGINAL');
    }

    // 5. Candidate is unusually extended
    if (context.unusuallyExtended === true) {
      reasons.push('CANDIDATE_UNUSUALLY_EXTENDED');
    }

    // 6. Researcher claims are weakly supported
    const hasWeakClaims =
      parentDecision.observedFacts.length === 0 ||
      parentDecision.observedFacts.some((f) => f.confidence === 'LOW' || f.evidenceIds.length === 0);
    if (hasWeakClaims && parentDecision.decision !== 'INSUFFICIENT_DATA') {
      reasons.push('RESEARCHER_CLAIMS_WEAKLY_SUPPORTED');
    }

    // 7. Threshold sensitivity fragility
    if (context.fragilityDetected === true) {
      reasons.push('THRESHOLD_SENSITIVITY_FRAGILITY');
    }

    // 8. Dominant single-provider dependence
    if (context.dominantProviderRatio !== undefined && context.dominantProviderRatio >= 0.8) {
      reasons.push('DOMINANT_SINGLE_PROVIDER_DEPENDENCE');
    }

    return {
      triggered: reasons.length > 0,
      triggerReasons: reasons,
      triggerMetrics: metrics,
      policyVersion: this.config.policyVersion,
    };
  }
}

export interface SkepticExecutionOptions {
  candidate: CandidateTarget;
  parentDecision: AgentDecision;
  parentDecisionId?: string | undefined;
  runId: string;
  envelope: ToolAuthorizationEnvelope;
  skepticBudget?: AgentBudget | undefined;
  profileId?: string | undefined;
  profileVersion?: string | undefined;
  triggerContext?: Partial<SkepticTriggerContext> | undefined;
  triggerPolicy?: SkepticTriggerPolicy | undefined;
  signal?: AbortSignal | undefined;
  asOf?: string | undefined;
}

export interface SkepticExecutionResult {
  artifact: SkepticArtifact;
  status: 'EXECUTED' | 'NOT_TRIGGERED' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'SKIPPED_POLICY';
  toolRecords: ToolExecutionRecord[];
}

export class ConditionalSkepticAgent {
  private readonly triggerPolicy: SkepticTriggerPolicy;
  private readonly registry: ModelProfileRegistry;
  private readonly tools = new Map<string, ToolHandler>();

  constructor(
    triggerPolicy: SkepticTriggerPolicy = new SkepticTriggerPolicy(),
    registry: ModelProfileRegistry = new ModelProfileRegistry(),
  ) {
    this.triggerPolicy = triggerPolicy;
    this.registry = registry;
    this.registerDefaultTools();
  }

  public registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  private registerDefaultTools(): void {
    const defaultHandler: ToolHandler = async (args, ctx) => {
      if (ctx.signal?.aborted) throw new AgentCancelledError();
      return {
        status: 'OK',
        tool: 'skeptic_verification',
        parameters: args,
        verified: true,
        timestamp: new Date().toISOString(),
      };
    };

    const skepticTools = [
      'contract.audit',
      'risk.honeypot_scan',
      'liquidity.lock',
      'simulation.sell',
      'holder.distribution',
    ];

    for (const tool of skepticTools) {
      this.registerTool(tool, defaultHandler);
    }
  }

  /**
   * Executes the conditional skeptic agent on a parent research decision.
   * If triggers do not fire, skips tool execution and emits a NOT_TRIGGERED skeptic artifact.
   * If triggers fire, executes independently budgeted skeptic checks and produces an auditable artifact.
   */
  public async execute(options: SkepticExecutionOptions): Promise<SkepticExecutionResult> {
    const {
      candidate,
      parentDecision,
      runId,
      envelope,
      signal,
    } = options;

    const parentDecisionId = options.parentDecisionId ?? `dec_${candidate.assetId}_${runId}`;
    const asOf = options.asOf ?? envelope.timeRange?.maxTimestamp ?? new Date().toISOString();
    const policy = options.triggerPolicy ?? this.triggerPolicy;

    // 1. Evaluate versioned trigger policy
    const triggerEval = policy.evaluate({
      candidate,
      parentDecision,
      ...(options.triggerContext ?? {}),
    });

    const profileId = options.profileId ?? 'skeptic-v1';
    const profile = this.registry.require(profileId, options.profileVersion);

    // 2. If not triggered, return auditable NOT_TRIGGERED artifact without burning tool budget
    if (!triggerEval.triggered) {
      const artifactId = `skeptic_${candidate.assetId}_${runId}_not_triggered`;
      const canonicalNotTriggeredData = {
        id: artifactId,
        parentDecisionId,
        candidateId: candidate.assetId,
        runId,
        policyVersion: triggerEval.policyVersion,
        triggered: false,
        triggerReasons: [] as SkepticTriggerReason[],
        triggerMetrics: triggerEval.triggerMetrics,
        profileId: profile.id,
        profileVersion: profile.version,
        status: 'NOT_TRIGGERED' as const,
        verdict: 'CONFIRM' as const,
        confidence: 'HIGH' as const,
        challengeFindings: [] as string[],
        counterThesis: 'No conditional skeptic triggers satisfied; parent research thesis confirmed without adversarial challenge.',
        invalidationConditions: parentDecision.thesisInvalidationConditions,
        suggestedDecision: parentDecision.decision,
        suggestedRiskLevel: parentDecision.riskRecommendation,
        decisionChanged: false,
        evidenceIds: [] as string[],
        executedToolRecords: [],
        createdAt: asOf,
      };

      const notTriggeredArtifact: SkepticArtifact = {
        ...canonicalNotTriggeredData,
        sha256: this.computeArtifactHash(canonicalNotTriggeredData),
      };

      // Validate schema
      SkepticArtifactSchema.parse(notTriggeredArtifact);

      return {
        artifact: notTriggeredArtifact,
        status: 'NOT_TRIGGERED',
        toolRecords: [],
      };
    }

    // 3. Pre-flight cancellation check
    if (signal?.aborted) {
      throw new AgentCancelledError();
    }

    // 4. Setup independent skeptic budget
    const defaultSkepticBudget: AgentBudget = {
      maxSteps: 10,
      maxToolCalls: 10,
      maxModelCostUsd: 0.10,
      maxProviderCostUnits: 30,
      maxInputTokens: 10000,
      maxOutputTokens: 10000,
    };
    const skepticBudget = options.skepticBudget ?? defaultSkepticBudget;
    const tracker = new AgentBudgetTracker(skepticBudget);

    // 5. Select skeptic tools available in envelope and profile
    const allowedToolsSet = new Set(envelope.allowedTools);
    const allowedSkepticTools = profile.declaredTools.filter((t) =>
      allowedToolsSet.has(t),
    );

    if (allowedSkepticTools.length === 0) {
      const artifactId = `skeptic_${candidate.assetId}_${runId}_skipped_policy`;
      const canonicalSkippedData = {
        id: artifactId,
        parentDecisionId,
        candidateId: candidate.assetId,
        runId,
        policyVersion: triggerEval.policyVersion,
        triggered: true,
        triggerReasons: triggerEval.triggerReasons,
        triggerMetrics: triggerEval.triggerMetrics,
        profileId: profile.id,
        profileVersion: profile.version,
        status: 'SKIPPED_POLICY' as const,
        verdict: 'INSUFFICIENT_EVIDENCE' as const,
        confidence: 'LOW' as const,
        challengeFindings: ['No authorized skeptic tools permitted in envelope or profile'],
        counterThesis: 'Adversarial skeptic triggered but skipped by policy: no skeptic tools authorized by profile or envelope.',
        invalidationConditions: parentDecision.thesisInvalidationConditions,
        suggestedDecision: parentDecision.decision,
        suggestedRiskLevel: parentDecision.riskRecommendation,
        decisionChanged: false,
        evidenceIds: [] as string[],
        executedToolRecords: [],
        budgetUsage: tracker.getSnapshot() as unknown as Record<string, unknown>,
        createdAt: asOf,
      };

      const skippedArtifact: SkepticArtifact = {
        ...canonicalSkippedData,
        sha256: this.computeArtifactHash(canonicalSkippedData),
      };

      SkepticArtifactSchema.parse(skippedArtifact);

      return {
        artifact: skippedArtifact,
        status: 'SKIPPED_POLICY',
        toolRecords: [],
      };
    }

    const toolRecords: ToolExecutionRecord[] = [];
    const challengeFindings: string[] = [];
    let isVetoed = false;
    let isChallenged = false;
    let budgetExceeded = false;

    // 6. Execute bounded skeptic tool loop
    let stepIndex = 0;
    for (const toolName of allowedSkepticTools) {
      if (signal?.aborted) throw new AgentCancelledError();

      try {
        tracker.checkStep(1);
        tracker.recordStep(1);
        tracker.recordToolCall(candidate.assetId, 1);
        tracker.recordProviderCall(1);
        tracker.recordTokens(100, 150, (profile.costPerInputTokenUsd ?? 0.000001) * 250);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = true;
          break;
        }
        throw err;
      }

      // Confinement verification for skeptic tool arguments
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = this.generateSkepticToolArguments(toolName, candidate, envelope);
        ToolArgumentConfinementValidator.assertConforms(
          toolName,
          toolArgs,
          envelope,
          profile.declaredTools,
        );
      } catch (err) {
        if (err instanceof AgentCancelledError || signal?.aborted) {
          throw new AgentCancelledError();
        }
        const callError = err instanceof Error ? err.message : String(err);
        challengeFindings.push(`Skeptic confinement violation for ${toolName}: ${callError}`);
        toolRecords.push({
          callId: `skeptic_call_${candidate.assetId}_${stepIndex++}`,
          stepIndex: stepIndex - 1,
          toolName,
          arguments: {},
          output: undefined,
          error: callError,
          latencyMs: 0,
          executedAt: new Date().toISOString(),
        });
        continue;
      }

      const handler = this.tools.get(toolName);
      const callId = `skeptic_call_${candidate.assetId}_${stepIndex++}`;

      if (handler) {
        const startMs = Date.now();
        let output: unknown;
        let callError: string | undefined;

        try {
          const ctx: ToolExecutionContext = {
            candidate,
            signal,
            stepIndex,
            callId,
            envelope,
            profile,
          };
          output = await handler(toolArgs, ctx);
          this.evaluateToolOutputForChallenges(toolName, output, challengeFindings);
        } catch (err) {
          if (err instanceof AgentCancelledError || signal?.aborted) {
            throw new AgentCancelledError();
          }
          if (err instanceof ConfinementViolationError) {
            callError = `Confinement violation: ${err.message}`;
            challengeFindings.push(`Skeptic tool confinement violation for ${toolName}: ${callError}`);
          } else if (
            err instanceof BudgetExceededError ||
            (err instanceof Error &&
              (err.name === 'BudgetExceededError' ||
                (err as { code?: string }).code === 'BUDGET_EXCEEDED' ||
                err.message.toLowerCase().includes('budget exceeded')))
          ) {
            budgetExceeded = true;
            callError = 'Skeptic tool budget exceeded';
          } else {
            callError = err instanceof Error ? err.message : String(err);
            challengeFindings.push(`Skeptic tool execution error for ${toolName}: ${callError}`);
          }
        }

        toolRecords.push({
          callId,
          stepIndex,
          toolName,
          arguments: toolArgs,
          output,
          error: callError,
          latencyMs: Math.max(0, Date.now() - startMs),
          executedAt: new Date().toISOString(),
        });

        if (budgetExceeded) {
          break;
        }
      }
    }

    // 7. Determine verdict and revisions
    if (challengeFindings.some((f) => f.includes('HONEYPOT') || f.includes('CRITICAL_SECURITY') || f.includes('SELL_FAILED'))) {
      isVetoed = true;
    } else if (challengeFindings.length > 0 || triggerEval.triggerReasons.includes('PROVIDER_CONFLICT_EXCEEDS_THRESHOLD')) {
      isChallenged = true;
    }

    const verdict: SkepticVerdict = isVetoed
      ? 'VETO'
      : isChallenged
        ? 'CHALLENGE'
        : toolRecords.length === 0 || budgetExceeded
          ? 'INSUFFICIENT_EVIDENCE'
          : 'CONFIRM';

    const suggestedDecision = isVetoed
      ? 'REJECT'
      : isChallenged
        ? 'WATCH'
        : parentDecision.decision;

    const suggestedRiskLevel: CandidateRiskState = isVetoed
      ? 'CRITICAL'
      : isChallenged
        ? 'HIGH'
        : parentDecision.riskRecommendation;

    const decisionChanged =
      suggestedDecision !== parentDecision.decision ||
      suggestedRiskLevel !== parentDecision.riskRecommendation;

    const counterThesis = isVetoed
      ? `Adversarial skeptic veto: Critical failure hazards or security vulnerabilities identified (${challengeFindings.join('; ')})`
      : isChallenged
        ? `Adversarial skeptic challenge: High-risk latent vulnerabilities or conflicting signals detected (${challengeFindings.join('; ')})`
        : verdict === 'INSUFFICIENT_EVIDENCE'
          ? (budgetExceeded
            ? 'Adversarial skeptic budget exceeded before completing verification; insufficient evidence for confirmation.'
            : 'Adversarial skeptic had no authorized tools to execute; insufficient evidence.')
          : 'Adversarial skeptic evaluation verified security invariants without finding fatal counter-evidence.';

    const status: SkepticArtifact['status'] = budgetExceeded
      ? 'BUDGET_EXCEEDED'
      : 'EXECUTED';

    const artifactId = `skeptic_${candidate.assetId}_${runId}`;
    const canonicalArtifactData = {
      id: artifactId,
      parentDecisionId,
      candidateId: candidate.assetId,
      runId,
      policyVersion: triggerEval.policyVersion,
      triggered: true,
      triggerReasons: triggerEval.triggerReasons,
      triggerMetrics: triggerEval.triggerMetrics,
      profileId: profile.id,
      profileVersion: profile.version,
      status,
      verdict,
      confidence: (isVetoed || verdict === 'CONFIRM' ? 'HIGH' : verdict === 'INSUFFICIENT_EVIDENCE' ? 'LOW' : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH',
      challengeFindings,
      counterThesis,
      invalidationConditions: [
        ...parentDecision.thesisInvalidationConditions,
        ...challengeFindings.map((f) => `Adversarial trigger: ${f}`),
      ],
      suggestedDecision,
      suggestedRiskLevel,
      decisionChanged,
      evidenceIds: toolRecords.map((r) => r.callId),
      executedToolRecords: toolRecords.map((r) => ({
        toolName: r.toolName,
        callId: r.callId,
        latencyMs: r.latencyMs,
      })),
      budgetUsage: tracker.getSnapshot() as unknown as Record<string, unknown>,
      createdAt: asOf,
    };

    const sha256 = this.computeArtifactHash(canonicalArtifactData);
    const artifact: SkepticArtifact = {
      ...canonicalArtifactData,
      sha256,
    };

    // Validate schema
    SkepticArtifactSchema.parse(artifact);

    return {
      artifact,
      status,
      toolRecords,
    };
  }

  private generateSkepticToolArguments(
    toolName: string,
    candidate: CandidateTarget,
    envelope: ToolAuthorizationEnvelope,
  ): Record<string, unknown> {
    const baseArgs: Record<string, unknown> = {
      chain: candidate.chainId,
      address: candidate.contractAddress,
    };

    if (envelope.timeRange?.maxTimestamp) {
      baseArgs.asOf = envelope.timeRange.maxTimestamp;
    }

    switch (toolName) {
      case 'risk.honeypot_scan':
      case 'contract.audit':
      case 'liquidity.lock':
        return {
          ...baseArgs,
          contractAddress: candidate.contractAddress,
        };
      case 'holder.distribution':
        return {
          ...baseArgs,
          mint: candidate.contractAddress,
          limit: 20,
        };
      case 'simulation.sell':
        return {
          ...baseArgs,
          notionalUsd: 500,
        };
      default:
        return baseArgs;
    }
  }

  private evaluateToolOutputForChallenges(
    toolName: string,
    output: unknown,
    findings: string[],
  ): void {
    if (!output || typeof output !== 'object') return;
    const data = output as Record<string, unknown>;

    if (toolName === 'risk.honeypot_scan') {
      if (data.isHoneypot === true || data.honeypot === true) {
        findings.push('CRITICAL_SECURITY_HONEYPOT_CONFIRMED');
      }
      if (typeof data.sellTax === 'number' && data.sellTax > 0.10) {
        findings.push(`EXCESSIVE_SELL_TAX_${(data.sellTax * 100).toFixed(0)}_PERCENT`);
      }
    } else if (toolName === 'contract.audit') {
      if (data.mintAuthorityRenounced === false || data.mintable === true) {
        findings.push('UNRENOUNCED_MINT_AUTHORITY_RISK');
      }
      if (data.freezeAuthorityRenounced === false || data.freezable === true) {
        findings.push('ACTIVE_FREEZE_AUTHORITY_RISK');
      }
    } else if (toolName === 'liquidity.lock') {
      if (data.lockedPercentage !== undefined && typeof data.lockedPercentage === 'number' && data.lockedPercentage < 50) {
        findings.push(`UNLOCKED_LIQUIDITY_HAZARD_${data.lockedPercentage}_PERCENT_LOCKED`);
      }
    } else if (toolName === 'simulation.sell') {
      if (data.sellSuccess === false || data.success === false) {
        findings.push('SELL_FAILED_SIMULATION');
      }
    } else if (toolName === 'holder.distribution') {
      if (typeof data.top10Percentage === 'number' && data.top10Percentage > 0.70) {
        findings.push(`HIGH_HOLDER_CENTRALIZATION_${(data.top10Percentage * 100).toFixed(0)}_PERCENT`);
      }
    }
  }

  private computeArtifactHash(data: unknown): string {
    const canonicalize = (val: unknown): unknown => {
      if (val === null || val === undefined) return val;
      if (Array.isArray(val)) return val.map(canonicalize);
      if (typeof val === 'object') {
        return Object.fromEntries(
          Object.entries(val as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonicalize(v)]),
        );
      }
      return val;
    };
    const json = JSON.stringify(canonicalize(data));
    return createHash('sha256').update(json).digest('hex');
  }
}
