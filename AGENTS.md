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
