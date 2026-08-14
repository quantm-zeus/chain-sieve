#!/usr/bin/env bash
set -euo pipefail

deployment_config="${CHAINSIEVE_DEPLOYMENT_CONFIG:-/etc/chainsieve/deployment.env}"
[[ -r "$deployment_config" ]] || { echo "deployment configuration not found: $deployment_config" >&2; exit 1; }
set -a
. "$deployment_config"
set +a
repo="$CHAINSIEVE_REPO_PATH"
state_dir="$CHAINSIEVE_FACTORY_STATE_DIR"
factory_python="$CHAINSIEVE_FACTORY_PYTHON"
deploy_user="$CHAINSIEVE_DEPLOYMENT_USER"
deploy_group="$CHAINSIEVE_DEPLOYMENT_GROUP"
user_home="$CHAINSIEVE_USER_HOME"
report="${CHAINSIEVE_VALIDATION_REPORT:-$state_dir/ubuntu-validation.json}"

[[ "$(id -u)" -eq 0 ]] || { echo "run as root on the Ubuntu factory host" >&2; exit 1; }
[[ "$(id -u "$deploy_user")" -ne 0 ]]
[[ -d "$repo/.git" && -x "$factory_python" ]]
[[ "$($factory_python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" == 3.12 ]]

factory_user=(runuser -u "$deploy_user" -- env \
  HOME="$user_home" PATH="$(dirname "$factory_python"):/opt/chainsieve/factory-bin:$(dirname "$CHAINSIEVE_GH_BIN"):$(dirname "$CHAINSIEVE_CODEX_BIN"):$(dirname "$CHAINSIEVE_MUSE_BIN"):$(dirname "$CHAINSIEVE_AGY_BIN"):/usr/local/bin:/usr/bin:/bin" \
  CHAINSIEVE_GH_BIN="$CHAINSIEVE_GH_BIN" CHAINSIEVE_MUSE_BIN="$CHAINSIEVE_MUSE_BIN" \
  CHAINSIEVE_AGY_BIN="$CHAINSIEVE_AGY_BIN" CHAINSIEVE_CODEX_BIN="$CHAINSIEVE_CODEX_BIN" \
  PYTHONPATH="$repo" CHAINSIEVE_FACTORY_EXPECTED_PYTHON="$factory_python" \
  CHAINSIEVE_FACTORY_STATE_DIR="$state_dir" CHAINSIEVE_FACTORY_PLAN="$repo/specs/factory/current-milestone.json" \
  AO_RUN_FILE=/run/chainsieve-ao/running.json AO_DATA_DIR="$AO_DATA_DIR")

"${factory_user[@]}" "$CHAINSIEVE_GH_BIN" auth status >/dev/null
github_actor="$("${factory_user[@]}" "$CHAINSIEVE_GH_BIN" api user --jq .login)"
[[ -n "$github_actor" ]]
"${factory_user[@]}" "$factory_python" -m factory doctor --json >/tmp/chainsieve-doctor.json

systemctl is-enabled --quiet chainsieve-ao.service chainsieve-factory.service
systemctl is-active --quiet chainsieve-ao.service chainsieve-factory.service
[[ "$(systemctl show chainsieve-ao.service -p User --value)" == "$deploy_user" ]]
[[ "$(systemctl show chainsieve-factory.service -p User --value)" == "$deploy_user" ]]
[[ "$(systemctl show chainsieve-ao.service -p KillMode --value)" == process ]]
[[ "$(systemctl show chainsieve-factory.service -p Restart --value)" == on-failure ]]
[[ "$(systemctl show chainsieve-ao.service -p ProtectHome --value)" == no ]]
[[ "$(systemctl show chainsieve-factory.service -p ProtectHome --value)" == no ]]
systemctl show chainsieve-factory.service -p ExecStart --value | grep -F "$factory_python -m factory run" >/dev/null
systemctl show chainsieve-ao.service -p Environment --value | grep -F "GH_CONFIG_DIR=$user_home/.config/gh" >/dev/null
systemctl show chainsieve-ao.service -p Environment --value | grep -F "TMUX_TMPDIR=$AO_DATA_DIR/tmux" >/dev/null
[[ -d "$AO_DATA_DIR/tmux" && -w "$AO_DATA_DIR/tmux" ]]
systemd-analyze verify \
  /etc/systemd/system/chainsieve-ao.service \
  /etc/systemd/system/chainsieve-factory.service \
  /etc/systemd/system/chainsieve-reboot-probe.service

ao_pid="$(systemctl show chainsieve-ao.service -p MainPID --value)"
[[ "$ao_pid" -gt 1 ]]
# Exercise the AO service's actual mount namespace: root source is read-only,
# while AO worktrees and the Git administrative directory remain writable.
nsenter -t "$ao_pid" -m -- runuser -u "$deploy_user" -- python3.12 - "$repo" <<'PY'
import os
import sys

repo = sys.argv[1]
for relative in ("factory/config.json", ".github/workflows/ci.yml"):
    try:
        descriptor = os.open(os.path.join(repo, relative), os.O_WRONLY)
    except OSError as error:
        if error.errno in {1, 13, 30}:
            continue
        raise
    else:
        os.close(descriptor)
        raise SystemExit(f"AO namespace unexpectedly permits root-checkout write: {relative}")
PY
nsenter -t "$ao_pid" -m -- runuser -u "$deploy_user" -- sh -c 'probe="$1/worktrees/.integrity-probe"; mkdir -p "$(dirname "$probe")"; : > "$probe"; rm "$probe"' sh "$AO_DATA_DIR"
nsenter -t "$ao_pid" -m -- runuser -u "$deploy_user" -- sh -c 'probe="$1/.git/.integrity-probe"; : > "$probe"; rm "$probe"' sh "$repo"

before="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
main_pid="$(systemctl show chainsieve-factory.service -p MainPID --value)"
[[ "$main_pid" -gt 1 ]]
kill -KILL "$main_pid"
for _ in $(seq 1 30); do
  after="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
  if systemctl is-active --quiet chainsieve-factory.service && [[ "$after" -gt "$before" ]]; then break; fi
  sleep 1
done
after="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
[[ "$after" -gt "$before" ]]
reconciled=false
for _ in $(seq 1 45); do
  "${factory_user[@]}" "$factory_python" -m factory status --json >/tmp/chainsieve-post-crash-status.json
  if "$factory_python" - /tmp/chainsieve-post-crash-status.json <<'PY'
import json
import sys
status = json.load(open(sys.argv[1], encoding="utf-8"))
raise SystemExit(0 if any(event.get("type") == "RECONCILED" for event in status.get("recentEvents", [])) else 1)
PY
  then reconciled=true; break; fi
  sleep 1
done
[[ "$reconciled" == true ]] || { echo "controller restarted but did not publish reconciliation evidence" >&2; exit 1; }

install -d -o "$deploy_user" -g "$deploy_group" -m 0750 "$(dirname "$report")"
"$factory_python" - "$report" "$repo" "$deploy_user" "$github_actor" "$before" "$after" <<'PY'
import json
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path

report, repo, user, actor, before, after = sys.argv[1:]
Path(report).write_text(json.dumps({
    "validatedAt": datetime.now(UTC).isoformat(),
    "host": platform.node(),
    "platform": platform.platform(),
    "repository": repo,
    "deploymentUser": user,
    "githubActor": actor,
    "checks": {
        "doctor": "PASS",
        "servicesEnabled": "PASS",
        "servicesActive": "PASS",
        "sameServiceUser": "PASS",
        "githubCliAuth": "PASS",
        "systemdAnalyze": "PASS",
        "homeAuthReadable": "PASS",
        "controllerCrashRestart": "PASS",
        "rootCheckoutIntegrity": "PASS",
    },
    "controllerRestarts": {"before": int(before), "after": int(after)},
    "notValidatedByThisScript": [
        "SSH disconnect with active workers",
        "host reboot with active workers",
        "AO daemon crash with active tmux workers",
        "network outage",
        "live Muse/Agy semantic PR-to-merge paths",
        "Codex-to-Muse fallback canary (run run-codex-fallback-canary.py separately)",
        "final audit remediation with live Codex",
    ],
}, indent=2) + "\n", encoding="utf-8")
PY
chown "$deploy_user:$deploy_group" "$report"
chmod 0640 "$report"
echo "Ubuntu validation evidence written to $report"
