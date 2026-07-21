import type { DatabaseAdapter, DiscoveryUniverseAdapter, NotificationAdapter, ObjectStoreAdapter } from '@ciag/provider-contracts';
import { assertNoBackdating } from '@ciag/domain';
import { freezeEvidence } from '@ciag/evidence';
import { matureSyntheticOutcome } from '@ciag/evaluation';
import type { InMemoryTracer } from '@ciag/observability';

export interface WalkingSkeletonClock { now(): string; advance(milliseconds: number): void }
export interface WalkingSkeletonResult { assetId: string; observationCount: number; artifactKey: string; outboxState: string; outcomeState: string; capabilityMode: 'SYNTHETIC_SHADOW'; duplicateSuppressed: boolean; traceId: string }

const insertStage = async (database: DatabaseAdapter, input: { id: string; assetId: string; stage: string; payload: unknown; eventTime: string; observedAt: string; availableAt: string; idempotencyKey: string; traceId: string }): Promise<boolean> => {
  assertNoBackdating(input.eventTime, input.availableAt);
  const existing = await database.query('SELECT id FROM synthetic_observations WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (existing.rows.length > 0) return false;
  const result = await database.query(
    `INSERT INTO synthetic_observations (id,asset_id,stage,payload_json,event_time,observed_at,available_at,idempotency_key,capability_mode,trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC_SHADOW',$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.id, input.assetId, input.stage, JSON.stringify(input.payload), input.eventTime, input.observedAt, input.availableAt, input.idempotencyKey, input.traceId],
  );
  return result.rows.length === 1;
};

export const runWalkingSkeleton = async (dependencies: { database: DatabaseAdapter; objectStore: ObjectStoreAdapter; discovery: DiscoveryUniverseAdapter; notifications: NotificationAdapter; clock: WalkingSkeletonClock; tracer: InMemoryTracer }): Promise<WalkingSkeletonResult> => {
  const trace = dependencies.tracer.start('walking-skeleton', { capability: 'SYNTHETIC_SHADOW' });
  const eventTime = dependencies.clock.now();
  const discovered = await dependencies.discovery.discover(eventTime);
  if (discovered.status !== 'AVAILABLE' || !discovered.value?.[0]) throw new Error(discovered.reason ?? 'SYNTHETIC_DISCOVERY_UNAVAILABLE');
  const point = discovered.value[0];
  const asset = point.value;
  const stages = [
    ['discovery', { source: point.provenance }],
    ['canonical_asset', asset],
    ['point_in_time_observation', point],
    ['deterministic_feature', { syntheticMomentum: '0.42', units: 'ratio', sampleSize: 4 }],
    ['candidate', { state: 'SHADOW_CANDIDATE' }],
    ['decision', { disposition: 'OBSERVE_ONLY', confidence: 'SYNTHETIC' }],
  ] as const;
  let inserted = 0;
  for (const [index, [stage, payload]] of stages.entries()) {
    if (await insertStage(dependencies.database, { id: `obs-${index + 1}`, assetId: asset.id, stage, payload, eventTime: point.eventTime, observedAt: point.observedAt, availableAt: point.availableAt, idempotencyKey: `${asset.id}:${stage}:${point.availableAt}`, traceId: trace.span.id })) inserted += 1;
  }
  const duplicateSuppressed = !(await insertStage(dependencies.database, { id: 'obs-duplicate', assetId: asset.id, stage: 'discovery', payload: {}, eventTime: point.eventTime, observedAt: point.observedAt, availableAt: point.availableAt, idempotencyKey: `${asset.id}:discovery:${point.availableAt}`, traceId: trace.span.id }));
  const artifactKey = `evidence/${asset.id.replaceAll(':', '-')}/${point.availableAt.replaceAll(':', '-')}.json`;
  const evidence = await freezeEvidence(dependencies.objectStore, artifactKey, { asset, point, stages, decision: 'OBSERVE_ONLY', traceId: trace.span.id }, dependencies.clock.now());
  await dependencies.database.transaction(async (database) => {
    await database.query(`INSERT INTO artifact_metadata (artifact_key,sha256,media_type,bytes,created_at,frozen,trace_id) VALUES ($1,$2,$3,$4,$5,true,$6) ON CONFLICT (artifact_key) DO NOTHING`, [evidence.artifactKey, evidence.sha256, evidence.mediaType, evidence.bytes, dependencies.clock.now(), trace.span.id]);
    await database.query(`INSERT INTO outbox (id,topic,payload_json,state,attempt_count,available_at,trace_id) VALUES ($1,'synthetic.shadow',$2,'PENDING',0,$3,$4) ON CONFLICT (id) DO NOTHING`, ['outbox-1', JSON.stringify({ assetId: asset.id, evidenceKey: evidence.artifactKey }), dependencies.clock.now(), trace.span.id]);
  });
  let delivery = await dependencies.notifications.enqueue({ outboxId: 'outbox-1', template: 'synthetic-shadow', evidenceKeys: [evidence.artifactKey] });
  if (delivery.status !== 'AVAILABLE') {
    await dependencies.database.query(`UPDATE outbox SET state='RETRY',attempt_count=attempt_count+1 WHERE id='outbox-1'`);
    delivery = await dependencies.notifications.enqueue({ outboxId: 'outbox-1', template: 'synthetic-shadow', evidenceKeys: [evidence.artifactKey] });
  }
  if (delivery.status === 'AVAILABLE') await dependencies.database.query(`UPDATE outbox SET state='DELIVERED',attempt_count=attempt_count+1,delivered_at=$1 WHERE id='outbox-1'`, [dependencies.clock.now()]);
  dependencies.clock.advance(86_400_000);
  const outcome = matureSyntheticOutcome(point.observedAt, dependencies.clock.now(), 43_200_000);
  await dependencies.database.query(`INSERT INTO evaluation_records (id,asset_id,outcome_state,signal_success,tradable_success,evaluated_at,evidence_key,trace_id) VALUES ('eval-1',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [asset.id, outcome.state, outcome.signalSuccess ?? null, outcome.tradableSuccess ?? null, dependencies.clock.now(), evidence.artifactKey, trace.span.id]);
  const observations = await dependencies.database.query<{ count: string }>('SELECT count(*)::text AS count FROM synthetic_observations WHERE asset_id=$1', [asset.id]);
  const outbox = await dependencies.database.query<{ state: string }>(`SELECT state FROM outbox WHERE id='outbox-1'`);
  trace.end();
  return { assetId: asset.id, observationCount: Number(observations.rows[0]?.count ?? inserted), artifactKey, outboxState: outbox.rows[0]?.state ?? 'UNKNOWN', outcomeState: outcome.state, capabilityMode: 'SYNTHETIC_SHADOW', duplicateSuppressed, traceId: trace.span.id };
};

export const replayStagesAsOf = async (database: DatabaseAdapter, assetId: string, asOf: string): Promise<{ stage: string; available_at: string | Date }[]> => { const result = await database.query<{ stage: string; available_at: string | Date }>('SELECT stage, available_at FROM synthetic_observations WHERE asset_id=$1 AND available_at <= $2 ORDER BY available_at, stage', [assetId, asOf]); return result.rows; };
