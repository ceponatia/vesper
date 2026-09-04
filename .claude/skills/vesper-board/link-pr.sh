#!/usr/bin/env bash
# Put a PR on the Vesper Development board and mirror its issue's classification
# onto it: Horizon, Priority, Area, Effort, Iteration. Status is never mirrored —
# a PR item's Status tracks the PR's own review state, not the issue's.
#
#   .claude/skills/vesper-board/link-pr.sh <pr-number> <issue-number>
#
# Idempotent: re-running writes the same values. Run it again after the issue's
# classification changes. Direct GraphQL only (small queries, explicit
# mutations) — `gh project …` calls are large and have been refused with
# "API rate limit exceeded" while direct GraphQL still worked.
set -euo pipefail

PR="${1:?usage: link-pr.sh <pr-number> <issue-number>}"
ISSUE="${2:?usage: link-pr.sh <pr-number> <issue-number>}"

OWNER=ceponatia
PROJECT_ID=PVT_kwHOARzdw84BhlWR
MIRROR='Horizon Priority Area Effort Iteration'

lookup() {  # number kind -> "contentId itemId"
  gh api graphql -F n="$1" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"vesper\") {
      $2(number:\$n) { id projectItems(first:20) { nodes { id project { id } } } } } }" \
    | jq -r --arg p "$PROJECT_ID" '.data.repository[] | "\(.id) \([.projectItems.nodes[] | select(.project.id == $p) | .id][0] // "")"'
}

read -r _ issue_item <<<"$(lookup "$ISSUE" issue)"
[ -n "$issue_item" ] || { echo "issue #$ISSUE is not on the board — classify it first" >&2; exit 1; }

read -r pr_content pr_item <<<"$(lookup "$PR" pullRequest)"
if [ -z "$pr_item" ]; then
  pr_item=$(gh api graphql -f project="$PROJECT_ID" -f content="$pr_content" -f query='mutation($project:ID!, $content:ID!) {
      addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }' \
    --jq .data.addProjectV2ItemById.item.id)
  echo "added PR #$PR to the board ($pr_item)"
fi

src=$(gh api graphql -f id="$issue_item" -f query='
  query($id: ID!) {
    node(id: $id) { ... on ProjectV2Item { fieldValues(first: 40) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        kind: __typename optionId name field { ... on ProjectV2SingleSelectField { id name } } }
      ... on ProjectV2ItemFieldIterationValue {
        kind: __typename iterationId title field { ... on ProjectV2IterationField { id name } } }
    } } } }
  }' --jq '[.data.node.fieldValues.nodes[] | select(.field != null)]')

for name in $MIRROR; do
  row=$(jq -c --arg n "$name" '[.[] | select(.field.name == $n)][0] // empty' <<<"$src")
  if [ -z "$row" ]; then echo "  $name: unset on #$ISSUE — skipped"; continue; fi
  field_id=$(jq -r '.field.id' <<<"$row")
  if [ "$(jq -r '.kind' <<<"$row")" = ProjectV2ItemFieldIterationValue ]; then
    gh api graphql -f project="$PROJECT_ID" -f item="$pr_item" -f field="$field_id" -f iter="$(jq -r .iterationId <<<"$row")" \
      -f query='mutation($project:ID!, $item:ID!, $field:ID!, $iter:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{iterationId:$iter}}) { projectV2Item { id } } }' >/dev/null
    label=$(jq -r '.title' <<<"$row")
  else
    gh api graphql -f project="$PROJECT_ID" -f item="$pr_item" -f field="$field_id" -f opt="$(jq -r .optionId <<<"$row")" \
      -f query='mutation($project:ID!, $item:ID!, $field:ID!, $opt:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{singleSelectOptionId:$opt}}) { projectV2Item { id } } }' >/dev/null
    label=$(jq -r '.name' <<<"$row")
  fi
  echo "  $name: $label"
done

echo "PR #$PR mirrors #$ISSUE. Set the PR's Status yourself (In Progress while draft, Awaiting Acceptance once ready for review)."
