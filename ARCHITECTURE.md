# Architecture

CIAG is a TypeScript modular monolith. The API and dashboard are delivery adapters around shared domain, Tool Core, workflow, evidence, evaluation, capability, and persistence packages. Provider SDK types stop at provider adapters. PostgreSQL is authoritative for operational state; immutable evidence uses an object-store port; SQL migrations lead Drizzle mirrors. The dashboard uses API contracts only. The MCP adapter reaches domain operations only through Tool Core.

The bootstrap contains synthetic/shadow behavior only. Long-running collectors and Alpha Lab may later use separate processes only with an accepted ADR and unchanged domain contracts. Redis is intentionally absent.

Dependency direction is delivery → application/runtime → domain contracts. Domain has no infrastructure SDKs. Agent runtime cannot import provider implementations. Capability state is separate from engineering state and defaults to disabled or synthetic shadow.
