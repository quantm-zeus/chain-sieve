# Muse Code full-autonomy setup

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
