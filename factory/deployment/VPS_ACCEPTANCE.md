# Ubuntu VPS acceptance

Current classification: **READY_FOR_VPS_INSTALL**. This means the source-complete replacement and deployment artifacts may be merged and installed for live validation; it is not evidence to remove the legacy factory or cut over production.

The deployment topology is one normal non-root user running AO, the Factory Controller, Muse, Agy, Codex CLI, and GitHub CLI. The user authenticates once with `gh auth login`; services read the normal persistent login through the real `HOME` and standard `GH_CONFIG_DIR`, with token environment overrides removed. Resolved repo/state/AO/venv paths are generated at install time.

Local deterministic validation covers exact-head CI/review/merge logic, policy `BLOCKED` versus real conflict, no GitHub approval call, same-account operation, protected paths, heartbeat concurrency/liveness, audit-remediation re-audit and circuit breaking, exact normative IDs, controller-owned semantic context, bounded event history, failover, duplicate prevention, and canary guards. It does not prove live VPS behavior.

Required live order:

1. As the target user, install and authenticate `gh`, Muse, Agy, and Codex, and configure the desired default model in each provider CLI.
2. Install with `sudo ./factory/deployment/install-ubuntu.sh --user "$(id -un)" --repo "$(pwd)"`; the installer resolves those CLIs from the deployment user's login environment.
3. Prepare and protect `factory/canary-base`, activate canary mode, then enable/start the two services.
4. Run `validate-ubuntu.sh`, `run-codex-fallback-canary.py`, provider/parallel/CI/failover canaries, and the semantic review canary.
5. Exercise SSH disconnect, controlled controller/AO crashes, scoped network/auth blocking, resource breaker, and one explicitly authorized reboot probe.
6. Exercise a live `NOT_CONVERGED -> remediation -> CONVERGED` final-audit cycle.
7. Update `VPS_ACCEPTANCE.json` only from durable live evidence.

All live-only gates—including `github_cli_auth`, provider execution, semantic review effectiveness, systemd, SSH disconnect, crash/reboot, failover, and final-audit remediation—remain `NOT_RUN` until that evidence exists.
