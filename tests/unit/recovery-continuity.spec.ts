import { describe, it, expect } from 'vitest';
import { MemoryPostgresAdapter, VirtualClock } from '@ciag/test-fixtures';
import {
  applyBootstrapMigration,
  applyDurableWorkflowMigration,
  applyAlertLifecycleMigration,
  applySchedulingControlPlaneMigration,
  applyRecoveryContinuityMigration,
} from '@ciag/persistence';
import {
  createRetentionPolicy,
  createBackupRecord,
  enforceRetentionAndDelete,
  createLegalHold,
  releaseLegalHold,
  requestRestoreAccess,
  verifyBackupAuditChain,
  runDestructiveRestoreDrill,
  reconcileAfterRecovery,
  enterDegradedMode,
  exitDegradedMode,
  isConfirmedOpportunityDisabled,
  validateFencingToken,
  acquireLease,
} from '@ciag/workflow-runtime';

const setupDb = async () => {
  const db = new MemoryPostgresAdapter();
  await applyBootstrapMigration(db);
  await applyDurableWorkflowMigration(db);
  await applyAlertLifecycleMigration(db);
  await applySchedulingControlPlaneMigration(db);
  await applyRecoveryContinuityMigration(db);
  return db;
};

describe('Recovery Continuity — FR-DR-003/004/005/006', () => {
  it('retention is versioned, access-controlled and audited with chain verification', async () => {
    const db = await setupDb();
    const clock = new VirtualClock();

    // Owner creates tiered retention policies
    const p1 = await createRetentionPolicy(db, {
      tier: 'CRITICAL_CONFIG',
      retentionDays: 30,
      geographicLocation: 'us-east-1',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k1', keyVersion: 1 },
      rightsConstraints: [{ dataClass: 'config', retentionAllowed: true }],
      actor: 'owner@chainsieve',
      role: 'owner',
      now: clock.now(),
    });
    expect(p1.version).toBe(1);

    const p2 = await createRetentionPolicy(db, {
      tier: 'CRITICAL_CONFIG',
      retentionDays: 60,
      geographicLocation: 'eu-west-1',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k2', keyVersion: 1 },
      rightsConstraints: [{ dataClass: 'config', retentionAllowed: true }],
      actor: 'owner@chainsieve',
      role: 'owner',
      now: clock.now(),
      previousVersionId: p1.id,
    });
    expect(p2.version).toBe(2);

    // Viewer cannot create retention — denied
    await expect(
      createRetentionPolicy(db, {
        tier: 'REPLAYABLE_RAW',
        retentionDays: 7,
        geographicLocation: 'us-east-1',
        encryption: { algorithm: 'AES-256-GCM', keyId: 'k3', keyVersion: 1 },
        rightsConstraints: [{ dataClass: 'raw', retentionAllowed: true }],
        actor: 'viewer@chainsieve',
        role: 'viewer',
        now: clock.now(),
      }),
    ).rejects.toThrow('RETENTION_ACCESS_DENIED');

    // Audit chain valid
    const chain = await verifyBackupAuditChain(db);
    expect(chain.valid).toBe(true);

    // Create backup record with geographic/encryption/rights
    const backup = await createBackupRecord(db, {
      tier: 'CRITICAL_CONFIG',
      location: 's3://bucket/backup-1',
      geographicLocation: 'us-east-1',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k1', keyVersion: 1 },
      hash: 'a'.repeat(64),
      sizeBytes: 1024,
      retentionPolicyId: p2.id,
      rightsConstraints: [{ dataClass: 'config', retentionAllowed: true }],
      now: clock.now(),
      actor: 'owner@chainsieve',
      role: 'owner',
    });
    expect(backup.id).toBeDefined();

    // Legal hold prevents deletion even when expired
    clock.advance(61 * 86400000);
    await createLegalHold(db, backup.id, 'litigation hold', 'owner@chainsieve', 'owner', clock.now());
    const enforced1 = await enforceRetentionAndDelete(db, clock.now(), 'owner@chainsieve', 'owner');
    expect(enforced1.held).toContain(backup.id);
    expect(enforced1.deleted).not.toContain(backup.id);

    // Release hold then deletion succeeds
    const holds = await db.query<{ id: string }>(`SELECT id FROM backup_legal_holds WHERE backup_record_id=$1`, [backup.id]);
    await releaseLegalHold(db, holds.rows[0]!.id, 'owner@chainsieve', 'owner', clock.now());
    const enforced2 = await enforceRetentionAndDelete(db, clock.now(), 'owner@chainsieve', 'owner');
    expect(enforced2.deleted).toContain(backup.id);

    // Non-owner cannot delete
    await expect(enforceRetentionAndDelete(db, clock.now(), 'viewer@chainsieve', 'viewer')).rejects.toThrow(
      'RETENTION_DELETE_ACCESS_DENIED',
    );

    // Viewer restore denied, owner granted; both audited
    const backup2 = await createBackupRecord(db, {
      tier: 'REPLAYABLE_RAW',
      location: 's3://bucket/backup-2',
      geographicLocation: 'us-west-2',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k3', keyVersion: 1 },
      hash: 'b'.repeat(64),
      sizeBytes: 2048,
      retentionPolicyId: p1.id,
      now: clock.now(),
      actor: 'owner@chainsieve',
      role: 'owner',
    });
    const denied = await requestRestoreAccess(db, backup2.id, 'viewer@chainsieve', 'viewer', 'need restore', clock.now());
    expect(denied.granted).toBe(false);
    const granted = await requestRestoreAccess(db, backup2.id, 'owner@chainsieve', 'owner', 'DR drill', clock.now());
    expect(granted.granted).toBe(true);

    const finalChain = await verifyBackupAuditChain(db);
    expect(finalChain.valid).toBe(true);
    await db.close();
  });

  it('destructive restore drill rebuilds clean env, verifies hashes/chains, replays migrations, restores cross-store refs, re-establishes checkpoints and measures RPO/RTO', async () => {
    const db = await setupDb();
    const clock = new VirtualClock();

    const policy = await createRetentionPolicy(db, {
      tier: 'CRITICAL_CONFIG',
      retentionDays: 30,
      geographicLocation: 'us-east-1',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k-drill', keyVersion: 1 },
      rightsConstraints: [{ dataClass: 'config', retentionAllowed: true }],
      actor: 'owner@chainsieve',
      role: 'owner',
      now: clock.now(),
    });
    const backup = await createBackupRecord(db, {
      tier: 'CRITICAL_CONFIG',
      location: 's3://bucket/drill-backup',
      geographicLocation: 'us-east-1',
      encryption: { algorithm: 'AES-256-GCM', keyId: 'k-drill', keyVersion: 1 },
      hash: 'c'.repeat(64),
      sizeBytes: 4096,
      retentionPolicyId: policy.id,
      now: clock.now(),
      actor: 'owner@chainsieve',
      role: 'owner',
    });

    // Seed some artifact and audit data for verification
    await db.query(
      `INSERT INTO artifact_metadata (artifact_key, sha256, media_type, bytes, created_at, frozen, trace_id) VALUES ($1,$2,$3,$4,$5,true,$6)`,
      ['evidence/asset-1/2026-01-01.json', 'd'.repeat(64), 'application/json', 100, clock.now(), 'trace-1'],
    );
    await db.query(
      `INSERT INTO audit_records (id, event_type, actor, payload_json, previous_hash, record_hash, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['audit-1', 'TEST', 'system', JSON.stringify({}), null, 'e'.repeat(64), clock.now()],
    );
    await db.query(`INSERT INTO collector_checkpoints (partition, slot, sequence, updated_at) VALUES ($1,$2,$3,$4)`, [
      'partition-1',
      100,
      1,
      clock.now(),
    ]);
    await db.query(
      `INSERT INTO synthetic_observations (id, asset_id, stage, payload_json, event_time, observed_at, available_at, idempotency_key, capability_mode, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC_SHADOW',$9)`,
      ['obs-1', 'partition-1', 'discovery', JSON.stringify({}), clock.now(), clock.now(), clock.now(), 'idem-1', 'trace-1'],
    );

    // Immediate drill should meet 15m RPO
    const result = await runDestructiveRestoreDrill(db, {
      tier: 'CRITICAL_CONFIG',
      backupRecordId: backup.id,
      now: clock.now(),
      actor: 'owner@chainsieve',
      role: 'owner',
    });
    expect(result.artifactsVerified).toBe(true);
    expect(result.auditChainVerified).toBe(true);
    expect(result.migrationsReplayed).toBe(true);
    expect(result.crossStoreReferencesRestored).toBe(true);
    expect(result.collectorCheckpointsReestablished).toBe(true);
    expect(result.hiddenGaps).toBe(0);
    expect(result.targetRpoMinutes).toBe(15);
    expect(result.meetsRpo).toBe(true);
    expect(result.status).toBe('PASSED');
    expect(result.degradedEntered).toBe(false);

    // Stale backup — RPO miss should auto-degrade and disable confirmed opportunity alerts
    clock.advance(30 * 60000); // 30 min later, exceeds 15m RPO
    const staleResult = await runDestructiveRestoreDrill(db, {
      tier: 'CRITICAL_CONFIG',
      backupRecordId: backup.id,
      now: clock.now(),
      actor: 'owner@chainsieve',
      role: 'owner',
    });
    expect(staleResult.meetsRpo).toBe(false);
    expect(staleResult.degradedEntered).toBe(true);
    const disabled = await isConfirmedOpportunityDisabled(db);
    expect(disabled).toBe(true);

    // Exit degraded, alerts re-enabled
    await exitDegradedMode(db, 'CRITICAL_CONFIG', clock.now());
    expect(await isConfirmedOpportunityDisabled(db)).toBe(false);
    await db.close();
  });

  it('post-recovery reconciliation reconciles all domains and rejects stale fencing tokens before resuming', async () => {
    const db = await setupDb();
    const clock = new VirtualClock();

    // Create workflow lease and step with valid fencing
    await acquireLease(db, 'lease-run-1', 'worker-a', 60000, clock.now());
    await db.query(
      `INSERT INTO workflow_runs (id, workflow_name, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
      ['run-1', 'test-workflow', 'RUNNING', clock.now()],
    );
    await db.query(
      `INSERT INTO workflow_steps (step_id, run_id, step_type, idempotency_key, attempt, input_hash, status, lease_owner, lease_version, lease_expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,0,$5,'RUNNING',$6,1,$7,$8,$8)`,
      ['step-1', 'run-1', 'fetch', 'idem-step-1', 'h1', 'worker-a', new Date(Date.parse(clock.now()) + 60000).toISOString(), clock.now()],
    );
    // Also create a lease for that step key so fencing validation finds it
    await acquireLease(db, 'lease-step-1', 'worker-a', 60000, clock.now());

    // Create trigger inbox and outbox entries
    await db.query(
      `INSERT INTO trigger_inbox (id, source, external_message_id, payload_hash, received_at, status, created_at) VALUES ($1,$2,$3,$4,$5,'RECEIVED',$5)`,
      ['inbox-1', 'qstash', 'msg-1', 'h1', clock.now()],
    );
    await db.query(
      `INSERT INTO outbox (id, topic, payload_json, state, attempt_count, available_at, trace_id) VALUES ($1,$2,$3,'PENDING',0,$4,$5)`,
      ['outbox-1', 'test.topic', JSON.stringify({}), clock.now(), 'trace-1'],
    );
    await db.query(
      `INSERT INTO alerts (alert_id, asset_id, alert_class, actionability_state, fingerprint, valid_until, payload_json, canonical_json, sha256, bytes, created_at, shadow_mode, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      ['alert-1', 'asset-1', 'CONFIRMED_OPPORTUNITY', 'ACTIONABLE', 'fp1', new Date(Date.parse(clock.now()) + 3600000).toISOString(), JSON.stringify({}), '{}', 'f'.repeat(64), 100, clock.now(), false, 'trace-1'],
    );

    const recon = await reconcileAfterRecovery(db, { recoveryId: 'rec-1', now: clock.now() });
    expect(recon.allReconciled).toBe(true);
    expect(recon.canResume).toBe(true);
    expect(recon.fencingStaleRejected).toBeDefined();

    // Stale fencing token rejected
    await acquireLease(db, 'lease-stale', 'worker-b', 1000, clock.now());
    clock.advance(2000);
    // Try to validate old token — should be stale
    const validated = await validateFencingToken(db, 'lease-stale', 'worker-b', 1);
    expect(validated.stale).toBe(true);
    expect(validated.valid).toBe(false);

    // Acquire new lease with different owner, old token stale
    const l1 = await acquireLease(db, 'lease-fence', 'owner-1', 60000, clock.now());
    const stale = await validateFencingToken(db, 'lease-fence', 'owner-1', l1.version - 1);
    // version -1 doesn't exist — stale
    expect(stale.valid).toBe(false);
    await db.close();
  });

  it('tier miss auto-degrades per degraded-mode matrix and disables confirmed opportunity until continuity restored', async () => {
    const db = await setupDb();
    const clock = new VirtualClock();

    await enterDegradedMode(db, 'CRITICAL_OBSERVATIONS', 'RPO miss 90m > 60m', clock.now());
    expect(await isConfirmedOpportunityDisabled(db)).toBe(true);

    // REPLAYABLE_RAW miss does NOT disable confirmed opportunity per matrix
    await exitDegradedMode(db, 'CRITICAL_OBSERVATIONS', clock.now());
    await enterDegradedMode(db, 'REPLAYABLE_RAW', 'RPO miss', clock.now());
    // But if critical still active, still disabled — clear all first
    await exitDegradedMode(db, 'REPLAYABLE_RAW', clock.now());
    await enterDegradedMode(db, 'REPLAYABLE_RAW', 'raw miss', clock.now());
    // REPLAYABLE_RAW alone should not disable confirmed opportunity per matrix (capability PARTIAL)
    // Our implementation disables only for CRITICAL tiers; check that REPLAYABLE_RAW alone leaves opportunity enabled
    // Clear and test isolated REPLAYABLE_RAW
    await exitDegradedMode(db, 'REPLAYABLE_RAW', clock.now());
    await enterDegradedMode(db, 'REPLAYABLE_RAW', 'raw isolated', clock.now(), 'degraded-raw-isolated');
    const stillDisabled = await isConfirmedOpportunityDisabled(db);
    // REPLAYABLE_RAW matrix says disableConfirmedOpportunity:false, so not disabled
    expect(stillDisabled).toBe(false);
    await exitDegradedMode(db, 'REPLAYABLE_RAW', clock.now());
    expect(await isConfirmedOpportunityDisabled(db)).toBe(false);
    await db.close();
  });
});
