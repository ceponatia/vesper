#!/usr/bin/env bash
# Mechanical pass over a branch before a human reads it: every check here is a
# defect an agent has actually shipped in this repo.
#
#   scan-diff.sh [--base main] [--pr-body file] [<worktree-dir>]
#
# Compares HEAD of the worktree (default: cwd) against the merge-base with
# --base. Exit 1 on any FAIL.
#
#   FAIL  control characters / NUL bytes in added text (a NUL in a template
#         string made git treat a .ts file as binary — PR #447)
#   FAIL  a text-typed file git thinks is binary
#   FAIL  `Closes #A, #B` in the PR body (GitHub links only #A)
#   WARN  `throw new Error` added under server/contracts/packages (schema-legal
#         input must degrade with a diagnostic — docs/resilience.md)
#   WARN  a docs/ file whose diff is mostly whitespace (a formatter ran over docs)
#   WARN  markdown table rows whose pipes do not line up (docs are read raw)
#   WARN  dynamic-state wording added under docs/ (status, remaining, awaiting…)
#   WARN  a touched legacy [param] route still on bare withUser (lint:authz fires)
#   WARN  ageAnchor mentioned in a census-guarded file (the test greps source text)
#   INFO  new test files, so vesper-testing's question gets asked
set -euo pipefail

BASE=main; PR_BODY=""; DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --pr-body) PR_BODY="$2"; shift 2 ;;
    *) DIR="$1"; shift ;;
  esac
done
[ -z "$DIR" ] || cd "$DIR"

mb=$(git merge-base "$BASE" HEAD)
range="$mb..HEAD"
fails=0; warns=0
fail() { echo "FAIL  $*"; fails=$((fails+1)); }
warn() { echo "WARN  $*"; warns=$((warns+1)); }
info() { echo "INFO  $*"; }

echo "scan $(git rev-parse --short "$mb")..$(git rev-parse --short HEAD) ($(git rev-list --count "$range") commits) in $(pwd)"
mapfile -t files < <(git diff --name-only "$range")
[ ${#files[@]} -gt 0 ] || { echo "no changes"; exit 0; }

# --- binary-looking text files ------------------------------------------------------
while IFS=$'\t' read -r a b f; do
  if [ "$a" = "-" ] && [ "$b" = "-" ]; then
    case "$f" in
      *.ts|*.tsx|*.mts|*.js|*.mjs|*.cjs|*.json|*.md|*.sql|*.yml|*.yaml|*.toml|*.sh|*.py|*.css|*.txt)
        fail "$f: git reports it as binary — look for a NUL byte or other control character" ;;
    esac
  fi
done < <(git diff --numstat "$range")

# --- control characters in added lines ------------------------------------------------
ctrl=$(git diff -U0 --text "$range" -- . ':!*.png' ':!*.jpg' ':!*.webp' ':!*.gif' ':!*.ico' ':!*.woff*' \
  | grep -a -nP '^\+(?!\+\+ )[^\n]*[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' | head -5 || true)
if [ -n "$ctrl" ]; then
  fail "control characters in added lines (first hits, diff line numbers):"; sed 's/^/        /' <<<"$ctrl" | cat -v
fi

# --- PR body closing keywords -----------------------------------------------------------
if [ -n "$PR_BODY" ] && grep -qE '(Closes|Fixes|Resolves) #[0-9]+ *,' "$PR_BODY"; then
  fail "$PR_BODY: 'Closes #A, #B' links only #A — one keyword per issue on its own line"
fi

# --- throw new Error on production paths --------------------------------------------------
for f in "${files[@]}"; do
  case "$f" in
    apps/web/src/server/*|apps/web/src/contracts/*|apps/web/src/lib/*|packages/*/src/*)
      case "$f" in *.test.ts|*.test.tsx|*/test-support/*|*/test/*) continue ;; esac
      n=$(git diff -U0 "$range" -- "$f" | grep -c '^+.*throw new Error' || true)
      [ "$n" -gt 0 ] && warn "$f: $n added 'throw new Error' — is the input schema-legal? then degrade + diagnostic instead (docs/resilience.md)" ;;
  esac
done

# --- docs: formatter churn, tables, dynamic state --------------------------------------------
for f in "${files[@]}"; do
  case "$f" in docs/*.md|*.md) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  total=$(git diff --numstat "$range" -- "$f" | awk '{print $1+$2}')
  nows=$(git diff --numstat -w "$range" -- "$f" | awk '{print $1+$2}')
  if [ "${total:-0}" -gt 40 ] && [ $(( ${nows:-0} * 100 )) -lt $(( total * 30 )) ]; then
    warn "$f: $total changed lines but only ${nows:-0} without whitespace — a formatter ran over it; revert the churn"
  fi
  case "$f" in docs/*) ;; *) continue ;; esac   # alignment and dynamic-state are docs/ law (vesper-docs)
  tbl=$(awk -v F="$f" '
    function positions(s,   i, c, out) { out = ""; for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); if (c == "|" && (i == 1 || substr(s, i-1, 1) != "\\")) out = out i "," } return out }
    /^\|/ { if (!inblock) { inblock = 1; ref = positions($0); start = NR; flagged = 0 }
            else if (!flagged && positions($0) != ref) { print F ":" NR ": pipes do not line up with the row at line " start; flagged = 1 }
            next }
    { inblock = 0 }' "$f")
  [ -z "$tbl" ] || { warn "misaligned table(s):"; sed 's/^/        /' <<<"$tbl"; }
  case "$f" in docs/*)
    ds=$(git diff -U0 "$range" -- "$f" | grep -n '^+' | grep -iE 'status:|remaining work|awaiting (owner|review|acceptance)|blocked on|not started|not yet built|slice [0-9]|stage [0-9]+ (is|of)' | head -3 || true)
    [ -z "$ds" ] || { warn "$f: dynamic-state wording added to a durable doc (vesper-docs: that is board state):"; sed 's/^/        /' <<<"$ds"; } ;;
  esac
done

# --- lint:authz touch gate ---------------------------------------------------------------------
for f in "${files[@]}"; do
  case "$f" in apps/web/src/app/api/*\[*\]*route.ts)
    [ -f "$f" ] || continue
    if grep -q 'withUser(' "$f" && ! grep -qE 'withAuthorizedResource|withOwnedEntity|withOwnerAdmin|withCrossAccountSupport' "$f"; then
      warn "$f: touched legacy bare-withUser route — lint:authz fails on ANY edit; migrate the wrapper or revert the file out of the diff"
    fi ;;
  esac
done

# --- census-guarded files ------------------------------------------------------------------------
for f in "${files[@]}"; do
  case "$f" in */chat-look.ts|*/chat-reference-images.ts)
    if git diff -U0 "$range" -- "$f" | grep -q '^+.*[aA]geAnchor'; then
      warn "$f: 'ageAnchor' added (comments count) — age-context-separation.test.ts greps the source text"
    fi ;;
  esac
done

# --- tests ---------------------------------------------------------------------------------------
newtests=$(git diff --name-status "$range" | awk '$1 == "A" && $2 ~ /\.test\.tsx?$/ {print $2}')
[ -z "$newtests" ] || { info "new test files — each should name the defect it kills (vesper-testing):"; sed 's/^/        /' <<<"$newtests"; }

echo
git --no-pager diff --stat "$range" | tail -1
echo "$fails FAIL, $warns WARN"
[ "$fails" -eq 0 ]
