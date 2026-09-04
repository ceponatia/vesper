#!/usr/bin/env bash
# Set board fields on an issue or PR by NAME — the item-id, field-id and
# option-id lookups are done for you — and apply the assignment convention.
#
#   board-set.sh <number> [--pr] [--assign|--unassign] [--dry-run] [<Field> <Value>]...
#
#   board-set.sh 457 Status "Awaiting Acceptance" --assign
#   board-set.sh 461 --pr Status "In Progress"
#   board-set.sh 459 Horizon Later Priority P3 Area Images Effort M
#   board-set.sh 459 Iteration @current        # also @next, "Iteration 3", none
#   board-set.sh 459                           # just make sure it is on the board
#
# Single-select fields (Status, Horizon, Priority, Area, Effort) take an option
# name, case-insensitive. Iteration takes a title, @current, @next, or none.
# --assign / --unassign edit the issue or PR itself (assignee ceponatia): the
# board's "the next action is the owner's" signal.
#
# The board holds two separate rows for an issue and its PR, so a number is
# looked up as an Issue unless --pr is given. An issue missing from the board is
# added; a PR missing from the board is an error — use link-pr.sh, which also
# mirrors the issue's classification onto the PR row.
#
# Everything goes through `gh api graphql` (small queries, explicit mutations)
# and REST — never `gh project …`, whose calls are large and have been refused
# with "API rate limit exceeded" while direct GraphQL still worked.
set -euo pipefail

REPO=ceponatia/vesper
OWNER=ceponatia
PROJECT_ID=PVT_kwHOARzdw84BhlWR
ASSIGNEE=ceponatia

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

[ $# -ge 1 ] || usage
NUMBER="$1"; shift
[[ "$NUMBER" =~ ^[0-9]+$ ]] || usage

TYPE=Issue; ASSIGN=""; DRY=0; PAIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) TYPE=PullRequest; shift ;;
    --assign) ASSIGN=add; shift ;;
    --unassign) ASSIGN=remove; shift ;;
    --dry-run) DRY=1; shift ;;
    --help|-h) usage ;;
    --*) echo "unknown flag $1" >&2; usage ;;
    *) [ $# -ge 2 ] || { echo "field '$1' has no value" >&2; usage; }
       PAIRS+=("$1" "$2"); shift 2 ;;
  esac
done

run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

# --- item id (one small query; adds the issue to the board if absent) ---------------
kind=issue; [ "$TYPE" = PullRequest ] && kind=pullRequest
content=$(gh api graphql -F n="$NUMBER" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"vesper\") {
    $kind(number:\$n) { id projectItems(first:20) { nodes { id project { id } } } } } }")
content_id=$(jq -r '.data.repository[] | .id' <<<"$content")
item_id=$(jq -r --arg p "$PROJECT_ID" '[.data.repository[] | .projectItems.nodes[] | select(.project.id == $p) | .id][0] // empty' <<<"$content")
if [ -z "$item_id" ]; then
  if [ "$TYPE" = Issue ]; then
    if [ "$DRY" = 1 ]; then
      echo "  (dry-run) would add issue #$NUMBER to the board"; item_id=DRY
    else
      item_id=$(gh api graphql -f project="$PROJECT_ID" -f content="$content_id" -f query='mutation($project:ID!, $content:ID!) {
          addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }' \
        --jq .data.addProjectV2ItemById.item.id)
      echo "added issue #$NUMBER to the board ($item_id)"
    fi
  else
    echo "PR #$NUMBER is not on the board — run link-pr.sh <pr> <issue> first" >&2
    exit 1
  fi
else
  echo "#$NUMBER ($TYPE) is board item $item_id"
fi

# --- fields ----------------------------------------------------------------------------
if [ ${#PAIRS[@]} -gt 0 ]; then
  fields=$(gh api graphql -f project="$PROJECT_ID" -f query='query($project:ID!) { node(id:$project) { ... on ProjectV2 {
      fields(first:40) { nodes {
        ... on ProjectV2Field { id name dataType }
        ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        ... on ProjectV2IterationField { id name dataType
          configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } }
      } } } } }' --jq '.data.node.fields.nodes')
  today=$(date -I)

  set_single() {  # item field option
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f opt="$3" -f query='mutation($project:ID!, $item:ID!, $field:ID!, $opt:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{singleSelectOptionId:$opt}}) { projectV2Item { id } } }' >/dev/null
  }
  set_iteration() {  # item field iteration
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f iter="$3" -f query='mutation($project:ID!, $item:ID!, $field:ID!, $iter:String!) {
        updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field, value:{iterationId:$iter}}) { projectV2Item { id } } }' >/dev/null
  }
  clear_field() {  # item field
    run gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$2" -f query='mutation($project:ID!, $item:ID!, $field:ID!) {
        clearProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item, fieldId:$field}) { projectV2Item { id } } }' >/dev/null
  }

  set_pair() {
    local name="$1" value="$2" field field_id dtype
    field=$(jq -c --arg n "$name" '[.[] | select((.name | ascii_downcase) == ($n | ascii_downcase))][0] // empty' <<<"$fields")
    [ -n "$field" ] || { echo "no board field named '$name'" >&2; exit 1; }
    field_id=$(jq -r .id <<<"$field"); dtype=$(jq -r .dataType <<<"$field")

    if [ "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" = none ]; then
      clear_field "$item_id" "$field_id"; echo "  $name: cleared"; return
    fi
    case "$dtype" in
      SINGLE_SELECT)
        local opt
        opt=$(jq -r --arg v "$value" '[.options[] | select((.name | ascii_downcase) == ($v | ascii_downcase))][0].id // empty' <<<"$field")
        [ -n "$opt" ] || { echo "$name has no option '$value' (options: $(jq -r '[.options[].name] | join(", ")' <<<"$field"))" >&2; exit 1; }
        set_single "$item_id" "$field_id" "$opt"
        echo "  $name: $(jq -r --arg id "$opt" '.options[] | select(.id == $id) | .name' <<<"$field")" ;;
      ITERATION)
        local all iter
        all=$(jq -c '((.configuration.iterations // []) + (.configuration.completedIterations // []))
          | map({id, title, startDate, duration,
                 endDate: (((.startDate | strptime("%Y-%m-%d") | mktime) + (.duration * 86400)) | strftime("%Y-%m-%d"))})' <<<"$field")
        case "$value" in
          @current) iter=$(jq -c --arg d "$today" '[.[] | select(.startDate <= $d and $d < .endDate)][0] // empty' <<<"$all") ;;
          @next)    iter=$(jq -c --arg d "$today" '[.[] | select(.startDate > $d)] | sort_by(.startDate) | .[0] // empty' <<<"$all") ;;
          *)        iter=$(jq -c --arg v "$value" '[.[] | select((.title | ascii_downcase) == ($v | ascii_downcase))][0] // empty' <<<"$all") ;;
        esac
        [ -n "$iter" ] || { echo "no iteration matches '$value' (have: $(jq -r '[.[].title] | join(", ")' <<<"$all"))" >&2; exit 1; }
        set_iteration "$item_id" "$field_id" "$(jq -r .id <<<"$iter")"
        echo "  $name: $(jq -r '"\(.title) (\(.startDate) → \(.endDate))"' <<<"$iter")" ;;
      *) echo "$name is $dtype; this script sets single-select and iteration fields only" >&2; exit 1 ;;
    esac
  }

  i=0
  while [ $i -lt ${#PAIRS[@]} ]; do
    set_pair "${PAIRS[$i]}" "${PAIRS[$((i+1))]}"
    i=$((i+2))
  done
fi

# --- assignment (REST; PRs are issues here) ---------------------------------------------
if [ -n "$ASSIGN" ]; then
  if [ "$ASSIGN" = add ]; then
    run gh api -X POST "repos/$REPO/issues/$NUMBER/assignees" -f "assignees[]=$ASSIGNEE" >/dev/null
    echo "  assigned $ASSIGNEE (next action is the owner's)"
  else
    run gh api -X DELETE "repos/$REPO/issues/$NUMBER/assignees" -f "assignees[]=$ASSIGNEE" >/dev/null
    echo "  unassigned $ASSIGNEE (back in the pool)"
  fi
fi
