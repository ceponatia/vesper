#!/usr/bin/env bash
# Deliberate batch-checkpoint gates for the RAM-constrained dev machine.
# Runs lint and typecheck SERIALLY, each inside a memory-capped systemd scope,
# and refuses to start without RAM headroom — so a runaway gate is OOM-killed
# inside its own cgroup instead of taking the desktop down with it.
#
# This is the ONLY sanctioned way to run these gates locally, and only as a
# deliberate batch checkpoint — never automatically per task (CLAUDE.md
# "Validation"). Tests, jscpd, evals, and the production build stay CI-only.
set -euo pipefail

MIN_AVAILABLE_MIB=4500   # refuse below this — close Brave/Docker and retry
WARN_AVAILABLE_MIB=6500  # below this it runs, but expect zram swapping

available_mib=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
if (( available_mib < MIN_AVAILABLE_MIB )); then
  echo "gates:local: only ${available_mib} MiB available (need ${MIN_AVAILABLE_MIB}). Close apps and retry." >&2
  exit 1
fi
if (( available_mib < WARN_AVAILABLE_MIB )); then
  echo "gates:local: ${available_mib} MiB available — will run, but expect swapping." >&2
fi

run_gate() {
  local name=$1
  shift
  echo "── gates:local: ${name} ──"
  systemd-run --user --scope --quiet \
    -p MemoryMax=8G -p MemorySwapMax=8G \
    env NODE_OPTIONS=--max-old-space-size=6144 nice -n 10 "$@"
}

target=${1:-all}
case "$target" in
  lint)      run_gate lint pnpm lint ;;
  typecheck) run_gate typecheck pnpm typecheck ;;
  all)
    run_gate lint pnpm lint
    run_gate typecheck pnpm typecheck
    ;;
  *)
    echo "usage: pnpm gates:local [lint|typecheck|all]" >&2
    exit 2
    ;;
esac

echo "gates:local: all requested gates passed."
