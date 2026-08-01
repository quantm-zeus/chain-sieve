# C-G7-IMPLEMENTATION agent-fix-goal

Fix only the findings in the latest cluster review. The immutable contract is `C-G7-IMPLEMENTATION.contract.json`. Validate source hashes before work. Work only on `cluster/g7`; create it from the current verified baseline if it does not exist. Never switch to or merge into `main`.

Tasks, in contract order:
- `T-G7-ADG`
- `T-G7-AEP`
- `T-G7-AIG`
- `T-G7-ALAB`
- `T-G7-AMS`
- `T-G7-EXP`
- `T-G7-OF`
- `T-G7-SPF`

For every task, sequentially: run `pnpm worktree:create <task-id>`; enter the returned isolated worktree; run `pnpm task:acquire <task-id> --holder agent-orchestrator` and retain its lease version; run `pnpm task:begin <task-id> --holder agent-orchestrator --lease-version <version>`; implement only the contract IDs and allowed paths; run targeted development tests; create exactly one atomic commit; self-review the complete committed diff; run `pnpm task:self-review <task-id> --holder agent-orchestrator --lease-version <version>`; then stop. The clean root control plane performs authoritative verification, merge-queue processing, and cleanup. Use only explicit root `pnpm agent:renew -- <task-id> --expected-lease-id <lease-id> --expected-fencing-version <version> --holder <holder>` or `pnpm agent:recover -- <task-id> ...` lifecycle operations; implementation agents never renew or recover credentials. Stop on hash drift, stale/lost lease, path conflict, specification gap, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.

After all tasks are atomically merged, the root control plane runs `pnpm cluster:verify C-G7-IMPLEMENTATION`, freezes the cluster result, and only then requests a separate independent review before `pnpm cluster:report C-G7-IMPLEMENTATION`.
