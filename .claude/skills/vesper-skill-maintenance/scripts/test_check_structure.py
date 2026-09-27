"""Offline fixtures; no application or service imports."""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_structure", Path(__file__).with_name("check_structure.py"))
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class StructureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.skill = self.create_skill("sample")

    def create_skill(self, name):
        skill = self.repo / ".agents/skills" / name
        (skill / "agents").mkdir(parents=True)
        (skill / "SKILL.md").write_text("# Sample\n", encoding="utf-8")
        (skill / "agents/openai.yaml").write_text("interface: {}\n", encoding="utf-8")
        self.sync(name)
        return skill

    def sync(self, name):
        """Mirror a canonical skill the way `rolesync sync` does: a real directory copy."""
        mirror = self.repo / ".claude/skills" / name
        if mirror.is_symlink() or mirror.is_file():
            mirror.unlink()
        elif mirror.exists():
            shutil.rmtree(mirror)
        shutil.copytree(self.repo / ".agents/skills" / name, mirror)

    def codes(self, names=None):
        return [item["code"] for item in CHECKER.check(self.repo, names or [])["issues"]]

    def test_valid_structure_leaves_yaml_and_runtime_unverified(self):
        report = CHECKER.check(self.repo, [])
        self.assertTrue(report["passed"])
        self.assertIn("YAML schema", report["unverified"])
        self.assertIn("runtime discovery", report["unverified"])

    def test_required_file_missing(self):
        (self.skill / "agents/openai.yaml").unlink()
        self.sync("sample")
        self.assertEqual(self.codes(), ["missing-resource"])

    def test_canonical_edit_without_a_sync_leaves_a_stale_copy(self):
        """The defect the copy check exists for: `.agents/skills` edited, `rolesync sync`
        not run, and Claude still reading the old text."""
        (self.skill / "SKILL.md").write_text("# Sample, revised\n", encoding="utf-8")
        self.assertEqual(self.codes(), ["claude-mirror"])

    def test_copy_must_mirror_its_own_skill(self):
        other = self.create_skill("other")
        (other / "SKILL.md").write_text("# Other\n", encoding="utf-8")
        mirror = self.repo / ".claude/skills/sample"
        shutil.rmtree(mirror)
        shutil.copytree(other, mirror)
        self.assertEqual(self.codes(), ["claude-mirror", "claude-mirror"])

    def test_retired_symlink_layout_is_not_a_copy(self):
        mirror = self.repo / ".claude/skills/sample"
        shutil.rmtree(mirror)
        mirror.symlink_to("../../.agents/skills/sample")
        self.assertEqual(self.codes(), ["claude-mirror"])

    def test_missing_copy(self):
        shutil.rmtree(self.repo / ".claude/skills/sample")
        self.assertEqual(self.codes(), ["claude-mirror"])

    def test_copy_that_lost_its_executable_bit_is_stale(self):
        """rolesync writes a mirrored file's bytes without its mode, so a rewritten helper
        script comes out non-executable while its bytes still match."""
        helper = self.skill / "helper.sh"
        helper.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        helper.chmod(0o755)
        self.sync("sample")
        self.assertEqual(self.codes(), [])
        (self.repo / ".claude/skills/sample/helper.sh").chmod(0o644)
        self.assertEqual(self.codes(), ["claude-mirror"])

    def test_transient_files_are_not_compared(self):
        cache = self.skill / "__pycache__"
        cache.mkdir()
        (cache / "helper.cpython-312.pyc").write_bytes(b"\0")
        (self.skill / "SKILL.md~").write_text("backup\n", encoding="utf-8")
        self.assertEqual(self.codes(), [])

    def test_scoped_check_ignores_unrelated_skill(self):
        other = self.create_skill("other")
        (other / "SKILL.md").unlink()
        self.sync("other")
        self.assertEqual(self.codes(["sample"]), [])
        self.assertEqual(self.codes(), ["missing-resource"])

    def test_canonical_directory_cannot_be_alias(self):
        self.create_skill("other")
        (self.repo / ".agents/skills/linked").symlink_to("other")
        self.assertEqual(self.codes(), ["canonical-directory"])

    def cli(self, *names):
        return subprocess.run(
            [sys.executable, '-B', str(Path(__file__).with_name('check_structure.py')),
             '--repo', str(self.repo), *names], capture_output=True, text=True)

    def test_cli_pass_emits_json_and_zero(self):
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['passed'])

    def test_cli_failure_emits_json_and_nonzero(self):
        (self.skill / 'SKILL.md').unlink()
        result = self.cli('sample')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)['passed'])

    def test_cli_rejects_path_argument(self):
        result = self.cli('../sample')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')


if __name__ == "__main__":
    unittest.main()
