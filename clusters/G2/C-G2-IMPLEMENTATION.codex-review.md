# C-G2-IMPLEMENTATION codex-review

Independently review the completed cluster and produce PASS or CHANGES_REQUIRED. The immutable contract is `C-G2-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G2-ADM`
- `T-G2-ALERT`
- `T-G2-DR`
- `T-G2-PROD`
- `T-G2-WF`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G2-IMPLEMENTATION` and an independent Codex review.
