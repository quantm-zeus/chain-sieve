#!/usr/bin/env bash
set -euo pipefail

repo="${CHAINSIEVE_REPO_PATH:-/srv/chainsieve/repo}"
override_dir="/etc/systemd/system/chainsieve-factory.service.d"
override="$override_dir/10-canary-validation.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root on the validation host" >&2
  exit 1
fi

case "${1:-}" in
  activate)
    systemctl is-active --quiet chainsieve-factory.service && {
      echo "stop chainsieve-factory.service before changing its validation target" >&2
      exit 1
    }
    test -f "$repo/factory/deployment/canary-config.json"
    test -f "$repo/factory/deployment/canary-milestone.json"
    install -d -o root -g root -m 0755 "$override_dir"
    temporary="$(mktemp "$override_dir/.10-canary-validation.XXXXXX")"
    trap 'rm -f "$temporary"' EXIT
    printf '%s\n' \
      '[Service]' \
      'Environment=CHAINSIEVE_FACTORY_CONFIG=/srv/chainsieve/repo/factory/deployment/canary-config.json' \
      'Environment=CHAINSIEVE_FACTORY_PLAN=/srv/chainsieve/repo/factory/deployment/canary-milestone.json' \
      'Environment=CHAINSIEVE_INTEGRATION_BRANCH=factory/canary-base' \
      >"$temporary"
    chmod 0644 "$temporary"
    mv "$temporary" "$override"
    trap - EXIT
    systemctl daemon-reload
    systemctl show chainsieve-factory.service -p Environment --value | grep -F 'CHAINSIEVE_INTEGRATION_BRANCH=factory/canary-base' >/dev/null
    echo "actual chainsieve-factory.service is pinned to the isolated canary target; start it only after the canary branch and AO project are prepared"
    ;;
  deactivate)
    systemctl is-active --quiet chainsieve-factory.service && {
      echo "stop chainsieve-factory.service before leaving canary mode" >&2
      exit 1
    }
    if [[ -e "$override" ]]; then
      rm "$override"
    fi
    systemctl daemon-reload
    echo "canary override removed; do not start production until every required VPS gate passes and cutover is separately authorized"
    ;;
  *)
    echo "usage: $0 activate|deactivate" >&2
    exit 2
    ;;
esac
