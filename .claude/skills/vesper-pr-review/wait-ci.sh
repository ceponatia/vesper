#!/usr/bin/env bash
# Wait for a PR's CI to settle without the traps this repo has already paid
# for: a draft PR runs no CI, a CONFLICTING PR runs no CI (no merge ref), and
# "no checks reported" right after a push means the suite has not registered
# yet — never that it passed. Run it in the background and wait for the
# notification; do not arm a Monitor on a probe you have not eyeballed.
#
#   wait-ci.sh <pr> [--timeout-min N] [--interval-sec N]
#
# Exit: 0 every check passed or was skipped · 1 a check failed or was
# cancelled (rows printed) · 2 timed out · 3 draft, nothing will run ·
# 4 conflicting, merge main into the branch first.
set -euo pipefail

REPO=ceponatia/vesper
PR="${1:?usage: wait-ci.sh <pr> [--timeout-min N] [--interval-sec N]}"; shift
TIMEOUT=25; INTERVAL=30
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-min) TIMEOUT="$2"; shift 2 ;;
    --interval-sec) INTERVAL="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done

view() { gh pr view "$PR" --repo "$REPO" --json state,isDraft,mergeable,headRefOid,url; }
v=$(view)
state=$(jq -r .state <<<"$v"); draft=$(jq -r .isDraft <<<"$v"); head=$(jq -r '.headRefOid[0:8]' <<<"$v")
echo "PR #$PR $(jq -r .url <<<"$v")  state=$state draft=$draft head=$head mergeable=$(jq -r .mergeable <<<"$v")"
[ "$state" = OPEN ] || { echo "PR is $state — nothing to wait for"; exit 0; }
[ "$draft" != true ] || { echo "draft PRs run no CI — flip it ready (owner's call) before waiting"; exit 3; }
[ "$(jq -r .mergeable <<<"$v")" != CONFLICTING ] || { echo "CONFLICTING — no merge ref, so CI never triggers; merge main into the branch first"; exit 4; }

deadline=$(( $(date +%s) + TIMEOUT * 60 ))
errfile=$(mktemp); trap 'rm -f "$errfile"' EXIT

while :; do
  set +e
  out=$(gh pr checks "$PR" --repo "$REPO" --json name,bucket,state,workflow 2>"$errfile")
  rc=$?
  set -e
  err=$(cat "$errfile")

  if [ $rc -ne 0 ] || [ -z "$out" ] || [ "$out" = "[]" ]; then
    if grep -qi "no checks reported" <<<"$err$out"; then
      msg="no checks registered yet (a race window of about a minute after a push)"
    else
      msg="gh pr checks: ${err:-empty result}"
    fi
    m=$(gh pr view "$PR" --repo "$REPO" --json mergeable --jq .mergeable)
    [ "$m" != CONFLICTING ] || { echo "became CONFLICTING (main moved) — merge main into the branch; CI will not run"; exit 4; }
    echo "$(date +%H:%M:%S)  $msg — waiting"
  else
    fail=$(jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length' <<<"$out")
    pending=$(jq '[.[] | select(.bucket == "pending")] | length' <<<"$out")
    pass=$(jq '[.[] | select(.bucket == "pass")] | length' <<<"$out")
    skip=$(jq '[.[] | select(.bucket == "skipping")] | length' <<<"$out")
    if [ "$fail" -gt 0 ]; then
      echo "FAILED:"; jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | "  \(.state)\t\(.workflow)/\(.name)"' <<<"$out"
      echo "diagnose with ci-failure.sh $PR (from the logs, not from a local gate run)"; exit 1
    fi
    if [ "$pending" -eq 0 ]; then
      echo "GREEN: $pass passed, $skip skipped"; jq -r '.[] | "  \(.bucket)\t\(.workflow)/\(.name)"' <<<"$out"; exit 0
    fi
    echo "$(date +%H:%M:%S)  pending $pending · pass $pass · skip $skip — waiting"
  fi

  newhead=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq '.headRefOid[0:8]')
  [ "$newhead" = "$head" ] || { echo "new push: head $head → $newhead, waiting on the new suite"; head=$newhead; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out after $TIMEOUT min"; exit 2; }
  sleep "$INTERVAL"
done
