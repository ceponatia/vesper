import { baseImageModelSlug } from "@vesper/image-core";

/**
 * Shared identifiers for the intimate-scene LoRA pairing, and the reviewed
 * per-model intimate-route policy. Render routes and admin tools use these
 * constants so the selected library row and model do not drift between
 * surfaces.
 */

/** Seeded library row used for the intimate-scene anatomy LoRA. */
export const INTIMATE_SCENE_LORA_ID = "imglorqwennsfwallinclv20";

/** Base model the automatic intimate-scene route pairs with the curated LoRA. */
export const INTIMATE_SCENE_LORA_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/** Model selection that pre-fills the curated LoRA in the Image Generator. */
export const INTIMATE_SCENE_LORA_PREFILL_SLUG = INTIMATE_SCENE_LORA_MODEL_SLUG;

// ---------------------------------------------------------------------------
// The per-model intimate route
// ---------------------------------------------------------------------------

/**
 * How a model takes the intimate route — the render lanes whose work is nude by
 * design: a `bare` reference view, the portrait studio's `nsfw_test` variant,
 * and an intimate staged chat scene.
 *
 * `optional` is a reviewed claim that the model draws that work on its own
 * resolved profile: the render stays on the lane's resolved model, and the
 * model's curated anatomy LoRA rides along only when one is named here and
 * resolves. Its absence is the route working, never a degrade.
 *
 * A union of one member today, deliberately a union: the pairing every model
 * this table does not list takes (the lane's profile on
 * {@link INTIMATE_SCENE_LORA_MODEL_SLUG} with {@link INTIMATE_SCENE_LORA_ID}) is
 * the headroom a second mode would name, and widening the tuple needs no other
 * change to the record's shape.
 */
export const intimateAnatomyLoraModes = ["optional"] as const;
export type IntimateAnatomyLoraMode = (typeof intimateAnatomyLoraModes)[number];

/** One model's reviewed intimate-route policy. */
export interface IntimateRoutePolicy {
  readonly anatomyLora: IntimateAnatomyLoraMode;
  /**
   * The curated `image_loras` row the route pairs when it resolves, or null
   * when none is curated for this model.
   *
   * Named here, in reviewed code, rather than discovered from the library:
   * nothing on a library row says "anatomy", so a lookup by model would pair
   * whatever style LoRA an operator next curated for the model with every nude
   * render. Name a row only once its weights are generation-enabled on the
   * provider — a row the provider refuses fails the render it rides, where a
   * missing one costs nothing.
   */
  readonly anatomyLoraId: string | null;
}

/**
 * The reviewed intimate-route policy, keyed by model slug. A model absent from
 * this table takes the intimate-model pairing, unchanged.
 *
 * Owner ruling 2026-10-01: Civitai Qwen Image 2.1 renders bare reference views,
 * `nsfw_test` variants and intimate chat scenes on itself with no LoRA, and
 * pairs a curated 2.1 anatomy LoRA once one is generation-enabled.
 */
export const INTIMATE_ROUTE_POLICIES: Readonly<Record<string, IntimateRoutePolicy>> = {
  "civitai/qwen-image-2.1": { anatomyLora: "optional", anatomyLoraId: null },
};

/**
 * The policy for a model slug, or null when the model takes the intimate-model
 * pairing. Exact spelling first, then the base slug — a pinned
 * `owner/name:version` row is the same model the table reviewed.
 */
export function intimateRoutePolicyFor(modelSlug: string): IntimateRoutePolicy | null {
  return INTIMATE_ROUTE_POLICIES[modelSlug] ?? INTIMATE_ROUTE_POLICIES[baseImageModelSlug(modelSlug)] ?? null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Why an intimate render carried the LoRA it did — the reason half of
 * `images.meta.intimateRoute`.
 *
 * - `anatomy_lora` — the anatomy LoRA rode: the intimate-model pairing, or a
 *   listed model's curated row that resolved.
 * - `no_anatomy_lora_curated` — a listed model whose policy names no row.
 * - `anatomy_lora_unavailable` — a listed model's named row did not resolve (the
 *   library refused it, or the deployment lacks its credential).
 */
export const intimateRouteReasons = ["anatomy_lora", "no_anatomy_lora_curated", "anatomy_lora_unavailable"] as const;
export type IntimateRouteReason = (typeof intimateRouteReasons)[number];

/**
 * What one intimate render records on `images.meta.intimateRoute`: the library
 * row that was SENT, by id, or null when none was, and the reason. Never the
 * locator — an image row is long-lived, and a locator may carry a credential
 * once the transport completes it.
 */
export interface IntimateRouteProvenance {
  readonly lora: string | null;
  readonly reason: IntimateRouteReason;
}
