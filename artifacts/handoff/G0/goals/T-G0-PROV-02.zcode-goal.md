# T-G0-PROV-02 ZCode task goal

Implement exactly one task: `T-G0-PROV-02` in cluster `C-G0-IMPLEMENTATION`.

## Immutable bindings

- Canonical execution branch: `cluster/g0`
- Release baseline: `harness-v1.0.1`
- Release commit: `1027664eb708b4c1249dda5f1c33f5129946ab3e`
- Release tree: `706e400d3eb5c41a95209523bb034f2e2c60bd34`
- Context pack: `artifacts/context/T-G0-PROV-02`
- Context manifest SHA-256: `b281879f9964bc2a1ece5c880787c9dcbd80b4c46eb8875bbe9aa1f5f47073a8`
- Context aggregate SHA-256: `857667178f3f1dc3101db2bf78bf9c43c7eb241be2b784366bc608a315eb56a6`
- Task base commit and tree: use the exact values in the just-in-time launch receipt; they must be descendants of the release commit and match the task worktree before implementation.

## Contract scope

- Requirements: `FR-PROV-009`, `FR-PROV-010`
- Acceptance criteria: `AC-251`, `AC-253`, `AC-258`, `AC-271`
- Dependencies: none
- Path locks: `packages/provider-lifecycle/public-api`

Allowed paths:
- `packages/provider-lifecycle/**`
- `packages/providers/**`
- `tests/**`
- `docs/implementation/**`

Forbidden paths:
- `docs/spec/**`
- `artifacts/spec/**`
- `tasks/generated/**`
- `.github/workflows/**`
- `infra/migrations/**`

Required tests:
- `tests/acceptance/AC-251.spec.ts`
- `tests/negative/AC-251.negative.spec.ts`
- `tests/acceptance/AC-253.spec.ts`
- `tests/negative/AC-253.negative.spec.ts`
- `tests/acceptance/AC-258.spec.ts`
- `tests/negative/AC-258.negative.spec.ts`
- `tests/acceptance/AC-271.spec.ts`
- `tests/negative/AC-271.negative.spec.ts`

## Required lifecycle

The just-in-time preflight must already have created this task worktree and acquired a current fenced lease. Read the launch receipt. Reject a missing, expired, lost, wrong-owner, wrong-task, or stale fencing credential.

Run, substituting only the receipt-bound holder and fencing version:

```sh
# Run in the selected task worktree.
pnpm spec:verify
pnpm task:begin T-G0-PROV-02 --holder <holder> --lease-version <version>
pnpm exec vitest run tests/acceptance/AC-251.spec.ts tests/negative/AC-251.negative.spec.ts tests/acceptance/AC-253.spec.ts tests/negative/AC-253.negative.spec.ts tests/acceptance/AC-258.spec.ts tests/negative/AC-258.negative.spec.ts tests/acceptance/AC-271.spec.ts tests/negative/AC-271.negative.spec.ts
pnpm architecture:verify
pnpm prohibited-capabilities:scan
pnpm task:self-review T-G0-PROV-02 --holder <holder> --lease-version <version>
pnpm task:verify T-G0-PROV-02 --holder <holder> --lease-version <version>
# Return to /Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0 on cluster/g0.
pnpm merge-queue:add T-G0-PROV-02
pnpm merge-queue:process
```

Renew before expiry with:

```sh
pnpm task:renew T-G0-PROV-02 --holder <holder> --lease-version <version>
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
