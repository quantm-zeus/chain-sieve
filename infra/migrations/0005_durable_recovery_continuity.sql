-- Durable Recovery Continuity — FR-DR-003/004/005/006
-- Tiered backup, restore drills, reconciliation, degraded mode, retention audit

CREATE TABLE IF NOT EXISTS backup_retention_policies (
  id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('CRITICAL_CONFIG','CRITICAL_OBSERVATIONS','REPLAYABLE_RAW')),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  version integer NOT NULL CHECK (version > 0),
  geographic_location text NOT NULL CHECK (geographic_location IN ('us-east-1','us-west-2','eu-west-1','ap-northeast-1')),
  encryption_json jsonb NOT NULL,
  rights_constraints_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  previous_version_id text REFERENCES backup_retention_policies(id),
  UNIQUE (tier, version)
);

CREATE TABLE IF NOT EXISTS backup_records (
  id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('CRITICAL_CONFIG','CRITICAL_OBSERVATIONS','REPLAYABLE_RAW')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  location text NOT NULL,
  geographic_location text NOT NULL,
  encryption_json jsonb NOT NULL,
  hash text NOT NULL CHECK (length(hash)=64),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  retention_policy_id text NOT NULL REFERENCES backup_retention_policies(id),
  version integer NOT NULL CHECK (version > 0),
  rights_constraints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS backup_records_tier_created_idx ON backup_records(tier, created_at);
CREATE INDEX IF NOT EXISTS backup_records_expires_idx ON backup_records(expires_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS backup_legal_holds (
  id text PRIMARY KEY,
  backup_record_id text NOT NULL REFERENCES backup_records(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  released_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX IF NOT EXISTS backup_legal_holds_record_idx ON backup_legal_holds(backup_record_id) WHERE active = true;

CREATE TABLE IF NOT EXISTS restore_drills (
  id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('CRITICAL_CONFIG','CRITICAL_OBSERVATIONS','REPLAYABLE_RAW')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  target_rpo_minutes integer NOT NULL,
  target_rto_minutes integer NOT NULL,
  achieved_rpo_minutes integer,
  achieved_rto_minutes integer,
  artifacts_verified boolean NOT NULL DEFAULT false,
  audit_chain_verified boolean NOT NULL DEFAULT false,
  migrations_replayed boolean NOT NULL DEFAULT false,
  cross_store_references_restored boolean NOT NULL DEFAULT false,
  collector_checkpoints_reestablished boolean NOT NULL DEFAULT false,
  hidden_gaps_detected integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('RUNNING','PASSED','FAILED')),
  evidence_json jsonb
);
CREATE INDEX IF NOT EXISTS restore_drills_tier_started_idx ON restore_drills(tier, started_at);

CREATE TABLE IF NOT EXISTS recovery_reconciliation_state (
  id text PRIMARY KEY,
  recovery_id text NOT NULL UNIQUE,
  provider_calls_reconciled boolean NOT NULL DEFAULT false,
  quota_reservations_reconciled boolean NOT NULL DEFAULT false,
  workflow_leases_reconciled boolean NOT NULL DEFAULT false,
  inbox_reconciled boolean NOT NULL DEFAULT false,
  outbox_reconciled boolean NOT NULL DEFAULT false,
  alerts_reconciled boolean NOT NULL DEFAULT false,
  collector_gaps_reconciled boolean NOT NULL DEFAULT false,
  artifacts_verified boolean NOT NULL DEFAULT false,
  audit_checkpoints_verified boolean NOT NULL DEFAULT false,
  fencing_tokens_validated boolean NOT NULL DEFAULT false,
  stale_tokens_rejected integer NOT NULL DEFAULT 0,
  resumed_at timestamptz,
  degraded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS degraded_mode_state (
  id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('CRITICAL_CONFIG','CRITICAL_OBSERVATIONS','REPLAYABLE_RAW')),
  reason text NOT NULL,
  degraded_at timestamptz NOT NULL,
  restored_at timestamptz,
  confirmed_opportunity_alerts_disabled boolean NOT NULL,
  capability_matrix_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS degraded_mode_active_idx ON degraded_mode_state(tier) WHERE active = true;

-- Versioned audit for backup/restore/retention actions with hash chain
CREATE TABLE IF NOT EXISTS backup_audit_log (
  id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN (
    'RETENTION_CREATED','RETENTION_UPDATED','BACKUP_CREATED','BACKUP_DELETED',
    'LEGAL_HOLD_CREATED','LEGAL_HOLD_RELEASED','RESTORE_REQUESTED','RESTORE_GRANTED',
    'RESTORE_DENIED','DRILL_STARTED','DRILL_COMPLETED','DEGRADED_ENTERED','DEGRADED_EXITED','RECONCILIATION_COMPLETED'
  )),
  actor text NOT NULL,
  payload_json jsonb NOT NULL,
  previous_hash text,
  record_hash text NOT NULL CHECK (length(record_hash)=64),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS backup_audit_log_recorded_idx ON backup_audit_log(recorded_at);

-- Collector checkpoints table (if not already exists via collector-core)
CREATE TABLE IF NOT EXISTS collector_checkpoints (
  partition text PRIMARY KEY,
  slot bigint NOT NULL,
  sequence bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO schema_migrations (version, applied_at) VALUES ('0005_durable_recovery_continuity', now()) ON CONFLICT (version) DO NOTHING;
