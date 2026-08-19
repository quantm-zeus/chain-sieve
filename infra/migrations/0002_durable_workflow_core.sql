CREATE TABLE IF NOT EXISTS trigger_inbox (
  id text PRIMARY KEY,
  source text NOT NULL,
  external_message_id text NOT NULL UNIQUE,
  schedule_id text,
  scheduled_for timestamptz,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  verified_at timestamptz,
  processed_run_id text,
  status text NOT NULL CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','DUPLICATE','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_inbox_external_idx ON trigger_inbox(external_message_id);
CREATE INDEX IF NOT EXISTS trigger_inbox_schedule_idx ON trigger_inbox(schedule_id, scheduled_for);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY,
  workflow_name text NOT NULL,
  schedule_id text,
  trigger_inbox_id text REFERENCES trigger_inbox(id),
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','WAITING','RETRYING','COMPLETED','PARTIAL','FAILED','CANCELLED','TIMED_OUT','DEAD_LETTERED')),
  lease_owner text,
  lease_version bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_class text,
  retryable boolean
);

CREATE INDEX IF NOT EXISTS workflow_runs_schedule_status_idx ON workflow_runs(schedule_id, status);

CREATE TABLE IF NOT EXISTS workflow_steps (
  step_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  attempt integer NOT NULL DEFAULT 0,
  input_hash text NOT NULL,
  output_hash text,
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','DEAD_LETTERED','SKIPPED')),
  lease_owner text,
  lease_version bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_class text,
  retryable boolean NOT NULL DEFAULT false,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_steps_run_idx ON workflow_steps(run_id, step_type);
CREATE INDEX IF NOT EXISTS workflow_steps_idempotency_idx ON workflow_steps(idempotency_key);

CREATE TABLE IF NOT EXISTS step_attempts (
  id text PRIMARY KEY,
  step_id text NOT NULL REFERENCES workflow_steps(step_id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_class text,
  error_message text,
  retryable boolean,
  output_hash text
);

CREATE TABLE IF NOT EXISTS workflow_leases (
  lease_key text PRIMARY KEY,
  owner text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  run_id text REFERENCES workflow_runs(id)
);

CREATE TABLE IF NOT EXISTS dead_letter_items (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id text REFERENCES workflow_steps(step_id) ON DELETE SET NULL,
  error_class text NOT NULL,
  retryable boolean NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  payload_json jsonb,
  error_message text,
  status text NOT NULL CHECK (status IN ('OPEN','RETRYING','RESOLVED','CANCELLED')) DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_retry_at timestamptz
);

CREATE INDEX IF NOT EXISTS dead_letter_run_idx ON dead_letter_items(run_id);
CREATE INDEX IF NOT EXISTS dead_letter_status_idx ON dead_letter_items(status);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0002_durable_workflow_core', now())
ON CONFLICT (version) DO NOTHING;
