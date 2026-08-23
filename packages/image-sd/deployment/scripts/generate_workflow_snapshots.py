#!/usr/bin/env python3
"""Write the reviewable ComfyUI graph snapshots in `workflows/`.

    python3 scripts/generate_workflow_snapshots.py

Run from the deployment directory. Stdlib only — no GPU, no torch, no ComfyUI —
because `sd_workflow.py` is pure, and that purity is what makes these snapshots
worth checking in.

The snapshots exist so the graph can be REVIEWED. `deployment/README.md` is
explicit that production must never execute arbitrary workflow JSON; the flip
side is that a graph expressed only as Python is hard to argue about in a diff.
These files close that gap: five canonical input combinations, rendered to the
exact payload the ComfyUI API would receive, so a reviewer can see that the LoRA
sits between the checkpoint and the text encoders, that PuLID patches the model
rather than the conditioning, and that depth runs before pose.

They are also this module's smoke test. Every combination is built, so a typo in
a node name, a missing manifest artifact or a broken branch shows up here rather
than on a GPU forty minutes later.

Regenerate after ANY change to `sd_workflow.py`, `recipes.json` or
`weights_manifest.json`, and commit the result with the change.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

DEPLOYMENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(DEPLOYMENT_DIR))

from sd_workflow import (  # noqa: E402  (path set above so this runs from anywhere)
    WorkflowInputs,
    build_workflow,
    manifest_filename,
    select_recipe,
)

OUTPUT_DIR = DEPLOYMENT_DIR / "workflows"

#: Fixed so a rebuild is a no-op diff. A snapshot whose seed moved would show a
#: change on every run and stop being readable as a review artifact.
SNAPSHOT_SEED = 1
SNAPSHOT_PROMPT = "a photograph of a woman standing in a sunlit kitchen, natural light"
SNAPSHOT_NEGATIVE = "blurry, low quality"
SNAPSHOT_WIDTH = 832
SNAPSHOT_HEIGHT = 1216

#: The five combinations the deployment actually implements, in the order the
#: plan turns them on: base render, identity, identity + trained LoRA, identity +
#: depth, and the full stack. Anything not on this list is a branch this
#: deployment does not build.
CASES: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("base", "sdxl/base-portrait", {}),
    ("identity", "sdxl/identity-portrait", {"reference_image": "reference.png"}),
    (
        "identity-lora",
        "sdxl/identity-portrait",
        {"reference_image": "reference.png", "lora_file": "character.safetensors"},
    ),
    (
        "identity-depth",
        "sdxl/identity-portrait",
        {"reference_image": "reference.png", "depth_image": "depth.png"},
    ),
    (
        "identity-pose-depth",
        "sdxl/identity-portrait",
        {
            "reference_image": "reference.png",
            "depth_image": "depth.png",
            "pose_image": "pose.png",
        },
    ),
)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf8"))


def main() -> int:
    recipes = load_json(DEPLOYMENT_DIR / "recipes.json")
    manifest = load_json(DEPLOYMENT_DIR / "weights_manifest.json")
    assets = {
        "checkpoint_file": manifest_filename(manifest, "sdxl-base-checkpoint"),
        "pulid_file": manifest_filename(manifest, "pulid-sdxl"),
        "depth_controlnet_file": manifest_filename(manifest, "controlnet-depth-sdxl"),
        "pose_controlnet_file": manifest_filename(manifest, "controlnet-openpose-sdxl"),
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, recipe_id, overrides in CASES:
        recipe = select_recipe(recipes, recipe_id)
        inputs = WorkflowInputs(
            prompt=SNAPSHOT_PROMPT,
            negative_prompt=SNAPSHOT_NEGATIVE,
            width=SNAPSHOT_WIDTH,
            height=SNAPSHOT_HEIGHT,
            seed=SNAPSHOT_SEED,
            **assets,
            **overrides,
        )
        graph = build_workflow(recipe, inputs)
        path = OUTPUT_DIR / f"{name}.json"
        path.write_text(f"{json.dumps(graph, indent=2)}\n", encoding="utf8")
        print(f"  {path.relative_to(DEPLOYMENT_DIR)}  ({recipe_id} revision {recipe['revision']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
