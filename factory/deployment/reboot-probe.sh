#!/usr/bin/env bash
set -euo pipefail

repo="${CHAINSIEVE_REPO_PATH:-/srv/chainsieve/repo}"
factory_python="${CHAINSIEVE_FACTORY_PYTHON:-/srv/chainsieve/.venv/bin/python}"
state_dir="${CHAINSIEVE_FACTORY_STATE_DIR:-/var/lib/chainsieve/factory}"
cd "$repo"

case "${1:-}" in
  arm)
    if [[ "$(id -u)" -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
    install -d -o chainsieve-controller -g chainsieve -m 0750 "$state_dir"
    systemctl show chainsieve-ao.service chainsieve-factory.service \
      -p ActiveState -p SubState -p MainPID -p NRestarts \
      >"$state_dir/pre-reboot-services.txt"
    "$factory_python" -m factory status --json >"$state_dir/pre-reboot-status.json"
    "$factory_python" - "$state_dir/reboot-probe-armed" <<'PY'
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({
    "armedAt": datetime.now(UTC).isoformat(),
    "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    "pid": os.getpid(),
}, indent=2) + "\n", encoding="utf-8")
PY
    chown chainsieve-controller:chainsieve "$state_dir"/pre-reboot-* "$state_dir/reboot-probe-armed"
    chmod 0640 "$state_dir"/pre-reboot-* "$state_dir/reboot-probe-armed"
    echo "probe armed; the enabled one-shot unit will capture evidence automatically after the single authorized reboot"
    ;;
  verify)
    test -f "$state_dir/reboot-probe-armed"
    systemctl is-active --quiet chainsieve-ao.service chainsieve-factory.service
    for attempt in $(seq 1 60); do
      "$factory_python" -m factory status --json >"$state_dir/post-reboot-status.json"
      if "$factory_python" - "$state_dir" <<'PY'
import json
import sys
from datetime import datetime
from pathlib import Path

state = Path(sys.argv[1])
armed = json.loads((state / "reboot-probe-armed").read_text())
status = json.loads((state / "post-reboot-status.json").read_text())
armed_at = datetime.fromisoformat(armed["armedAt"].replace("Z", "+00:00"))
fresh = [
    event for event in status.get("recentEvents", [])
    if event.get("type") == "RECONCILED"
    and datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00")) > armed_at
]
raise SystemExit(0 if fresh else 1)
PY
      then
        break
      fi
      sleep 2
    done
    systemctl show chainsieve-ao.service chainsieve-factory.service \
      -p ActiveState -p SubState -p MainPID -p NRestarts \
      >"$state_dir/post-reboot-services.txt"
    "$factory_python" - "$state_dir" <<'PY'
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

state = Path(sys.argv[1])
armed = json.loads((state / "reboot-probe-armed").read_text())
current_boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
if current_boot == armed["bootId"]:
    raise SystemExit("reboot probe verify refused: boot ID did not change")
before = json.loads((state / "pre-reboot-status.json").read_text())
after = json.loads((state / "post-reboot-status.json").read_text())
before_packages = before.get("packages", {})
after_packages = after.get("packages", {})
duplicates = [key for key, value in after_packages.items() if "duplicate" in str(value.get("blocked_reason", "")).lower()]
armed_at = datetime.fromisoformat(armed["armedAt"].replace("Z", "+00:00"))
fresh_reconcile = [
    event for event in after.get("recentEvents", [])
    if event.get("type") == "RECONCILED"
    and datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00")) > armed_at
]
artifact_mismatches = []
for package_id, old in before_packages.items():
    new = after_packages.get(package_id, {})
    for field in ("session_id", "branch", "pr_number"):
        if old.get(field) is not None and new.get(field) != old.get(field):
            artifact_mismatches.append(f"{package_id}.{field}: {old.get(field)!r} -> {new.get(field)!r}")
result = {
    "gate": "vps_reboot",
    "status": "FAIL" if duplicates or artifact_mismatches or not fresh_reconcile else "PASS",
    "timestamp": datetime.now(UTC).isoformat(),
    "evidence": [
        f"boot ID changed from {armed['bootId']} to {current_boot}",
        "chainsieve-ao.service and chainsieve-factory.service active",
        f"pre packages: {sorted(before_packages)}",
        f"post packages: {sorted(after_packages)}",
        f"duplicate blockers: {duplicates}",
        f"artifact mismatches: {artifact_mismatches}",
        f"fresh reconcile events: {len(fresh_reconcile)}",
    ],
}
(state / "post-reboot-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
if duplicates or artifact_mismatches or not fresh_reconcile:
    raise SystemExit("post-reboot reconciliation evidence failed")
PY
    chown chainsieve-controller:chainsieve "$state_dir"/post-reboot-*
    chmod 0640 "$state_dir"/post-reboot-*
    rm "$state_dir/reboot-probe-armed"
    echo "post-reboot evidence captured automatically; no duplicate blocker was observed"
    ;;
  *)
    echo "usage: $0 arm|verify" >&2
    exit 2
    ;;
esac
