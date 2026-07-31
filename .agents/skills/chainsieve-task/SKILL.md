---
name: chainsieve-task
description: Execute exactly one immutable ChainSieve task contract in its supplied isolated worktree.
---

# ChainSieve task execution

Work only in the task worktree named in the supplied task execution goal. Never implement in the root checkout or cluster worktree.

Before editing:

1. Read the immutable goal file completely before any repository exploration.
2. Validate its task ID, cluster ID, task branch, exact worktree, base commit and tree, lease ID, holder, expiry, fencing version, context-manifest hash, goal hash, conformance-manifest hash when present, and path locks against authoritative runtime state. Stop on a missing, expired, stale, foreign, or conflicting binding.
3. Read and validate the context manifest before reading other repository files. Start with `implementation-brief.json`, `interface-plan.json`, `behavior-test-matrix.json`, `normative-excerpts.json`, and `referenced-path-status.json`.
4. If the brief reports `SPECIFICATION_GAP`, an invalid reference, a changed active contract, an unmet dependency, or an interface-hash mismatch, stop. Do not invent a public contract.

Preserve valid existing work in the task worktree. Implement exactly one task and only its requirements, task-local acceptance facets, write set, and allowed paths. Respect forbidden paths and immutable conformance paths. Do not invoke the merge queue, merge a branch, start another task, release/reacquire the lease, renew or recover a lease, change its holder, switch provider credentials, or increment fencing. Provider adapters and implementation sessions never own lifecycle mutation.

Use targeted file reads. Do not scan the entire PRD unless the context pack is insufficient, and stop for a specification gap if the authoritative source still does not define the needed interface. Do not repeatedly reread unchanged files. Do not repeat completed analysis. Do not use web, browser, or unrelated MCP tools unless the task contract requires them.

During development, run focused positive, negative, degraded, replay, recovery, rollback, idempotency, and observability tests where required. Inspect concise summaries for successful commands and full output only for failures. Do not print complete successful logs.

Before completion:

1. Run the targeted development and task-owned tests required to support the implementation and self-review. Do not run the final authoritative verifier from the task worktree.
2. Create exactly one atomic implementation commit above the bound base.
3. Self-review the entire committed diff for scope, point-in-time leakage, fabricated success, unsafe fallback, capability activation, secret exposure, migration reversibility, conformance-oracle changes, and missing observability.
4. Run `task:self-review` with the bound holder, fencing version, and exact launch-receipt ID.
5. Stop. The clean root control plane independently validates the immutable verification baseline and runs the provider-independent authoritative verifier with this worktree supplied only as an untrusted target.

Never run `task:verify`, `agent:renew`, `agent:recover`, or any provider credential operation from the implementation session. Never invoke the merge queue and never start another task.

The implementation agent does not author, alter, approve, or replace its immutable conformance oracle and cannot issue the final independent cluster PASS review.
