# C-G6-IMPLEMENTATION codex-review

Independently review the completed cluster and produce PASS or CHANGES_REQUIRED. The immutable contract is `C-G6-IMPLEMENTATION.contract.json`. Validate source hashes before work. Work only on `cluster/g6`; create it from the current verified baseline if it does not exist. Never switch to or merge into `main`.

Tasks, in contract order:
- `T-G6-AL`
- `T-G6-ANA`
- `T-G6-CF`
- `T-G6-EVAL-01`
- `T-G6-EVAL-02`
- `T-G6-FHZ`
- `T-G6-LEGAL`
- `T-G6-MCP`
- `T-G6-MVD`
- `T-G6-OOD`
- `T-G6-PROD`
- `T-G6-SIG`
- `T-G6-WPI-01`
- `T-G6-WPI-02`

For every task, sequentially: run `pnpm worktree:create <task-id>`; enter the returned isolated worktree; run `pnpm task:acquire <task-id> --holder zcode` and retain its lease version; run `pnpm task:begin <task-id> --holder zcode --lease-version <version>`; implement only the contract IDs and allowed paths; run targeted tests; create exactly one atomic commit; self-review the complete committed diff; run `pnpm task:self-review <task-id> --holder zcode --lease-version <version>`; then run `pnpm task:verify <task-id> --holder zcode --lease-version <version>`. Return to the cluster worktree, run `pnpm merge-queue:add <task-id>` and `pnpm merge-queue:process`, then clean up the task worktree. Renew before expiry. Stop on hash drift, stale/lost lease, path conflict, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.

After all tasks are atomically merged, run `pnpm cluster:verify C-G6-IMPLEMENTATION`. Cluster completion still requires a separate Codex review and `pnpm cluster:report C-G6-IMPLEMENTATION`; this goal cannot author its own review or merge to main.
