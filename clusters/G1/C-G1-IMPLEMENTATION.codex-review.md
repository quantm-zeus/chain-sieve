# C-G1-IMPLEMENTATION codex-review

Independently review the completed cluster and produce PASS or CHANGES_REQUIRED. The immutable contract is `C-G1-IMPLEMENTATION.contract.json`. Validate source hashes before work. Work only on `cluster/g1`; create it from the current verified baseline if it does not exist. Never switch to or merge into `main`.

Tasks, in contract order:
- `T-G1-COST`
- `T-G1-DATA-01`
- `T-G1-DATA-02`
- `T-G1-DISC-01`
- `T-G1-DISC-02`
- `T-G1-EVAL-01`
- `T-G1-EVAL-02`
- `T-G1-EXEC-01`
- `T-G1-EXEC-02`
- `T-G1-EXEC-03`
- `T-G1-MAT-01`
- `T-G1-MAT-02`
- `T-G1-OBJ-01`
- `T-G1-OBJ-02`
- `T-G1-SIG`
- `T-G1-SOLSEC`
- `T-G1-SUP`
- `T-G1-TRD`

For every task, sequentially: run `pnpm worktree:create <task-id>`; enter the returned isolated worktree; run `pnpm task:acquire <task-id> --holder agent-orchestrator` and retain its lease version; run `pnpm task:begin <task-id> --holder agent-orchestrator --lease-version <version>`; implement only the contract IDs and allowed paths; run task-owned and immutable conformance tests; create exactly one atomic commit; self-review the complete committed diff; run `pnpm task:self-review <task-id> --holder agent-orchestrator --lease-version <version>`; then run `pnpm task:verify <task-id> --holder agent-orchestrator --lease-version <version>`. Return to the cluster worktree, run `pnpm merge-queue:add <task-id>` and `pnpm merge-queue:process`, then clean up the task worktree. Renew before expiry. Stop on hash drift, stale/lost lease, path conflict, specification gap, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.

After all tasks are atomically merged, run `pnpm cluster:verify C-G1-IMPLEMENTATION`. Cluster completion still requires a separate independent Codex review and `pnpm cluster:report C-G1-IMPLEMENTATION`; the implementation agent cannot author its own review or merge to main.
