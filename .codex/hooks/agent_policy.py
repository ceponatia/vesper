#!/usr/bin/env python3
"""PreToolUse hook for the Agent tool: the Vesper subagent model policy.

The owner's ruling: delegated Vesper roles pin their own model so the
choice survives a missed `AGENTS.md` read — Sonnet for a bounded
implementation slice (`vesper-builder`), Opus for escalation, semantic
review, and test-keeping (`vesper-escalation`, `vesper-reviewer`,
`vesper-test-keeper`). This hook keeps a spawn from working around that:
an explicit `model` on a pinned role, an implementation brief handed to
anything else, or an escalation spawn with no record of what it is
escalating from.

It never blocks on its own failure: any internal error exits 0 (fail
open), same as `preflight.py`. It is Claude-only — the `Agent` tool has no
Codex equivalent, so every other `tool_name` passes through untouched.
"""
from __future__ import annotations

import json
import re
import sys

PINNED = {"vesper-builder", "vesper-escalation", "vesper-reviewer", "vesper-test-keeper"}
PINNED_MODEL = {
    "vesper-builder": "sonnet",
    "vesper-escalation": "opus",
    "vesper-reviewer": "opus",
    "vesper-test-keeper": "opus",
}
BRIEF_MARKERS = ("## Checkout and ownership", "Owned writable paths", "# Brief:")
ESCALATION_LINE = re.compile(r"^(Escalation|Risk area):", re.MULTILINE)

# Copied verbatim from the "## Escalation record" section of
# .agents/skills/vesper-agent-build/templates/agent-brief.md. A prompt that
# still contains one of these means the escalation record is the unfilled
# template, not a filled-in record -- the brief's placeholder text, not this
# slice's facts.
RECORD_PLACEHOLDERS = (
    "Risk area: <kernel | migration | authz | persistence/replay>",
    "Originating brief: <this brief, or a link/path to it>",
    "Trigger: <what made this stop worth returning instead of continuing>",
    "Findings: <what you learned about the actual problem>",
    "Attempted approaches: <each approach tried and why it failed>",
    "Changed files: <paths touched so far>",
    "Unresolved question: <what the next worker must decide or discover>",
)


def _has_brief(prompt: str) -> bool:
    return any(marker in prompt for marker in BRIEF_MARKERS)


def _has_escalation_record(prompt: str) -> bool:
    return bool(ESCALATION_LINE.search(prompt)) or "## Escalation" in prompt


def _record_placeholder(prompt: str) -> str | None:
    """Return the first unfilled template placeholder still present in `prompt`, or None."""
    return next((placeholder for placeholder in RECORD_PLACEHOLDERS if placeholder in prompt), None)


def check(tool_input: dict) -> str | None:
    """Return a deny reason for this Agent spawn, or None to allow it.

    Pure and side-effect free so tests can call it directly; `main()` wires
    it to stdin/stdout/exit-code for the actual hook.
    """
    subagent_type = tool_input.get("subagent_type") or ""
    model = tool_input.get("model") or ""
    prompt = tool_input.get("prompt") or ""

    if subagent_type in PINNED and model:
        return (
            f"[vesper agent policy] `{subagent_type}` pins its own model "
            f"({PINNED_MODEL[subagent_type]}); this spawn passed `model: {model}`, "
            "which would override that pin.\n"
            "Remove `model` from the call, or use `general-purpose` with an explicit "
            "model for an ad-hoc task that isn't one of the pinned Vesper roles."
        )

    if subagent_type == "vesper-escalation":
        if not _has_escalation_record(prompt):
            return (
                "[vesper agent policy] `vesper-escalation` needs either an `Escalation:` "
                "record (originating brief, trigger, findings, attempted approaches, "
                "changed files, unresolved question) or a `Risk area:` line naming why "
                "this slice starts here. Add one of those to the prompt and retry."
            )

        placeholder = _record_placeholder(prompt)
        if placeholder:
            return (
                "[vesper agent policy] this escalation record is still the brief "
                f"template's boilerplate (found the unfilled placeholder `{placeholder}`). "
                "Fill the six fields (originating brief, trigger, findings, attempted "
                "approaches, changed files, unresolved question) or the `Risk area:` line "
                "with this slice's actual facts before spawning."
            )

    if _has_brief(prompt) and subagent_type not in PINNED:
        return (
            "[vesper agent policy] this prompt carries an implementation brief, and "
            f"`{subagent_type or '(no subagent_type)'}` is not one of the pinned roles.\n"
            "Implementation briefs go to `vesper-builder` (Sonnet) or `vesper-escalation` "
            "(Opus; needs an escalation record or a Risk area line). Explore, Plan, and "
            "`claude-code-guide` take no brief."
        )

    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if not isinstance(payload, dict):
        return 0

    if payload.get("tool_name") != "Agent":
        return 0

    tool_input = payload.get("tool_input") or {}

    try:
        deny = check(tool_input)
    except Exception as exc:  # never break a tool call on our own bug
        print(f"[vesper agent policy] skipped: {exc}", file=sys.stderr)
        return 0

    if deny:
        print(deny, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
