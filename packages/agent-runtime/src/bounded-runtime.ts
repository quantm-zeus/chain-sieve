import type {
  AgentBudget,
  AgentDecision,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { AgentBudgetTracker, type BudgetUsageSnapshot } from './budget-tracker.js';
import { ToolArgumentConfinementValidator } from './confinement.js';
import {
  DeterministicPlanner,
  type CandidateTarget,
  type DeterministicPlan,
} from './deterministic-planner.js';
import {
  AgentCancelledError,
  AgentRuntimeError,
  BudgetExceededError,
  ConfinementViolationError,
} from './errors.js';
import { ModelProfileRegistry } from './model-profiles.js';
import { VoiPlanner, type VoiPlanResult, type VoiPolicy } from './voi-planner.js';
import {
  ConditionalSkepticAgent,
  type SkepticExecutionResult,
  type SkepticTriggerPolicy,
  type SkepticTriggerContext,
} from './conditional-skeptic.js';
import { StructuredDecisionEngine } from './decision-engine.js';
import { type EvidenceRecord } from './evidence-validator.js';
import { UntrustedContentIsolator } from './untrusted-isolation.js';
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
  plan: DeterministicPlan;
  status: 'SUCCESS' | 'ABSTAINED' | 'BUDGET_EXCEEDED' | 'CANCELLED' | 'FAILED';
  decision: AgentDecision;
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

    // 6. Generate deterministic plan
    const plan = DeterministicPlanner.plan({
      candidate,
      profile,
      envelope,
      budget,
      goal: options.goal,
      initialEvidence: options.initialEvidence,
      deterministicSeedRef: options.deterministicSeedRef,
    });

    const toolRecords: ToolExecutionRecord[] = [];
    let executedSteps = 0;
    let executedToolCalls = 0;
    const accumulatedEvidence: Record<string, unknown> = {
      ...(options.initialEvidence ?? {}),
    };

    // Synthesize baseline decision prior to evidence acquisition
    const baselineDecision = this.synthesizeDecision(
      candidate,
      profile,
      accumulatedEvidence,
      [],
    );

    // Pre-execution VOI planning: evaluate EVOI and establish per-family acquisition plan
    let initialVoiPlan: VoiPlanResult | undefined;
    let voiPlanner: VoiPlanner | undefined;
    if (options.enableVoi) {
      voiPlanner = new VoiPlanner(options.voiPolicy);
      initialVoiPlan = voiPlanner.planAcquisitions({
        candidate,
        runId: plan.planId,
        envelope,
        budget,
        profile,
        currentCandidateScore: options.candidateScore,
        knownEvidence: accumulatedEvidence,
        randomizationStratum: options.randomizationStratum,
      });
    }

    // 5. Bounded tool execution loop
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

    let voiPlanResult: VoiPlanResult | undefined;
    if (options.enableVoi) {
      if (!voiPlanner) {
        voiPlanner = new VoiPlanner(options.voiPolicy);
      }
      const planToReconcile = initialVoiPlan ?? voiPlanner.planAcquisitions({
        candidate,
        runId: plan.planId,
        envelope,
        budget,
        profile,
        currentCandidateScore: options.candidateScore,
        knownEvidence: accumulatedEvidence,
        randomizationStratum: options.randomizationStratum,
      });

      const actualCostSnapshot = tracker.getSnapshot();
      const actualCost = {
        monetaryCostUsd: Number(actualCostSnapshot.modelCostUsd.current.toFixed(6)),
        quotaCostUnits: actualCostSnapshot.providerCostUnits.current ?? 0,
      };

      planToReconcile.decisions = voiPlanner.reconcileDecisions({
        decisions: planToReconcile.decisions,
        toolRecords,
        previousDecision: baselineDecision,
        finalDecision: decision,
        actualCost,
        completedAt: new Date().toISOString(),
      });
      voiPlanResult = planToReconcile;
    }

    let skepticResult: SkepticExecutionResult | undefined;
    if (options.enableSkeptic && options.goal !== 'SKEPTIC') {
      const skepticAgent = new ConditionalSkepticAgent(
        options.skepticTriggerPolicy,
        this.registry,
      );
      for (const [name, handler] of this.tools.entries()) {
        skepticAgent.registerTool(name, handler);
      }
      skepticResult = await skepticAgent.execute({
        candidate,
        parentDecision: decision,
        parentDecisionId: `dec_${candidate.assetId}_${plan.planId}`,
        runId: plan.planId,
        envelope,
        skepticBudget: options.skepticBudget,
        triggerContext: {
          candidateScore: options.candidateScore,
          ...(options.skepticTriggerContext ?? {}),
        },
        signal,
      });
    }

    if (options.persistenceRepository) {
      if (voiPlanResult) {
        await options.persistenceRepository.saveVoiPlan(voiPlanResult);
      }
      if (skepticResult) {
        await options.persistenceRepository.saveSkepticArtifact(skepticResult.artifact);
      }
    }

    return {
      plan,
      status: 'SUCCESS',
      decision,
      toolRecords,
      budgetUsage: tracker.getSnapshot(),
      executedSteps,
      executedToolCalls,
      completedAt: new Date().toISOString(),
      voiPlanResult,
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
