"""Offline hook fixtures; never execute payload commands or contact services."""

import importlib.util
import json
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

ESCALATION_PROMPT = (
    "Escalation: builder tried a schema tweak, then a service-layer guard; both "
    "left the same race. Changed files: apps/web/src/server/thing.ts. "
    "Unresolved: whether the lock should live in the repo or the service."
)

RISK_AREA_PROMPT = "Risk area: migration -- adds a NOT NULL column to a hot table."

LATE_ESCALATION_PROMPT = "\n".join([
    "Continue #999 where the builder stopped.",
    "",
    "Escalation: two attempts left the same race. Changed files: apps/web/src/server/thing.ts. "
    "Unresolved: where the lock belongs.",
])

TEMPLATE_ESCALATION_PROMPT = "\n".join([
    "## Escalation record (escalation spawns only)",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the builder stopped after one failed attempt.",
])

BRIEF_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/vesper-agent-build/templates/agent-brief.md"
)


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

    def test_escalation_without_record_is_denied(self):
        reason = HOOK.check({"subagent_type": "vesper-escalation", "prompt": "take over please"})
        self.assertIsNotNone(reason)

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

    def test_escalation_with_the_brief_template_heading_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vesper-escalation", "prompt": TEMPLATE_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

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

    def test_vesper_escalation_with_risk_area_line_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vesper-escalation", "prompt": RISK_AREA_PROMPT},
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


if __name__ == "__main__":
    unittest.main()
