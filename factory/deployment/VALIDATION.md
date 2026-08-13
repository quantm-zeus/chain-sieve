# External production validation record

The controller unit/simulation suite is necessary but not sufficient for production cutover. Capture the date, host image, exact lock file, repository commit, issue/PR/session IDs, and evidence paths for every live run.

Required live rows: Muse autonomy; Agy autonomy; two-worker parallelism; dependency integration; CI correction; cross review and correction; stale-review rejection; convergence remediation; restart duplicate prevention; SSH disconnect; controller crash; AO daemon crash and tmux survival; host reboot; worker crash; GitHub outage/backoff; permission-wait remediation; disk pressure; untrusted GitHub input; credential separation; runaway breaker; and legacy-free production process inspection.

Do not change a row to PASS merely because an implementation or script exists. Legacy deletion and production cutover require all applicable rows to have evidence from the pinned Ubuntu system.

## 2026-08-13 pre-cutover hardening evidence

- PASS — direct `git ls-remote --tags` provenance proof for AO and Spec Kit; canonical repository redirect/fork state, tag objects, commits, Git trees, install mechanisms, release digest, provider integration source, and Agy waiting-input limitation are recorded in `UPSTREAM_PROVENANCE.md`.
- PASS — 38 deterministic Python tests after hardening pass both locally and in a Linux/amd64 Python 3.12 container with the declared Git prerequisite. They cover role-scoped Codex routing/counters/budgets and no-Codex routine/recovery cycles; meaningful-progress/stuck classification; required cross-provider exact-head reviews; untrusted/wrong-base PR filtering; process environment presence/absence; resource spawn suppression; capped GitHub backoff/recovery; deployment/canary/acceptance invariants; and the original reconciliation/security suite.
- PASS — Python 3.12 production contract, empty dependency lock, dedicated venv path, absolute systemd interpreter, unbuffered logging, explicit working directory/PATH, service-user-readable separated environment files, and automatic post-reboot probe are implemented and syntax-checked.
- PASS — safe canary configuration, AO project config, milestone, GitHub check, and target-branch guard are committed for `factory/canary-base`; no validation worker targets `main`.
- NOT RUN — all live provider/AO/GitHub and Ubuntu VPS gates remain as recorded in `VPS_ACCEPTANCE.json` because this audit host is macOS and no explicit target VPS was configured or reached.

## 2026-08-13 migration-worktree evidence before hardening

- PASS — controller compilation, JSON plan/schema parsing, shell syntax, and whitespace checks.
- PASS — 25 deterministic Python tests covering DAG/reconciliation, duplicate blocking, exact-head review staleness, CI wait/failure routing, review correction, provider alternation, time/resource/runaway gates, read-only status, environment separation, trusted issue filtering, rolling-plan selection/artifacts, production-entrypoint isolation, and terminated-session preservation.
- PASS — existing repository lint, TypeScript/Svelte typecheck (zero diagnostics), and 80 existing unit tests in an isolated Node 22 + pnpm 10.13.1 container.
- PASS — pinned AO v0.12.3 production-relevant Go suite under Linux/Go 1.25.7 with tmux, followed by the exact release-metadata build; binary reported `0.12.3 commit b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`, and daemon/session CLI flags used by the controller were present.
- PASS — pinned Spec Kit commit `4871b485f97c7fa452ec58eba325d87536c55c34` installed through uv in Linux and reported `specify 0.16.2`.
- PASS — live Codex CLI milestone-plan and final-audit structured-output smokes with `gpt-5.6-terra`, high reasoning, read-only sandbox, approval `never`, ephemeral sessions, and ignored user config.
- PASS — live direct Muse headless no-write/no-shell smoke and direct Agy headless `gemini-3.6-flash-high` model smoke. These prove only provider CLI authentication/configuration on the migration host, not AO lifecycle behavior.
- KNOWN UPSTREAM HARNESS FAILURE — AO's unrelated fake-agent lifecycle test does not preserve its injected shim PATH through Debian `sh -lc`; this is documented and excluded from the installer suite. It is not a live-provider validation.
- NOT RUN — all live AO/GitHub provider lifecycle and Ubuntu/systemd/SSH/reboot/outage scenarios listed above. This macOS host lacks AO, Spec Kit, Node, pnpm, tmux, and systemd locally; direct provider smokes and GitHub authentication are insufficient.
