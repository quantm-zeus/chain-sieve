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
} from './errors.js';
import { ModelProfileRegistry } from './model-profiles.js';

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

    // 2. Budget tracker setup
    const tracker = new AgentBudgetTracker(budget);

    // 3. Pre-flight cancellation check
    if (signal?.aborted) {
      throw new AgentCancelledError();
    }

    // 4. Generate deterministic plan
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

        // Enforce budget for tool call & simulated provider call
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

        const startMs = Date.now();
        let output: unknown;
        let callError: string | undefined;

        try {
          output = await Promise.race([
            toolHandler(call.arguments, {
              candidate,
              signal,
              stepIndex: step.stepIndex,
              callId: call.callId,
              envelope,
              profile,
            }),
            new Promise((_, reject) => {
              if (signal) {
                const onAbort = () => {
                  signal.removeEventListener('abort', onAbort);
                  reject(new AgentCancelledError());
                };
                signal.addEventListener('abort', onAbort);
              }
            }),
          ]);

          accumulatedEvidence[call.toolName] = output;
        } catch (err) {
          if (err instanceof AgentCancelledError || signal?.aborted) {
            throw new AgentCancelledError();
          }
          if (err instanceof BudgetExceededError) {
            throw err;
          }
          callError = err instanceof Error ? err.message : String(err);
        }

        const latencyMs = Math.max(0, Date.now() - startMs);

        // Account for simulated tokens / cost
        const inputTokens = 100;
        const outputTokens = 150;
        const costUsd =
          inputTokens * (profile.costPerInputTokenUsd ?? 0.000001) +
          outputTokens * (profile.costPerOutputTokenUsd ?? 0.000002);
        tracker.recordTokens(inputTokens, outputTokens, costUsd);

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

    return {
      plan,
      status: 'SUCCESS',
      decision,
      toolRecords,
      budgetUsage: tracker.getSnapshot(),
      executedSteps,
      executedToolCalls,
      completedAt: new Date().toISOString(),
    };
  }

  private synthesizeDecision(
    candidate: CandidateTarget,
    profile: ModelProfile,
    evidence: Record<string, unknown>,
    toolRecords: readonly ToolExecutionRecord[],
  ): AgentDecision {
    const hasAudit = 'contract.audit' in evidence || 'risk.honeypot_scan' in evidence;
    const hasPairs = 'dex.pairs' in evidence || 'token.profile' in evidence;

    const hasErrors = toolRecords.some((r) => r.error !== undefined);
    const decisionType =
      toolRecords.length === 0 || (!hasPairs && !hasAudit)
        ? 'INSUFFICIENT_DATA'
        : hasErrors
          ? 'WATCH'
          : 'ALERT';

    return {
      candidate: {
        assetId: candidate.assetId,
        chainId: candidate.chainId,
        contractAddress: candidate.contractAddress,
        symbol: candidate.symbol,
      },
      profileId: profile.id,
      decision: decisionType,
      costPolicyResult: 'PASS',
      lifecycleRecommendation: 'QUALIFIED',
      riskRecommendation: 'LOW',
      thesis: `Deterministic bounded evaluation for ${candidate.assetId}`,
      counterThesis: 'Potential latent liquidity or contract vulnerability',
      observedFacts: toolRecords.map((r) => ({
        claim: `Executed tool ${r.toolName}`,
        evidenceIds: [r.callId],
        confidence: 'HIGH',
      })),
      derivedFacts: [],
      inferences: [],
      hypotheses: [],
      positiveSignals: hasPairs ? ['VERIFIED_LIQUIDITY_PAIRS'] : [],
      riskSignals: hasErrors ? ['TOOL_EXECUTION_WARNING'] : [],
      missingData:
        decisionType === 'INSUFFICIENT_DATA'
          ? [
              {
                field: 'market_data',
                reason: 'No evidence gathered',
                severity: 'HIGH',
              },
            ]
          : [],
      providerConflicts: [],
      thesisInvalidationConditions: [
        'Liquidity dropped below 10k',
        'Ownership renouncement revoked',
      ],
      reasoningAssessment: 'HIGH',
    };
  }
}
