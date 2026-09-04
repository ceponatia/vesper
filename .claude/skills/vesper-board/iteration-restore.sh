#!/usr/bin/env bash
# Restore Iteration values from an iteration-snapshot.sh file after the
# iteration field was re-cut. Iterations are matched by TITLE against the
# field's current configuration (new ids), so keep titles stable when you
# change dates. Items whose title no longer exists are reported and skipped.
#
#   iteration-restore.sh iterations-before.json [--dry-run]
set -euo pipefail

OWNER=ceponatia
PROJECT=7
PROJECT_ID=PVT_kwHOARzdw84BhlWR

SNAP="${1:?usage: iteration-restore.sh <snapshot.json> [--dry-run]}"
DRY=0; [ "${2:-}" = --dry-run ] && DRY=1

field=$(gh project field-list "$PROJECT" --owner "$OWNER" --format json \
  | jq -c '[.fields[] | select(.type == "ProjectV2IterationField")][0]')
field_id=$(jq -r .id <<<"$field")
# field-list's JSON omits the iteration configuration; only GraphQL has it
iterations=$(gh api graphql -f id="$field_id" -f query='query($id:ID!) { node(id:$id) { ... on ProjectV2IterationField {
    configuration { iterations { id title } completedIterations { id title } } } } }' \
  | jq -c '.data.node.configuration | (.iterations // []) + (.completedIterations // [])')
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
    gh project item-edit --project-id "$PROJECT_ID" --id "$item_id" --field-id "$field_id" --iteration-id "$new_id" >/dev/null
    echo "  #$number ($type) → $title"
  fi
  restored=$((restored+1))
done < <(jq -r '.[] | [.number, .type, .itemId, .title] | @tsv' "$SNAP")

echo "restored $restored, skipped $skipped"
