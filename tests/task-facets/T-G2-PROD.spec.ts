import { describe, it, expect } from 'vitest';
import {
  ModuleRegistry,
  createModuleState,
  evaluateProductionDeployment,
  getBuildOrder,
  getTestPrerequisites,
  validateBuildOrder,
  assertNoThrowawayMVP,
  evaluateFreeTierPolicy,
  authorizeStrictFree,
  STRICT_FREE_POLICY,
} from '../../packages/capability-registry/src/index.js';
import {
  MCP_BASELINE_REVISION,
  getMcpCompatibilityMatrix,
  isMcpRevisionStable,
  isMcpDraftOptIn,
  isMcpClientCompatible,
  assertMcpConformance,
  createPrecomputedManifest,
  boundedAlphaMatch,
  createExportPackage,
  validateAlphaImport,
  isolateHeavyAlphaLabJob,
  verifyExportIsolation,
  getProductionGovernanceStatus,
} from '../../packages/release-conformance/src/index.js';

// FR-PROD-001..006 positive facets consumed by AC-144, AC-150..154, AC-272..279 interface facets
describe('T-G2-PROD production governance facets', () => {
  // AC-152: module can be deployed as IMPLEMENTED while remaining unavailable/shadow and cannot support alert claims until AVAILABLE
  it('FR-PROD-001: IMPLEMENTED, AVAILABLE, PROVEN are independent and shadow/disabled cannot influence', () => {
    const registry = new ModuleRegistry();
    registry.register(createModuleState('mod-alpha', { implemented: true, availability: 'SHADOW', proven: false }));
    registry.register(createModuleState('mod-beta', { implemented: true, availability: 'AVAILABLE', proven: true }));
    registry.register(createModuleState('mod-gamma', { implemented: false, availability: 'DISABLED', proven: false }));
    registry.register(createModuleState('mod-degraded', { implemented: true, availability: 'AVAILABLE', proven: true, operational: 'DEGRADED' }));
    registry.register(createModuleState('mod-paused', { implemented: true, availability: 'PAUSED', proven: true }));

    // Independent: setting PROVEN does not affect IMPLEMENTED/AVAILABLE
    expect(registry.get('mod-alpha')?.implemented).toBe(true);
    expect(registry.get('mod-alpha')?.availability).toBe('SHADOW');
    registry.setProven('mod-alpha', true);
    expect(registry.get('mod-alpha')?.implemented).toBe(true);
    expect(registry.get('mod-alpha')?.availability).toBe('SHADOW');
    expect(registry.get('mod-alpha')?.proven).toBe(true);

    registry.setAvailability('mod-alpha', 'AVAILABLE');
    expect(registry.get('mod-alpha')?.proven).toBe(true);
    expect(registry.get('mod-alpha')?.implemented).toBe(true);

    // Active influence only when IMPLEMENTED && AVAILABLE && PROVEN && NORMAL
    expect(registry.canProduceActiveInfluence('mod-alpha')).toBe(true);
    expect(registry.canProduceActiveInfluence('mod-beta')).toBe(true);
    expect(registry.canProduceActiveInfluence('mod-gamma')).toBe(false);
    expect(registry.canProduceActiveInfluence('mod-degraded')).toBe(false);
    expect(registry.canProduceActiveInfluence('mod-paused')).toBe(false);

    // Shadow transition does not auto-clear proven
    registry.setAvailability('mod-beta', 'SHADOW');
    expect(registry.canProduceActiveInfluence('mod-beta')).toBe(false);
    expect(registry.get('mod-beta')?.proven).toBe(true);
    expect(registry.get('mod-beta')?.implemented).toBe(true);
  });

  // FR-PROD-002: production codebase deploys with insufficient modules disabled/partial/shadow-only without blocking proven paths
  it('FR-PROD-002: deployment remains deployable with disabled/partial/shadow modules', () => {
    const registry = new ModuleRegistry();
    registry.register(createModuleState('proven-a', { implemented: true, availability: 'AVAILABLE', proven: true }));
    registry.register(createModuleState('shadow-b', { implemented: true, availability: 'SHADOW', proven: false }));
    registry.register(createModuleState('disabled-c', { implemented: false, availability: 'DISABLED', proven: false }));
    registry.register(createModuleState('paused-d', { implemented: true, availability: 'PAUSED', proven: true }));

    const evaluation = evaluateProductionDeployment(registry);
    expect(evaluation.deployable).toBe(true);
    expect(evaluation.provenModules).toContain('proven-a');
    expect(evaluation.blockedProvenModules).toHaveLength(0);
    expect(evaluation.shadowOrDisabledModules).toContain('shadow-b');
    expect(evaluation.shadowOrDisabledModules).toContain('disabled-c');

    // Even with zero proven modules, deployment still allowed (proven paths not blocked, just absent)
    const empty = new ModuleRegistry();
    empty.register(createModuleState('only-shadow', { implemented: true, availability: 'SHADOW', proven: false }));
    const emptyEval = evaluateProductionDeployment(empty);
    expect(emptyEval.deployable).toBe(true);
    expect(emptyEval.reason).toBe('DEPLOYABLE_NO_PROVEN_PATHS_REQUIRED');
  });

  // FR-PROD-003: dependency groups define build order and test prerequisites without throwaway MVP
  it('FR-PROD-003: dependency groups enforce build order and test prerequisites', () => {
    const order = getBuildOrder();
    expect(order).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
    expect(validateBuildOrder(['G0', 'G1', 'G2']).valid).toBe(true);
    expect(validateBuildOrder(['G1', 'G0']).valid).toBe(false);
    expect(getTestPrerequisites('G2')).toEqual(['G0', 'G1']);
    expect(getTestPrerequisites('G0')).toEqual([]);
    expect(getTestPrerequisites('G7')).toContain('G0');
    expect(assertNoThrowawayMVP().isThrowawayMVP).toBe(false);
    expect(assertNoThrowawayMVP().reason).toContain('ONE_PRODUCTION_CODEBASE');
  });

  // FR-PROD-004: free-only production declared best-effort with STRICT_FREE unless every critical external dependency provides SLA
  it('FR-PROD-004: STRICT_FREE best-effort unless every critical dependency has SLA', () => {
    const bestEffort = evaluateFreeTierPolicy([
      { name: 'dexscreener', hasApplicableSLA: false, verifiedAt: null },
      { name: 'helius', hasApplicableSLA: true, verifiedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(bestEffort.dataProviderMode).toBe(STRICT_FREE_POLICY);
    expect(bestEffort.declaredTier).toBe('BEST_EFFORT');
    expect(bestEffort.allCriticalHaveSLA).toBe(false);

    const slaGuaranteed = evaluateFreeTierPolicy([
      { name: 'dexscreener', hasApplicableSLA: true, verifiedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'helius', hasApplicableSLA: true, verifiedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(slaGuaranteed.declaredTier).toBe('SLA_GUARANTEED');
    expect(slaGuaranteed.allCriticalHaveSLA).toBe(true);

    // STRICT_FREE blocks paid/unknown/overage/auto-upgrade/paid-fallback before network
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'PAID', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'UNKNOWN', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'FREE_QUOTA', wouldExceedQuota: true, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'FREE_QUOTA', wouldExceedQuota: false, isAutoUpgrade: true, isPaidFallback: false }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'FREE_QUOTA', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: true }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'FREE_QUOTA', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(true);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'FREE_UNMETERED', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(true);
  });

  // FR-PROD-005: MCP compatibility matrix baseline 2025-11-25
  it('FR-PROD-005: MCP compatibility matrix governs revisions and clients', () => {
    expect(MCP_BASELINE_REVISION).toBe('2025-11-25');
    const matrix = getMcpCompatibilityMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.filter((entry) => entry.revision === MCP_BASELINE_REVISION).length).toBeGreaterThanOrEqual(5);
    expect(isMcpRevisionStable('2025-11-25')).toBe(true);
    expect(isMcpRevisionStable('2026-03-26-draft')).toBe(false);
    expect(isMcpDraftOptIn('2026-03-26-draft')).toBe(true);
    expect(isMcpDraftOptIn('2025-11-25')).toBe(false);
    expect(isMcpClientCompatible('2025-11-25', 'claude-desktop')).toBe(true);
    expect(isMcpClientCompatible('2025-11-25', 'chatgpt')).toBe(true);
    expect(isMcpClientCompatible('2026-03-26-draft', 'claude-desktop')).toBe(false);
    expect(assertMcpConformance('2025-11-25').conformant).toBe(true);
    expect(assertMcpConformance('2026-03-26-draft').conformant).toBe(false);
    expect(assertMcpConformance('2026-03-26-draft').reason).toBe('MCP_DRAFT_REQUIRES_OPT_IN');
  });

  // FR-PROD-006: bounded precomputed alpha matching and export/import trust boundary
  it('FR-PROD-006: production live paths use bounded precomputed alpha matching', () => {
    const manifest = createPrecomputedManifest([
      { id: 'pat-1', archetype: 'wick-then-fill', definingSequence: ['spike', 'retrace'], invalidatingSequence: ['rug'], sampleSize: 100, availableAt: '2026-01-01T00:00:00.000Z', provenance: 'alpha-lab-v1' },
      { id: 'pat-2', archetype: 'accumulation', definingSequence: ['accum', 'breakout'], invalidatingSequence: ['dump'], sampleSize: 80, availableAt: '2026-01-10T00:00:00.000Z', provenance: 'alpha-lab-v1' },
    ]);

    const hit = boundedAlphaMatch(manifest, {
      candidateFeatures: ['spike', 'retrace', 'volume-up'],
      asOf: '2026-01-15T00:00:00.000Z',
      availableAtCutoff: '2026-01-16T00:00:00.000Z',
    });
    expect(hit.bounded).toBe(true);
    expect(hit.matched.map((pattern) => pattern.id)).toContain('pat-1');
    expect(hit.matched.map((pattern) => pattern.id)).not.toContain('pat-2');
    expect(hit.evaluatedPatterns).toBe(2);

    // Point-in-time: future pattern not available
    const early = boundedAlphaMatch(manifest, {
      candidateFeatures: ['accum', 'breakout'],
      asOf: '2026-01-05T00:00:00.000Z',
      availableAtCutoff: '2026-01-05T00:00:00.000Z',
    });
    expect(early.matched.length).toBe(0);

    // Invalidating sequence blocks match
    const blocked = boundedAlphaMatch(manifest, {
      candidateFeatures: ['spike', 'retrace', 'rug'],
      asOf: '2026-01-15T00:00:00.000Z',
      availableAtCutoff: '2026-01-16T00:00:00.000Z',
    });
    expect(blocked.matched.length).toBe(0);

    // Bounded limit exceeded
    const bigPatterns = Array.from({ length: 1001 }, (_, index) => ({
      id: `pat-${index}`,
      archetype: 'bulk',
      definingSequence: ['x'],
      invalidatingSequence: ['y'],
      sampleSize: 10,
      availableAt: '2026-01-01T00:00:00.000Z',
      provenance: 'lab',
    }));
    const bigManifest = createPrecomputedManifest(bigPatterns);
    const exceeded = boundedAlphaMatch(bigManifest, {
      candidateFeatures: ['x'],
      asOf: '2026-01-15T00:00:00.000Z',
      availableAtCutoff: '2026-01-16T00:00:00.000Z',
    });
    expect(exceeded.rejectedAsUnbounded).toBe(true);
  });

  it('FR-PROD-006: heavy Alpha Lab jobs isolated behind export/import trust boundary with signature and schema validation', () => {
    const pkg = createExportPackage({
      artifactKey: 'alpha/pattern-001.json',
      bytes: new TextEncoder().encode(JSON.stringify({ pattern: 'wick' })),
      datasetCutoff: '2026-01-01T00:00:00.000Z',
      codeVersion: 'v1.0.0',
    });
    const valid = validateAlphaImport(pkg);
    expect(valid.valid).toBe(true);
    expect(valid.quarantined).toBe(false);

    // Tampered bytes -> signature mismatch -> quarantined
    const tampered = { ...pkg, bytes: new TextEncoder().encode('tampered') } as typeof pkg;
    const tamperedResult = validateAlphaImport(tampered);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.quarantined).toBe(true);
    expect(tamperedResult.reason).toBe('SIGNATURE_MISMATCH');

    // Schema version rejected
    const badSchema = { ...pkg, manifest: { ...pkg.manifest, schemaVersion: '9.9.9' } };
    expect(validateAlphaImport(badSchema as never).valid).toBe(false);

    // Untrusted signer
    const badSigner = { ...pkg, signer: 'evil-signer' };
    expect(validateAlphaImport(badSigner as never).valid).toBe(false);

    // Isolation properties
    expect(isolateHeavyAlphaLabJob().isolated).toBe(true);
    expect(isolateHeavyAlphaLabJob().trustBoundary).toContain('SIGNATURE');
    expect(verifyExportIsolation({ hasExportedPackage: true, mutatedLivePolicy: false, calledPaidProvider: false }).valid).toBe(true);
    expect(verifyExportIsolation({ hasExportedPackage: true, mutatedLivePolicy: true, calledPaidProvider: false }).valid).toBe(false);
    expect(verifyExportIsolation({ hasExportedPackage: false, mutatedLivePolicy: false, calledPaidProvider: false }).valid).toBe(false);
  });

  it('aggregate production governance status exposes all FR-PROD dimensions', () => {
    const status = getProductionGovernanceStatus();
    expect(status.moduleStatesIndependent).toBe(true);
    expect(status.deployableWithInsufficientModules).toBe(true);
    expect(status.dependencyGroupsOrdered).toBe(true);
    expect(status.freeTierBestEffort).toBe(true);
    expect(status.mcpBaselineConformant).toBe(true);
    expect(status.alphaLiveBounded).toBe(true);
    expect(status.alphaImportBoundaryEnforced).toBe(true);
  });

  // Property-style: seeded fault would invert PROVEN check; ensure correct behavior still holds across many permutations
  it('property: seeded-fault simulation – toggling proven must flip influence deterministically', () => {
    const registry = new ModuleRegistry();
    for (let index = 0; index < 20; index += 1) {
      const id = `prop-${index}`;
      registry.register(createModuleState(id, { implemented: true, availability: 'AVAILABLE', proven: index % 2 === 0 }));
      const expected = index % 2 === 0;
      expect(registry.canProduceActiveInfluence(id)).toBe(expected);
    }
    // If implementation mistakenly ignored proven, this would fail – seeded fault is caught
    const faultCheck = registry.get('prop-1');
    expect(faultCheck?.proven).toBe(false);
    expect(registry.canProduceActiveInfluence('prop-1')).toBe(false);
  });
});
