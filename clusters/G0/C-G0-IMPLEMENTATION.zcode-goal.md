# C-G0-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G0-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G0-COL`
- `T-G0-CORE`
- `T-G0-COST`
- `T-G0-DATA`
- `T-G0-DISC`
- `T-G0-DR`
- `T-G0-MCP`
- `T-G0-PROV`
- `T-G0-SEC`
- `T-G0-TRACE`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G0-IMPLEMENTATION` and an independent Codex review.
