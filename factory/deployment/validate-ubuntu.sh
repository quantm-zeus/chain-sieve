#!/usr/bin/env bash
set -euo pipefail

repo="${CHAINSIEVE_REPO_PATH:-/srv/chainsieve/repo}"
report="${CHAINSIEVE_VALIDATION_REPORT:-/var/lib/chainsieve/factory/ubuntu-validation.json}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root on the Ubuntu factory host" >&2
  exit 1
fi

python3 -m factory doctor --json >/tmp/chainsieve-doctor.json
systemctl is-enabled --quiet chainsieve-ao.service chainsieve-factory.service
systemctl is-active --quiet chainsieve-ao.service chainsieve-factory.service
test "$(systemctl show chainsieve-ao.service -p KillMode --value)" = process
test "$(systemctl show chainsieve-factory.service -p Restart --value)" = on-failure

before="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
main_pid="$(systemctl show chainsieve-factory.service -p MainPID --value)"
test "$main_pid" -gt 1
kill -KILL "$main_pid"

for attempt in $(seq 1 30); do
  after="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
  if systemctl is-active --quiet chainsieve-factory.service && [[ "$after" -gt "$before" ]]; then
    break
  fi
  sleep 1
done
after="$(systemctl show chainsieve-factory.service -p NRestarts --value)"
test "$after" -gt "$before"
python3 -m factory reconcile >/tmp/chainsieve-reconcile.json

install -d -o chainsieve-controller -g chainsieve -m 0750 "$(dirname "$report")"
python3 - "$report" "$repo" "$before" "$after" <<'PY'
import json
import platform
import sys
from datetime import UTC, datetime
from pathlib import Path

report, repo, before, after = sys.argv[1:]
Path(report).write_text(json.dumps({
    "validatedAt": datetime.now(UTC).isoformat(),
    "host": platform.node(),
    "platform": platform.platform(),
    "repository": repo,
    "checks": {
        "doctor": "PASS",
        "servicesEnabled": "PASS",
        "servicesActive": "PASS",
        "aoKillMode": "PASS",
        "controllerCrashRestart": "PASS",
        "postCrashReconcile": "PASS",
    },
    "controllerRestarts": {"before": int(before), "after": int(after)},
    "notValidatedByThisScript": [
        "SSH disconnect with active workers",
        "host reboot with active workers",
        "AO daemon crash with active tmux workers",
        "network outage",
        "live Muse/Agy PR-to-merge paths",
    ],
}, indent=2) + "\n", encoding="utf-8")
PY
chown chainsieve-controller:chainsieve "$report"
chmod 0640 "$report"
echo "Ubuntu validation evidence written to $report"
