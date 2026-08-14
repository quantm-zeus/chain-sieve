# ChainSieve OSS factory operations

## Architecture and authority

Authoritative product documentation defines the outcome. Spec Kit supplies planning and convergence artifacts. The deterministic Python Factory Controller owns scheduling, dependency readiness, budgets, reconciliation, CI/review gates, exact-head merge, convergence transitions, status, and events. Agent Orchestrator (AO) owns tmux/process sessions, isolated worktrees, Muse/Agy execution, activity, and machine reviews. GitHub owns issues, PRs, CI, branches, and integrated history. Codex is used only for bounded planning, exceptional replan, and final audit.

The production pins remain AO `v0.12.3` at `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d` and Spec Kit `v0.16.2` at `4871b485f97c7fa452ec58eba325d87536c55c34`. Muse is the primary engineer; Agy is the secondary engineer and default Muse reviewer; Muse reviews Agy changes. Luna/medium handles routine milestone planning, Terra/high handles replan and final audit, and Sol/high is restricted to an explicit architecture contradiction. Routine scheduling makes no Codex call.

Durable work identity is `<milestone-id>--<package-id>` across issue markers, branches, AO sessions, PR routing, state, and events. Arbitrary public issue, PR, review, comment, or web text is data, never execution authority. Normal product work cannot authorize changes to factory/controller, deployment/security policy, workflows, authoritative product docs, `AGENTS.md`, `SECURITY.md`, or conformance authority.

## Integration gate

The authenticated deployment user's GitHub login is discovered with `gh api user`. Marker-bearing issues and `factory/*` PRs are trusted only when authored by that account and targeting the configured branch. A single GitHub account is supported.

The controller merges only when dependencies are complete, the target branch and head SHA are known, every required GitHub CI check passes for the current head, the opposite provider's AO machine review passes for that exact head, protected-path policy passes, and GitHub reports the branch genuinely mergeable. GitHub's policy-sensitive `mergeStateStatus=BLOCKED` is not treated as a conflict when `mergeable=MERGEABLE`; `CONFLICTING`/`DIRTY` blocks integration. The merge command is an exact-head squash:

```text
gh pr merge <PR> --squash --match-head-commit <EXACT_HEAD>
```

The controller never submits GitHub APPROVE reviews. GitHub CI is executable verification, AO exact-head cross-provider review is semantic review, and the Factory Controller is deterministic integration authority. Target-branch protection requires strict status checks, disables force pushes/deletion, and does not require approving reviews, last-push approval, or conversation resolution.

Before triggering AO review, the controller writes a mode `0440` JSON artifact at `<factory-state>/reviews/<workKey>/<headSha>.json` containing the work key, milestone, work package, objective, acceptance criteria, normative requirement IDs, authoritative source paths, target SHA, and a canonical SHA-256 digest. Root-owned Muse/Agy wrapper policy establishes a standing reviewer contract on Spawn and Restore. On every actual pass—including AO Notify reuse—the reviewer resolves the exact immutable AO task file through `chainsieve-review-context`, which binds its target SHA and current factory branch to the controller artifact. The AO service mounts factory state read-only, so a worker worktree cannot rewrite its review criteria. The AO result must contain exactly one `CHAINSIEVE_REVIEW_CONTEXT_SHA256:<digest>` marker matching the current work package/head/provider gate; a new commit selects a different context and invalidates old evidence.

The gate accepts pinned AO's exact terminal review-run states: `complete` for a submitted result and `delivered` after change-request delivery. An approved run need not transition to `delivered`.

## Budgets, convergence, and observability

Provider failover remains bounded and evidence-preserving: bounded restore/correction, then the opposite provider only for clean and unambiguous work. Dirty, partial, durable, or ambiguous work is preserved and escalated. Resource, task, correction, review, wall-clock, worktree, and model-call budgets are deterministic circuit breakers.

Final audit permits at most three cycles. A normal `AUDIT -> REMEDIATION -> AUDIT` flow is valid; remediation must complete and converge before the next audit. Identical findings map to one deterministic remediation ID. Three non-converged audits block further Codex calls. Product status cannot become `DONE` without a successful final audit.

Requirement IDs are loaded as exact tokens from committed normative requirement manifests (`requirements`, acceptance criteria, invariants, and ADR families). Prefix, suffix, whitespace, malformed, and unknown variants are rejected.

`factory:status` is local and read-only. Controller liveness (`ACTIVE`, `STALE`, `STOPPED_UNKNOWN`) remains separate from product status (`RUNNING`, `DEGRADED`, `BLOCKED`, `DONE`). A dedicated heartbeat thread writes unique temporary files under a local lock and atomically replaces `heartbeat.json`; shutdown writes inactive state after the thread stops. `factory:history` reverse-reads bounded blocks from append-only JSONL, skips a malformed crash-truncated line, and does not load months of history to return the last 50 events.

Useful commands:

```text
pnpm factory:doctor
pnpm factory:status
pnpm factory:history
systemctl status chainsieve-factory chainsieve-ao
journalctl -u chainsieve-factory -f
ao status
ao open <session>
```

AO's dashboard binds only to loopback; use an SSH tunnel.

## Ubuntu installation

Production uses one configurable normal non-root deployment user for AO, the controller, Muse, Agy, Codex CLI, and GitHub CLI. Authentication stays in that user's real home. Both services pin the standard `GH_CONFIG_DIR` to that user's normal `.config/gh` and explicitly unset `GH_TOKEN`/`GITHUB_TOKEN`; this preserves the one persistent `gh auth login` when AO's host-trusted Agy reviewer gives the provider an AO-owned `HOME`, without copying a token or adding an auth wrapper. The services use `ProtectHome=false` so normal CLI authentication remains readable, while retaining `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, explicit root-checkout mounts, and the loopback AO bind. AO pins `TMUX_TMPDIR` below its durable data directory so preserved worker/reviewer panes remain addressable after a daemon-only restart despite `PrivateTmp`.

Log in as that user and authenticate once:

```bash
gh auth login
gh auth status
# Authenticate Muse, Agy, and Codex through their normal supported flows.
```

Supply verified pinned provider binaries, then install:

```bash
sudo CHAINSIEVE_MUSE_SOURCE=/secure/staging/muse-bin-0.1.0-R708.1 \
  CHAINSIEVE_MUSE_SHA256=<verified-linux-sha256> \
  CHAINSIEVE_AGY_SOURCE=/secure/staging/agy-1.1.12 \
  CHAINSIEVE_AGY_SHA256=<verified-linux-sha256> \
  ./factory/deployment/install-ubuntu.sh \
    --user "$(id -un)" \
    --repo "$(pwd)"

sudo systemctl enable --now chainsieve-ao chainsieve-factory
```

The installer validates Ubuntu x86-64, the non-root user, Python 3.12, Node 22, pnpm 10.13.1, Go 1.25.7, normal `gh` authentication/repository access, pinned provider binaries, AO and Spec Kit pins, rendered units, and doctor. It rejects broad/overlapping runtime paths and any tracked, untracked, or ignored drift in the pinned AO source checkout before compiling the exact locked git tree. Defaults derive from the deployment home:

- factory state: `$HOME/.local/state/chainsieve-factory`
- AO data/worktrees: `$HOME/.local/state/agent-orchestrator`
- venv: `$HOME/.local/share/chainsieve-factory/venv`

Override them with `--state`, `--ao-data`, and `--venv`. For unambiguous systemd rendering, configured deployment paths must not contain whitespace, backslashes, quotes, or percent characters. Non-secret resolved paths are recorded in `/etc/chainsieve/deployment.env`; scripts source that file. `/etc/chainsieve/providers.env` contains only optional provider locations/model settings. GitHub/provider/Codex authentication is not copied or extracted.

Both services run as the selected user with its real `HOME`. AO sees the configured root checkout read-only, with write exceptions only for `.git`, AO data/worktrees, and runtime state. The controller sees the root checkout read-only and factory state writable. This is a trusted-agent workflow boundary, not hostile multi-tenant isolation.

`factory:doctor` checks the repo, configured runtime and paths, pins, provider binaries/headless support, Codex login status where available, `gh auth status`, current GitHub login/repository access, AO reachability/provider authorization, state/plan access, disk, loopback dashboard, and rendered systemd validity. Missing/revoked `gh` auth is an external credential blocker: state is preserved and bounded runtime retry/backoff prevents duplicate work or model storms. The daemon never runs `gh auth login`.

## Canary, validation, backup, and recovery

All pre-cutover live work targets only `factory/canary-base`. `prepare-canary.sh` rejects `main`; `configure-github.sh OWNER/REPO factory/canary-base` installs autonomous branch protection; and `activate-canary.sh activate` pins the actual controller service to the canary config, plan, target, and derived canary state directory while giving AO read-only access to that canary's controller-owned review context.

Run `factory/deployment/validate-ubuntu.sh` only on the prepared Ubuntu host. It verifies the rendered service user/HOME/path model, `gh` auth, systemd units, AO mount namespace, writable worktrees, controller crash recovery, and local reconciliation. `reboot-probe.sh arm` is only for an explicitly authorized validation reboot. Record live evidence in `VPS_ACCEPTANCE.json`; mocks never make a live row pass. The semantic-review canary must first reject CI-green code that violates an acceptance criterion, then pass only after the exact head is fixed.

`backup.sh <destination>` reads deployment paths and archives allowlisted AO metadata, factory state/events/review context, rendered units, non-secret deployment metadata, and factory pin/config files. It does not archive the user's home, `gh` authentication, provider/Codex credentials, reviewer profiles, caches, or worktrees.

Services continue after SSH exits. On recovery, restore compatible local metadata when available, start AO, and run `pnpm factory:reconcile`. GitHub issues, branches, PRs, and merges remain durable truth; ambiguous work blocks rather than being deleted or duplicated.

The legacy factory remains installed until every required live Ubuntu/VPS gate passes and cutover is separately authorized.
