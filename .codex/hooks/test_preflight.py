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
    "sed -n '1,40p' apps/web/src/lib/media-preview.ts",
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
for binary in sorted(set(preflight.GATE_BINARIES) | set(preflight.GATE_BUILDERS)):
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
