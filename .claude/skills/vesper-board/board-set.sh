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
set -euo pipefail

REPO=ceponatia/vesper
OWNER=ceponatia
PROJECT=7
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

# --- item id -------------------------------------------------------------------
# A one-point GraphQL lookup, not a 500-item board dump: item-list queries share
# the 5,000-point hourly budget and have exhausted it mid-session before.
kind=issue; [ "$TYPE" = PullRequest ] && kind=pullRequest
item_id=$(gh api graphql -F n="$NUMBER" -f query="query(\$n:Int!) { repository(owner:\"$OWNER\", name:\"vesper\") {
    $kind(number:\$n) { projectItems(first:20) { nodes { id project { id } } } } } }" \
  | jq -r --arg p "$PROJECT_ID" '[.data.repository[] | .projectItems.nodes[] | select(.project.id == $p) | .id][0] // empty')
if [ -z "$item_id" ]; then
  if [ "$TYPE" = Issue ]; then
    if [ "$DRY" = 1 ]; then
      echo "  (dry-run) would add issue #$NUMBER to the board"; item_id=DRY
    else
      item_id=$(gh project item-add "$PROJECT" --owner "$OWNER" \
        --url "https://github.com/$REPO/issues/$NUMBER" --format json --jq .id)
      echo "added issue #$NUMBER to the board ($item_id)"
    fi
  else
    echo "PR #$NUMBER is not on the board — run link-pr.sh <pr> <issue> first" >&2
    exit 1
  fi
else
  echo "#$NUMBER ($TYPE) is board item $item_id"
fi

# --- fields --------------------------------------------------------------------
if [ ${#PAIRS[@]} -gt 0 ]; then
  fields=$(gh project field-list "$PROJECT" --owner "$OWNER" --format json)
  today=$(date -I)

  set_pair() {
    local name="$1" value="$2" field field_id ftype
    field=$(jq -c --arg n "$name" \
      '[.fields[] | select((.name | ascii_downcase) == ($n | ascii_downcase))][0] // empty' <<<"$fields")
    [ -n "$field" ] || { echo "no board field named '$name'" >&2; exit 1; }
    field_id=$(jq -r .id <<<"$field")
    ftype=$(jq -r .type <<<"$field")

    if [ "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" = none ]; then
      run gh project item-edit --project-id "$PROJECT_ID" --id "$item_id" --field-id "$field_id" --clear >/dev/null
      echo "  $name: cleared"; return
    fi

    case "$ftype" in
      ProjectV2SingleSelectField)
        local opt
        opt=$(jq -r --arg v "$value" \
          '[.options[] | select((.name | ascii_downcase) == ($v | ascii_downcase))][0].id // empty' <<<"$field")
        [ -n "$opt" ] || { echo "$name has no option '$value' (options: $(jq -r '[.options[].name] | join(", ")' <<<"$field"))" >&2; exit 1; }
        run gh project item-edit --project-id "$PROJECT_ID" --id "$item_id" --field-id "$field_id" \
          --single-select-option-id "$opt" >/dev/null
        echo "  $name: $(jq -r --arg id "$opt" '.options[] | select(.id == $id) | .name' <<<"$field")" ;;
      ProjectV2IterationField)
        local all iter
        # field-list's JSON omits the iteration configuration; only GraphQL has it
        all=$(gh api graphql -f id="$field_id" -f query='query($id:ID!) { node(id:$id) { ... on ProjectV2IterationField {
                configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } } } }' \
          | jq -c '.data.node.configuration | ((.iterations // []) + (.completedIterations // []))
              | map({id, title, startDate, duration,
                     endDate: (((.startDate | strptime("%Y-%m-%d") | mktime) + (.duration * 86400)) | strftime("%Y-%m-%d"))})')
        case "$value" in
          @current) iter=$(jq -c --arg d "$today" '[.[] | select(.startDate <= $d and $d < .endDate)][0] // empty' <<<"$all") ;;
          @next)    iter=$(jq -c --arg d "$today" '[.[] | select(.startDate > $d)] | sort_by(.startDate) | .[0] // empty' <<<"$all") ;;
          *)        iter=$(jq -c --arg v "$value" '[.[] | select((.title | ascii_downcase) == ($v | ascii_downcase))][0] // empty' <<<"$all") ;;
        esac
        [ -n "$iter" ] || { echo "no iteration matches '$value' (have: $(jq -r '[.[].title] | join(", ")' <<<"$all"))" >&2; exit 1; }
        run gh project item-edit --project-id "$PROJECT_ID" --id "$item_id" --field-id "$field_id" \
          --iteration-id "$(jq -r .id <<<"$iter")" >/dev/null
        echo "  $name: $(jq -r '"\(.title) (\(.startDate) → \(.endDate))"' <<<"$iter")" ;;
      *) echo "$name is a $ftype; this script sets single-select and iteration fields only" >&2; exit 1 ;;
    esac
  }

  i=0
  while [ $i -lt ${#PAIRS[@]} ]; do
    set_pair "${PAIRS[$i]}" "${PAIRS[$((i+1))]}"
    i=$((i+2))
  done
fi

# --- assignment ----------------------------------------------------------------
if [ -n "$ASSIGN" ]; then
  sub=issue; [ "$TYPE" = PullRequest ] && sub=pr
  if [ "$ASSIGN" = add ]; then
    run gh "$sub" edit "$NUMBER" --repo "$REPO" --add-assignee "$ASSIGNEE" >/dev/null
    echo "  assigned $ASSIGNEE (next action is the owner's)"
  else
    run gh "$sub" edit "$NUMBER" --repo "$REPO" --remove-assignee "$ASSIGNEE" >/dev/null
    echo "  unassigned $ASSIGNEE (back in the pool)"
  fi
fi
