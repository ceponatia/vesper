#!/usr/bin/env python3
"""Fail when cog.yaml's baked-weight declarations drift from the manifest.

Cog's build.run commands cannot read source files, so the immutable weight URLs
and digests have to appear both in weights_manifest.json (runtime/provenance) and
in cog.yaml (image-build download). This cheap source check makes that necessary
duplication loud instead of allowing a rebuild to bake one artifact while the
predictor believes it pinned another.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEPLOYMENT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = DEPLOYMENT_DIR / "weights_manifest.json"
COG_PATH = DEPLOYMENT_DIR / "cog.yaml"


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf8"))
    cog = COG_PATH.read_text(encoding="utf8")
    errors: list[str] = []

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("weights_manifest.json has no artifacts list")
    else:
        for artifact in artifacts:
            name = str(artifact.get("name", "<unnamed>"))
            required = {
                "source_url": artifact.get("source_url"),
                "sha256": artifact.get("sha256"),
                "filename": artifact.get("filename"),
            }
            if artifact.get("kind") == "hf_hub":
                required["hf_repo_id"] = artifact.get("hf_repo_id")
                required["hf_filename"] = artifact.get("hf_filename")

            for field, value in required.items():
                if not isinstance(value, str) or not value:
                    errors.append(f"{name}: manifest field {field} is missing")
                    continue
                if value not in cog:
                    errors.append(
                        f"{name}: {field}={value!r} is absent from cog.yaml's baked-weight steps"
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

    print(f"Static weight bake matches {len(artifacts)} manifest artifacts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
