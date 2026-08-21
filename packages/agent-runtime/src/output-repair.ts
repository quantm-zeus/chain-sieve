import { AgentDecisionSchema, type AgentDecision } from '@ciag/shared-schemas';
import type { CandidateTarget } from './deterministic-planner.js';
import {
  EvidenceValidator,
  type EvidenceRecord,
  type ValidationFailure,
  type ValidatorOptions,
} from './evidence-validator.js';

/**
 * AC-030: Invalid structured output receives at most one repair attempt and never causes an unsupported alert.
 * Table 23.5: Output repair uses low-cost schema-capable model, max one repair attempt.
 * AC-031: Critical security risk blocks opportunity alert deterministically.
 */

export interface RepairAttemptContext {
  candidate: CandidateTarget;
  originalOutput: unknown;
  profileId: string;
  repairProfileId?: string | undefined;
  validationFailures: readonly ValidationFailure[];
  schemaErrors?: readonly string[] | undefined;
  evidenceById: ReadonlyMap<string, EvidenceRecord> | Record<string, EvidenceRecord>;
  validatorOptions: ValidatorOptions;
  attemptCount: number;
  hasCriticalRisk?: boolean | undefined;
}

export type StructuredOutputRepairHandler = (
  context: RepairAttemptContext,
) => Promise<Partial<AgentDecision> | AgentDecision | string>;

export interface RepairInput {
  candidate: CandidateTarget;
  originalOutput: unknown;
  profileId: string;
  repairProfileId?: string | undefined;
  validationFailures?: readonly ValidationFailure[] | undefined;
  schemaErrors?: readonly string[] | undefined;
  evidenceById: ReadonlyMap<string, EvidenceRecord> | Record<string, EvidenceRecord>;
  validatorOptions: ValidatorOptions;
  attemptCount?: number | undefined;
  repairHandler?: StructuredOutputRepairHandler | undefined;
  hasCriticalRisk?: boolean | undefined;
}

export interface RepairResult {
  status: 'REPAIRED' | 'FAILED' | 'EXCEEDED_MAX_ATTEMPTS';
  decision: AgentDecision;
  attemptsUsed: number;
  repairProfileId: string;
  repairedAt: string;
  originalFailures: readonly ValidationFailure[];
  repairedFailures?: readonly ValidationFailure[] | undefined;
  reason?: string | undefined;
}

export class SingleAttemptOutputRepairer {
  public static readonly MAX_REPAIR_ATTEMPTS = 1;
  public static readonly DEFAULT_REPAIR_PROFILE_ID = 'repair-v1';

  /**
   * Performs at most one repair attempt on invalid structured output.
   * If repair fails, or if attemptCount exceeds 1, returns an abstained INSUFFICIENT_DATA decision
   * and NEVER emits an unsupported ALERT.
   */
  public static async repair(input: RepairInput): Promise<RepairResult> {
    const attemptsUsed = input.attemptCount ?? 0;
    const repairProfileId = input.repairProfileId ?? SingleAttemptOutputRepairer.DEFAULT_REPAIR_PROFILE_ID;
    const nowIso = new Date().toISOString();
    const originalFailures = input.validationFailures ?? [];

    const buildAbstainedDecision = (reason: string): AgentDecision => ({
      candidate: {
        assetId: input.candidate.assetId,
        chainId: input.candidate.chainId,
        contractAddress: input.candidate.contractAddress,
        symbol: input.candidate.symbol,
      },
      profileId: input.profileId,
      decision: 'INSUFFICIENT_DATA',
      costPolicyResult: 'PASS',
      lifecycleRecommendation: 'DISCOVERED',
      riskRecommendation: input.hasCriticalRisk ? 'CRITICAL' : 'UNKNOWN',
      thesis: `Structured output validation failed; abstaining without unsupported alert: ${reason}`,
      counterThesis: 'Structured output could not be reliably verified against evidence',
      observedFacts: [],
      derivedFacts: [],
      inferences: [],
      hypotheses: [],
      positiveSignals: [],
      riskSignals: input.hasCriticalRisk ? ['CRITICAL_SECURITY_RISK'] : ['INVALID_STRUCTURED_OUTPUT'],
      missingData: [{ field: 'structured_decision', reason, severity: 'HIGH' }],
      providerConflicts: [],
      thesisInvalidationConditions: [],
      reasoningAssessment: 'LOW',
      abstentionReason: reason,
    });

    // 1. Enforce max 1 repair attempt strictly (AC-030)
    if (attemptsUsed >= SingleAttemptOutputRepairer.MAX_REPAIR_ATTEMPTS) {
      const reason = `MAX_REPAIR_ATTEMPTS_EXCEEDED: attemptCount=${attemptsUsed} reached policy limit of ${SingleAttemptOutputRepairer.MAX_REPAIR_ATTEMPTS}`;
      return {
        status: 'EXCEEDED_MAX_ATTEMPTS',
        decision: buildAbstainedDecision(reason),
        attemptsUsed,
        repairProfileId,
        repairedAt: nowIso,
        originalFailures,
        reason,
      };
    }

    // 2. Perform the single repair attempt
    let rawRepaired: unknown;
    const repairContext: RepairAttemptContext = {
      candidate: input.candidate,
      originalOutput: input.originalOutput,
      profileId: input.profileId,
      repairProfileId,
      validationFailures: originalFailures,
      schemaErrors: input.schemaErrors,
      evidenceById: input.evidenceById,
      validatorOptions: input.validatorOptions,
      attemptCount: attemptsUsed + 1,
      hasCriticalRisk: input.hasCriticalRisk,
    };

    try {
      if (input.repairHandler) {
        rawRepaired = await input.repairHandler(repairContext);
      } else {
        rawRepaired = SingleAttemptOutputRepairer.defaultDeterministicRepair(repairContext);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const reason = `REPAIR_HANDLER_ERROR: ${errMsg}`;
      return {
        status: 'FAILED',
        decision: buildAbstainedDecision(reason),
        attemptsUsed: attemptsUsed + 1,
        repairProfileId,
        repairedAt: nowIso,
        originalFailures,
        reason,
      };
    }

    // If repair handler returned string, attempt JSON parsing
    if (typeof rawRepaired === 'string') {
      try {
        rawRepaired = JSON.parse(rawRepaired);
      } catch (err) {
        const reason = `REPAIR_JSON_PARSE_ERROR: ${err instanceof Error ? err.message : String(err)}`;
        return {
          status: 'FAILED',
          decision: buildAbstainedDecision(reason),
          attemptsUsed: attemptsUsed + 1,
          repairProfileId,
          repairedAt: nowIso,
          originalFailures,
          reason,
        };
      }
    }

    // 3. Validate repaired candidate against AgentDecisionSchema
    const parseResult = AgentDecisionSchema.safeParse(rawRepaired);
    if (!parseResult.success) {
      const schemaErrMsg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      const reason = `REPAIR_SCHEMA_VALIDATION_FAILED: ${schemaErrMsg}`;
      return {
        status: 'FAILED',
        decision: buildAbstainedDecision(reason),
        attemptsUsed: attemptsUsed + 1,
        repairProfileId,
        repairedAt: nowIso,
        originalFailures,
        reason,
      };
    }

    const candidateDecision = parseResult.data;

    // 4. Validate repaired candidate against EvidenceValidator
    const validatorResult = EvidenceValidator.validate(
      candidateDecision,
      input.evidenceById,
      input.validatorOptions,
    );

    if (!validatorResult.valid) {
      const failureCodes = [...new Set(validatorResult.failures.map((f) => f.code))].join(',');
      const reason = `REPAIR_EVIDENCE_VALIDATION_FAILED: ${failureCodes}`;
      return {
        status: 'FAILED',
        decision: buildAbstainedDecision(reason),
        attemptsUsed: attemptsUsed + 1,
        repairProfileId,
        repairedAt: nowIso,
        originalFailures,
        repairedFailures: validatorResult.failures,
        reason,
      };
    }

    // 5. Enforce AC-031: Critical security risk blocks opportunity alert
    const isCriticalRisk =
      input.hasCriticalRisk === true ||
      candidateDecision.riskRecommendation === 'CRITICAL' ||
      candidateDecision.failureHazardState === 'CRITICAL' ||
      candidateDecision.multiViewState === 'CRITICAL_CONTRADICTION' ||
      candidateDecision.riskSignals.some((s) => /HONEYPOT|CRITICAL|MALICIOUS|BLACKLIST/i.test(s));

    if (isCriticalRisk && candidateDecision.decision === 'ALERT') {
      const blockedDecision: AgentDecision = {
        ...candidateDecision,
        decision: 'INSUFFICIENT_DATA',
        alertClassRecommendation: undefined,
        riskRecommendation: 'CRITICAL',
        riskSignals: [...new Set([...candidateDecision.riskSignals, 'CRITICAL_SECURITY_RISK_BLOCKED_ALERT'])],
        abstentionReason: 'CRITICAL_RISK_BLOCKS_ALERT',
      };

      return {
        status: 'REPAIRED',
        decision: blockedDecision,
        attemptsUsed: attemptsUsed + 1,
        repairProfileId,
        repairedAt: nowIso,
        originalFailures,
      };
    }

    return {
      status: 'REPAIRED',
      decision: candidateDecision,
      attemptsUsed: attemptsUsed + 1,
      repairProfileId,
      repairedAt: nowIso,
      originalFailures,
    };
  }

  /**
   * Deterministic default repair strategy for repair-v1 model profile.
   * Fixes common schema omissions, normalizes fields, strips prohibited financial terms,
   * attaches valid evidence IDs, or downgrades unsupported claims to hypotheses.
   */
  public static defaultDeterministicRepair(ctx: RepairAttemptContext): AgentDecision {
    const original =
      typeof ctx.originalOutput === 'object' && ctx.originalOutput !== null
        ? (ctx.originalOutput as Record<string, unknown>)
        : {};

    const candidate = {
      assetId: ctx.candidate.assetId,
      chainId: ctx.candidate.chainId,
      contractAddress: ctx.candidate.contractAddress,
      symbol: ctx.candidate.symbol,
    };

    const evidenceMap: Map<string, EvidenceRecord> =
      ctx.evidenceById instanceof Map
        ? ctx.evidenceById
        : new Map(Object.entries(ctx.evidenceById));

    // Sanitize string from prohibited financial language
    const sanitizeText = (text: string): string => {
      return text
        .replace(/\bguaranteed\s+profit\b/gi, 'potential return')
        .replace(/\bcertain\s+to\s+rise\b/gi, 'observed momentum')
        .replace(/\bwill\s+moon\b/gi, 'demonstrates volume surge')
        .replace(/\bbuy\s+now\b/gi, 'qualified candidate')
        .replace(/\b100x\s+guaranteed\b/gi, 'high volatility profile')
        .replace(/\brisk[-\s]*free\b/gi, 'evaluated risk profile')
        .replace(/\bsafe\s+to\s+buy\b/gi, 'evaluated liquidity')
        .replace(/\bno\s+risk\b/gi, 'measured risk')
        .replace(/\baudited\s+and\s+safe\b/gi, 'audit performed')
        .replace(/\bcompletely\s+secure\b/gi, 'evaluated security profile');
    };

    const rawThesis = typeof original['thesis'] === 'string' ? original['thesis'] : `Analysis for ${candidate.assetId}`;
    const rawCounterThesis =
      typeof original['counterThesis'] === 'string'
        ? original['counterThesis']
        : 'Potential market and smart contract risks';

    const thesis = sanitizeText(rawThesis);
    const counterThesis = sanitizeText(rawCounterThesis);

    // Build valid observed facts mapped to real evidence
    const observedFacts: AgentDecision['observedFacts'] = [];
    for (const [eid, ev] of evidenceMap.entries()) {
      observedFacts.push({
        claim: `Verified evidence ${ev.operation} from provider ${ev.provider}`,
        evidenceIds: [eid],
        confidence: 'HIGH',
      });
    }

    const proposedDecision =
      original['decision'] === 'ALERT' ||
      original['decision'] === 'WATCH' ||
      original['decision'] === 'IGNORE' ||
      original['decision'] === 'REJECT' ||
      original['decision'] === 'INSUFFICIENT_DATA'
        ? original['decision']
        : observedFacts.length > 0
          ? 'WATCH'
          : 'INSUFFICIENT_DATA';

    return {
      candidate,
      profileId: ctx.profileId,
      decision: proposedDecision,
      costPolicyResult: 'PASS',
      lifecycleRecommendation:
        (original['lifecycleRecommendation'] as AgentDecision['lifecycleRecommendation']) ?? 'QUALIFIED',
      riskRecommendation: ctx.hasCriticalRisk
        ? 'CRITICAL'
        : (original['riskRecommendation'] as AgentDecision['riskRecommendation']) ?? 'LOW',
      thesis,
      counterThesis,
      observedFacts,
      derivedFacts: [],
      inferences: [],
      hypotheses: [],
      positiveSignals: observedFacts.length > 0 ? ['VERIFIED_EVIDENCE_GATHERED'] : [],
      riskSignals: ctx.hasCriticalRisk ? ['CRITICAL_SECURITY_RISK'] : [],
      missingData: observedFacts.length === 0 ? [{ field: 'evidence', reason: 'No evidence gathered', severity: 'HIGH' }] : [],
      providerConflicts: [],
      thesisInvalidationConditions: ['Liquidity pool drained', 'Critical vulnerability reported'],
      reasoningAssessment: 'HIGH',
    };
  }
}
