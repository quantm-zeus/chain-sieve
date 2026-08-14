#!/usr/bin/env bash
set -euo pipefail

deployment_config="${CHAINSIEVE_DEPLOYMENT_CONFIG:-/etc/chainsieve/deployment.env}"
[[ -r "$deployment_config" ]] || { echo "deployment configuration not found: $deployment_config" >&2; exit 1; }
. "$deployment_config"
repo="$CHAINSIEVE_REPO_PATH"
source_ref="${CHAINSIEVE_CANARY_SOURCE_REF:-main}"
target_ref="${CHAINSIEVE_CANARY_TARGET_REF:-factory/canary-base}"

[[ "$target_ref" == factory/canary-* ]] || { echo "refusing unsafe canary target: $target_ref" >&2; exit 1; }
[[ "$target_ref" != main ]] || { echo "canary target must never be main" >&2; exit 1; }
git -C "$repo" fetch origin "$source_ref"
source_sha="$(git -C "$repo" rev-parse "origin/$source_ref^{commit}")"
git -C "$repo" push origin "$source_sha:refs/heads/$target_ref"
remote_sha="$(git -C "$repo" ls-remote origin "refs/heads/$target_ref" | awk '{print $1}')"
test "$remote_sha" = "$source_sha"
printf 'canary target %s now points to %s\n' "$target_ref" "$remote_sha"
