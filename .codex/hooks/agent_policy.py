#!/usr/bin/env python3
"""PreToolUse hook for the Agent tool: the Vesper subagent model policy.

The owner's ruling: delegated Vesper roles pin their own model so the
choice survives a missed `AGENTS.md` read — Sonnet for a bounded
implementation slice (`vesper-builder`), Opus for escalation, semantic
review, and test-keeping (`vesper-escalation`, `vesper-reviewer`,
`vesper-test-keeper`). This hook keeps a spawn from working around that:
an explicit `model` on a pinned role, an implementation brief handed to
anything else, or an escalation spawn whose record does not actually say
what it is escalating from — either every handoff field filled with this
slice's facts, or a filled `Risk area:` line when the slice starts on
escalation instead of taking over a failed attempt.

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

# The handoff record of the "## Escalation record" section in
# .agents/skills/vesper-agent-build/templates/agent-brief.md. Route A: a worker
# taking over a failed attempt must arrive with all six, each filled in -- these
# are exactly the facts that keep it from restarting blindly.
RECORD_FIELDS = (
    "Originating brief",
    "Trigger",
    "Findings",
    "Attempted approaches",
    "Changed files",
    "Unresolved question",
)
# The template's alternative, for a slice owned by `vesper-escalation` from the
# start. Route B: one filled line is the whole record, and the six handoff fields
# above it in the pasted template stay unfilled precisely because nothing failed
# yet -- so a filled `Risk area:` is sufficient on its own.
RISK_AREA_FIELD = "Risk area"

# What marks a prompt as carrying a handoff record at all (Route A).
ESCALATION_LINE = re.compile(
    r"^[ \t]*(?:[-*+][ \t]+)?Escalation[ \t]*:", re.MULTILINE | re.IGNORECASE
)
ESCALATION_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+Escalation\b", re.MULTILINE | re.IGNORECASE)

HEADING_LINE = re.compile(r"^[ \t]*#{1,6}[ \t]+\S")
# `Field: value`, optionally bullet- or number-prefixed and indented, as the
# record's fields are written in the template and in real briefs.
LABEL_LINE = re.compile(
    r"^(?P<indent>[ \t]*)(?:[-*+][ \t]+|\d+[.)][ \t]+)?"
    r"(?P<label>[^:<>\n]{1,60}?)[ \t]*:[ \t]*(?P<value>.*)$"
)

ABSENT = "absent"
UNFILLED = "unfilled"
FILLED = "filled"


def _has_brief(prompt: str) -> bool:
    return any(marker in prompt for marker in BRIEF_MARKERS)


def _normalize_label(label: str) -> str:
    """Lowercase a field label down to its words: `- **Changed files**` -> `changed files`."""
    return re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()


def _label_matches(label: str, field: str) -> bool:
    """True when `label` names `field`, allowing the writer's own trailing words
    (`Changed files so far:` is still the changed-files field)."""
    normalized = _normalize_label(label)
    target = _normalize_label(field)
    return normalized == target or normalized.startswith(target + " ")


def _is_filled_value(value: str) -> bool:
    """True when `value` carries this slice's own facts rather than template text.

    The template writes every field as `<angle-bracket prose>`, so a value is
    unfilled when nothing but placeholders and punctuation is left once the
    `<...>` chunks are removed. Removing them instead of rejecting any `<` keeps
    a real value that happens to quote a placeholder path -- `Changed files:
    <worktree>/.codex/hooks/agent_policy.py` -- from reading as boilerplate.
    """
    return bool(re.search(r"\w", re.sub(r"<[^<>]*>", "", value)))


def _indent_width(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def _block_is_filled(lines: list[str], boundaries: set[int], index: int, match: "re.Match") -> bool:
    """True when the field starting at `index` has a filled value.

    The value may sit on the field's own line, or below it as an indented block
    (`Findings:` followed by a numbered list) -- a shape real briefs use. Only
    lines indented deeper than the field count, so a field left empty above
    ordinary prose stays unfilled.
    """
    if _is_filled_value(match.group("value")):
        return True
    indent = len(match.group("indent"))
    for j in range(index + 1, len(lines)):
        if j in boundaries:
            return False
        line = lines[j]
        if not line.strip():
            continue
        if _indent_width(line) <= indent:
            return False
        if _is_filled_value(line):
            return True
    return False


def _record_states(prompt: str) -> dict[str, str]:
    """Map every record field in `prompt` to ABSENT, UNFILLED, or FILLED."""
    fields = RECORD_FIELDS + (RISK_AREA_FIELD,)
    lines = prompt.splitlines()

    labelled: dict[int, tuple[str, "re.Match"]] = {}
    for index, line in enumerate(lines):
        match = LABEL_LINE.match(line)
        if not match:
            continue
        field = next((f for f in fields if _label_matches(match.group("label"), f)), None)
        if field:
            labelled[index] = (field, match)

    # A field's block ends at the next record field or the next Markdown heading.
    boundaries = set(labelled) | {i for i, line in enumerate(lines) if HEADING_LINE.match(line)}

    states = {field: ABSENT for field in fields}
    for index, (field, match) in labelled.items():
        if states[field] == FILLED:
            continue  # an earlier occurrence already carried real content
        states[field] = FILLED if _block_is_filled(lines, boundaries, index, match) else UNFILLED
    return states


def _escalation_denial(prompt: str) -> str | None:
    """Return why this escalation prompt carries no usable record, or None to allow it."""
    states = _record_states(prompt)

    if states[RISK_AREA_FIELD] == FILLED:
        return None  # Route B: the handoff fields do not apply to a slice starting here

    marked = bool(ESCALATION_LINE.search(prompt) or ESCALATION_HEADING.search(prompt))
    missing = [field for field in RECORD_FIELDS if states[field] == ABSENT]
    unfilled = [field for field in RECORD_FIELDS if states[field] == UNFILLED]
    if marked and not missing and not unfilled:
        return None  # Route A: a complete handoff record

    if not marked and not unfilled and missing == list(RECORD_FIELDS):
        route_a = (
            "not attempted — add an `Escalation:` line or a `## Escalation` heading plus all "
            "six fields, each filled with this slice's facts: " + ", ".join(RECORD_FIELDS) + "."
        )
    else:
        problems = []
        if missing:
            problems.append("missing: " + ", ".join(missing))
        if unfilled:
            problems.append(
                "present but unfilled (empty, or still the template's `<...>` placeholder text): "
                + ", ".join(unfilled)
            )
        if not marked:
            problems.append("no `Escalation:` line or `## Escalation` heading marks the record")
        route_a = "; ".join(problems) + "."

    if states[RISK_AREA_FIELD] == ABSENT:
        route_b = (
            "not attempted — add a `Risk area:` line saying why this slice starts on escalation, "
            "e.g. `Risk area: migration — 0134 rewrites a hot table`."
        )
    else:
        route_b = (
            "the `Risk area:` line is present but unfilled (empty, or still the template's "
            "`<...>` placeholder text); name the actual risk, e.g. "
            "`Risk area: migration — 0134 rewrites a hot table`."
        )

    return "\n".join(
        [
            "[vesper agent policy] `vesper-escalation` needs a record of what it is escalating "
            "from, and neither route is complete in this prompt.",
            f"Route A (taking over a failed attempt): {route_a}",
            f"Route B (this slice starts on escalation): {route_b}",
            "Fill one of the two routes with this slice's actual facts and retry.",
        ]
    )


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
        denial = _escalation_denial(prompt)
        if denial:
            return denial

    if _has_brief(prompt) and subagent_type not in PINNED:
        return (
            "[vesper agent policy] this prompt carries an implementation brief, and "
            f"`{subagent_type or '(no subagent_type)'}` is not one of the pinned roles.\n"
            "Implementation briefs go to `vesper-builder` (Sonnet) or `vesper-escalation` "
            "(Opus; needs a filled escalation record or a filled Risk area line). Explore, "
            "Plan, and `claude-code-guide` take no brief."
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
