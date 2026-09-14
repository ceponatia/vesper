#!/usr/bin/env python3
"""PreToolUse hook for Bash: the Vesper deploy and commit preflight.

Two hazards this checkout has actually hit, both invisible from the command
line the moment it is typed:

* `fly deploy` ships the WORKING TREE of the directory it runs in. A session
  restart silently drops the worktree binding, so the "same" command can run
  in the main checkout where another session keeps half-done work, including
  untracked migrations that would run against Neon.
* `git commit` with no pathspec commits the whole index. Concurrent sessions
  stage files in this checkout mid-task; one docs commit swept in nine of
  someone else's renames.

The hook refuses both when the state says so and explains what it saw. It
never blocks on its own failure: any internal error exits 0 (fail open).

Acknowledgements, when you have looked and mean it:
  VESPER_DEPLOY_DIRTY_OK=1 fly deploy …      ship a dirty tree on purpose
  VESPER_INDEX_OK=1 git commit -m … …        commit a pre-populated index

Manual report:  python3 .codex/hooks/preflight.py --report [dir]
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

ACK_DEPLOY = "VESPER_DEPLOY_DIRTY_OK=1"
ACK_INDEX = "VESPER_INDEX_OK=1"
# Local gate runs are an owner ruling (2026-08-22, tightened 2026-08-24):
# CI validates; a local lint:package-resolution took the desktop down.
# The settings deny list catches the bare families; this catches every
# `pnpm test:*` / `pnpm lint:*` sub-script, `pnpm run …`, and scripts/verify.sh,
# which the deny syntax (space-star prefixes only) cannot express.
GATE_SCRIPT = re.compile(r"^(test|lint|typecheck|verify|vitest|build)(?::[\w.-]+)?$")
GATE_ALLOWED = {"lint:docs"}  # sanctioned for documentation-only changes (AGENTS.md)
PNPM_PASSTHROUGH = {"run", "exec", "dlx", "-r", "--recursive", "-w", "--workspace-root", "--stream", "--parallel"}
RUNNERS = {"npx", "pnpx", "bunx"}  # `npx vitest …` — owner ruling 2026-09-04: no local vitest either
# Runner options that consume the NEXT token, so the checker is not simply the
# word after the runner. `npx --package=typescript -- tsc` and `npx --yes tsc`
# are documented npm-exec spellings, and reading only the first argument let
# both through (PR review, 2026-09-14).
RUNNER_VALUE_OPTS = {"--package", "-p", "--userconfig", "--cache", "--shell", "--npm", "--node-arg"}
# `-c`/`--call` runs its value as a shell string: `npx -c "tsc --noEmit"`. The
# command lives inside one token, so it is re-tokenized rather than skipped.
RUNNER_CALL_OPTS = {"-c", "--call"}
# The checkers themselves, caught by basename so a path-qualified or
# runner-prefixed spelling lands the same way: `tsc`, `npx tsc`,
# `pnpm exec tsc`, `./node_modules/.bin/tsc`.
#
# Naming the pnpm scripts was not enough. A worker that had read the ban
# reasoned its way to "a throwaway tsconfig, outside the project" because the
# rule it had been given was a list of command names and its command was not on
# it. The gate is the CHECK, not the spelling: a config written to resolve this
# repository's dependency types is an application typecheck wherever it sits.
GATE_BINARIES = {"tsc", "tsgo", "eslint", "vitest", "jest", "tsd", "attw"}
# Same idea for the bundlers, which only count when actually building: `next`
# and `vite` also front `next dev` / `vite preview`, which the run workflow owns.
GATE_BUILDERS = {"next": {"build"}, "vite": {"build"}, "turbo": {"build", "run"}}
# Substrings that make `main` bother tokenizing at all. Derived from the rules
# above rather than retyped, so a checker added to either set stays reachable.
PREFILTER = ("fly", "git", "pnpm", "verify.sh", *sorted(GATE_BINARIES), *sorted(GATE_BUILDERS))
SEPARATORS = {"&&", "||", ";", "|", "&"}
COMMIT_VALUE_OPTS = {
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c",
    "--reedit-message", "--author", "--date", "-t", "--template", "--trailer",
    "--fixup", "--squash", "--cleanup", "--pathspec-from-file", "-S", "--gpg-sign",
}
SWEEP_ADD = {"-A", "--all", ".", ":/", "-u", "--update", "--no-ignore-removal"}
LIMIT = 30


def git(cwd: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=15
    ).stdout.rstrip("\n")


def is_repo(cwd: str) -> bool:
    r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True, timeout=15)
    return r.returncode == 0


def tokenize(command: str) -> list[str]:
    lex = shlex.shlex(command, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)


def segments(tokens: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    cur: list[str] = []
    for t in tokens:
        if t in SEPARATORS or set(t) <= set("&|;"):
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        out.append(cur)
    return out


def strip_env_prefix(seg: list[str]) -> list[str]:
    i = 0
    if seg and seg[0] == "env":
        i = 1
    while i < len(seg) and "=" in seg[i] and not seg[i].startswith("-"):
        i += 1
    return seg[i:]


def resolve(base: str, path: str) -> str:
    path = os.path.expanduser(path)
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(base, path))


def deploy_report(cwd: str) -> tuple[bool, str]:
    """(clean, text). Clean means nothing modified or untracked."""
    if not is_repo(cwd):
        return True, f"{cwd} is not a git checkout — nothing to check"
    branch = git(cwd, "branch", "--show-current") or "(detached)"
    head = git(cwd, "rev-parse", "--short", "HEAD")
    status = git(cwd, "status", "--porcelain", "--untracked-files=normal")
    lines = status.splitlines()
    rel = ""
    try:
        lr = git(cwd, "rev-list", "--left-right", "--count", "origin/main...HEAD")
        behind, ahead = lr.split()
        rel = f", {ahead} ahead / {behind} behind origin/main"
    except Exception:
        pass
    head_line = f"{cwd}: branch {branch} @ {head}{rel}"
    if not lines:
        return True, f"{head_line}, tree clean"
    shown = "\n".join("  " + l for l in lines[:LIMIT])
    more = f"\n  … and {len(lines) - LIMIT} more" if len(lines) > LIMIT else ""
    return False, f"{head_line}, tree NOT clean ({len(lines)} entries):\n{shown}{more}"


def commit_pathspec(args: list[str]) -> tuple[bool, bool]:
    """(has_pathspec, all_flag) for the tokens after `git commit`."""
    has_path = False
    all_flag = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            has_path = has_path or i + 1 < len(args)
            break
        if a in ("-a", "--all"):
            all_flag = True
        elif a.startswith("-") and not a.startswith("--") and len(a) > 2 and "=" not in a:
            # combined short flags such as -am / -asm
            if "a" in a[1:]:
                all_flag = True
            if any(ch in "mFCct" for ch in a[1:]) and i + 1 < len(args) and a[-1] in "mFCct":
                i += 1
        elif a in COMMIT_VALUE_OPTS:
            i += 1
        elif a.startswith("-"):
            pass
        else:
            has_path = True
        i += 1
    return has_path, all_flag


def skip_runner_options(seg: list[str], start: int) -> tuple[int, str | None]:
    """Advance past a runner's own options to the command it will run.

    Returns `(index, call_value)`. A `--` ends the options outright; a
    value-taking option consumes two tokens; any other `-` token consumes one.
    `call_value` is set when the command was handed over as a shell string
    instead, which the caller re-tokenizes.
    """
    i = start
    while i < len(seg):
        token = seg[i]
        if token == "--":
            return i + 1, None
        if token in RUNNER_CALL_OPTS:
            return i + 2, (seg[i + 1] if i + 1 < len(seg) else None)
        if token in RUNNER_VALUE_OPTS:
            i += 2
            continue
        if token.startswith("-"):
            # `--package=typescript` carries its value inline; a bare flag such
            # as `--yes` carries none. Either way it is one token.
            i += 1
            continue
        return i, None
    return i, None


def gate_behind(seg: list[str], start: int) -> str | None:
    """The checker a runner is about to execute, past that runner's options."""
    index, call = skip_runner_options(seg, start)
    if call is not None:
        inner = tokenize(call)
        return gate_binary(inner[0]) or gate_builder(inner, 0) if inner else None
    if index >= len(seg):
        return None
    return gate_binary(seg[index]) or gate_builder(seg, index)


def gate_binary(token: str) -> str | None:
    """The checker a token names, ignoring any directory and `.cmd`/`.exe` tail."""
    base = os.path.basename(token)
    for suffix in (".cmd", ".exe", ".ps1", ".bat", ".js", ".mjs"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return base if base in GATE_BINARIES else None


def gate_builder(seg: list[str], start: int) -> str | None:
    """`next build` / `vite build` / `turbo run …`, at `start` in the segment."""
    if start >= len(seg):
        return None
    base = os.path.basename(seg[start])
    subcommands = GATE_BUILDERS.get(base)
    if subcommands is None:
        return None
    following = [t for t in seg[start + 1 :] if not t.startswith("-")]
    if following and following[0] in subcommands:
        return f"{base} {following[0]}"
    return None


def gate_violation(seg: list[str]) -> str | None:
    """A local application gate: the checkers themselves however invoked, a
    pnpm test/lint/typecheck/verify script, or scripts/verify.sh."""
    if not seg:
        return None
    # running the script (directly or via a shell), not merely naming it
    invoked = seg[0] if seg[0] not in ("bash", "sh", "zsh", "source", ".") else (seg[1] if len(seg) > 1 else "")
    if invoked.endswith("scripts/verify.sh"):
        return "scripts/verify.sh"

    # The checker invoked directly, at the head of the segment or behind a
    # runner. `pnpm exec tsc` reaches this through the passthrough walk below.
    direct = gate_binary(seg[0]) or gate_builder(seg, 0)
    if direct:
        return direct
    if seg[0] in RUNNERS and len(seg) > 1:
        behind = gate_behind(seg, 1)
        if behind:
            return f"{seg[0]} {behind}"

    if seg[0] != "pnpm":
        return None

    # Scan every token rather than parsing pnpm's option grammar to locate the
    # script position.
    #
    # Locating it was tried twice and leaked twice. A hard-coded option list
    # stopped dead at the first unlisted option, so `pnpm --silent exec tsc`
    # read `--silent` as the script. Skipping any `-` token fixed that and left
    # the separate-value form — `pnpm --loglevel error exec tsc` consumes one
    # token, lands on `error`, and calls that the script. Neither default is
    # right for both, because whether an option takes a value is knowledge that
    # lives in pnpm and drifts: every gap between that table and the real
    # grammar is an allow, and an allow here is a silent full typecheck.
    #
    # So this errs the other way. Any gate name anywhere in a pnpm segment
    # refuses it, which costs `pnpm ls vitest` and `pnpm why eslint` — rare
    # inspection commands with obvious alternatives, and the refusal says why.
    # `pnpm lint:docs` stays allowed through GATE_ALLOWED, as does any token
    # that merely contains a gate name (`lint-staged`, `test-utils`), since
    # GATE_SCRIPT is anchored.
    for i in range(1, len(seg)):
        token = seg[i]
        if GATE_SCRIPT.match(token) and token not in GATE_ALLOWED:
            return f"pnpm {token}"
        behind_pnpm = gate_binary(token) or gate_builder(seg, i)
        if behind_pnpm:
            return f"pnpm {behind_pnpm}"
    return None


def check(command: str, start_cwd: str) -> tuple[str | None, str | None]:
    """Return (deny_reason, context). deny_reason set means block."""
    tokens = tokenize(command)
    for raw in segments(tokens):
        gate = gate_violation(strip_env_prefix(raw))
        if gate:
            return (
                f"[vesper preflight] `{gate}` is a local application gate, and those are off-limits here "
                "(owner ruling 2026-08-22, tightened 2026-08-24 after a local lint run coincided with the desktop "
                "crashing). The ban is on the CHECK, not on how it is spelled or where it runs: a hand-written or "
                "throwaway tsconfig, a copy of the sources in a temp directory, and a different working directory are "
                "all the same typecheck, because each one resolves this repository's code or dependency types. Do not "
                "look for a spelling that gets through. "
                "CI on GitHub-hosted runners is the gate: push the branch and read the result "
                "(.agents/skills/vesper-pr-review/wait-ci.sh, ci-failure.sh). Diagnose from CI logs and by reading code. "
                "Satisfy a compiler constraint by construction instead — under `noUncheckedIndexedAccess` an indexed "
                "read is `T | undefined`, so guard it with an explicit `=== undefined` or length check and never a "
                "non-null assertion, which `no-non-null-assertion` forbids anyway. Report a genuine type ambiguity to "
                "the parent rather than reconstructing a compiler. "
                "Only `pnpm lint:docs` is sanctioned locally, for documentation-only changes.",
                None,
            )
    ack_deploy = any(t == ACK_DEPLOY for t in tokens)
    ack_index = any(t == ACK_INDEX for t in tokens)
    cwd = start_cwd
    sweep_add = False
    context: list[str] = []

    for raw in segments(tokens):
        seg = strip_env_prefix(raw)
        if not seg:
            continue
        head = seg[0]

        if head in ("cd", "pushd") and len(seg) >= 2:
            cwd = resolve(cwd, seg[1])
            continue

        if head in ("fly", "flyctl") and "deploy" in seg[1:]:
            clean, text = deploy_report(cwd)
            if clean or ack_deploy:
                context.append(f"[vesper preflight] fly deploy from {text}"
                               + (" (dirty tree acknowledged)" if not clean else ""))
            else:
                return (
                    "[vesper preflight] `fly deploy` ships the WORKING TREE, and this one is not clean.\n"
                    f"{text}\n"
                    "Deploy from a clean checkout (commit, or `git worktree add <scratch> <sha>` and deploy "
                    f"there). To ship these changes on purpose, re-run with {ACK_DEPLOY} in front of the command.",
                    None,
                )
            continue

        if head != "git":
            continue

        # git global options
        i = 1
        gcwd = cwd
        while i < len(seg) and seg[i].startswith("-"):
            if seg[i] == "-C" and i + 1 < len(seg):
                gcwd = resolve(cwd, seg[i + 1]); i += 2
            elif seg[i].startswith("-C") and len(seg[i]) > 2:
                gcwd = resolve(cwd, seg[i][2:]); i += 1
            elif seg[i] == "-c" and i + 1 < len(seg):
                i += 2
            else:
                i += 1
        if i >= len(seg):
            continue
        sub, rest = seg[i], seg[i + 1:]

        if sub == "add":
            if any(t in SWEEP_ADD for t in rest):
                sweep_add = True
            continue

        if sub != "commit" or not is_repo(gcwd):
            continue
        has_path, all_flag = commit_pathspec(rest)
        if has_path or ack_index or "--dry-run" in rest:
            continue
        branch = git(gcwd, "branch", "--show-current") or "(detached)"
        if all_flag or sweep_add:
            status = git(gcwd, "status", "--porcelain", "--untracked-files=normal").splitlines()
            if not status:
                continue
            shown = "\n".join("  " + l for l in status[:LIMIT])
            return (
                f"[vesper preflight] this commit sweeps the whole working tree of {gcwd} ({branch}) — "
                f"`-a` / `git add -A` stage everything, including other sessions' work:\n{shown}\n"
                f"Commit by pathspec instead: git add <paths> && git commit -m \"…\" -- <paths>. "
                f"If every entry above is yours, re-run with {ACK_INDEX} in front of the command.",
                None,
            )
        staged = git(gcwd, "diff", "--cached", "--name-status").splitlines()
        if not staged:
            continue
        shown = "\n".join("  " + l for l in staged[:LIMIT])
        return (
            f"[vesper preflight] `git commit` with no pathspec would commit everything already staged in "
            f"{gcwd} ({branch}):\n{shown}\n"
            "Other sessions stage work in this checkout. Commit by pathspec — git commit -m \"…\" -- <paths> — "
            f"or, if every entry above is yours, re-run with {ACK_INDEX} in front of the command.",
            None,
        )

    return None, "\n".join(context) if context else None


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--report":
        target = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.getcwd()
        clean, text = deploy_report(target)
        print(text)
        return 0 if clean else 1

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    # Cheap prefilter before the tokenizer. Every gate this hook refuses must
    # have a substring here or `check` never sees it: `npx tsc --noEmit` carries
    # none of the original five keys and was allowed straight through, which made
    # the checker-binary rules below unreachable from the real entry point. A
    # false positive here costs one tokenize; a miss costs the whole gate.
    if not any(k in command for k in PREFILTER):
        return 0
    start = payload.get("cwd") or os.getcwd()

    try:
        deny, context = check(command, start)
    except Exception as exc:  # never break a tool call on our own bug
        print(f"[vesper preflight] skipped: {exc}", file=sys.stderr)
        return 0

    if deny:
        print(deny, file=sys.stderr)
        return 2
    if context:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "additionalContext": context}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
