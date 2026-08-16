# Repository agent operating contract

## Current authority

The repository is undergoing an owner-authorized replacement of the legacy ChainSieve autonomous factory.

For the factory migration itself, the legacy task acquisition, lease, fencing, cluster, immutable task-goal, task-worktree, recovery, maintenance, and merge-queue protocols are **not authoritative prerequisites**.

Those legacy protocols remain applicable only when a session is explicitly launched to execute one generated legacy ChainSieve product task with an immutable task execution goal.

## Factory migration authority

An agent explicitly instructed by the repository owner to redesign, replace, migrate, or remove the autonomous factory/control plane may:

- inspect the complete repository and authoritative product documentation;
- create and use its own isolated migration branch/worktree;
- refactor or delete legacy factory infrastructure;
- modify repository-level tooling, configuration, tests, documentation, workflows, agent instructions, and service definitions required by the migration;
- introduce and pin OSS orchestration/planning dependencies;
- replace legacy agent/task lifecycle infrastructure;
- remove obsolete generated lifecycle artifacts after replacement validation;
- restructure product implementation when required to satisfy the authoritative product documentation.

No legacy task ID, cluster ID, lease, fencing version, launch receipt, context-manifest binding, conformance-manifest binding, generated task contract, or path lock is required for an owner-authorized factory architecture migration.

The migration agent must **not** run the legacy task lifecycle merely to obtain permission to replace that lifecycle. In particular, it must not require `task:acquire`, `task:begin`, `agent:renew`, `agent:recover`, legacy merge-queue commands, or a host-issued immutable task execution goal before beginning the migration.

This migration authority includes changing or retiring this repository operating contract and legacy `.agents/skills/**` instructions when doing so is part of the owner-authorized replacement.

## Product authority

Product intent remains authoritative during the migration.

Authority for product semantics is ordered as follows:

1. authoritative product documentation and normative requirement IDs;
2. accepted architecture decisions that do not weaken those requirements;
3. valid executable verification that correctly represents those requirements;
4. existing product implementation;
5. existing factory/control-plane implementation.

Existing implementation is replaceable. Product requirements are not.

Do not weaken, omit, silently reinterpret, or edit authoritative product requirements merely to make implementation or migration easier.

If documentation is ambiguous, inspect the relevant documentation set, choose the most coherent engineering interpretation, record material decisions in an ADR, and continue. If authoritative documents materially conflict, record the conflict and chosen resolution rather than silently changing product intent.

## Autonomous migration behavior

The owner-authorized factory migration is expected to proceed autonomously. Do not stop merely because a routine implementation, refactoring, dependency, planning, testing, review, permission, or architecture decision could be delegated back to the owner.

The migration may replace poor existing architecture rather than preserving it for compatibility. Prefer a simpler, reliable, OSS-backed design with a small ChainSieve-specific integration surface.

## Safety

Work on an isolated migration branch/worktree rather than treating the root checkout as an implementation workspace when a separate worktree is available.

Do not use `git reset --hard` or broad `git clean`.

Do not destroy unrelated runtime/user data, secrets, external repositories, or production resources.

Do not commit credentials or expose secrets to coding-agent prompts.

Before deleting a major legacy component, establish and validate its replacement path as far as the current environment permits.

Product agents must not weaken verification, security, or product authority merely to obtain a passing result.

## Legacy product-task execution

The legacy `.agents/skills/chainsieve-task` workflow applies **only** when the current session was explicitly launched with a legacy immutable ChainSieve task execution goal for one generated product task.

When that condition is true, continue to honor the task's supplied worktree, scope, bindings, allowed/forbidden paths, locks, verification requirements, and lifecycle ownership rules.

When the owner explicitly requests factory architecture migration, repository-wide factory refactoring, or replacement/removal of the legacy control plane, the legacy task workflow does not apply. Follow the factory migration authority in this file instead.

## Product-worker commit-history contract (No Amend / Force-Push)

Normal autonomous product workers MUST NOT use `git commit --amend`, `git rebase`, `git push --force`, `git push --force-with-lease`, or equivalent history rewriting under any circumstances. This applies especially after a pull request exists.

Normal correction behavior must strictly be:
1. edit affected code/tests;
2. perform focused local verification;
3. create a NEW additive commit;
4. execute a normal `git push`.

The deterministic merge queue may squash history later during integration. If the target integration branch moves and a branch update is genuinely required, merge the target branch into the product branch and normal push; do not rebase or force-push. Under no circumstances may a product worker rebase or force-push while semantic review is active.

## Test economy and verification policy

Product workers must maintain rigorous verification without wasteful synthetic duplication:

1. **New behavior or bug fix**: Add the smallest regression test that directly proves the changed behavior.
2. **Security/control-plane invariants**: Dedicated regression tests are strictly required.
3. **Pure refactors with sufficient coverage**: Do not add redundant tests merely to increase test count.
4. **Existing coverage reuse**: If an existing test already directly proves acceptance, reuse it rather than creating synthetic duplicates.
5. **Focused tests**: Prefer one focused test covering the invariant over multiple repetitive tests.
6. **No synthetic suites for optional suggestions**: Do not invent large synthetic integration suites merely because a reviewer suggested optional additional evidence.
7. **Preserve authoritative tests**: Do not weaken or delete existing authoritative tests solely to reduce CI duration.

## Local verification economy

Local worker verification must be focused and economical:
- Before pushing, run only the smallest useful affected checks. Do not routinely run the entire repository CI locally.
- Avoid repeatedly running broad suites (`pnpm test`, `pnpm test:integration`, `harness:lifecycle`, full typecheck) after every minor edit unless required by the changed behavior.
- If a local test runner hangs: inspect once, retry at most once with a materially justified invocation change. If it hangs again and CI is available, stop burning worker time locally, commit the focused change, and let exact-head CI provide authoritative verification.
- Do not perform repeated retries of local test runner hangs. Do not update Vite, Vitest, pnpm, lockfiles, or unrelated dependencies merely to resolve local test runner hangs unless reproduced in CI and explicitly part of the work package.

