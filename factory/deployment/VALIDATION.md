# External production validation record

Deterministic tests are necessary but do not prove a live provider, GitHub, systemd, SSH-disconnect, crash, or reboot path. For every VPS gate, capture the date, Ubuntu image, repository SHA, upstream lock, deployment user and configured paths, workKey, AO session/worktree, branch/head, PR, CI run, AO review target SHA/verdict, merge SHA, and relevant journal/evidence paths.

Required live scenarios include Muse and Agy autonomy, parallel dependency work, CI correction, exact-head cross-provider review, intentional semantic-review rejection and correction, duplicate prevention, controller/AO crash, SSH disconnect, host reboot, GitHub CLI authentication/revocation, network backoff, disk/resource breaker, clean alternate-provider failover, root-checkout integrity, bounded Codex replan, and final-audit remediation/re-audit.

Use only `factory/canary-base`. Never target `main`, delete the legacy factory, or claim production cutover during validation. `PASS` requires durable evidence from the actual target; deterministic mocks leave live rows `NOT_RUN`.

The pre-VPS pass deterministically verifies the one-user/path templates, normal `gh` model, exact-head merge gates, merge-state deadlock regression, heartbeat concurrency, exact requirement IDs, immutable semantic context, bounded final-audit cycles, bounded event tail, failover, global work identity, and public-input/control-plane policy. Rendered units also pass `systemd-analyze verify` in an amd64 Debian Linux container; that is syntax/static validation, not a live service result. Systemd runtime, provider, SSH, reboot, and semantic-effectiveness rows remain `NOT_RUN` until executed on Ubuntu.
