# C-G5-IMPLEMENTATION zcode-goal

Implement each READY task one at a time. The immutable contract is `C-G5-IMPLEMENTATION.contract.json`. Validate source hashes before work.

Tasks, in contract order:
- `T-G5-ADQ`
- `T-G5-CROWD`
- `T-G5-DFD`
- `T-G5-LAR`
- `T-G5-LMS`
- `T-G5-NAR`
- `T-G5-NLL`
- `T-G5-POL`
- `T-G5-REG`
- `T-G5-SIG`
- `T-G5-SOC`
- `T-G5-WAL`
- `T-G5-XCF`

For every task: acquire its monotonically-versioned lease, honor read/write sets and exclusive locks, implement only its IDs, run `pnpm task:verify <task-id>`, self-review the diff, and create one atomic commit. Stop on hash drift, stale lease, path conflict, budget breach, prohibited capability, or unmet dependency. Never activate product or alpha capability.

Cluster completion requires `pnpm cluster:verify C-G5-IMPLEMENTATION` and an independent Codex review.
