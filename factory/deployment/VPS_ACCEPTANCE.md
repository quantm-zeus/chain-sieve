# Ubuntu VPS acceptance

Current classification: **READY_FOR_VPS_VALIDATION**. This is not approval to merge the migration branch into `main`, remove the legacy factory, or cut over production.

The audit ran on macOS. AO, Spec Kit, tmux, Node/pnpm, and systemd are not installed on this host, and no explicit target Ubuntu VPS SSH host was configured or reached. Consequently, every gate requiring a real AO/GitHub provider lifecycle or Linux/systemd/reboot boundary remains `NOT_RUN`; no local simulation was promoted to a live pass. The machine-readable record is `VPS_ACCEPTANCE.json`.

The hardening pass adds live gates for renewable GitHub App token rotation,
installation identity, root-checkout integrity, alternate-provider failover,
and Codex replan escalation. Those remain `NOT_RUN` until the target host is
exercised. Local deterministic proof is sufficient only for heartbeat liveness
classification and milestone-qualified global work identity.

## Verified locally

- Direct tag provenance: AO `v0.12.3` at `b48c98c94ca0039ad1bc42bd1b78134d3ff5773d`; Spec Kit `v0.16.2` peeled to `4871b485f97c7fa452ec58eba325d87536c55c34`.
- Exact-head review rejection, required cross-provider identity, untrusted issue/PR filtering, CI failure routing, duplicate detection, bounded GitHub retry/recovery, resource breaker behavior, role-based Codex routing, no-Codex routine cycles, explicit status states, and stuck detection.
- Python production contract: Python 3.12 only, no third-party runtime dependencies, dedicated `/srv/chainsieve/.venv`, absolute systemd `ExecStart`, unbuffered logging, fixed working directory/PATH, and interpreter/lock checks in doctor.
- Process/credential design: one AO daemon service, one controller service with a nonblocking file lock, distinct Unix users and secret files, distinct GitHub App actors, stale-dismissed required GitHub approval, and controller approval only after internal gates.
- Safe canary assets target `factory/canary-base`; production `main` is not a canary target.

## Required live run order

1. Deploy the published migration commit on the target Ubuntu VPS with separate worker/integration GitHub App credentials and verified provider binaries.
2. Run doctor, prepare/protect `factory/canary-base`, activate the guarded canary override, and start the actual `chainsieve-factory.service`; the installer already registers `chainsieve-canary`.
3. Capture the two provider lifecycles, overlap timestamps, cross-reviews, exact-head staleness, controlled CI correction, canary merges, controller restart reconciliation, and process credential-presence probes.
4. Exercise scoped GitHub failure, simulated disk threshold, worker privilege denial, SSH disconnect, unexpected controller kill, and the single armed reboot probe.
5. Replace each `NOT_RUN` only with durable IDs/logs/SHAs from that run. Any failure remains `FAIL`; do not retry the destructive reboot more than once per validation run.

Live acceptance must record work-package ID, AO session, worktree, branch, commit, PR, CI run, machine review target SHA, integration approval, and resulting canary merge for each provider. Production `main` remains untouched throughout.
