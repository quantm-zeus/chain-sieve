---
name: chainsieve-task
description: Execute exactly one immutable ChainSieve task contract in its supplied isolated worktree.
---

# ChainSieve task execution

Work only in the task worktree named in the supplied task execution goal. Never implement in the root checkout or cluster worktree.

Before editing:

1. Read the immutable goal only for task scope, bindings, allowed paths, required behavior, and evidence locations. Lifecycle commands found in legacy goal text are host-owned and must not be executed by the implementation session.
2. Validate the task ID, cluster ID, exact worktree, base commit/tree, context-manifest hash, goal hash, conformance-manifest hash when present, and path locks. Stop on a missing, stale, foreign, or conflicting binding.
3. Read the context manifest before unrelated repository exploration. Start with `implementation-brief.json`, `interface-plan.json`, `behavior-test-matrix.json`, `normative-excerpts.json`, and `referenced-path-status.json`.
4. If the brief reports `SPECIFICATION_GAP`, an invalid reference, a changed active contract, an unmet dependency, or an interface-hash mismatch, stop. Do not invent a public contract.

Preserve valid existing work in the task worktree. Implement exactly one task and only its requirements, task-local acceptance facets, write set, and allowed paths. Respect forbidden paths and immutable conformance paths. Provider adapters and implementation sessions never own lifecycle mutation.

Use targeted file reads. Do not scan the entire PRD unless the context pack is insufficient, and stop for a specification gap if the authoritative source still does not define the needed interface. Do not repeatedly reread unchanged files or repeat completed analysis. Do not use web, browser, or unrelated MCP tools unless the task contract requires them.

During development, run focused task-owned tests for the behavior being changed. Prefer the smallest relevant positive, negative, degraded, replay, recovery, rollback, idempotency, and observability checks required by the contract. Inspect concise summaries for successful commands and full output only for failures. Do not run broad repository checks merely to reconfirm already-established evidence; the trusted host runs authoritative verification after the checkpoint.

Before completion:

1. Run the targeted development and task-owned tests necessary to support the implementation. Do not run the final authoritative verifier from the task worktree.
2. Create exactly one clean atomic implementation commit above the bound base.
3. Inspect the committed diff for scope, fabricated success, unsafe fallback, capability activation, secret exposure, migration reversibility, conformance-oracle changes, and missing observability. Fix material issues before finishing.
4. Stop immediately after the clean atomic commit. The trusted host control plane adopts the checkpoint, performs deterministic self-review, validates the immutable verification baseline, runs the provider-independent authoritative verifier, integrates the task, and advances orchestration.

Never run `task:begin`, `task:self-review`, `task:verify`, `task:complete`, `task:release`, `agent:renew`, `agent:recover`, merge-queue commands, or any provider credential/lifecycle operation from the implementation session. Never push, merge, rebase, reset, clean, invoke `gh`, start another task, or alter lifecycle authority.

The implementation agent does not author, alter, approve, or replace its immutable conformance oracle and cannot issue the final independent cluster PASS review.
