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

Run AO and the controller as separate systemd services and Unix users/credential domains. AO receives the worker GitHub
credential and provider credentials. The controller receives the integration GitHub credential. Controller subprocesses
use explicit environment allowlists, so provider/Codex/notifier subprocesses never inherit the integration credential.
Worker and integration GitHub actors must be distinct. Protected target branches require a stale-dismissed, last-push approval;
the controller supplies that approval only after its CI, exact-head cross-review, protected-path, dependency, and mergeability gates.

Run the controller from a dedicated Python 3.12 virtual environment with a committed dependency lock. Route scarce Codex calls
by role: Luna/medium for routine milestone planning, Terra/high for replan/final audit, and a one-call Sol/high emergency tier.
Routine lifecycle decisions never invoke Codex. Live validation uses `factory/canary-base`, never `main`.

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
