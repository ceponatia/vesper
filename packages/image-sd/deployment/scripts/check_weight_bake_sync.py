#!/usr/bin/env python3
"""Fail when cog.yaml's baked-weight declarations drift from the manifest.

Cog's build.run commands cannot read source files, so immutable weight identity
has to appear both in weights_manifest.json (runtime/provenance) and in cog.yaml
(image-build download). This source check compares each ordinary download as one
URL + destination + digest tuple so a correct filename/hash in the wrong model
directory cannot pass merely because all of the same strings appear somewhere in
cog.yaml.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEPLOYMENT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = DEPLOYMENT_DIR / "weights_manifest.json"
COG_PATH = DEPLOYMENT_DIR / "cog.yaml"


def _unquote_bake_arg(line: str, *, trailing_slash: bool) -> str | None:
    value = line.strip()
    if trailing_slash:
        if not value.endswith("\\"):
            return None
        value = value[:-1].rstrip()
    if len(value) < 2 or not value.startswith('"') or not value.endswith('"'):
        return None
    return value[1:-1]


def _parse_fetch_weight_calls(cog: str) -> tuple[list[tuple[str, str, str]], list[str]]:
    lines = cog.splitlines()
    calls: list[tuple[str, str, str]] = []
    errors: list[str] = []
    for index, line in enumerate(lines):
        if line.strip() != "fetch_weight \\":
            continue
        if index + 3 >= len(lines):
            errors.append(f"cog.yaml line {index + 1}: truncated fetch_weight declaration")
            continue
        source_url = _unquote_bake_arg(lines[index + 1], trailing_slash=True)
        destination = _unquote_bake_arg(lines[index + 2], trailing_slash=True)
        sha256 = _unquote_bake_arg(lines[index + 3], trailing_slash=False)
        if source_url is None or destination is None or sha256 is None:
            errors.append(
                f"cog.yaml line {index + 1}: fetch_weight must be URL, destination, sha256"
            )
            continue
        calls.append((source_url, destination, sha256))
    return calls, errors


def _expected_destination(artifact: dict[str, object]) -> str | None:
    target_root = artifact.get("target_root")
    target_dir = artifact.get("target_dir")
    filename = artifact.get("filename")
    if not isinstance(target_dir, str) or not isinstance(filename, str):
        return None
    if target_root == "comfyui":
        root = "/ComfyUI"
    elif target_root == "facexlib":
        root = "$FACEXLIB_DIR"
    else:
        return None
    suffix = "/".join(part for part in (target_dir.strip("/"), filename) if part)
    return f"{root}/{suffix}"


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf8"))
    cog = COG_PATH.read_text(encoding="utf8")
    errors: list[str] = []

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("weights_manifest.json has no artifacts list")
        artifacts = []

    calls, parse_errors = _parse_fetch_weight_calls(cog)
    errors.extend(parse_errors)
    unmatched_calls = set(calls)

    for raw_artifact in artifacts:
        if not isinstance(raw_artifact, dict):
            errors.append("weights_manifest.json contains a non-object artifact")
            continue
        artifact: dict[str, object] = raw_artifact
        name = str(artifact.get("name", "<unnamed>"))
        if artifact.get("kind") == "hf_hub":
            # The build intentionally uses huggingface_hub rather than the
            # manifest's equivalent resolve URL so the cache has the exact
            # repo/snapshot layout PuLID consumes. Check its cache address and
            # identity explicitly; ordinary fetch_weight tuple parsing does not
            # apply to this special case.
            required = {
                "sha256": artifact.get("sha256"),
                "filename": artifact.get("filename"),
                "hf_repo_id": artifact.get("hf_repo_id"),
                "hf_filename": artifact.get("hf_filename"),
            }
            for field, value in required.items():
                if not isinstance(value, str) or not value:
                    errors.append(f"{name}: manifest field {field} is missing")
                elif value not in cog:
                    errors.append(f"{name}: {field}={value!r} is absent from cog.yaml")
            if 'cache_dir="/hf-cache/hub"' not in cog or "HF_HOME=/hf-cache" not in cog:
                errors.append(f"{name}: cog.yaml does not bake the artifact into /hf-cache/hub")
            continue

        source_url = artifact.get("source_url")
        sha256 = artifact.get("sha256")
        destination = _expected_destination(artifact)
        if not isinstance(source_url, str) or not source_url:
            errors.append(f"{name}: manifest field source_url is missing")
            continue
        if not isinstance(sha256, str) or not sha256:
            errors.append(f"{name}: manifest field sha256 is missing")
            continue
        if destination is None:
            errors.append(
                f"{name}: unsupported or incomplete target path "
                f"{artifact.get('target_root')!r}/{artifact.get('target_dir')!r}/{artifact.get('filename')!r}"
            )
            continue

        expected = (source_url, destination, sha256)
        if expected not in unmatched_calls:
            errors.append(
                f"{name}: cog.yaml does not contain the exact baked tuple "
                f"url={source_url!r}, destination={destination!r}, sha256={sha256!r}"
            )
        else:
            unmatched_calls.remove(expected)

    for source_url, destination, sha256 in sorted(unmatched_calls):
        errors.append(
            "cog.yaml contains an unmanifested fetch_weight tuple: "
            f"url={source_url!r}, destination={destination!r}, sha256={sha256!r}"
        )

    if errors:
        print("Static weight bake is out of sync with weights_manifest.json:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print(
            "Update cog.yaml and weights_manifest.json together before rebuilding the renderer.",
            file=sys.stderr,
        )
        return 1

    print(f"Static weight bake matches {len(artifacts)} manifest artifacts and target paths.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
