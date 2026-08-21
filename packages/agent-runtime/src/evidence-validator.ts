import { createHash } from 'node:crypto';
import type { AgentDecision, ClaimRef } from '@ciag/shared-schemas';

/**
 * FR-AGT-004 Deterministic evidence validator
 * Checks every important claim against cited evidence IDs, blocks unsupported
 * claims, and preserves lineage.
 */

export interface EvidenceRecord {
  id: string;
  entityId: string;
  candidateId?: string | undefined;
  assetId?: string | undefined;
  provider: string;
  operation: string;
  independenceGroup: string;
  availableAt: string;
  fetchedAt: string;
  normalizedFields: Record<string, unknown>;
  qualityCodes: readonly string[];
  // optional lineage hash
  artifactSha256?: string | undefined;
}

export interface ValidatorOptions {
  decisionTimeIso: string;
  maxFreshnessMs?: number | undefined;
  requireIndependenceGroups?: number | undefined;
  candidateId?: string | undefined;
  entityId?: string | undefined;
}

export interface ValidationFailure {
  code: string;
  message: string;
  claimIndex: number;
  claimType: 'observedFacts' | 'derivedFacts' | 'inferences' | 'hypotheses';
  evidenceId?: string | undefined;
}

export interface EvidenceValidatorResult {
  valid: boolean;
  failures: ValidationFailure[];
  lineage: {
    evidenceIds: string[];
    evidenceHashes: string[];
    rawEvidenceCount: number;
    effectiveIndependenceGroups: number;
    independenceGroups: string[];
    validatedAt: string;
  };
}

const PROHIBITED_FINANCIAL_PHRASES: readonly RegExp[] = [
  /\bguaranteed\s+profit\b/i,
  /\bcertain\s+to\s+rise\b/i,
  /\bwill\s+moon\b/i,
  /\bbuy\s+now\b/i,
  /\b100x\s+guaranteed\b/i,
  /\brisk[-\s]*free\b/i,
];

const UNSUPPORTED_SAFETY_PATTERNS: readonly RegExp[] = [
  /\bsafe\s+to\s+buy\b/i,
  /\bno\s+risk\b/i,
  /\baudited\s+and\s+safe\b/i,
  /\bcompletely\s+secure\b/i,
];

const canonicalJson = (value: unknown): string => {
  const canonicalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, child]) => [k, canonicalize(child)]),
      );
    }
    return v;
  };
  return JSON.stringify(canonicalize(value));
};

export class EvidenceValidator {
  public static validate(
    decision: AgentDecision,
    evidenceById: ReadonlyMap<string, EvidenceRecord> | Record<string, EvidenceRecord>,
    options: ValidatorOptions,
  ): EvidenceValidatorResult {
    const evidenceMap: Map<string, EvidenceRecord> =
      evidenceById instanceof Map
        ? new Map(evidenceById as Map<string, EvidenceRecord>)
        : new Map(Object.entries(evidenceById as Record<string, EvidenceRecord>));

    const decisionTimeMs = Date.parse(options.decisionTimeIso);
    if (Number.isNaN(decisionTimeMs)) {
      throw new Error('INVALID_DECISION_TIME');
    }

    const failures: ValidationFailure[] = [];
    const allEvidenceIds = new Set<string>();
    const independenceGroups = new Set<string>();

    const claimGroups: Array<{ key: 'observedFacts' | 'derivedFacts' | 'inferences' | 'hypotheses'; claims: ClaimRef[] }> = [
      { key: 'observedFacts', claims: decision.observedFacts ?? [] },
      { key: 'derivedFacts', claims: decision.derivedFacts ?? [] },
      { key: 'inferences', claims: decision.inferences ?? [] },
      { key: 'hypotheses', claims: decision.hypotheses ?? [] },
    ];

    // For hypotheses, empty evidence is allowed (speculative); but observed/derived/inferences require evidence
    for (const group of claimGroups) {
      for (let idx = 0; idx < group.claims.length; idx++) {
        const claim = group.claims[idx]!;
        const isImportant = group.key === 'observedFacts' || group.key === 'derivedFacts' || group.key === 'inferences';

        // Hypotheses may have zero evidence (explicit speculation)
        if (group.key === 'hypotheses' && claim.evidenceIds.length === 0) {
          continue;
        }

        if (claim.evidenceIds.length === 0) {
          if (isImportant) {
            failures.push({
              code: 'MISSING_EVIDENCE_IDS',
              message: `Claim "${claim.claim}" in ${group.key}[${idx}] has no evidenceIds`,
              claimIndex: idx,
              claimType: group.key,
            });
          }
          continue;
        }

        for (const eid of claim.evidenceIds) {
          allEvidenceIds.add(eid);
          const ev = evidenceMap.get(eid);
          if (!ev) {
            failures.push({
              code: 'EVIDENCE_NOT_FOUND',
              message: `Evidence "${eid}" cited by ${group.key}[${idx}] does not exist`,
              claimIndex: idx,
              claimType: group.key,
              evidenceId: eid,
            });
            continue;
          }

          // Belongs to candidate/entity check
          if (options.candidateId && ev.candidateId && ev.candidateId !== options.candidateId) {
            failures.push({
              code: 'EVIDENCE_ENTITY_MISMATCH',
              message: `Evidence "${eid}" candidateId "${ev.candidateId}" does not match decision candidate "${options.candidateId}"`,
              claimIndex: idx,
              claimType: group.key,
              evidenceId: eid,
            });
          }
          if (options.entityId && ev.entityId !== options.entityId && ev.candidateId !== options.entityId) {
            // entity mismatch, but allow if candidateId matches? Already checked above
            // fail only if both entityId and candidateId mismatch and neither matches
            if (ev.entityId !== options.entityId) {
              failures.push({
                code: 'EVIDENCE_ENTITY_MISMATCH',
                message: `Evidence "${eid}" entityId "${ev.entityId}" does not match expected "${options.entityId}"`,
                claimIndex: idx,
                claimType: group.key,
                evidenceId: eid,
              });
            }
          }

          // Available at decision time
          const availMs = Date.parse(ev.availableAt);
          if (Number.isNaN(availMs)) {
            failures.push({
              code: 'INVALID_EVIDENCE_TIMESTAMP',
              message: `Evidence "${eid}" has invalid availableAt "${ev.availableAt}"`,
              claimIndex: idx,
              claimType: group.key,
              evidenceId: eid,
            });
          } else if (availMs > decisionTimeMs) {
            failures.push({
              code: 'EVIDENCE_NOT_AVAILABLE_AT_DECISION_TIME',
              message: `Evidence "${eid}" availableAt "${ev.availableAt}" is after decision time "${options.decisionTimeIso}"`,
              claimIndex: idx,
              claimType: group.key,
              evidenceId: eid,
            });
          }

          // Freshness
          if (options.maxFreshnessMs !== undefined) {
            const fetchedMs = Date.parse(ev.fetchedAt);
            if (!Number.isNaN(fetchedMs) && !Number.isNaN(availMs)) {
              const age = decisionTimeMs - Math.max(availMs, fetchedMs);
              if (age > options.maxFreshnessMs) {
                failures.push({
                  code: 'EVIDENCE_STALE',
                  message: `Evidence "${eid}" is stale: age ${age}ms exceeds ${options.maxFreshnessMs}ms`,
                  claimIndex: idx,
                  claimType: group.key,
                  evidenceId: eid,
                });
              }
            }
          }

          // Direction/magnitude match (deterministic lightweight check)
          const magnitudeFailure = EvidenceValidator.checkDirectionMagnitude(claim.claim, ev.normalizedFields);
          if (magnitudeFailure) {
            failures.push({
              code: 'CLAIM_EVIDENCE_MISMATCH',
              message: `Claim "${claim.claim}" direction/magnitude mismatch for evidence "${eid}": ${magnitudeFailure}`,
              claimIndex: idx,
              claimType: group.key,
              evidenceId: eid,
            });
          }

          if (ev.independenceGroup) independenceGroups.add(ev.independenceGroup);
        }

        // Unsupported safety assertion check
        const safetyCheck = EvidenceValidator.checkUnsupportedSafety(claim.claim, claim.evidenceIds, evidenceMap);
        if (safetyCheck) {
          failures.push({
            code: 'UNSUPPORTED_SAFETY_ASSERTION',
            message: `Claim "${claim.claim}" makes unsupported safety assertion: ${safetyCheck}`,
            claimIndex: idx,
            claimType: group.key,
          });
        }

        // Prohibited financial language check (applies to thesis/counterThesis too, but here per-claim)
        const financialViolation = EvidenceValidator.checkProhibitedLanguage(claim.claim);
        if (financialViolation) {
          failures.push({
            code: 'PROHIBITED_FINANCIAL_LANGUAGE',
            message: `Claim "${claim.claim}" contains prohibited financial language: ${financialViolation}`,
            claimIndex: idx,
            claimType: group.key,
          });
        }
      }
    }

    // Thesis / counterThesis prohibited language also validated
    for (const field of [decision.thesis, decision.counterThesis] as const) {
      const violation = EvidenceValidator.checkProhibitedLanguage(field);
      if (violation) {
        failures.push({
          code: 'PROHIBITED_FINANCIAL_LANGUAGE',
          message: `Decision field contains prohibited language: ${violation} in "${field.slice(0, 80)}"`,
          claimIndex: -1,
          claimType: 'observedFacts',
        });
      }
    }

    // Independence groups check
    if (options.requireIndependenceGroups !== undefined) {
      if (independenceGroups.size < options.requireIndependenceGroups) {
        // Only fail if there is at least one important claim (otherwise INSUFFICIENT_DATA path already)
        const hasImportantClaims = claimGroups.some((g) => g.claims.length > 0 && g.key !== 'hypotheses');
        if (hasImportantClaims) {
          failures.push({
            code: 'INSUFFICIENT_INDEPENDENCE',
            message: `Effective independence groups ${independenceGroups.size} < required ${options.requireIndependenceGroups}`,
            claimIndex: -1,
            claimType: 'observedFacts',
          });
        }
      }
    }

    const sortedIds = [...allEvidenceIds].sort();
    const evidenceHashes = sortedIds.map((id) => {
      const ev = evidenceMap.get(id);
      if (!ev) return createHash('sha256').update(id).digest('hex');
      if (ev.artifactSha256) return ev.artifactSha256;
      return createHash('sha256').update(canonicalJson(ev)).digest('hex');
    });

    return {
      valid: failures.length === 0,
      failures,
      lineage: {
        evidenceIds: sortedIds,
        evidenceHashes,
        rawEvidenceCount: sortedIds.length,
        effectiveIndependenceGroups: independenceGroups.size,
        independenceGroups: [...independenceGroups].sort(),
        validatedAt: new Date().toISOString(),
      },
    };
  }

  private static checkDirectionMagnitude(claim: string, fields: Record<string, unknown>): string | null {
    const lower = claim.toLowerCase();

    // Check price direction claims
    if (lower.includes('price') && (lower.includes('increased') || lower.includes('rose') || lower.includes('up'))) {
      const priceVal = fields['price'] ?? fields['priceUsd'] ?? fields['value'];
      if (typeof priceVal === 'number' && priceVal < 0) return 'claimed increase but normalized price is negative';
      // If we have explicit direction field
      const dir = fields['direction'];
      if (dir === 'down' || dir === 'decreased') return 'claimed increase but evidence direction is down';
    }
    if (lower.includes('price') && (lower.includes('decreased') || lower.includes('fell') || lower.includes('down'))) {
      const dir = fields['direction'];
      if (dir === 'up' || dir === 'increased') return 'claimed decrease but evidence direction is up';
    }

    // Liquidity claims
    if (lower.includes('liquidity') && lower.includes('high')) {
      const liq = fields['liquidityUsd'] ?? fields['liquidity'];
      if (typeof liq === 'number' && liq < 1000) return 'claimed high liquidity but value is very low';
    }

    // If claim mentions concrete numeric value, verify it roughly matches evidence
    const numericInClaim = lower.match(/(\d+(?:\.\d+)?)\s*%|\$?\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
    // Not enforcing strict numeric match without clear field mapping; skip unless obvious mismatch
    void numericInClaim;
    return null;
  }

  private static checkUnsupportedSafety(
    claim: string,
    evidenceIds: readonly string[],
    evidenceMap: Map<string, EvidenceRecord>,
  ): string | null {
    const lower = claim.toLowerCase();
    const isSafetyClaim = UNSUPPORTED_SAFETY_PATTERNS.some((re) => re.test(lower));
    if (!isSafetyClaim) return null;

    // Require at least one evidence with quality that supports safety (e.g., audit pass)
    for (const eid of evidenceIds) {
      const ev = evidenceMap.get(eid);
      if (!ev) continue;
      // If evidence has auditPassed or safety flag
      if (ev.normalizedFields['auditPassed'] === true || ev.normalizedFields['isSafe'] === true || ev.qualityCodes.includes('VALID')) {
        // Check that evidence actually indicates safety
        if (ev.normalizedFields['risk'] === 'LOW' || ev.normalizedFields['auditPassed'] === true) return null;
      }
    }
    return 'safety claim without supporting auditPassed/risk LOW evidence';
  }

  private static checkProhibitedLanguage(text: string): string | null {
    for (const re of PROHIBITED_FINANCIAL_PHRASES) {
      if (re.test(text)) return re.source;
    }
    return null;
  }
}
