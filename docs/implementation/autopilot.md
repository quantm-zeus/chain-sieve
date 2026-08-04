# ChainSieve autopilot

ChainSieve is configured for full autonomy through `config/autonomy-policy.json`. The owner does not review or approve individual implementation tasks. Machine review, deterministic verification, safe defaults and CI remain mandatory.

Run the real environment preflight first:

```sh
pnpm autopilot -- --doctor
```

The doctor fails closed unless the root checkout is clean and on `main`, Node 22 and pnpm are available, the Antigravity CLI exposes the required headless flags, GitHub CLI authentication works, the repository is accessible and `origin` can be fetched.

Run `pnpm autopilot` from the repository root. It selects canonical worktrees, manages fenced leases, runs Antigravity CLI headlessly, performs trusted verification and bounded corrections, integrates and cleans tasks, and continues through the authoritative queue.

The default task launch is equivalent to:

```sh
agy --model "Gemini 3.6 Flash (High)" --mode=accept-edits -p "<immutable task payload>" --cwd "<canonical task worktree>"
```

The committed autonomy policy preauthorizes tasks whose generated contracts retain historical `OWNER_APPROVAL_REQUIRED` labels, but it does not enable live trading, irreversible migrations, external write capabilities or secret materialization. Those capabilities remain disabled until a separate source-defined capability policy explicitly enables them.

Use `pnpm autopilot -- --status` for a zero-mutation queue view after the same environment doctor passes. Only one process may run per repository. Automatic product correction stops after the policy-defined limit.

Antigravity is mandatory for the default path. The command fails closed when the headless `agy` CLI is unavailable; it does not silently consume Codex quota. Codex remains available only through the explicit fallback `pnpm autopilot -- --provider codex`.
