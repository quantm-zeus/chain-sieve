# C-G0-IMPLEMENTATION zcode-fix-goal

Fix only the findings in the latest cluster review. The immutable contract is `C-G0-IMPLEMENTATION.contract.json`. Validate source hashes before work. Work only on `cluster/g0`; create it from the current verified baseline if it does not exist. Never switch to or merge into `main`.

Tasks, in contract order:
- `T-G0-COL-01`
- `T-G0-COL-02`
- `T-G0-CORE`
- `T-G0-COST-01`
- `T-G0-COST-02`
- `T-G0-DATA`
- `T-G0-DISC`
- `T-G0-DR`
- `T-G0-MCP`
- `T-G0-PROV-01`
- `T-G0-PROV-02`
- `T-G0-SEC-01`
- `T-G0-SEC-02`
- `T-G0-TRACE`

For every task, sequentially: run `pnpm worktree:create <task-id>`; enter the returned isolated worktree; run `pnpm task:acquire <task-id> --holder zcode` and retain its lease version; run `pnpm task:begin <task-id> --holder zcode --lease-version <version>`; implement only the contract IDs and allowed paths; run targeted tests; create exactly one atomic commit; self-review the complete committed diff; run `pnpm task:self-review <task-id> --holder zcode --lease-version <version>`; then run `pnpm task:verify <task-id> --holder zcode --lease-version <version>`. Return to the cluster worktree, run `pnpm merge-queue:add <task-id>` and `pnpm merge-queue:process`, then clean up the task worktree. Renew before expiry. Stop on hash drift, stale/lost lease, path conflict, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.

After all tasks are atomically merged, run `pnpm cluster:verify C-G0-IMPLEMENTATION`. Cluster completion still requires a separate Codex review and `pnpm cluster:report C-G0-IMPLEMENTATION`; this goal cannot author its own review or merge to main.
