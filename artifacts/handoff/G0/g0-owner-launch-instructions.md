# G0 owner action required before launch preparation can resume

Do not launch ZCode and do not acquire a task lease.

Choose and authorize exactly one branch-interface resolution:

1. Keep `cluster/C-G0-IMPLEMENTATION` and approve a versioned, independently reviewed harness amendment updating the goal generator, worktree manager, task verifier, and merge queue to use that branch; or
2. Approve `cluster/g0` as the G0 execution branch and amend the readiness contract accordingly.

The relevant hard-coded interface locations are:

- `tools/prd-compiler/compiler.ts:127`
- `tools/worktree-manager/manager.ts:26`
- `tools/task-verifier/verify.ts:54`
- `tools/merge-queue/processor.ts:174`

After the branch decision is implemented and independently verified:

1. Install and authenticate the actual ZCode runtime.
2. Verify its version and goal-mode invocation using read-only help/version commands.
3. Restart G0 readiness preparation.
4. Generate the remaining inventory, context checksums, per-task goals, execution plan, and just-in-time launcher.
5. Run the launcher only in `--dry-run` or `--validate-only` mode.

There is intentionally no future launch command in this report because the runtime interface is not installed and the repository execution branch is unresolved.
