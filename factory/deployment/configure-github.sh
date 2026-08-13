#!/usr/bin/env bash
set -euo pipefail

repo="${1:?usage: configure-github.sh OWNER/REPO}"

# This script is intentionally explicit and idempotent. It does not use --admin
# merge bypasses. Supply a repository-administration credential only while
# applying policy, never to the running factory or workers.
gh api --method PUT "repos/$repo/branches/main/protection" \
  -H 'Accept: application/vnd.github+json' \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Tier 3 · pre-main"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON

echo "Protected main configured. Configure the worker token to write only factory/* branches and PRs; configure the integration token with narrowly scoped pull-request merge permission."
