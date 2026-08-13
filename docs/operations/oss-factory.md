# ChainSieve OSS factory operations

## Architecture and authority

ChainSieve's production factory is a thin integration layer. Committed product documentation defines what must be built; Spec Kit structures the milestone specification, plan, tasks, and convergence review; Agent Orchestrator (AO) owns sessions, tmux workers, worktrees, provider adapters, reviews, and local runtime persistence; GitHub owns issues, PRs, CI, branches, and integrated history. The Python Factory Controller makes only deterministic lifecycle, budget, security, review, and merge decisions.

The pins are recorded in `factory/upstream-lock.json` and proven in `factory/deployment/UPSTREAM_PROVENANCE.md`: AO `v0.12.3` at `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`, Spec Kit `v0.16.2` at `4871b485f97c7fa452ec58eba325d87536c55c34`, Muse `0.1.0-R708.1`, and Antigravity `1.1.12`. The requested ComposioHQ AO URL redirects to the canonical Untrivial-ai repository and GitHub reports it is not a fork. Production installs an exact Muse release binary rather than its auto-updating launcher. The Agy shim always injects `gemini-3.6-flash-high`. Upgrades occur only between milestones after `factory:upstream-check`, controller tests, provider smoke paths, and Ubuntu chaos validation.

Muse is the primary implementation worker. Antigravity is the secondary worker and the default reviewer of Muse changes. Muse reviews Antigravity changes. Codex is deliberately scarce and read-only: routine next-milestone planning uses `gpt-5.6-luna`/medium; major replan or provider-deadlock calls use `gpt-5.6-terra`/high; final product audit uses `gpt-5.6-terra`/high; and the one-call emergency architecture tier uses `gpt-5.6-sol`/high. Every role has an explicit per-milestone limit. Codex is not used for queue selection, monitoring, CI forwarding, review, ordinary correction/conflict handling, merge, or status.

## Work and integration lifecycle

A committed milestone plan contains stable work-package IDs, dependencies, acceptance criteria, preferred provider, risk, requirement IDs, and any explicit protected-path authority. The controller creates only trusted marker-bearing GitHub issues from this plan. Issue/comment prose never becomes a worker instruction. Prompts are reconstructed from committed authority.

Ready dependency nodes may run in parallel up to the configured cap. Each maps to one AO session, one worktree, branch `factory/<id>`, issue, and PR. Restart reconciliation correlates those durable identifiers. Duplicate or ambiguous branches, PRs, or sessions block while preserving work.

Integration requires the configured CI check at the current PR head, a cross-provider machine review from the required opposite harness at that exact head when policy requires it, no unauthorized protected-path changes, and a mergeable PR. The controller identity then records a GitHub approval for that exact head and performs an exact-head squash merge. Branch protection dismisses stale approvals and requires approval after the last push. Worker and integration identities are distinct, workers do not receive the integration credential, and worker-authored PRs are the only PRs routed for integration. CI, review, and ordinary merge-update failures are returned once per unique head/evidence to the owning AO session without invoking Codex.

Protected paths include product authority, controller/configuration, CI, and root lifecycle files. A work package must explicitly name any protected path it may modify. Neither implementation workers nor reviewers may weaken requirements, verification, or security to obtain a pass.

## Budgets and failure behavior

Configuration in `factory/config.json` bounds active workers, primary/alternate task attempts, corrections, review cycles, convergence passes, Codex calls, task time, milestone time, worktrees, memory, and disk. A first safe respawn uses the alternate provider. An existing terminated AO session is restored in place once; it is never blindly duplicated. If work exists only in an ambiguous or terminated worktree, the controller preserves it and blocks. Independent work continues.

AO `v0.12.3` does not directly switch a Muse worktree/session to Agy. Cross-provider recovery is therefore safe only for a clean respawn before evidence exists or by a separately validated PR-claim flow. The controller currently fails closed rather than fabricating that support.

Low resources open a circuit breaker and prevent new work while existing work continues to be monitored/preserved. Task/milestone timeouts and exhausted correction/review budgets block the affected package. AO activity and PR/CI changes update a durable meaningful-progress timestamp; an unchanged live process eventually becomes `STUCK` rather than remaining `ACTIVE`. AO v0.12.3 natively detects Muse input waits but lacks an Agy waiting-input detector, so Agy relies on the bounded stuck timeout and must prove this path live. Notifications are optional and informational; no notification response is needed for normal progress.

After every milestone merge set, Muse performs a read-only docs/spec/plan/tasks convergence pass. Gaps become deterministic idempotent remediation packages. When a milestone converges, the bounded Codex planner decomposes exactly the next committed roadmap objective into two to eight packages; the controller validates the DAG and requirement IDs, writes the runtime active plan plus Spec Kit-style `spec.md`, `plan.md`, and `tasks.md`, archives the prior state, and continues. After the last roadmap milestone, the controller automatically runs the schema-constrained read-only Codex audit; a non-converged audit becomes remediation work.

## Commands and observability

Use the package scripts:

```text
pnpm factory:doctor
pnpm factory:start
pnpm factory:stop
pnpm factory:restart
pnpm factory:status
pnpm factory:history
pnpm factory:sync
pnpm factory:converge
pnpm factory:final-audit
pnpm factory:upstream-check
```

`factory:status` reads local state without calling or mutating GitHub/AO. It distinguishes `STARTING`, `ACTIVE`, `IDLE`, `WAITING_INPUT`, `CI`, `REVIEW`, `BLOCKED`, `FAILED`, `COMPLETE`, and `STUCK`; it shows last progress, retries, resource gates, and separate Codex planner/replan/final-audit/emergency counters. `factory:history` reads the append-only JSONL event stream. AO exposes session detail and its dashboard only on loopback; use an SSH tunnel. Journald is the service-liveness log, AO/tmux is the worker log, GitHub Actions is CI truth, and `.factory/events.jsonl` (or `/var/lib/chainsieve/factory/events.jsonl`) is concise factory history. Logrotate bounds local history growth.

## Ubuntu installation and privilege boundaries

The target is Ubuntu x86-64 with Git, Python 3.12, GitHub CLI, tmux, uv, Node 22/pnpm 10.13.1, and exactly Go 1.25.7. The installer creates `/srv/chainsieve/.venv`; the controller has no third-party Python dependencies, and `factory/requirements.lock` records that empty lock. Supply separately obtained, verified Linux provider binaries:

```bash
sudo CHAINSIEVE_REPO_PATH=/srv/chainsieve/repo \
  CHAINSIEVE_MUSE_SOURCE=/secure/staging/muse-bin-0.1.0-R708.1 \
  CHAINSIEVE_MUSE_SHA256=<verified-linux-sha256> \
  CHAINSIEVE_AGY_SOURCE=/secure/staging/agy-1.1.12 \
  CHAINSIEVE_AGY_SHA256=<verified-linux-sha256> \
  factory/deployment/install-ubuntu.sh
```

The installer builds and tests AO from its pinned commit, installs pinned Spec Kit into `/usr/local/bin`, installs immutable provider targets and shims, creates separate `chainsieve-worker` and `chainsieve-controller` users/groups, builds the dedicated venv, and registers systemd services. Fill `/etc/chainsieve/ao.env` with the worker GitHub/provider credentials. Fill `/etc/chainsieve/factory.env` with the integration GitHub credential, Codex credential, and the Muse credential used only for read-only convergence. Each file is owner-only mode `0600` and unreadable by the other service user. Explicit subprocess allowlists prevent `GH_TOKEN` from reaching Muse/Codex and prevent provider/Codex credentials from reaching GitHub or AO commands. Use separate GitHub Apps: the worker can fetch and push `factory/*` and create PRs but cannot approve/merge or push protected targets; the controller identity can approve and merge only through its deterministic gate.

The installer runs AO's production-relevant Go packages rather than `go test ./...`: in v0.12.3 the unrelated fake-agent lifecycle test launches `sh -lc`, which resets its injected shim PATH on Debian/Ubuntu and fails to create its hook log. The actual session-manager suite passes once the declared tmux dependency is installed. Treat this exclusion as an upstream pin note, not evidence that live AO behavior passed.

`chainsieve-ao.service` and `chainsieve-factory.service` start at boot and do not depend on an SSH shell. AO binds to `127.0.0.1`. Before starting the factory controller, run `factory:doctor`; it refreshes AO's agent catalog and fails unless Muse and Agy are both authorized under the `chainsieve-worker` identity. Provision any Agy local profile under that service identity through the CLI's supported login flow; never copy a personal profile blindly. The controller repository is read-only under systemd and its state directory is writable. `KillMode=process` is intentionally conditional on passing the pinned AO Ubuntu child-survival tests before production cutover.

Validate on the actual host with `factory/deployment/validate-ubuntu.sh`. The safe live plan in `factory/deployment/canary-milestone.json` targets only `factory/canary-base`; prepare the branch with `prepare-canary.sh`, protect it with `configure-github.sh OWNER/REPO factory/canary-base`, and run `activate-canary.sh activate` while the controller is stopped. This uses the actual `chainsieve-factory.service` executable/topology with a systemd override that pins only the plan/config/target to canary. Never use `main` for validation. Use `reboot-probe.sh arm` once during a disposable active validation package; the enabled one-shot service records the post-boot result automatically. Also exercise SSH disconnect, AO daemon crash, worker crash, scoped GitHub outage, disk threshold injection, credential probes, worker privilege denial, Muse and Agy PR-to-merge, parallel workers, cross-review correction, review staleness, and convergence. Record evidence in `VPS_ACCEPTANCE.json`; code presence is not validation.

## Backup and recovery

Run `factory/deployment/backup.sh <destination>` from a protected backup job. It archives AO metadata/config, controller planning/events/state, and non-secret service definitions. It excludes `/etc/chainsieve/*.env`, provider credentials, package caches, and worktrees. Retain encrypted archives off-host under the normal operational policy.

After loss of local AO state, restore a compatible backup if available, start AO, then run `factory:reconcile`. Without a backup, GitHub issues, branches, PRs, merges, and the committed milestone remain authoritative. Re-register the AO project; the controller will complete merged work, recognize PRs/branches, and block ambiguous branch-only state rather than duplicating it.

## Migration status and legacy isolation

Normal production package entrypoints now target `python3 -m factory`; explicit `legacy:*` diagnostics and some old lifecycle/test scripts remain available during migration. They must not be installed as services or invoked by normal factory operation. The old code and tests are intentionally retained until all required live Muse/Agy, GitHub, parallelism, review, SSH, crash, reboot, and outage scenarios pass on Ubuntu. Deletion before that evidence would violate the migration safety gate.
