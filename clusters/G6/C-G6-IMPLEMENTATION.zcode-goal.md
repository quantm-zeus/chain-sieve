# C-G6-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G6-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G6-AL`
- `T-G6-ANA`
- `T-G6-CF`
- `T-G6-EVAL`
- `T-G6-FHZ`
- `T-G6-LEGAL`
- `T-G6-MCP`
- `T-G6-MVD`
- `T-G6-OOD`
- `T-G6-PROD`
- `T-G6-SIG`
- `T-G6-WPI`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G6-IMPLEMENTATION` and an independent Codex review.
