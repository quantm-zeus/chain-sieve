import { describe, it, expect } from 'vitest';
import {
  ModuleRegistry,
  createModuleState,
  evaluateProductionDeployment,
  getGroupDefinition,
  validateBuildOrder,
  authorizeStrictFree,
  evaluateFreeTierPolicy,
} from '../../packages/capability-registry/src/index.js';
import {
  MCP_BASELINE_REVISION,
  isMcpClientCompatible,
  assertMcpConformance,
  getMcpCompatibilityMatrix,
  createPrecomputedManifest,
  boundedAlphaMatch,
  createExportPackage,
  validateAlphaImport,
} from '../../packages/release-conformance/src/index.js';

describe('T-G2-PROD negative facets', () => {
  it('FR-PROD-001 negative: SHADOW/DISABLED/DEGRADED/PAUSED never yield active influence even when implemented and proven', () => {
    const registry = new ModuleRegistry();
    for (const availability of ['SHADOW', 'DISABLED', 'PAUSED'] as const) {
      const id = `neg-${availability}`;
      registry.register(createModuleState(id, { implemented: true, availability, proven: true }));
      expect(registry.canProduceActiveInfluence(id)).toBe(false);
    }
    registry.register(createModuleState('neg-degraded', { implemented: true, availability: 'AVAILABLE', proven: true, operational: 'DEGRADED' }));
    expect(registry.canProduceActiveInfluence('neg-degraded')).toBe(false);
    registry.register(createModuleState('neg-not-impl', { implemented: false, availability: 'AVAILABLE', proven: true }));
    expect(registry.canProduceActiveInfluence('neg-not-impl')).toBe(false);
    registry.register(createModuleState('neg-unproven', { implemented: true, availability: 'AVAILABLE', proven: false }));
    expect(registry.canProduceActiveInfluence('neg-unproven')).toBe(false);
  });

  it('FR-PROD-002 negative: deployment evaluation does not block on shadow/disabled but flags empty proven', () => {
    const registry = new ModuleRegistry();
    registry.register(createModuleState('shadow-only', { implemented: true, availability: 'SHADOW', proven: false }));
    const evaluation = evaluateProductionDeployment(registry);
    expect(evaluation.deployable).toBe(true);
    expect(evaluation.provenModules).toHaveLength(0);
    expect(evaluation.blockedProvenModules).toHaveLength(0);
  });

  it('FR-PROD-003 negative: unknown group and reverse order fail', () => {
    expect(() => getGroupDefinition('G9' as never)).toThrow('UNKNOWN_DEPENDENCY_GROUP');
    expect(validateBuildOrder(['G2', 'G1']).valid).toBe(false);
    expect(validateBuildOrder(['G2', 'G1']).reason).toContain('BUILD_ORDER_VIOLATION');
  });

  it('FR-PROD-004 negative: STRICT_FREE never allows paid/unknown even when quota not exceeded', () => {
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'PAID', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(false);
    expect(authorizeStrictFree({ operation: 'price.fetch', costClass: 'UNKNOWN', wouldExceedQuota: false, isAutoUpgrade: false, isPaidFallback: false }).allowed).toBe(false);
    // Free-tier best-effort: empty critical list cannot claim SLA guaranteed
    const empty = evaluateFreeTierPolicy([]);
    expect(empty.declaredTier).toBe('BEST_EFFORT');
    expect(empty.allCriticalHaveSLA).toBe(false);
    // Missing verification timestamp fails SLA
    const unverified = evaluateFreeTierPolicy([{ name: 'provider-a', hasApplicableSLA: true, verifiedAt: null }]);
    expect(unverified.declaredTier).toBe('BEST_EFFORT');
  });

  it('FR-PROD-005 negative: unknown revision or draft not conformant, generic client not in baseline', () => {
    expect(MCP_BASELINE_REVISION).toBe('2025-11-25');
    expect(isMcpClientCompatible('2099-99-99', 'claude-desktop')).toBe(false);
    expect(assertMcpConformance('2099-99-99').conformant).toBe(false);
    expect(assertMcpConformance('2026-03-26-draft').conformant).toBe(false);
    const matrix = getMcpCompatibilityMatrix();
    const draftEntries = matrix.filter((entry) => entry.isOptIn);
    expect(draftEntries.length).toBeGreaterThan(0);
    for (const entry of draftEntries) expect(entry.isStable).toBe(false);
  });

  it('FR-PROD-006 negative: tampered artifact, hash mismatch, empty bytes and future cutoff all quarantined or empty', () => {
    const pkg = createExportPackage({
      artifactKey: 'alpha/neg.json',
      bytes: new TextEncoder().encode('valid-bytes'),
      datasetCutoff: '2026-01-01T00:00:00.000Z',
      codeVersion: 'v1.0.0',
    });
    // Signature mismatch
    const tamperedSig = { ...pkg, signature: 'deadbeef' };
    expect(validateAlphaImport(tamperedSig as never).valid).toBe(false);
    expect(validateAlphaImport(tamperedSig as never).quarantined).toBe(true);

    // Hash mismatch
    const badHash = { ...pkg, manifest: { ...pkg.manifest, sha256: '0'.repeat(64) } };
    expect(validateAlphaImport(badHash as never).valid).toBe(false);

    // Empty artifact
    const empty = createExportPackage({ artifactKey: 'alpha/empty.json', bytes: new Uint8Array(0), datasetCutoff: '2026-01-01T00:00:00.000Z', codeVersion: 'v1.0.0' });
    expect(validateAlphaImport(empty).valid).toBe(false);

    // Alpha live path future cutoff yields no matches, not fabricated
    const manifest = createPrecomputedManifest([
      { id: 'future-pat', archetype: 'future', definingSequence: ['a'], invalidatingSequence: ['b'], sampleSize: 10, availableAt: '2099-01-01T00:00:00.000Z', provenance: 'lab' },
    ]);
    const result = boundedAlphaMatch(manifest, {
      candidateFeatures: ['a'],
      asOf: '2026-01-15T00:00:00.000Z',
      availableAtCutoff: '2026-01-01T00:00:00.000Z',
    });
    expect(result.matched.length).toBe(0);
    expect(result.bounded).toBe(true);
  });

  it('FR-PROD-006 negative: bounded live path refuses to exceed limits rather than running heavy job inline', () => {
    const largePatterns = Array.from({ length: 1001 }, (_, index) => ({
      id: `large-${index}`,
      archetype: 'test',
      definingSequence: ['feat'],
      invalidatingSequence: ['invalid'],
      sampleSize: 1,
      availableAt: '2026-01-01T00:00:00.000Z',
      provenance: 'lab',
    }));
    const manifest = createPrecomputedManifest(largePatterns);
    const result = boundedAlphaMatch(manifest, {
      candidateFeatures: ['feat'],
      asOf: '2026-01-15T00:00:00.000Z',
      availableAtCutoff: '2026-01-16T00:00:00.000Z',
    });
    expect(result.rejectedAsUnbounded).toBe(true);
    expect(result.matched.length).toBe(0);
  });

  it('FR-PROD-001 negative: missing module lookup fails closed', () => {
    const registry = new ModuleRegistry();
    expect(() => registry.canProduceActiveInfluence('nonexistent')).toThrow('MODULE_NOT_FOUND');
  });
});
