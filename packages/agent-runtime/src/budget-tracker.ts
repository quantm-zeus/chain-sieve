import type { AgentBudget } from '@ciag/shared-schemas';
import { BudgetExceededError } from './errors.js';

export interface BudgetUsageSnapshot {
  steps: { current: number; limit: number; remaining: number };
  toolCalls: { current: number; limit: number; remaining: number };
  toolCallsByCandidate: Record<string, number>;
  providerCalls: { current: number; limit?: number; remaining?: number };
  inputTokens: { current: number; limit?: number; remaining?: number };
  outputTokens: { current: number; limit?: number; remaining?: number };
  modelCostUsd: { current: number; limit?: number; remaining?: number };
  providerCostUnits: { current: number; limit?: number; remaining?: number };
  deadlineAt?: string;
  isExpired: boolean;
}

export class AgentBudgetTracker {
  private currentSteps = 0;
  private currentToolCalls = 0;
  private readonly toolCallsByCandidate = new Map<string, number>();
  private currentProviderCalls = 0;
  private currentInputTokens = 0;
  private currentOutputTokens = 0;
  private currentModelCostUsd = 0;
  private currentProviderCostUnits = 0;

  constructor(public readonly budget: AgentBudget) {}

  public checkDeadline(): void {
    if (!this.budget.deadlineAt) return;
    const deadlineMs = new Date(this.budget.deadlineAt).getTime();
    const nowMs = Date.now();
    if (nowMs >= deadlineMs) {
      throw new BudgetExceededError('DEADLINE', nowMs, deadlineMs, 0);
    }
  }

  public checkStep(requested = 1): void {
    this.checkDeadline();
    if (this.currentSteps + requested > this.budget.maxSteps) {
      throw new BudgetExceededError(
        'STEPS',
        this.currentSteps,
        this.budget.maxSteps,
        requested,
      );
    }
  }

  public recordStep(count = 1): void {
    this.checkStep(count);
    this.currentSteps += count;
  }

  public checkToolCall(candidateId?: string, requested = 1): void {
    this.checkDeadline();
    if (this.currentToolCalls + requested > this.budget.maxToolCalls) {
      throw new BudgetExceededError(
        'TOOL_CALLS',
        this.currentToolCalls,
        this.budget.maxToolCalls,
        requested,
      );
    }

    if (candidateId && this.budget.maxToolCallsPerCandidate !== undefined) {
      const currentForCandidate = this.toolCallsByCandidate.get(candidateId) ?? 0;
      if (currentForCandidate + requested > this.budget.maxToolCallsPerCandidate) {
        throw new BudgetExceededError(
          'TOOL_CALLS_PER_CANDIDATE',
          currentForCandidate,
          this.budget.maxToolCallsPerCandidate,
          requested,
        );
      }
    }
  }

  public recordToolCall(candidateId?: string, count = 1): void {
    this.checkToolCall(candidateId, count);
    this.currentToolCalls += count;
    if (candidateId) {
      const current = this.toolCallsByCandidate.get(candidateId) ?? 0;
      this.toolCallsByCandidate.set(candidateId, current + count);
    }
  }

  public checkProviderCall(requested = 1): void {
    this.checkDeadline();
    if (
      this.budget.maxProviderCalls !== undefined &&
      this.currentProviderCalls + requested > this.budget.maxProviderCalls
    ) {
      throw new BudgetExceededError(
        'PROVIDER_CALLS',
        this.currentProviderCalls,
        this.budget.maxProviderCalls,
        requested,
      );
    }
  }

  public recordProviderCall(count = 1): void {
    this.checkProviderCall(count);
    this.currentProviderCalls += count;
  }

  public checkTokens(
    inputTokens = 0,
    outputTokens = 0,
    estimatedCostUsd = 0,
  ): void {
    this.checkDeadline();
    if (
      this.budget.maxInputTokens !== undefined &&
      this.currentInputTokens + inputTokens > this.budget.maxInputTokens
    ) {
      throw new BudgetExceededError(
        'INPUT_TOKENS',
        this.currentInputTokens,
        this.budget.maxInputTokens,
        inputTokens,
      );
    }
    if (
      this.budget.maxOutputTokens !== undefined &&
      this.currentOutputTokens + outputTokens > this.budget.maxOutputTokens
    ) {
      throw new BudgetExceededError(
        'OUTPUT_TOKENS',
        this.currentOutputTokens,
        this.budget.maxOutputTokens,
        outputTokens,
      );
    }
    if (
      this.budget.maxModelCostUsd !== undefined &&
      this.currentModelCostUsd + estimatedCostUsd > this.budget.maxModelCostUsd
    ) {
      throw new BudgetExceededError(
        'MODEL_COST_USD',
        this.currentModelCostUsd,
        this.budget.maxModelCostUsd,
        estimatedCostUsd,
      );
    }
  }

  public recordTokens(
    inputTokens: number,
    outputTokens: number,
    costUsd = 0,
  ): void {
    this.checkTokens(inputTokens, outputTokens, costUsd);
    this.currentInputTokens += inputTokens;
    this.currentOutputTokens += outputTokens;
    this.currentModelCostUsd += costUsd;
  }

  public checkProviderCostUnits(requestedUnits = 0): void {
    this.checkDeadline();
    if (
      this.budget.maxProviderCostUnits !== undefined &&
      this.currentProviderCostUnits + requestedUnits >
        this.budget.maxProviderCostUnits
    ) {
      throw new BudgetExceededError(
        'PROVIDER_COST_UNITS',
        this.currentProviderCostUnits,
        this.budget.maxProviderCostUnits,
        requestedUnits,
      );
    }
  }

  public recordProviderCostUnits(units: number): void {
    this.checkProviderCostUnits(units);
    this.currentProviderCostUnits += units;
  }

  public getSnapshot(): BudgetUsageSnapshot {
    const isExpired = this.budget.deadlineAt
      ? Date.now() >= new Date(this.budget.deadlineAt).getTime()
      : false;

    return {
      steps: {
        current: this.currentSteps,
        limit: this.budget.maxSteps,
        remaining: Math.max(0, this.budget.maxSteps - this.currentSteps),
      },
      toolCalls: {
        current: this.currentToolCalls,
        limit: this.budget.maxToolCalls,
        remaining: Math.max(0, this.budget.maxToolCalls - this.currentToolCalls),
      },
      toolCallsByCandidate: Object.fromEntries(this.toolCallsByCandidate),
      providerCalls: {
        current: this.currentProviderCalls,
        limit: this.budget.maxProviderCalls,
        remaining:
          this.budget.maxProviderCalls !== undefined
            ? Math.max(0, this.budget.maxProviderCalls - this.currentProviderCalls)
            : undefined,
      },
      inputTokens: {
        current: this.currentInputTokens,
        limit: this.budget.maxInputTokens,
        remaining:
          this.budget.maxInputTokens !== undefined
            ? Math.max(0, this.budget.maxInputTokens - this.currentInputTokens)
            : undefined,
      },
      outputTokens: {
        current: this.currentOutputTokens,
        limit: this.budget.maxOutputTokens,
        remaining:
          this.budget.maxOutputTokens !== undefined
            ? Math.max(0, this.budget.maxOutputTokens - this.currentOutputTokens)
            : undefined,
      },
      modelCostUsd: {
        current: this.currentModelCostUsd,
        limit: this.budget.maxModelCostUsd,
        remaining:
          this.budget.maxModelCostUsd !== undefined
            ? Math.max(0, this.budget.maxModelCostUsd - this.currentModelCostUsd)
            : undefined,
      },
      providerCostUnits: {
        current: this.currentProviderCostUnits,
        limit: this.budget.maxProviderCostUnits,
        remaining:
          this.budget.maxProviderCostUnits !== undefined
            ? Math.max(
                0,
                this.budget.maxProviderCostUnits - this.currentProviderCostUnits,
              )
            : undefined,
      },
      deadlineAt: this.budget.deadlineAt,
      isExpired,
    };
  }
}
