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

Manual report:  python3 .claude/hooks/preflight.py --report [dir]
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
# CodeBuild validates; a local lint:package-resolution took the desktop down.
# The settings deny list catches the bare families; this catches every
# `pnpm test:*` / `pnpm lint:*` sub-script, `pnpm run …`, and scripts/verify.sh,
# which the deny syntax (space-star prefixes only) cannot express.
GATE_SCRIPT = re.compile(r"^(test|lint|typecheck|verify|vitest)(?::[\w.-]+)?$")
GATE_ALLOWED = {"lint:docs"}  # sanctioned for documentation-only changes (CLAUDE.md)
PNPM_PASSTHROUGH = {"run", "exec", "dlx", "-r", "--recursive", "-w", "--workspace-root", "--stream", "--parallel"}
RUNNERS = {"npx", "pnpx", "bunx"}  # `npx vitest …` — owner ruling 2026-09-04: no local vitest either
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


def gate_violation(seg: list[str]) -> str | None:
    """A local gate run: pnpm test/lint/typecheck/verify (any sub-script) or scripts/verify.sh."""
    if not seg:
        return None
    # running the script (directly or via a shell), not merely naming it
    invoked = seg[0] if seg[0] not in ("bash", "sh", "zsh", "source", ".") else (seg[1] if len(seg) > 1 else "")
    if invoked.endswith("scripts/verify.sh"):
        return "scripts/verify.sh"
    if os.path.basename(seg[0]) == "vitest":
        return "vitest"
    if seg[0] in RUNNERS and len(seg) > 1 and seg[1] == "vitest":
        return f"{seg[0]} vitest"
    if seg[0] != "pnpm":
        return None
    i = 1
    while i < len(seg):
        t = seg[i]
        if t in PNPM_PASSTHROUGH or t.startswith("--workspace-concurrency") or t.startswith("--filter="):
            i += 1
        elif t in ("--filter", "-F", "-C", "--dir"):
            i += 2
        else:
            break
    if i >= len(seg):
        return None
    script = seg[i]
    if GATE_SCRIPT.match(script) and script not in GATE_ALLOWED:
        return f"pnpm {script}"
    return None


def check(command: str, start_cwd: str) -> tuple[str | None, str | None]:
    """Return (deny_reason, context). deny_reason set means block."""
    tokens = tokenize(command)
    for raw in segments(tokens):
        gate = gate_violation(strip_env_prefix(raw))
        if gate:
            return (
                f"[vesper preflight] `{gate}` is a local gate run, and those are off-limits here "
                "(owner ruling 2026-08-22, tightened 2026-08-24 after a local lint run coincided with the desktop "
                "crashing). CI on CodeBuild is the gate: push the branch and read the result "
                "(.claude/skills/vesper-pr-review/wait-ci.sh, ci-failure.sh). Diagnose from CI logs and by reading code. "
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
    if not any(k in command for k in ("fly", "git", "pnpm", "verify.sh", "vitest")):
        return 0
    start = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

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
