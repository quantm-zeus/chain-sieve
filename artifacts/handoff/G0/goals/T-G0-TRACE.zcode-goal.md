# T-G0-TRACE ZCode task goal

Implement exactly one task: `T-G0-TRACE` in cluster `C-G0-IMPLEMENTATION`.

## Immutable bindings

- Canonical execution branch: `cluster/g0`
- Release baseline: `harness-v1.0.1`
- Release commit: `1027664eb708b4c1249dda5f1c33f5129946ab3e`
- Release tree: `706e400d3eb5c41a95209523bb034f2e2c60bd34`
- Context pack: `artifacts/context/T-G0-TRACE`
- Context manifest SHA-256: `80f94149c4709a70452ca7806e5046993beaa01fd61a327ab1a3ee1f10ae1911`
- Context aggregate SHA-256: `51eb51b995044bc5892812edadbc5421fc679921c737b55d614ac85258374d7c`
- Task base commit and tree: use the exact values in the just-in-time launch receipt; they must be descendants of the release commit and match the task worktree before implementation.

## Contract scope

- Requirements: `FR-TRACE-001`, `FR-TRACE-002`, `FR-TRACE-003`, `FR-TRACE-004`, `FR-TRACE-005`, `FR-TRACE-006`
- Acceptance criteria: `AC-265`, `AC-266`, `AC-267`, `AC-268`, `AC-269`
- Dependencies: none
- Path locks: `packages/requirement-manifest/public-api`

Allowed paths:
- `packages/requirement-manifest/**`
- `packages/release-conformance/**`
- `tests/**`
- `docs/implementation/**`

Forbidden paths:
- `docs/spec/**`
- `artifacts/spec/**`
- `tasks/generated/**`
- `.github/workflows/**`
- `infra/migrations/**`

Required tests:
- `tests/acceptance/AC-265.spec.ts`
- `tests/negative/AC-265.negative.spec.ts`
- `tests/acceptance/AC-266.spec.ts`
- `tests/negative/AC-266.negative.spec.ts`
- `tests/acceptance/AC-267.spec.ts`
- `tests/negative/AC-267.negative.spec.ts`
- `tests/acceptance/AC-268.spec.ts`
- `tests/negative/AC-268.negative.spec.ts`
- `tests/acceptance/AC-269.spec.ts`
- `tests/negative/AC-269.negative.spec.ts`

## Required lifecycle

The just-in-time preflight must already have created this task worktree and acquired a current fenced lease. Read the launch receipt. Reject a missing, expired, lost, wrong-owner, wrong-task, or stale fencing credential.

Run, substituting only the receipt-bound holder and fencing version:

```sh
# Run in the selected task worktree.
pnpm spec:verify
pnpm task:begin T-G0-TRACE --holder <holder> --lease-version <version>
pnpm exec vitest run tests/acceptance/AC-265.spec.ts tests/negative/AC-265.negative.spec.ts tests/acceptance/AC-266.spec.ts tests/negative/AC-266.negative.spec.ts tests/acceptance/AC-267.spec.ts tests/negative/AC-267.negative.spec.ts tests/acceptance/AC-268.spec.ts tests/negative/AC-268.negative.spec.ts tests/acceptance/AC-269.spec.ts tests/negative/AC-269.negative.spec.ts
pnpm architecture:verify
pnpm prohibited-capabilities:scan
pnpm task:self-review T-G0-TRACE --holder <holder> --lease-version <version>
pnpm task:verify T-G0-TRACE --holder <holder> --lease-version <version>
# Return to /Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0 on cluster/g0.
pnpm merge-queue:add T-G0-TRACE
pnpm merge-queue:process
```

Renew before expiry with:

```sh
pnpm task:renew T-G0-TRACE --holder <holder> --lease-version <version>
```

Create exactly one atomic task commit. Perform mandatory full-diff self-review and proof-carrying verification bound to the task contract, base, head, tree, changed files, tests, lease ID, fencing version, and current dependency-interface hashes. Use only the repository merge queue; never merge directly to `main`.

## Stop conditions

- A source hash differs from the task contract.
- A dependency is not MERGED or its public interface hash changed.
- Required behavior exceeds a declared budget without an approved split.
- A prohibited capability or activation path would be introduced.
- Stop after this one task; do not start another task without separate authorization.
- Stop if a command, context hash, dependency interface, path lock, lease, or fencing precondition differs.
- Stop rather than weakening, renumbering, reinterpreting, or omitting normative content.

## Prohibited capabilities

- No force-push or direct merge to `main`.
- No expired or stale lease reuse.
- No capability or alpha activation.
- No trading, transaction construction or submission, signing, wallet custody, or private credentials.
- No paid provider fallback in `STRICT_FREE`.
