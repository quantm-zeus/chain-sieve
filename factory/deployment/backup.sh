#!/usr/bin/env bash
set -euo pipefail

destination="$(readlink -m "${1:?usage: backup.sh DESTINATION_DIRECTORY}")"
deployment_config="${CHAINSIEVE_DEPLOYMENT_CONFIG:-/etc/chainsieve/deployment.env}"
[[ -r "$deployment_config" ]] || { echo "deployment configuration not found: $deployment_config" >&2; exit 1; }
. "$deployment_config"
for runtime_root in "$CHAINSIEVE_FACTORY_STATE_DIR" "$AO_DATA_DIR"; do
  case "$destination/" in
    "$runtime_root/"*) echo "backup destination must be outside runtime state: $destination" >&2; exit 1 ;;
  esac
done
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 "$destination"
archive="$destination/chainsieve-factory-$timestamp.tar.zst"
[[ ! -e "$archive" ]] || { echo "backup already exists: $archive" >&2; exit 1; }
target="$(mktemp -d "$destination/.chainsieve-factory-$timestamp.XXXXXX")"
trap 'rm -r -- "$target"' EXIT

# No provider profiles, tokens, auth files, or GitHub secret files are copied.
# AO's database/config are allowlisted; reviewer profiles and worktrees are
# reconstructed instead of archived.
install -d -m 0750 "$target/ao-metadata"
find "$AO_DATA_DIR" -maxdepth 1 -type f \
  \( -name '*.db' -o -name '*.db-shm' -o -name '*.db-wal' -o -name '*.sqlite' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' \) \
  ! -iname '*auth*' ! -iname '*token*' ! -iname '*credential*' \
  -exec cp -a '{}' "$target/ao-metadata/" \;
cp -a "$CHAINSIEVE_FACTORY_STATE_DIR" "$target/factory-state"
install -d -m 0750 "$target/service"
cp -a /etc/systemd/system/chainsieve-ao.service /etc/systemd/system/chainsieve-factory.service \
  /etc/systemd/system/chainsieve-reboot-probe.service "$target/service/"
cp -a "$deployment_config" "$target/service/deployment.env"
cp -a "$CHAINSIEVE_REPO_PATH/factory/config.json" "$CHAINSIEVE_REPO_PATH/factory/upstream-lock.json" "$target/service/"
tar --create --zstd --file "$archive" --directory "$target" .
rm -r -- "$target"
trap - EXIT
echo "$archive"
