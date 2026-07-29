# G0 owner launch instructions

Repository preparation is complete. Do not run the task-preparation step until
the owner separately authorizes the first implementation task.

1. Install and open the ZCode desktop application.
2. Connect and confirm the desired model in the ZCode UI.
3. Open this workspace:

   ```text
   /Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0
   ```

4. Validate the repository without mutation:

   ```sh
   tools/zcode/g0-preflight.sh --validate-only
   ```

5. After separate owner authorization, prepare only the recommended first task:

   ```sh
   tools/zcode/g0-preflight.sh --prepare-task T-G0-CORE
   ```

6. The preflight prints `TASK_WORKSPACE`, `TASK_GOAL`, `LAUNCH_RECEIPT`,
   `LEASE_ID`, and `FENCING_VERSION`. Open the printed task workspace in ZCode.
7. In ZCode Agent, enter `/goal`, then paste:

   ```text
   Load the task goal path printed by the G0 preflight and the corresponding launch receipt. Implement exactly that one task, honoring the current lease ID, holder, fencing version, path locks, allowed and forbidden paths, required tests, mandatory self-review, one atomic commit, proof-carrying task verification, and the repository merge queue. Stop before any direct main merge and do not start another task.
   ```

8. Attach or paste the task-specific goal printed by the preflight. Confirm its
   receipt-bound base commit/tree before allowing implementation.

The static Goal Mode payload is
`artifacts/handoff/G0/g0-goal-payload.md`. The shell preflight never starts
ZCode automatically, and its default mode is always `--validate-only`.
