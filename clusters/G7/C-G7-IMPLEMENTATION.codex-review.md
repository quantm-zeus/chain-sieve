# C-G7-IMPLEMENTATION codex-review

Independently review the completed cluster and produce PASS or CHANGES_REQUIRED. The immutable contract is `C-G7-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G7-ADG`
- `T-G7-AEP`
- `T-G7-AIG`
- `T-G7-ALAB`
- `T-G7-AMS`
- `T-G7-EXP`
- `T-G7-OF`
- `T-G7-SPF`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G7-IMPLEMENTATION` and an independent Codex review.
