# ADR-FACTORY-002: OSS-backed autonomous factory control plane

Status: Accepted
Date: 2026-08-13

## Context

The prototype factory implements task acquisition, leases, fencing, worktree management, recovery, recursive maintenance,
and a merge queue in ChainSieve-specific TypeScript. It is costly to reason about and has produced recursive maintenance
lineages. The owner authorized its replacement while retaining the v6.0 PRD as product authority.

Current upstream inspection found:

- Agent Orchestrator `v0.12.3` (commit `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`) has native Muse and Agy workers,
  native Muse and Agy reviewers, tmux/process runtimes, worktree workspaces, GitHub tracker/SCM, durable SQLite session
  metadata, restore, activity states including Muse waiting-input detection, CI/review/conflict reactions, a loopback CLI,
  dashboard, and notifier plugins.
- AO's `auto-merge` reaction is an intent/notification flag, not an autonomous merge implementation. AO exposes a merge
  action but does not enforce ChainSieve's exact reviewed-head/protected-path/dependency policy.
- Spec Kit `v0.16.2` (commit `4871b485f97c7fa452ec58eba325d87536c55c34`) provides constitution/spec/plan/tasks/
  analyze and `/speckit.converge`. Converge appends gaps to tasks; it does not execute workers itself.

## Decision

Use Spec Kit only for planning and convergence artifacts. Use AO for sessions, isolated worktrees, runtime persistence,
activity, PR/CI feedback, and machine review. Use GitHub Issues as the durable work queue and PR/Actions as integration
truth. Retain a small Python-standard-library controller for dependency readiness, budgets, trusted-source filtering,
resource gates, reconciliation, current-head review/CI enforcement, protected paths, and serialized merge.

Do not fork AO. Use its native Muse/Agy adapters. Select AO `v0.12.3` instead of same-day `v0.12.4` so production does not
adopt an unsoaked release. Pin Spec Kit `v0.16.2`. Upgrades happen only between milestones after smoke/chaos validation.
The historical ComposioHQ URL currently redirects to the canonical Untrivial-ai repository, which GitHub reports is not a fork.
The exact pin has native Muse waiting-input detection but no native Agy waiting-input detector; ChainSieve therefore uses a
bounded meaningful-progress timeout for Agy and records this as a live-acceptance requirement rather than claiming native support.

Run AO and the controller as separate systemd services under one configurable normal non-root deployment user. Muse, Agy,
Codex CLI, and GitHub CLI use that user's normal supported authentication in its real home. GitHub authentication is a single
interactive `gh auth login`; the daemons neither extract tokens nor implement token refresh, App credentials, askpass brokers,
or a second actor. The authenticated login returned by `gh api user` is the trusted author for factory issues and PRs.

Protected target branches require strict status checks, disable force push/deletion, and require neither GitHub approval nor
conversation resolution. The controller never calls GitHub APPROVE. It merges only after dependencies, exact-head CI,
opposite-provider AO exact-head review, protected paths, target branch, known head, and actual mergeability pass. GitHub
`mergeStateStatus=BLOCKED` is policy data, not a conflict when the explicit mergeability result is `MERGEABLE`.

Normal product models cannot authorize immutable control-plane, security, workflow, authoritative-spec, or verification
paths. Elevated product surfaces require HIGH/CRITICAL risk and an exact deterministic authorization. Durable work identity
is `<milestone-id>--<package-id>`, not the milestone-local package ID.

Run the controller from a dedicated Python 3.12 virtual environment with a committed dependency lock. Route scarce Codex calls
by role: Luna/medium for routine milestone planning, Terra/high for replan/final audit, and a one-call Sol/high emergency tier.
Routine lifecycle decisions never invoke Codex. Live validation uses `factory/canary-base`, never `main`.

Provider failover uses AO's native safe teardown semantics. After bounded restore, the controller respawns on the opposite
provider only when it proves there is no PR, remote branch, dirty worktree, durable commit, or ambiguous session. AO removes
clean worktrees and preserves dirty ones. Dual-provider exhaustion, repeated material conflicts, and exhausted convergence
decomposition receive one Terra/high replan. Sol/high is limited to a successfully classified exceptional architecture
contradiction and is never an availability fallback. A local heartbeat separates controller liveness from product state.

AO v0.12.3 reviewer configuration selects a harness but does not accept dynamic per-work-package criteria. Without forking
AO, the controller therefore writes an immutable exact-head review-context artifact outside worker worktrees. Thin Muse/Agy
binary wrappers read it from the read-only mount and embed its contents in AO's native review invocation. It contains the workKey, milestone, objective, acceptance,
normative IDs, authority paths, and target SHA; the AO service can read but not write the factory-state mount.

Final audit is bounded to three cycles so one non-converged audit can create remediation and a later audit can establish
convergence. Identical findings use a deterministic remediation ID; exhaustion blocks further Codex calls. Normative IDs
are exact tokens parsed from committed manifests. Heartbeats use locked unique atomic replacements, and JSONL history uses a
bounded reverse reader.

The AO systemd write boundary is the root checkout `.git` administrative directory, `$AO_DATA_DIR/worktrees`, and AO
runtime/state. The configured root source and controller-owned review state are read-only in AO's mount namespace. The
controller's explicit runtime write path is its configured state, while `ProtectHome=false` intentionally leaves the trusted
deployment user's home available because normal CLI authentication lives there; other compatible hardening remains enabled. This is workflow
containment for trusted coding agents, not a hostile-agent or multi-tenant security boundary.

## Consequences

- Legacy factory lifecycle machinery can be removed after the replacement path passes external AO/GitHub/VPS validation.
- AO's daemon remains localhost-only. Remote access uses SSH/Tailscale, not a public dashboard.
- The macOS implementation environment cannot validate systemd, VPS reboot, or Linux tmux/cgroup semantics; Ubuntu chaos
  scripts must pass before production cutover is claimed.
- AO v0.12.3's fake-agent lifecycle test is not portable to Debian's login-shell PATH behavior. The installer runs the
  production-relevant upstream package suite, including session manager, tmux, Muse/Agy adapters and reviewers, rather
  than concealing this known unrelated harness failure.
- Agy's preferred model is pinned through the deployment shim because AO `v0.12.3` has project-level rather than
  per-spawn agent configuration. The shim adds the model only when AO did not already supply one.
