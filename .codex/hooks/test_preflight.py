#!/usr/bin/env python3
"""Offline fixtures for the preflight hook's local-application-gate detection.

Imports the hook and the standard library only: no application code, no
service, no external mutation, so this runs locally under the fixture exception
in `AGENTS.md`.

Two rules are pinned here.

The first is that the gate is the CHECK rather than its spelling. A worker that
had read the ban still reasoned its way to "a throwaway tsconfig, outside the
project", because the rule it had been given was a list of command names and its
command was not on that list.

The second is why these drive `main()` over stdin rather than calling `check()`:
`main` prefilters on substrings before it tokenizes anything, and the original
five keys did not include the checker binaries — so `npx tsc --noEmit` returned
"allow" without `check` ever running. A suite that called `check` directly would
have passed against a hook that refused nothing. Test the entry point the hook
framework actually calls.

    python .codex/hooks/test_preflight.py
"""
from __future__ import annotations

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import preflight  # noqa: E402

CWD = os.path.dirname(os.path.abspath(__file__))
ALLOW, DENY = 0, 2


def run(command: str) -> tuple[int, str]:
    """Drive the hook exactly as the framework does: JSON on stdin, exit code out."""
    payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": CWD}
    stdin, stderr, stdout = sys.stdin, sys.stderr, sys.stdout
    sys.stdin = io.StringIO(json.dumps(payload))
    sys.stderr = io.StringIO()
    sys.stdout = io.StringIO()
    try:
        code = preflight.main()
        return code, sys.stderr.getvalue()
    finally:
        sys.stdin, sys.stderr, sys.stdout = stdin, stderr, stdout


# Each must be refused, with the evasion it closes.
REFUSED = [
    ("pnpm test", "the named script"),
    ("pnpm test:engine", "a sub-script"),
    ("pnpm run typecheck", "behind `run`"),
    ("pnpm lint", "the lint family"),
    ("pnpm verify", "the aggregate"),
    ("vitest run", "the bare runner"),
    ("npx vitest", "behind a runner"),
    ("pnpm exec vitest", "behind pnpm exec"),
    ("bash scripts/verify.sh", "the script through a shell"),
    ("tsc", "the compiler, bare"),
    ("tsc --noEmit", "the compiler with flags"),
    ("tsc -p /tmp/throwaway/tsconfig.json", "a throwaway config outside the project"),
    ("npx tsc --noEmit -p apps/web", "behind npx"),
    ("pnpm exec tsc", "behind pnpm exec"),
    ("./node_modules/.bin/tsc", "path-qualified"),
    ("/c/Users/x/node_modules/.bin/tsc --noEmit", "absolute path"),
    ("node_modules/.bin/tsc.cmd", "the Windows shim"),
    ("tsgo --noEmit", "the other compiler"),
    ("eslint apps/web/src", "the linter, bare"),
    ("npx eslint .", "the linter behind npx"),
    ("pnpm dlx eslint .", "the linter behind dlx"),
    ("next build", "the production build"),
    ("vite build", "the other build"),
    ("cd /tmp/scratch && tsc -p tsconfig.json", "after a cd, in its own segment"),
    ("VESPER_INDEX_OK=1 tsc --noEmit", "behind an env prefix"),
    ("git status && npx tsc --noEmit", "chained after allowed work"),
    # Runner options sit between the runner and the checker in every documented
    # npm-exec spelling, so reading only the first argument missed all of these
    # (PR review, 2026-09-14). `-p` and `-y` are the short forms; the pnpm walk
    # had the same hole one layer down.
    ("npx --package=typescript -- tsc --noEmit", "--package= then a -- separator"),
    ("npx --yes tsc", "a bare flag before the checker"),
    ("npx -y tsc --noEmit", "the short flag"),
    ("npx -p typescript tsc", "--package's short form, value-taking"),
    ("npx --package typescript tsc --noEmit", "--package with a separate value"),
    ("npx -c \"tsc --noEmit\"", "the checker inside a --call shell string"),
    ("pnpm exec --package=typescript tsc", "the same hole in the pnpm walk"),
    ("pnpm dlx --yes eslint .", "a flag before the linter"),
    ("npx --package=x -- next build", "a bundler behind the separator"),
    # pnpm's own global options sit before the subcommand, in both the inline
    # and the separate-value form. Locating the script position was tried twice
    # and leaked twice (PR review, 2026-09-14, twice): a fixed option list
    # stopped at the first unlisted option, and skipping any dash token left the
    # separate-value form landing on the value. The segment is scanned now.
    ("pnpm --silent exec tsc --noEmit", "a global flag before the subcommand"),
    ("pnpm --dir=apps/web exec tsc --noEmit", "an inline-value global option"),
    ("pnpm --dir apps/web exec tsc", "a separate-value global option"),
    ("pnpm -C apps/web exec tsc", "its short form"),
    ("pnpm --loglevel error exec tsc --noEmit", "a value that is not itself an option"),
    ("pnpm --workspace-concurrency 1 exec tsc", "a numeric option value"),
    ("pnpm --reporter default exec tsc", "a value that looks like a script name"),
    ("pnpm --silent test", "a global flag before a gate script"),
    # The CI integration launchers (#638) run the app-int suite against a local
    # database — `ci-integration.mjs` drops, creates and migrates it first — so
    # they are the same gate however they are reached, like scripts/verify.sh.
    ("node scripts/ci-integration.mjs --mode=strict --shard=1/2", "the launcher, the way CI calls it"),
    ("node ./scripts/ci-integration.mjs --mode=legacy", "a ./ prefix"),
    ("node /home/brian/projects/vesper/scripts/ci-integration.mjs --mode=strict", "an absolute path"),
    ("node --env-file=.env scripts/ci-integration.mjs --mode=strict", "a node option before the script"),
    ("node --import tsx scripts/ci-integration.mjs --mode=strict", "a separate-value node option"),
    ("cd scripts && node ci-integration.mjs --mode=strict", "from inside scripts/, by file name"),
    ("pnpm exec node scripts/ci-integration.mjs --mode=strict", "behind pnpm exec node"),
    ("pnpm exec scripts/ci-integration.mjs --mode=strict", "run through pnpm exec directly"),
    ("npx node scripts/ci-integration.mjs --mode=strict", "behind a runner"),
    ("./scripts/ci-integration.mjs --mode=strict", "executed directly"),
    ("bash scripts/ci-integration.mjs", "handed to a shell"),
    ("tsx scripts/ci-integration.mjs --mode=strict", "another JS runtime"),
    ("VESPER_INTEGRATION_MODE=strict node scripts/ci-integration.mjs", "behind an env prefix"),
    ("git status && node scripts/ci-integration.mjs --mode=legacy", "chained after allowed work"),
    ("node scripts/integration-plan.mjs --out=/tmp/plan.json --shard=1/2", "the planner, which loads Vitest"),
    ("node ./scripts/integration-plan.mjs --out=plan.json", "the planner with a ./ prefix"),
    ("pnpm exec node scripts/integration-plan.mjs --out=plan.json", "the planner behind pnpm exec node"),
]

# Each must keep working. A hook that blocks ordinary work gets routed around.
ALLOWED = [
    "pnpm lint:docs",
    "node scripts/check-docs.mjs",
    "git status --porcelain",
    "gh pr view 593 --repo ceponatia/vesper",
    "grep -rn tsc apps/web/src",
    "cat apps/web/tsconfig.json",
    "ls node_modules/.bin",
    "echo 'run pnpm typecheck in CI'",
    "python .codex/hooks/test_preflight.py",
    "bash .agents/skills/vesper-agent-build/tests/worktree-paths.sh",
    "pnpm install --offline --frozen-lockfile",
    "next dev",
    "rg --files-with-matches eslint",
    "npx --yes prettier --check .",
    "npx --package=cowsay -- cowsay hello",
    # The scan errs toward refusing a pnpm segment, so these pin the line it
    # must not cross: ordinary installs and inspection, and the documented
    # documentation exception, in their optioned forms too.
    "pnpm --silent install",
    "pnpm run lint:docs",
    "pnpm add -D typescript",
    "pnpm why lint-staged",
    "pnpm install --prefer-offline",
    "sed -n '1,40p' apps/web/src/lib/media-preview.ts",
    # The integration policy's git census runs no tests, and naming a launcher
    # is not running it.
    "node scripts/integration-policy.mjs census",
    "node scripts/integration-policy.mjs census --json",
    "pnpm census:integration",
    "cat scripts/ci-integration.mjs",
    "sed -n '1,80p' scripts/integration-plan.mjs",
    "git diff -- scripts/ci-integration.mjs scripts/integration-plan.mjs",
    "git add scripts/ci-integration.mjs",
    "grep -n buildVitestArgs scripts/ci-integration.mjs",
    "node -e 'import(\"./scripts/ci-integration.mjs\").then((m) => console.log(m.parseShard(\"1/2\")))'",
]

failures: list[str] = []

for command, why in REFUSED:
    code, message = run(command)
    if code != DENY:
        failures.append("NOT REFUSED (%s): %s" % (why, command))
    elif "local application gate" not in message:
        failures.append("refused without the principle: %s" % command)

for command in ALLOWED:
    code, message = run(command)
    if code == DENY:
        failures.append("WRONGLY REFUSED: %s -> %s" % (command, message.strip()[:90]))

# Every gate must survive main's substring prefilter, which is what silently
# unreachable rules look like from the outside.
for binary in sorted(set(preflight.GATE_BINARIES) | set(preflight.GATE_BUILDERS) | set(preflight.GATE_LAUNCHERS)):
    if not any(key in binary for key in preflight.PREFILTER):
        failures.append("PREFILTER MISSES %r — check() would never see it" % binary)

# The refusal has to teach, or the next attempt is another spelling.
_code, message = run("tsc -p /tmp/throwaway/tsconfig.json")
for phrase in ("not on how it is spelled", "throwaway tsconfig", "noUncheckedIndexedAccess", "CI on GitHub-hosted runners"):
    if phrase not in message:
        failures.append("refusal text is missing %r" % phrase)

if failures:
    for line in failures:
        print("FAIL  " + line)
    print("\n%d checks failed" % len(failures))
    raise SystemExit(1)

print("ok  %d gate evasions refused through main()" % len(REFUSED))
print("ok  %d ordinary commands still allowed" % len(ALLOWED))
print("ok  every gate binary survives the prefilter")
print("ok  the refusal names the principle, not just the command")
print("preflight gate fixtures passed")
