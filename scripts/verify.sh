#!/usr/bin/env bash
# RETIRED from the workflow (owner decision 2026-08-22). CI on AWS CodeBuild
# (.github/workflows/ci.yml) is the gate; nothing invokes this script and the
# `pnpm verify` / `pnpm verify:full` aliases are removed. It is kept only as a
# hand-run curiosity; prefer pushing the PR and letting CI validate.
#
# It runs each gate SERIALLY, one at a time, inside a memory-capped systemd
# scope, and refuses to start without RAM headroom — this is a 16 GB machine,
# and running the gates concurrently (the old `pnpm verify` chain, or CI's
# parallel jobs) is what used to tip it into earlyoom territory. Serial and
# capped is slower by the clock and survivable by the desktop.
set -euo pipefail

cd "$(dirname "$0")/.."

MIN_AVAILABLE_MIB=4500   # refuse below this — close Brave/Docker and retry
WARN_AVAILABLE_MIB=6500  # below this it runs, but expect zram swapping

usage() {
  cat >&2 <<'EOF'
usage: pnpm verify [target...]

Targets (default: all)
  all         lint, static checks, typecheck, unit tests, jscpd — the push gate
  full        all + engine (needs Postgres) + build — the pre-deploy gate

  lint        type-aware ESLint at --max-warnings 0
  static      circular imports, route authorization, package boundaries + resolution
  typecheck   tsc across the root, the app, and every package
  test        the pure Vitest suite (no database)
  jscpd       copy-paste threshold
  engine      DB-backed engine/rollout suite + Gate 1 benchmark (needs `pnpm db:up`)
  build       Next production build, heap-pinned to the Fly builder's 4 GB ceiling
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h | --help | help)
      usage
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# RAM headroom

available_mib=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
if [ -z "$available_mib" ]; then
  # MSYS2/Git Bash (Windows) exposes MemFree but no MemAvailable line. MemFree
  # understates true headroom (no reclaimable cache), so it is a conservative
  # stand-in; an empty probe still refuses below rather than passing silently.
  available_mib=$(awk '/MemFree/ {printf "%d", $2 / 1024; exit}' /proc/meminfo)
fi
: "${available_mib:=0}"
if ((available_mib < MIN_AVAILABLE_MIB)); then
  echo "verify: only ${available_mib} MiB available (need ${MIN_AVAILABLE_MIB}). Close apps and retry." >&2
  exit 1
fi
if ((available_mib < WARN_AVAILABLE_MIB)); then
  echo "verify: ${available_mib} MiB available — will run, but expect swapping." >&2
fi

# ---------------------------------------------------------------------------
# Sandboxing
#
# Each gate runs in its own systemd scope so a runaway gate is OOM-killed inside
# its own cgroup instead of taking the desktop down with it. Outside a systemd
# user session (a bare shell, a container) there is no scope to run in, so the
# gates still run — just uncapped, and the script says so once.

if systemd-run --user --scope --quiet true >/dev/null 2>&1; then
  SANDBOX=systemd
else
  SANDBOX=none
  echo "verify: no systemd user session — gates run uncapped (nice only)." >&2
fi

run_capped() {
  local mem=$1 heap=$2
  shift 2
  if [[ $SANDBOX == systemd ]]; then
    systemd-run --user --scope --quiet \
      -p "MemoryMax=${mem}" -p "MemorySwapMax=${mem}" \
      env "NODE_OPTIONS=--max-old-space-size=${heap}" nice -n 10 "$@"
  else
    env "NODE_OPTIONS=--max-old-space-size=${heap}" nice -n 10 "$@"
  fi
}

# ---------------------------------------------------------------------------
# Gates

failed=()
declare -A DURATIONS=()

gate() {
  local name=$1 mem=$2 heap=$3
  shift 3
  echo
  echo "── verify: ${name} ──"
  local started=$SECONDS
  if run_capped "$mem" "$heap" "$@"; then
    DURATIONS[$name]=$((SECONDS - started))
    return 0
  fi
  DURATIONS[$name]=$((SECONDS - started))
  failed+=("$name")
  echo "verify: ${name} FAILED" >&2
  return 0 # keep going: one report beats one failure at a time
}

gate_lint() { gate lint 8G 6144 pnpm lint; }

gate_static() {
  gate cycles 4G 4096 pnpm lint:cycles
  gate authz 4G 4096 pnpm lint:authz
  gate package-boundaries 4G 4096 pnpm lint:package-boundaries
  gate package-resolution 4G 4096 pnpm lint:package-resolution
}

gate_typecheck() { gate typecheck 8G 6144 pnpm typecheck; }
gate_test() { gate test 8G 6144 pnpm test; }
gate_jscpd() { gate jscpd 4G 4096 pnpm jscpd; }

# The engine suite needs the dev Postgres. Missing database is a hard failure
# here rather than a self-skip: the suites' own skip-tolerance is right for
# ordinary dev and wrong for a gate that claims to have verified something.
gate_engine() {
  if ! docker compose ps --status running --quiet 2>/dev/null | grep -q .; then
    echo "verify: engine gate needs the dev database — run \`pnpm db:up && pnpm db:migrate\` first." >&2
    failed+=(engine)
    return 0
  fi
  gate engine 8G 6144 env VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1 REQUIRE_INTEGRATION_DB=true pnpm test:engine
  gate engine-gate1-benchmark 4G 4096 pnpm eval:engine-gate1
}

# Heap pinned to 4096 to match the Dockerfile build stage: a build that would
# OOM on the Fly builder must fail here, before the deploy.
gate_build() { gate build 8G 4096 pnpm build; }

# ---------------------------------------------------------------------------
# Dispatch

run_target() {
  case "$1" in
    all)
      gate_lint
      gate_static
      gate_typecheck
      gate_test
      gate_jscpd
      ;;
    full)
      run_target all
      gate_engine
      gate_build
      ;;
    lint) gate_lint ;;
    static) gate_static ;;
    typecheck) gate_typecheck ;;
    test) gate_test ;;
    jscpd) gate_jscpd ;;
    engine) gate_engine ;;
    build) gate_build ;;
    *)
      echo "verify: unknown target '$1'" >&2
      usage
      exit 2
      ;;
  esac
}

targets=("$@")
((${#targets[@]})) || targets=(all)

started=$SECONDS
for target in "${targets[@]}"; do
  run_target "$target"
done
elapsed=$((SECONDS - started))

echo
for name in "${!DURATIONS[@]}"; do
  printf 'verify: %-28s %4ds\n' "$name" "${DURATIONS[$name]}"
done | sort

if ((${#failed[@]})); then
  echo
  echo "verify: FAILED after ${elapsed}s — ${failed[*]}" >&2
  exit 1
fi

echo
echo "verify: all gates passed in ${elapsed}s (${targets[*]})."
