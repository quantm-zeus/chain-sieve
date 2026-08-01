# C-G4-IMPLEMENTATION agent-goal

Implement each READY task one at a time. The immutable contract is `C-G4-IMPLEMENTATION.contract.json`. Validate source hashes before work. Work only on `cluster/g4`; create it from the current verified baseline if it does not exist. Never switch to or merge into `main`.

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

For every task, sequentially: run `pnpm worktree:create <task-id>`; enter the returned isolated worktree; run `pnpm task:acquire <task-id> --holder agent-orchestrator` and retain its lease version; run `pnpm task:begin <task-id> --holder agent-orchestrator --lease-version <version>`; implement only the contract IDs and allowed paths; run targeted development tests; create exactly one atomic commit; self-review the complete committed diff; run `pnpm task:self-review <task-id> --holder agent-orchestrator --lease-version <version>`; then stop. The clean root control plane performs authoritative verification, merge-queue processing, and cleanup. Use only explicit root `pnpm agent:renew -- <task-id> --expected-lease-id <lease-id> --expected-fencing-version <version> --holder <holder>` or `pnpm agent:recover -- <task-id> ...` lifecycle operations; implementation agents never renew or recover credentials. Stop on hash drift, stale/lost lease, path conflict, specification gap, budget breach, prohibited capability, failed verification, or unmet dependency. Never activate product or alpha capability.

After all tasks are atomically merged, the root control plane runs `pnpm cluster:verify C-G4-IMPLEMENTATION`, freezes the cluster result, and only then requests a separate independent review before `pnpm cluster:report C-G4-IMPLEMENTATION`.
