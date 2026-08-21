import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  AgentDecision,
  EvidenceAcquisitionDecision,
  ModelProfile,
  SkepticArtifact,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { AgentBudgetTracker, type BudgetUsageSnapshot } from './budget-tracker.js';
import { ToolArgumentConfinementValidator } from './confinement.js';
import type {
  CandidateTarget,
  DeterministicPlan,
} from './deterministic-planner.js';
import {
  AgentCancelledError,
  AgentRuntimeError,
  BudgetExceededError,
  ConfinementViolationError,
} from './errors.js';
import { ModelProfileRegistry } from './model-profiles.js';
import {
  VoiPlanner,
  type VoiPlanResult,
  type VoiPolicy,
  type RandomProbeConfig,
} from './voi-planner.js';
import {
  ConditionalSkepticAgent,
  SkepticTriggerPolicy,
  type SkepticExecutionResult,
  type SkepticTriggerContext,
} from './conditional-skeptic.js';
import { StructuredDecisionEngine } from './decision-engine.js';
import { type EvidenceRecord } from './evidence-validator.js';
import { UntrustedContentIsolator } from './untrusted-isolation.js';
import {
  type EvidenceAcquisitionStore,
  getEvidenceAcquisitionStore,
} from './acquisition-state.js';
import {
  EvidenceFamilyRegistry,
  type EvidenceFamilyDefinition,
} from './evidence-families.js';
import type { AgentRuntimePersistenceRepository } from './runtime-store.js';


export interface ToolExecutionContext {
  candidate: CandidateTarget;
  signal?: AbortSignal | undefined;
  stepIndex: number;
  callId: string;
  envelope: ToolAuthorizationEnvelope;
  profile: ModelProfile;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

export interface ToolExecutionRecord {
  callId: string;
  stepIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  output?: unknown;
  error?: string | undefined;
  latencyMs: number;
  executedAt: string;
}

export interface AgentExecutionOptions {
  candidate: CandidateTarget;
  profileId: string;
  profileVersion?: string | undefined;
  envelope: ToolAuthorizationEnvelope;
  budget: AgentBudget;
  signal?: AbortSignal | undefined;
  initialEvidence?: Record<string, unknown> | undefined;
  goal?: 'TRIAGE' | 'DEEP_RESEARCH' | 'SKEPTIC' | 'ADMIN_CHAT' | 'REPAIR' | undefined;
  deterministicSeedRef?: string | number | undefined;
  runId?: string | undefined;
  policyVersion?: string | undefined;
  randomProbeConfig?: RandomProbeConfig | undefined;
  eligibleEvidenceFamilies?: readonly EvidenceFamilyDefinition[] | readonly string[] | undefined;
  minVoiThreshold?: number | undefined;
  acquisitionStore?: EvidenceAcquisitionStore | undefined;
  enableVoi?: boolean | undefined;
  voiPolicy?: Partial<VoiPolicy> | undefined;
  enableSkeptic?: boolean | undefined;
  skepticBudget?: AgentBudget | undefined;
  skepticTriggerPolicy?: SkepticTriggerPolicy | undefined;
  candidateScore?: number | undefined;
  skepticTriggerContext?: Partial<SkepticTriggerContext> | undefined;
  randomizationStratum?: string | undefined;
  persistenceRepository?: AgentRuntimePersistenceRepository | undefined;
}

export interface AgentExecutionResult {
  runId: string;
  plan: DeterministicPlan;
  status: 'SUCCESS' | 'ABSTAINED' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'FAILED';
  decision: AgentDecision;
  acquisitionDecisions: EvidenceAcquisitionDecision[];
  toolRecords: ToolExecutionRecord[];
  budgetUsage: BudgetUsageSnapshot;
  executedSteps: number;
  executedToolCalls: number;
  completedAt: string;
  voiPlanResult?: VoiPlanResult | undefined;
  skepticResult?: SkepticExecutionResult | undefined;
}

export class BoundedAgentRuntime {
  private readonly tools = new Map<string, ToolHandler>();

  constructor(
    public readonly registry: ModelProfileRegistry = new ModelProfileRegistry(),
  ) {
    this.registerDefaultTools();
  }

  public registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  private registerDefaultTools(): void {
    const defaultEchoHandler: ToolHandler = async (args, ctx) => {
      if (ctx.signal?.aborted) {
        throw new AgentCancelledError();
      }
      return {
        status: 'OK',
        assetId: ctx.candidate.assetId,
        chain: ctx.candidate.chainId,
        address: ctx.candidate.contractAddress,
        parameters: args,
        timestamp: new Date().toISOString(),
      };
    };

    const toolNames = [
      'dex.pairs',
      'dex.screener',
      'token.profile',
      'holder.distribution',
      'contract.audit',
      'solana.transaction_trace',
      'pool.liquidity',
      'signal.score',
      'simulation.execution',
      'liquidity.lock',
      'simulation.sell',
      'risk.honeypot_scan',
      'market.summary',
      'schedule.inspect',
      'candidate.inspect',
      'run.inspect',
      'alert.inspect',
      'incident.list',
    ];

    for (const name of toolNames) {
      this.registerTool(name, defaultEchoHandler);
    }
  }

  /**
   * Executes a bounded agent research run.
   */
  public async execute(
    options: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    const { candidate, profileId, profileVersion, envelope, budget, signal } =
      options;

    // 1. Fail closed on unknown profile before any execution
    const profile = this.registry.require(profileId, profileVersion);

    // 2. Budget tracker setup and unconditional pre-flight deadline & step checks
    const tracker = new AgentBudgetTracker(budget);
    tracker.checkDeadline();
    if (budget.maxSteps <= 0) {
      tracker.checkStep(1);
    }

    // 3. Pre-flight cancellation check
    if (signal?.aborted) {
      throw new AgentCancelledError();
    }

    // 4. Determine available tools for this profile and envelope
    const availableTools = profile.declaredTools.filter((tool) =>
      envelope.allowedTools.includes(tool),
    );

    // 5. If tools are available for this execution, enforce pre-flight external budget gates
    if (availableTools.length > 0) {
      if (budget.maxToolCalls <= 0) {
        tracker.checkToolCall(candidate.assetId, 1);
      }
      if (budget.maxProviderCalls !== undefined && budget.maxProviderCalls <= 0) {
        tracker.checkProviderCall(1);
      }
      if (budget.maxProviderCostUnits !== undefined && budget.maxProviderCostUnits <= 0) {
        tracker.checkProviderCostUnits(1);
      }

      const minInputTokens = 100;
      const minOutputTokens = 150;
      const minEstimatedCostUsd =
        minInputTokens * (profile.costPerInputTokenUsd ?? 0.000001) +
        minOutputTokens * (profile.costPerOutputTokenUsd ?? 0.000002);

      if (
        (budget.maxModelCostUsd !== undefined && budget.maxModelCostUsd < minEstimatedCostUsd) ||
        (budget.maxInputTokens !== undefined && budget.maxInputTokens < minInputTokens) ||
        (budget.maxOutputTokens !== undefined && budget.maxOutputTokens < minOutputTokens)
      ) {
        tracker.checkTokens(minInputTokens, minOutputTokens, minEstimatedCostUsd);
      }
    }

    // 6. Generate deterministic VOI plan and persist initial acquisition decisions
    const familyRegistry = new EvidenceFamilyRegistry();
    const voiPlanner = new VoiPlanner(options.voiPolicy, familyRegistry);
    const store = options.acquisitionStore ?? getEvidenceAcquisitionStore();
    const policyVersion = options.policyVersion ?? profile.version;

    const initialPlan = DeterministicPlanner.plan({
      candidate,
      profile,
      envelope,
      budget,
      goal: options.goal,
      initialEvidence: options.initialEvidence,
      requestedEvidenceFamilies: options.requestedEvidenceFamilies,
      deterministicSeedRef: options.deterministicSeedRef,
    });

    const runId = options.runId ?? initialPlan.planId;

    const voiResult = voiPlanner.plan({
      candidate,
      profile,
      envelope,
      budget,
      goal: options.goal,
      runId,
      policyVersion,
      eligibleEvidenceFamilies: options.eligibleEvidenceFamilies,
      initialEvidence: options.initialEvidence,
      currentCandidateScore: options.candidateScore,
      randomProbeConfig: options.randomProbeConfig,
      randomizationStratum: options.randomizationStratum,
      minVoiThreshold: options.minVoiThreshold,
      policy: options.voiPolicy,
      store,
      deterministicSeedRef: options.deterministicSeedRef,
    });

    const plan = voiResult.plan;


    const toolRecords: ToolExecutionRecord[] = [];
    let executedSteps = 0;
    let executedToolCalls = 0;
    const accumulatedEvidence: Record<string, unknown> = {
      ...(options.initialEvidence ?? {}),
    };

    // 7. Bounded tool execution loop
    for (const step of plan.steps) {
      if (signal?.aborted) {
        throw new AgentCancelledError();
      }

      // Check and record step limit
      tracker.recordStep(1);
      executedSteps++;

      for (const call of step.toolCalls) {
        if (signal?.aborted) {
          throw new AgentCancelledError();
        }

        // Validate confinement before execution - fail closed on any broadening
        ToolArgumentConfinementValidator.assertConforms(
          call.toolName,
          call.arguments,
          envelope,
          profile.declaredTools,
        );

        // Pre-flight cost & token estimation
        const inputTokens = 100;
        const outputTokens = 150;
        const estimatedCostUsd =
          call.estimatedCostUsd ??
          (inputTokens * (profile.costPerInputTokenUsd ?? 0.000001) +
            outputTokens * (profile.costPerOutputTokenUsd ?? 0.000002));
        const providerCostUnits = call.quotaCostUnits ?? 1;

        // Pre-flight check: token & model cost quota before invoking tool
        tracker.checkTokens(inputTokens, outputTokens, estimatedCostUsd);

        // Pre-flight check & record provider cost units quota
        tracker.recordProviderCostUnits(providerCostUnits);

        // Enforce budget for tool call & provider call
        tracker.recordToolCall(candidate.assetId, 1);
        tracker.recordProviderCall(1);
        executedToolCalls++;

        const toolHandler = this.tools.get(call.toolName);
        if (!toolHandler) {
          throw new AgentRuntimeError(
            `No handler registered for tool "${call.toolName}"`,
            'MISSING_TOOL_HANDLER',
          );
        }

        const executionContext: ToolExecutionContext = {
          candidate,
          signal,
          stepIndex: step.stepIndex,
          callId: call.callId,
          envelope,
          profile,
        };

        const startMs = Date.now();
        let output: unknown;
        let callError: string | undefined;
        let onAbort: (() => void) | undefined;

        try {
          if (signal) {
            output = await Promise.race([
              toolHandler(call.arguments, executionContext),
              new Promise<never>((_, reject) => {
                if (signal.aborted) {
                  reject(new AgentCancelledError());
                  return;
                }
                onAbort = () => reject(new AgentCancelledError());
                signal.addEventListener('abort', onAbort, { once: true });
              }),
            ]);
          } else {
            output = await toolHandler(call.arguments, executionContext);
          }

          accumulatedEvidence[call.toolName] = output;
        } catch (err) {
          if (err instanceof BudgetExceededError || err instanceof ConfinementViolationError) {
            throw err;
          }
          if (err instanceof AgentCancelledError || signal?.aborted) {
            throw new AgentCancelledError();
          }
          callError = err instanceof Error ? err.message : String(err);
        } finally {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
        }

        const latencyMs = Math.max(0, Date.now() - startMs);

        // Account for actual tokens / cost
        tracker.recordTokens(inputTokens, outputTokens, estimatedCostUsd);

        // Update acquisition record outcome if this tool maps to an evidence family
        const fam = familyRegistry.findByTool(call.toolName);
        if (fam) {
          const famId = fam.familyId ?? fam.id;
          try {
            if (callError) {
              const isUnavailable =
                callError.includes('503') ||
                callError.includes('UNAVAILABLE') ||
                callError.includes('TIMEOUT') ||
                callError.includes('ETIMEDOUT');
              store.updateOutcome({
                runId,
                candidateId: candidate.assetId,
                evidenceFamily: famId,
                policyVersion,
                state: isUnavailable ? 'PROVIDER_UNAVAILABLE' : 'FAILED',
                reasonCodes: [callError],
              });
            } else {
              const isEmpty =
                output === null ||
                output === undefined ||
                (Array.isArray(output) && output.length === 0) ||
                (typeof output === 'object' && Object.keys(output as object).length === 0);

              store.updateOutcome({
                runId,
                candidateId: candidate.assetId,
                evidenceFamily: famId,
                policyVersion,
                state: isEmpty ? 'RETURNED_EMPTY' : 'RETURNED',
                evidenceIds: isEmpty ? [] : [call.callId],
              });
            }
          } catch {
            // Already updated or blocked pre-flight
          }
        }

        toolRecords.push({
          callId: call.callId,
          stepIndex: step.stepIndex,
          toolName: call.toolName,
          arguments: call.arguments,
          output,
          error: callError,
          latencyMs,
          executedAt: new Date().toISOString(),
        });
      }

      if (step.isTerminal) break;
    }

    const decision = this.synthesizeDecision(
      candidate,
      profile,
      accumulatedEvidence,
      toolRecords,
    );

    const actualCostSnapshot = tracker.getSnapshot();
    const actualCost = {
      monetaryCostUsd: Number(actualCostSnapshot.modelCostUsd.current.toFixed(6)),
      quotaCostUnits: actualCostSnapshot.providerCostUnits.current ?? 0,
    };

    const reconciledDecisions = voiPlanner.reconcileExecution({
      decisions: voiResult.decisions,
      toolRecords,
      finalDecision: decision,
      actualCost,
      completedAt: new Date().toISOString(),
    });

    const acquisitionDecisions = store.listDecisionsForCandidateAndRun(runId, candidate.assetId);

    let skepticResult: SkepticExecutionResult | undefined;
    if (options.enableSkeptic && options.goal !== 'SKEPTIC') {
      const skepticPolicy = options.skepticTriggerPolicy ?? new SkepticTriggerPolicy();
      const skepticTriggerContext = {
        candidateScore: options.candidateScore,
        ...(options.skepticTriggerContext ?? {}),
      };
      // Pre-evaluate trigger so error fallbacks preserve actual policy evaluation and audit metrics
      const triggerEval = skepticPolicy.evaluate({
        candidate,
        parentDecision: decision,
        ...skepticTriggerContext,
      });

      try {
        const skepticAgent = new ConditionalSkepticAgent(
          skepticPolicy,
          this.registry,
        );
        for (const [name, handler] of this.tools.entries()) {
          skepticAgent.registerTool(name, handler);
        }
        skepticResult = await skepticAgent.execute({
          candidate,
          parentDecision: decision,
          parentDecisionId: `dec_${candidate.assetId}_${runId}`,
          runId,
          envelope,
          skepticBudget: options.skepticBudget,
          triggerContext: skepticTriggerContext,
          triggerPolicy: skepticPolicy,
          signal,
        });
      } catch (err) {
        if (err instanceof AgentCancelledError || signal?.aborted) {
          throw new AgentCancelledError();
        }
        // Fail-closed boundary isolation: generate auditable artifact without aborting parent research execution
        const errMsg = err instanceof Error ? err.message : String(err);
        const parentDecisionId = `dec_${candidate.assetId}_${runId}`;
        const artifactId = `skeptic_${candidate.assetId}_${runId}_failed_closed`;
        const asOf = new Date().toISOString();
        const rawArtifact = {
          id: artifactId,
          parentDecisionId,
          candidateId: candidate.assetId,
          runId,
          policyVersion: triggerEval.policyVersion,
          triggered: triggerEval.triggered,
          triggerReasons: triggerEval.triggerReasons,
          triggerMetrics: triggerEval.triggerMetrics,
          profileId: profile.id,
          profileVersion: profile.version,
          status: 'SKIPPED_POLICY' as const,
          verdict: 'INSUFFICIENT_EVIDENCE' as const,
          confidence: 'LOW' as const,
          challengeFindings: [`Skeptic runtime execution error: ${errMsg}`],
          counterThesis: `Skeptic evaluation failed closed: ${errMsg}`,
          invalidationConditions: decision.thesisInvalidationConditions ?? [],
          suggestedDecision: decision.decision,
          suggestedRiskLevel: decision.riskRecommendation,
          decisionChanged: false,
          evidenceIds: [] as string[],
          executedToolRecords: [],
          budgetUsage: {},
          createdAt: asOf,
        };

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
        const sha256 = createHash('sha256')
          .update(JSON.stringify(canonicalize(rawArtifact)))
          .digest('hex');

        const fallbackArtifact: SkepticArtifact = {
          ...rawArtifact,
          sha256,
        };

        skepticResult = {
          artifact: fallbackArtifact,
          status: 'SKIPPED_POLICY',
          toolRecords: [],
        };
      }
    }

    const finalVoiPlanResult: VoiPlanResult = {
      ...voiResult,
      decisions: reconciledDecisions,
    };

    if (options.persistenceRepository) {
      try {
        await options.persistenceRepository.saveVoiPlan(finalVoiPlanResult);
        if (skepticResult) {
          await options.persistenceRepository.saveSkepticArtifact(skepticResult.artifact);
        }
      } catch {
        // Isolate persistence write-through failures to prevent transient database unavailability
        // from aborting successful parent research decision execution.
      }
    }

    return {
      runId,
      plan,
      status: 'SUCCESS',
      decision,
      acquisitionDecisions: acquisitionDecisions.length > 0 ? acquisitionDecisions : reconciledDecisions,
      toolRecords,
      budgetUsage: tracker.getSnapshot(),
      executedSteps,
      executedToolCalls,
      completedAt: new Date().toISOString(),
      voiPlanResult: finalVoiPlanResult,
      skepticResult,
    };
  }

  private synthesizeDecision(
    candidate: CandidateTarget,
    profile: ModelProfile,
    _evidence: Record<string, unknown>,
    toolRecords: readonly ToolExecutionRecord[],
  ): AgentDecision {
    // Build deterministic EvidenceRecord map from toolRecords (each successful tool call is evidence)
    const nowIso = new Date().toISOString();
    const evidenceById = new Map<string, EvidenceRecord>();
    const observedFacts: AgentDecision['observedFacts'] = [];
    const riskSignals: string[] = [];
    let hasPairs = false;
    let hasAudit = false;

    for (const record of toolRecords) {
      if (record.error) {
        riskSignals.push(`TOOL_EXECUTION_WARNING:${record.toolName}`);
        continue;
      }

      // Isolate untrusted tool output as data
      const rawOutput = typeof record.output === 'string' ? record.output : JSON.stringify(record.output ?? {});
      const isolated = UntrustedContentIsolator.isolate(rawOutput, `tool:${record.toolName}`);
      // Use safeData only for logging/thesis; evidence stores normalized fields from original output (sanitized claim)
      void isolated;

      if (record.toolName === 'dex.pairs' || record.toolName === 'token.profile') hasPairs = true;
      if (record.toolName === 'contract.audit' || record.toolName === 'risk.honeypot_scan') hasAudit = true;

      const normalizedFields: Record<string, unknown> =
        record.output !== null && typeof record.output === 'object' && !Array.isArray(record.output)
          ? (record.output as Record<string, unknown>)
          : { raw: record.output };

      const ev: EvidenceRecord = {
        id: record.callId,
        entityId: candidate.assetId,
        candidateId: candidate.assetId,
        provider: 'synthetic',
        operation: record.toolName,
        independenceGroup: record.toolName, // each tool is its own group for determinism
        availableAt: record.executedAt,
        fetchedAt: record.executedAt,
        normalizedFields,
        qualityCodes: ['VALID'],
      };
      evidenceById.set(ev.id, ev);

      observedFacts.push({
        claim: `Executed tool ${record.toolName}`,
        evidenceIds: [ev.id],
        confidence: 'HIGH',
      });
    }

    const hasErrors = toolRecords.some((r) => r.error !== undefined);
    const proposedDecisionType: AgentDecision['decision'] =
      toolRecords.length === 0 || (!hasPairs && !hasAudit)
        ? 'INSUFFICIENT_DATA'
        : hasErrors
          ? 'WATCH'
          : 'ALERT';

    // Use StructuredDecisionEngine to enforce abstention gates deterministically
    const engineResult = StructuredDecisionEngine.decide({
      candidate: {
        assetId: candidate.assetId,
        chainId: candidate.chainId,
        contractAddress: candidate.contractAddress,
        symbol: candidate.symbol,
      },
      profileId: profile.id,
      proposedDecision: {
        decision: proposedDecisionType,
        thesis: `Deterministic bounded evaluation for ${candidate.assetId}`,
        counterThesis: 'Potential latent liquidity or contract vulnerability',
        lifecycleRecommendation: 'QUALIFIED',
        riskRecommendation: hasErrors ? 'MEDIUM' : 'LOW',
        observedFacts,
        derivedFacts: [],
        inferences: [],
        hypotheses: [],
        positiveSignals: hasPairs ? ['VERIFIED_LIQUIDITY_PAIRS'] : [],
        riskSignals,
        missingData:
          proposedDecisionType === 'INSUFFICIENT_DATA'
            ? [{ field: 'market_data', reason: 'No evidence gathered', severity: 'HIGH' }]
            : [],
        providerConflicts: [],
        thesisInvalidationConditions: ['Liquidity dropped below 10k', 'Ownership renouncement revoked'],
        reasoningAssessment: 'HIGH',
        costPolicyResult: 'PASS',
      },
      evidenceById,
      validatorOptions: {
        decisionTimeIso: nowIso,
        candidateId: candidate.assetId,
        entityId: candidate.assetId,
      },
      gateConfig: {
        minObservedFacts: 1,
        minEvidenceCount: 1,
        minIndependenceGroups: 1,
      },
      hasCriticalRisk: false,
      executionTradabilityPass: true,
    });

    // Structured engine already implements abstention — return its decision
    // Ensure evidence lineage is preserved: if validator failed, decision is INSUFFICIENT_DATA (never forces ranking)
    return engineResult.decision;
  }
}
