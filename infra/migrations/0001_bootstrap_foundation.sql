CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS specification_metadata (
  id text PRIMARY KEY,
  version text NOT NULL,
  prd_sha256 text NOT NULL CHECK (length(prd_sha256) = 64),
  manifest_sha256 text NOT NULL CHECK (length(manifest_sha256) = 64),
  audit_sha256 text NOT NULL CHECK (length(audit_sha256) = 64),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_state (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS task_state (
  task_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('PLANNED','READY','LEASED','IMPLEMENTING','SELF_REVIEWING','VERIFYING','VERIFIED','MERGE_QUEUED','MERGED','BLOCKED')),
  lease_version bigint NOT NULL DEFAULT 0,
  lease_holder text,
  lease_expires_at timestamptz,
  commit_sha text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cluster_state (
  cluster_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('PLANNED','READY','IN_PROGRESS','VERIFIED','REVIEWED','MERGED','BLOCKED')),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS synthetic_observations (
  id text PRIMARY KEY,
  asset_id text NOT NULL,
  stage text NOT NULL,
  payload_json jsonb NOT NULL,
  event_time timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  capability_mode text NOT NULL CHECK (capability_mode = 'SYNTHETIC_SHADOW'),
  trace_id text NOT NULL,
  CHECK (available_at >= event_time)
);

CREATE INDEX IF NOT EXISTS synthetic_observations_asset_available_idx ON synthetic_observations(asset_id, available_at);

CREATE TABLE IF NOT EXISTS artifact_metadata (
  artifact_key text PRIMARY KEY,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  media_type text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  created_at timestamptz NOT NULL,
  frozen boolean NOT NULL DEFAULT true,
  trace_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  topic text NOT NULL,
  payload_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','DELIVERED','RETRY','EXPIRED','CANCELLED','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  delivered_at timestamptz,
  trace_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id text PRIMARY KEY,
  asset_id text NOT NULL,
  alert_class text NOT NULL CHECK (alert_class IN ('EARLY_WATCH','CONFIRMED_OPPORTUNITY','THESIS_STRENGTHENING','THESIS_WEAKENING','OPPORTUNITY_EXPIRED','RISK_ALERT')),
  actionability_state text NOT NULL CHECK (actionability_state IN ('ACTIONABLE','DETERIORATED','EXPIRED','CANCELLED','WATCH_ONLY')),
  fingerprint text NOT NULL,
  valid_until timestamptz NOT NULL,
  payload_json jsonb NOT NULL,
  canonical_json text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  bytes integer NOT NULL CHECK (bytes >= 0),
  created_at timestamptz NOT NULL,
  shadow_mode boolean NOT NULL DEFAULT false,
  trace_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS alerts_asset_class_idx ON alerts(asset_id, alert_class);
CREATE INDEX IF NOT EXISTS alerts_fingerprint_idx ON alerts(fingerprint);

CREATE TABLE IF NOT EXISTS evaluation_records (
  id text PRIMARY KEY,
  asset_id text NOT NULL,
  outcome_state text NOT NULL CHECK (outcome_state IN ('PENDING','MATURE','CENSORED')),
  signal_success boolean,
  tradable_success boolean,
  evaluated_at timestamptz NOT NULL,
  evidence_key text NOT NULL REFERENCES artifact_metadata(artifact_key),
  trace_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_records (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  actor text NOT NULL,
  payload_json jsonb NOT NULL,
  previous_hash text,
  record_hash text NOT NULL,
  recorded_at timestamptz NOT NULL
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0001_bootstrap_foundation', now())
ON CONFLICT (version) DO NOTHING;
