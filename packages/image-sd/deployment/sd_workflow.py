"""The frozen ComfyUI graph, as code.

This module turns one resolved Stable Diffusion recipe plus one resolved set of
request inputs into a ComfyUI **API-format** workflow: a flat dict keyed by node
id, where every node carries a ``class_type`` and an ``inputs`` mapping, and a
link is spelled ``[node_id, output_index]``.

Three properties are deliberate and load-bearing:

1. **It is pure.** Stdlib only — no ``torch``, no ``comfy``, no filesystem, no
   network, no clock, no randomness. The same recipe and the same inputs produce
   the same dict, byte for byte, on any machine. That is what lets
   ``scripts/generate_workflow_snapshots.py`` check reviewable JSON snapshots
   into git and lets a reviewer read the graph without a GPU.
2. **It is the graph of record.** `deployment/README.md` explains why production
   must never execute arbitrary workflow JSON: a graph edited in a browser has
   no version, no review, and no way to answer "what produced this image" later.
   Here the graph is source, the recipe names the numbers, and the diff shows
   the change.
3. **It refuses what it does not implement.** A recipe that asks for inpainting
   or a finishing pass raises rather than rendering a plausible image under
   settings nobody chose. Stage 2 implements identity conditioning, one LoRA,
   depth and pose ControlNet, and SDXL sampling; the repair and finishing
   passes arrive in Stage 7.

Every node class name and input name below was read from ComfyUI v0.33.1
(``nodes.py``) and from cubiq/PuLID_ComfyUI at commit ``93e0c4c2``. The recipe
vocabulary's sampler and scheduler names were chosen to BE ComfyUI's names, so
the mapping is identity — but it is still validated, because a name this
deployment has not verified would otherwise reach ``KSampler`` and be rejected
mid-prediction, after the money is spent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

__all__ = [
    "SdWorkflowError",
    "WorkflowInputs",
    "build_workflow",
    "identity_recipe_ids",
    "manifest_filename",
    "resolved_settings",
    "select_recipe",
]


class SdWorkflowError(ValueError):
    """A recipe or an input this deployment cannot honour, named out loud."""


# ---------------------------------------------------------------------------
# Pure lookups over already-loaded configuration
#
# `recipes.json` and `weights_manifest.json` are read by the caller — this
# module never opens a file. They live here rather than in `predict.py` because
# the snapshot generator needs the identical resolution: a snapshot built from a
# different revision than the one a prediction would run is worse than no
# snapshot.
# ---------------------------------------------------------------------------


def select_recipe(recipes: Sequence[Mapping[str, Any]], recipe_id: str) -> Mapping[str, Any]:
    """The LIVE revision of one recipe — the highest revision registered for it.

    The registry keeps every revision so a historical render can still say what
    produced it; an operator naming an id gets the current one. An unknown id
    fails with the list of ids that would have worked, because the alternative —
    falling back to some default — is a paid prediction under settings nobody
    chose, filed under a name that never existed.
    """
    matches = [recipe for recipe in recipes if recipe.get("id") == recipe_id]
    if not matches:
        known = sorted({str(recipe.get("id")) for recipe in recipes})
        raise SdWorkflowError(f"unknown recipe {recipe_id!r}. Known recipes: {', '.join(known)}")
    return max(matches, key=lambda recipe: int(recipe.get("revision", 0)))


def identity_recipe_ids(recipes: Sequence[Mapping[str, Any]]) -> list[str]:
    """Ids of the recipes that carry an identity weight — the ones a reference
    image may be sent to.

    Used to make the refusal actionable: "this recipe cannot use a reference
    image" is only half an answer, and the other half is which ones can.
    """
    return sorted(
        {str(recipe["id"]) for recipe in recipes if recipe.get("identityWeight") is not None}
    )


def manifest_filename(manifest: Mapping[str, Any], name: str) -> str:
    """The on-disk filename of one manifest artifact, by its manifest name."""
    for artifact in manifest.get("artifacts", []):
        if artifact.get("name") == name:
            return str(artifact["filename"])
    raise SdWorkflowError(f"weights_manifest.json has no artifact named {name!r}")


# ---------------------------------------------------------------------------
# What this deployment implements
# ---------------------------------------------------------------------------

#: Sampler names verified present in ``comfy.samplers.KSampler.SAMPLERS`` at
#: ComfyUI v0.33.1. Identical to the recipe contract's ``sdSamplers`` tuple.
COMFY_SAMPLERS = frozenset(
    {"dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "euler", "euler_ancestral"}
)

#: Scheduler names verified present in ``comfy.samplers.SCHEDULER_NAMES`` at
#: ComfyUI v0.33.1. Identical to the recipe contract's ``sdSchedulers`` tuple.
COMFY_SCHEDULERS = frozenset({"karras", "normal", "simple", "exponential"})

#: Recipe blocks whose behaviour lands in Stage 7. A recipe carrying one is
#: refused, not ignored: the recipe id is what render provenance records, so a
#: silently-dropped finishing pass would make that id describe an image it never
#: produced.
UNIMPLEMENTED_RECIPE_BLOCKS = ("inpaint", "finishing")

#: ControlNet roles the recipe vocabulary allows but this deployment has no
#: nodes for. Edge/Canny stays behind "only if trials prove useful".
UNIMPLEMENTED_CONTROLNETS = ("edge",)

# ---------------------------------------------------------------------------
# Built-in defaults
#
# These apply ONLY where the recipe is silent. A recipe value always wins, and
# an explicit request input (``lora_scale``) wins over the recipe — the caller
# knowingly overrode a frozen number, which is a different act from the recipe
# not having one.
#
# **Identity has NO default, on purpose.** A missing ``identityWeight`` is not
# silence, it is a statement: `sdxl/base-portrait` is Stage 3's control arm, and
# the whole point of the arm is that no identity conditioning runs. A fallback
# weight would let a reference image quietly turn the control into a fourth
# identity cell, and the comparison it exists for would be measuring nothing.
# So a reference image sent to a recipe with no identity weight is REFUSED —
# see ``build_workflow``.
#
# The ControlNet strengths below keep their fallbacks, and that asymmetry is
# deliberate rather than an oversight. Depth and pose are pre-Stage-5 lab
# controls with no recipe carrying them yet, both have explicit starting
# bands, and every resolved value is logged with the render — so a
# default there is a documented starting point rather than a silent substitution
# for a decision the recipe already made.
# ---------------------------------------------------------------------------

#: LoRA scale when neither the request nor the recipe names one. 1.0 is the
#: trained strength of the weights as published, so it is the honest "no opinion".
DEFAULT_LORA_SCALE = 1.0
#: Depth ControlNet defaults — the starting band is roughly 0.45–0.70.
DEFAULT_DEPTH_STRENGTH = 0.5
#: Pose ControlNet defaults — the starting band is roughly 0.65–0.85.
DEFAULT_POSE_STRENGTH = 0.75
#: A control with no recipe window runs over the whole schedule.
DEFAULT_CONTROL_START = 0.0
DEFAULT_CONTROL_END = 1.0

#: PuLID's normalization mode. ``fidelity`` is the identity-preserving one, and
#: it is what Vesper already sends the third-party SDXL PuLID model, so a
#: comparison between the two is a comparison of the pipelines rather than of
#: two different PuLID settings.
PULID_METHOD = "fidelity"
#: The ONNX execution provider insightface runs its face detector on.
PULID_INSIGHTFACE_PROVIDER = "CUDA"
#: Identity conditioning spans the whole schedule; the recipe's identity weight
#: is the dial, not the window.
PULID_START_AT = 0.0
PULID_END_AT = 1.0

#: No img2img in Stage 2 — every render starts from an empty latent.
SAMPLER_DENOISE = 1.0

# ---------------------------------------------------------------------------
# Node ids
#
# Stable, semantic, and never reused. ComfyUI keys its prompt payload by
# arbitrary strings (verified against execution.py at v0.33.1 — node ids are
# never parsed as integers), so the snapshots read as a graph rather than as a
# numbered soup, and a diff between two snapshots names the node that moved.
# ---------------------------------------------------------------------------

NODE_CHECKPOINT = "checkpoint"
NODE_LORA = "lora"
NODE_POSITIVE = "positive_prompt"
NODE_NEGATIVE = "negative_prompt"
NODE_LATENT = "empty_latent"
NODE_REFERENCE_IMAGE = "reference_image"
NODE_PULID_MODEL = "pulid_model"
NODE_PULID_EVA_CLIP = "pulid_eva_clip"
NODE_PULID_INSIGHTFACE = "pulid_insightface"
NODE_PULID_APPLY = "pulid_apply"
NODE_DEPTH_IMAGE = "depth_image"
NODE_DEPTH_CONTROLNET = "depth_controlnet"
NODE_DEPTH_APPLY = "depth_apply"
NODE_POSE_IMAGE = "pose_image"
NODE_POSE_CONTROLNET = "pose_controlnet"
NODE_POSE_APPLY = "pose_apply"
NODE_SAMPLER = "sampler"
NODE_DECODE = "vae_decode"
NODE_SAVE = "save_image"


@dataclass(frozen=True)
class WorkflowInputs:
    """One render's resolved inputs, in the vocabulary the graph needs.

    Everything here is a NAME, never a path or a URL: image fields name a file
    already staged in ComfyUI's ``input/`` directory, and weight fields name a
    file already present in the matching ``models/`` directory. Fetching,
    staging and validating those files is ``predict.py``'s job, which is what
    keeps this module free of IO.
    """

    prompt: str
    negative_prompt: str
    width: int
    height: int
    seed: int
    #: Filenames inside ComfyUI's model directories, taken from the weights
    #: manifest so the graph and the downloader cannot drift apart.
    checkpoint_file: str
    pulid_file: str
    depth_controlnet_file: str
    pose_controlnet_file: str
    filename_prefix: str = "vesper"
    #: Present ⇒ the PuLID branch is built. Absent ⇒ no identity conditioning,
    #: whatever the recipe's identity weight says.
    reference_image: str | None = None
    #: ALREADY-PREPROCESSED control maps — a depth map, an OpenPose skeleton
    #: render. This deployment ships no preprocessors; see the README.
    depth_image: str | None = None
    pose_image: str | None = None
    #: Present ⇒ the LoRA branch is built.
    lora_file: str | None = None
    #: An explicit override of the recipe's ``loraScale``.
    lora_scale: float | None = None


# ---------------------------------------------------------------------------
# Recipe reading
# ---------------------------------------------------------------------------


def _require(recipe: Mapping[str, Any], field: str) -> Any:
    if field not in recipe:
        raise SdWorkflowError(f"recipe {recipe.get('id', '<unnamed>')} has no {field}")
    return recipe[field]


def _reject_unimplemented(recipe: Mapping[str, Any]) -> None:
    """Fail loudly on a recipe asking for behaviour Stage 2 does not build."""
    recipe_id = recipe.get("id", "<unnamed>")
    for block in UNIMPLEMENTED_RECIPE_BLOCKS:
        if recipe.get(block) is not None:
            raise SdWorkflowError(
                f"recipe {recipe_id} sets `{block}`, which this deployment does not implement yet "
                f"(inpainting and the finishing pass land in Stage 7). Run a recipe without it, "
                f"or extend the deployment before registering this one."
            )
    control_nets = recipe.get("controlNets") or {}
    for role in UNIMPLEMENTED_CONTROLNETS:
        if control_nets.get(role) is not None:
            raise SdWorkflowError(
                f"recipe {recipe_id} configures the `{role}` ControlNet, which this deployment has no "
                f"nodes for. Stage 2 implements depth and pose only."
            )


def _control_setting(
    recipe: Mapping[str, Any], role: str, default_strength: float
) -> tuple[float, float, float]:
    """``(strength, start, end)`` for one ControlNet — recipe first, then defaults."""
    setting = (recipe.get("controlNets") or {}).get(role) or {}
    return (
        float(setting.get("strength", default_strength)),
        float(setting.get("start", DEFAULT_CONTROL_START)),
        float(setting.get("end", DEFAULT_CONTROL_END)),
    )


def resolved_settings(recipe: Mapping[str, Any], inputs: WorkflowInputs) -> dict[str, Any]:
    """Every number this render will actually run under, for the prediction log.

    Separate from {@link build_workflow} on purpose: an operator reading a failed
    render's logs wants the eight numbers, not a hundred-line graph, and a
    logging call that had to walk the built graph would break the moment a node
    was rewired.
    """
    settings: dict[str, Any] = {
        "recipe": recipe.get("id"),
        "revision": recipe.get("revision"),
        "checkpoint": inputs.checkpoint_file,
        "sampler": recipe.get("sampler"),
        "scheduler": recipe.get("scheduler"),
        "steps": recipe.get("steps"),
        "cfg": recipe.get("cfg"),
        "width": inputs.width,
        "height": inputs.height,
        "seed": inputs.seed,
    }
    identity_weight = recipe.get("identityWeight")
    if inputs.reference_image is not None and identity_weight is not None:
        settings["identity_weight"] = float(identity_weight)
        settings["identity_method"] = PULID_METHOD
    if inputs.lora_file is not None:
        settings["lora_scale"] = _lora_scale(recipe, inputs)
    if inputs.depth_image is not None:
        strength, start, end = _control_setting(recipe, "depth", DEFAULT_DEPTH_STRENGTH)
        settings["depth"] = {"strength": strength, "start": start, "end": end}
    if inputs.pose_image is not None:
        strength, start, end = _control_setting(recipe, "pose", DEFAULT_POSE_STRENGTH)
        settings["pose"] = {"strength": strength, "start": start, "end": end}
    return settings


def _lora_scale(recipe: Mapping[str, Any], inputs: WorkflowInputs) -> float:
    """Explicit input, then the recipe, then 1.0."""
    if inputs.lora_scale is not None:
        return float(inputs.lora_scale)
    return float(recipe.get("loraScale", DEFAULT_LORA_SCALE))


# ---------------------------------------------------------------------------
# The graph
# ---------------------------------------------------------------------------


def _node(class_type: str, inputs: dict[str, Any]) -> dict[str, Any]:
    return {"class_type": class_type, "inputs": inputs}


def build_workflow(recipe: Mapping[str, Any], inputs: WorkflowInputs) -> dict[str, Any]:
    """The ComfyUI API-format graph for one render.

    Branches are built ONLY when the request carries the input they consume:
    PuLID needs a reference image, the LoRA loader needs weights, and a
    ControlNet needs its (already preprocessed) control map. A recipe's identity
    weight or LoRA scale therefore configures a branch rather than creating one —
    which is what makes ``sdxl/identity-portrait`` degrade exactly to
    ``sdxl/base-portrait`` when a caller sends neither a reference nor weights.
    """
    _reject_unimplemented(recipe)

    sampler_name = str(_require(recipe, "sampler"))
    scheduler = str(_require(recipe, "scheduler"))
    if sampler_name not in COMFY_SAMPLERS:
        raise SdWorkflowError(
            f"recipe {recipe.get('id', '<unnamed>')} names sampler {sampler_name!r}, which this "
            f"deployment has not verified against ComfyUI. Known: {sorted(COMFY_SAMPLERS)}"
        )
    if scheduler not in COMFY_SCHEDULERS:
        raise SdWorkflowError(
            f"recipe {recipe.get('id', '<unnamed>')} names scheduler {scheduler!r}, which this "
            f"deployment has not verified against ComfyUI. Known: {sorted(COMFY_SCHEDULERS)}"
        )

    graph: dict[str, Any] = {}
    graph[NODE_CHECKPOINT] = _node(
        "CheckpointLoaderSimple", {"ckpt_name": inputs.checkpoint_file}
    )

    # --- one LoRA, patching both the diffusion model and CLIP ---------------
    model_source: list[Any] = [NODE_CHECKPOINT, 0]
    clip_source: list[Any] = [NODE_CHECKPOINT, 1]
    if inputs.lora_file is not None:
        scale = _lora_scale(recipe, inputs)
        graph[NODE_LORA] = _node(
            "LoraLoader",
            {
                "model": model_source,
                "clip": clip_source,
                "lora_name": inputs.lora_file,
                # One scale drives both. There is a single LoRA slot for the
                # character identity, and splitting model/CLIP strength would
                # add a knob the recipe contract does not carry and nothing
                # would record.
                "strength_model": scale,
                "strength_clip": scale,
            },
        )
        model_source = [NODE_LORA, 0]
        clip_source = [NODE_LORA, 1]

    # --- prompts, encoded by the (possibly LoRA-patched) CLIP ---------------
    graph[NODE_POSITIVE] = _node(
        "CLIPTextEncode", {"text": inputs.prompt, "clip": clip_source}
    )
    graph[NODE_NEGATIVE] = _node(
        "CLIPTextEncode", {"text": inputs.negative_prompt, "clip": clip_source}
    )

    # --- identity conditioning, patched onto the model ----------------------
    # RECIPE-GATED, not input-gated: the branch needs a reference image AND a
    # recipe that says how hard to condition on it. Neither half is optional and
    # neither half has a fallback.
    if inputs.reference_image is not None:
        identity_weight = recipe.get("identityWeight")
        if identity_weight is None:
            raise SdWorkflowError(
                f"recipe {recipe.get('id', '<unnamed>')} sets no identityWeight, so it cannot "
                f"condition on a reference image — it is a no-identity recipe, and running it "
                f"with one would make it a different recipe than the one recorded. Send the "
                f"reference to an identity recipe, or drop it."
            )
        weight = float(identity_weight)
        graph[NODE_REFERENCE_IMAGE] = _node("LoadImage", {"image": inputs.reference_image})
        graph[NODE_PULID_MODEL] = _node("PulidModelLoader", {"pulid_file": inputs.pulid_file})
        graph[NODE_PULID_EVA_CLIP] = _node("PulidEvaClipLoader", {})
        graph[NODE_PULID_INSIGHTFACE] = _node(
            "PulidInsightFaceLoader", {"provider": PULID_INSIGHTFACE_PROVIDER}
        )
        graph[NODE_PULID_APPLY] = _node(
            "ApplyPulid",
            {
                "model": model_source,
                "pulid": [NODE_PULID_MODEL, 0],
                "eva_clip": [NODE_PULID_EVA_CLIP, 0],
                "face_analysis": [NODE_PULID_INSIGHTFACE, 0],
                "image": [NODE_REFERENCE_IMAGE, 0],
                "method": PULID_METHOD,
                "weight": weight,
                "start_at": PULID_START_AT,
                "end_at": PULID_END_AT,
            },
        )
        model_source = [NODE_PULID_APPLY, 0]

    # --- structural conditioning, applied to both conditionings -------------
    # Depth before pose: depth is the first production experiment, and a
    # fixed order keeps two renders of the same recipe byte-identical.
    positive_source: list[Any] = [NODE_POSITIVE, 0]
    negative_source: list[Any] = [NODE_NEGATIVE, 0]
    if inputs.depth_image is not None:
        strength, start, end = _control_setting(recipe, "depth", DEFAULT_DEPTH_STRENGTH)
        graph[NODE_DEPTH_IMAGE] = _node("LoadImage", {"image": inputs.depth_image})
        graph[NODE_DEPTH_CONTROLNET] = _node(
            "ControlNetLoader", {"control_net_name": inputs.depth_controlnet_file}
        )
        graph[NODE_DEPTH_APPLY] = _node(
            "ControlNetApplyAdvanced",
            {
                "positive": positive_source,
                "negative": negative_source,
                "control_net": [NODE_DEPTH_CONTROLNET, 0],
                "image": [NODE_DEPTH_IMAGE, 0],
                "strength": strength,
                "start_percent": start,
                "end_percent": end,
            },
        )
        positive_source = [NODE_DEPTH_APPLY, 0]
        negative_source = [NODE_DEPTH_APPLY, 1]
    if inputs.pose_image is not None:
        strength, start, end = _control_setting(recipe, "pose", DEFAULT_POSE_STRENGTH)
        graph[NODE_POSE_IMAGE] = _node("LoadImage", {"image": inputs.pose_image})
        graph[NODE_POSE_CONTROLNET] = _node(
            "ControlNetLoader", {"control_net_name": inputs.pose_controlnet_file}
        )
        graph[NODE_POSE_APPLY] = _node(
            "ControlNetApplyAdvanced",
            {
                "positive": positive_source,
                "negative": negative_source,
                "control_net": [NODE_POSE_CONTROLNET, 0],
                "image": [NODE_POSE_IMAGE, 0],
                "strength": strength,
                "start_percent": start,
                "end_percent": end,
            },
        )
        positive_source = [NODE_POSE_APPLY, 0]
        negative_source = [NODE_POSE_APPLY, 1]

    # --- sampling and output ------------------------------------------------
    graph[NODE_LATENT] = _node(
        "EmptyLatentImage",
        {"width": inputs.width, "height": inputs.height, "batch_size": 1},
    )
    graph[NODE_SAMPLER] = _node(
        "KSampler",
        {
            "model": model_source,
            "seed": inputs.seed,
            "steps": int(_require(recipe, "steps")),
            "cfg": float(_require(recipe, "cfg")),
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "positive": positive_source,
            "negative": negative_source,
            "latent_image": [NODE_LATENT, 0],
            "denoise": SAMPLER_DENOISE,
        },
    )
    graph[NODE_DECODE] = _node(
        "VAEDecode", {"samples": [NODE_SAMPLER, 0], "vae": [NODE_CHECKPOINT, 2]}
    )
    graph[NODE_SAVE] = _node(
        "SaveImage",
        {"images": [NODE_DECODE, 0], "filename_prefix": inputs.filename_prefix},
    )
    return graph
