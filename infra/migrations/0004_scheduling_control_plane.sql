-- Scheduling Control Plane — FR-WF-004 / FR-WF-005 / FR-ADM-003
-- Schedules, immutable schedule_versions, incidents, resolved configs

CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','PAUSED','DEGRADED','DISABLED','DELETED')),
  current_version_id text,
  current_version_number integer,
  external_schedule_id text,
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id text PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES schedules(id),
  version integer NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  workflow_version text NOT NULL,
  agent_profile_version text NOT NULL,
  tool_profile_version text NOT NULL,
  model_profile_version text,
  prompt_version text,
  outcome_profile_id text,
  ranking_policy_id text,
  alert_policy_id text,
  budgets jsonb NOT NULL,
  concurrency integer NOT NULL CHECK (concurrency >= 1 AND concurrency <= 32),
  destination text NOT NULL,
  external_id text,
  target_scope jsonb NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('DRAFT','VALIDATED','APPROVED','ACTIVE','DEPRECATED','ROLLED_BACK')),
  config_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  UNIQUE (schedule_id, version)
);
CREATE INDEX IF NOT EXISTS schedule_versions_schedule_idx ON schedule_versions(schedule_id);

CREATE TABLE IF NOT EXISTS schedule_incidents (
  id text PRIMARY KEY,
  type text NOT NULL,
  schedule_id text,
  external_schedule_id text,
  detail text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved_run_configs (
  id text PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES schedules(id),
  schedule_version_id text NOT NULL REFERENCES schedule_versions(id),
  run_id text NOT NULL,
  resolved_json jsonb NOT NULL,
  config_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO schema_migrations (version, applied_at) VALUES ('0004_scheduling_control_plane', now()) ON CONFLICT (version) DO NOTHING;
