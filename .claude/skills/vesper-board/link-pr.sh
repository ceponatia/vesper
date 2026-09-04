#!/usr/bin/env bash
# Put a PR on the Vesper Development board and mirror its issue's classification
# onto it: Horizon, Priority, Area, Effort, Iteration. Status is never mirrored —
# a PR item's Status tracks the PR's own review state, not the issue's.
#
#   .claude/skills/vesper-board/link-pr.sh <pr-number> <issue-number>
#
# Idempotent: re-running writes the same values. Run it again after the issue's
# classification changes.
set -euo pipefail

PR="${1:?usage: link-pr.sh <pr-number> <issue-number>}"
ISSUE="${2:?usage: link-pr.sh <pr-number> <issue-number>}"

REPO=ceponatia/vesper
OWNER=ceponatia
PROJECT=7
PROJECT_ID=PVT_kwHOARzdw84BhlWR
MIRROR='Horizon Priority Area Effort Iteration'

# One-point lookups instead of a board dump: item-list queries share the
# 5,000-point hourly GraphQL budget and have exhausted it mid-session before.
item_id() {
  local kind=issue; [ "$2" = PullRequest ] && kind=pullRequest
  gh api graphql -F n="$1" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"vesper\") {
      $kind(number:\$n) { projectItems(first:20) { nodes { id project { id } } } } } }" \
    | jq -r --arg p "$PROJECT_ID" '[.data.repository[] | .projectItems.nodes[] | select(.project.id == $p) | .id][0] // empty'
}

issue_item=$(item_id "$ISSUE" Issue)
[ -n "$issue_item" ] || { echo "issue #$ISSUE is not on the board — classify it first" >&2; exit 1; }

pr_item=$(item_id "$PR" PullRequest)
if [ -z "$pr_item" ]; then
  pr_item=$(gh project item-add "$PROJECT" --owner "$OWNER" \
    --url "https://github.com/$REPO/pull/$PR" --format json --jq .id)
  echo "added PR #$PR to the board ($pr_item)"
fi

read_values() {
  gh api graphql -f id="$1" -f query='
    query($id: ID!) {
      node(id: $id) { ... on ProjectV2Item { fieldValues(first: 40) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue {
          kind: __typename optionId name field { ... on ProjectV2SingleSelectField { id name } } }
        ... on ProjectV2ItemFieldIterationValue {
          kind: __typename iterationId title field { ... on ProjectV2IterationField { id name } } }
      } } } }
    }' --jq '[.data.node.fieldValues.nodes[] | select(.field != null)]'
}

src=$(read_values "$issue_item")

for name in $MIRROR; do
  row=$(jq -c --arg n "$name" '[.[] | select(.field.name == $n)][0] // empty' <<<"$src")
  if [ -z "$row" ]; then echo "  $name: unset on #$ISSUE — skipped"; continue; fi
  field_id=$(jq -r '.field.id' <<<"$row")
  if [ "$(jq -r '.kind' <<<"$row")" = ProjectV2ItemFieldIterationValue ]; then
    value_flag=(--iteration-id "$(jq -r '.iterationId' <<<"$row")")
    label=$(jq -r '.title' <<<"$row")
  else
    value_flag=(--single-select-option-id "$(jq -r '.optionId' <<<"$row")")
    label=$(jq -r '.name' <<<"$row")
  fi
  gh project item-edit --project-id "$PROJECT_ID" --id "$pr_item" \
    --field-id "$field_id" "${value_flag[@]}" >/dev/null
  echo "  $name: $label"
done

echo "PR #$PR mirrors #$ISSUE. Set the PR's Status yourself (In Progress while draft, Awaiting Acceptance once ready for review)."
