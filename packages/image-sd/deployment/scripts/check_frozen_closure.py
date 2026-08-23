#!/usr/bin/env python3
"""Fail if the built image's Python closure has drifted from the frozen record.

    cog exec python scripts/check_frozen_closure.py

Run from the deployment directory, before trusting a rebuild.

`frozen-requirements.txt` is `pip freeze` from the build the deployed model was
made from. It is a RECORD, not an install list — appending it to
`requirements.txt` would double-pin the direct dependencies, which pip rejects —
and a record that nothing checks is a record that quietly stops being true. Only
the direct dependencies are pinned in `requirements.txt`; everything they and
ComfyUI's own requirements pull in is free to move on the next rebuild, and the
first sign of it would be a render that behaves differently for no reason in any
diff.

## Why this is not an automatic build step

It would be a better guard as a `run:` step in `cog.yaml`, and it cannot be one.
Cog documents plainly that "Your source code is not available to `run` commands"
(https://cog.run/yaml/), so a build step has no way to read the checked-in
record; the only alternative would be pasting all 133 lines into `cog.yaml`,
which is two spellings of the same list and exactly the drift this guards
against.

`cog exec` is the seam that does work. Its own source mounts the project
directory at `/src` and sets the working directory there
(`pkg/cli/exec.go`, cog 0.22.0: `Volumes: {Source: src.ProjectDir, Destination:
"/src"}, Workdir: "/src"`), and it builds the image from the same `cog.yaml` the
model is built from — so what this script measures is the real closure of a real
build of this configuration.

Stdlib only, so it runs in the image with nothing installed for its benefit.
"""

import re
import subprocess
import sys
from pathlib import Path

DEPLOYMENT_DIR = Path(__file__).resolve().parent.parent
RECORD_PATH = DEPLOYMENT_DIR / "frozen-requirements.txt"

#: PEP 503 name normalization. `pip freeze` and a hand-edited record can spell
#: the same distribution `huggingface-hub`, `huggingface_hub` or
#: `Huggingface.Hub`, and three spellings of one package would report as three
#: differences that are not differences.
_SEPARATORS = re.compile(r"[-_.]+")


def normalize(name: str) -> str:
    return _SEPARATORS.sub("-", name).lower()


def parse(lines: list[str], source: str) -> tuple[dict[str, str], list[str]]:
    """Split `name==version` pins from everything else.

    The "everything else" bucket is compared verbatim rather than dropped.
    Editable installs, direct URL references and pip's own `## FIXME` lines all
    describe real state, and silently ignoring them would let exactly the kind of
    unreproducible install this record exists to catch pass the check.
    """
    pins: dict[str, str] = {}
    other: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, version = line.partition("==")
        if separator and "=" not in version and " " not in version:
            key = normalize(name)
            if key in pins and pins[key] != version:
                raise SystemExit(f"{source} pins {name} twice, at {pins[key]} and {version}")
            pins[key] = version
        else:
            other.append(line)
    return pins, other


def installed() -> list[str]:
    result = subprocess.run(  # noqa: S603  (fixed argv, no shell)
        [sys.executable, "-m", "pip", "freeze"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"`pip freeze` failed ({result.returncode}):\n{result.stderr}")
    return result.stdout.splitlines()


def main() -> int:
    if not RECORD_PATH.exists():
        raise SystemExit(f"no frozen record at {RECORD_PATH}")

    record_pins, record_other = parse(
        RECORD_PATH.read_text(encoding="utf8").splitlines(), RECORD_PATH.name
    )
    live_pins, live_other = parse(installed(), "pip freeze")

    print(f"record:    {RECORD_PATH.name} ({len(record_pins)} pinned)")
    print(f"installed: pip freeze ({len(live_pins)} pinned)")

    differences: list[str] = []
    for name in sorted(set(record_pins) | set(live_pins)):
        recorded = record_pins.get(name)
        live = live_pins.get(name)
        if recorded == live:
            continue
        if recorded is None:
            differences.append(f"  extra    {name}=={live} — installed, not in the record")
        elif live is None:
            differences.append(f"  missing  {name}=={recorded} — in the record, not installed")
        else:
            differences.append(f"  changed  {name}  {recorded} (record) -> {live} (installed)")
    for line in sorted(set(record_other) - set(live_other)):
        differences.append(f"  missing  {line} — in the record, not installed")
    for line in sorted(set(live_other) - set(record_other)):
        differences.append(f"  extra    {line} — installed, not in the record")

    if not differences:
        print("OK — the built environment matches the frozen closure exactly.")
        return 0

    print("")
    print(f"DRIFT: {len(differences)} difference(s) from the frozen closure.")
    print("")
    for line in differences:
        print(line)
    print("")
    print("Resolve it one of two ways, and never by ignoring it:")
    print("  - pin the drift back out, if the record is what the deployed image was built from; or")
    print("  - update the record IN THE SAME CHANGE that causes the drift, so it keeps")
    print("    describing an image that actually exists:")
    print("        cog exec pip freeze > frozen-requirements.txt")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
