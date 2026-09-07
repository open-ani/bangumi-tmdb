#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:-}" = open-ani/bangumi-tmdb
test "${GITHUB_REF:-}" = refs/heads/main
case "${GITHUB_EVENT_NAME:-}" in schedule|workflow_dispatch) ;; *) exit 1 ;; esac
test "$(gh api user --jq .login)" = openanibot

git_remote() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
base="$UPDATE_BASE_SHA"

# Retry from fresh main, recomputing proposals; never rebase stale mapping decisions or force-push.
for attempt in 1 2 3; do
  pnpm cli guard "$base"
  git_remote fetch origin main
  remote=$(git rev-parse origin/main)
  if test "$remote" != "$base"; then
    # Only our allow-listed generated changes exist here: guard above rejects other edits.
    git restore --source=HEAD --staged --worktree -- data state sources
    git clean -f -- data state sources
    git reset --hard "$remote"
    base="$remote"
    pnpm install --frozen-lockfile
    pnpm check && pnpm test && pnpm validate
    # Codex must never inherit the GitHub token during a recomputation.
    env -u GH_TOKEN pnpm run update
  fi
  pnpm cli guard "$base"
  pnpm cli verify
  git add -- data state sources
  if git diff --cached --quiet; then echo 'No changes'; exit 0; fi
  git -c user.name=openanibot -c user.email=openanibot@users.noreply.github.com \
    commit -m 'data: update and audit Bangumi to TMDB mappings'
  if git_remote push origin HEAD:main; then exit 0; fi
  # A racing human merge causes a non-fast-forward rejection. Preserve the patch only
  # long enough for the next guard, then recompute on the new remote head.
  git reset --soft "$base"
done
echo '::error::main kept changing; no force push attempted. Retry the workflow.'
exit 1
