You are an independent principal engineer, architecture auditor, codebase reviewer, and release gatekeeper.

A previous Codex agent created the initial runnable codebase and the PRD-driven agent implementation harness for the Crypto Intelligence Agent Gateway on:

```text
bootstrap/agent-harness-and-codebase
```

Your responsibilities are:

```text
1. Independently review the codebase and harness.
2. Freeze the initial findings before editing.
3. Fix all release-blocking defects.
4. Re-run complete verification from a clean state.
5. Merge the approved bootstrap branch into main.
6. Create and push the final harness baseline tag.
```

Do not trust previous reports or PASS claims.

# Authoritative files

Locate:

```text
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md) 
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.audit.json) 
[crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json](docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json) 
```

Also locate:

```text
the bootstrap prompt
artifacts/final/codebase-bootstrap-report.*
artifacts/final/harness-preparation-report.*
```

Authority order:

```text
PRD
→ normative manifest
→ accepted ADRs
→ bootstrap deliverable contract
→ executable repository behavior
→ generated reports
```

Generated reports are evidence, not authority.

# Git preparation

Fetch all branches and tags.

Record:

```text
main commit
bootstrap branch commit
bootstrap release-candidate tag
working tree state
remote URLs
Git user
available authentication
```

Create:

```text
review/harness-codebase-independent-audit
```

from the bootstrap branch.

Do not modify `main` until the final review passes.

# Review-only phase

Before editing any repository file, independently inspect and execute the system.

Create and content-hash:

```text
artifacts/reviews/codebase-harness-review.initial.json
artifacts/reviews/codebase-harness-review.initial.md
```

Only after these files are committed may you begin repairs.

# Part A — Review the actual codebase

Verify that this is a real runnable repository, not documentation or generated placeholders.

Review:

```text
pnpm workspace configuration
TypeScript strict configuration
API application
SvelteKit dashboard
package boundaries
configuration system
PostgreSQL integration
SQL migrations
Drizzle schema compatibility
object-store integration
local Docker stack
logging
tracing
health and readiness
test infrastructure
production builds
development commands
deployment skeleton
```

From a clean checkout verify:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Check that:

* API starts;
* dashboard builds;
* health endpoint works;
* readiness reports real dependency state;
* database migrations work from empty database;
* MinIO or local object storage works;
* environment validation fails safely;
* fake adapters do not masquerade as production capabilities;
* no real crypto provider is called;
* no production notification is sent;
* no placeholder implementation is reported as complete.

Flag unnecessary abstractions and premature product implementation.

# Part B — Review architecture

Verify PRD stack and modular-monolith rules.

Check:

```text
domain isolation
infrastructure isolation
provider adapter boundary
agent-runtime boundary
MCP-to-Tool-Core boundary
dashboard boundary
persistence authority
SQL migration authority
object-store abstraction
capability lifecycle separation
synthetic versus production capability labeling
```

Introduce controlled temporary architecture violations and verify deterministic detection.

Revert every controlled mutation.

# Part C — Review code quality

Inspect representative packages and entry points.

Look for:

* empty interfaces with no meaningful contract;
* fake successful defaults;
* ignored errors;
* unsafe `any`;
* swallowed promises;
* hard-coded environment behavior;
* unsafe subprocess construction;
* path traversal;
* symlink attacks;
* unstable generated files;
* circular imports;
* duplicate types;
* infrastructure leakage;
* weak error contracts;
* unbounded retries;
* nondeterministic tests;
* excessive framework-building without current need.

Confirm fake adapters explicitly report non-production capability state.

# Part D — Review database and migration foundation

Verify:

```text
empty database → latest
application starts after migration
migration ownership exists
SQL migrations are authoritative
Drizzle mirrors SQL
no destructive speculative schema
synthetic walking-skeleton schema is sufficient
migration failure is visible
partial migration does not produce false readiness
```

Do not approve speculative creation of the entire future production schema.

# Part E — Review API and dashboard

API review:

* Hono application is real;
* Zod contracts are enforced;
* errors are structured;
* request IDs propagate;
* logs are structured;
* readiness is real;
* MCP bootstrap endpoint is bounded;
* no unrestricted arbitrary URL retrieval exists;
* no prohibited financial path exists.

Dashboard review:

* production build succeeds;
* data comes through the API;
* dashboard does not import persistence/provider code;
* pages correctly label synthetic, unavailable and future capabilities;
* no investment recommendation is rendered;
* no direct external provider calls exist.

# Part F — Independently review specification integrity

Recalculate:

```text
requirement count
acceptance count
invariant count
ADR count
API routes
persistence entities
dependency groups
```

Detect:

* duplicate IDs;
* orphan IDs;
* missing mappings;
* PRD/manifest disagreements;
* unresolved placeholders;
* invalid references;
* invalid dependency direction;
* duplicate API method/path;
* duplicate persistence names.

Compare with generated artifacts and reports.

# Part G — Review compiler determinism

Delete generated compiler output and caches.

Run compilation twice from identical frozen inputs.

Verify identical output manifests and content hashes.

A semantic Codex step must use a frozen, versioned and content-addressed semantic artifact.

Flag live uncontrolled model calls during normal regeneration.

Verify the semantic stage cannot add, remove, renumber or modify normative IDs.

# Part H — Review task contracts

Independently calculate complete requirement and acceptance coverage.

Review a stratified sample including:

```text
repository task
schema task
migration task
provider task
point-in-time task
workflow task
security task
cost/quota task
execution-math task
evaluation task
MCP task
agent-runtime task
dashboard task
advanced-alpha task
```

Check:

* objective is finite;
* scope is coherent;
* dependencies are sufficient;
* paths are accurate;
* task is not trivial or enormous;
* tests arise from specification;
* degraded behavior exists;
* rollback exists;
* stop conditions exist;
* verification is executable;
* autonomy/risk classification is appropriate.

# Part I — Review cluster contracts and ZCode goals

Verify:

* every task is in exactly one cluster;
* DAG is acyclic;
* cluster boundaries are integration boundaries;
* failure injection is defined;
* integration invariants are executable;
* generated ZCode goals can run from one prompt;
* one task is verified and atomically merged before the next;
* no goal can merge to main;
* no goal can alter protected PRD semantics;
* no goal can activate alpha capability;
* repeated verification has bounded stop conditions.

# Part J — Review executable verifiers

Attempt controlled forgery and verify rejection:

```text
fake PASS task result
changed source after result generation
deleted acceptance test
weakened assertion
skipped test
wrong PRD hash
stale interface hash
forbidden path change
exclusive-lock conflict
lost lease
migration ownership conflict
prohibited capability
production placeholder
```

A verifier that trusts generated reports without checking the repository is a P0 defect.

# Part K — Review worktrees, leases and merge queue

Run a complete harmless synthetic task lifecycle:

```text
READY
→ LEASED
→ IMPLEMENTING
→ SELF_REVIEWING
→ VERIFYING
→ VERIFIED
→ MERGE_QUEUED
→ MERGED
```

Verify:

* isolated worktree;
* separate task branch;
* task lease;
* stale lease rejection;
* path-lock conflict;
* rebase;
* verification after rebase;
* atomic task commit;
* cluster merge;
* integration test;
* auto-revert after injected integration failure;
* cleanup.

Ensure no test accidentally modifies `main`.

# Part L — Review the walking skeleton

From clean PostgreSQL and object storage, execute:

```text
synthetic discovery
→ identity
→ point-in-time observation
→ feature
→ candidate
→ decision
→ frozen evidence
→ shadow outbox
→ outcome collection
→ maturity
→ evaluation
```

Confirm actual integration across packages.

Verify:

* durable database rows;
* actual artifact creation;
* evidence resolution;
* `available_at` historical replay;
* duplicate idempotency;
* outbox retry;
* virtual-time maturity;
* trace continuity;
* no live provider;
* no external notification;
* capability remains synthetic/shadow.

# Part M — Review deterministic simulation and golden data

Verify deterministic replay for:

* timeout and recovery;
* duplicate trigger;
* workflow crash/resume;
* lost lease;
* quota reset;
* schema drift;
* object-store failure;
* model unavailability;
* notification retry;
* late observation;
* outcome maturity.

Review shared golden scenarios for semantic consistency.

# Part N — Review CI

Verify CI runs real commands.

Check:

```text
build
lint
typecheck
unit tests
integration tests
system tests
task verifier
cluster verifier
architecture verification
migration verification
prohibited-capability scan
placeholder scan
walking skeleton
spec mutation
generated drift
```

Mark Git hosting controls such as branch protection as `REQUIRES_REPOSITORY_CONFIGURATION` when they cannot be inspected through available credentials.

# Part O — Review prohibited capabilities and security

Confirm no executable production path for:

```text
wallet custody
private key
seed phrase
mnemonic
transaction signing
transaction submission
swap execution
token approval
exchange order
```

Review shell execution, path validation, generated file paths, symlinks, artifact import and semantic compiler prompt-injection boundaries.

# Part P — Review premature implementation

The bootstrap may contain real infrastructure and synthetic code.

It must not claim implementation of:

* live discovery;
* real provider intelligence;
* opportunity ranking;
* wallet alpha;
* real alerts;
* production research agent;
* execution models;
* learned alpha.

Scaffolding is allowed only when it returns explicit unavailable or synthetic state.

# Initial findings

Before editing, generate findings using:

```text
P0 critical
P1 release-blocking
P2 important
P3 improvement
```

Initial verdict:

```text
PASS
CONDITIONAL_PASS
FAIL
UNVERIFIABLE
```

Any P0 or P1 means `FAIL`.

Commit the immutable initial report before repairs.

# Repair phase

Create:

```text
fix/harness-codebase-independent-review
```

Fix:

* every P0;
* every P1;
* every P2 affecting correctness, architecture, security, determinism, ZCode execution, Git safety, test integrity or maintainability.

For every fix:

1. preserve the original finding;
2. add a test or deterministic control;
3. implement the fix;
4. execute targeted verification;
5. update resolution status;
6. avoid unrelated refactoring.

Do not weaken PRD requirements or generated test semantics.

# Final verification

Use a clean checkout of the repaired branch.

Remove generated output and caches.

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

Also run:

* API startup and health/readiness smoke test;
* dashboard production build;
* empty-database migration;
* object-store smoke test;
* compiler double-generation;
* walking skeleton;
* spec mutations;
* synthetic task lifecycle;
* stale lease;
* lock conflict;
* post-merge failure and revert.

No missing command may be silently skipped.

# Final reports

Create:

```text
artifacts/reviews/codebase-harness-review.final.json
artifacts/reviews/codebase-harness-review.final.md
artifacts/reviews/codebase-harness-review.resolution.json
artifacts/reviews/codebase-harness-owner-checklist.md
```

Report:

```text
initial verdict
final verdict
source hashes
base and final commits
commands and exit codes
codebase build result
API result
dashboard result
Docker/local stack result
migration result
spec integrity
coverage
task count
cluster count
compiler determinism
walking skeleton
mutation tests
architecture
security
Git lifecycle
initial findings
fixed findings
remaining findings
unverified external controls
recommended first ZCode cluster
exact ZCode goal command
```

# Merge and release actions

Only when all conditions below hold:

```text
final verdict = PASS
no P0 findings
no P1 findings
complete clean verification passes
working tree is clean
main has not advanced incompatibly
remote authentication is available
```

perform these actions:

1. Fetch and rebase the repaired review branch on the latest `main`.
2. Re-run the complete final verification after rebase.
3. Merge using a non-fast-forward merge commit into `main`.
4. Push `main`.
5. Create the final annotated tag:

```text
harness-v1.0.0
```

6. The tag message must include:

```text
PRD hash
manifest hash
bootstrap commit
review commit
final main commit
harness verification result
task count
cluster count
```

7. Push the tag.
8. Delete or archive temporary review and fix branches according to repository policy.
9. Do not delete task/cluster artifacts or immutable review reports.
10. Produce the exact first ZCode cluster command.

Do not merge or tag when verification fails.

If remote permissions are unavailable:

* do not claim merge or push succeeded;
* leave the local repository on a verified release-ready branch;
* produce exact commands;
* record `BLOCKED_REMOTE_PERMISSION`.

# Final acceptance

The repository is ready only when:

1. It is a runnable codebase, not a documentation scaffold.
2. API and dashboard build.
3. Local infrastructure works.
4. Migrations work.
5. Compiler is deterministic.
6. Requirement and acceptance coverage are complete.
7. Task and cluster contracts validate.
8. ZCode goals are executable.
9. Verifiers reject forged completion.
10. Worktree, lease and merge queue behavior works.
11. Walking skeleton passes.
12. Architecture violations are rejected.
13. Prohibited capabilities are absent.
14. No P0 or P1 remains.
15. `main` contains the reviewed baseline.
16. `harness-v1.0.0` points to the verified baseline.
17. The first ZCode cluster goal is identified.

Do not stop after writing a review.

Review, freeze findings, repair, verify, merge, push, tag and leave the repository ready for ZCode.