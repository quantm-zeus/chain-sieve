# ChainSieve product map

Authority is `docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md` plus its normative manifest, acceptance,
invariant, API, persistence, and dependency-group indexes. Existing code is a bootstrap modular monolith, not proof that
the product is complete.

| Product area | Authoritative intent | Current reusable surface | Direction |
| --- | --- | --- | --- |
| Domain truth | Canonical identities, independent states, point-in-time availability, immutable revisions | `packages/domain`, `packages/shared-schemas` | Preserve boundaries; fill semantics from PRD |
| Observation | Bounded Solana collector, registry, checkpoints, gaps, reorg/revision evidence | `apps/collector`, `packages/collector-*`, `packages/program-decoders` | Extend and prove; never imply unsupported coverage |
| Tool Core | Authorization-to-audit pipeline, exact cache/single-flight/quota | `packages/tool-core`, provider contracts, runtime cache | Complete deterministic contracts before provider breadth |
| Workflow | Durable idempotent automation and bounded scheduling | `packages/workflow-runtime`, `packages/scheduler` | Product workflow semantics remain; legacy software-factory lifecycle is unrelated and removable |
| Agent/evidence | Bounded model use, abstention, evidence validation and lineage | `packages/agent-runtime`, `packages/evidence`, `packages/evaluation` | Build after deterministic truth/tool layers |
| Delivery | API, MCP, admin dashboard, alerts | `apps/api`, `apps/dashboard`, `packages/mcp-adapter`, `packages/alerts` | Keep delivery dependent on domain/application ports |
| Persistence | PostgreSQL authority and immutable object evidence | `packages/persistence`, migrations, object store | SQL remains authoritative |
| Security | Permanent financial read-only boundary, fail-closed MCP/provider behavior | `packages/security`, negative scans/tests | Preserve and deepen; never weaken for automation |

The factory replacement is orthogonal to product runtime. Agent Orchestrator owns generic coding sessions, worktrees,
activity, PR/CI feedback, and machine reviewers. Spec Kit owns planning/convergence artifacts. ChainSieve owns only the
deterministic policy joining those systems.
