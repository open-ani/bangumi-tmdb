#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:-}" = open-ani/bangumi-tmdb
test "${GITHUB_REF:-}" = refs/heads/main
case "${GITHUB_EVENT_NAME:-}" in schedule|workflow_dispatch) ;; *) exit 1 ;; esac
test "$(gh api user --jq .login)" = openanibot

git_remote() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
# The runner user's signing key must not sign the bot's commits.
git_bot() { git -c user.name=openanibot -c user.email=openanibot@users.noreply.github.com -c commit.gpgsign=false "$@"; }
prepare() {
  pnpm install --frozen-lockfile
  pnpm check && pnpm test && pnpm validate
}
# main moved under us. Carry the generated changes onto the new head when they apply cleanly and the
# merged dataset still validates (a code-only or unrelated commit), regenerating the README block there.
carry_over() {
  git checkout -q -- README.md
  git add -- data state sources
  if git diff --cached --quiet; then git reset -q --hard "$1"; prepare && pnpm cli stats; return; fi
  git_bot commit -q -m 'wip: generated changes'
  if git rebase --quiet "$1" && git reset -q "$1" && prepare; then pnpm cli stats; return 0; fi
  git rebase --abort 2> /dev/null || true
  return 1
}
# Otherwise recompute on the new head. Research decisions from the last 48 hours are reused, so this
# repeats only the cheap verification work. Codex must never inherit the GitHub token here.
recompute() {
  git reset -q --hard "$1"
  git clean -fq -- data state sources
  prepare
  env -u GH_TOKEN pnpm run update
  pnpm cli stats
}
base="$UPDATE_BASE_SHA"

# Never rebase stale mapping decisions by hand or force-push.
for attempt in 1 2 3; do
  git_remote fetch origin main
  remote=$(git rev-parse origin/main)
  if test "$remote" != "$base"; then
    carry_over "$remote" || recompute "$remote"
    base="$remote"
  fi
  # Only our allow-listed generated changes may exist here: guard rejects other edits.
  pnpm cli guard "$base"
  pnpm validate
  git add -- data state sources README.md
  if git diff --cached --quiet; then echo 'No changes'; exit 0; fi
  git_bot commit -q -m 'data: update and audit Bangumi to TMDB mappings'
  if git_remote push origin HEAD:main; then exit 0; fi
  # A racing human merge causes a non-fast-forward rejection. Preserve the patch only
  # long enough for the next guard, then carry it onto the new remote head.
  git reset -q --soft "$base"
done
echo '::error::main kept changing; no force push attempted. Retry the workflow.'
exit 1
