# C-G1-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G1-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G1-COST`
- `T-G1-DATA`
- `T-G1-DISC`
- `T-G1-EVAL`
- `T-G1-EXEC`
- `T-G1-MAT`
- `T-G1-OBJ`
- `T-G1-SIG`
- `T-G1-SOLSEC`
- `T-G1-SUP`
- `T-G1-TRD`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G1-IMPLEMENTATION` and an independent Codex review.
