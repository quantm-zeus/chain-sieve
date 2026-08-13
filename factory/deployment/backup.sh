#!/usr/bin/env bash
set -euo pipefail

destination="${1:?usage: backup.sh DESTINATION_DIRECTORY}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$destination/chainsieve-factory-$timestamp"
install -d -m 0750 "$target"

# No provider profiles, tokens, auth files, or GitHub secret files are copied.
# AO's database/config are allowlisted; reviewer profiles and worktrees are
# reconstructed instead of archived.
install -d -m 0750 "$target/ao-metadata"
find /var/lib/chainsieve/ao -maxdepth 1 -type f \
  \( -name '*.db' -o -name '*.db-shm' -o -name '*.db-wal' -o -name '*.sqlite' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' \) \
  ! -iname '*auth*' ! -iname '*token*' ! -iname '*credential*' \
  -exec cp -a '{}' "$target/ao-metadata/" \;
cp -a /var/lib/chainsieve/factory "$target/factory-state"
install -d -m 0750 "$target/service"
cp -a /etc/systemd/system/chainsieve-ao.service /etc/systemd/system/chainsieve-factory.service "$target/service/"
cp -a /srv/chainsieve/repo/factory/config.json /srv/chainsieve/repo/factory/upstream-lock.json "$target/service/"
tar --create --zstd --file "$target.tar.zst" --directory "$destination" "$(basename "$target")"
rm -r "$target"
echo "$target.tar.zst"
