# C-G3-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G3-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G3-ADM`
- `T-G3-AGT`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G3-IMPLEMENTATION` and an independent Codex review.
