# ChainSieve autopilot

Run `pnpm autopilot` from the repository root. It selects canonical worktrees, manages fenced leases, runs Antigravity CLI headlessly, performs trusted verification and bounded corrections, integrates and cleans tasks, and continues through the authoritative queue.

The default launch is equivalent to:

```sh
agy --model "Gemini 3.6 Flash (High)" --mode=accept-edits -p "<immutable task payload>" --cwd "<canonical task worktree>"
```

Use `pnpm autopilot -- --status` for a zero-mutation status and smoke check. Only one process may run per repository. Automatic product correction stops after three rounds.

Antigravity is mandatory for the default path. The command fails closed when the headless `agy` CLI is unavailable; it does not silently consume Codex quota. Codex remains available only through the explicit fallback `pnpm autopilot -- --provider codex`.
