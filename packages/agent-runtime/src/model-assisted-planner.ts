import { createHash } from 'node:crypto';
import type {
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { ToolArgumentConfinementValidator } from './confinement.js';
import {
  type CandidateTarget,
  type DeterministicPlan,
  type PlannedToolCall,
  type PlannerInput,
  type PlanStep,
} from './deterministic-planner.js';
import { ConfinementViolationError } from './errors.js';

export interface ModelToolSuggestion {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
  purpose?: string | undefined;
}

export interface ModelAssistedPlannerInput extends PlannerInput {
  modelSuggestions?: readonly ModelToolSuggestion[] | undefined;
  modelAdvisorId?: string | undefined;
}

function stableHash(value: unknown): string {
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
  const json = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(json).digest('hex');
}

export class ModelAssistedPlanner {
  /**
   * Generates a model-assisted execution plan bounded by symmetric budgets and
   * strictly confined within the authorization envelope.
   *
   * @requirement FR-AGT-011 (Model-assisted planner evaluation)
   * @requirement FR-AGT-012 (Model-generated tool arguments cannot broaden provider scope, URL, chain, address set, time range, output size, or cost beyond envelope)
   */
  public static plan(input: ModelAssistedPlannerInput): DeterministicPlan {
    const { candidate, profile, envelope, budget } = input;
    const goal = input.goal ?? (profile.modelClass as PlannerInput['goal']) ?? 'DEEP_RESEARCH';

    // 1. Intersect profile declared tools with envelope allowed tools
    const availableTools = profile.declaredTools
      .filter((tool) => envelope.allowedTools.includes(tool))
      .sort((a, b) => a.localeCompare(b));

    const maxSteps = Math.min(budget.maxSteps, 6);
    const maxCalls = budget.maxToolCalls;
    const maxCostUsd = budget.maxModelCostUsd;
    const maxProviderUnits = budget.maxProviderCostUnits;

    let toolCallSeq = 1;
    let totalPlannedCalls = 0;
    let totalCost = 0;
    let totalProviderUnits = 0;
    const steps: PlanStep[] = [];

    // If model suggestions provided, validate each suggestion against envelope and declared tools
    const validSuggestions: PlannedToolCall[] = [];

    if (input.modelSuggestions && input.modelSuggestions.length > 0) {
      for (const suggestion of input.modelSuggestions) {
        if (!availableTools.includes(suggestion.toolName)) {
          // Reject tools not in available/allowed tools
          continue;
        }

        const estimatedCost = (profile.costPerInputTokenUsd ?? 0.000001) * 500;
        const quotaCostUnits = 1;

        if (maxCostUsd !== undefined && totalCost + estimatedCost > maxCostUsd) break;
        if (maxProviderUnits !== undefined && totalProviderUnits + quotaCostUnits > maxProviderUnits) break;
        if (totalPlannedCalls + validSuggestions.length >= maxCalls) break;

        // Build base arguments conforming to envelope
        const candidateArgs: Record<string, unknown> = {
          chain: candidate.chainId,
          address: candidate.contractAddress,
          ...(suggestion.arguments ?? {}),
        };

        if (envelope.timeRange?.maxTimestamp) {
          candidateArgs.asOf = envelope.timeRange.maxTimestamp;
        }
        if (envelope.maxLimit !== undefined) {
          candidateArgs.limit = Math.min(
            envelope.maxLimit,
            typeof candidateArgs.limit === 'number' ? candidateArgs.limit : envelope.maxLimit,
          );
        }

        // Validate confinement strictly (FR-AGT-012)
        try {
          ToolArgumentConfinementValidator.assertConforms(
            suggestion.toolName,
            candidateArgs,
            envelope,
            profile.declaredTools,
          );
        } catch (err) {
          if (err instanceof ConfinementViolationError) {
            // Drop invalid/unconfined suggestion
            continue;
          }
          throw err;
        }

        totalCost += estimatedCost;
        totalProviderUnits += quotaCostUnits;

        validSuggestions.push({
          callId: `model_call_${candidate.assetId}_${toolCallSeq++}`,
          toolName: suggestion.toolName,
          arguments: candidateArgs,
          purpose: suggestion.purpose ?? `Model-assisted execution of ${suggestion.toolName}`,
          estimatedCostUsd: estimatedCost,
          quotaCostUnits,
        });
      }
    }

    // If suggestions were validated, assemble into steps
    if (validSuggestions.length > 0) {
      const chunkSize = 2;
      for (let i = 0; i < validSuggestions.length && steps.length < maxSteps; i += chunkSize) {
        const stepCalls = validSuggestions.slice(i, i + chunkSize);
        steps.push({
          stepIndex: steps.length,
          stage: `MODEL_ASSISTED_STAGE_${steps.length + 1}`,
          toolCalls: stepCalls,
          isTerminal: i + chunkSize >= validSuggestions.length || steps.length + 1 >= maxSteps,
        });
      }
    } else {
      // Fallback to structured sequence bounded by available tools
      const stages = this.buildModelAssistedStages(goal, availableTools);
      for (let stepIndex = 0; stepIndex < Math.min(maxSteps, stages.length); stepIndex++) {
        if (totalPlannedCalls >= maxCalls) break;
        const stage = stages[stepIndex];
        if (!stage) break;

        const stepCalls: PlannedToolCall[] = [];
        for (const toolName of stage.tools) {
          if (totalPlannedCalls + stepCalls.length >= maxCalls) break;
          const estimatedCost = (profile.costPerInputTokenUsd ?? 0.000001) * 500;
          const quotaCostUnits = 1;

          if (maxCostUsd !== undefined && totalCost + estimatedCost > maxCostUsd) break;
          if (maxProviderUnits !== undefined && totalProviderUnits + quotaCostUnits > maxProviderUnits) break;

          const callArgs = this.generateConformedArguments(toolName, candidate, envelope);
          ToolArgumentConfinementValidator.assertConforms(toolName, callArgs, envelope, profile.declaredTools);

          totalCost += estimatedCost;
          totalProviderUnits += quotaCostUnits;

          stepCalls.push({
            callId: `model_call_${candidate.assetId}_${stepIndex}_${toolCallSeq++}`,
            toolName,
            arguments: callArgs,
            purpose: `Execute ${toolName} for stage ${stage.name}`,
            estimatedCostUsd: estimatedCost,
            quotaCostUnits,
          });
        }

        if (stepCalls.length === 0 && steps.length > 0) break;
        totalPlannedCalls += stepCalls.length;
        steps.push({
          stepIndex,
          stage: stage.name,
          toolCalls: stepCalls,
          isTerminal: stepIndex === stages.length - 1 || totalPlannedCalls >= maxCalls,
        });
      }
    }

    if (steps.length === 0) {
      steps.push({
        stepIndex: 0,
        stage: 'EVALUATION',
        toolCalls: [],
        isTerminal: true,
      });
    } else {
      steps[steps.length - 1]!.isTerminal = true;
    }

    const planDataForHash = {
      candidateId: candidate.assetId,
      chainId: candidate.chainId,
      contractAddress: candidate.contractAddress,
      profileId: profile.id,
      profileVersion: profile.version,
      plannerType: 'MODEL_ASSISTED',
      modelAdvisorId: input.modelAdvisorId ?? 'default-advisor',
      seed: input.deterministicSeedRef ?? 'model-seed-default',
      steps: steps.map((s) => ({
        stepIndex: s.stepIndex,
        stage: s.stage,
        toolCalls: s.toolCalls.map((c) => ({
          toolName: c.toolName,
          arguments: c.arguments,
        })),
      })),
    };

    const planId = `plan_model_${candidate.assetId}_${stableHash(planDataForHash).slice(0, 16)}`;

    return {
      planId,
      candidateId: candidate.assetId,
      profileId: profile.id,
      profileVersion: profile.version,
      steps,
      totalPlannedToolCalls: steps.reduce((sum, s) => sum + s.toolCalls.length, 0),
      totalEstimatedCostUsd: totalCost,
      envelope,
      maxSteps: budget.maxSteps,
      generatedAt: envelope.timeRange?.maxTimestamp ?? new Date().toISOString(),
    };
  }

  private static buildModelAssistedStages(
    goal: PlannerInput['goal'],
    availableTools: readonly string[],
  ): Array<{ name: string; tools: string[] }> {
    const has = (name: string) => availableTools.includes(name);

    if (goal === 'DEEP_RESEARCH') {
      const s1 = ['dex.pairs', 'dex.screener', 'token.profile'].filter(has);
      const s2 = ['holder.distribution', 'pool.liquidity', 'contract.audit'].filter(has);
      const s3 = ['simulation.execution', 'signal.score'].filter(has);

      return [
        { name: 'TARGETED_DISCOVERY', tools: s1 },
        { name: 'DEEP_VERIFICATION', tools: s2 },
        { name: 'FINANCIAL_SIMULATION', tools: s3 },
      ].filter((s) => s.tools.length > 0);
    }

    const s1 = ['token.profile', 'market.summary', 'dex.pairs'].filter(has);
    const unassigned = availableTools.filter((t) => !s1.includes(t));

    return [
      { name: 'PRIMARY_DISCOVERY', tools: s1 },
      { name: 'SUPPLEMENTARY_TOOLS', tools: unassigned },
    ].filter((s) => s.tools.length > 0);
  }

  private static generateConformedArguments(
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
    if (envelope.maxLimit !== undefined) {
      baseArgs.limit = Math.min(50, envelope.maxLimit);
    }

    switch (toolName) {
      case 'dex.pairs':
      case 'dex.screener':
      case 'pool.liquidity':
        return { ...baseArgs, pairAddress: candidate.contractAddress };
      case 'holder.distribution':
        return { ...baseArgs, mint: candidate.contractAddress, limit: Math.min(50, envelope.maxLimit ?? 50) };
      case 'contract.audit':
      case 'risk.honeypot_scan':
      case 'liquidity.lock':
        return { ...baseArgs, contractAddress: candidate.contractAddress };
      case 'simulation.sell':
      case 'simulation.execution':
        return { ...baseArgs, notionalUsd: 1000 };
      default:
        return baseArgs;
    }
  }
}
