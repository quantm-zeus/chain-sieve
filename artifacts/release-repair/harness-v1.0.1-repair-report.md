# ChainSieve harness-v1.0.1 bounded repair report

Status: **ready for independent clean-room attestation with two external GitHub-control blockers**. This report is not an attestation and does not authorize the final `harness-v1.0.1` tag.

## Immutable bindings

- Repair branch: `fix/harness-v1.0.1-attestation`
- Continuation base: `822cbbe7f7229432bde66e5ba8e0e088a795f33c`
- Verified implementation head: `5bc384810fcf994ab9f96e5975de47dc5fa5434d`
- Verified implementation tree: `54596a6dd15df1fbed9f16c85973cbeddfe2363a`
- Repair contract SHA-256: `9191d56a5ac654b582ffa37f54b707fe1386521669b6f836b5c2acc0654c163a`
- Narrow amendment hashes: A001 `59e538a48966eb38eb74a93f024053887139a724b73b2e280a0cf318d00a99f7`; A002 `ba284f76726d50c01e664222ffd83fbb2799691c0d94d4f52f4f6ee142f22e84`. A002 authorizes only the previously omitted task-lease schema and merge-queue verifier integration paths.
- Lease: fencing version 2, ID `HARNESS-V1.0.1-REPAIR:2:1784726848931`; stale version 1 is rejected.
- Failed tag remains immutable: tag object `a8515700a7c09cbf2ea7dc97e59c19e91d4be316`, target `90027c40753d502d1893fd518382080b5302dd63`, tree `561efa1c33b1cef08972d844fd42ad38c65b25b8`.

The authoritative PRD, requirement-manifest and audit hashes match `baa521d9...7299`, `e0f9f128...90ff` and `ab4be13...47f8` respectively.

## The 98-file working tree

The original 98 entries were classified before cleanup: 51 formatting-only, 14 mixed functional/formatting, 9 functional-only, 5 expected generated, 17 new required, 2 pre-existing owner prompt files, and 0 unexpected. All 51 formatting-only changes were restored; the 14 mixed files were restored and their required semantic edits reapplied minimally. The post-cleanup inventory was 33 files before atomic commits, not one 98-file commit.

External safety copies were preserved outside the repository. Their hashes are recorded in the JSON report, together with the 98-entry classification-manifest hash.

## Verification outcome

The clean worktree used the official `node:22.23.1-bookworm` image with a fresh pnpm store and fresh `node_modules` volume. Recorded environment: Node `v22.23.1`, pnpm `10.13.1`, Git `2.39.5`, Linux `aarch64`.

Every required local command exited 0: frozen install, build, lint, typecheck, owned-file format check, full tests, source verification, double compilation, drift, coverage, architecture, skeleton integrity, placeholder and prohibited-capability scans, migrations, harness verification, E2E, mutation, harness, system, integration, service and lifecycle tests. The compiler produced 1,160 files twice with aggregate hash `e2020d8d2091d12c359cad931e254df7a80bbc7531f82e6bf753f034dfb82aa6`; byte/path hashes were identical. The clean worktree remained clean.

The proof suite rejects forged task and cluster PASS documents, tracked and untracked post-result mutations, committed post-result mutations, copied task/commit results, wrong trees, missing acceptance evidence, missing test artifacts, stale leases and task commits unreachable from cluster head. Cluster verification re-derives task evidence and confirms the attested source remains identical at cluster head.

MCP tests cover success, validation, authentication, rate limiting, concurrency limiting, timeout and internal error correlation. The deterministic slow test tool returns 504, is absent outside test mode and produces zero side effects after cancellation.

PostgreSQL 17 and MinIO were recreated on clean volumes. Empty-schema readiness, migration, migration rerun, query, commit, rollback, complete-schema readiness and the synthetic/shadow walking skeleton passed. `drizzle-orm` is exactly `0.45.2`; GHSA-gpj5-g38j-94v9 is no longer reported.

API and dashboard images built and smoke-tested for `linux/arm64` and `linux/amd64`. Both run as `node`, accept read-only root filesystems, expose only the expected ports, terminate with exit code 0 and contain no package-manager store, workspace `node_modules`, tests or Playwright/Chromium payload. The first manual API smoke command omitted required production environment variables and correctly failed closed; the corrected production-configured smoke passed on both architectures.

## Finding disposition

Resolved locally: `ATTEST-P0-001`, `ATTEST-P0-002`, `ATTEST-P1-003`, `ATTEST-P1-004`, `ATTEST-P1-006`, `ATTEST-P2-007`, `ATTEST-P2-008`, `ATTEST-P2-009`, and `ATTEST-P2-011`.

Remaining external blockers:

- `ATTEST-P1-005` — `gh auth status` reports no authenticated GitHub host; the remote default still points to `bootstrap/agent-harness-and-codebase`, so it was not changed.
- `ATTEST-P2-010` — branch and tag rulesets could not be inspected or changed without GitHub authentication/permission. Local Tier 0–3, patch-tag and workflow-dispatch gates are committed, but remote controls are not claimed enabled.

The production audit also reports unrelated moderate `GHSA-frvp-7c67-39w9` in `@hono/node-server@1.19.14`. It concerns Windows `serve-static`; these production images are Linux and the API does not use `serve-static`. It is disclosed for owner follow-up and is not suppressed.

## Release boundary

No Crypto Intelligence product cluster was started. `main` was not modified directly. No release-candidate or final patch tag was created. Independent review must verify the merged repair commit before any final immutable tag is created.
