# T-G0-DISC ZCode task goal

Implement exactly one task: `T-G0-DISC` in cluster `C-G0-IMPLEMENTATION`.

## Immutable bindings

- Canonical execution branch: `cluster/g0`
- Release baseline: `harness-v1.0.1`
- Release commit: `1027664eb708b4c1249dda5f1c33f5129946ab3e`
- Release tree: `706e400d3eb5c41a95209523bb034f2e2c60bd34`
- Context pack: `artifacts/context/T-G0-DISC`
- Context manifest SHA-256: `1e597fc5654d10e9c5719160b6bae04c08e0eeb277c2d57494324871288fc13d`
- Context aggregate SHA-256: `2585266019e65d2114f4cfe938dc909915bdb6d5f1fb5b01f1e3072c0d82d30a`
- Task base commit and tree: use the exact values in the just-in-time launch receipt; they must be descendants of the release commit and match the task worktree before implementation.

## Contract scope

- Requirements: `FR-DISC-001`, `FR-DISC-002`, `FR-DISC-003`, `FR-DISC-004`, `FR-DISC-005`
- Acceptance criteria: `AC-112`, `AC-227`
- Dependencies: none
- Path locks: `packages/discovery-universe/public-api`

Allowed paths:
- `packages/discovery-universe/**`
- `packages/cheap-monitor/**`
- `tests/**`
- `docs/implementation/**`

Forbidden paths:
- `docs/spec/**`
- `artifacts/spec/**`
- `tasks/generated/**`
- `.github/workflows/**`
- `infra/migrations/**`

Required tests:
- `tests/acceptance/AC-112.spec.ts`
- `tests/negative/AC-112.negative.spec.ts`
- `tests/acceptance/AC-227.spec.ts`
- `tests/negative/AC-227.negative.spec.ts`

## Required lifecycle

The just-in-time preflight must already have created this task worktree and acquired a current fenced lease. Read the launch receipt. Reject a missing, expired, lost, wrong-owner, wrong-task, or stale fencing credential.

Run, substituting only the receipt-bound holder and fencing version:

```sh
# Run in the selected task worktree.
pnpm spec:verify
pnpm task:begin T-G0-DISC --holder <holder> --lease-version <version>
pnpm exec vitest run tests/acceptance/AC-112.spec.ts tests/negative/AC-112.negative.spec.ts tests/acceptance/AC-227.spec.ts tests/negative/AC-227.negative.spec.ts
pnpm architecture:verify
pnpm prohibited-capabilities:scan
pnpm task:self-review T-G0-DISC --holder <holder> --lease-version <version>
pnpm task:verify T-G0-DISC --holder <holder> --lease-version <version>
# Return to /Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0 on cluster/g0.
pnpm merge-queue:add T-G0-DISC
pnpm merge-queue:process
```

Renew before expiry with:

```sh
pnpm task:renew T-G0-DISC --holder <holder> --lease-version <version>
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
