#!/usr/bin/env bash
set -euo pipefail

repo="${CHAINSIEVE_REPO_PATH:-/srv/chainsieve/repo}"
report="${CHAINSIEVE_VALIDATION_REPORT:-/var/lib/chainsieve/factory/ubuntu-validation.json}"
factory_python="${CHAINSIEVE_FACTORY_PYTHON:-/srv/chainsieve/.venv/bin/python}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root on the Ubuntu factory host" >&2
  exit 1
fi

cd "$repo"
test "$(id -u chainsieve-worker)" -ne 0
test "$(id -u chainsieve-controller)" -ne 0
test -x "$factory_python"
test "$($factory_python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" = 3.12
CHAINSIEVE_FACTORY_EXPECTED_PYTHON="$factory_python" "$factory_python" -m factory doctor --json >/tmp/chainsieve-doctor.json
systemctl is-enabled --quiet chainsieve-ao.service chainsieve-factory.service
systemctl is-active --quiet chainsieve-ao.service chainsieve-factory.service
test "$(systemctl show chainsieve-ao.service -p KillMode --value)" = process
test "$(systemctl show chainsieve-factory.service -p Restart --value)" = on-failure
systemctl show chainsieve-factory.service -p ExecStart --value | grep -F '/srv/chainsieve/.venv/bin/python -m factory run' >/dev/null
test "$(stat -c '%a:%U' /etc/chainsieve/ao.env)" = "600:chainsieve-worker"
test "$(stat -c '%a:%U' /etc/chainsieve/factory.env)" = "600:chainsieve-controller"
runuser -u chainsieve-worker -- test ! -r /etc/chainsieve/factory.env
runuser -u chainsieve-controller -- test ! -r /etc/chainsieve/ao.env
ao_pid="$(systemctl show chainsieve-ao.service -p MainPID --value)"
controller_pid="$(systemctl show chainsieve-factory.service -p MainPID --value)"
"$factory_python" factory/deployment/credential-probe.py "$ao_pid" \
  --require GITHUB_TOKEN --forbid GH_TOKEN --forbid OPENAI_API_KEY >/tmp/chainsieve-ao-credential-presence.json
"$factory_python" factory/deployment/credential-probe.py "$controller_pid" \
  --require GH_TOKEN --forbid GITHUB_TOKEN >/tmp/chainsieve-controller-credential-presence.json

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
for attempt in $(seq 1 45); do
  "$factory_python" -m factory status --json >/tmp/chainsieve-post-crash-status.json
  if "$factory_python" - /tmp/chainsieve-post-crash-status.json <<'PY'
import json
import sys

status = json.load(open(sys.argv[1], encoding="utf-8"))
raise SystemExit(0 if any(event.get("type") == "RECONCILED" for event in status.get("recentEvents", [])) else 1)
PY
  then
    break
  fi
  sleep 1
done
"$factory_python" - /tmp/chainsieve-post-crash-status.json <<'PY'
import json
import sys

status = json.load(open(sys.argv[1], encoding="utf-8"))
assert any(event.get("type") == "RECONCILED" for event in status.get("recentEvents", []))
PY

install -d -o chainsieve-controller -g chainsieve -m 0750 "$(dirname "$report")"
"$factory_python" - "$report" "$repo" "$before" "$after" <<'PY'
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
        "pythonRuntime": "PASS",
        "credentialFileOwnership": "PASS",
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
