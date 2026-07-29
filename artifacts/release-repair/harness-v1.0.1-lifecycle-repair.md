# ChainSieve harness-v1.0.1 lifecycle repair

Status: **ready for merge with one external GitHub-control blocker**.

This report does not authorize a direct merge, a release tag, final clean-room attestation, or ZCode G0.

## Immutable bindings

- Repair contract: `tasks/repairs/HARNESS-V1.0.1-LIFECYCLE-REPAIR.yaml`
- Repair contract SHA-256: `f9ab4b031f7a853619cc53045d4d0be39464bd7b216b19b1d7b56d69cc19a7cb`
- Base commit/tree: `a4072215f73cd2cdbf5608535633327b0b34891e` / `428579a08d21ffeb7e0d3f7941e4642a38bfc22a`
- Recovery amendment: `HARNESS-V1.0.1-LIFECYCLE-REPAIR-RECOVERY-001`
- Amendment file SHA-256: `210146f4407edb2c43607ee93ccae5bb220d7cf8c02aaeb3780b7f8a502e3225`
- Amendment canonical-payload SHA-256: `76bdd2c3cf65df184220afb587df5662c8cbb7af122cdb578876c92a8493fcde`
- Recovery source commit/tree: `b939736b3595b3679284643feb8496235290466d` / `c1f0bc47d9f1650adcf67d15013163a6d8545b0f`
- Fully verified pre-report commit/tree: `e26bc69d9c07ac6affecd0258fc2ef2593a2b962` / `9cc2c3adfc8d1102eb57ae5a32eae66fd8a8608c`
- Branch: `fix/harness-v1.0.1-lifecycle`

The report binds the fully verified pre-report commit and tree. Its containing report commit is resolved from Git history, avoiding an impossible self-reference.

## Fenced recovery

The expired lease `HARNESS-V1.0.1-LIFECYCLE-REPAIR:2:1785254231489` and fencing version 2 remain in the audit history. Version 2 was rejected with `STALE_LEASE_VERSION` for source modification, verification, report generation, push, PR creation, state transitions, and completion.

The owner-approved recovery used the existing repository equivalents:

`IMPLEMENTING → BLOCKED → READY → LEASED → IMPLEMENTING`

The active replacement lease is `HARNESS-V1.0.1-LIFECYCLE-REPAIR:3:1785329127900`, fencing version 3, held by `codex-lifecycle-repair-recovery-001`, and bound to the original repair contract, approved branch/source, and recovery amendment.

## Lifecycle evidence

`pnpm harness:lifecycle` passed twice after recovery. The final observed manifest was generated at `2026-07-29T13:01:52.563Z` and contains 8 scenarios, 43 executed commands, and 7 evidence hashes.

- A: the persisted lifecycle observed `DRAFT`, `VALIDATED`, `READY`, `LEASED`, `IMPLEMENTING`, `SELF_REVIEWING`, `VERIFYING`, `VERIFIED`, `MERGE_QUEUED`, and `MERGED`, ending in a real queue merge.
- B: renewal advanced fencing from 1 to 2; the old credential was rejected and the new credential authorized the protected transition.
- C: the second conflicting protected path operation was rejected deterministically.
- D: the production queue detected cluster-head advance, rebased, invalidated old evidence, generated fresh review and result evidence, ran the real task verifier, and merged.
- E: the pre-rebase self-review, task result, and verification evidence were all rejected.
- F: tracked post-result source mutation was rejected.
- G: deterministic post-merge integration failure produced an audited automatic revert and restored the branch tree.
- H: worktrees, leases, locks, queue items, and temporary branches were cleaned.

## Full verification

The suite ran with Node.js `v22.23.1`, pnpm `10.13.1`, and a clean dependency store. Every required command passed: frozen install, build, lint, typecheck, formatting, unit tests, source verification, double deterministic PRD compilation, drift, requirements coverage, architecture, skeleton integrity, placeholder and prohibited-capability scans, migration verification, harness verification, E2E, mutation, harness, system, integration, live-service, and lifecycle tests.

Focused proof tests passed 49 tests across 8 files, covering proof-carrying forgery rejection, post-rebase stale evidence, renewal and stale fencing, the real merge queue, automatic revert, Node.js 22 runtime behavior, compiler determinism, and MCP timeout/cancellation.

PostgreSQL `17-alpine` and MinIO `RELEASE.2025-07-23T15-54-02Z` passed the live-service suite and were cleaned afterward.

API and dashboard production images built and smoke-tested for `linux/amd64` and `linux/arm64`. All four ran as `node`, accepted a read-only root filesystem, exposed their health/page endpoint, contained no pnpm store, workspace `node_modules`, or tests, and stopped with exit code 0.

## Atomic commits

- `a1b309fa607f6c1e7a6f706058f517d1db9fc2d2` — freeze repair contract and acquisition bootstrap
- `5b3d3d9431bf2d7cea3acd3e29c0d2e8951a5867` — enforce evidence-bound production workflow
- `43882db084e748441c3930b1f0d83d93d1a58f2a` — require lifecycle verification in CI
- `cf15faacce9b7bf71746f7e03c12939c478c19c8` — keep the temporary lifecycle clone clean
- `b939736b3595b3679284643feb8496235290466d` — seed isolated acceptance fixtures
- `e26bc69d9c07ac6affecd0258fc2ef2593a2b962` — authorize fenced recovery
- `10b6a5f2b5fd5df5f23db3b8c321eb50cab883c1` — record lifecycle recovery verification

## External boundary

Pull request [#2](https://github.com/quantm-zeus/chain-sieve/pull/2) targets `main`. CI run [30454465214](https://github.com/quantm-zeus/chain-sieve/actions/runs/30454465214) completed successfully on exact head `10b6a5f2b5fd5df5f23db3b8c321eb50cab883c1`: Tier 0, Tier 1, Tier 2, all four API/dashboard `linux/amd64` and `linux/arm64` jobs, and Tier 3 pre-main passed.

The remaining blocker is external. Both the repository-ruleset and `main` branch-protection APIs return HTTP 403 with: “Upgrade to GitHub Pro or make this repository public to enable this feature.” No code change was attempted for this plan limitation.

No Crypto Intelligence product functionality was implemented. `main` was not modified directly. No release tag was created or moved. ZCode G0 was not started.
