#!/usr/bin/env bash
# Show why CI failed on a PR: the jobs of the run for the PR's head commit and
# the failed steps' logs, straight from GitHub. Diagnose from these and from
# reading code — never by running the gates locally (owner ruling: CI
# validates; local gate runs have crashed this machine).
#
#   ci-failure.sh <pr> [--run <run-id>] [--lines N]
set -euo pipefail

REPO=ceponatia/vesper
PR="${1:?usage: ci-failure.sh <pr> [--run <run-id>] [--lines N]}"; shift
RUN=""; LINES=300
while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN="$2"; shift 2 ;;
    --lines) LINES="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done

head=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
if [ -z "$RUN" ]; then
  runs=$(gh run list --repo "$REPO" --commit "$head" --json databaseId,status,conclusion,createdAt,workflowName,event --limit 20)
  echo "runs for head ${head:0:8}:"
  jq -r '.[] | "  \(.databaseId)\t\(.workflowName)\t\(.event)\t\(.status)\t\(.conclusion // "-")\t\(.createdAt)"' <<<"$runs"
  RUN=$(jq -r '[.[] | select(.workflowName == "CI" and .conclusion != "skipped")] | sort_by(.createdAt) | last | .databaseId // empty' <<<"$runs")
  [ -n "$RUN" ] || { echo "no non-skipped CI run for this head yet (draft? just pushed? conflicting?)"; exit 2; }
fi

echo; echo "run $RUN: $(gh run view "$RUN" --repo "$REPO" --json url,status,conclusion --jq '"\(.status) \(.conclusion // "") \(.url)"')"
echo "jobs:"
gh run view "$RUN" --repo "$REPO" --json jobs --jq '.jobs[] | "  \(.conclusion // .status)\t\(.name)"'

status=$(gh run view "$RUN" --repo "$REPO" --json status --jq .status)
[ "$status" = completed ] || { echo; echo "run still $status — logs are partial until it completes"; }

echo; echo "--- failed-step logs (last $LINES lines) ---"
gh run view "$RUN" --repo "$REPO" --log-failed 2>&1 | tail -n "$LINES"
