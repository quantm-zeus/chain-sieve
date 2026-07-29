You are the final independent clean-room release attestation agent for the ChainSieve engineering harness.

The repair pull request has already been merged into `main`.

Your task is to independently verify the exact merged commit:

```text
f61b51a3c8e8772851b1619c0209299e35e870d8
```

Do not trust any previous bootstrap report, repair report, CI result, local working tree, branch state, PASS claim, generated evidence, or cached dependency.

Your objective is to determine whether this exact commit is safe to publish as:

```text
harness-v1.0.1
```

# Final allowed verdicts

Use exactly one:

```text
PASS_ATTESTED
PASS_WITH_EXTERNAL_CONTROLS_PENDING
FAIL_RELEASE
UNVERIFIABLE
```

Do not use a softer or ambiguous verdict.

# Strict operating rules

Start from a fresh remote clone.

Operate in read-only review mode until the initial attestation report has been frozen.

Do not:

* repair source code;
* modify `main`;
* amend or rewrite commits;
* force-push;
* move, delete or recreate `harness-v1.0.0`;
* start any ZCode product implementation;
* implement crypto product functionality;
* weaken tests or CI gates;
* create `harness-v1.0.1` before every required check passes;
* trust JSON fields that merely declare `PASS`;
* rely on verification performed against an earlier commit.

The exact object being verified is:

```text
f61b51a3c8e8772851b1619c0209299e35e870d8
```

Every attestation result must bind to this exact commit and its Git tree.

# Expected repository

```text
git@github.com:quantm-zeus/chain-sieve.git
```

Expected default branch:

```text
main
```

Expected merged commit:

```text
f61b51a3c8e8772851b1619c0209299e35e870d8
```

Expected new release tag after successful attestation:

```text
harness-v1.0.1
```

Existing immutable failed release:

```text
harness-v1.0.0
```

The existing `harness-v1.0.0` tag must remain unchanged.

# Phase 1 — Fresh clone and exact commit verification

Create a new temporary directory outside every previous ChainSieve workspace.

Run:

```sh
ATTEST_ROOT="$(mktemp -d /tmp/chainsieve-v101-final-attest.XXXXXX)"

git clone --no-local \
  git@github.com:quantm-zeus/chain-sieve.git \
  "$ATTEST_ROOT/repo"

cd "$ATTEST_ROOT/repo"

git fetch --all --tags --prune
```

Resolve and record:

```text
remote URL
remote default branch
origin/main full SHA
target commit full SHA
target tree full SHA
harness-v1.0.0 tag object SHA
harness-v1.0.0 peeled target SHA
```

Require:

```text
origin/main = f61b51a3c8e8772851b1619c0209299e35e870d8
```

Checkout detached:

```sh
git checkout --detach \
  f61b51a3c8e8772851b1619c0209299e35e870d8

test "$(git rev-parse HEAD)" = \
  "f61b51a3c8e8772851b1619c0209299e35e870d8"

test -z "$(git status --porcelain)"
```

Fail release when:

* `origin/main` does not point to the target commit;
* the target commit is missing;
* checkout is not clean;
* the target commit is not reachable from `origin/main`;
* the repository remote differs unexpectedly;
* `harness-v1.0.0` was moved or rewritten.

Record actual full SHAs, not Git expressions such as `HEAD^{}` or `refs/tags/...^{}`.

# Phase 2 — Verify authoritative specification

Locate the repository’s authoritative PRD, requirement manifest and audit evidence.

Expected SHA-256:

```text
PRD:
baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299

Requirement manifest:
e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff

Audit evidence:
ab4be13b6aeac998f13daa89ae08f4b9f5d6280b4018bd171b7b128b412a47f8
```

Recalculate all three hashes.

Fail release if any hash differs.

Confirm that immutable PRD inputs were not reformatted or semantically modified by the repair.

# Phase 3 — Verify repair provenance

Locate:

```text
artifacts/release-repair/harness-v1.0.1-repair-report.json
artifacts/release-repair/harness-v1.0.1-repair-report.md
artifacts/release-repair/harness-v1.0.1-resolution.json
```

Also locate the original failed-release attestation evidence for `harness-v1.0.0`.

Verify that the repair evidence accounts for:

```text
ATTEST-P0-001
ATTEST-P0-002
ATTEST-P1-003
ATTEST-P1-004
ATTEST-P1-005
ATTEST-P1-006
ATTEST-P2-007
ATTEST-P2-008
ATTEST-P2-009
ATTEST-P2-010
ATTEST-P2-011
```

Require explicit resolutions for every P0 and P1.

Do not accept a finding as resolved solely because a report says so. Independently verify the implementation and regression test.

Verify prompt provenance files:

```text
docs/prompts/01-bootstrap-codebase-and-harness.md
docs/prompts/02-independent-codebase-review.md
docs/prompts/prompt-manifest.json
```

Recalculate prompt hashes and compare them with the manifest.

Do not reconstruct missing prompts.

When exact prompt provenance is still incomplete, record:

```text
BLOCKED_PROMPT_ARCHIVAL
```

Prompt provenance alone is not necessarily a code-release blocker, but the final report must state it accurately.

# Phase 4 — Freeze initial attestation

Before changing anything, create outside the target Git tree:

```text
harness-v1.0.1.initial.json
harness-v1.0.1.initial.md
```

Include:

```text
attestation ID
timestamp
remote URL
default branch
origin/main SHA
target commit SHA
target tree SHA
existing tag details
specification hashes
prompt hashes
environment versions
initial findings
initial verdict
```

Content-hash both files.

Do not commit these files into the target commit.

Do not create a release tag at this phase.

# Phase 5 — Exact Node.js 22 verification

The required runtime is Node.js 22.

Use:

```text
Node.js 22.23.1
pnpm 10.13.1
```

or the exact repository-pinned compatible versions.

Record:

```sh
node --version
corepack --version
pnpm --version
git --version
uname -a
uname -m
```

Do not accept Node.js 24 execution as evidence of Node.js 22 compatibility.

Use a clean dependency store and remove build caches.

Run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
```

Verify:

* `package.json` engines require or support Node.js 22;
* `.node-version` and `.nvmrc`, where present, specify Node.js 22;
* GitHub Actions use Node.js 22;
* Docker production images use Node.js 22;
* no dependency requires Node.js 23 or 24;
* no source path relies on Node.js 24-only APIs;
* the frozen lockfile installs without mutation;
* the working tree remains clean.

A Node.js 22 failure is release-blocking.

# Phase 6 — Deterministic PRD compiler and coverage

Remove generated compiler outputs only through documented repository commands.

Run generation twice from the same immutable inputs.

Compare:

```text
all generated paths
file counts
file bytes
file SHA-256 values
aggregate manifest hashes
task inventory
cluster inventory
dependency graph
```

Run:

```sh
pnpm spec:verify
pnpm prd:compile
pnpm prd:drift-check
pnpm requirements:coverage
```

Expected inventory:

```text
requirements: 397
acceptance criteria: 204
invariants: 44
ADRs: 58
dependency groups: 8
task contracts: 84
cluster contracts: 8
```

Require:

```text
no duplicate normative IDs
no unmapped requirements
no unmapped acceptance criteria
one requirement owner per requirement
one acceptance owner per acceptance criterion
one cluster owner per task
acyclic task dependency graph
acyclic cluster dependency graph
byte-identical repeated generation
```

Investigate and explain any discrepancy rather than silently updating expected values.

# Phase 7 — Full harness gates

Run every mandatory repository gate.

At minimum:

```sh
pnpm architecture:verify
pnpm tests:skeleton-integrity
pnpm placeholders:scan
pnpm prohibited-capabilities:scan
pnpm migration:verify
pnpm harness:verify
pnpm test:e2e
pnpm test:mutation
pnpm test:harness
pnpm test:system
pnpm test:integration
pnpm test:service
pnpm harness:lifecycle
```

Also run any Tier 0–3 commands documented by the repository but not listed above.

Record for every command:

```text
exact command
start time
duration
exit code
relevant artifact path
```

Inspect the command implementations.

Fail release if a mandatory command:

* is a no-op;
* always returns success;
* hard-codes PASS;
* suppresses errors;
* skips required checks;
* uses `|| true`;
* silently ignores missing commands;
* accepts skipped or todo tests;
* verifies only report JSON rather than real implementation.

# Phase 8 — Proof-carrying task and cluster verification

This is a release-critical gate.

Independently prove that task and cluster completion cannot be forged.

Task verification must bind to at least:

```text
task contract hash
PRD hash
manifest hash
base commit
head commit
head Git tree
changed-file list
changed-file hashes
acceptance-test mappings
required test artifact hashes
dependency-interface hashes
verifier version
verification-policy version
lease ID
lease fencing version
verification timestamp
```

Run controlled negative cases for:

```text
forged task PASS with empty evidence
forged cluster PASS
empty acceptance mappings
empty requirement mappings
missing required test artifacts
post-result uncommitted source mutation
post-result committed source mutation
result copied from another task
result copied from another commit
wrong Git tree
wrong PRD hash
wrong manifest hash
stale lease
lost lease
wrong fencing version
task commit not reachable from cluster head
dirty tracked working tree
```

Every negative case must be rejected for a deterministic, specific reason.

Verify that:

```text
cluster:verify does not trust PASS fields
cluster:verify validates every task result
task commits are reachable from cluster head
source changes after result generation invalidate the result
empty evidence cannot pass
```

Any forged completion accepted is `FAIL_RELEASE`.

# Phase 9 — Lifecycle and generated ZCode goal verification

Verify that all commands referenced by generated task and cluster goals exist.

Specifically verify:

```text
pnpm task:begin <task-id>
pnpm task:self-review <task-id>
pnpm task:verify <task-id>
pnpm cluster:verify <cluster-id>
```

Run generated-goal command validation across every generated `.zcode-goal.md` file.

Require compiler failure when a generated goal references a nonexistent command.

Execute the complete lifecycle in an isolated temporary repository or fixture:

```text
DRAFT
→ VALIDATED
→ READY
→ LEASED
→ IMPLEMENTING
→ SELF_REVIEWING
→ VERIFYING
→ VERIFIED
→ MERGE_QUEUED
→ MERGED
```

Test:

```text
lease acquisition
lease renewal
stale lease rejection
fencing version enforcement
path-lock conflict
worktree isolation
atomic task commit
cluster-head advance
rebase after cluster advance
post-rebase verification
injected integration failure
automatic revert
cleanup
```

Do not alter remote `main` during the simulation.

# Phase 10 — Live PostgreSQL 17 and MinIO verification

Start the documented local service stack from clean Docker volumes.

Require:

```text
PostgreSQL 17
pinned MinIO version
healthy containers
MinIO started in server mode
automatic bucket provisioning
```

Verify MinIO effective startup is equivalent to:

```text
minio server /data --console-address ":9001"
```

Test PostgreSQL:

```text
empty database migration
migration rerun
migration ledger
transaction commit
transaction rollback
readiness with complete schema
readiness failure with missing migration
query behavior after drizzle-orm upgrade
```

Test MinIO/S3:

```text
bucket creation
put object
get object
same-byte idempotent immutable write
changed-byte collision rejection
object metadata retrieval
clean-volume initialization
```

Run the live-service walking skeleton.

Verify actual durable database rows and actual object-store artifacts.

Clean temporary containers, networks and volumes afterward.

# Phase 11 — API, dashboard and MCP verification

Start the production-configured API under Node.js 22.

Verify:

```text
GET /api/v1/health returns 200
GET /api/v1/readiness returns 200 only when dependencies are ready
readiness returns non-200 when PostgreSQL is unavailable
readiness returns non-200 when MinIO is unavailable
readiness returns non-200 when migrations are incomplete
graceful SIGINT shutdown
graceful SIGTERM shutdown
structured error responses
```

Require `x-correlation-id` on:

```text
successful API response
successful MCP response
validation error
authentication error
rate-limit error
concurrency-limit error
timeout
internal error
```

Verify valid inbound correlation IDs are preserved according to policy.

Test the synthetic slow MCP tool.

Require:

```text
deterministic timeout
request cancellation
tool cancellation
zero side effects after timeout
no background operation continuing after response
```

Test:

```text
valid origin
invalid origin rejection
authentication
body-size limit
rate limit
concurrency limit
request timeout
tool timeout
read-only synthetic tool
```

Verify the dashboard:

* builds successfully;
* runs from its production image;
* obtains readiness information through the API;
* does not access databases or external providers directly;
* does not contain static fake readiness results.

# Phase 12 — Production Docker verification

Build production images for:

```text
linux/amd64
linux/arm64
```

Use the repository’s actual production Dockerfiles.

At minimum:

```sh
docker buildx build \
  --platform linux/amd64 \
  --load \
  -f apps/api/Dockerfile \
  -t chainsieve-api:attest-amd64 \
  .

docker buildx build \
  --platform linux/arm64 \
  --load \
  -f apps/api/Dockerfile \
  -t chainsieve-api:attest-arm64 \
  .
```

Run equivalent builds for the dashboard.

Adapt exact paths only when the repository layout differs.

Verify:

```text
Node.js 22-compatible base images
multi-stage builds
non-root runtime
production dependencies only
no Playwright or Chromium in final production image
no test fixtures in final image
no development secrets
healthcheck
graceful shutdown
expected ports
no AMD64-only production dependency
no Docker Desktop-only dependency
```

Smoke-test API and dashboard images.

When executing an ARM64 image is supported, run it.

When only cross-build is possible, report:

```text
UNVERIFIED_ARM64_RUNTIME
```

A failed ARM64 build is release-blocking for Oracle Ampere A1 deployment readiness.

# Phase 13 — Security, dependency and secret checks

Verify:

```text
drizzle-orm >= 0.45.2
no reachable GHSA-gpj5-g38j-94v9 exposure
no committed secrets
no private keys
no API tokens
no production passwords
no unsafe root container where avoidable
no world-writable production paths
no unbounded exposed ports
no prohibited trading capability
no signing capability
no wallet custody capability
no automatic alpha activation
```

Run repository-native dependency and secret scanning commands.

Do not fail merely because an advisory exists. Evaluate:

```text
package
version
affected API
reachability
practical impact
patched version
```

# Phase 14 — CI evidence for the exact merge commit

Use GitHub CLI or authenticated GitHub API.

Resolve runs for exactly:

```text
f61b51a3c8e8772851b1619c0209299e35e870d8
```

Run:

```sh
gh run list \
  --repo quantm-zeus/chain-sieve \
  --commit f61b51a3c8e8772851b1619c0209299e35e870d8 \
  --limit 50 \
  --json databaseId,name,workflowName,status,conclusion,headSha,url,event,attempt
```

Verify all required Tier 0–3 checks passed for this exact SHA.

Do not use results from the repair branch’s earlier SHA as evidence for the merge commit.

Inspect failed, skipped or cancelled jobs.

Skipped required checks are not passing.

Record:

```text
workflow
job
run URL
head SHA
conclusion
attempt
```

# Phase 15 — GitHub repository controls

Using authenticated API evidence, verify:

```text
default branch = main
pull requests required for main
force push disabled
branch deletion disabled
required CI checks configured
stale approvals dismissed where applicable
latest-push approval policy where applicable
tag protection or ruleset for harness-v*
```

Do not claim these are enabled unless the API confirms them.

When code and exact-commit checks pass but GitHub controls cannot be inspected because of credentials or permissions, use:

```text
PASS_WITH_EXTERNAL_CONTROLS_PENDING
```

Do not use that verdict for code failures.

# Phase 16 — First ZCode handoff readiness

Verify:

```text
clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md
```

Confirm:

```text
cluster ID exists
all referenced task IDs exist
task count matches cluster contract
dependencies are ready
source hashes match
lease is required
worktree isolation is required
merge queue is required
goal cannot merge directly to main
capability activation remains disabled
stop conditions are bounded
all referenced pnpm commands exist
```

Run:

```sh
pnpm cluster:list
pnpm cluster:ready
pnpm cluster:verify C-G0-IMPLEMENTATION
```

An unimplemented cluster must not be falsely reported as completed.

The correct result should distinguish:

```text
ready to begin
not implemented
not verified
```

Do not start the cluster.

# Phase 17 — Final working-tree integrity

After all tests and controlled mutations:

```sh
git status --porcelain
git diff --exit-code
git diff --cached --exit-code
```

Require a clean target checkout.

Ensure every mutation fixture was reverted.

Ensure temporary generated output matches committed deterministic output.

Ensure no test container or volume remains unless explicitly retained outside the repository.

# Release-blocking conditions

Return `FAIL_RELEASE` for any of the following:

```text
origin/main does not equal target commit
wrong specification hash
Node.js 22 failure
frozen install failure
build, lint or typecheck failure
mandatory test failure
compiler nondeterminism
coverage or ownership gap
forged task or cluster completion accepted
post-result mutation accepted
stale lease accepted
unreachable task commit accepted
generated goal references invalid command
PostgreSQL migration or transaction failure
MinIO startup or immutable-object failure
MCP timeout leaks side effects
missing correlation ID on required paths
linux/amd64 production build failure
linux/arm64 production build failure
critical reachable security defect
prohibited product capability
required CI failure for the exact merge SHA
dirty final working tree
```

# Final attestation artifacts

Create outside the target Git tree:

```text
harness-v1.0.1.final.json
harness-v1.0.1.final.md
harness-v1.0.1-owner-actions.md
SHA256SUMS
```

Record actual immutable values:

```text
remote main SHA
verified commit SHA
verified tree SHA
existing v1.0.0 tag object SHA
existing v1.0.0 target SHA
PRD SHA
manifest SHA
audit SHA
Node.js version
pnpm version
Git version
host architecture
compiler hashes
test results
CI run URLs
Docker amd64 result
Docker arm64 result
PostgreSQL result
MinIO result
forgery rejection result
MCP timeout result
GitHub controls result
ZCode handoff result
final verdict
```

Do not use placeholders such as:

```text
THIS_REPORT_COMMIT
HEAD
refs/tags/...^{}
derive later
```

Content-hash every final artifact.

# Final tag policy

Only when the final verdict is:

```text
PASS_ATTESTED
```

and the target commit remains:

```text
f61b51a3c8e8772851b1619c0209299e35e870d8
```

you may create and push the annotated tag:

```text
harness-v1.0.1
```

Before creating it, verify the tag does not already exist:

```sh
if git rev-parse "refs/tags/harness-v1.0.1" >/dev/null 2>&1; then
  echo "harness-v1.0.1 already exists"
  exit 1
fi
```

Create:

```sh
git tag -a harness-v1.0.1 \
  f61b51a3c8e8772851b1619c0209299e35e870d8 \
  -m "ChainSieve attested harness v1.0.1

Attested commit: f61b51a3c8e8772851b1619c0209299e35e870d8
PRD: baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299
Manifest: e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff
Node.js 22: PASS
Harness verification: PASS
linux/amd64: PASS
linux/arm64: PASS"
```

Push only the new tag:

```sh
git push origin refs/tags/harness-v1.0.1
```

Then fetch and verify:

```sh
git fetch origin --tags

test "$(
  git rev-parse 'refs/tags/harness-v1.0.1^{}'
)" = \
"f61b51a3c8e8772851b1619c0209299e35e870d8"

git merge-base --is-ancestor \
  f61b51a3c8e8772851b1619c0209299e35e870d8 \
  origin/main
```

Record:

```text
tag object SHA
peeled target SHA
push result
```

Do not create the tag for:

```text
PASS_WITH_EXTERNAL_CONTROLS_PENDING
FAIL_RELEASE
UNVERIFIABLE
```

For `PASS_WITH_EXTERNAL_CONTROLS_PENDING`, provide the exact remaining owner actions and wait for repository controls to be verified before tagging.

# Final response

Clearly report:

```text
Verdict
Verified commit
Verified Git tree
origin/main SHA
Node.js 22 result
Compiler determinism result
Full test result
Forged-result rejection result
Post-result mutation rejection result
PostgreSQL 17 result
MinIO result
MCP timeout/cancellation result
linux/amd64 result
linux/arm64 result
Exact-commit CI result
GitHub controls result
First ZCode cluster readiness
Tag creation result
Remaining blockers
```

End with exactly one of:

```text
PASS_ATTESTED — HARNESS_V1.0.1_PUBLISHED
PASS_WITH_EXTERNAL_CONTROLS_PENDING — DO_NOT_TAG
FAIL_RELEASE — DO_NOT_TAG_OR_START_ZCODE
UNVERIFIABLE — DO_NOT_TAG_OR_START_ZCODE
```
