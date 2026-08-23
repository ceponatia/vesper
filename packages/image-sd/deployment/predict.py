"""The Cog predictor for Vesper's SDXL character renderer.

One prediction internally loads a checkpoint, optionally patches it with a
character LoRA, optionally conditions it on an identity reference through PuLID,
optionally applies depth and pose ControlNets, samples, decodes and saves. From
Vesper's side it was one image render, with one cost line, one provenance record
and one retry — which is the whole point of owning the model
(sd-rendering-package.plan.md §5).

The input names are snake_case on purpose: they are the vocabulary Vesper's
existing Replicate capability probe reads, so this model registers as an
ordinary `image_models` row and its inputs bind to image-core controls with no
Stable Diffusion special case anywhere in the render path.

Three responsibilities live here and nowhere else:

- **IO.** Fetching weights, staging files where ComfyUI can find them, running
  the server, polling it, returning the image. `sd_workflow.py` stays pure.
- **Resolution.** Turning a recipe id into one frozen revision, and a request
  into the numbers that revision actually implies.
- **Refusal.** An unknown recipe, an out-of-range size, a LoRA URL that is not
  weights, or a recipe demanding a feature this deployment does not build, all
  fail with a sentence an operator can act on — before or instead of producing a
  plausible image nobody can explain.
"""

# No `from __future__ import annotations` here, deliberately: Cog builds this
# model's published OpenAPI schema by INSPECTING the annotations on `predict`,
# and PEP 563 would hand it the string "Path" rather than the class. That schema
# is exactly what Vesper's capability probe reads.

import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path as FsPath
from typing import Any, Mapping

from cog import BasePredictor, Input, Path

from sd_workflow import (
    NODE_SAVE,
    SdWorkflowError,
    WorkflowInputs,
    build_workflow,
    identity_recipe_ids,
    manifest_filename,
    resolved_settings,
    select_recipe,
)

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

DEPLOYMENT_DIR = FsPath(__file__).resolve().parent
#: Cloned at an exact commit by cog.yaml, deliberately outside /src so the
#: project copy that lands there cannot interact with it.
COMFY_DIR = FsPath("/ComfyUI")
COMFY_INPUT_DIR = COMFY_DIR / "input"
COMFY_OUTPUT_DIR = COMFY_DIR / "output"
#: PuLID's EVA-CLIP loader resolves its weights through huggingface_hub, so the
#: hub cache is a real model directory here rather than an incidental one.
HF_CACHE_DIR = FsPath("/hf-cache")
#: Where huggingface_hub actually keeps downloaded repo files: `HF_HOME/hub`,
#: never `HF_HOME` itself (`huggingface_hub.constants.HF_HUB_CACHE`). The warm
#: must target this exact directory, because PuLID's EVA-CLIP loader calls
#: `hf_hub_download` with no `cache_dir` and therefore reads only here — a warm
#: one level up is a warm nothing reads, and the first prediction quietly
#: re-downloads 1.7 GB mid-render.
HF_HUB_CACHE_DIR = HF_CACHE_DIR / "hub"
PREDICTION_OUTPUT_DIR = FsPath("/tmp/vesper-predictions")

COMFY_HOST = "127.0.0.1"
COMFY_PORT = 8188
COMFY_URL = f"http://{COMFY_HOST}:{COMFY_PORT}"

#: The server loads torch and scans custom nodes before it answers.
SERVER_READY_TIMEOUT_S = 600
SERVER_POLL_INTERVAL_S = 1.0
#: A 35-step SDXL render with PuLID and two ControlNets, with headroom for a
#: cold model load. Exceeding it is a hang, not a slow render.
PREDICTION_TIMEOUT_S = 1800
HISTORY_POLL_INTERVAL_S = 1.0
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
#: Every HTTP call this predictor makes is given a socket timeout. Without one,
#: `urlopen` blocks forever on a stalled connection, and a deadline loop cannot
#: fire while it is blocked INSIDE the call it is supposed to be bounding — the
#: render would hang past PREDICTION_TIMEOUT_S rather than fail at it.
HTTP_TIMEOUT_S = 30
#: Weight downloads are large, so a stalled-socket timeout has to allow for a
#: slow chunk rather than a slow file; this bounds silence, not size.
DOWNLOAD_TIMEOUT_S = 300

# ---------------------------------------------------------------------------
# Input defaults
# ---------------------------------------------------------------------------

#: The default recipe is the identity one, and that is a deliberate choice
#: rather than a preference.
#:
#: The Advanced Image Lab reaches a registered model by typing its slug and
#: cannot send a `recipe` input, so whatever sits here is what every lab run
#: gets. `sdxl/identity-portrait` degrades EXACTLY to `sdxl/base-portrait` when
#: no reference image and no LoRA arrive — its extra fields (identityWeight,
#: loraScale) only configure branches that those inputs create — so defaulting
#: to it costs a base render nothing and saves an identity render from silently
#: running without identity.
#:
#: It also has to be an identity recipe for a second reason: a reference image
#: sent to a recipe with no identity weight is refused, and a lab run that
#: cannot name a recipe would otherwise be unable to use a reference at all.
DEFAULT_RECIPE = "sdxl/identity-portrait"
#: The native portrait size of every seeded recipe (plan §7).
DEFAULT_WIDTH = 832
DEFAULT_HEIGHT = 1216
#: Wide enough to make a collision irrelevant, small enough to read in a log.
MAX_SEED = 2**32 - 1
#: Matches `@vesper/image-core`'s curated LoRA scale band.
MIN_LORA_SCALE = 0.0
MAX_LORA_SCALE = 4.0
#: SDXL's VAE works in 8-pixel blocks; the TypeScript contract says the same.
SIZE_MULTIPLE = 8
MIN_SIZE = 256
MAX_SIZE = 2048

#: Manifest artifacts the graph names, mapped to the builder's field names.
GRAPH_ASSETS = {
    "checkpoint_file": "sdxl-base-checkpoint",
    "pulid_file": "pulid-sdxl",
    "depth_controlnet_file": "controlnet-depth-sdxl",
    "pose_controlnet_file": "controlnet-openpose-sdxl",
}


def _log(message: str) -> None:
    print(message, flush=True)


def _facexlib_dir() -> FsPath:
    """Where facexlib's own downloader writes: the installed package directory."""
    import facexlib

    return FsPath(facexlib.__file__).resolve().parent


def _sha256(path: FsPath) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, destination: FsPath) -> None:
    """Stream one file to disk, through a partial name so a crash cannot leave a
    truncated file that every later boot happily reuses."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(f"{destination.name}.partial")
    with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as response, partial.open("wb") as handle:
        shutil.copyfileobj(response, handle, DOWNLOAD_CHUNK_BYTES)
    partial.rename(destination)


class Predictor(BasePredictor):
    def setup(self) -> None:
        """Stage every weight, then start ComfyUI and wait for it to answer."""
        self._recipes: list[dict[str, Any]] = json.loads(
            (DEPLOYMENT_DIR / "recipes.json").read_text(encoding="utf8")
        )
        self._manifest: dict[str, Any] = json.loads(
            (DEPLOYMENT_DIR / "weights_manifest.json").read_text(encoding="utf8")
        )
        self._assets = {
            field: manifest_filename(self._manifest, name) for field, name in GRAPH_ASSETS.items()
        }

        os.environ["HF_HOME"] = str(HF_CACHE_DIR)
        HF_HUB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        PREDICTION_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)

        self._fetch_weights()
        self._start_server()

    # -- weights ------------------------------------------------------------

    def _fetch_weights(self) -> None:
        """Fetch every manifest artifact that is not already on disk.

        Idempotent: a file that exists is left alone, so a warm container boots
        without touching the network and a partial first boot resumes rather
        than starting over. Digests are checked on the download that produced
        the file, not on every boot — re-hashing ~15 GB per cold start would cost
        more than it protects, and the file cannot change between boots.
        """
        for artifact in self._manifest["artifacts"]:
            name = artifact["name"]
            if artifact["kind"] == "hf_hub":
                self._fetch_from_hub(artifact)
                continue

            destination = self._artifact_path(artifact)
            if destination.exists():
                _log(f"  {name}: already present")
                continue
            _log(f"  {name}: downloading {artifact['source_url']}")
            _download(artifact["source_url"], destination)
            expected = artifact.get("sha256")
            if expected is not None:
                actual = _sha256(destination)
                if actual != expected:
                    destination.unlink(missing_ok=True)
                    raise RuntimeError(
                        f"{name} downloaded from {artifact['source_url']} has sha256 {actual}, "
                        f"but weights_manifest.json pins {expected}. The artifact moved; "
                        f"nothing was kept."
                    )

    def _fetch_from_hub(self, artifact: dict[str, Any]) -> None:
        """Warm one Hugging Face hub artifact into the cache its consumer reads."""
        from huggingface_hub import hf_hub_download

        _log(f"  {artifact['name']}: resolving through huggingface_hub")
        hf_hub_download(
            repo_id=artifact["hf_repo_id"],
            filename=artifact["hf_filename"],
            cache_dir=str(HF_HUB_CACHE_DIR),
        )

    def _artifact_path(self, artifact: dict[str, Any]) -> FsPath:
        roots = {"comfyui": COMFY_DIR, "facexlib": _facexlib_dir(), "hf_cache": HF_CACHE_DIR}
        root = roots.get(artifact["target_root"])
        if root is None:
            raise RuntimeError(
                f"{artifact['name']} names target_root {artifact['target_root']!r}, "
                f"which this predictor does not know. Known: {sorted(roots)}"
            )
        return root / artifact["target_dir"] / artifact["filename"]

    # -- the ComfyUI server -------------------------------------------------

    def _start_server(self) -> None:
        """Run ComfyUI as a subprocess and block until it answers.

        In-process would be simpler, but ComfyUI is an application rather than a
        library: it owns an event loop, an argument parser and a node registry,
        and importing it would make every Cog concern a ComfyUI concern. A
        subprocess keeps the seam at HTTP, which is also the seam the snapshots
        in `workflows/` describe.
        """
        _log("Starting ComfyUI …")
        self._server = subprocess.Popen(  # noqa: S603  (fixed argv, no shell)
            [
                sys.executable,
                "main.py",
                "--listen",
                COMFY_HOST,
                "--port",
                str(COMFY_PORT),
                "--disable-auto-launch",
                # Every saved PNG would otherwise carry the full workflow and the
                # prompt text in its metadata, and those images travel into
                # Vesper's own storage and out to players.
                "--disable-metadata",
                # Nothing here submits a user-authored graph, so the API node and
                # manager surfaces are attack surface with no upside.
                "--disable-api-nodes",
            ],
            cwd=str(COMFY_DIR),
            env={**os.environ, "HF_HOME": str(HF_CACHE_DIR)},
        )

        deadline = time.monotonic() + SERVER_READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if self._server.poll() is not None:
                raise RuntimeError(
                    f"ComfyUI exited during startup with code {self._server.returncode}. "
                    f"Its output is above this line."
                )
            try:
                with urllib.request.urlopen(f"{COMFY_URL}/system_stats", timeout=5) as response:
                    if response.status == 200:
                        _log("ComfyUI is ready.")
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(SERVER_POLL_INTERVAL_S)
        raise RuntimeError(f"ComfyUI did not become ready within {SERVER_READY_TIMEOUT_S}s")

    # -- one prediction -----------------------------------------------------

    def predict(  # noqa: PLR0913  (this signature IS the model's public contract)
        self,
        prompt: str = Input(description="What to render. Authored by the caller; never assembled here."),
        negative_prompt: str = Input(
            description=(
                "What to avoid. Authored by the caller: a legitimate render can contain unusual "
                "anatomy, prosthetics, text, logos, blur or non-human features, so this model "
                "injects nothing of its own."
            ),
            default="",
        ),
        reference_image: Path | None = Input(
            description="Identity reference for PuLID conditioning. Absent means no identity conditioning runs.",
            default=None,
        ),
        depth_image: Path | None = Input(
            description=(
                "An ALREADY-PREPROCESSED depth map for the depth ControlNet. This model runs no "
                "preprocessors — send a depth map, not a photograph."
            ),
            default=None,
        ),
        pose_image: Path | None = Input(
            description=(
                "An ALREADY-PREPROCESSED OpenPose skeleton render for the pose ControlNet. As with "
                "depth, no preprocessing happens here."
            ),
            default=None,
        ),
        lora_weights: str | None = Input(
            description="URL of one character LoRA (.safetensors). Absent means no LoRA is loaded.",
            default=None,
        ),
        lora_scale: float | None = Input(
            description="Overrides the recipe's LoRA scale. Ignored when no LoRA is sent.",
            default=None,
            ge=MIN_LORA_SCALE,
            le=MAX_LORA_SCALE,
        ),
        seed: int | None = Input(
            description="Fixed seed for a reproducible render. Absent means one is generated and logged.",
            default=None,
            ge=0,
        ),
        width: int = Input(description="Output width in pixels.", default=DEFAULT_WIDTH),
        height: int = Input(description="Output height in pixels.", default=DEFAULT_HEIGHT),
        recipe: str = Input(
            description=(
                "Which frozen recipe to run, by id. The default is the identity recipe, which "
                "degrades to the base recipe when neither a reference image nor LoRA weights are sent."
            ),
            default=DEFAULT_RECIPE,
        ),
    ) -> Path:
        """Render one image and return it."""
        selected = select_recipe(self._recipes, recipe)
        _log(f"Recipe {selected['id']} revision {selected['revision']}")
        if selected.get("width") != width or selected.get("height") != height:
            _log(
                f"  note: rendering at {width}x{height}; this recipe's native size is "
                f"{selected.get('width')}x{selected.get('height')}"
            )

        _validate_size("width", width)
        _validate_size("height", height)
        self._validate_identity(selected, reference_image)
        chosen_seed = random.randint(0, MAX_SEED) if seed is None else int(seed)
        _log(f"  seed {chosen_seed}")

        prediction_id = uuid.uuid4().hex
        # Staged inputs AND the ComfyUI-side output, all removed in `finally`.
        # The output copy matters as much as the inputs: a warm worker serves
        # many predictions from one container, and a PNG left in ComfyUI's output
        # directory each time is a disk leak that ends the worker rather than the
        # render. (The copy under PREDICTION_OUTPUT_DIR is the value being
        # returned, so Cog still owns its lifetime — it cannot be removed here.)
        scratch: list[FsPath] = []
        try:
            inputs = WorkflowInputs(
                prompt=prompt,
                negative_prompt=negative_prompt,
                width=width,
                height=height,
                seed=chosen_seed,
                filename_prefix=prediction_id,
                reference_image=self._stage(reference_image, prediction_id, "reference", scratch),
                depth_image=self._stage(depth_image, prediction_id, "depth", scratch),
                pose_image=self._stage(pose_image, prediction_id, "pose", scratch),
                lora_file=self._stage_lora(lora_weights),
                lora_scale=lora_scale,
                **self._assets,
            )
            _log(f"  settings {json.dumps(resolved_settings(selected, inputs), sort_keys=True)}")

            graph = build_workflow(selected, inputs)
            prompt_id = self._submit(graph)
            image = self._await_image(prompt_id)
            scratch.append(image)
            destination = PREDICTION_OUTPUT_DIR / f"{prediction_id}{image.suffix}"
            shutil.copyfile(image, destination)
            return Path(destination)
        except SdWorkflowError as error:
            # The builder's refusals are operator-facing sentences, not bugs.
            raise ValueError(str(error)) from error
        finally:
            for path in scratch:
                path.unlink(missing_ok=True)

    def _validate_identity(self, selected: Mapping[str, Any], reference_image: Path | None) -> None:
        """Refuse a reference image sent to a recipe that runs no identity.

        The alternative implementations are both worse. Ignoring the reference
        renders a stranger and reports success. Conditioning anyway turns
        `sdxl/base-portrait` — the control arm the whole Stage 3 matrix is
        measured against — into a fourth identity cell, and the comparison it
        exists for silently measures nothing.
        """
        if reference_image is None or selected.get("identityWeight") is not None:
            return
        accepts = identity_recipe_ids(self._recipes)
        raise ValueError(
            f"recipe {selected['id']} runs no identity conditioning, so it cannot accept "
            f"reference_image. Send the reference with one of: {', '.join(accepts)} — or drop it "
            f"to run {selected['id']} as the no-identity recipe it is."
        )

    # -- staging ------------------------------------------------------------

    def _stage(
        self, source: Path | None, prediction_id: str, role: str, scratch: list[FsPath]
    ) -> str | None:
        """Copy one input image into ComfyUI's input directory under a unique name.

        Unique per prediction because ComfyUI's `LoadImage` addresses files by
        name inside a shared directory: a fixed name would let two concurrent
        predictions read each other's reference.
        """
        if source is None:
            return None
        suffix = FsPath(str(source)).suffix or ".png"
        name = f"{prediction_id}-{role}{suffix}"
        destination = COMFY_INPUT_DIR / name
        shutil.copyfile(str(source), destination)
        scratch.append(destination)
        return name

    def _stage_lora(self, url: str | None) -> str | None:
        """Fetch one LoRA into ComfyUI's loras directory, cached by URL.

        Cached rather than staged-and-deleted: a character's LoRA is the same
        file on every render of that character, and re-downloading it per
        prediction would add minutes to a warm container for nothing.
        """
        if url is None:
            return None
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"lora_weights must be an http(s) URL: {url}")
        if not parsed.path.endswith(".safetensors"):
            raise ValueError(
                f"lora_weights must point at a .safetensors file, not {parsed.path}. "
                f"A weights archive URL renders nothing — re-host the extracted file."
            )
        name = f"{hashlib.sha256(url.encode('utf8')).hexdigest()[:32]}.safetensors"
        destination = COMFY_DIR / "models" / "loras" / name
        if not destination.exists():
            _log(f"  fetching LoRA weights from {parsed.netloc}")
            _download(url, destination)
        return name

    # -- the ComfyUI API ----------------------------------------------------

    def _submit(self, graph: dict[str, Any]) -> str:
        body = json.dumps({"prompt": graph, "client_id": "vesper-sdxl-character-render"}).encode("utf8")
        request = urllib.request.Request(
            f"{COMFY_URL}/prompt", data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
                return str(json.loads(response.read())["prompt_id"])
        except urllib.error.HTTPError as error:
            # ComfyUI answers a rejected graph with the offending node and why,
            # which is the one thing worth surfacing verbatim.
            raise RuntimeError(f"ComfyUI rejected the workflow: {error.read().decode('utf8')}") from error

    def _await_image(self, prompt_id: str) -> FsPath:
        """Poll until the prediction finishes, then return the saved image's path."""
        deadline = time.monotonic() + PREDICTION_TIMEOUT_S
        while time.monotonic() < deadline:
            if self._server.poll() is not None:
                raise RuntimeError(f"ComfyUI exited mid-render with code {self._server.returncode}")
            with urllib.request.urlopen(
                f"{COMFY_URL}/history/{prompt_id}", timeout=HTTP_TIMEOUT_S
            ) as response:
                history = json.loads(response.read())
            # A prompt reaches /history only once it has settled, successfully or
            # not — a running one lives in /queue.
            entry = history.get(prompt_id)
            if entry is not None:
                status = entry.get("status", {})
                if status.get("status_str") != "success":
                    raise RuntimeError(f"ComfyUI failed the render: {json.dumps(status)}")
                return self._output_path(entry)
            time.sleep(HISTORY_POLL_INTERVAL_S)
        raise RuntimeError(f"the render did not finish within {PREDICTION_TIMEOUT_S}s")

    def _output_path(self, entry: dict[str, Any]) -> FsPath:
        """The single saved image. One output is the model's whole contract."""
        images = entry.get("outputs", {}).get(NODE_SAVE, {}).get("images", [])
        if not images:
            raise RuntimeError(f"the render finished but saved no image: {json.dumps(entry.get('status', {}))}")
        first = images[0]
        return COMFY_OUTPUT_DIR / first.get("subfolder", "") / first["filename"]


def _validate_size(field: str, value: int) -> None:
    if value < MIN_SIZE or value > MAX_SIZE:
        raise ValueError(f"{field} must be between {MIN_SIZE} and {MAX_SIZE}: {value}")
    if value % SIZE_MULTIPLE != 0:
        raise ValueError(f"{field} must be a multiple of {SIZE_MULTIPLE}: {value}")
