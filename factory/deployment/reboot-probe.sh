#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  arm)
    if [[ "$(id -u)" -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
    install -d -o chainsieve-controller -g chainsieve -m 0750 /var/lib/chainsieve/factory
    systemctl show chainsieve-ao.service chainsieve-factory.service \
      -p ActiveState -p SubState -p MainPID -p NRestarts \
      >/var/lib/chainsieve/factory/pre-reboot-services.txt
    python3 -m factory status --json >/var/lib/chainsieve/factory/pre-reboot-status.json
    touch /var/lib/chainsieve/factory/reboot-probe-armed
    echo "probe armed; reboot separately during an active validation work package"
    ;;
  verify)
    test -f /var/lib/chainsieve/factory/reboot-probe-armed
    systemctl is-active --quiet chainsieve-ao.service chainsieve-factory.service
    python3 -m factory reconcile >/var/lib/chainsieve/factory/post-reboot-reconcile.json
    python3 -m factory status --json >/var/lib/chainsieve/factory/post-reboot-status.json
    rm /var/lib/chainsieve/factory/reboot-probe-armed
    echo "post-reboot evidence captured; compare pre/post status and verify no duplicate session, branch, or PR"
    ;;
  *)
    echo "usage: $0 arm|verify" >&2
    exit 2
    ;;
esac
