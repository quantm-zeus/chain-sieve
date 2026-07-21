# ADR-BOOTSTRAP-001: deterministic embedded PostgreSQL emulator for default tests

Status: Accepted for bootstrap tests only.

Production and local integration use PostgreSQL. The default hermetic suite executes the authoritative SQL against `pg-mem` so a clean checkout can verify without a running container. CI also runs a PostgreSQL service migration job. The emulator is not a production database and cannot authorize PostgreSQL-specific behavior without the service-backed check.
