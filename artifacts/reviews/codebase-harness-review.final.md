# Independent codebase and harness review — final

Final verdict: **PASS**. Initial verdict: **FAIL**. All three P0 findings, all twelve P1 findings, and both correctness/maintainability P2 findings have been resolved with code and deterministic controls. One non-blocking P3 formatting-baseline item remains.

## Release basis

- Bootstrap commit: `ae26ac134e118c6ca5bf08db6f3a2acda5c91e69`
- Immutable initial-review commit: `a28378d`
- Clean-checkout verified repair commit: `1d92ab62a8cf9268750c3ab494d04af098b32979`
- Final release commit: the commit resolved by `refs/tags/harness-v1.0.0^{}` after publication; a commit cannot embed its own Git object ID
- PRD SHA-256: `baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299`
- Manifest SHA-256: `e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff`
- Audit-evidence SHA-256: `ab4be13b6aeac998f13daa89ae08f4b9f5d6280b4018bd171b7b128b412a47f8`

The original bootstrap prompt is not present in the repository, any reachable history, or the inspected unreachable Git objects. This is recorded as an owner archival item. No generated report was elevated to authority: the implementation and harness were checked directly against the higher-authority PRD and manifest.

## Independent inventory

The source contains 397 requirements, 204 acceptance criteria, 44 invariants, 58 ADRs, 181 unique API method/path routes, 286 unique persistence names, and 8 dependency groups. The repaired compiler emits 1,160 files, 84 task contracts, and 8 acyclic cluster contracts. Every requirement and acceptance criterion is owned by exactly one task, and every task belongs to exactly one cluster. G0 contains 14 tasks.

## Codebase and architecture result

The API is a real Hono application with Zod/OpenAPI contracts, structured errors and logs, request IDs, dependency-aware readiness, bounded authenticated MCP transport, and a read-only synthetic tool routed through MCP Adapter to Tool Core. The SvelteKit dashboard production build passes and its server load obtains readiness through the API. Production configuration fails closed. S3 configuration selects the S3 adapter; Compose provisions the MinIO bucket.

PostgreSQL transactions use the transaction-scoped connection. Readiness requires the migration ledger and required schema. SQL is authoritative, Drizzle table names mirror it, and the bootstrap migration creates only 10 walking-skeleton tables. Empty-database migration and rerun pass against PostgreSQL 17. Filesystem and S3 immutable writes reject changed bytes; filesystem paths reject traversal and symlink escape.

Architecture verification enforces 11 boundaries, including domain/infrastructure isolation, persistence authority, dashboard isolation, MCP-to-Tool-Core routing, agent/provider separation, and cycle rejection. Controlled mutations are detected and reverted. Synthetic adapters require `capabilityMode: SYNTHETIC_SHADOW`; no live provider, production notification, signing, submission, swap, approval, order, custody, private-key, seed, or mnemonic path exists.

## Harness and deterministic evidence

Task verification requires a live fenced lease, expected isolated task branch, clean tree, one atomic commit, path/budget compliance, all declared tests, non-skipped/non-trivial assertions, real command execution, and an external runtime result. Cluster verification consumes merged task state and matching results, runs integration gates, and requires a separately tracked Codex review before reporting reviewed status.

The lifecycle test uses a real temporary Git repository and worktree, traverses recorded `READY → LEASED → IMPLEMENTING → SELF_REVIEWING → VERIFYING → VERIFIED → MERGE_QUEUED → MERGED`, rebases one atomic task commit over a cluster advance, rejects stale/expired leases and lock conflicts, executes an injected failing integration probe, and verifies Git revert removed the task change.

Compiler generation deletes/replaces controlled roots under a cross-process lock. Two final runs were byte-identical: 1,160 files with aggregate hash `f305f6c8b117b25144b37f654ae965c75a38712978c339f716ed5b68429010ae`. The command-output hash was `b6e65275ceea21ff125521841ab28619ebf3d01033370197aea02ebadb5367da`. Semantic stage `semantic-stage-v1-4231cbf20630563aaf691ef8ac1ce15dec50260178405ba4a2eb622ae3612b34` is frozen and content-addressed; normal compilation makes no live model call and cannot change normative IDs.

## Clean verification

From a dependency/cache-free detached worktree at `1d92ab6`, all requested commands exited 0: frozen install, build, lint, typecheck, 47-test default suite, spec verification, PRD compilation and drift, coverage, architecture, skeleton integrity, placeholder scan, prohibited-capability scan, migration verification, harness verification, browser E2E, mutation tests, harness tests, system tests, integration tests, live service test, and lifecycle simulation.

The live stack test used PostgreSQL 17 and MinIO, reset an empty schema, migrated it, exercised durable walking-skeleton rows and S3 artifacts, and passed transaction rollback/readiness checks. A separately started production-config API returned health 200, readiness 200 with PostgreSQL and S3 both true, served only the authenticated synthetic MCP readiness tool, propagated request IDs, and shut down with exit 0.

## Remaining and external items

`pnpm format:check` is a pre-existing repository-wide P3 failure over 89 files, including immutable PRD and untouched generated/schema inputs. It was not “fixed” by rewriting authority. Lint, strict typecheck, all mandatory checks, and `git diff --check` pass.

GitHub branch protection, required-review rules, rulesets, and tag protection are `REQUIRES_REPOSITORY_CONFIGURATION` because SSH Git authentication cannot inspect them. The original bootstrap prompt is `REQUIRES_OWNER_ARCHIVAL` if it exists outside Git.

## First ZCode cluster

Recommended first cluster: `C-G0-IMPLEMENTATION`.

```sh
zcode "$(cat clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md)"
```
