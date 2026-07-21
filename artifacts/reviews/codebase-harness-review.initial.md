# Independent codebase and harness review — initial findings

Verdict: **FAIL**. The review reproduced three P0 defects and twelve P1 release blockers. Existing generated PASS reports are not reliable release evidence.

## Frozen review basis

- Bootstrap commit and RC tag target: `ae26ac134e118c6ca5bf08db6f3a2acda5c91e69`
- `main`: absent locally and remotely
- PRD SHA-256: `baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299`
- Manifest SHA-256: `e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff`
- Audit-evidence SHA-256: `ab4be13b6aeac998f13daa89ae08f4b9f5d6280b4018bd171b7b128b412a47f8`
- Bootstrap prompt: not found in the repository or its history
- SSH Git authentication: available; GitHub CLI/API authentication: unavailable

Independent counts match the frozen source artifacts: 397 requirements, 204 acceptance criteria, 44 invariants, 58 ADRs, 181 API routes, 286 persistence entities, 8 dependency groups, 70 task contracts and 8 cluster contracts. There are no duplicate normative IDs, API method/path pairs, persistence names, task IDs or cluster assignments. That structural agreement does not establish implementation or verifier correctness.

## What ran successfully

Frozen-lockfile install, build, lint, strict typecheck, 29-test Vitest suite, static dashboard browser test, source checksum verification, SQL migration under live PostgreSQL 17, migration rerun, Compose PostgreSQL/MinIO health, manual S3 put/get, and compiler double-generation all ran successfully. The compiler produced 977 byte-identical files twice with aggregate hash `f8df660f8668884b166164a09dae2a2104dd50dab440a28a54b2d4d681ae929e`.

Those passes are insufficient. The API returned HTTP 200 readiness against a database containing zero application tables. A transaction rollback left its inserted row committed. Task and cluster verification returned PASS despite zero declared acceptance-test files and no result/review artifacts.

## P0 findings

1. `INITIAL-P0-001` — task and cluster verifiers validate generated contract metadata and fabricate completion without tests, commits, leases, task results or independent reviews.
2. `INITIAL-P0-002` — task completion trusts `--verified true`; the lifecycle is incomplete; the Git simulation hard-codes key outcomes; merge-queue branch handling does not safely prove the cluster branch advances.
3. `INITIAL-P0-003` — the filesystem object store follows symlinks outside its root and returns a new-content hash after silently retaining different existing bytes.

## P1 findings

- `INITIAL-P1-004`: PostgreSQL transaction scoping is broken; readiness ignores migration completeness.
- `INITIAL-P1-005`: scanners accept an executable transaction-broadcast-style mutation and a skipped test.
- `INITIAL-P1-006`: all 70 tasks allow migrations, representative write sets exceed allowed paths, required paths/tests do not exist, and task verification is recursively specified.
- `INITIAL-P1-007`: the dashboard is static and does not obtain data from the API.
- `INITIAL-P1-008`: `OBJECT_STORE_DRIVER=s3` is ignored by API wiring; the Compose stack does not provision its bucket.
- `INITIAL-P1-009`: production configuration accepts development defaults.
- `INITIAL-P1-010`: fake/shadow adapters can return generic `AVAILABLE` without a typed non-production marker.
- `INITIAL-P1-011`: the walking skeleton is hermetic-only and does not cover the requested replay/recovery matrix or persisted trace continuity.
- `INITIAL-P1-012`: no frozen content-addressed semantic-stage artifact exists, and generated drift ignores unexpected output files.
- `INITIAL-P1-013`: CI omits multiple claimed release gates and its mutation coverage is not adversarial.
- `INITIAL-P1-014`: the bootstrap prompt and `main` base are absent; hosting controls cannot be inspected.
- `INITIAL-P1-015`: MCP transport lacks message-size, rate, concurrency and request-time bounds.

## P2 findings

- `INITIAL-P2-016`: dependency readiness checks and graceful shutdown are not robustly bounded.
- `INITIAL-P2-017`: future-facing adapter contracts and ineffective helpers add premature surface area without current behavioral proof.

## Controlled mutation results

The architecture verifier correctly rejected a domain-to-PostgreSQL import. It failed to reject an executable `broadcastSignedPayload` capability. Placeholder scanning and the test command both accepted an `it.skip` mutation. Every controlled repository mutation was reverted before this report was written.

Git hosting controls are `REQUIRES_REPOSITORY_CONFIGURATION` because the available SSH credential proves Git transport only; it cannot inspect branch protection, required reviews, tag protection or rulesets.
