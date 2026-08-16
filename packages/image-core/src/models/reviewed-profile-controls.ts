import type { ImageControlDefaults } from "./image-model-profiles";

/**
 * The reviewed quality policy, said ONCE in both vocabularies it has to exist in
 * during the migration off the transitional overlay
 * (image-render-quality.spec.md §"Migration off the transitional policy", steps
 * 1–2).
 *
 * The transitional policy says a reviewed setting as a RAW PROVIDER FIELD, merged
 * into the model row's `extraInput` (`withReviewedImageQuality`). A task profile
 * says the same setting as a NORMALIZED CONTROL, mapped through the version's own
 * probed binding — or, for a setting no normalized control covers, as a
 * `providerOverrides` entry validated against the version's field list.
 *
 * Both spellings have to be live at once, because step 4 removes an override only
 * after parity is demonstrated for it. Two hand-maintained copies of the same
 * numbers is exactly how a "parity" migration ships a silent difference, so this
 * module is the single table and the overlay is DERIVED from it. A value can no
 * longer move in one representation without moving in the other, and
 * `reviewed-profile-controls.test.ts` pins the equivalence besides.
 *
 * What lives here is the reviewed judgment only. Which provider field a control
 * reaches on a model whose version has been probed is the PROBE's answer, read
 * from `advancedCapabilities.controls`; `controlFields` below records the field
 * the transitional overlay writes today, which is what makes the two
 * representations comparable at all.
 */

/**
 * The normalized controls a reviewed setting can be — a deliberate subset,
 * which keeps a policy from claiming a control (`seed`, `lora`) that the
 * reviewed judgment has nothing to say about.
 *
 * `steps` and `guidance` are currently expressible but unused: the sampler
 * corrections that needed them belonged to models the 2026-08-16 ruling dropped.
 * They stay in the vocabulary because the remaining trial questions are exactly
 * about steps and guidance on the seeded catalog, and a reviewed answer should
 * be a one-line table edit rather than a type change.
 */
export type ReviewedImageControlDefaults = Pick<
  ImageControlDefaults,
  "steps" | "guidance" | "negativePrompt" | "resolution" | "width" | "height"
>;

/** One model's reviewed policy in both vocabularies. */
export interface ReviewedImageQualityPolicy {
  /** The reviewed settings a task profile carries as `control_defaults`. */
  controlDefaults: Readonly<ReviewedImageControlDefaults>;
  /**
   * Reviewed settings NO normalized control covers, carried as a profile's
   * `provider_overrides` — the escape hatch, used only where the control
   * vocabulary genuinely has no word for the setting (`go_fast`, `scheduler`,
   * PuLID's `method`).
   */
  providerOverrides: Readonly<Record<string, unknown>>;
  /**
   * The provider field each normalized control above corresponds to on THIS
   * model — what the transitional overlay writes directly into `extraInput`.
   *
   * A control with no entry here is one the overlay never wrote and the profile
   * vocabulary needs anyway: `resolution: "custom"` is the whole list, and it is
   * the GATE that makes `width`/`height` a request rather than a leftover
   * (`compileProfileRenderPlan`), not a field anything sends.
   */
  controlFields: Readonly<Partial<Record<keyof ReviewedImageControlDefaults, string>>>;
}

/**
 * The reviewed policy per BASE provider slug (a pinned `owner/name:version` is
 * matched on `owner/name`).
 *
 * Exact slugs are the point: an operator-added model never receives a guessed
 * field.
 *
 * Owner ruling (2026-08-16): the reviewed set is the Qwen family plus the
 * 2026-08-10/11 seeded additions, and every slug here therefore HAS a seeded
 * `image_models` row. Juggernaut XL v9, RealVis Hyper LoRA and Pony Realism v2.3
 * were dropped from it: they are unseeded community checkpoints an admin adds by
 * hand, they remain catalog pages in `docs/image-models/`, and an admin who adds
 * one now gets the wrapper's own defaults with no reviewed correction. That is
 * accepted rather than overlooked.
 *
 * The consequence worth knowing: this table can no longer contain a model that
 * has no row to seed, so a reviewed setting stated here is always reproducible
 * as a task profile's controls.
 */
const REVIEWED_IMAGE_QUALITY: Readonly<Record<string, ReviewedImageQualityPolicy>> = {
  "qwen/qwen-image-edit-2511": {
    // This model currently serves only identity-critical variants/scenes. Its
    // provider default optimizes speed on the surface where fidelity matters.
    // `go_fast` has no normalized control, so the profile says it as the raw
    // field — the same shape 0107 already uses for Qwen 2512's quality row.
    controlDefaults: {},
    providerOverrides: { go_fast: false },
    controlFields: {},
  },
  "aisha-ai-official/nsfw-flux-dev": {
    // The wrapper defaults to a 1024×1024 square, so every render would be
    // cropped to 3:4 and lose a quarter of the frame. 832×1216 is the portrait
    // bucket this architecture is trained on.
    controlDefaults: { resolution: "custom", width: 832, height: 1216 },
    providerOverrides: {},
    controlFields: { width: "width", height: "height" },
  },
  "aisha-ai-official/likereality-pony-v1": {
    // The wrapper's provider default negative is literally `"nsfw, naked"` — a
    // hidden negative that suppresses the output this app exists to produce and
    // silently contradicts the authored wardrobe and exposure state. The Pony
    // score-tag preamble is separate and stays on (`prepend_preprompt`).
    controlDefaults: { negativePrompt: "", resolution: "custom", width: 832, height: 1216 },
    providerOverrides: {},
    controlFields: { negativePrompt: "negative_prompt", width: "width", height: "height" },
  },
  "nsfw-api/sdxl-pulid": {
    // 512×512 is the wrapper's default: both off-shape and far below the
    // 768×1024 canonical portrait. `method` is pinned because Vesper runs this
    // model for identity preservation and never for style transfer, so a changed
    // provider default must not be able to move it off `fidelity`.
    controlDefaults: { resolution: "custom", width: 832, height: 1216 },
    providerOverrides: { method: "fidelity" },
    controlFields: { width: "width", height: "height" },
  },
};

/** Every base slug the reviewed policy covers, for tests and admin diagnostics. */
export const reviewedImageQualitySlugs: readonly string[] = Object.keys(REVIEWED_IMAGE_QUALITY);

/** The reviewed policy for one BASE slug, or null when the model is unreviewed. */
export function reviewedImageQualityPolicy(baseSlug: string): ReviewedImageQualityPolicy | null {
  return REVIEWED_IMAGE_QUALITY[baseSlug] ?? null;
}

/**
 * The reviewed policy as the RAW PROVIDER FIELDS the transitional overlay merges
 * into a model row's `extraInput`.
 *
 * Derived rather than stored, so the overlay and the profile representation
 * cannot drift: every field here is either a normalized control written to the
 * field `controlFields` names, or a `providerOverrides` entry that had no
 * normalized control to begin with.
 *
 * Written control by control rather than through a generic loop because the
 * control names are a closed set with different value types, and a loop over them
 * would need a cast the type-aware lint rules refuse — the explicit version is
 * both safer and a readable statement of which settings the reviewed table knows
 * how to express.
 */
export function reviewedImageQualityProviderInputs(policy: ReviewedImageQualityPolicy): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const controls = policy.controlDefaults;
  const fields = policy.controlFields;
  if (controls.steps !== undefined && fields.steps !== undefined) input[fields.steps] = controls.steps;
  if (controls.guidance !== undefined && fields.guidance !== undefined) input[fields.guidance] = controls.guidance;
  if (controls.negativePrompt !== undefined && fields.negativePrompt !== undefined) {
    input[fields.negativePrompt] = controls.negativePrompt;
  }
  if (controls.width !== undefined && fields.width !== undefined) input[fields.width] = controls.width;
  if (controls.height !== undefined && fields.height !== undefined) input[fields.height] = controls.height;
  // `resolution` is deliberately unmapped — see `controlFields`.
  return { ...input, ...policy.providerOverrides };
}

/**
 * The provider fields this policy's NORMALIZED controls reach — the overlay's
 * fields minus the raw overrides.
 *
 * Derived from {@link reviewedImageQualityProviderInputs} rather than read off
 * `controlFields` directly, because `Object.values` of a partial record widens to
 * `any` under this repo's lint rules and a cast to work around that would be a
 * silent hole in exactly the table the parity tests are checking.
 */
export function reviewedImageQualityControlFields(policy: ReviewedImageQualityPolicy): string[] {
  return Object.keys(reviewedImageQualityProviderInputs(policy)).filter(
    (field) => !Object.hasOwn(policy.providerOverrides, field),
  );
}

/**
 * The reviewed policy as the two jsonb columns a task profile row stores.
 *
 * The shape the seed migration writes and the parity tests compile, so "what the
 * profile carries" has one definition rather than one in SQL and another in a
 * test fixture that agrees with it until somebody edits one.
 */
export function reviewedImageProfileControls(baseSlug: string): {
  controlDefaults: Readonly<ReviewedImageControlDefaults>;
  providerOverrides: Readonly<Record<string, unknown>>;
} | null {
  const policy = reviewedImageQualityPolicy(baseSlug);
  if (!policy) return null;
  return { controlDefaults: policy.controlDefaults, providerOverrides: policy.providerOverrides };
}

/**
 * The overlay's whole table, keyed by base slug — the value
 * `withReviewedImageQuality` merges over a row's `extraInput`.
 *
 * Built once at module load rather than per render: the policy is a constant, and
 * a render path that rebuilt six objects per call would be paying for the
 * indirection this refactor exists to remove.
 */
export const reviewedImageQualityInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.fromEntries(
    Object.entries(REVIEWED_IMAGE_QUALITY).map(([slug, policy]) => [slug, reviewedImageQualityProviderInputs(policy)]),
  );
