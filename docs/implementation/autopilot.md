# ChainSieve autopilot

ChainSieve is configured for full autonomy through `config/autonomy-policy.json`. The owner does not review or approve individual implementation tasks. Machine review, deterministic verification, safe defaults and CI remain mandatory.

Run the provider-aware environment preflight first:

```sh
pnpm autopilot -- --doctor
```

For an explicit fallback provider, use the same provider for the doctor and execution:

```sh
pnpm autopilot -- --provider codex --doctor
pnpm autopilot -- --provider codex
```

The doctor fails closed unless the root checkout is clean and on `main`, Node 22 and pnpm 10.13.1 are available, the selected provider exposes its required headless interface, GitHub CLI authentication and repository push access work, and `origin` can be fetched.

Run `pnpm autopilot` from the repository root. It selects canonical worktrees, manages fenced leases, runs the provider headlessly with bounded command execution, performs trusted verification and bounded corrections, integrates and cleans tasks, and continues through the authoritative queue.

The default task launch is equivalent to:

```sh
agy --model "Gemini 3.6 Flash (High)" --mode=accept-edits -p "<immutable task payload>" --cwd "<canonical task worktree>"
```

The implementation or review model may modify only its assigned working tree. The trusted root control plane owns all authoritative Git and GitHub operations: scope validation, commits, resets, force-with-lease, pushes, pull requests and merges. Specification resolution and CI repair are rejected when their changed paths cross the machine-enforced allowlists.

Independent review is bound to a trusted session receipt containing the provider, generated identity, exact product commit and tree, implementation holders and an internal receipt hash. The cluster verifier rejects missing, stale or forged review-session bindings.

The committed autonomy policy preauthorizes tasks whose generated contracts retain historical `OWNER_APPROVAL_REQUIRED` labels, but it does not enable live trading, irreversible migrations, external write capabilities or secret materialization. Those capabilities remain disabled until a separate source-defined capability policy explicitly enables them.

Task leases default to 120 minutes and remain bounded by the lifecycle policy. Task correction, cluster CI repair and infrastructure retry budgets are persisted in trusted runtime state so restarting the process does not reset the limits.

Autopilot does not report project completion immediately after the final merge. It runs final deterministic verification and then waits for the CI workflow attached to the exact final `main` commit to finish successfully.

Use `pnpm autopilot -- --status` for a zero-mutation queue view after the same provider-aware doctor passes. Only one process may run per repository. A stale or corrupt lock is recovered using its host, PID, token, timestamp and TTL.

Antigravity is mandatory for the default path. The command fails closed when the headless `agy` CLI is unavailable; it does not silently consume Codex quota. Codex remains available only through the explicit fallback shown above.
