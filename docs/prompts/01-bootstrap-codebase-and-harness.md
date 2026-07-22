You are the principal software architect, repository bootstrap engineer, and agent-workflow engineer responsible for creating the initial production codebase and the complete PRD-driven implementation harness for the Crypto Intelligence Agent Gateway.

You are working on an actual repository, not writing a design proposal.

You must create a runnable, testable, production-oriented codebase and leave it ready for ZCode to implement the product cluster by cluster.

# Authoritative specification

Locate these files by exact filename:

```text
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md) 
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json) 
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json) 
```

They may be located under `/mnt/data`, the repository root, or another mounted path.

Copy immutable working copies into:

```text
docs/spec/
```

Calculate and record SHA-256 hashes.

The PRD and normative requirement manifest are authoritative. Do not weaken, omit, renumber, reinterpret, or silently replace requirements, acceptance criteria, invariants, dependency groups, technology choices, or prohibited capabilities.

# Overall responsibility

Complete both responsibilities:

```text
A. Build the initial runnable application codebase.
B. Build the engineering harness that allows ZCode to implement the full PRD.
```

The expected workflow after your work is:

```text
PRD and manifest
→ runnable modular-monolith codebase
→ deterministic PRD compiler
→ task-contract DAG
→ cluster contracts
→ generated ZCode cluster goals
→ ZCode implementation
→ deterministic verification
→ Codex cluster review
→ staged and shadow rollout
```

# Important scope boundary

You MUST create the complete technical foundation and product skeleton.

You MUST NOT fully implement the real crypto-intelligence product features in this bootstrap phase.

Allowed implementation:

* actual repository structure;
* real build configuration;
* real API and dashboard shells;
* real database and migration foundation;
* real object-store, workflow, scheduler and provider interfaces;
* real configuration and validation;
* real test infrastructure;
* real synthetic walking skeleton;
* fake and deterministic adapters;
* health/readiness endpoints;
* development and deployment scaffolding;
* agent harness;
* task compiler;
* verifier;
* CI;
* architecture enforcement.

Not allowed in this phase:

* live token discovery;
* live crypto-provider integration beyond contract scaffolding and sanitized fixtures;
* real opportunity ranking;
* real wallet-alpha intelligence;
* real production alerting;
* real alpha models;
* real execution simulation beyond interfaces and synthetic examples;
* automatic product capability activation;
* trading, signing, custody, swapping, transferring, approving, bridging, staking, order placement, or transaction submission.

# Mandatory technology baseline

Follow the PRD defaults unless the specification explicitly supersedes them:

```text
Language: TypeScript strict mode
Runtime: Node.js 22
Repository: pnpm workspace
Architecture: modular monolith
API: Hono with Zod and OpenAPI contracts
Dashboard: Svelte 5 and SvelteKit
MCP: official TypeScript MCP SDK, Streamable HTTP
Operational database: PostgreSQL
ORM/query layer: SQL migrations are authoritative; Drizzle typed queries
Object storage: S3-compatible adapter
Local object storage: MinIO or filesystem development adapter
Testing: Vitest, Playwright, fast-check
Observability: structured JSON logs and OpenTelemetry-compatible traces
```

Do not introduce microservices.

Do not introduce Redis unless the PRD requires it or an accepted ADR proves it necessary.

# Git workflow

Inspect the repository before making changes.

If Git is not initialized, initialize it.

Identify the current stable base branch. Prefer `main`.

Create and work on:

```text
bootstrap/agent-harness-and-codebase
```

Do not directly modify `main` during bootstrap implementation.

Use meaningful atomic commits for major preparation phases, such as:

```text
chore(repo): initialize pnpm modular-monolith workspace
feat(skeleton): add runnable API dashboard and local infrastructure
feat(harness): add PRD compiler and executable contracts
test(harness): add walking skeleton and mutation verification
ci: add task cluster and repository verification workflows
docs: add agent implementation governance
```

Push the branch when a Git remote and credentials are available.

Create or update a pull request when the repository supports it.

Do not merge this bootstrap branch into `main` yourself unless the independent-review workflow has already completed and produced a final `PASS`.

The independent reviewer is responsible for final merge and release tag.

# Phase 1 — Create the actual repository codebase

If the repository is empty or incomplete, create the complete baseline structure.

At minimum:

```text
apps/
  api/
  dashboard/

packages/
  domain/
  shared-schemas/
  config/
  persistence/
  object-store/
  runtime-cache/
  observability/
  security/
  capability-registry/
  tool-core/
  workflow-runtime/
  scheduler/
  provider-contracts/
  evidence/
  agent-runtime/
  mcp-adapter/
  alerts/
  evaluation/
  test-fixtures/

infra/
  migrations/
  docker/
  deployment/

tools/
  prd-compiler/
  task-runner/
  task-verifier/
  cluster-verifier/
  worktree-manager/
  merge-queue/
  architecture-verifier/
  spec-mutation/

tests/
  unit/
  integration/
  system/
  architecture/
  harness/
  spec-mutation/

test-data/
  golden-v1/

docs/
  spec/
  adr/
  runbooks/
  implementation/
  provider-rights/
  schemas/

tasks/
clusters/
artifacts/
```

Create real workspace configuration:

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
eslint or equivalent lint configuration
format configuration
Vitest configuration
Playwright configuration
Docker Compose
.env.example
.gitignore
.npmrc where justified
```

Create repository scripts that actually execute:

```text
pnpm install
pnpm build
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:system
pnpm architecture:verify
pnpm harness:verify
```

A clean checkout must be able to install, build and test without undocumented manual file edits.

# Phase 2 — Create a runnable API application

Create `apps/api` as a real Hono application.

It must include:

```text
GET /api/v1/health
GET /api/v1/readiness
POST /mcp
```

Bootstrap behavior must include:

* typed request and response contracts;
* Zod validation;
* structured errors;
* correlation IDs;
* structured JSON logging;
* configuration validation;
* graceful shutdown;
* dependency readiness reporting;
* fake development adapters;
* no live crypto calls;
* no financial execution capabilities.

The API must build and start.

Health must distinguish process health from dependency readiness.

# Phase 3 — Create a runnable dashboard

Create `apps/dashboard` as a real SvelteKit application.

Include basic read-only pages for:

```text
Overview
System readiness
Harness status
Requirement coverage
Task graph
Cluster graph
Walking-skeleton result
```

The dashboard may consume synthetic or local API data.

It must not:

* call crypto providers directly;
* access PostgreSQL directly;
* claim product capabilities are active;
* contain fake investment recommendations.

The dashboard must build successfully for production.

# Phase 4 — Create local infrastructure

Create a working Docker Compose development stack for at least:

```text
PostgreSQL
MinIO or an equivalent local S3-compatible store
```

Provide:

```text
infra/docker/
docker-compose.yml
.env.example
development startup instructions
```

Create real database connectivity, object-store interfaces and local adapters.

Create initial SQL migrations for only the bootstrap foundation required by:

* specification metadata;
* harness state;
* task state;
* cluster state;
* synthetic walking skeleton;
* evidence/artifact metadata;
* outbox;
* audit records.

Do not prematurely create hundreds of speculative production tables merely because they appear in the PRD. Their migrations belong to generated task contracts.

SQL migrations are authoritative.

Drizzle schemas must mirror them.

Test:

```text
empty database → latest
migration rerun safety where applicable
application startup after migration
```

# Phase 5 — Create package boundaries and public interfaces

Create the PRD-required portability interfaces as compilable TypeScript contracts.

At minimum:

```ts
interface DatabaseAdapter {}
interface ObjectStoreAdapter {}
interface RuntimeCacheAdapter {}
interface SchedulerAdapter {}
interface DurableWorkflowAdapter {}
interface ModelProviderAdapter {}
interface NotificationAdapter {}
interface SecretStoreAdapter {}
interface CostPolicyAdapter {}
interface DiscoveryUniverseAdapter {}
interface ExecutionSimulatorAdapter {}
interface ChainSecurityAnalyzerAdapter {}
interface AlphaArtifactStoreAdapter {}
interface OfflineAlphaLabAdapter {}
```

Interfaces must have meaningful minimal method contracts where the PRD defines enough semantics.

Do not create empty interfaces solely to satisfy file existence.

Where product semantics are not yet implementable, create:

* strongly typed ports;
* explicit capability state;
* fake deterministic adapter;
* `NOT_AVAILABLE` or `INSUFFICIENT_DATA` behavior;
* future task ownership.

Do not return fabricated successful results.

# Phase 6 — Governance and architecture documentation

Create:

```text
AGENTS.md
ARCHITECTURE.md
INVARIANTS.md
CONTRIBUTING.md
SECURITY.md

docs/implementation-workflow.md
docs/task-contract-guide.md
docs/cluster-contract-guide.md
docs/zcode-execution-guide.md
docs/codex-cluster-review-guide.md
docs/migration-workflow.md
docs/release-and-capability-workflow.md
docs/local-development.md
docs/deployment-baseline.md
```

`AGENTS.md` must be operational and repository-specific.

It must define:

* authority hierarchy;
* source hash validation;
* allowed agent actions;
* forbidden capabilities;
* dependency order;
* scope enforcement;
* task self-review;
* blocked and amendment behavior;
* migration ownership;
* verification commands;
* stop conditions;
* engineering versus capability states;
* no automatic alpha activation.

# Phase 7 — Specification integrity extraction

Independently parse the PRD, requirement manifest and audit.

Generate:

```text
artifacts/spec/
  prd-metadata.json
  requirement-index.json
  acceptance-index.json
  invariant-index.json
  adr-index.json
  package-index.json
  api-index.json
  persistence-index.json
  capability-index.json
  dependency-group-index.json
  specification-integrity-report.json
```

Detect:

* duplicate IDs;
* missing IDs;
* orphan requirements;
* orphan acceptance criteria;
* contradictory dependency groups;
* unresolved placeholders;
* duplicate API method/path pairs;
* duplicate persistence entities;
* missing package ownership;
* invalid references;
* missing activation gates;
* PRD/manifest discrepancies.

Do not trust the supplied audit without independently validating it.

# Phase 8 — Task and cluster contract schemas

Create real JSON Schemas and Zod representations for:

```text
task-contract
task-result
task-review
task-amendment
task-lease
cluster-contract
cluster-result
cluster-review
architectural-diff
context-manifest
ready-queue
```

Every task contract must include:

```text
source hashes
dependency group
cluster
risk level
autonomy level
dependencies
requirements
acceptance criteria
invariants
ADRs
owner packages
read set
write set
allowed paths
forbidden paths
exclusive locks
interface hashes
deliverables
constraints
non-goals
degraded behavior
rollback
required tests
verification commands
complexity budget
change budget
stop conditions
completion definition
```

# Phase 9 — Hybrid PRD compiler

Implement the actual compiler under:

```text
tools/prd-compiler/
```

Deterministic code owns:

* source hashes;
* authoritative ID preservation;
* dependency graph;
* cycle detection;
* requirement coverage;
* acceptance coverage;
* task and cluster uniqueness;
* context manifests;
* task validation;
* risk and budget validation;
* interface hashes;
* ready queues;
* source references;
* output manifests.

A semantic Codex pass may be used only for:

* coherent requirement grouping;
* task boundary suggestions;
* cluster boundary suggestions;
* integration risks;
* negative-test suggestions;
* pre-mortems.

Semantic results must be:

* schema-validated;
* frozen;
* versioned;
* content-addressed;
* reviewable;
* unable to add, remove or renumber normative IDs.

The final task and cluster output must be deterministically reproducible from the frozen semantic compilation artifact.

Generate:

```text
tasks/G0-G7/
clusters/G0-G7/

tasks/generated/
  graph.json
  graph.mmd
  cluster-graph.json
  cluster-graph.mmd
  coverage.json
  ready-queue.json
  path-locks.json
  interface-hashes.json
  requirement-task-map.json
  acceptance-task-map.json
  risk-map.json
  architectural-baseline.json
```

Fail compilation when coverage is incomplete, graph cycles exist, IDs are invalid, or contracts exceed budgets without an explicit split recommendation.

# Phase 10 — Context packs and generated goals

Generate compact context packs:

```text
artifacts/context/<task-id>/
```

Each pack must include:

```text
task contract
referenced requirements
acceptance criteria
invariants
architecture boundaries
relevant ADRs
dependency outputs
public schemas
semantic-field definitions
pre-mortem
context manifest
source references and hashes
```

Generate:

```text
clusters/<group>/<cluster-id>.zcode-goal.md
clusters/<group>/<cluster-id>.codex-review.md
clusters/<group>/<cluster-id>.zcode-fix-goal.md
```

A ZCode cluster goal must support one prompt for multiple small tasks while preserving one-task-at-a-time verification and atomic commits.

# Phase 11 — Executable contracts and verifiers

Implement actual commands:

```text
pnpm spec:verify
pnpm prd:compile
pnpm prd:drift-check

pnpm task:list
pnpm task:ready
pnpm task:acquire <task-id>
pnpm task:renew <task-id>
pnpm task:verify <task-id>
pnpm task:complete <task-id>
pnpm task:release <task-id>

pnpm cluster:list
pnpm cluster:ready
pnpm cluster:verify <cluster-id>
pnpm cluster:report <cluster-id>

pnpm requirements:coverage
pnpm architecture:verify
pnpm tests:skeleton-integrity
pnpm placeholders:scan
pnpm prohibited-capabilities:scan
pnpm migration:verify
pnpm harness:verify
```

The task verifier must derive results from code and tests.

It must not trust a task-result JSON file merely because the file says `PASS`.

Test controlled completion forgery and verify rejection.

# Phase 12 — Git worktrees, leases, path locks and merge queue

Implement real automation for:

```text
pnpm worktree:create <task-id>
pnpm worktree:status
pnpm worktree:cleanup <task-id>
pnpm merge-queue:add <task-id>
pnpm merge-queue:process
```

Support:

* isolated task worktrees;
* task leases;
* monotonically increasing lease version;
* stale-agent rejection;
* read/write sets;
* exclusive path locks;
* task branches;
* cluster branches;
* rebase before merge;
* verification after rebase;
* one atomic commit per task;
* post-merge integration test;
* automatic task-commit revert after post-merge failure;
* no task-agent merge directly to `main`.

Use safe subprocess invocation. Do not construct unsafe shell commands from untrusted task content.

# Phase 13 — Architecture fitness functions

Enforce with executable tests and lint rules:

```text
domain cannot import infrastructure SDKs
agent-runtime cannot import provider implementations
MCP adapter must use Tool Core
dashboard cannot access providers or persistence directly
Alpha Lab cannot access production write credentials
execution simulator cannot import transaction-signing code
provider adapters cannot import UI
discovery cannot call paid operations in STRICT_FREE
model output cannot directly trigger external notification
```

# Phase 14 — Anti-placeholder and prohibited-capability enforcement

Create scanners for production placeholders and fake completion.

Classify or reject:

```text
TODO
FIXME
HACK
TEMP
NOT_IMPLEMENTED
empty catch
hard-coded PASS
trivial assertions
skipped tests
ts-ignore
eslint-disable
hard-coded provider responses
production test switches
```

Create semantic prohibited-capability checks for executable production paths involving:

```text
private keys
seed phrases
mnemonics
wallet custody
transaction signing
transaction submission
swap execution
token approvals
exchange order placement
```

Documentation and tests may mention them, but executable production paths must be absent.

# Phase 15 — Deterministic test environment

Create real reusable primitives:

```text
VirtualClock
DeterministicRandom
DeterministicIdGenerator
FakeProviderNetwork
FakeScheduler
FakeNotificationTransport
FakeObjectStore
FakeWorkflowRuntime
FakeQuotaClock
FailureInjector
ReplayManifest
```

Support deterministic reproduction of:

* provider timeout;
* duplicate trigger;
* workflow crash and resume;
* lease loss;
* quota exhaustion;
* schema drift;
* object-store failure;
* model unavailability;
* notification retry;
* late observation;
* alert expiry;
* outcome maturity.

# Phase 16 — Synthetic walking skeleton

Implement a real synthetic vertical slice:

```text
fake discovery source
→ canonical synthetic asset
→ point-in-time observation
→ deterministic synthetic feature
→ candidate
→ deterministic decision
→ frozen evidence artifact
→ transactional shadow outbox
→ synthetic outcome collection
→ outcome maturity
→ evaluation record
```

The walking skeleton must integrate real repository packages and real local persistence.

It must not be only mocked function calls.

Create:

```text
tests/system/walking-skeleton.spec.ts
```

Verify:

* database state;
* object artifact;
* evidence references;
* `available_at` replay;
* duplicate idempotency;
* outbox retry;
* virtual-time outcome maturity;
* traces;
* capability remains synthetic/shadow.

# Phase 17 — Golden synthetic dataset

Create:

```text
test-data/golden-v1/
```

Include coherent synthetic cases for:

* normal asset;
* rug;
* honeypot;
* liquidity spoof;
* bundled wallets;
* shared funder;
* migration;
* multi-hop route;
* partial fill;
* transfer fee;
* missing provider;
* provider conflict;
* late observation;
* untradable winner;
* tradable winner;
* duplicate trigger;
* stale lease;
* schema drift;
* quota exhaustion.

This is shared test semantics, not production intelligence.

# Phase 18 — CI workflows

Create real CI under:

```text
.github/workflows/
```

Implement:

```text
Tier 0: changed-file lint, affected typecheck and unit tests
Tier 1: task verification
Tier 2: cluster integration
Tier 3: complete pre-main verification
Tier 4: scheduled mutation, replay and extended tests
```

CI must verify:

* source hashes;
* generated drift;
* task contracts;
* task verifier;
* cluster verifier;
* architecture;
* prohibited capabilities;
* migration upgrades;
* walking skeleton;
* spec mutations;
* no skipped tests.

Do not call model reviewers while deterministic CI is failing.

# Phase 19 — Spec mutation tests

Create executable tests that intentionally violate critical invariants.

At minimum:

```text
remove available_at
backdate available_at
allow stale worker commit
charge quota on cache hit
allow paid fallback in STRICT_FREE
allow model direct notification
treat SIGNAL_SUCCESS as TRADABLE_SUCCESS
accept provider schema drift silently
auto-activate alpha artifact
allow dashboard provider import
```

Each mutation must be rejected by a specific deterministic control.

# Phase 20 — Self-review and verification

Before declaring completion:

1. Review the entire branch as an adversarial maintainer.
2. Detect documentation-only or placeholder implementations.
3. Delete generated outputs and caches.
4. Run the compiler twice.
5. Verify identical generated hashes.
6. Run the full build.
7. Run all bootstrap tests.
8. Run the walking skeleton.
9. Run the mutation suite.
10. Simulate task READY through MERGED.
11. Simulate stale lease.
12. Simulate path-lock conflict.
13. Simulate post-merge integration failure and automatic revert.
14. Verify Git status is clean after regeneration.
15. Fix all P0/P1 preparation defects.
16. Repeat until no known release-blocking defect remains.

Run at minimum:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm spec:verify
pnpm prd:compile
pnpm prd:drift-check
pnpm requirements:coverage
pnpm architecture:verify
pnpm tests:skeleton-integrity
pnpm placeholders:scan
pnpm prohibited-capabilities:scan
pnpm migration:verify
pnpm harness:verify
```

# Final artifacts

Create:

```text
artifacts/final/codebase-bootstrap-report.md
artifacts/final/codebase-bootstrap-report.json
artifacts/final/harness-preparation-report.md
artifacts/final/harness-preparation-report.json
```

The report must include:

```text
repository branch
base commit
head commit
source hashes
Node and pnpm versions
workspace packages
API build result
dashboard build result
Docker/local infrastructure result
migration result
requirement count
acceptance count
task-contract count
cluster count
coverage
compiler determinism
walking-skeleton result
mutation result
architecture result
security result
Git lifecycle simulation result
unresolved findings
recommended first ZCode cluster
exact first ZCode command
```

# Final Git actions

After all verification passes:

1. Ensure every bootstrap change is committed.
2. Push `bootstrap/agent-harness-and-codebase` when a remote is available.
3. Create or update its pull request when supported.
4. Create a release-candidate tag on the bootstrap branch:

```text
harness-v1.0.0-rc1
```

5. Push the release-candidate tag when permitted.
6. Do not create the final `harness-v1.0.0` tag.
7. Do not merge into `main` before the independent reviewer produces `PASS`.

If Git remote access or permissions are unavailable, record the exact blocked operation and exact commands required. Do not falsely claim that push, pull request creation, merge, or tag publication occurred.

Do not finish with a plan or summary alone.

Create the runnable codebase, implement the complete harness, execute verification, commit the results, and leave the bootstrap branch ready for independent review.