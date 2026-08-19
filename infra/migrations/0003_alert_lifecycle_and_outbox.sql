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

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0003_alert_lifecycle_and_outbox', now())
ON CONFLICT (version) DO NOTHING;
