"""Offline hook fixtures; never execute payload commands or contact services."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("workflow_context.py").resolve()
SPEC = importlib.util.spec_from_file_location("workflow_context", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        for args in [("init", "-q"), ("config", "user.email", "fixture@example.invalid"),
                     ("config", "user.name", "Fixture"), ("commit", "-q", "--allow-empty", "-m", "fixture")]:
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        self.session = "fixture-session"
        self.path = HOOK.record_path(self.repo, self.session)

    def invoke(self, event="Stop", env=None, **extra):
        payload = {"hook_event_name": event, "session_id": self.session, "cwd": str(self.repo), **extra}
        result = subprocess.run([sys.executable, "-B", str(SCRIPT)], input=json.dumps(payload),
                                capture_output=True, text=True, cwd=self.repo,
                                env=env if env is not None else {**os.environ, "CODEX_SESSION_ID": self.session,
                                                               "CODEX_THREAD_ID": "fixture-child"})
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertNotIn("decision", output)
        self.assertNotIn("continue", output)
        return output

    def record(self, **extra):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        value = {"version": 1, "session_id": self.session, "requirements": ["docs"], "results": [], **extra}
        self.path.write_text(json.dumps(value))
        return value

    def test_startup_returns_current_checkout_and_bounded_pointer(self):
        output = self.invoke("SessionStart")["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "SessionStart")
        self.assertIn(str(self.path), output["additionalContext"])
        self.assertIn(str(self.repo), output["additionalContext"])
        self.assertLess(len(output["additionalContext"]), 1800)

    def test_subagent_adds_only_its_role_pointer(self):
        output = self.invoke("SubagentStart", agent_type="vesper-ui-reviewer")
        text = output["hookSpecificOutput"]["additionalContext"]
        self.assertIn("vesper-ui-quality/SKILL.md", text)
        self.assertNotIn("vesper-scenario-review/SKILL.md", text)

    def test_test_keeper_role_points_at_vesper_testing_skill(self):
        output = self.invoke("SubagentStart", agent_type="vesper-test-keeper")
        text = output["hookSpecificOutput"]["additionalContext"]
        self.assertIn("vesper-testing/SKILL.md", text)

    def test_no_record_leaves_ordinary_conversation_quiet(self):
        self.assertEqual(self.invoke(), {})
        self.assertFalse(self.path.parent.exists())

    def test_all_honest_result_statuses_are_accepted(self):
        for status in ["verified", "failed", "unverified", "not-applicable"]:
            with self.subTest(status=status):
                self.record(results=[{"requirement": "docs", "status": status,
                                      "evidence": "fixture evidence", "reason": "scope limit"}])
                self.assertEqual(self.invoke(), {})

    def test_missing_result_warns_once_and_changed_record_warns_again(self):
        self.record()
        self.assertIn("systemMessage", self.invoke())
        self.assertEqual(self.invoke(), {})
        self.record(requirements=["docs", "ui"])
        self.assertIn("systemMessage", self.invoke())

    def test_verified_requires_evidence_and_unverified_requires_reason(self):
        for status in ["verified", "unverified"]:
            with self.subTest(status=status):
                self.record(results=[{"requirement": "docs", "status": status}])
                self.assertIn("systemMessage", self.invoke())

    def test_other_session_does_not_validate_current_task(self):
        self.record(session_id="other", requirements=[])
        self.assertIn("systemMessage", self.invoke())

    def test_malformed_and_oversized_records_are_advisory(self):
        self.record()
        for data in [b"not json", b"x" * (HOOK.LIMIT + 1)]:
            with self.subTest(size=len(data)):
                self.path.write_bytes(data)
                self.assertIn("systemMessage", self.invoke())

    def test_continued_stop_does_not_add_another_reminder(self):
        self.record()
        self.assertEqual(self.invoke(stop_hook_active=True), {})

    def test_brief_is_optional_but_must_be_confined_and_present(self):
        self.record(brief="brief.md", requirements=[])
        self.assertIn("systemMessage", self.invoke())
        (self.path.parent / "brief.md").write_text("# Task\n")
        self.assertEqual(self.invoke(), {})
        self.record(brief="../../outside.md", requirements=[])
        self.assertIn("systemMessage", self.invoke())

    def test_symlink_record_is_not_read_and_target_is_untouched(self):
        self.path.parent.mkdir(parents=True)
        target = self.repo / "private.json"
        target.write_text("private canary")
        self.path.symlink_to(target)
        output = self.invoke()
        self.assertNotIn("private canary", json.dumps(output))
        self.assertEqual(target.read_text(), "private canary")
        self.assertFalse((self.path.parent / ".last-warning").exists())

    def test_payload_command_and_record_text_are_never_executed_or_injected(self):
        marker = self.repo / "must-not-exist"
        self.record(requirements=["PRIVATE_CANARY"], task="PRIVATE_CANARY")
        output = self.invoke(tool_input={"command": f"touch {marker}"})
        self.assertFalse(marker.exists())
        self.assertNotIn("PRIVATE_CANARY", json.dumps(output))
        startup = self.invoke("SessionStart")
        self.assertNotIn("PRIVATE_CANARY", json.dumps(startup))

    def test_nested_checkout_path_resolves_same_record(self):
        nested = self.repo / "nested"
        nested.mkdir()
        output = self.invoke("SessionStart", cwd=str(nested))
        self.assertIn(str(self.path), output["hookSpecificOutput"]["additionalContext"])

    def test_cli_record_path_matches_payload_session(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--record-path", "--session", self.session],
                                cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.path))

    def test_invalid_status_type_fails_open_with_visible_limit(self):
        self.record(results=[{"requirement": "docs", "status": []}])
        self.assertIn("systemMessage", self.invoke())
        self.assertEqual(self.invoke(), {})

    def test_shared_session_aligns_cli_and_child_hook(self):
        env = {**os.environ, "CODEX_SESSION_ID": self.session, "CODEX_THREAD_ID": "fixture-child"}
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--record-path"],
                                cwd=self.repo, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.path))
        output = self.invoke("SubagentStart", session_id="fixture-child")
        self.assertIn(str(self.path), output["hookSpecificOutput"]["additionalContext"])
        self.record()
        self.assertIn("systemMessage", self.invoke(session_id="fixture-child"))

    def test_hook_falls_back_to_payload_when_shared_id_absent(self):
        env = {key: value for key, value in os.environ.items()
               if key not in {"CODEX_SESSION_ID", "CODEX_THREAD_ID"}}
        output = self.invoke("SessionStart", env=env)
        self.assertIn(str(self.path), output["hookSpecificOutput"]["additionalContext"])

    def test_long_worktree_context_fits_configured_cap(self):
        worktree = self.repo / ("codex-worktree-" + "long-name-" * 16)
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--detach", str(worktree)],
                       check=True, capture_output=True)
        config = json.loads((SCRIPT.parents[1] / "hooks.json").read_text())
        cap = config["hooks"]["SubagentStart"][0]["hooks"][0]["additionalContextLimit"]
        output = self.invoke("SubagentStart", cwd=str(worktree), agent_type="vesper-ui-reviewer")
        context = output["hookSpecificOutput"]["additionalContext"]
        self.assertLessEqual(len(context), cap)
        self.assertIn("vesper-ui-quality/SKILL.md", context)

    def test_preserved_preflight_allows_docs_and_rejects_application_gate_payload(self):
        preflight = SCRIPT.with_name("preflight.py")
        for command, expected in [("pnpm lint:docs", 0), ("pnpm exec vitest", 2)]:
            with self.subTest(command=command):
                payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                           "cwd": str(self.repo), "tool_input": {"command": command}}
                result = subprocess.run([sys.executable, "-B", str(preflight)],
                                        input=json.dumps(payload), capture_output=True, text=True)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_preflight_compatibility_path_resolves_to_canonical_source(self):
        repo = SCRIPT.parents[2]
        alias = repo / ".claude/hooks/preflight.py"
        self.assertTrue(alias.is_symlink())
        self.assertEqual(alias.resolve(strict=True), SCRIPT.with_name("preflight.py"))


if __name__ == "__main__":
    unittest.main()
