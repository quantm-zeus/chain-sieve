# Muse Code full-autonomy setup (legacy, superseded)

> This describes the retired architecture retained only for migration diagnostics. Use `docs/operations/oss-factory.md` and `pnpm factory:*` for production.

ChainSieve can run Muse Code as a headless autonomous implementation provider while keeping lifecycle authority, verification, GitHub push/PR operations, CI repair, and merge in the trusted root control plane.

## One-time setup

1. Install and authenticate Muse Code using the installation/authentication flow for the Muse Code CLI version you use.
2. Run `muse --help` (or the executable name shipped by your installation) and identify that version's non-interactive prompt/goal invocation plus its persistent or non-interactive permission/auto-approval option.
3. Configure ChainSieve once. The CLI is new and its public command contract is not pinned by ChainSieve, so the exact Muse arguments are intentionally supplied as configuration instead of being guessed or hard-coded:

```bash
export CHAINSIEVE_MUSE_COMMAND='muse'
export CHAINSIEVE_MUSE_ARGS_JSON='["<headless-argument>","<permission-or-auto-approval-argument>","{prompt}"]'
export CHAINSIEVE_MUSE_PERMISSION_MODE='preapproved'
```

`CHAINSIEVE_MUSE_ARGS_JSON` must be a JSON array of strings and must contain `{prompt}` exactly once. Replace the placeholder arguments above with the real arguments shown by your installed Muse Code CLI. If Muse uses a different executable name, set `CHAINSIEVE_MUSE_COMMAND` accordingly.

`CHAINSIEVE_MUSE_PERMISSION_MODE=preapproved` is an explicit operator assertion: set it only after Muse Code itself is configured so its headless invocation will not pause to request interactive tool permissions. ChainSieve fails the doctor before acquiring any task if this assertion or the headless argument binding is missing.

The Muse model is deliberately **not** granted GitHub merge authority. It may edit, test, self-review, and create the task-local atomic commit according to the immutable task contract. The root ChainSieve control plane owns task integration, cluster review evidence, push, pull request creation, CI polling, CI repair commits, and merge. This is still zero-touch from the operator's perspective while preserving deterministic lifecycle and evidence checks.

## Liveness and spend guard

Every Muse launch is supervised by ChainSieve instead of being allowed to remain an opaque two-hour child process. The supervisor watches repository/lifecycle progress while streaming Muse output and applies five independent controls:

- a 30-minute hard wall for one Muse invocation;
- repeated provider-retry detection, including `retrying meta model stream`, rate-limit, overload, and transient-upstream signals;
- a retry-storm circuit breaker only when those retry signals coincide with stalled repository progress;
- a durable cooldown record under the Git common runtime directory so an outer retry cannot immediately pay for the same unhealthy provider loop again;
- task checkpoint observation: once `SELF_REVIEWING` or a later durable lifecycle state is visible, a lingering Muse process is terminated because the trusted control plane already has what it needs to continue.

A clean task worktree containing exactly one commit above its bound base is also recoverable. If lifecycle state is still `IMPLEMENTING`, ChainSieve reuses the current lease/receipt and runs the deterministic `task:self-review` transition instead of launching another Muse session just to rediscover work that is already committed. Dirty worktrees and multi-commit task results are never auto-reconciled.

The defaults can be tightened or relaxed without changing source:

```bash
export CHAINSIEVE_MUSE_HARD_TIMEOUT_MS=1800000
export CHAINSIEVE_MUSE_RETRY_STORM_LIMIT=8
export CHAINSIEVE_MUSE_RETRY_STALL_MS=120000
export CHAINSIEVE_MUSE_COMMIT_GRACE_MS=480000
export CHAINSIEVE_MUSE_CIRCUIT_COOLDOWN_MS=900000
```

Do not treat wall-clock supervision as exact token accounting. ChainSieve does not currently receive an authoritative per-request token/cost stream from the configured Muse CLI, so it deliberately does not invent a token budget from stdout. If the provider exposes trusted structured usage in a future version, add a provider-level token/spend limit in addition to these liveness controls.

Useful journal markers are `CHAINSIEVE_MUSE_SUPERVISED_START`, `CHAINSIEVE_MUSE_PROGRESS`, `CHAINSIEVE_MUSE_RETRY_SIGNAL`, `CHAINSIEVE_MUSE_CIRCUIT_OPEN`, `CHAINSIEVE_MUSE_CIRCUIT_COOLDOWN`, `CHAINSIEVE_MUSE_CHECKPOINT_OBSERVED`, `CHAINSIEVE_TASK_CHECKPOINT_RECONCILE`, and `CHAINSIEVE_TASK_CHECKPOINT_RECONCILED`.

## Live progress and diagnostics

A separate read-only status process can inspect the same authoritative Git/lifecycle state without interfering with the running product factory:

```bash
pnpm product:status
```

The command refreshes every five seconds and reports total task/cluster completion percentages, lifecycle-state counts, normative requirement and acceptance-criterion coverage, the inferred current phase and next control-plane action, current task and cluster branch/head/worktree state, commits from the bound base, changed paths, lease/fencing/expiry details, the last lifecycle transition, root checkout state, and active Muse/Antigravity/product-factory processes. It is safe to run from a second SSH session while the systemd service is active. Stop the status display with Ctrl+C; that does not stop the service.

For one snapshot instead of a watch loop:

```bash
pnpm agent:status
```

For machine-readable automation/debugging:

```bash
pnpm agent:status -- --json
```

The product-factory entrypoint also emits single-line JSON journal events prefixed with `CHAINSIEVE_EVENT:` for start, bootstrap migration, supervised-run start, failures, maintenance start/merge, re-exec start/failure/complete, successful product completion, and terminal errors. These events contain timestamps, severity, PID, provider/generation context, and bounded error text, so `journalctl` can show both human-oriented legacy markers and structured diagnostic events.

Useful journal commands:

```bash
sudo journalctl -u chainsieve-product.service -b -f
sudo journalctl -u chainsieve-product.service -b --no-pager | grep 'CHAINSIEVE_EVENT:'
sudo journalctl -u chainsieve-product.service -b --no-pager | grep -E 'CHAINSIEVE_(EVENT|MUSE|TASK_CHECKPOINT|AUTO_MAINTENANCE)'
```

## Preflight

Run once after configuring Muse:

```bash
pnpm autopilot -- --doctor --provider muse
```

Do not start the project until every doctor check passes. In particular, the Muse CLI, headless launch binding, preapproved permission assertion, GitHub authentication/write access, repository cleanliness, Node, pnpm, and origin reachability must all pass.

## Run the complete project

From a clean `main` checkout:

```bash
pnpm autopilot -- --provider muse
```

Do not pass `--max-cycles` for a full project run. The default loop continues until `AUTOPILOT_COMPLETE` or a bounded hard failure is reached.

During the run ChainSieve automatically selects the next PRD task, prepares an isolated worktree and lease, launches Muse headlessly, verifies the task, invokes Muse again for corrections when verification fails, integrates the task, performs independent machine cluster review, creates the cluster PR, polls CI, invokes Muse for bounded CI repair when checks fail, pushes the repair, polls again, merges when clean, advances to the next cluster, and finally waits for main CI before reporting completion.

There is no human review, approval, merge, task-selection, lease-renewal, or "run the agent again" handoff in `FULL_AUTONOMY` mode. Legacy compatibility text that asks for such a handoff is superseded for Muse sessions by the provider's full-autonomy guard.

## Security boundary

Keep secrets and authentication in Muse's supported credential/configuration mechanism or environment. Do not embed credentials in `CHAINSIEVE_MUSE_ARGS_JSON` or task prompts. The launch configuration is persisted in your shell/process environment, not in immutable task evidence.

If a future Muse release changes its command syntax, update only `CHAINSIEVE_MUSE_COMMAND` / `CHAINSIEVE_MUSE_ARGS_JSON`, rerun the doctor, and then run autopilot. The provider adapter does not depend on undocumented fixed Muse flags.
