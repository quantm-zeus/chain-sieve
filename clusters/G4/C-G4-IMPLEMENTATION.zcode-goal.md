# C-G4-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G4-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G4-ADM`
- `T-G4-CAP`
- `T-G4-CROWD`
- `T-G4-DECAY`
- `T-G4-FB`
- `T-G4-LAT`
- `T-G4-NB`
- `T-G4-THS`
- `T-G4-WHY`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G4-IMPLEMENTATION` and an independent Codex review.
