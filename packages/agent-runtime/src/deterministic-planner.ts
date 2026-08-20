import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { ToolArgumentConfinementValidator } from './confinement.js';

export interface PlannedToolCall {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  purpose: string;
  estimatedCostUsd?: number | undefined;
  quotaCostUnits?: number | undefined;
}

export interface PlanStep {
  stepIndex: number;
  stage: string;
  toolCalls: PlannedToolCall[];
  isTerminal: boolean;
}

export interface DeterministicPlan {
  planId: string;
  candidateId: string;
  profileId: string;
  profileVersion: string;
  steps: PlanStep[];
  totalPlannedToolCalls: number;
  totalEstimatedCostUsd: number;
  envelope: ToolAuthorizationEnvelope;
  maxSteps: number;
  generatedAt: string;
}

export interface CandidateTarget {
  assetId: string;
  chainId: string;
  contractAddress: string;
  symbol?: string | undefined;
}

export interface PlannerInput {
  candidate: CandidateTarget;
  goal?: 'TRIAGE' | 'DEEP_RESEARCH' | 'SKEPTIC' | 'ADMIN_CHAT' | 'REPAIR' | undefined;
  profile: ModelProfile;
  envelope: ToolAuthorizationEnvelope;
  budget: AgentBudget;
  initialEvidence?: Record<string, unknown> | undefined;
  requestedEvidenceFamilies?: readonly string[] | undefined;
  deterministicSeedRef?: string | number | undefined;
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

export class DeterministicPlanner {
  /**
   * Generates a deterministic, bounded execution plan.
   * Identical inputs are guaranteed to produce the exact identical plan.
   */
  public static plan(input: PlannerInput): DeterministicPlan {
    const { candidate, profile, envelope, budget } = input;
    const goal = input.goal ?? (profile.modelClass as PlannerInput['goal']) ?? 'TRIAGE';

    // 1. Intersect profile declared tools with envelope allowed tools
    const availableTools = profile.declaredTools
      .filter((tool) => envelope.allowedTools.includes(tool))
      .sort((a, b) => a.localeCompare(b)); // Sort for deterministic order

    // 2. Stage mapping based on goal and available tools
    const stages = this.buildStageSequence(goal, availableTools);

    // 3. Construct bounded steps
    const steps: PlanStep[] = [];
    let toolCallSeq = 1;
    let totalPlannedCalls = 0;
    let totalCost = 0;
    let totalProviderUnits = 0;
    const maxSteps = Math.min(budget.maxSteps, stages.length > 0 ? stages.length : 1);
    const maxCalls = budget.maxToolCalls;
    const maxCostUsd = budget.maxModelCostUsd;
    const maxProviderUnits = budget.maxProviderCostUnits;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
      if (totalPlannedCalls >= maxCalls) break;
      if (maxCostUsd !== undefined && totalCost >= maxCostUsd) break;
      if (maxProviderUnits !== undefined && totalProviderUnits >= maxProviderUnits) break;

      const stage = stages[stepIndex];
      if (!stage) break;

      const stepCalls: PlannedToolCall[] = [];

      for (const toolName of stage.tools) {
        if (totalPlannedCalls + stepCalls.length >= maxCalls) break;

        const estimatedCost = this.estimateToolCost(toolName, profile);
        const quotaCostUnits = 1;

        if (maxCostUsd !== undefined && totalCost + estimatedCost > maxCostUsd) {
          break;
        }
        if (maxProviderUnits !== undefined && totalProviderUnits + quotaCostUnits > maxProviderUnits) {
          break;
        }

        const callArgs = this.generateDeterministicArguments(
          toolName,
          candidate,
          envelope,
        );

        // Verify confinement for generated arguments immediately
        ToolArgumentConfinementValidator.assertConforms(
          toolName,
          callArgs,
          envelope,
          profile.declaredTools,
        );

        totalCost += estimatedCost;
        totalProviderUnits += quotaCostUnits;

        const callId = `call_${candidate.assetId}_${stepIndex}_${toolCallSeq++}`;
        stepCalls.push({
          callId,
          toolName,
          arguments: callArgs,
          purpose: `Execute ${toolName} for stage ${stage.name}`,
          estimatedCostUsd: estimatedCost,
          quotaCostUnits,
        });
      }

      if (stepCalls.length === 0 && steps.length > 0) {
        break;
      }

      totalPlannedCalls += stepCalls.length;
      const isTerminal =
        stepIndex === maxSteps - 1 ||
        totalPlannedCalls >= maxCalls ||
        (maxCostUsd !== undefined && totalCost >= maxCostUsd) ||
        (maxProviderUnits !== undefined && totalProviderUnits >= maxProviderUnits);

      steps.push({
        stepIndex,
        stage: stage.name,
        toolCalls: stepCalls,
        isTerminal,
      });

      if (
        (maxCostUsd !== undefined && totalCost >= maxCostUsd) ||
        (maxProviderUnits !== undefined && totalProviderUnits >= maxProviderUnits)
      ) {
        break;
      }
    }

    // Ensure at least one step and ensure the final step is terminal
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
      goal,
      seed: input.deterministicSeedRef ?? 'deterministic-default',
      steps: steps.map((s) => ({
        stepIndex: s.stepIndex,
        stage: s.stage,
        toolCalls: s.toolCalls.map((c) => ({
          toolName: c.toolName,
          arguments: c.arguments,
        })),
      })),
    };

    const planId = `plan_${candidate.assetId}_${stableHash(planDataForHash).slice(0, 16)}`;

    return {
      planId,
      candidateId: candidate.assetId,
      profileId: profile.id,
      profileVersion: profile.version,
      steps,
      totalPlannedToolCalls: totalPlannedCalls,
      totalEstimatedCostUsd: totalCost,
      envelope,
      maxSteps: budget.maxSteps,
      generatedAt: envelope.timeRange?.maxTimestamp ?? new Date(0).toISOString(),
    };
  }

  private static buildStageSequence(
    goal: PlannerInput['goal'],
    availableTools: readonly string[],
  ): Array<{ name: string; tools: string[] }> {
    const has = (name: string) => availableTools.includes(name);

    if (goal === 'SKEPTIC') {
      const stage1: string[] = [];
      if (has('risk.honeypot_scan')) stage1.push('risk.honeypot_scan');
      if (has('contract.audit')) stage1.push('contract.audit');

      const stage2: string[] = [];
      if (has('liquidity.lock')) stage2.push('liquidity.lock');
      if (has('simulation.sell')) stage2.push('simulation.sell');

      const stage3: string[] = [];
      if (has('holder.distribution')) stage3.push('holder.distribution');

      return [
        { name: 'SECURITY_SCAN', tools: stage1 },
        { name: 'LIQUIDITY_AND_SELL_VERIFICATION', tools: stage2 },
        { name: 'HOLDER_CENTRALIZATION', tools: stage3 },
      ].filter((s) => s.tools.length > 0);
    }

    if (goal === 'DEEP_RESEARCH') {
      const stage1: string[] = [];
      if (has('token.profile')) stage1.push('token.profile');
      if (has('dex.pairs')) stage1.push('dex.pairs');
      if (has('dex.screener')) stage1.push('dex.screener');

      const stage2: string[] = [];
      if (has('holder.distribution')) stage2.push('holder.distribution');
      if (has('pool.liquidity')) stage2.push('pool.liquidity');

      const stage3: string[] = [];
      if (has('contract.audit')) stage3.push('contract.audit');
      if (has('solana.transaction_trace')) stage3.push('solana.transaction_trace');

      const stage4: string[] = [];
      if (has('simulation.execution')) stage4.push('simulation.execution');
      if (has('signal.score')) stage4.push('signal.score');

      return [
        { name: 'TOKEN_AND_MARKET_PROFILE', tools: stage1 },
        { name: 'HOLDERS_AND_LIQUIDITY', tools: stage2 },
        { name: 'CONTRACT_AND_ONCHAIN_TRACE', tools: stage3 },
        { name: 'EXECUTION_SIMULATION', tools: stage4 },
      ].filter((s) => s.tools.length > 0);
    }

    // Default / TRIAGE / ADMIN_CHAT / REPAIR
    const stage1: string[] = [];
    if (has('dex.pairs')) stage1.push('dex.pairs');
    if (has('token.profile')) stage1.push('token.profile');
    if (has('market.summary')) stage1.push('market.summary');
    if (has('schedule.inspect')) stage1.push('schedule.inspect');
    if (has('candidate.inspect')) stage1.push('candidate.inspect');

    // Add any remaining unassigned tools
    const assigned = new Set(stage1);
    const unassigned = availableTools.filter((t) => !assigned.has(t));

    const stages: Array<{ name: string; tools: string[] }> = [];
    if (stage1.length > 0) {
      stages.push({ name: 'PRIMARY_DISCOVERY', tools: stage1 });
    }
    if (unassigned.length > 0) {
      stages.push({ name: 'SUPPLEMENTARY_TOOLS', tools: unassigned });
    }

    return stages;
  }

  private static generateDeterministicArguments(
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
      baseArgs.limit = Math.min(100, envelope.maxLimit);
    }

    switch (toolName) {
      case 'dex.pairs':
      case 'dex.screener':
      case 'pool.liquidity':
        return {
          ...baseArgs,
          pairAddress: candidate.contractAddress,
        };
      case 'holder.distribution':
        return {
          ...baseArgs,
          mint: candidate.contractAddress,
          limit: envelope.maxLimit ? Math.min(50, envelope.maxLimit) : 50,
        };
      case 'contract.audit':
      case 'risk.honeypot_scan':
      case 'liquidity.lock':
        return {
          ...baseArgs,
          contractAddress: candidate.contractAddress,
        };
      case 'simulation.sell':
      case 'simulation.execution':
        return {
          ...baseArgs,
          notionalUsd: 1000,
        };
      default:
        return baseArgs;
    }
  }

  private static estimateToolCost(toolName: string, profile: ModelProfile): number {
    return (profile.costPerInputTokenUsd ?? 0.000001) * 500;
  }
}
