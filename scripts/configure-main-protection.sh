#!/usr/bin/env bash

set -euo pipefail

repository="${1:-sawfwair/relay-mere-run}"
branch="${2:-main}"
confirmation="${3:-}"

if [[ "$confirmation" != "--apply" ]]; then
  echo "Usage: $0 [owner/repository] [branch] --apply" >&2
  echo "Configures required CI checks and pull-request protection through GitHub." >&2
  exit 2
fi

gh api \
  --method PUT \
  "repos/${repository}/branches/${branch}/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Worker and web",
      "Node Rust (macos-latest)",
      "Node Rust (ubuntu-22.04)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON
