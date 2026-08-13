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
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
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

echo "Protected $branch configured. Worker and integration GitHub App identities must be distinct; only the controller identity may approve and merge after internal gates pass."
