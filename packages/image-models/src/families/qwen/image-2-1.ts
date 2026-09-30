import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { QWEN_IMAGE_FAMILY, qwenImage21Features } from "./shared";

/**
 * Civitai's native Qwen Image 2.1 lane — `civitai/qwen-image-2.1`
 * (issue #660).
 *
 * **Lane identity.** Civitai's comfy engine hosts this checkpoint as its own
 * lane: `engine: "comfy"`, `ecosystem: "qwen"`, `model: "2.1"`. This is
 * neither the `sdcpp` 20B Qwen-Image lane the family's other adapters run
 * (`model: "20b"`, a `version` of 2509/2512/2511) nor klein's `flux2` engine.
 * There is no `version` field on this lane at all — the checkpoint identity
 * is an immutable AIR (`urn:air:qwen21:diffusionmodel:civitai:2954443@3352534`),
 * recorded on the registry row as `probed_version_id`, not selected per
 * request.
 *
 * **Create vs. edit, selected by reference count.** One checkpoint answers
 * both `createImage` (no references) and `editImage` (one to ten reference
 * data URLs) — the transport picks the operation from how many references
 * the render carries, the same reference-count dispatch klein's Civitai lane
 * uses, not two separate registered models.
 *
 * **LoRA map beside references.** `loras` is an AIR-keyed map (weights to
 * strength) that rides in the same request as the 1–10 data-URL references —
 * this lane, unlike klein's two-reference Civitai cap, can carry a LoRA and a
 * full ten-reference edit together. Composing `loraFeature` here states only
 * that the schema accepts the map; the active probed row's control bindings
 * (`civitai_lora_version`/`civitai_lora_strength`) and a render-time
 * `baseModel === "Qwen 2.1"` check on the resolved AIR are what keep a
 * non-cross-compatible 20B LoRA off this lane, and neither lives in this
 * adapter.
 *
 * **Mature workflow policy is the transport's, not this adapter's.** Every
 * request on this lane travels under a fixed workflow policy
 * (`allowMatureContent: true`, `currencies: ["yellow"]`,
 * `upgradeMode: "manual"`) that Vesper's Civitai transport sets once for the
 * whole submission, the same way klein's requests do; nothing about that
 * policy is a per-model composition choice, so it is not represented here.
 *
 * **Documentation and a zero-Buzz preflight echo are not entitlement,
 * identity preservation, or quality.** Everything this file states was read
 * from the provider's OpenAPI schema and confirmed by a zero-Buzz `whatif`
 * preflight echo (2026-09-30) — neither establishes that Vesper's account can
 * actually spend on this lane, that edits preserve subject identity, or that
 * output quality is acceptable for any production use. The registry row this
 * adapter composes against stays unverified until the owners test the exact
 * endpoint and variant (`AGENTS.md` §Image-model requirements).
 *
 * No execution hint and no prompt preparation: neither a measured timing nor
 * a prompt finding backs either hook for this lane yet.
 */
export const civitaiQwenImage21: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: qwenImage21Features(),
});
