#!/usr/bin/env bash
# File an issue and finish it in one go: create it, put it on the board with
# its fields set, attach it to a parent, wire blocked-by relations, and assign
# the owner when the next action is theirs.
#
#   file-issue.sh --title "…" (--body-file f | --body "…") [options]
#
#   --label L          repeatable; must come from the board's label taxonomy
#   --parent N         make the new issue a sub-issue of #N
#   --blocked-by N     repeatable; the new issue is blocked by #N
#   --status S  --horizon H  --priority P  --area A  --effort E  --iteration I
#                      board fields by name (see board-set.sh for values)
#   --assign           assign ceponatia (only when the next action is the owner's)
#   --agent-found      shorthand for --label agent-found (something noticed in passing)
#
# The new issue number is the last line on stdout, so `n=$(… | tail -1)` works.
# Sub-issues entering an iteration pull their parent into the same iteration
# (the Current Iteration view only nests slices under a parent that is itself
# in the iteration), so --parent plus --iteration sets both.
set -euo pipefail

REPO=ceponatia/vesper
HERE=$(cd "$(dirname "$0")" && pwd)
TAXONOMY="bug technical-debt performance security documentation research evaluation initiative decision-needed agent-found"

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

TITLE=""; BODY=""; BODY_FILE=""; PARENT=""; ASSIGN=0
LABELS=(); BLOCKERS=(); FIELDS=(); ITERATION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --label) LABELS+=("$2"); shift 2 ;;
    --agent-found) LABELS+=(agent-found); shift ;;
    --parent) PARENT="$2"; shift 2 ;;
    --blocked-by) BLOCKERS+=("$2"); shift 2 ;;
    --status)   FIELDS+=(Status "$2"); shift 2 ;;
    --horizon)  FIELDS+=(Horizon "$2"); shift 2 ;;
    --priority) FIELDS+=(Priority "$2"); shift 2 ;;
    --area)     FIELDS+=(Area "$2"); shift 2 ;;
    --effort)   FIELDS+=(Effort "$2"); shift 2 ;;
    --iteration) ITERATION="$2"; FIELDS+=(Iteration "$2"); shift 2 ;;
    --assign) ASSIGN=1; shift ;;
    --help|-h) usage ;;
    *) echo "unknown argument $1" >&2; usage ;;
  esac
done
[ -n "$TITLE" ] || { echo "--title is required" >&2; usage; }
[ -n "$BODY" ] || [ -n "$BODY_FILE" ] || { echo "--body or --body-file is required" >&2; usage; }

for l in "${LABELS[@]+"${LABELS[@]}"}"; do
  case " $TAXONOMY " in
    *" $l "*) ;;
    *) echo "label '$l' is not in the board's taxonomy ($TAXONOMY)" >&2; exit 1 ;;
  esac
done

# --- create --------------------------------------------------------------------
args=(--repo "$REPO" --title "$TITLE")
if [ -n "$BODY_FILE" ]; then args+=(--body-file "$BODY_FILE"); else args+=(--body "$BODY"); fi
for l in "${LABELS[@]+"${LABELS[@]}"}"; do args+=(--label "$l"); done
url=$(gh issue create "${args[@]}")
NUMBER=${url##*/}
echo "created #$NUMBER  $url"

# --- board fields (also adds it to the board immediately) ------------------------
set_args=("$NUMBER")
[ "$ASSIGN" = 1 ] && set_args+=(--assign)
set_args+=("${FIELDS[@]+"${FIELDS[@]}"}")
"$HERE/board-set.sh" "${set_args[@]}"

# --- relations (REST wants database ids, not numbers) ------------------------------
db_id() { gh api "repos/$REPO/issues/$1" --jq .id; }

if [ -n "$PARENT" ]; then
  child=$(db_id "$NUMBER")
  gh api -X POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$child" >/dev/null
  echo "  sub-issue of #$PARENT"
  if [ -n "$ITERATION" ]; then
    echo "  parent #$PARENT joins the same iteration:"
    "$HERE/board-set.sh" "$PARENT" Iteration "$ITERATION" | sed 's/^/  /'
  fi
fi

for m in "${BLOCKERS[@]+"${BLOCKERS[@]}"}"; do
  blocker=$(db_id "$m")
  gh api -X POST "repos/$REPO/issues/$NUMBER/dependencies/blocked_by" -F issue_id="$blocker" >/dev/null
  echo "  blocked by #$m"
done

echo "$NUMBER"
