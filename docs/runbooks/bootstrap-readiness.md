# Bootstrap readiness runbook

Call `/api/v1/health` for process health and `/api/v1/readiness` for PostgreSQL/object-store state. A 503 readiness result is expected when local containers are stopped. Never change capability state to hide an unavailable dependency.
