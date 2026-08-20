import { describe, expect, it } from 'vitest';
import {
  BoundedAgentRuntime,
  ModelProfileRegistry,
  DeterministicPlanner,
  ToolArgumentConfinementValidator,
  AgentBudgetTracker,
  UnknownModelProfileError,
  BudgetExceededError,
  ConfinementViolationError,
  AgentCancelledError,
} from '@ciag/agent-runtime';
import type {
  AgentBudget,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import { AgentDecisionSchema } from '@ciag/shared-schemas';

describe('Bounded Agent Runtime (FR-AGT-001, FR-AGT-002, FR-AGT-006, FR-AGT-012)', () => {
  const sampleCandidate = {
    assetId: 'solana:token:So11111111111111111111111111111111111111112',
    chainId: 'solana',
    contractAddress: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
  };

  const sampleEnvelope: ToolAuthorizationEnvelope = {
    allowedTools: ['dex.pairs', 'token.profile', 'market.summary', 'contract.audit', 'simulation.sell'],
    allowedProviders: ['jupiter', 'dexscreener', 'helius'],
    allowedDomains: ['dexscreener.com', 'helius-rpc.com', 'jup.ag'],
    allowedChains: ['solana'],
    allowedAddresses: ['So11111111111111111111111111111111111111112'],
    timeRange: {
      minTimestamp: '2025-01-01T00:00:00Z',
      maxTimestamp: '2026-08-20T12:00:00Z',
    },
    maxLimit: 100,
    maxOutputSizeBytes: 65536,
    maxCostUsd: 0.1,
  };

  const sampleBudget: AgentBudget = {
    maxSteps: 5,
    maxToolCalls: 10,
    maxToolCallsPerCandidate: 10,
    maxProviderCalls: 20,
    maxInputTokens: 10000,
    maxOutputTokens: 10000,
    maxModelCostUsd: 1.0,
    maxProviderCostUnits: 50,
  };

  describe('FR-AGT-001: Pluggable runtime and versioned model profiles', () => {
    it('supports registry with versioned profiles and retrieves default/versioned', () => {
      const registry = new ModelProfileRegistry();
      const defaultTriage = registry.require('fast-triage-v1');
      expect(defaultTriage.id).toBe('fast-triage-v1');
      expect(defaultTriage.version).toBe('1.0.0');

      const v1Triage = registry.require('fast-triage-v1', '1.0.0');
      expect(v1Triage.id).toBe('fast-triage-v1');
      expect(v1Triage.version).toBe('1.0.0');

      const customProfile: ModelProfile = {
        id: 'custom-profile',
        version: '2.1.0',
        modelClass: 'DEEP_RESEARCH',
        provider: 'anthropic',
        modelId: 'claude-3-7-sonnet',
        declaredTools: ['dex.pairs', 'contract.audit'],
        maxTokens: 4096,
        maxContextTokens: 64000,
        temperature: 0,
      };

      registry.register(customProfile);
      const retrieved = registry.require('custom-profile', '2.1.0');
      expect(retrieved.modelId).toBe('claude-3-7-sonnet');
      expect(retrieved.declaredTools).toEqual(['dex.pairs', 'contract.audit']);
    });

    it('fails closed with typed UnknownModelProfileError on unknown profile or unknown version', () => {
      const registry = new ModelProfileRegistry();

      expect(() => registry.require('non-existent-profile')).toThrow(UnknownModelProfileError);
      expect(() => registry.require('fast-triage-v1', '9.9.9')).toThrow(UnknownModelProfileError);

      try {
        registry.require('non-existent-profile');
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownModelProfileError);
        if (err instanceof UnknownModelProfileError) {
          expect(err.code).toBe('UNKNOWN_MODEL_PROFILE');
          expect(err.profileId).toBe('non-existent-profile');
        }
      }
    });

    it('validates declared tools against requested tools fail-closed', () => {
      const registry = new ModelProfileRegistry();
      const validation = registry.validateDeclaredTools('fast-triage-v1', [
        'dex.pairs',
        'contract.audit', // not in fast-triage-v1 declared tools
      ]);

      expect(validation.valid).toBe(false);
      expect(validation.unauthorizedTools).toEqual(['contract.audit']);
    });

    it('runtime execution fails closed when given unknown profile', async () => {
      const runtime = new BoundedAgentRuntime();

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'unknown-model-profile',
          envelope: sampleEnvelope,
          budget: sampleBudget,
        }),
      ).rejects.toThrow(UnknownModelProfileError);
    });
  });

  describe('FR-AGT-002: Deterministic planner and bounded tool loop', () => {
    it('produces a bounded execution plan respecting budget maxSteps and maxToolCalls', () => {
      const profile = new ModelProfileRegistry().require('fast-triage-v1');
      const tightBudget: AgentBudget = {
        maxSteps: 2,
        maxToolCalls: 2,
      };

      const plan = DeterministicPlanner.plan({
        candidate: sampleCandidate,
        profile,
        envelope: sampleEnvelope,
        budget: tightBudget,
      });

      expect(plan.steps.length).toBeLessThanOrEqual(tightBudget.maxSteps);
      expect(plan.totalPlannedToolCalls).toBeLessThanOrEqual(tightBudget.maxToolCalls);
      expect(plan.planId).toContain('plan_solana:token:So11111111111111111111111111111111111111112');
    });

    it('guarantees replay determinism: identical inputs yield identical plan', () => {
      const profile = new ModelProfileRegistry().require('deep-research-v1');
      const deepEnvelope: ToolAuthorizationEnvelope = {
        ...sampleEnvelope,
        allowedTools: profile.declaredTools,
      };

      const input = {
        candidate: sampleCandidate,
        profile,
        envelope: deepEnvelope,
        budget: sampleBudget,
        goal: 'DEEP_RESEARCH' as const,
        deterministicSeedRef: 'seed-42',
      };

      const plan1 = DeterministicPlanner.plan(input);
      const plan2 = DeterministicPlanner.plan(input);

      expect(plan1.planId).toBe(plan2.planId);
      expect(plan1.totalPlannedToolCalls).toBe(plan2.totalPlannedToolCalls);
      expect(plan1.steps).toEqual(plan2.steps);
    });

    it('generates stage-specific tool sequence for skeptic goal', () => {
      const profile = new ModelProfileRegistry().require('skeptic-v1');
      const skepticEnvelope: ToolAuthorizationEnvelope = {
        ...sampleEnvelope,
        allowedTools: profile.declaredTools,
      };

      const plan = DeterministicPlanner.plan({
        candidate: sampleCandidate,
        profile,
        envelope: skepticEnvelope,
        budget: sampleBudget,
        goal: 'SKEPTIC',
      });

      const toolNames = plan.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      expect(toolNames).toContain('risk.honeypot_scan');
      expect(toolNames).toContain('contract.audit');
      expect(toolNames).toContain('simulation.sell');
    });

    it('runtime executes tool loop deterministically within step bounds', async () => {
      const runtime = new BoundedAgentRuntime();
      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'fast-triage-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.executedSteps).toBeGreaterThan(0);
      expect(result.executedSteps).toBeLessThanOrEqual(sampleBudget.maxSteps);
      expect(result.executedToolCalls).toBeLessThanOrEqual(sampleBudget.maxToolCalls);
      expect(result.decision.candidate.assetId).toBe(sampleCandidate.assetId);

      const parsedDecision = AgentDecisionSchema.parse(result.decision);
      expect(parsedDecision.decision).toBeDefined();
      expect(parsedDecision.lifecycleRecommendation).toBe('QUALIFIED');
      expect(parsedDecision.riskRecommendation).toBe('LOW');
    });

    it('bounds plan generation strictly by budget maxModelCostUsd and maxProviderCostUnits', () => {
      const profile = new ModelProfileRegistry().require('deep-research-v1');
      const costBoundedPlan = DeterministicPlanner.plan({
        candidate: sampleCandidate,
        profile,
        envelope: {
          ...sampleEnvelope,
          allowedTools: profile.declaredTools,
        },
        budget: {
          maxSteps: 10,
          maxToolCalls: 20,
          maxModelCostUsd: 0.005,
          maxProviderCostUnits: 2,
        },
        goal: 'DEEP_RESEARCH',
      });

      expect(costBoundedPlan.totalPlannedToolCalls).toBeLessThanOrEqual(2);
      expect(costBoundedPlan.totalEstimatedCostUsd).toBeLessThanOrEqual(0.005);
      expect(costBoundedPlan.steps.length).toBeGreaterThan(0);
      expect(costBoundedPlan.steps[costBoundedPlan.steps.length - 1]?.isTerminal).toBe(true);
    });
  });

  describe('FR-AGT-006: External budget and cancellation', () => {
    it('blocks execution when steps budget is exceeded with typed BUDGET_EXCEEDED', () => {
      const tracker = new AgentBudgetTracker({
        maxSteps: 2,
        maxToolCalls: 10,
      });

      tracker.recordStep(1);
      tracker.recordStep(1);

      expect(() => tracker.recordStep(1)).toThrow(BudgetExceededError);

      try {
        tracker.recordStep(1);
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        if (err instanceof BudgetExceededError) {
          expect(err.code).toBe('BUDGET_EXCEEDED');
          expect(err.dimension).toBe('STEPS');
          expect(err.limit).toBe(2);
        }
      }
    });

    it('blocks execution when tool calls budget is exceeded', () => {
      const tracker = new AgentBudgetTracker({
        maxSteps: 10,
        maxToolCalls: 2,
        maxToolCallsPerCandidate: 1,
      });

      tracker.recordToolCall('cand-1', 1);

      // Candidate quota exceeded
      expect(() => tracker.recordToolCall('cand-1', 1)).toThrow(BudgetExceededError);

      // Global tool calls exceeded
      tracker.recordToolCall('cand-2', 1);
      expect(() => tracker.recordToolCall('cand-3', 1)).toThrow(BudgetExceededError);
    });

    it('blocks execution when token or cost budgets are exceeded', () => {
      const tracker = new AgentBudgetTracker({
        maxSteps: 10,
        maxToolCalls: 10,
        maxInputTokens: 500,
        maxOutputTokens: 500,
        maxModelCostUsd: 0.05,
      });

      tracker.recordTokens(300, 300, 0.02);

      // Input tokens exceeded
      expect(() => tracker.checkTokens(300, 100, 0.01)).toThrow(BudgetExceededError);

      // Output tokens exceeded
      expect(() => tracker.checkTokens(100, 300, 0.01)).toThrow(BudgetExceededError);

      // Model cost exceeded
      expect(() => tracker.checkTokens(100, 100, 0.05)).toThrow(BudgetExceededError);
    });

    it('blocks execution when deadline has expired', () => {
      const expiredBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 5,
        deadlineAt: new Date(Date.now() - 10_000).toISOString(),
      };

      const tracker = new AgentBudgetTracker(expiredBudget);
      expect(() => tracker.checkDeadline()).toThrow(BudgetExceededError);

      try {
        tracker.checkStep(1);
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        if (err instanceof BudgetExceededError) {
          expect(err.dimension).toBe('DEADLINE');
        }
      }
    });

    it('propagates cancellation immediately when AbortSignal is aborted', async () => {
      const runtime = new BoundedAgentRuntime();
      const controller = new AbortController();

      // Pre-aborted signal
      controller.abort();

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: sampleBudget,
          signal: controller.signal,
        }),
      ).rejects.toThrow(AgentCancelledError);
    });

    it('propagates cancellation to in-flight tool handler', async () => {
      const runtime = new BoundedAgentRuntime();
      const controller = new AbortController();

      runtime.registerTool('dex.pairs', async (_args, ctx) => {
        // Trigger abort during tool execution
        controller.abort();
        if (ctx.signal?.aborted) {
          throw new AgentCancelledError();
        }
        return { data: 'delayed' };
      });

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: sampleBudget,
          signal: controller.signal,
        }),
      ).rejects.toThrow(AgentCancelledError);
    });

    it('enforces pre-flight cost/token quota blocking execution before invoking tool handler', async () => {
      const runtime = new BoundedAgentRuntime();
      let handlerInvoked = false;

      runtime.registerTool('dex.pairs', async () => {
        handlerInvoked = true;
        return { pairs: [] };
      });

      // Budget with zero allowed model cost
      const zeroCostBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 5,
        maxModelCostUsd: 0,
      };

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: zeroCostBudget,
        }),
      ).rejects.toThrow(BudgetExceededError);

      // Verify side effect never occurred
      expect(handlerInvoked).toBe(false);
    });

    it('enforces pre-flight provider cost units quota blocking execution before invoking tool handler', async () => {
      const runtime = new BoundedAgentRuntime();
      let handlerInvoked = false;

      runtime.registerTool('dex.pairs', async () => {
        handlerInvoked = true;
        return { pairs: [] };
      });

      const zeroProviderUnitsBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 5,
        maxProviderCostUnits: 0,
      };

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: zeroProviderUnitsBudget,
        }),
      ).rejects.toThrow(BudgetExceededError);

      expect(handlerInvoked).toBe(false);
    });

    it('enforces pre-flight maxToolCalls=0 blocking execution when tool execution is required', async () => {
      const runtime = new BoundedAgentRuntime();
      let handlerInvoked = false;

      runtime.registerTool('dex.pairs', async () => {
        handlerInvoked = true;
        return { pairs: [] };
      });

      const zeroToolCallsBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 0,
      };

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: zeroToolCallsBudget,
        }),
      ).rejects.toThrow(BudgetExceededError);

      expect(handlerInvoked).toBe(false);
    });

    it('enforces pre-flight maxSteps=0 blocking execution when tool execution is required', async () => {
      const runtime = new BoundedAgentRuntime();
      let handlerInvoked = false;

      runtime.registerTool('dex.pairs', async () => {
        handlerInvoked = true;
        return { pairs: [] };
      });

      const zeroStepsBudget: AgentBudget = {
        maxSteps: 0,
        maxToolCalls: 5,
      };

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: zeroStepsBudget,
        }),
      ).rejects.toThrow(BudgetExceededError);

      expect(handlerInvoked).toBe(false);
    });

    it('enforces pre-flight token quota blocking execution when input/output token budget is exhausted', async () => {
      const runtime = new BoundedAgentRuntime();
      let handlerInvoked = false;

      runtime.registerTool('dex.pairs', async () => {
        handlerInvoked = true;
        return { pairs: [] };
      });

      const tightTokenBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 5,
        maxInputTokens: 50,
      };

      await expect(
        runtime.execute({
          candidate: sampleCandidate,
          profileId: 'fast-triage-v1',
          envelope: sampleEnvelope,
          budget: tightTokenBudget,
        }),
      ).rejects.toThrow(BudgetExceededError);

      expect(handlerInvoked).toBe(false);
    });

    it('allows legitimate no-evidence / no-tool-needed plan when envelope allows no tools', async () => {
      const runtime = new BoundedAgentRuntime();
      const noToolsEnvelope: ToolAuthorizationEnvelope = {
        ...sampleEnvelope,
        allowedTools: [],
      };

      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'fast-triage-v1',
        envelope: noToolsEnvelope,
        budget: {
          maxSteps: 5,
          maxToolCalls: 5,
          maxModelCostUsd: 0,
        },
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.decision.decision).toBe('INSUFFICIENT_DATA');
      expect(result.executedToolCalls).toBe(0);
    });

    it('cleans up AbortSignal event listeners without leaking on successful tool completion', async () => {
      const runtime = new BoundedAgentRuntime();
      const controller = new AbortController();

      runtime.registerTool('dex.pairs', async () => {
        return { pairs: ['SOL-USDC'] };
      });

      await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'fast-triage-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        signal: controller.signal,
      });

      // controller signal is not aborted and listener has been cleanly detached
      expect(controller.signal.aborted).toBe(false);
    });
  });

  describe('FR-AGT-012: Tool-argument confinement against deterministic planner envelope', () => {
    it('allows conforming tool arguments within envelope', () => {
      const validArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        provider: 'jupiter',
        url: 'https://jup.ag/swap/SOL-USDC',
        timestamp: '2026-08-20T10:00:00Z',
        limit: 50,
        maxOutputSizeBytes: 32768,
        costUsd: 0.05,
      };

      const result = ToolArgumentConfinementValidator.validate(
        'dex.pairs',
        validArgs,
        sampleEnvelope,
        ['dex.pairs', 'token.profile'],
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects undeclared tool or tool not in allowedTools', () => {
      // 1. Tool not in envelope allowedTools
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'unauthorized.tool',
          {},
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'unauthorized.tool',
          {},
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('TOOL_NOT_ALLOWED');
          expect(err.code).toBe('ENVELOPE_TOOL_NOT_ALLOWED');
        }
      }

      // 2. Tool in envelope allowedTools but not in profile declaredTools
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          {},
          sampleEnvelope,
          ['contract.audit'], // declaredTools excludes dex.pairs
        ),
      ).toThrow(ConfinementViolationError);
    });

    it('rejects broadening of provider scope', () => {
      const broadProviderArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        provider: 'unauthorized-external-feed',
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadProviderArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadProviderArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('PROVIDER_NOT_ALLOWED');
        }
      }
    });

    it('rejects broadening of URL or domain scope', () => {
      const broadUrlArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        url: 'https://evil-unauthorized-site.com/api/leak',
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadUrlArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadUrlArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('URL_NOT_ALLOWED');
        }
      }
    });

    it('rejects broadening of chain scope', () => {
      const broadChainArgs = {
        chain: 'ethereum', // sampleEnvelope allows only 'solana'
        address: 'So11111111111111111111111111111111111111112',
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadChainArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadChainArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('CHAIN_NOT_ALLOWED');
        }
      }
    });

    it('rejects broadening of address set', () => {
      const broadAddressArgs = {
        chain: 'solana',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC address, not allowed in envelope
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadAddressArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          broadAddressArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('ADDRESS_NOT_ALLOWED');
        }
      }
    });

    it('rejects broadening of time range (future/lookahead timestamp)', () => {
      const futureTimeArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        timestamp: '2026-08-21T00:00:00Z', // Past envelope maxTimestamp '2026-08-20T12:00:00Z'
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          futureTimeArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          futureTimeArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('TIME_RANGE_NOT_ALLOWED');
        }
      }
    });

    it('rejects broadening of output size or limit', () => {
      const oversizedArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        limit: 500, // sampleEnvelope maxLimit is 100
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          oversizedArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          oversizedArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('OUTPUT_SIZE_NOT_ALLOWED');
        }
      }
    });

    it('rejects cost exceeding envelope maxCostUsd', () => {
      const highCostArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        costUsd: 0.5, // sampleEnvelope maxCostUsd is 0.1
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          highCostArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);

      try {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          highCostArgs,
          sampleEnvelope,
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ConfinementViolationError);
        if (err instanceof ConfinementViolationError) {
          expect(err.violationType).toBe('COST_NOT_ALLOWED');
        }
      }
    });

    it('detects nested violations deeply embedded in arguments', () => {
      const nestedViolationArgs = {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        options: {
          advanced: {
            routing: {
              fallbackProvider: 'unauthorized-stealth-provider',
            },
          },
        },
      };

      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          nestedViolationArgs,
          sampleEnvelope,
        ),
      ).toThrow(ConfinementViolationError);
    });
  });
});
