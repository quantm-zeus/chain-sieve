# T-G0-DATA ZCode task goal

Implement exactly one task: `T-G0-DATA` in cluster `C-G0-IMPLEMENTATION`.

## Immutable bindings

- Canonical execution branch: `cluster/g0`
- Release baseline: `harness-v1.0.1`
- Release commit: `1027664eb708b4c1249dda5f1c33f5129946ab3e`
- Release tree: `706e400d3eb5c41a95209523bb034f2e2c60bd34`
- Context pack: `artifacts/context/T-G0-DATA`
- Context manifest SHA-256: `37b370cb5db96240924a6044a98d2110fa7e5425bbf9d2c9f0d7e0f562eed0e9`
- Context aggregate SHA-256: `e0dbdd29166e54eb6c3d1be9bd024d240d728fc51b1a4bb489515c1bd937db2e`
- Task base commit and tree: use the exact values in the just-in-time launch receipt; they must be descendants of the release commit and match the task worktree before implementation.

## Contract scope

- Requirements: `FR-DATA-001`, `FR-DATA-002`, `FR-DATA-003`, `FR-DATA-004`, `FR-DATA-005`, `FR-DATA-006`
- Acceptance criteria: `AC-020`, `AC-240`, `AC-246`
- Dependencies: none
- Path locks: `infra/migrations`

Allowed paths:
- `packages/persistence/**`
- `packages/evidence/**`
- `tests/**`
- `docs/implementation/**`
- `infra/migrations/**`

Forbidden paths:
- `docs/spec/**`
- `artifacts/spec/**`
- `tasks/generated/**`
- `.github/workflows/**`

Required tests:
- `tests/acceptance/AC-020.spec.ts`
- `tests/negative/AC-020.negative.spec.ts`
- `tests/acceptance/AC-240.spec.ts`
- `tests/negative/AC-240.negative.spec.ts`
- `tests/acceptance/AC-246.spec.ts`
- `tests/negative/AC-246.negative.spec.ts`

## Required lifecycle

The just-in-time preflight must already have created this task worktree and acquired a current fenced lease. Read the launch receipt. Reject a missing, expired, lost, wrong-owner, wrong-task, or stale fencing credential.

Run, substituting only the receipt-bound holder and fencing version:

```sh
# Run in the selected task worktree.
pnpm spec:verify
pnpm task:begin T-G0-DATA --holder <holder> --lease-version <version>
pnpm exec vitest run tests/acceptance/AC-020.spec.ts tests/negative/AC-020.negative.spec.ts tests/acceptance/AC-240.spec.ts tests/negative/AC-240.negative.spec.ts tests/acceptance/AC-246.spec.ts tests/negative/AC-246.negative.spec.ts
pnpm architecture:verify
pnpm prohibited-capabilities:scan
pnpm task:self-review T-G0-DATA --holder <holder> --lease-version <version>
pnpm task:verify T-G0-DATA --holder <holder> --lease-version <version>
# Return to /Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0 on cluster/g0.
pnpm merge-queue:add T-G0-DATA
pnpm merge-queue:process
```

Renew before expiry with:

```sh
pnpm task:renew T-G0-DATA --holder <holder> --lease-version <version>
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
