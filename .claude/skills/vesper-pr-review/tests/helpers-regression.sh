#!/usr/bin/env bash
# Offline behavioral regressions for wait-ci.sh and review-status.sh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SKILL=$(cd "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
ln -s "$HERE/mock-gh.sh" "$TMP/bin/gh"
ln -s /usr/bin/true "$TMP/bin/sleep"

run_case() {
  local scenario=$1 expected_rc=$2 expected_text=$3 timeout=$5
  local state="$TMP/$scenario"
  mkdir -p "$state"
  set +e
  output=$(PATH="$TMP/bin:$PATH" TEST_SCENARIO="$scenario" TEST_STATE_DIR="$state" "$SKILL/${4}" 1 --timeout-min "$timeout" --interval-sec 1 2>&1)
  rc=$?
  set -e
  if [ "$rc" -ne "$expected_rc" ] || ! grep -Fq "$expected_text" <<<"$output"; then
    printf 'FAIL %s: rc=%s, wanted rc=%s and %q\n%s\n' "$scenario" "$rc" "$expected_rc" "$expected_text" "$output" >&2
    exit 1
  fi
  printf 'ok  %s\n' "$scenario"
}

run_review() {
  local scenario=$1 expected=$2
  local state="$TMP/$scenario"
  mkdir -p "$state"
  output=$(PATH="$TMP/bin:$PATH" TEST_SCENARIO="$scenario" TEST_STATE_DIR="$state" "$SKILL/review-status.sh" 1)
  if ! grep -Fq "codex: $expected" <<<"$output"; then
    printf 'FAIL %s: wanted codex: %s\n%s\n' "$scenario" "$expected" "$output" >&2
    exit 1
  fi
  grep -Fq -- '--paginate --slurp repos/ceponatia/vesper/issues/1/comments?per_page=100' "$state/calls" || {
    echo "FAIL $scenario: issue comments were not paginated" >&2
    exit 1
  }
  printf 'ok  %s\n' "$scenario"
}

# Valid JSON remains authoritative even with gh's documented rc=8/rc=1.
run_case wait-pending 0 'GREEN: required CI/verify succeeded for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 1
run_case wait-failing 1 'FAILED for head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' wait-ci.sh 0
# An unrelated successful check cannot satisfy the required aggregate.
run_case wait-unrelated 2 'CI/verify is absent' wait-ci.sh 0
run_case wait-no-checks 2 'no required checks registered' wait-ci.sh 0
run_case wait-required-peer-fail 1 'Security/security' wait-ci.sh 0
# A successful sample is discarded when the full head changes during the read.
run_case wait-stale 2 'discarded checks read for the previous head' wait-ci.sh 0

run_review review-clean clean
run_review review-old-open-clean findings
run_review review-findings findings
run_review review-approved clean
run_review review-dismissed unverified
run_review review-pending pending
run_review review-legacy unverified
run_review review-impostor unverified
run_review review-trusted-reaction clean
run_review review-stale unverified
run_review review-unrequested unrequested

echo 'all offline helper regressions passed'
