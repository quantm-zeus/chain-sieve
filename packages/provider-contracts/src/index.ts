import type { DegradedResult, PointInTime, SyntheticAsset } from '@ciag/domain';

export interface QueryResult<T extends Record<string, unknown> = Record<string, unknown>> { rows: T[]; rowCount: number }
export interface DatabaseAdapter { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<T>>; transaction<T>(work: (database: DatabaseAdapter) => Promise<T>): Promise<T>; ready(): Promise<boolean>; close(): Promise<void> }
export interface ObjectStoreAdapter { put(key: string, data: Uint8Array, metadata?: Record<string, string>): Promise<{ key: string; sha256: string }>; get(key: string): Promise<Uint8Array | undefined>; exists(key: string): Promise<boolean>; ready(): Promise<boolean> }
export interface RuntimeCacheAdapter { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T, expiresAt: string): Promise<void>; delete(key: string): Promise<void> }
export interface SchedulerAdapter { schedule(input: { idempotencyKey: string; runAt: string; payload: unknown }): Promise<DegradedResult<{ triggerId: string }>>; cancel(triggerId: string): Promise<void> }
export interface DurableWorkflowAdapter { start(input: { workflow: string; idempotencyKey: string; payload: unknown }): Promise<DegradedResult<{ runId: string }>>; resume(runId: string): Promise<DegradedResult<{ runId: string; state: string }>> }
export interface ModelProviderAdapter { generate(input: { purpose: string; promptArtifact: string; maxTokens: number }): Promise<DegradedResult<{ artifactKey: string }>> }
export interface NotificationAdapter { enqueue(input: { outboxId: string; template: string; evidenceKeys: string[] }): Promise<DegradedResult<{ deliveryId: string }>> }
export interface SecretStoreAdapter { getReference(name: string): Promise<DegradedResult<{ reference: string }>> }
export interface CostPolicyAdapter { authorize(input: { operation: string; costClass: 'FREE' | 'METERED' | 'UNKNOWN'; cacheHit: boolean }): Promise<DegradedResult<{ quotaCharged: number }>> }
export interface DiscoveryUniverseAdapter { discover(asOf: string): Promise<DegradedResult<PointInTime<SyntheticAsset>[]>> }
export interface ExecutionSimulatorAdapter { simulate(input: { assetId: string; notional: string; availableAt: string }): Promise<DegradedResult<{ executable: boolean; reason: string }>> }
export interface ChainSecurityAnalyzerAdapter { analyze(input: { assetId: string; availableAt: string }): Promise<DegradedResult<{ findings: string[] }>> }
export interface AlphaArtifactStoreAdapter { stage(input: { key: string; bytes: Uint8Array; evaluationState: 'UNVALIDATED' | 'SHADOW_VALIDATED' }): Promise<{ key: string; state: 'STAGED' }> }
export interface OfflineAlphaLabAdapter { run(manifestKey: string): Promise<DegradedResult<{ artifactKey: string; activationState: 'DISABLED' }>> }
export interface LongRunningCollectorAdapter { checkpoint(partition: string): Promise<DegradedResult<{ slot: bigint }>>; recoverGap(partition: string, from: bigint, to: bigint): Promise<DegradedResult<{ recovered: bigint }>> }
export interface CapacityPlannerAdapter { evaluate(horizon: string): Promise<DegradedResult<{ sustainable: boolean; constraints: string[] }>> }
export interface PoolMathAdapter { quote(input: { programVersion: string; notional: string }): Promise<DegradedResult<{ output: string; parityVerified: boolean }>> }
export interface ProviderDependenceEstimatorAdapter { estimate(sourceIds: string[], availableAt: string): Promise<DegradedResult<{ effectiveIndependentSources: number }>> }
export interface PublicActivationGateAdapter { evaluate(): Promise<{ state: 'DISABLED' | 'BLOCKED' | 'APPROVED'; failedGates: string[] }> }
export interface RequirementTraceabilityAdapter { coverage(): Promise<{ requirements: number; mapped: number; acceptances: number; mappedAcceptances: number }> }
