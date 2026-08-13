# Architecture

CIAG is a TypeScript modular monolith. The API and dashboard are delivery adapters around shared domain, Tool Core, workflow, evidence, evaluation, capability, and persistence packages. Provider SDK types stop at provider adapters. PostgreSQL is authoritative for operational state; immutable evidence uses an object-store port; SQL migrations lead Drizzle mirrors. The dashboard uses API contracts only. The MCP adapter reaches domain operations only through Tool Core.

The bootstrap contains synthetic/shadow behavior only. Long-running collectors and Alpha Lab may later use separate processes only with an accepted ADR and unchanged domain contracts. Redis is intentionally absent.

Dependency direction is delivery → application/runtime → domain contracts. Domain has no infrastructure SDKs. Agent runtime cannot import provider implementations. Capability state is separate from engineering state and defaults to disabled or synthetic shadow.

## Product factory control plane

The coding factory is operational tooling, not part of the CIAG product runtime. Committed product authority flows through Spec Kit planning into the small deterministic controller in `factory/`; Agent Orchestrator owns Muse/Antigravity sessions, tmux, worktrees, and machine reviews; GitHub owns issues, PRs, checks, and integrated history. Only the controller may merge after exact-head CI, review, dependency, and protected-path gates. See `docs/operations/oss-factory.md` and ADR-FACTORY-002.
