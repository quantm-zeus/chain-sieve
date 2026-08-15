#!/usr/bin/env bash
set -euo pipefail

deployment_config="${CHAINSIEVE_DEPLOYMENT_CONFIG:-/etc/chainsieve/deployment.env}"
[[ -r "$deployment_config" ]] || { echo "deployment configuration not found: $deployment_config" >&2; exit 1; }
. "$deployment_config"
repo="$CHAINSIEVE_REPO_PATH"
canary_state="${CHAINSIEVE_FACTORY_STATE_DIR}-canary"
repo_unit="${repo//\\/\\\\}"
repo_unit="${repo_unit//\"/\\\"}"
repo_unit="${repo_unit//%/%%}"
canary_state_unit="${canary_state//\\/\\\\}"
canary_state_unit="${canary_state_unit//\"/\\\"}"
canary_state_unit="${canary_state_unit//%/%%}"
factory_override_dir="/etc/systemd/system/chainsieve-factory.service.d"
factory_override="$factory_override_dir/10-canary-validation.conf"
ao_override_dir="/etc/systemd/system/chainsieve-ao.service.d"
ao_override="$ao_override_dir/10-canary-validation.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root on the validation host" >&2
  exit 1
fi

case "${1:-}" in
  activate)
    for service in chainsieve-factory.service chainsieve-ao.service; do
      systemctl is-active --quiet "$service" && {
        echo "stop $service before changing its validation target" >&2
        exit 1
      }
    done
    test -f "$repo/factory/deployment/canary-config.json"
    test -f "$repo/factory/deployment/canary-milestone.json"
    install -d -o "$CHAINSIEVE_DEPLOYMENT_USER" -g "$CHAINSIEVE_DEPLOYMENT_GROUP" -m 0750 "$canary_state"
    install -d -o root -g root -m 0755 "$factory_override_dir" "$ao_override_dir"
    factory_temporary="$(mktemp "$factory_override_dir/.10-canary-validation.XXXXXX")"
    ao_temporary="$(mktemp "$ao_override_dir/.10-canary-validation.XXXXXX")"
    trap 'rm -f "$factory_temporary" "$ao_temporary"' EXIT
    printf '%s\n' \
      '[Service]' \
      "Environment=\"CHAINSIEVE_FACTORY_CONFIG=$repo_unit/factory/deployment/canary-config.json\"" \
      "Environment=\"CHAINSIEVE_FACTORY_PLAN=$repo_unit/factory/deployment/canary-milestone.json\"" \
      "Environment=\"CHAINSIEVE_FACTORY_STATE_DIR=$canary_state_unit\"" \
      'Environment="CHAINSIEVE_INTEGRATION_BRANCH=factory/canary-base"' \
      "ReadWritePaths=$canary_state_unit" \
      >"$factory_temporary"
    printf '%s\n' \
      '[Service]' \
      "Environment=\"CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR=$canary_state_unit/reviews\"" \
      "Environment=\"CHAINSIEVE_FACTORY_STATE_DIR=$canary_state_unit\"" \
      "ReadOnlyPaths=$canary_state_unit" \
      >"$ao_temporary"
    chmod 0644 "$factory_temporary" "$ao_temporary"
    mv "$factory_temporary" "$factory_override"
    mv "$ao_temporary" "$ao_override"
    trap - EXIT
    systemctl daemon-reload
    systemctl show chainsieve-factory.service -p Environment --value | grep -F 'CHAINSIEVE_INTEGRATION_BRANCH=factory/canary-base' >/dev/null
    systemctl show chainsieve-ao.service -p Environment --value | grep -F "CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR=$canary_state/reviews" >/dev/null
    echo "actual chainsieve-factory.service is pinned to the isolated canary target; start it only after the canary branch and AO project are prepared"
    ;;
  deactivate)
    for service in chainsieve-factory.service chainsieve-ao.service; do
      systemctl is-active --quiet "$service" && {
        echo "stop $service before leaving canary mode" >&2
        exit 1
      }
    done
    [[ ! -e "$factory_override" ]] || rm "$factory_override"
    [[ ! -e "$ao_override" ]] || rm "$ao_override"
    systemctl daemon-reload
    echo "canary override removed; do not start production until every required VPS gate passes and cutover is separately authorized"
    ;;
  *)
    echo "usage: $0 activate|deactivate" >&2
    exit 2
    ;;
esac
