#!/usr/bin/env bash
# Offline contract checks for Codex worktree naming and legacy cleanup lookup.
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT="$TMP/repo"
BIN="$TMP/bin"
LOG="$TMP/calls"
mkdir -p "$ROOT" "$BIN"

cat >"$BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"

location=""
if [ "${1:-}" = -C ]; then location=$2; shift 2; fi
case "${1:-}" in
  rev-parse)
    if [ "${2:-}" = --show-toplevel ]; then echo "$FAKE_ROOT"
    elif [ "${2:-}" = --short ]; then echo abc1234
    fi
    ;;
  fetch|prune) ;;
  show-ref)
    ref="${@: -1}"
    case "$ref" in
      refs/heads/codex/*) [ "${FAKE_CODEX_BRANCH:-0}" = 1 ] ;;
      refs/heads/agent/*) [ "${FAKE_LEGACY_BRANCH:-0}" = 1 ] ;;
      *) exit 1 ;;
    esac
    ;;
  worktree)
    shift
    case "${1:-}" in
      add)
        shift
        if [ "${1:-}" = -b ]; then shift 2; fi
        mkdir -p "$1"
        ;;
      remove)
        shift
        [ "${1:-}" = --force ] && shift
        rmdir "$1"
        ;;
      prune) ;;
    esac
    ;;
  branch)
    if [ "${2:-}" = --show-current ]; then echo agent/42-feature; fi
    ;;
  status) ;;
esac
EOF

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = --worktree ]; then mkdir -p "$2"; exit 0; fi
  shift
done
EOF
chmod +x "$BIN/git" "$BIN/gh"

run_up() {
  PATH="$BIN:$PATH" FAKE_LOG="$LOG" FAKE_ROOT="$ROOT" "$SKILL_DIR/worktree-up.sh" "$@"
}

run_down() {
  PATH="$BIN:$PATH" FAKE_LOG="$LOG" FAKE_ROOT="$ROOT" "$SKILL_DIR/worktree-down.sh" "$@"
}

output=$(run_up 42 feature --no-install)
grep -Fq "gh issue develop 42 --repo ceponatia/vesper --base main --name codex/42-feature --checkout --worktree $ROOT/.codex/worktrees/issue-42" "$LOG"
grep -Fq "branch:   codex/42-feature @ abc1234" <<<"$output"

rm -rf "$ROOT/.codex"
: >"$LOG"
output=$(FAKE_LEGACY_BRANCH=1 run_up 42 feature --no-install)
grep -Fq "git -C $ROOT worktree add $ROOT/.codex/worktrees/issue-42 agent/42-feature" "$LOG"
grep -Fq "legacy branch agent/42-feature" <<<"$output"

rm -rf "$ROOT/.codex"
mkdir -p "$ROOT/.claude/worktrees/agent-42"
: >"$LOG"
output=$(run_down 42)
grep -Fq "git -C $ROOT/.claude/worktrees/agent-42 status --porcelain" "$LOG"
grep -Fq "removed $ROOT/.claude/worktrees/agent-42" <<<"$output"

echo "worktree path fixtures passed"
