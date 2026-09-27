#!/usr/bin/env bash
# Restore Iteration values from an iteration-snapshot.sh file after the
# iteration field was re-cut. Iterations are matched by TITLE against the
# field's current configuration (new ids), so keep titles stable when you
# change dates. Items whose title no longer exists are reported and skipped.
#
#   iteration-restore.sh iterations-before.json [--dry-run]
set -euo pipefail

PROJECT_ID=PVT_kwHOARzdw84BhlWR

SNAP="${1:?usage: iteration-restore.sh <snapshot.json> [--dry-run]}"
DRY=0; [ "${2:-}" = --dry-run ] && DRY=1

field=$(gh api graphql -f project="$PROJECT_ID" -f query='query($project:ID!) { node(id:$project) { ... on ProjectV2 {
    fields(first:40) { nodes { ... on ProjectV2IterationField { id name
      configuration { iterations { id title } completedIterations { id title } } } } } } } }' \
  --jq '[.data.node.fields.nodes[] | select(.id != null and .configuration != null)][0]')
field_id=$(jq -r .id <<<"$field")
iterations=$(jq -c '.configuration | (.iterations // []) + (.completedIterations // [])' <<<"$field")
echo "current iterations: $(jq -r '[.[] | "\(.title)=\(.id)"] | join("  ")' <<<"$iterations")"

restored=0; skipped=0
while IFS=$'\t' read -r number type item_id title; do
  new_id=$(jq -r --arg t "$title" '[.[] | select(.title == $t)][0].id // empty' <<<"$iterations")
  if [ -z "$new_id" ]; then
    echo "  #$number ($type): iteration '$title' no longer exists — skipped"; skipped=$((skipped+1)); continue
  fi
  if [ "$DRY" = 1 ]; then
    echo "  (dry-run) #$number ($type) → $title ($new_id)"
  else
    gh api graphql -f project="$PROJECT_ID" -f item="$item_id" -f field="$field_id" -f iter="$new_id" \
      -f query='mutation($project:ID!, $item:ID!, $field:ID!, $iter:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{iterationId:$iter}}) { projectV2Item { id } } }' >/dev/null
    echo "  #$number ($type) → $title"
  fi
  restored=$((restored+1))
done < <(jq -r '.[] | [.number, .type, .itemId, .title] | @tsv' "$SNAP")

echo "restored $restored, skipped $skipped"
