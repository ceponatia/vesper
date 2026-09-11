"""Offline hook fixtures; never execute payload commands or contact services."""

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("agent_policy.py").resolve()
SPEC = importlib.util.spec_from_file_location("agent_policy", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)

BRIEF_PROMPT = "\n".join([
    "# Brief: #999 -- do a bounded thing",
    "",
    "## Checkout and ownership",
    "- Owned writable paths: apps/web/src/thing.ts",
])

# A complete handoff record written as plain `Field: value` lines under an
# `Escalation:` line -- the prose-style shape a parent types by hand.
ESCALATION_PROMPT = "\n".join([
    "Escalation: two attempts left the same race; this needs a different approach.",
    "Originating brief: #999 -- do a bounded thing.",
    "Trigger: the second attempt failed exactly as the first did.",
    "Findings: the guard runs after the read, so concurrent writers still interleave.",
    "Attempted approaches: a service-layer guard, then a unique index; both missed concurrent inserts.",
    "Changed files: apps/web/src/server/thing.ts.",
    "Unresolved question: whether the lock belongs in the repo or the service.",
])

RISK_AREA_PROMPT = "Risk area: migration -- adds a NOT NULL column to a hot table."

# The same complete record, but below an opening instruction rather than first.
LATE_ESCALATION_PROMPT = "\n".join([
    "Continue #999 where the builder stopped.",
    "",
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: two attempts left the same race.",
    "- Findings: the guard runs after the read, so concurrent writers still interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index; both missed inserts.",
    "- Changed files: apps/web/src/server/thing.ts.",
    "- Unresolved question: where the lock belongs.",
])

# The record's heading with nothing under it: the shape that used to satisfy the gate.
HEADING_ONLY_PROMPT = "\n".join([
    "## Escalation record (escalation spawns only)",
    "",
    "Take over #999 from the builder and sort it out.",
])

# Two of the six fields filled, the rest simply deleted rather than left as
# template text -- the partial record that used to satisfy the gate.
PARTIAL_ESCALATION_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the builder stopped after one failed attempt.",
])

BRIEF_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/vesper-agent-build/templates/agent-brief.md"
)
ROLE_DIR = Path(__file__).resolve().parents[2] / ".claude/agents"

_BRIEF_TEMPLATE_TEXT = BRIEF_TEMPLATE.read_text(encoding="utf-8")

# The whole "## Escalation record" section of the template, verbatim, with every
# field still in its unfilled `<placeholder>` form -- this is what a worker who
# pastes the template without filling it in would actually send.
_RECORD_HEADING_AT = _BRIEF_TEMPLATE_TEXT.index("## Escalation record (escalation spawns only)")
FULL_TEMPLATE_ESCALATION_SECTION = _BRIEF_TEMPLATE_TEXT[_RECORD_HEADING_AT:]

# Everything above that section: the brief's ordinary instructions, which the
# placeholder rule has to leave alone.
TEMPLATE_BODY_ABOVE_RECORD = _BRIEF_TEMPLATE_TEXT[:_RECORD_HEADING_AT]

# Any `<...>` chunk at all, the shape the rule used to match wholesale.
ANY_ANGLE_CHUNK = re.compile(r"<[^<>]*>")

# The template's unfilled Risk area alternative, read from the template so the
# fixture cannot drift from the text a worker actually pastes.
TEMPLATE_RISK_AREA_LINE = next(
    line
    for line in FULL_TEMPLATE_ESCALATION_SECTION.splitlines()
    if line.startswith("Risk area:")
)

# The template's Risk area line with only the category chosen and the reason left
# as template prose: the half-edited shape a parent produces by deleting the
# alternatives -- `Risk area: migration -- <why>.` -- and the one the gate used to
# read as filled because a word survived the placeholder strip.
PARTIAL_RISK_AREA_LINE, _PARTIAL_RISK_AREA_SUBS = re.subn(
    r"<kernel[^>]*>", "migration", TEMPLATE_RISK_AREA_LINE
)

# A slice that starts on escalation: the parent pasted the template section and
# filled only the Risk area alternative, leaving the six handoff placeholders --
# which describe a failed attempt that never happened -- above it.
RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT, _RISK_AREA_SUBS = re.subn(
    r"(?m)^Risk area:.*$",
    "Risk area: kernel -- this slice rewrites the turn scheduler's ordering rule.",
    FULL_TEMPLATE_ESCALATION_SECTION,
)

# A complete record under the template's own heading, bullet-prefixed.
TEMPLATE_HEADING_FILLED_PROMPT = "\n".join([
    "## Escalation record (escalation spawns only)",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt hit the same race as the first.",
    "- Findings: the guard runs after the read, so concurrent writers still interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index; both missed inserts.",
    "- Changed files: apps/web/src/server/thing.ts.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

FILLED_ESCALATION_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999, the pregnancy-stage helper slice.",
    "- Trigger: the second fix attempt hit the same race as the first.",
    "- Findings: the backfill default is safe for existing rows but not concurrent writers.",
    "- Attempted approaches: a service-layer guard, then a DB constraint; both missed concurrent inserts.",
    "- Changed files: apps/web/src/server/thing.ts, migrations/0134_thing.sql.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# The template's own Trigger line, for a record whose writer filled every field
# but that one.
TEMPLATE_TRIGGER_LINE = next(
    line
    for line in FULL_TEMPLATE_ESCALATION_SECTION.splitlines()
    if line.startswith("- Trigger:")
)

# Five fields filled and the sixth still the template's own line: the record a
# writer produces by working down the template and skipping one field.
LEFTOVER_TRIGGER_PROMPT, _LEFTOVER_TRIGGER_SUBS = re.subn(
    r"(?m)^- Trigger:.*$", TEMPLATE_TRIGGER_LINE, FILLED_ESCALATION_PROMPT
)

# A field whose value continues as an indented block below its label, the way a
# parent writes a record with more than one finding.
MULTILINE_FIELD_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second correction round failed the same way as the first.",
    "- Findings:",
    "  1. the guard runs after the read, so concurrent writers interleave.",
    "  2. the unique index only fires once the second insert lands.",
    "- Attempted approaches:",
    "  (a) a service-layer guard; (b) a unique index. Both missed concurrent inserts.",
    "- Changed files: apps/web/src/server/thing.ts, migrations/0134_thing.sql.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# Real field values that quote the docs' own `<worktree>/...` paths: a path root
# has the template's own placeholder shape, so it is stripped before the check --
# it names a real file this slice touched, not prose the writer failed to replace.
ANGLE_BRACKET_VALUE_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the builder's second attempt failed the same way as the first.",
    "- Findings: the hook resolves <worktree>/.codex/hooks/agent_policy.py, not the symlink.",
    "- Attempted approaches: a relative path, then a resolved one; both broke under the symlink.",
    "- Changed files: <worktree>/.codex/hooks/agent_policy.py.",
    "- Unresolved question: whether the hook should resolve symlinks at all.",
])

# Real field values carrying the angle brackets that ordinary evidence uses: a
# Markdown autolink to the issue, a JSX tag, and a TypeScript generic. None of
# them is the template's placeholder shape, so none of them may unfill a record.
CODE_AND_AUTOLINK_VALUE_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: <https://github.com/ceponatia/vesper/issues/560>.",
    "- Trigger: the builder's second attempt failed the same way as the first.",
    "- Findings: <CharacterCard /> reads the id as Record<string, X>, so the cast drops it.",
    "- Attempted approaches: widening the generic, then a cast at the call site; both lost the id.",
    "- Changed files: apps/web/src/components/character-card.tsx.",
    "- Unresolved question: whether the id belongs in the props type at all.",
])

# Route B with the category chosen and nothing else -- the template's placeholder
# deleted rather than answered. A category names no risk the next worker could
# not read off the branch, and on this route that one line is the whole record.
BARE_CATEGORY_RISK_AREA_PROMPT = "Risk area: migration"
NONE_RISK_AREA_PROMPT = "Risk area: none"

# `Findings:` with nothing after it and the next field immediately below.
EMPTY_FIELD_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings:",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: apps/web/src/server/thing.ts.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# `Findings:` with nothing after it and unindented prose below: prose that is not
# part of the field must not count as its value.
PROSE_AFTER_EMPTY_FIELD_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings:",
    "Take over and work out what is going on.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: apps/web/src/server/thing.ts.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# Labels as a parent actually writes them: Markdown emphasis, and a field name that
# carries the writer's own trailing words.
PARAPHRASED_LABEL_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- **Originating brief**: #999 -- do a bounded thing.",
    "- **Trigger**: the second attempt failed the same way as the first.",
    "- **Findings**: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches so far: a service-layer guard, then a unique index.",
    "- Changed files so far: apps/web/src/server/thing.ts.",
    "- **Unresolved question**: whether the lock belongs in the repo or the service.",
])

# Six filled fields, but nothing says this is an escalation record.
MARKERLESS_RECORD_PROMPT = "\n".join([
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: apps/web/src/server/thing.ts.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

FILLED_RISK_AREA_PROMPT = "Risk area: migration -- 0134 renames a column on a hot table."


def role_frontmatter(path: Path) -> dict:
    """Read a role file's YAML frontmatter without a YAML dependency: flat `key: value` lines."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep and key == key.strip():
            fields[key] = value.strip()
    return fields


def run(payload: dict) -> tuple[int, str, str]:
    """Run agent_policy.py as a subprocess with payload on stdin; never execs it."""
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


class CheckFunctionTests(unittest.TestCase):
    """Exercise check() directly so the pure decision logic is covered without a subprocess."""

    def test_pinned_role_with_explicit_model_is_denied(self):
        reason = HOOK.check({"subagent_type": "vesper-builder", "model": "opus", "prompt": ""})
        self.assertIsNotNone(reason)
        self.assertIn("vesper-builder", reason)

    def test_every_pinned_role_denies_an_explicit_model_and_names_its_own_pin(self):
        """A PINNED role missing from PINNED_MODEL raises here, where the hook itself would
        fail open and silently let the override through."""
        for role in sorted(HOOK.PINNED):
            with self.subTest(role=role):
                reason = HOOK.check({"subagent_type": role, "model": "haiku", "prompt": ""})
                self.assertIsNotNone(reason)
                self.assertIn(role, reason)
                self.assertIn(f"({HOOK.PINNED_MODEL[role]})", reason)

    def test_explicit_model_on_an_unpinned_role_is_allowed(self):
        """The deny message sends ad-hoc work to `general-purpose` with a model; keep that route open."""
        reason = HOOK.check(
            {"subagent_type": "general-purpose", "model": "opus", "prompt": "look into the flaky test"}
        )
        self.assertIsNone(reason)

    def test_pinned_role_without_model_and_with_brief_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vesper-builder", "prompt": BRIEF_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_without_record_is_denied_and_offers_both_routes(self):
        reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": "take over please"})
        self.assertIsNotNone(reason)
        self.assertIn("Route A", reason)
        self.assertIn("Route B", reason)
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_escalation_line_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": ESCALATION_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_with_risk_area_line_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": RISK_AREA_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_record_below_an_opening_line_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": LATE_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_the_brief_template_heading_and_six_filled_fields_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": TEMPLATE_HEADING_FILLED_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_only_the_record_heading_is_denied_and_names_every_field(self):
        """A heading is a label, not a record: the worker would start with no findings, no
        attempted approaches, no changed files and no question -- exactly what it needs."""
        reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": HEADING_ONLY_PROMPT})
        self.assertIsNotNone(reason)
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_a_two_field_record_is_denied_and_names_the_four_missing(self):
        """Deleting the fields you cannot fill must not pass: the deny reason names the four
        that are gone and stays silent about the two that are there."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": PARTIAL_ESCALATION_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        for field in ("Findings", "Attempted approaches", "Changed files", "Unresolved question"):
            with self.subTest(field=field):
                self.assertIn(field, route_a)
        self.assertNotIn("Originating brief", route_a)
        self.assertNotIn("Trigger", route_a)

    def test_escalation_with_the_unfilled_template_section_is_denied_as_boilerplate(self):
        """Pasting the whole template section without filling it in must not satisfy the
        gate: every field is still `<placeholder>` text, not this slice's facts."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": FULL_TEMPLATE_ESCALATION_SECTION}
        )
        self.assertIsNotNone(reason)
        self.assertIn("placeholder", reason.lower())
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_a_filled_record_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": FILLED_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_a_filled_risk_area_line_naming_a_migration_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": FILLED_RISK_AREA_PROMPT}
        )
        self.assertIsNone(reason)

    def test_filled_risk_area_above_the_unfilled_handoff_placeholders_is_allowed(self):
        """A slice that starts on escalation fills the template's Risk area alternative and
        leaves the handoff fields unfilled -- there is no failed attempt to report. The
        documented direct-escalation route has to work with the standard template."""
        reason = HOOK.check(
            {
                "subagent_type": "vesper-escalation",
                "prompt": RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT,
            }
        )
        self.assertIsNone(reason)

    def test_escalation_with_only_the_template_risk_area_line_is_denied(self):
        """The alternative pasted but not filled in names no risk at all."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": TEMPLATE_RISK_AREA_LINE}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Risk area", reason)

    def test_escalation_with_a_half_edited_risk_area_line_is_denied(self):
        """Choosing the category and leaving `<why>` gives the worker no reason at all. A
        leftover placeholder must not be rescued by the words around it, or every partially
        edited template line satisfies the gate."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": PARTIAL_RISK_AREA_LINE}
        )
        self.assertIsNotNone(reason)
        route_b = next(line for line in reason.splitlines() if line.startswith("Route B"))
        self.assertIn("present but unfilled", route_b)

    def test_escalation_with_one_field_left_as_template_text_is_denied_and_names_only_it(self):
        """Five filled fields do not carry the sixth: the deny reason names the field still
        holding the template's prose and stays silent about the five that are done."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": LEFTOVER_TRIGGER_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        self.assertIn("Trigger", route_a)
        self.assertNotIn("missing", route_a)
        for field in HOOK.RECORD_FIELDS:
            if field == "Trigger":
                continue
            with self.subTest(field=field):
                self.assertNotIn(field, route_a)

    def test_escalation_with_an_indented_multiline_field_is_allowed(self):
        """A field whose value is a list below its label is filled in; requiring the value on
        the label's own line would deny real records."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": MULTILINE_FIELD_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_field_quoting_a_placeholder_path_is_allowed(self):
        """`<worktree>/...` is a real path this slice touched, not template boilerplate: a
        bracketed token followed immediately by `/` names a path root, and reading it as
        template prose would deny real records about paths."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": ANGLE_BRACKET_VALUE_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_field_carrying_an_autolink_jsx_or_a_generic_is_allowed(self):
        """Real evidence uses angle brackets: `<https://.../issues/560>` is the issue link the
        record is supposed to carry, `<CharacterCard />` and `Record<string, X>` are the code
        the finding is about. Reading any of them as leftover template prose would deny the
        very records this gate exists to require."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": CODE_AND_AUTOLINK_VALUE_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_a_bare_risk_area_category_is_denied_for_the_missing_rationale(self):
        """`Risk area: migration` deletes the placeholder instead of answering it. The line is
        the entire record on this route, so a category with no reason must not open it -- and
        the deny reason has to say that, not repeat the placeholder complaint."""
        for prompt in (BARE_CATEGORY_RISK_AREA_PROMPT, NONE_RISK_AREA_PROMPT):
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": prompt})
                self.assertIsNotNone(reason)
                route_b = next(
                    line for line in reason.splitlines() if line.startswith("Route B")
                )
                self.assertIn("without a rationale", route_b)
                self.assertNotIn("present but unfilled", route_b)
                self.assertIn("Risk area: migration — 0134 rewrites a hot table", route_b)

    def test_escalation_with_an_empty_field_is_denied_and_names_it(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": EMPTY_FIELD_ESCALATION_PROMPT}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Findings", reason)
        self.assertNotIn("Changed files", reason.split("Route B")[0])

    def test_escalation_with_unindented_prose_after_an_empty_field_is_denied(self):
        """Only an indented block continues a field; the next unindented line belongs to the
        prompt, not to `Findings:`."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": PROSE_AFTER_EMPTY_FIELD_PROMPT}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Findings", reason)

    def test_escalation_with_paraphrased_field_labels_is_allowed(self):
        """The gate reads the record's content, not its typography: bold labels and a field
        name with trailing words (`Changed files so far:`) still name the same field."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": PARAPHRASED_LABEL_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_six_filled_fields_but_no_marker_is_denied_for_the_marker(self):
        """Six filled fields loose in a prompt are not yet a record the role can find: the
        deny reason asks for the marker and reports no missing field."""
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": MARKERLESS_RECORD_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        self.assertIn("`Escalation:` line or `## Escalation` heading", route_a)
        self.assertNotIn("missing", route_a)

    def test_brief_sent_to_unpinned_role_is_denied_and_names_vesper_builder(self):
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": BRIEF_PROMPT})
        self.assertIsNotNone(reason)
        self.assertIn("vesper-builder", reason)

    def test_brief_with_missing_subagent_type_is_denied(self):
        reason = HOOK.check({"prompt": BRIEF_PROMPT})
        self.assertIsNotNone(reason)

    def test_plain_prompt_to_unpinned_role_is_allowed(self):
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": "look into the flaky test"})
        self.assertIsNone(reason)


class ProcessTests(unittest.TestCase):
    """Exercise the stdin-to-exit-code wiring, matching how Claude Code actually invokes the hook."""

    def test_non_agent_tool_exits_zero_with_no_output(self):
        code, out, err = run({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertEqual(err, "")

    def test_explore_with_plain_prompt_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "Explore", "prompt": "find the file that defines X"},
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_plain_prompt_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "general-purpose", "prompt": "look into the flaky test"},
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_brief_is_denied_and_names_vesper_builder(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "general-purpose", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 2)
        self.assertIn("vesper-builder", err)

    def test_missing_subagent_type_with_brief_is_denied(self):
        code, out, err = run({"tool_name": "Agent", "tool_input": {"prompt": BRIEF_PROMPT}})
        self.assertEqual(code, 2)

    def test_vesper_builder_with_brief_and_no_model_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-builder", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vesper_builder_with_explicit_model_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-builder", "model": "opus", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 2)

    def test_vesper_escalation_without_record_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-escalation", "prompt": "take over please"},
        })
        self.assertEqual(code, 2)

    def test_vesper_escalation_with_escalation_line_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-escalation", "prompt": ESCALATION_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vesper_escalation_with_a_partial_record_is_denied_naming_the_missing_fields(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vesper-escalation",
                "prompt": PARTIAL_ESCALATION_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("Findings", err)
        self.assertIn("Unresolved question", err)

    def test_vesper_escalation_with_risk_area_line_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-escalation", "prompt": RISK_AREA_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vesper_escalation_with_a_bare_risk_area_category_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vesper-escalation",
                "prompt": BARE_CATEGORY_RISK_AREA_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("without a rationale", err)

    def test_vesper_escalation_with_angle_bracket_evidence_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vesper-escalation",
                "prompt": CODE_AND_AUTOLINK_VALUE_PROMPT,
            },
        })
        self.assertEqual(code, 0, err)

    def test_vesper_reviewer_with_brief_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-reviewer", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vesper_test_keeper_with_brief_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-test-keeper", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_non_dict_tool_input_fails_open_with_a_note(self):
        code, out, err = run({"tool_name": "Agent", "tool_input": "vesper-builder"})
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("skipped", err)

    def test_non_object_json_payload_fails_open(self):
        """Valid JSON that parses to something other than an object (e.g. a bare list) must
        not reach `payload.get(...)`: that would raise AttributeError uncaught and exit 1,
        contradicting the "any internal error exits 0" fail-open contract."""
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="[]",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_malformed_stdin_fails_open(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


class BriefMarkerTests(unittest.TestCase):
    """Guard the brief vocabulary: a renamed heading in the template the parent copies, or a
    detector narrowed to one marker, would let an implementation brief reach an unpinned agent
    with the hook still reporting success."""

    def test_every_brief_marker_still_appears_in_the_agent_brief_template(self):
        text = BRIEF_TEMPLATE.read_text(encoding="utf-8")
        for marker in HOOK.BRIEF_MARKERS:
            with self.subTest(marker=marker):
                self.assertIn(marker, text)

    def test_each_brief_marker_alone_denies_an_unpinned_spawn(self):
        for marker in HOOK.BRIEF_MARKERS:
            with self.subTest(marker=marker):
                reason = HOOK.check(
                    {"subagent_type": "general-purpose", "prompt": f"do a thing\n{marker} x"}
                )
                self.assertIsNotNone(reason)


class EscalationRecordTemplateTests(unittest.TestCase):
    """Keep the hook's field names and the template the parent copies in step. A renamed or
    reworded field in the template reaches the hook two ways, both silent in production: the
    hook would demand a field no brief writes (denying every real handoff), or stop reading
    the template's own placeholder text as unfilled (letting boilerplate through)."""

    def test_every_record_field_appears_in_the_template_as_an_unfilled_placeholder(self):
        states = HOOK._record_states(_BRIEF_TEMPLATE_TEXT)
        for field in HOOK.RECORD_FIELDS + (HOOK.RISK_AREA_FIELD,):
            with self.subTest(field=field):
                self.assertEqual(states[field], HOOK.UNFILLED)

    def test_the_risk_area_fixture_rewrote_exactly_the_template_line(self):
        """The filled-Risk-area fixture is built by substitution; if the template's line
        changed shape the fixture would silently become a copy of the unfilled section."""
        self.assertEqual(_RISK_AREA_SUBS, 1)
        self.assertNotIn(TEMPLATE_RISK_AREA_LINE, RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT)

    def test_every_angle_bracket_chunk_in_the_record_section_is_read_as_a_placeholder(self):
        """The placeholder rule is narrow by design, so it can drift off the very text it
        exists to catch: a template placeholder reworded to start with a capital or to carry a
        colon would silently stop counting, and a pasted-but-unfilled record would pass."""
        chunks = set(ANY_ANGLE_CHUNK.findall(FULL_TEMPLATE_ESCALATION_SECTION))
        self.assertTrue(chunks)
        detected = {m.group(0) for m in HOOK.PLACEHOLDER.finditer(FULL_TEMPLATE_ESCALATION_SECTION)}
        self.assertEqual(chunks, detected)

    def test_the_template_s_other_sections_are_placeholders_too_and_hold_no_record_field(self):
        """The rest of the brief template is the same placeholder prose, and none of it names a
        record field -- so narrowing the rule changed nothing outside the record section."""
        chunks = set(ANY_ANGLE_CHUNK.findall(TEMPLATE_BODY_ABOVE_RECORD))
        self.assertTrue(chunks)
        detected = {m.group(0) for m in HOOK.PLACEHOLDER.finditer(TEMPLATE_BODY_ABOVE_RECORD)}
        self.assertEqual(chunks, detected)
        states = HOOK._record_states(TEMPLATE_BODY_ABOVE_RECORD)
        for field in HOOK.RECORD_FIELDS + (HOOK.RISK_AREA_FIELD,):
            with self.subTest(field=field):
                self.assertEqual(states[field], HOOK.ABSENT)

    def test_the_half_edited_fixtures_still_carry_the_template_s_own_placeholder_text(self):
        """Both half-edited fixtures are built by substitution on the template. If the
        template's wording moved, they would silently stop being half-edited -- one a fully
        filled line, the other a record with six real values -- and prove nothing."""
        self.assertEqual(_PARTIAL_RISK_AREA_SUBS, 1)
        self.assertRegex(PARTIAL_RISK_AREA_LINE, r"<[^<>]*>")
        self.assertEqual(_LEFTOVER_TRIGGER_SUBS, 1)
        self.assertRegex(LEFTOVER_TRIGGER_PROMPT, r"(?m)^- Trigger:.*<[^<>]*>")


class PlaceholderValueTests(unittest.TestCase):
    """State the filled-versus-template rule on values directly. Every route through the gate
    rests on it, and a record-shaped fixture can pass for the wrong reason."""

    def test_a_value_still_carrying_template_prose_is_unfilled(self):
        for value in (
            "",
            "<why>",
            "migration -- <why>.",
            "<kernel | migration | authz | persistence/replay> -- <why>.",
            "<paths touched so far>.",
            "apps/web/src/server/thing.ts and <whatever else this touched>.",
            "<worktree>/",
        ):
            with self.subTest(value=value):
                self.assertFalse(HOOK._is_filled_value(value))

    def test_a_value_naming_real_facts_is_filled_even_around_a_quoted_path_root(self):
        for value in (
            "migration -- 0134 rewrites a hot table",
            "apps/web/src/server/thing.ts",
            "<worktree>/.codex/hooks/agent_policy.py",
            "apps/web/src/server/thing.ts, <worktree>/migrations/0134_thing.sql",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))

    def test_angle_brackets_that_are_not_the_template_s_shape_leave_a_value_filled(self):
        """Each of these is the reason the rule is shaped the way it is: a Markdown autolink
        (ruled out by the colon), a JSX tag (by the capital), and a generic (by the word
        character before `<`). Matching every `<...>` denied all three."""
        for value in (
            "<https://github.com/ceponatia/vesper/issues/560>",
            "the card renders <CharacterCard /> twice",
            "the id is typed Record<string, X>, so the cast drops it",
            "the helper returns Array<string> from the adapter",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))

    def test_a_risk_area_value_needs_a_category_and_a_reason_not_a_category_alone(self):
        """Route B's one line is the whole record. These clear the placeholder rule -- they are
        real words, not template prose -- and still must not open the route, which is what the
        word count buys and the placeholder rule alone cannot."""
        for value in ("migration", "none", "authz -- new route"):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))
                self.assertFalse(HOOK._is_filled_value(value, HOOK.RISK_AREA_MIN_WORDS))
        for value in (
            "migration -- 0134 rewrites a hot table",
            "kernel -- this slice rewrites the turn scheduler's ordering rule",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value, HOOK.RISK_AREA_MIN_WORDS))


class PinnedRoleTableTests(unittest.TestCase):
    """Keep the hook's table and the role files it enforces in step: a `vesper-*` role whose
    frontmatter pins a model but which PINNED omits is a role the policy silently stops
    protecting, and a mismatched entry makes the deny message name the wrong model."""

    def roles(self) -> dict:
        found = {}
        for path in sorted(ROLE_DIR.glob("*.md")):
            fields = role_frontmatter(path)
            name = fields.get("name", "")
            if name.startswith("vesper-"):
                found[name] = fields.get("model")
        return found

    def test_every_model_pinning_role_file_is_in_the_hook_table(self):
        found = self.roles()
        self.assertTrue(found)
        self.assertEqual({name for name, model in found.items() if model}, set(HOOK.PINNED))

    def test_hook_table_names_the_model_each_role_file_pins(self):
        for name, model in self.roles().items():
            with self.subTest(role=name):
                self.assertEqual(HOOK.PINNED_MODEL.get(name), model)


if __name__ == "__main__":
    unittest.main()
