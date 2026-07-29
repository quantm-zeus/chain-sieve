# G0 ZCode desktop Goal Mode payload

Use this only after an authorized `--prepare-task <task-id>` preflight has succeeded.

## Direct command form

```text
/goal Load the task goal path printed by the G0 preflight and the corresponding launch receipt. Implement exactly that one task, honoring the current lease ID, holder, fencing version, path locks, allowed and forbidden paths, required tests, mandatory self-review, one atomic commit, proof-carrying task verification, and the repository merge queue. Stop before any direct main merge and do not start another task.
```

## Interactive command-panel flow

1. Open the task workspace path printed by the preflight.
2. Open ZCode Agent and enter `/goal`.
3. Paste the objective above.
4. Attach or paste the exact task-specific goal file printed by the preflight.
5. Confirm the receipt task ID, lease ID, holder, fencing version, base commit, and task branch before allowing implementation.

The task-specific goal is authoritative for requirements, acceptance criteria, context hashes, paths, tests, stop conditions, and prohibited capabilities.
