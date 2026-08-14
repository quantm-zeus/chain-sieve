#!/usr/bin/env bash
set -euo pipefail

repo="${1:?usage: configure-github.sh OWNER/REPO}"
branch="${2:-main}"
[[ "$branch" == main || "$branch" == factory/canary-* ]] || { echo "refusing unsupported protected branch: $branch" >&2; exit 1; }
check_context="Tier 3 · pre-main"
if [[ "$branch" == factory/canary-* ]]; then
  check_context="Factory Canary · harmless validation"
fi

# This script is intentionally explicit and idempotent. It does not use --admin
# merge bypasses. Supply a repository-administration credential only while
# applying policy, never to the running factory or workers.
gh api --method PUT "repos/$repo/branches/$branch/protection" \
  -H 'Accept: application/vnd.github+json' \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["$check_context"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

echo "Protected $branch configured. GitHub CI is executable verification; AO exact-head review is semantic authority; the controller merges only after its deterministic gates pass."
