#!/usr/bin/env bash
# One look at where a PR stands: state, CI buckets, reviews and requests,
# unresolved threads, and whether Codex has answered the latest
# "@codex review" trigger — its clean pass is a 👍 reaction on the trigger
# comment, not a review row, which is why a plain poll of reviews misses it.
#
#   review-status.sh <pr>
set -euo pipefail

REPO=ceponatia/vesper
HERE=$(cd "$(dirname "$0")" && pwd)
PR="${1:?usage: review-status.sh <pr>}"

v=$(gh pr view "$PR" --repo "$REPO" --json state,isDraft,mergeable,mergeStateStatus,headRefOid,url,title,reviews,reviewRequests,assignees)
echo "PR #$PR  $(jq -r .title <<<"$v")"
echo "  $(jq -r .url <<<"$v")"
echo "  state=$(jq -r .state <<<"$v") draft=$(jq -r .isDraft <<<"$v") mergeable=$(jq -r .mergeable <<<"$v")/$(jq -r .mergeStateStatus <<<"$v") head=$(jq -r '.headRefOid[0:8]' <<<"$v") assignees=$(jq -r '[.assignees[].login] | join(",")' <<<"$v")"

echo "CI:"
set +e
checks=$(gh pr checks "$PR" --repo "$REPO" --json name,bucket,workflow 2>&1)
set -e
if jq -e 'type == "array" and length > 0' <<<"$checks" >/dev/null 2>&1; then
  jq -r 'group_by(.bucket) | map("  \(.[0].bucket): \(map(.name) | join(", "))") | .[]' <<<"$checks"
else
  echo "  $(tr '\n' ' ' <<<"$checks")"
fi

echo "reviews:"
if [ "$(jq '.reviews | length' <<<"$v")" = 0 ]; then echo "  none"; else
  jq -r '.reviews[] | "  \(.submittedAt[0:16]) \(.author.login) \(.state)"' <<<"$v"; fi
echo "review requests: $(jq -r '[.reviewRequests[] | (.login // .name // "?")] | join(", ") | if . == "" then "none" else . end' <<<"$v")"

threads=$("$HERE/threads.sh" "$PR" --all --json)
echo "threads: $(jq 'length' <<<"$threads") total, $(jq 'map(select(.isResolved | not)) | length' <<<"$threads") unresolved"

# --- Codex ---------------------------------------------------------------------------
comments=$(gh api "repos/$REPO/issues/$PR/comments?per_page=100")
# the bot's own summary comment mentions "@codex review" — only a human (or agent) comment is a trigger
trigger=$(jq -c '[.[] | select((.body | test("@codex review"; "i")) and ((.user.login | test("codex"; "i")) | not))] | last // empty' <<<"$comments")
codex_reviews=$(jq -c '[.reviews[] | select(.author.login | test("codex"; "i"))]' <<<"$v")
if [ -z "$trigger" ]; then
  n=$(jq 'length' <<<"$codex_reviews")
  echo "codex: no '@codex review' trigger comment; $n codex review(s) on the PR (a review is not guaranteed — check once, do not poll)"
else
  t_at=$(jq -r .created_at <<<"$trigger"); thumbs=$(jq -r '.reactions["+1"]' <<<"$trigger")
  after=$(jq --arg t "$t_at" '[.[] | select(.submittedAt > $t)] | length' <<<"$codex_reviews")
  if [ "$thumbs" -gt 0 ]; then verdict="answered CLEAN (👍 on the trigger)"
  elif [ "$after" -gt 0 ]; then verdict="answered with findings ($after review(s) after the trigger) — see threads"
  else verdict="no answer yet"; fi
  echo "codex: trigger $(jq -r .html_url <<<"$trigger") at ${t_at:0:16} by $(jq -r .user.login <<<"$trigger") — $verdict"
fi
