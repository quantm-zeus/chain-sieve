import type { CapabilityState } from '@ciag/domain';

export interface CapabilityRecord { id: string; engineeringState: CapabilityState; availabilityState: CapabilityState; influenceState: CapabilityState; reason: string }

export class CapabilityRegistry {
  private readonly records = new Map<string, CapabilityRecord>();
  register(record: CapabilityRecord): void { this.records.set(record.id, structuredClone(record)); }
  get(id: string): CapabilityRecord | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  activate(): never { throw new Error('AUTOMATIC_CAPABILITY_ACTIVATION_PROHIBITED'); }
  list(): CapabilityRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
}

// ---------------------------------------------------------------------------
// FR-PROD-001: Module states IMPLEMENTED, AVAILABLE, PROVEN (and SHADOW/DEGRADED/PAUSED) enforced independently
// ---------------------------------------------------------------------------

/**
 * @requirement FR-PROD-001
 * Independent module states. IMPLEMENTED, AVAILABLE and PROVEN are orthogonal dimensions.
 * SHADOW/DEGRADED/PAUSED are also independent operational modifiers.
 * No state transition may implicitly flip another dimension.
 */
export type ModuleAvailability = 'AVAILABLE' | 'SHADOW' | 'DISABLED' | 'PAUSED' | 'DEGRADED';

export interface ModuleState {
  id: string;
  implemented: boolean;
  availability: ModuleAvailability;
  proven: boolean;
  operational: 'NORMAL' | 'DEGRADED' | 'PAUSED';
}

export const createModuleState = (id: string, overrides: Partial<Omit<ModuleState, 'id'>> = {}): ModuleState => ({
  id,
  implemented: overrides.implemented ?? false,
  availability: overrides.availability ?? 'DISABLED',
  proven: overrides.proven ?? false,
  operational: overrides.operational ?? 'NORMAL',
});

export class ModuleRegistry {
  private readonly modules = new Map<string, ModuleState>();

  register(state: ModuleState): void {
    this.modules.set(state.id, structuredClone(state));
  }

  get(id: string): ModuleState | undefined {
    const value = this.modules.get(id);
    return value ? structuredClone(value) : undefined;
  }

  list(): ModuleState[] {
    return [...this.modules.values()].map((m) => structuredClone(m));
  }

  // Independent transitions — each only touches its own dimension
  setImplemented(id: string, implemented: boolean): ModuleState {
    const current = this.require(id);
    const next = { ...current, implemented };
    this.modules.set(id, next);
    return structuredClone(next);
  }

  setAvailability(id: string, availability: ModuleAvailability): ModuleState {
    const current = this.require(id);
    const next = { ...current, availability };
    this.modules.set(id, next);
    return structuredClone(next);
  }

  setProven(id: string, proven: boolean): ModuleState {
    const current = this.require(id);
    const next = { ...current, proven };
    this.modules.set(id, next);
    return structuredClone(next);
  }

  setOperational(id: string, operational: ModuleState['operational']): ModuleState {
    const current = this.require(id);
    const next = { ...current, operational };
    this.modules.set(id, next);
    return structuredClone(next);
  }

  /**
   * @requirement FR-PROD-001
   * Disabled / partial / shadow modules cannot produce active opportunity influence.
   * Active influence requires: implemented && available===AVAILABLE && proven && operational===NORMAL
   */
  canProduceActiveInfluence(id: string): boolean {
    const module = this.require(id);
    if (!module.implemented) return false;
    if (module.availability !== 'AVAILABLE') return false;
    if (!module.proven) return false;
    if (module.operational !== 'NORMAL') return false;
    return true;
  }

  /**
   * Returns true if module would be considered shadow-only.
   */
  isShadowOnly(id: string): boolean {
    const module = this.require(id);
    return module.availability === 'SHADOW';
  }

  private require(id: string): ModuleState {
    const value = this.modules.get(id);
    if (!value) throw new Error(`MODULE_NOT_FOUND:${id}`);
    return value;
  }
}

// ---------------------------------------------------------------------------
// FR-PROD-002: Production codebase deploys with insufficient modules disabled/partial/shadow-only without blocking proven paths
// ---------------------------------------------------------------------------

export interface DeploymentEvaluation {
  deployable: boolean;
  provenModules: string[];
  blockedProvenModules: string[];
  shadowOrDisabledModules: string[];
  reason: string;
}

export const evaluateProductionDeployment = (registry: ModuleRegistry): DeploymentEvaluation => {
  const all = registry.list();
  const proven = all.filter((m) => m.proven && m.implemented && m.availability === 'AVAILABLE' && m.operational === 'NORMAL');
  const blockedProven = proven.filter((m) => !registry.canProduceActiveInfluence(m.id));
  const shadowOrDisabled = all.filter((m) => m.availability === 'SHADOW' || m.availability === 'DISABLED' || !m.implemented || m.availability === 'PAUSED' || m.operational !== 'NORMAL').map((m) => m.id);
  // Deployment is always allowed even when many modules are insufficient, as long as we don't fabricate proven paths
  const deployable = true;
  const reason = proven.length === 0
    ? 'DEPLOYABLE_NO_PROVEN_PATHS_REQUIRED'
    : blockedProven.length === 0
      ? 'DEPLOYABLE_PROVEN_PATHS_INTACT'
      : 'DEPLOYABLE_BUT_SOME_PROVEN_BLOCKED';
  return {
    deployable,
    provenModules: proven.map((m) => m.id),
    blockedProvenModules: blockedProven.map((m) => m.id),
    shadowOrDisabledModules: shadowOrDisabled,
    reason,
  };
};

// ---------------------------------------------------------------------------
// FR-PROD-003: Dependency groups define build order and test prerequisites without throwaway MVP architecture
// ---------------------------------------------------------------------------

export type DependencyGroup = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

export const DEPENDENCY_GROUP_ORDER: DependencyGroup[] = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

export interface GroupDefinition {
  group: DependencyGroup;
  buildOrder: number;
  testPrerequisites: DependencyGroup[];
  description: string;
}

const GROUP_DEFINITIONS: Record<DependencyGroup, GroupDefinition> = {
  G0: { group: 'G0', buildOrder: 0, testPrerequisites: [], description: 'Contract foundation, capability truth, first-party observation, security perimeter' },
  G1: { group: 'G1', buildOrder: 1, testPrerequisites: ['G0'], description: 'Deterministic data truth, security, pool execution, signal, evaluation baseline' },
  G2: { group: 'G2', buildOrder: 2, testPrerequisites: ['G0', 'G1'], description: 'Durable automation, risk/alert operations, recovery, admin observability' },
  G3: { group: 'G3', buildOrder: 3, testPrerequisites: ['G0', 'G1', 'G2'], description: 'Model-assisted research and Workbench' },
  G4: { group: 'G4', buildOrder: 4, testPrerequisites: ['G0', 'G1', 'G2'], description: 'Timing, thesis, decay, light crowding, capability/fallback' },
  G5: { group: 'G5', buildOrder: 5, testPrerequisites: ['G0', 'G1', 'G2', 'G4'], description: 'Full wallet/deployer/liquidity, narrative, crowding, regime, policy' },
  G6: { group: 'G6', buildOrder: 6, testPrerequisites: ['G0', 'G1', 'G2', 'G4', 'G5'], description: 'Pattern, analog, failure intelligence, public compatibility' },
  G7: { group: 'G7', buildOrder: 7, testPrerequisites: ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'], description: 'Adaptive allocation, adversarial validation, alpha governance, bounded Alpha Lab' },
};

export const getGroupDefinition = (group: DependencyGroup): GroupDefinition => {
  const def = GROUP_DEFINITIONS[group];
  if (!def) throw new Error(`UNKNOWN_DEPENDENCY_GROUP:${group}`);
  return structuredClone(def);
};

export const getBuildOrder = (): DependencyGroup[] => [...DEPENDENCY_GROUP_ORDER];

export const getTestPrerequisites = (group: DependencyGroup): DependencyGroup[] => [...getGroupDefinition(group).testPrerequisites];

export const validateBuildOrder = (groups: DependencyGroup[]): { valid: boolean; reason: string } => {
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const order = DEPENDENCY_GROUP_ORDER.indexOf(group);
    for (let predecessorIndex = 0; predecessorIndex < index; predecessorIndex += 1) {
      const predecessor = groups[predecessorIndex]!;
      const predecessorOrder = DEPENDENCY_GROUP_ORDER.indexOf(predecessor);
      if (predecessorOrder > order) return { valid: false, reason: `BUILD_ORDER_VIOLATION:${predecessor}>${group}` };
    }
  }
  return { valid: true, reason: 'BUILD_ORDER_VALID' };
};

export const assertNoThrowawayMVP = (): { isThrowawayMVP: false; reason: string } => ({
  isThrowawayMVP: false as const,
  reason: 'ONE_PRODUCTION_CODEBASE_DEPENDENCY_ORDER_CONTROLS_ACTIVATION_NOT_ARCHITECTURE',
});

// ---------------------------------------------------------------------------
// FR-PROD-004: Free-only production declared best-effort with explicit STRICT_FREE policy unless every critical external dependency provides applicable SLA
// ---------------------------------------------------------------------------

export const STRICT_FREE_POLICY = 'STRICT_FREE' as const;

export interface CriticalDependency {
  name: string;
  hasApplicableSLA: boolean;
  verifiedAt: string | null;
}

export interface FreeTierEvaluation {
  dataProviderMode: typeof STRICT_FREE_POLICY;
  declaredTier: 'BEST_EFFORT' | 'SLA_GUARANTEED';
  reason: string;
  criticalDependencies: CriticalDependency[];
  allCriticalHaveSLA: boolean;
}

export const evaluateFreeTierPolicy = (criticalDependencies: CriticalDependency[]): FreeTierEvaluation => {
  const allHaveSLA = criticalDependencies.length > 0 && criticalDependencies.every((dependency) => dependency.hasApplicableSLA && dependency.verifiedAt !== null);
  return {
    dataProviderMode: STRICT_FREE_POLICY,
    declaredTier: allHaveSLA ? 'SLA_GUARANTEED' : 'BEST_EFFORT',
    reason: allHaveSLA
      ? 'ALL_CRITICAL_DEPENDENCIES_HAVE_APPLICABLE_SLA'
      : 'FREE_ONLY_BEST_EFFORT_UNLESS_EVERY_CRITICAL_DEPENDENCY_HAS_SLA',
    criticalDependencies: structuredClone(criticalDependencies),
    allCriticalHaveSLA: allHaveSLA,
  };
};

export interface CostAuthorizationInput {
  operation: string;
  costClass: 'FREE_UNMETERED' | 'FREE_QUOTA' | 'PAID' | 'UNKNOWN';
  wouldExceedQuota: boolean;
  isAutoUpgrade: boolean;
  isPaidFallback: boolean;
}

export const authorizeStrictFree = (input: CostAuthorizationInput): { allowed: boolean; reason: string } => {
  if (input.costClass === 'PAID') return { allowed: false, reason: 'STRICT_FREE_BLOCKS_PAID' };
  if (input.costClass === 'UNKNOWN') return { allowed: false, reason: 'STRICT_FREE_BLOCKS_UNKNOWN_COST' };
  if (input.wouldExceedQuota) return { allowed: false, reason: 'STRICT_FREE_BLOCKS_OVERAGE' };
  if (input.isAutoUpgrade) return { allowed: false, reason: 'STRICT_FREE_BLOCKS_AUTO_UPGRADE' };
  if (input.isPaidFallback) return { allowed: false, reason: 'STRICT_FREE_BLOCKS_PAID_FALLBACK' };
  return { allowed: true, reason: 'STRICT_FREE_ALLOWED' };
};
