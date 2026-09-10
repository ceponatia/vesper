#!/usr/bin/env bash
# Offline contract checks for Codex worktree naming, main-checkout resolution,
# the pnpm store lookup, and legacy cleanup lookup. No network, no real git.
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
MAIN="$TMP/repo"          # the main checkout git worktree list names first
SESSION="$TMP/session"    # the worktree the helper is invoked from
BIN="$TMP/bin"
LOG="$TMP/calls"
FAKE_HOME="$TMP/home"
mkdir -p "$MAIN" "$SESSION" "$BIN" "$FAKE_HOME"

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
      list)
        # Porcelain lists the main checkout first, then the other worktrees.
        [ "${FAKE_NO_WORKTREE_LIST:-0}" = 1 ] && exit 0
        printf 'worktree %s\nHEAD abc1234abc1234abc1234abc1234abc1234abcd\nbranch refs/heads/main\n\n' "$FAKE_MAIN"
        printf 'worktree %s\nHEAD def5678def5678def5678def5678def5678defa\nbranch refs/heads/codex/1-session\n\n' "$FAKE_ROOT"
        ;;
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

cat >"$BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm' >>"$FAKE_LOG"
printf ' %q' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"
EOF
chmod +x "$BIN/git" "$BIN/gh" "$BIN/pnpm"

# Invoked from the session worktree: --show-toplevel is SESSION, not MAIN.
run_up() {
  (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" "$SKILL_DIR/worktree-up.sh" "$@")
}

run_down() {
  (cd "$SESSION" && PATH="$BIN:$PATH" HOME="$FAKE_HOME" FAKE_LOG="$LOG" \
    FAKE_ROOT="$SESSION" FAKE_MAIN="$MAIN" "$SKILL_DIR/worktree-down.sh" "$@")
}

fail() { echo "$1" >&2; exit 1; }

output=$(run_up 42 feature --no-install)
grep -Fq "gh issue develop 42 --repo ceponatia/vesper --base main --name codex/42-feature --checkout --worktree $MAIN/.codex/worktrees/issue-42" "$LOG" \
  || fail "worktree-up did not target the main checkout"
! grep -Fq "$SESSION/.codex/worktrees" "$LOG" || fail "worktree-up nested the worktree in the invoking worktree"
grep -Fq "branch:   codex/42-feature @ abc1234" <<<"$output" || fail "worktree-up did not print the summary"
echo 'ok  worktree-up places the worktree under the main checkout from any checkout'

rm -rf "$MAIN/.codex"
: >"$LOG"
output=$(FAKE_LEGACY_BRANCH=1 run_up 42 feature --no-install)
grep -Fq "git -C $MAIN worktree add $MAIN/.codex/worktrees/issue-42 agent/42-feature" "$LOG" \
  || fail "worktree-up did not resume the legacy branch"
grep -Fq "legacy branch agent/42-feature" <<<"$output" || fail "worktree-up did not report the legacy branch"
echo 'ok  worktree-up resumes a legacy agent/<issue>-<slug> branch'

# No node_modules anywhere: the store lookup must fall through, not abort.
rm -rf "$MAIN/.codex"
: >"$LOG"
output=$(run_up 42 feature)
grep -Fq "node_modules linked offline from $FAKE_HOME/.local/share/pnpm/store" <<<"$output" \
  || fail "worktree-up did not fall back to the default store"
grep -Fq "pnpm install --offline --frozen-lockfile --store-dir $FAKE_HOME/.local/share/pnpm/store" "$LOG" \
  || fail "worktree-up did not run the offline install"
grep -Fq "worktree: $MAIN/.codex/worktrees/issue-42" <<<"$output" || fail "worktree-up did not print the summary after installing"
echo 'ok  worktree-up defaults the store and still summarizes without .modules.yaml'

# The main checkout's recorded store wins, with the /v<n> suffix stripped.
rm -rf "$MAIN/.codex"
mkdir -p "$MAIN/node_modules"
printf 'storeDir: %s/store/v10\nvirtualStoreDir: .pnpm\n' "$TMP" >"$MAIN/node_modules/.modules.yaml"
: >"$LOG"
output=$(run_up 42 feature)
grep -Fq "node_modules linked offline from $TMP/store" <<<"$output" || fail "worktree-up ignored the recorded store"
echo 'ok  worktree-up reads the main checkout store and strips the version suffix'

# Fallback when worktree list yields nothing (not a worktree-aware git).
rm -rf "$MAIN/.codex" "$MAIN/node_modules"
: >"$LOG"
output=$(FAKE_NO_WORKTREE_LIST=1 run_up 42 feature --no-install)
grep -Fq "worktree: $SESSION/.codex/worktrees/issue-42" <<<"$output" \
  || fail "worktree-up did not fall back to --show-toplevel"
echo 'ok  worktree-up falls back to --show-toplevel when the list is empty'

# Removal by issue number resolves under the main checkout too.
rm -rf "$SESSION/.codex"
mkdir -p "$MAIN/.codex/worktrees/issue-42"
: >"$LOG"
output=$(run_down 42)
grep -Fq "removed $MAIN/.codex/worktrees/issue-42" <<<"$output" || fail "worktree-down did not find the main-checkout worktree"
grep -Fq "kept branch agent/42-feature @ abc1234" <<<"$output" || fail "worktree-down did not keep the branch"
echo 'ok  worktree-down resolves an issue number under the main checkout'

rm -rf "$MAIN/.codex"
mkdir -p "$MAIN/.claude/worktrees/agent-42"
: >"$LOG"
output=$(run_down 42)
grep -Fq "git -C $MAIN/.claude/worktrees/agent-42 status --porcelain" "$LOG" || fail "worktree-down skipped the dirty check"
grep -Fq "removed $MAIN/.claude/worktrees/agent-42" <<<"$output" || fail "worktree-down did not find the legacy worktree"
echo 'ok  worktree-down still finds a legacy .claude/worktrees/agent-<issue>'

echo "worktree path fixtures passed"
