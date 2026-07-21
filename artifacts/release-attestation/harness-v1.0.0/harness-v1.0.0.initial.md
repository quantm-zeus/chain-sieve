# ChainSieve harness v1.0.0 initial clean-room attestation

Attestation ID: `CSA-HARNESS-V1.0.0-20260721T170912Z`

Verdict: **FAIL_RELEASE**.

The exact published annotated tag resolves to commit `90027c40753d502d1893fd518382080b5302dd63` and tree `561efa1c33b1cef08972d844fd42ad38c65b25b8`. It is reachable from `origin/main`, and the tag object is `a8515700a7c09cbf2ea7dc97e59c19e91d4be316`. The three immutable specification hashes match exactly. The tag was not moved or modified.

## Release blockers

1. The harness accepts forged completion. In an isolated controlled mutation, all 14 G0 task results were supplied as schema-valid `PASS` documents with empty evidence, tracked source was then changed, and `pnpm cluster:verify C-G0-IMPLEMENTATION` exited 0 with `VERIFIED`. The mutation and Git-local runtime artifacts were removed; the detached checkout is clean and compiler drift passes.
2. Node.js 22 is explicitly unsupported. Official Node `v22.23.1` with Corepack `0.34.6`, pnpm `10.13.1`, and fresh stores cannot perform the frozen install because `package.json` requires `>=24 <25` with `engine-strict=true`. `.node-version` and every CI job use `24.14.0`.
3. No production Dockerfile exists. PostgreSQL and MinIO images run as `linux/arm64`, but there is no repository production image that can be passed to the required Buildx command.
4. The generated first ZCode goal is not executable: it invokes `pnpm task:begin` and `pnpm task:self-review`, neither of which exists; both exit 254.

## What passed

- The PRD, requirement manifest, and audit hashes match the required values.
- The annotated tag points exactly to `origin/main`; verified repair commit `1d92ab62a8cf9268750c3ab494d04af098b32979` is an ancestor. Its only differences from the release are five review/release report files.
- Initial and final review checksum files validate; immutable initial review blobs are unchanged.
- Two compiler generations produced identical 1,160-file path/byte/hash manifests. Full-manifest SHA-256 is `0ea9b9acb2d91a57feb31b71ffde9798b36e429cf0e3caaa8a3faf192b1a9f5a`; compiler aggregate is `f305f6c8b117b25144b37f654ae965c75a38712978c339f716ed5b68429010ae`.
- Counts and ownership are correct: 397 requirements, 204 acceptance criteria, 44 invariants, 58 ADRs, 8 groups, 84 tasks, 8 clusters; normative IDs are unique; requirement, acceptance, and task-cluster ownership are each unique; both graphs are acyclic.
- Under the repository's declared Node 24 runtime, build, lint, typecheck, all 47 default tests, browser E2E, architecture, scanner, migration, mutation, harness, system, integration, lifecycle, and service suites pass.
- A clean Docker stack proved PostgreSQL 17 and MinIO health, automatic bucket creation, empty migration and reruns, ledger readiness, rollback, empty/partial-schema fail-closed behavior, durable rows and S3 artifacts, same-byte idempotence, retrieval, and changed-byte immutable collision rejection.
- Production-configured API smoke under Node 24 proved health 200, readiness 200/503, structured errors, origin/auth/body/rate/concurrency controls, synthetic read-only MCP behavior, and direct-node graceful SIGINT/SIGTERM exit 0. Dashboard browser E2E proves API-backed readiness.

## Additional findings

- `BLOCKED_PROMPT_ARCHIVAL`: neither prompt nor `prompt-manifest.json` exists in the exact tag. No reconstruction was attempted.
- Remote `HEAD` points to `bootstrap/agent-harness-and-codebase`, not `main`.
- Successful MCP responses omit `x-correlation-id`, although health and error responses propagate it.
- `pnpm format:check` fails across 91 files including owned source; the old P3 classification no longer satisfies the requested formatting policy.
- `pnpm audit --prod --audit-level high` reports direct dependency `drizzle-orm@0.44.7` under GHSA-gpj5-g38j-94v9; practical dynamic-identifier reachability was not demonstrated.
- GitHub Actions and branch/tag protection are unverified because GitHub API authentication is unavailable. The repository is private to unauthenticated API access.
- MCP timeout behavior could not be proven with a slow synthetic handler; the only tool completed before a configured zero-millisecond timeout.

## ZCode state

`pnpm cluster:list` and `pnpm cluster:ready` correctly identify `C-G0-IMPLEMENTATION`, and clean pre-implementation `cluster:verify` correctly fails with `CLUSTER_TASK_NOT_MERGED`. Nonetheless the missing lifecycle commands and forged-result acceptance make the cluster **not ready**. Do not start it.

The exact command to run next is not a ZCode implementation command. It is to acquire/approve a bounded v1.0.1 harness-repair task contract covering the attestation findings, then create `fix/harness-v1.0.1-attestation`. The existing `harness-v1.0.0` tag must remain untouched.
