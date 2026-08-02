# ChainSieve autopilot

Run `pnpm autopilot` from the repository root. It selects canonical worktrees, manages fenced leases, runs Codex CLI headlessly, performs trusted verification and bounded corrections, integrates and cleans tasks, and continues through the authoritative queue.

Use `pnpm autopilot -- --status` for a zero-mutation status and smoke check. Only one process may run per repository. Automatic product correction stops after three rounds.

Codex CLI is the autonomous default. The installed Antigravity launcher exposes no supported headless prompt-and-wait model/thinking controls, so the requested Gemini 3.6 Flash with High reasoning preference is recorded as `ANTIGRAVITY_MODEL_NOT_PROGRAMMATICALLY_ENFORCEABLE` and is not silently substituted.
