# Deployment baseline

Deploy the API and SvelteKit dashboard from the same immutable revision. Supply PostgreSQL and S3-compatible object storage through least-privilege references. Apply SQL migrations before readiness traffic. Health reports process liveness; readiness reports dependencies separately. The baseline ships `SYNTHETIC_SHADOW`, denies product activation, emits structured JSON logs, and supports OpenTelemetry-compatible trace spans.
