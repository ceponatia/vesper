#!/usr/bin/env python3
"""Offline contract tests for fly-api.sh using fake curl and fly binaries."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "fly-api.sh"


class FlyApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state = self.root / "curl-index"
        self.cache = self.root / "cache"
        self.jar = self.cache / "vesper" / "fly.cookies"
        self.base = "https://vesper.fly.dev"
        self.secret = "fixture-password-must-not-leak"

        (self.bin / "fly").write_text(
            "#!/bin/sh\nprintf '%s\\n' \"$FAKE_FLY_SECRET\"\n",
            encoding="utf-8",
        )
        (self.bin / "curl").write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json
                import os
                from pathlib import Path
                import sys

                def option(args, flag):
                    positions = [i for i, value in enumerate(args) if value == flag]
                    assert len(positions) == 1, (flag, args)
                    return args[positions[0] + 1]

                def cookie_value(path, name):
                    for raw in Path(path).read_text(encoding="utf-8").splitlines():
                        line = raw.removeprefix("#HttpOnly_")
                        if not line or line.startswith("#"):
                            continue
                        fields = line.split("\\t")
                        if len(fields) >= 7 and fields[5] == name:
                            return fields[6]
                    return None

                plan = json.loads(os.environ["FAKE_CURL_PLAN"])
                state = Path(os.environ["FAKE_CURL_STATE"])
                index = int(state.read_text() if state.exists() else "0")
                state.write_text(str(index + 1))
                entry = plan[index]
                args = sys.argv[1:]
                base = os.environ["FAKE_BASE"]
                jar = os.environ["FAKE_COOKIE_JAR"]
                headers = [args[i + 1] for i, value in enumerate(args) if value == "-H"]

                assert option(args, "-w") == "%{http_code}", args
                output = option(args, "-o")
                assert f"Origin: {base}" in headers, headers

                if entry["kind"] == "login":
                    assert args[-1] == f"{base}/api/auth/sign-in/email", args
                    assert "-X" not in args and "-b" not in args, args
                    assert option(args, "-c") == jar, args
                    assert "Content-Type: application/json" in headers, headers
                    assert option(args, "--data") == "@-", args
                    payload = json.loads(sys.stdin.read())
                    assert payload == {
                        "email": os.environ["FAKE_QA_EMAIL"],
                        "password": os.environ["FAKE_FLY_SECRET"],
                    }, payload
                else:
                    assert entry["kind"] == "request", entry
                    assert args[-1] == f"{base}{entry['path']}", args
                    assert option(args, "-X") == entry["method"], args
                    assert option(args, "-b") == jar, args
                    assert option(args, "-c") == jar, args
                    assert "Accept: application/json" in headers, headers
                    request_body = entry.get("request_body")
                    if request_body is None:
                        assert "--data" not in args, args
                        assert "Content-Type: application/json" not in headers, headers
                    else:
                        assert option(args, "--data") == request_body, args
                        assert "Content-Type: application/json" in headers, headers
                    expected_cookie = entry.get("expected_cookie")
                    if expected_cookie:
                        assert cookie_value(jar, expected_cookie["name"]) == expected_cookie["value"]

                if entry.get("exit", 0):
                    print("curl: fixture transport failure", file=sys.stderr)
                    raise SystemExit(entry["exit"])

                cookie = entry.get("set_cookie")
                if cookie:
                    domain = "#HttpOnly_vesper.fly.dev" if cookie.get("http_only", True) else "vesper.fly.dev"
                    Path(jar).write_text(
                        "# Netscape HTTP Cookie File\\n"
                        f"{domain}\\tTRUE\\t/\\t{str(cookie.get('secure', True)).upper()}\\t"
                        f"{cookie.get('expires', 4102444800)}\\t{cookie['name']}\\t{cookie['value']}\\n",
                        encoding="utf-8",
                    )
                if output != "/dev/null":
                    Path(output).write_text(entry.get("body", ""), encoding="utf-8")
                sys.stdout.write(str(entry["status"]))
                """
            ),
            encoding="utf-8",
        )
        os.chmod(self.bin / "fly", 0o755)
        os.chmod(self.bin / "curl", 0o755)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def cookie(self, value: str = "fresh", *, secure: bool = True, expires: int = 4102444800) -> dict[str, object]:
        return {
            "name": "__Secure-better-auth.session_token" if secure else "better-auth.session_token",
            "value": value,
            "secure": secure,
            "expires": expires,
        }

    def seed_cookie(self, value: str = "seed", *, expires: int = 4102444800) -> None:
        cookie = self.cookie(value, expires=expires)
        self.jar.parent.mkdir(parents=True, exist_ok=True)
        self.jar.write_text(
            "# Netscape HTTP Cookie File\n"
            f"#HttpOnly_vesper.fly.dev\tTRUE\t/\tTRUE\t{expires}\t{cookie['name']}\t{value}\n",
            encoding="utf-8",
        )

    def request_call(
        self,
        status: int,
        response_body: str = "",
        *,
        method: str = "GET",
        path: str = "/api/example",
        request_body: str | None = None,
        expected_cookie: dict[str, object] | None = None,
        exit_code: int = 0,
    ) -> dict[str, object]:
        return {
            "kind": "request",
            "status": status,
            "body": response_body,
            "method": method,
            "path": path,
            "request_body": request_body,
            "expected_cookie": expected_cookie or self.cookie("seed"),
            "exit": exit_code,
        }

    def login_call(
        self,
        status: int = 200,
        *,
        set_cookie: dict[str, object] | None = None,
    ) -> dict[str, object]:
        entry: dict[str, object] = {"kind": "login", "status": status, "body": ""}
        if set_cookie is not None:
            entry["set_cookie"] = set_cookie
        return entry

    def run_api(self, plan: list[dict[str, object]], *args: str) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "XDG_CACHE_HOME": str(self.cache),
            "FAKE_CURL_PLAN": json.dumps(plan),
            "FAKE_CURL_STATE": str(self.state),
            "FAKE_FLY_SECRET": self.secret,
            "FAKE_BASE": self.base,
            "FAKE_COOKIE_JAR": str(self.jar),
            "FAKE_QA_EMAIL": "uxtest-main@vesper.local",
        }
        return subprocess.run(
            [str(SCRIPT), *args],
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )

    def assert_secret_absent(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertNotIn(self.secret, result.stdout)
        self.assertNotIn(self.secret, result.stderr)

    def test_success_prints_only_response_body(self) -> None:
        self.seed_cookie()
        result = self.run_api([self.request_call(200, '{"ok":true}')], "GET", "/api/example")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '{"ok":true}')
        self.assertIn("HTTP 200", result.stderr)
        self.assert_secret_absent(result)

    def test_500_and_403_fail_by_default(self) -> None:
        for status in (500, 403):
            with self.subTest(status=status):
                self.state.unlink(missing_ok=True)
                self.seed_cookie()
                result = self.run_api(
                    [self.request_call(status, f'{{"status":{status}}}')],
                    "GET",
                    "/api/example",
                )
                self.assertEqual(result.returncode, 22)
                self.assertEqual(result.stdout, f'{{"status":{status}}}')
                self.assertIn(f"unexpected HTTP {status}", result.stderr)

    def test_expected_negative_status_succeeds(self) -> None:
        self.seed_cookie()
        result = self.run_api(
            [self.request_call(403, '{"error":"denied"}', method="POST", request_body="{}")],
            "--expect", "403", "POST", "/api/example", "{}",
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '{"error":"denied"}')

    def test_transport_failure_is_distinct_and_has_no_body(self) -> None:
        self.seed_cookie()
        result = self.run_api([self.request_call(0, exit_code=7)], "GET", "/api/example")
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, "")
        self.assertIn("transport failed (curl exit 7)", result.stderr)

    def test_401_reauth_retries_once_and_prints_only_final_success(self) -> None:
        self.seed_cookie()
        result = self.run_api(
            [
                self.request_call(401, '{"attempt":"first"}'),
                self.login_call(set_cookie=self.cookie("fresh")),
                self.request_call(200, '{"attempt":"final"}', expected_cookie=self.cookie("fresh")),
            ],
            "GET", "/api/example",
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '{"attempt":"final"}')
        self.assertNotIn("first", result.stdout)
        self.assertEqual(self.state.read_text(), "3")
        self.assert_secret_absent(result)

    def test_401_reauth_retries_once_then_fails_on_final_401(self) -> None:
        self.seed_cookie()
        result = self.run_api(
            [
                self.request_call(401, '{"attempt":"first"}'),
                self.login_call(set_cookie=self.cookie("fresh")),
                self.request_call(401, '{"attempt":"final"}', expected_cookie=self.cookie("fresh")),
            ],
            "GET", "/api/example",
        )
        self.assertEqual(result.returncode, 22)
        self.assertEqual(result.stdout, '{"attempt":"final"}')
        self.assertNotIn("first", result.stdout)
        self.assertEqual(self.state.read_text(), "3")

    def test_401_reauth_login_failure_does_not_print_initial_body(self) -> None:
        self.seed_cookie()
        result = self.run_api(
            [
                self.request_call(401, '{"attempt":"first"}'),
                self.login_call(403),
            ],
            "GET", "/api/example",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("sign-in as", result.stderr)
        self.assertNotIn("first", result.stdout)
        self.assert_secret_absent(result)

    def test_login_requires_a_nonempty_session_cookie(self) -> None:
        self.seed_cookie("old")
        result = self.run_api([self.login_call()], "login")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.jar.exists())
        self.assertIn("without a usable Better Auth session cookie", result.stderr)
        self.assert_secret_absent(result)

    def test_login_accepts_secure_httponly_and_plain_session_cookie_names(self) -> None:
        for secure in (True, False):
            with self.subTest(secure=secure):
                self.state.unlink(missing_ok=True)
                self.jar.unlink(missing_ok=True)
                cookie = self.cookie("fresh", secure=secure)
                result = self.run_api([self.login_call(set_cookie=cookie)], "login")
                self.assertEqual(result.returncode, 0)
                self.assertTrue(self.jar.exists())
                self.assertIn(str(cookie["name"]), self.jar.read_text())
                self.assert_secret_absent(result)

    def test_expired_cookie_reauth_persists_fresh_cookie_for_retry(self) -> None:
        expired = self.cookie("expired", expires=1)
        fresh = self.cookie("renewed")
        self.seed_cookie("expired", expires=1)
        result = self.run_api(
            [
                self.request_call(401, '{"attempt":"expired"}', expected_cookie=expired),
                self.login_call(set_cookie=fresh),
                self.request_call(200, '{"attempt":"renewed"}', expected_cookie=fresh),
            ],
            "GET",
            "/api/example",
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '{"attempt":"renewed"}')
        self.assertNotIn("expired", result.stdout)
        self.assertEqual(self.state.read_text(), "3")
        self.assertIn("renewed", self.jar.read_text())
        self.assert_secret_absent(result)


if __name__ == "__main__":
    unittest.main()
