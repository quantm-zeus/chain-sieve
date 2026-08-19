import { describe, expect, it } from 'vitest';
import { applyBootstrapMigration, applyAlertLifecycleMigration } from '@ciag/persistence';
import { MemoryPostgresAdapter, FakeNotificationTransport } from '@ciag/test-fixtures';
import {
  evaluateAlertPolicy,
  evaluateAlertLifecycle,
  renderAlert,
  determineAlertRouting,
  commitAlertTransaction,
  processOutboxEntry,
  computeAlertClassMetrics,
  assertNoHighConvictionLanguage,
  validateEarlyWatchGuardrails,
  validateAlertSemanticIntegrity,
  DEFAULT_ALERT_POLICY_CONFIG,
  ShadowNotificationAdapter,
} from '@ciag/alerts';
import type {
  AlertCandidateInput,
  AlertEvaluationMetricRecord,
  AlertPolicyConfig,
} from '@ciag/alerts';

const iso = '2026-03-01T00:00:00.000Z';

const makePolicyConfig = (overrides: Partial<AlertPolicyConfig> = {}): AlertPolicyConfig => ({
  ...DEFAULT_ALERT_POLICY_CONFIG,
  ...overrides,
});

const makeCandidateInput = (overrides: Partial<AlertCandidateInput> = {}): AlertCandidateInput => ({
  assetId: 'solana:asset-gem-01',
  chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  contractAddress: 'So11111111111111111111111111111111111111112',
  symbol: 'GEM1',
  asOf: iso,
  profileId: 'HG-EM-1',
  profileVersion: '1',
  lifecycleState: 'CONFIRMED',
  riskState: 'LOW',
  decision: 'ALERT',
  score: 0.85,
  rank: 1,
  dataCoverage: 0.90,
  effectiveIndependenceGroups: 3.0,
  sourceDependenceState: 'INDEPENDENT',
  freshness: {
    marketObservedAt: iso,
    holderObservedAt: iso,
    securityObservedAt: iso,
  },
  tradability: {
    executable: true,
    expectedSlippageBps: 25,
    feeTotalUsd: '1.50',
    netReturnEstimate: 0.45,
    maxExecutableNotionalUsd: '5000',
    minLiquidityUsd: 10000,
    currentLiquidityUsd: 50000,
  },
  security: {
    mintAuthorityRevokedOrDisabled: true,
    freezeAuthorityDisabled: true,
    lpLockedOrBurned: true,
    criticalSecurityEvents: [],
    findings: [],
  },
  cost: {
    mode: 'STRICT_FREE',
    costUsd: 0,
    unknownCostOperationsCount: 0,
  },
  unresolvedConflicts: [],
  positiveSignals: ['Strong organic buyer momentum', 'High unique wallet diversity'],
  riskSignals: ['Moderate early volatility'],
  missingData: [],
  thesis: 'Rapid organic adoption with strong decentralized holder distribution and locked liquidity.',
  counterThesis: 'Potential liquidity fragmentation across secondary DEX pools.',
  thesisInvalidationConditions: ['Creator wallet sells > 5% of supply', 'Liquidity drops below $10,000'],
  materialEvidenceFingerprint: 'a'.repeat(64),
  shadowMode: false,
  traceId: 'trace-test-001',
  ...overrides,
});

describe('Alert Policy & Classification (FR-ALERT-001, FR-ALERT-003)', () => {
  it('qualifies a valid candidate as CONFIRMED_OPPORTUNITY passing all 14 gates', () => {
    const input = makeCandidateInput();
    const result = evaluateAlertPolicy(input);

    expect(result.passed).toBe(true);
    expect(result.alertClass).toBe('CONFIRMED_OPPORTUNITY');
    expect(result.actionabilityState).toBe('ACTIONABLE');
    expect(result.rejectionReasons).toHaveLength(0);
    expect(result.alertRecord).toBeDefined();
    expect(result.outboxEntry).toBeDefined();
    expect(result.alertRecord?.payload.execution?.netReturnEstimate).toBe(0.45);
  });

  it('rejects CONFIRMED_OPPORTUNITY on critical risk or conflicting state', () => {
    const input = makeCandidateInput({ riskState: 'CRITICAL' });
    const result = evaluateAlertPolicy(input);

    // Critical risk routes to RISK_ALERT instead of CONFIRMED_OPPORTUNITY
    expect(result.alertClass).toBe('RISK_ALERT');
  });

  it('rejects CONFIRMED_OPPORTUNITY when stale market data exceeds maximum limit', () => {
    const staleTime = new Date(Date.parse(iso) - 300 * 1000).toISOString(); // 300s > 180s limit
    const input = makeCandidateInput({
      freshness: {
        marketObservedAt: staleTime,
        holderObservedAt: iso,
        securityObservedAt: iso,
      },
    });

    const result = evaluateAlertPolicy(input);
    expect(result.passed).toBe(false);
    expect(result.rejectionReasons.some((r) => r.startsWith('MARKET_DATA_STALE'))).toBe(true);
  });

  it('rejects CONFIRMED_OPPORTUNITY when Solana security checks fail', () => {
    const input = makeCandidateInput({
      security: {
        mintAuthorityRevokedOrDisabled: false, // Mint authority still active!
        freezeAuthorityDisabled: true,
        lpLockedOrBurned: true,
        criticalSecurityEvents: [],
        findings: [],
      },
    });

    const result = evaluateAlertPolicy(input);
    expect(result.passed).toBe(false);
    expect(result.rejectionReasons).toContain('SECURITY_MINT_AUTHORITY_NOT_REVOKED');
  });

  it('rejects CONFIRMED_OPPORTUNITY on STRICT_FREE cost policy violations', () => {
    const input = makeCandidateInput({
      cost: {
        mode: 'STRICT_FREE',
        costUsd: 0.05, // Paid operation in free tier!
        unknownCostOperationsCount: 0,
      },
    });

    const result = evaluateAlertPolicy(input);
    expect(result.passed).toBe(false);
    expect(result.rejectionReasons.some((r) => r.startsWith('COST_POLICY_VIOLATION_PAID_OP'))).toBe(true);
  });

  it('rejects CONFIRMED_OPPORTUNITY on non-executable tradability or negative net return', () => {
    const input = makeCandidateInput({
      tradability: {
        executable: false,
        expectedSlippageBps: 500,
        feeTotalUsd: '2.00',
        netReturnEstimate: -0.10,
        minLiquidityUsd: 10000,
        currentLiquidityUsd: 2000,
        reason: 'EXCESSIVE_PRICE_IMPACT',
      },
    });

    const result = evaluateAlertPolicy(input);
    expect(result.passed).toBe(false);
    expect(result.rejectionReasons.some((r) => r.startsWith('TRADABILITY_NOT_EXECUTABLE'))).toBe(true);
  });

  it('enforces conservative execution, p90 action delay, statistical gate, source dependence, and quiet hours', () => {
    // 1. Conservative execution pass failure
    const consFailed = evaluateAlertPolicy(
      makeCandidateInput({ tradability: { ...makeCandidateInput().tradability, conservativeExecutionPass: false } }),
      { ...makePolicyConfig(), requireConservativeExecutionPass: true },
    );
    expect(consFailed.passed).toBe(false);
    expect(consFailed.rejectionReasons).toContain('CONSERVATIVE_EXECUTION_GATE_FAILED');

    // 2. P90 action delay pass failure
    const p90Failed = evaluateAlertPolicy(
      makeCandidateInput({ tradability: { ...makeCandidateInput().tradability, p90ActionDelayPass: false } }),
      { ...makePolicyConfig(), requireP90ActionDelayPass: true },
    );
    expect(p90Failed.passed).toBe(false);
    expect(p90Failed.rejectionReasons).toContain('P90_ACTION_DELAY_GATE_FAILED');

    // 3. Statistical gate pass failure
    const statFailed = evaluateAlertPolicy(
      makeCandidateInput({ statisticalGatePass: false }),
      { ...makePolicyConfig(), requireActiveStatisticalGate: true },
    );
    expect(statFailed.passed).toBe(false);
    expect(statFailed.rejectionReasons).toContain('ACTIVE_STATISTICAL_GATE_FAILED');

    // 4. Source dependence exceeds allowed maximum
    const depFailed = evaluateAlertPolicy(
      makeCandidateInput({ sourceDependenceState: 'HIGHLY_DEPENDENT' }),
      { ...makePolicyConfig(), maximumSourceDependenceState: 'PARTIALLY_DEPENDENT' },
    );
    expect(depFailed.passed).toBe(false);
    expect(depFailed.rejectionReasons.some((r) => r.startsWith('SOURCE_DEPENDENCE_EXCEEDS_MAXIMUM'))).toBe(true);

    // 5. Quiet hours active
    const quietFailed = evaluateAlertPolicy(
      makeCandidateInput({ asOf: '2026-03-01T23:30:00.000Z' }),
      { ...makePolicyConfig(), quietHours: { enabled: true, startUtcHour: 22, endUtcHour: 6 } },
    );
    expect(quietFailed.passed).toBe(false);
    expect(quietFailed.rejectionReasons).toContain('QUIET_HOURS_ACTIVE');
  });
});

describe('EARLY_WATCH Guardrails & Language Policy (FR-ALERT-002)', () => {
  it('qualifies an emerging candidate as EARLY_WATCH with short TTL and explicit missing data', () => {
    const input = makeCandidateInput({
      decision: 'WATCH',
      lifecycleState: 'EMERGING',
      dataCoverage: 0.60,
      missingData: [
        { field: 'holderDistribution', reason: 'Wallet clustering index in calculation', severity: 'MEDIUM' },
        { field: 'historicalLiquidity', reason: 'Pool age < 1 hour', severity: 'LOW' },
      ],
      thesis: 'Emerging transaction velocity with initial organic buyer signals.',
    });

    const result = evaluateAlertPolicy(input);
    expect(result.passed).toBe(true);
    expect(result.alertClass).toBe('EARLY_WATCH');
    expect(result.actionabilityState).toBe('WATCH_ONLY');
    expect(result.missingData).toHaveLength(2);

    // TTL check: validUntil duration must be exactly 30 minutes
    const startMs = Date.parse(result.alertRecord!.payload.asOf);
    const endMs = Date.parse(result.alertRecord!.payload.validUntil);
    const durationMinutes = (endMs - startMs) / (60 * 1000);
    expect(durationMinutes).toBe(30);
  });

  it('blocks high-conviction and buy language in EARLY_WATCH and throws/rejects', () => {
    expect(() => {
      assertNoHighConvictionLanguage('This is a strong buy with guaranteed profit!');
    }).toThrow(/HIGH_CONVICTION_LANGUAGE_PROHIBITED/);

    expect(() => {
      assertNoHighConvictionLanguage('Massive breakout 100x gem confirmed');
    }).toThrow(/HIGH_CONVICTION_LANGUAGE_PROHIBITED/);

    const guardrailCheck = validateEarlyWatchGuardrails({
      asOf: iso,
      validUntil: new Date(Date.parse(iso) + 30 * 60 * 1000).toISOString(),
      missingData: [{ field: 'audit', reason: 'Pending', severity: 'HIGH' }],
      thesis: 'Strong buy now for guaranteed 10x returns',
    });

    expect(guardrailCheck.valid).toBe(false);
    expect(guardrailCheck.violations).toContain('EARLY_WATCH_HIGH_CONVICTION_THESIS_PROHIBITED');
  });

  it('rejects EARLY_WATCH if TTL exceeds policy limit or missing data is absent', () => {
    const badTtlCheck = validateEarlyWatchGuardrails({
      asOf: iso,
      validUntil: new Date(Date.parse(iso) + 120 * 60 * 1000).toISOString(), // 120 min > 30 min limit
      missingData: [{ field: 'audit', reason: 'Pending', severity: 'HIGH' }],
      thesis: 'Emerging volume pattern observed.',
    });
    expect(badTtlCheck.valid).toBe(false);
    expect(badTtlCheck.violations.some((v) => v.startsWith('EARLY_WATCH_TTL_EXCEEDS_LIMIT'))).toBe(true);

    const noMissingDataCheck = validateEarlyWatchGuardrails({
      asOf: iso,
      validUntil: new Date(Date.parse(iso) + 30 * 60 * 1000).toISOString(),
      missingData: [], // Missing data required!
      thesis: 'Emerging volume pattern observed.',
    });
    expect(noMissingDataCheck.valid).toBe(false);
    expect(noMissingDataCheck.violations).toContain('EARLY_WATCH_EXPLICIT_MISSING_DATA_REQUIRED');
  });
});

describe('Alert Lifecycle & Deterioration Updates (FR-ALERT-004, AC-141)', () => {
  it('generates OPPORTUNITY_EXPIRED update when valid_until lapses', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const priorAlert = policyResult.alertRecord!;

    // Advance clock past validUntil (validUntil + 1 hour)
    const futureTime = new Date(Date.parse(priorAlert.validUntil) + 3600 * 1000).toISOString();
    const updateResult = evaluateAlertLifecycle(priorAlert, null, futureTime);

    expect(updateResult.decision.transitionType).toBe('OPPORTUNITY_EXPIRED');
    expect(updateResult.decision.actionabilityState).toBe('EXPIRED');
    expect(updateResult.decision.parentAlertId).toBe(priorAlert.alertId);
    expect(updateResult.updatePayload?.alertClass).toBe('OPPORTUNITY_EXPIRED');
    expect(updateResult.outboxEntry?.topic).toBe('alert.production.expired');
  });

  it('generates THESIS_WEAKENING update when score drops sharply or tradability deteriorates', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const priorAlert = policyResult.alertRecord!;

    // New observation with collapsed score and degraded tradability
    const deterioratedCandidate = makeCandidateInput({
      score: 0.30, // Dropped from 0.85 (>30% drop)
      tradability: {
        executable: false,
        expectedSlippageBps: 600,
        feeTotalUsd: '5.00',
        netReturnEstimate: -0.20,
        minLiquidityUsd: 10000,
        currentLiquidityUsd: 1500,
        reason: 'LIQUIDITY_DRAINED',
      },
      materialEvidenceFingerprint: 'b'.repeat(64),
    });

    const updateResult = evaluateAlertLifecycle(priorAlert, deterioratedCandidate, iso);

    expect(updateResult.decision.transitionType).toBe('THESIS_WEAKENING');
    expect(updateResult.decision.actionabilityState).toBe('DETERIORATED');
    expect(updateResult.decision.parentAlertId).toBe(priorAlert.alertId);
    expect(updateResult.updatePayload?.alertClass).toBe('THESIS_WEAKENING');
    expect(updateResult.updatePayload?.actionabilityState).toBe('DETERIORATED');
  });

  it('generates RISK_ALERT and cancels prior alert when critical security event occurs', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const priorAlert = policyResult.alertRecord!;

    const compromisedCandidate = makeCandidateInput({
      riskState: 'CRITICAL',
      security: {
        mintAuthorityRevokedOrDisabled: false,
        freezeAuthorityDisabled: false,
        lpLockedOrBurned: false,
        criticalSecurityEvents: ['FREEZE_AUTHORITY_REACTIVATED', 'LP_UNLOCKED_AND_WITHDRAWN'],
        findings: ['Critical exploit detected'],
      },
      materialEvidenceFingerprint: 'c'.repeat(64),
    });

    const updateResult = evaluateAlertLifecycle(priorAlert, compromisedCandidate, iso);

    expect(updateResult.decision.transitionType).toBe('RISK_ALERT');
    expect(updateResult.decision.actionabilityState).toBe('CANCELLED');
    expect(updateResult.decision.parentAlertId).toBe(priorAlert.alertId);
    expect(updateResult.updatePayload?.alertClass).toBe('RISK_ALERT');
  });

  it('is idempotent and suppresses duplicate update notifications for identical state', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const priorAlert = policyResult.alertRecord!;

    // Identical candidate fingerprint
    const updateResult = evaluateAlertLifecycle(priorAlert, input, iso);

    expect(updateResult.decision.isIdempotentNoOp).toBe(true);
    expect(updateResult.updatePayload).toBeNull();
    expect(updateResult.outboxEntry).toBeNull();
  });

  it('does not suppress deterioration update even if materialEvidenceFingerprint is unchanged', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const priorAlert = policyResult.alertRecord!;

    // Same fingerprint, but non-executable tradability
    const deterioratedCandidate = makeCandidateInput({
      tradability: {
        ...input.tradability,
        executable: false,
        reason: 'SLIPPAGE_TOLERANCE_EXCEEDED',
      },
      materialEvidenceFingerprint: input.materialEvidenceFingerprint, // identical fingerprint!
    });

    const updateResult = evaluateAlertLifecycle(priorAlert, deterioratedCandidate, iso);
    expect(updateResult.decision.isIdempotentNoOp).toBe(false);
    expect(updateResult.decision.transitionType).toBe('THESIS_WEAKENING');
    expect(updateResult.decision.actionabilityState).toBe('DETERIORATED');
  });
});

describe('Distinct Rendering & Routing (FR-ALERT-001, FR-ALERT-002)', () => {
  it('renders deterministically with renderedAt matching payload.asOf by default', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const rendered = renderAlert(policyResult.alertPayload!);

    expect(rendered.renderedAt).toBe(policyResult.alertPayload!.asOf);

    const customRendered = renderAlert(policyResult.alertPayload!, false, { renderedAt: '2026-05-01T00:00:00.000Z' });
    expect(customRendered.renderedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('renders CONFIRMED_OPPORTUNITY with execution impact and research disclaimer', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const rendered = renderAlert(policyResult.alertPayload!);

    expect(rendered.channel).toBe('telegram');
    expect(rendered.priority).toBe('HIGH');
    expect(rendered.headline).toContain('[CONFIRMED OPPORTUNITY]');
    expect(rendered.body).toContain('Modeled Execution Impact');
    expect(rendered.body).toContain('Expected Slippage');
    expect(rendered.disclaimer).toContain('research and educational intelligence purposes only');
  });

  it('renders EARLY_WATCH with explicit missing data breakdown and watch disclaimer', () => {
    const input = makeCandidateInput({
      decision: 'WATCH',
      lifecycleState: 'EMERGING',
      missingData: [{ field: 'securityAudit', reason: 'Formal verification pending', severity: 'HIGH' }],
    });
    const policyResult = evaluateAlertPolicy(input);
    const rendered = renderAlert(policyResult.alertPayload!);

    expect(rendered.channel).toBe('admin_inbox');
    expect(rendered.priority).toBe('NORMAL');
    expect(rendered.headline).toContain('[EARLY WATCH]');
    expect(rendered.body).toContain('Explicit Missing Data');
    expect(rendered.body).toContain('securityAudit');
    expect(rendered.body).toContain('Notice: This is an EARLY WATCH notification');
  });

  it('suppresses positive headline if critical contradiction or expiry is detected', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const payload = policyResult.alertPayload!;

    // Simulate contradiction: actionability changed to DETERIORATED
    const deterioratedPayload = { ...payload, actionabilityState: 'DETERIORATED' as const };
    const rendered = renderAlert(deterioratedPayload);

    expect(rendered.suppressed).toBe(true);
    expect(rendered.headline).toContain('[INVALIDATED OPPORTUNITY]');
  });

  it('determines appropriate channel and priority routing', () => {
    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);
    const routing = determineAlertRouting(policyResult.alertPayload!);

    expect(routing.channel).toBe('telegram');
    expect(routing.priority).toBe('HIGH');

    const semantic = validateAlertSemanticIntegrity(policyResult.alertPayload!);
    expect(semantic.valid).toBe(true);
  });
});

describe('Class-Separated Metrics (FR-ALERT-005, AC-140)', () => {
  it('strictly separates confirmed opportunity metrics from early watch denominator', () => {
    const records: AlertEvaluationMetricRecord[] = [
      // 2 Confirmed Opportunities: 1 Win, 1 Loss -> 50% precision
      {
        alertId: 'alt-c1',
        alertClass: 'CONFIRMED_OPPORTUNITY',
        assetId: 'asset-1',
        asOf: iso,
        actionabilityState: 'ACTIONABLE',
        tradableSuccess: true,
      },
      {
        alertId: 'alt-c2',
        alertClass: 'CONFIRMED_OPPORTUNITY',
        assetId: 'asset-2',
        asOf: iso,
        actionabilityState: 'ACTIONABLE',
        tradableSuccess: false,
      },
      // 3 Early Watches: 2 converted, 1 won -> should NOT dilute confirmed precision
      {
        alertId: 'alt-w1',
        alertClass: 'EARLY_WATCH',
        assetId: 'asset-3',
        asOf: iso,
        actionabilityState: 'WATCH_ONLY',
        convertedToConfirmed: true,
        tradableSuccess: true,
        leadTimeMinutes: 45,
      },
      {
        alertId: 'alt-w2',
        alertClass: 'EARLY_WATCH',
        assetId: 'asset-4',
        asOf: iso,
        actionabilityState: 'WATCH_ONLY',
        convertedToConfirmed: true,
        tradableSuccess: false,
        leadTimeMinutes: 30,
      },
      {
        alertId: 'alt-w3',
        alertClass: 'EARLY_WATCH',
        assetId: 'asset-5',
        asOf: iso,
        actionabilityState: 'WATCH_ONLY',
        convertedToConfirmed: false,
      },
      // 1 Risk Alert: 1 true risk
      {
        alertId: 'alt-r1',
        alertClass: 'RISK_ALERT',
        assetId: 'asset-6',
        asOf: iso,
        actionabilityState: 'ACTIONABLE',
        trueRiskDetected: true,
        warningLeadTimeMinutes: 120,
      },
    ];

    const metrics = computeAlertClassMetrics(records);

    // Confirmed Opportunity Precision = 1 / 2 = 0.50 (Early watch excluded!)
    expect(metrics.confirmedOpportunity.totalAlerts).toBe(2);
    expect(metrics.confirmedOpportunity.tradableSuccessCount).toBe(1);
    expect(metrics.confirmedOpportunity.precision).toBe(0.5);
    expect(metrics.confirmedOpportunity.falseDiscoveryRate).toBe(0.5);
    expect(metrics.confirmedOpportunity.recall).toBe(0.5);

    // Early Watch Metrics
    expect(metrics.earlyWatch.totalWatches).toBe(3);
    expect(metrics.earlyWatch.convertedToConfirmedCount).toBe(2);
    expect(metrics.earlyWatch.conversionRate).toBeCloseTo(0.666667, 4);
    expect(metrics.earlyWatch.watchPrecision).toBe(0.5);
    expect(metrics.earlyWatch.medianLeadTimeMinutes).toBe(37.5);
    expect(metrics.earlyWatch.excludedFromConfirmedPrecision).toBe(true);

    // Risk Alert Metrics
    expect(metrics.riskAlert.totalRiskAlerts).toBe(1);
    expect(metrics.riskAlert.trueRiskCount).toBe(1);
    expect(metrics.riskAlert.precision).toBe(1.0);
    expect(metrics.riskAlert.medianWarningLeadTimeMinutes).toBe(120);
  });
});

describe('Transactional Outbox & Delivery Worker (FR-WF-006, AC-141)', () => {
  it('commits decision observation, alert record, and outbox entry in one atomic transaction and is rerun safe', async () => {
    const database = new MemoryPostgresAdapter();
    await applyBootstrapMigration(database);
    await applyAlertLifecycleMigration(database);

    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);

    await commitAlertTransaction(database, {
      decisionRecord: {
        id: 'obs-dec-1',
        assetId: input.assetId,
        stage: 'decision',
        payload: { disposition: 'ALERT', score: input.score },
        eventTime: input.asOf,
        observedAt: input.asOf,
        availableAt: input.asOf,
        idempotencyKey: `${input.assetId}:decision:${input.asOf}`,
        capabilityMode: 'SYNTHETIC_SHADOW',
        traceId: input.traceId,
      },
      alertRecord: policyResult.alertRecord!,
      outboxEntry: policyResult.outboxEntry!,
    });

    // Re-commit exact same transaction (must safely no-op without mutation)
    await expect(
      commitAlertTransaction(database, {
        alertRecord: policyResult.alertRecord!,
        outboxEntry: policyResult.outboxEntry!,
      }),
    ).resolves.toBeUndefined();

    const alertRows = await database.query<{ alert_id: string; alert_class: string }>(
      'SELECT alert_id, alert_class FROM alerts WHERE alert_id=$1',
      [policyResult.alertRecord!.alertId],
    );
    expect(alertRows.rows).toHaveLength(1);
    expect(alertRows.rows[0]?.alert_class).toBe('CONFIRMED_OPPORTUNITY');

    const outboxRows = await database.query<{ id: string; state: string }>(
      'SELECT id, state FROM outbox WHERE id=$1',
      [policyResult.outboxEntry!.id],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0]?.state).toBe('PENDING');
  });

  it('delivers from outbox idempotently with retry and state updates', async () => {
    const database = new MemoryPostgresAdapter();
    await applyBootstrapMigration(database);
    await applyAlertLifecycleMigration(database);

    const input = makeCandidateInput();
    const policyResult = evaluateAlertPolicy(input);

    await commitAlertTransaction(database, {
      alertRecord: policyResult.alertRecord!,
      outboxEntry: policyResult.outboxEntry!,
    });

    const notifications = new FakeNotificationTransport();
    notifications.failUntil = 1; // First attempt fails, second succeeds

    // First attempt -> retryable failure
    const attempt1 = await processOutboxEntry(database, notifications, policyResult.outboxEntry!.id, iso);
    expect(attempt1.delivered).toBe(false);
    expect(attempt1.state).toBe('RETRY');
    expect(attempt1.attemptCount).toBe(1);

    // Second attempt -> succeeds
    const attempt2 = await processOutboxEntry(database, notifications, policyResult.outboxEntry!.id, iso);
    expect(attempt2.delivered).toBe(true);
    expect(attempt2.state).toBe('DELIVERED');
    expect(attempt2.attemptCount).toBe(2);

    // Third attempt -> idempotent no-op (already delivered)
    const attempt3 = await processOutboxEntry(database, notifications, policyResult.outboxEntry!.id, iso);
    expect(attempt3.delivered).toBe(true);
    expect(attempt3.state).toBe('DELIVERED');
    expect(attempt3.reason).toBe('IDEMPOTENT_ALREADY_DELIVERED');
    expect(notifications.attempts).toBe(2); // No extra network dispatch!
  });
});

describe('Shadow Mode (FR-WF-008)', () => {
  it('produces identical evidence and DB persistence without external notification side effects', async () => {
    const database = new MemoryPostgresAdapter();
    await applyBootstrapMigration(database);
    await applyAlertLifecycleMigration(database);

    const shadowCandidate = makeCandidateInput({ shadowMode: true });
    const policyResult = evaluateAlertPolicy(shadowCandidate);

    expect(policyResult.alertRecord?.shadowMode).toBe(true);
    expect(policyResult.outboxEntry?.topic).toBe('alert.shadow.opportunity');

    await commitAlertTransaction(database, {
      alertRecord: policyResult.alertRecord!,
      outboxEntry: policyResult.outboxEntry!,
    });

    const shadowAdapter = new ShadowNotificationAdapter();
    const delivery = await processOutboxEntry(database, shadowAdapter, policyResult.outboxEntry!.id, iso, {
      shadowMode: true,
    });

    expect(delivery.delivered).toBe(true);
    expect(delivery.state).toBe('DELIVERED');
    expect(shadowAdapter.messages).toHaveLength(1);
    expect(shadowAdapter.messages[0]).toContain('shadow.opportunity');
  });
});
