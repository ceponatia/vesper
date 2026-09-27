#!/usr/bin/env python3
"""Read-only, deliberately limited structural checks for repository skills."""

import argparse
import json
import re
from pathlib import Path

# rolesync mirrors each canonical skill into `.claude/skills/<name>/` byte for byte
# and skips these transient files, so the comparison below skips the same ones.
IGNORED_DIRS = {"__pycache__"}
IGNORED_NAMES = {".DS_Store", "Thumbs.db"}
IGNORED_SUFFIXES = (".pyc", ".swp", ".swo", "~")


def mirrored_files(root):
    """Relative path -> (bytes, executable) for every file rolesync would mirror from `root`.

    The executable bit is compared because rolesync writes a mirrored file's bytes
    without its mode: a helper script it rewrites comes out non-executable, and a
    skill that runs `.claude/skills/<name>/<helper>.sh` then fails with
    `Permission denied` while the byte comparison still passes."""
    files = {}
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if any(part in IGNORED_DIRS for part in rel.parts):
            continue
        if path.name in IGNORED_NAMES or path.name.endswith(IGNORED_SUFFIXES):
            continue
        if path.is_file():
            files[rel.as_posix()] = (path.read_bytes(), bool(path.stat().st_mode & 0o111))
    return files


def check(repo, names):
    root = repo / ".agents/skills"
    issues = []

    def issue(code, path, detail):
        issues.append({"code": code, "path": str(path), "detail": detail})

    if not root.is_dir():
        issue("missing-root", root, "Canonical skill root is missing.")
    if not names and root.is_dir():
        names = sorted(p.name for p in root.iterdir() if p.is_dir() or p.is_symlink())
    for name in names:
        skill = root / name
        if skill.is_symlink() or not skill.is_dir():
            issue("canonical-directory", skill, "Expected a real canonical directory.")
            continue
        for required in ("SKILL.md", "agents/openai.yaml"):
            if not (skill / required).is_file():
                issue("missing-resource", skill / required, "Required skill file is missing.")
        mirror = repo / ".claude/skills" / name
        if mirror.is_symlink() or not mirror.is_dir():
            issue("claude-mirror", mirror, "Expected rolesync's generated copy of the canonical skill; run `rolesync sync`.")
        elif mirrored_files(mirror) != mirrored_files(skill):
            issue("claude-mirror", mirror, "Generated copy differs from the canonical skill in content or "
                  "executable bit; run `rolesync sync`, then restore executable bits with `chmod +x`.")
    return {
        "scope": "structural", "passed": not issues, "skills": names, "issues": issues,
        "unverified": ["YAML schema", "reference paths and Markdown links", "runtime discovery",
                       "tool availability and hook attachment", "routing and helper behavior"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="Skill names; omit to check all repository skills")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    args = parser.parse_args()
    if any(not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) for name in args.names):
        parser.error("Use skill names, not paths.")
    try:
        report = check(args.repo.resolve(), args.names)
    except OSError as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
