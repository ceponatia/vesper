import { z } from "zod";
import {
  emptyImageModelAdvancedCapabilities,
  imageEditKindSchema,
  imageIdentityPreservationSchema,
  imageModelAdvancedCapabilitiesSchema,
} from "../capabilities/image-model-capabilities";

/**
 * The image-model registry's vocabulary (image-model-registry.spec.md).
 *
 * Which models the app can run is DATA — rows in `image_models`, managed from
 * the admin page — not a hardcoded union. This pure module carries the record
 * shape, the surface filters, and the reference-capacity scaffold, so the
 * client and server agree without importing a server module. Concrete provider
 * calls stay server-side (`server/ai/replicate.ts`).
 *
 * Replaces the pre-2026-08-05 Venice/Replicate key unions. Venice is gone: the
 * app is Replicate-only, and a model's identity is its Replicate slug.
 */

/**
 * How a model is told what shape to produce. Most take an `aspect_ratio` enum;
 * Wan 2.7 has no aspect input at all and is driven by `size` pixel pairs like
 * `1536*2048`.
 *
 * What shape it can actually produce is a separate question — see
 * `supportedAspects` and `chooseAspect`. Keeping "how to ask" and "what it
 * offers" apart is what lets one mechanism serve both the 3:4 render paths and
 * the entity lanes, which want 1:1 (items) and 3:2 (locations).
 */
export const imageAspectModes = ["aspect_ratio", "size"] as const;
export const imageAspectModeSchema = z.enum(imageAspectModes);
export type ImageAspectMode = (typeof imageAspectModes)[number];

/**
 * Whether the model's reference input takes one URI or a list. The field NAME
 * is not enough: `qwen/qwen-image-2512` and `qwen/qwen-image-edit-2511` both
 * call it `image`, but the first is a single string and the second an array.
 */
export const imageReferenceArities = ["single", "array"] as const;
export const imageReferenceAritySchema = z.enum(imageReferenceArities);
export type ImageReferenceArity = (typeof imageReferenceArities)[number];

/**
 * How reference bytes REACH the model — the third thing a Replicate schema
 * cannot tell you (after the field name and its arity).
 *
 * `file` uploads to Replicate's files API and sends the resulting URL. That is
 * the default and what every model in the seeded set wants, because it keeps
 * the prediction payload small.
 *
 * `data_url` inlines the bytes as `data:image/webp;base64,…`. Wan 2.7 needs it:
 * its wrapper proxies Alibaba's async API and validates the file extension of
 * whatever it receives, and a Replicate-hosted file URL arrives at the model
 * container with no extension — `ValueError: Invalid image format ''` (owner
 * report 2026-08-05, reproduced against the live model). Inlined bytes carry
 * their type in the URI itself, so the wrapper sees `.webp` and proceeds.
 *
 * Stored per row rather than inferred: nothing in the OpenAPI schema
 * distinguishes a wrapper that resolves URLs itself from one that does not, so
 * this is a fact learned by running the model and recorded like any other
 * registry column.
 */
export const imageReferenceTransports = ["file", "data_url"] as const;
export const imageReferenceTransportSchema = z.enum(imageReferenceTransports);
export type ImageReferenceTransport = (typeof imageReferenceTransports)[number];

/** The surfaces a model can be offered on. */
export const imageModelSurfaces = ["portrait", "variant", "scene"] as const;
export const imageModelSurfaceSchema = z.enum(imageModelSurfaces);
export type ImageModelSurface = (typeof imageModelSurfaces)[number];

/** Vesper's one output shape. Every render lands here regardless of model. */
export const IMAGE_TARGET_ASPECT = 3 / 4;

export const imageModelSchema = z.object({
  id: z.string().min(1),
  /** Replicate model path, optionally `owner/name:version`. */
  slug: z.string().min(1),
  label: z.string().min(1),
  /** Can run with no reference image (its reference input is not required). */
  canGenerate: z.boolean(),
  /** Has a reference input at all. Says nothing about identity preservation. */
  canEdit: z.boolean(),
  /** The input key references are written to (`image` / `image_input` / `images`). */
  referenceField: z.string().default("image"),
  referenceArity: imageReferenceAritySchema.default("array"),
  /** How the bytes travel: an uploaded file URL, or an inlined data URI. */
  referenceTransport: imageReferenceTransportSchema.default("file"),
  /**
   * How many references the model accepts. NOT derivable: no model in the
   * seeded set declares `maxItems` on its array input — the caps are stated in
   * prose, so this is stored per row and editable on the admin page.
   */
  maxReferences: z.number().int().min(0).max(64).default(1),
  aspectMode: imageAspectModeSchema.default("aspect_ratio"),
  /**
   * Every shape this model offers, verbatim from its schema enum — ratios like
   * `"3:4"` for `aspect_ratio` models, pixel pairs like `"1536*2048"` for `size`
   * models. The render path picks the closest entry to what a lane asked for and
   * crops the remainder, which is how Stable Diffusion 3.5 Large (no `3:4`) and
   * the 1:1 item lane are both served without a per-model branch.
   */
  supportedAspects: z.array(z.string()).default([]),
  /** Omitted from the payload when null — several models have no such input. */
  outputFormat: z.string().nullable().default(null),
  /** Per-model constants merged into the payload (e.g. `max_images: 1`). */
  extraInput: z.record(z.string(), z.unknown()).default({}),
  /**
   * The exact Replicate version whose schema produced the stored mechanical
   * capabilities. Null on every row probed before the column existed, and on a
   * bare-slug experimental row. For a pinned `owner/name:version` slug this must
   * equal the pinned version — a mismatch means the stored bindings describe a
   * version the app is no longer calling, which is how a control silently starts
   * being sent to a field that moved.
   */
  probedVersionId: z.string().nullable().default(null),
  /**
   * REVIEWED, never probed: what this model's editing actually does. `canEdit` is
   * true for anything with an image input, so this is the field that keeps an
   * instruction editor apart from strength-based repainting (see
   * `./image-model-capabilities`). `unknown` is the default and stays permissive.
   */
  editKind: imageEditKindSchema.default("unknown"),
  /** REVIEWED: how well a face survives a render. Gates identity-critical tasks. */
  identityPreservation: imageIdentityPreservationSchema.default("unknown"),
  /**
   * Operator-facing caveat shown on the admin card and in pickers — not a failure
   * class. Wan 2.7 is the first use: its upstream moderation cannot be disabled and
   * has refused ordinary character references, which an operator needs told before
   * choosing it, not after a rejected render.
   */
  operatorWarning: z.string().nullable().default(null),
  /**
   * Version-specific probed extras: optional control bindings, extra image inputs,
   * output arity, the known-field allowlist. `{}` on every seeded row today — the
   * probe does not derive control aliases until the later slices — and an empty set
   * means no optional control is sent, which is exactly current behavior.
   */
  advancedCapabilities: imageModelAdvancedCapabilitiesSchema.default(() => emptyImageModelAdvancedCapabilities()),
  forPortrait: z.boolean().default(false),
  forVariant: z.boolean().default(false),
  forScene: z.boolean().default(false),
  /** Marks a seeded row for display. Does NOT gate deletion (owner ruling 4). */
  builtin: z.boolean().default(false),
  sort: z.number().int().default(0),
  // `updated_at` is a COLUMN ONLY, deliberately not a field here. This record
  // crosses to the client as JSON, and adding a timestamp forces a
  // date-serialization decision (Date vs ISO string vs epoch) that no consumer
  // needs yet. The admin version card is the first surface that will show
  // "capabilities changed at", so it is what should make that call.
});
export type ImageModel = z.infer<typeof imageModelSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const imageModelListSchema = z.array(imageModelSchema).catch([]);

/**
 * Whether a model may be OFFERED on a surface: the stored toggle AND the
 * capability it implies. A row whose toggle and flags disagree is simply not
 * listed — no error, no diagnostic. Editing surfaces need `canEdit`; making a
 * portrait from nothing needs `canGenerate`.
 *
 * This is why the two flags are independent rather than one either/or: an
 * edit-capable model that can also run bare (every seeded model except
 * `qwen-image-edit-2511`) is legitimately offered in all three places.
 */
export function imageModelOffersSurface(model: ImageModel, surface: ImageModelSurface): boolean {
  switch (surface) {
    case "portrait":
      return model.forPortrait && model.canGenerate;
    case "variant":
      return model.forVariant && model.canEdit;
    case "scene":
      return model.forScene && model.canEdit;
  }
}

/** The models offered on one surface, in stored sort order. */
export function imageModelsForSurface(models: readonly ImageModel[], surface: ImageModelSurface): ImageModel[] {
  return models.filter((model) => imageModelOffersSurface(model, surface)).sort((a, b) => a.sort - b.sort);
}

export interface ImageReferenceCapacity {
  /** How many references may actually be sent (0 when the model cannot edit). */
  max: number;
  arity: ImageReferenceArity;
  field: string;
}

/**
 * The scaffold the render path asks before building a payload — "how many
 * reference images does this model support, and how do I send them?". A model
 * that cannot edit reports 0 regardless of its stored cap, and a `single`-arity
 * model never reports more than 1 however generous the stored number is.
 */
export function referenceCapacity(model: ImageModel): ImageReferenceCapacity {
  if (!model.canEdit) return { max: 0, arity: model.referenceArity, field: model.referenceField };
  const stored = Math.max(0, Math.trunc(model.maxReferences));
  return {
    max: model.referenceArity === "single" ? Math.min(1, stored) : stored,
    arity: model.referenceArity,
    field: model.referenceField,
  };
}

/**
 * Trim a reference list to what this model will actually accept. Callers use
 * this instead of a hardcoded slice, so a single-reference model stops being
 * handed three and quietly ignoring two.
 */
export function fitReferences<T>(model: ImageModel, references: readonly T[]): T[] {
  const { max } = referenceCapacity(model);
  return max <= 0 ? [] : references.slice(0, max);
}

/**
 * Parse one stored aspect entry to a numeric width/height ratio. Two spellings
 * exist: `"3:4"` (ratio enums) and `"1536*2048"` (Wan's `size` pixel pairs —
 * note the asterisk, not an `x`). Tier names like `"2K"` have no ratio and
 * return null, so they are never chosen as a shape.
 */
export function parseAspectValue(value: string): number | null {
  const match = /^(\d+)\s*[:*]\s*(\d+)$/.exec(value.trim());
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return match && width > 0 && height > 0 ? width / height : null;
}

/** One offered pixel pair, or null for ratio spellings and tier names. */
function parsePixelPair(value: string): { width: number; height: number } | null {
  const match = /^(\d+)\s*\*\s*(\d+)$/.exec(value.trim());
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return match && width > 0 && height > 0 ? { width, height } : null;
}

/** Pixel count of a `1536*2048`-style value; 0 for ratio spellings, which carry no size. */
function pixelArea(value: string): number {
  const pair = parsePixelPair(value);
  return pair ? pair.width * pair.height : 0;
}

export interface AspectChoice {
  /** The value to send the model, or null when it offers no usable shape. */
  value: string | null;
  /** True when the result must be centre-cropped to reach the requested ratio. */
  needsCrop: boolean;
}

/** Ratio distance below which an offered shape counts as an exact match. */
const EXACT_RATIO_TOLERANCE = 0.001;
/** Ratio distance below which two offered shapes count as the same ratio. */
const RATIO_TIE_TOLERANCE = 0.0001;

/** One parseable `supportedAspects` entry: the stored spelling and its ratio. */
interface ShapeOption {
  value: string;
  ratio: number;
}

/** Every shape this model offers that carries a ratio, in stored order. */
function shapeOptions(model: ImageModel): ShapeOption[] {
  return model.supportedAspects
    .map((value) => ({ value, ratio: parseAspectValue(value) }))
    .filter((entry): entry is ShapeOption => entry.ratio !== null);
}

/** The entries nearest a target ratio, and the single one `chooseAspect` answers with. */
interface ShapeCandidates {
  /** Every offered entry at the winning ratio, in stored order — what a
   * resolution tier picks among ({@link chooseDimensions}). */
  group: ShapeOption[];
  preferred: ShapeOption;
  needsCrop: boolean;
}

/**
 * The closest-ratio contest both shape pickers share, so a tier selection can
 * never choose a ratio `chooseAspect` would not have.
 *
 * Among exact matches, `preferred` is the biggest. Wan offers 768*1024,
 * 1536*2048 and 3072*4096 — all exactly 3:4 — and picking the first would
 * quietly render portraits at a quarter of the resolution every other model
 * produces. Ratio spellings ("3:4") have no pixel count, so this is a no-op for
 * them.
 *
 * With no exact match, ties break toward the WIDER option, because cropping a
 * too-wide image trims the sides (usually background) while cropping a too-tall
 * one trims the top or bottom — which is where heads are.
 */
function closestShapeCandidates(options: readonly ShapeOption[], targetRatio: number): ShapeCandidates | null {
  if (options.length === 0) return null;

  const exact = options.filter((entry) => Math.abs(entry.ratio - targetRatio) < EXACT_RATIO_TOLERANCE);
  if (exact.length > 0) {
    const largest = exact.reduce((best, entry) => (pixelArea(entry.value) > pixelArea(best.value) ? entry : best));
    return { group: exact, preferred: largest, needsCrop: false };
  }

  const closest = options.reduce((best, entry) => {
    const delta = Math.abs(entry.ratio - targetRatio) - Math.abs(best.ratio - targetRatio);
    if (Math.abs(delta) < RATIO_TIE_TOLERANCE) return entry.ratio > best.ratio ? entry : best;
    return delta < 0 ? entry : best;
  });
  return {
    group: options.filter((entry) => Math.abs(entry.ratio - closest.ratio) < RATIO_TIE_TOLERANCE),
    preferred: closest,
    needsCrop: true,
  };
}

/**
 * Pick the shape to request for a target ratio.
 *
 * An exact match is sent as-is. Otherwise the closest offered ratio is sent and
 * the caller crops the remainder — losing a strip of a correct-looking image
 * beats refusing to render, and beats stretching. A model offering no parseable
 * shape at all gets no aspect key, taking its own default.
 *
 * The selection rules live in {@link closestShapeCandidates}, shared with the
 * dimension resolver below.
 */
export function chooseAspect(model: ImageModel, targetRatio: number = IMAGE_TARGET_ASPECT): AspectChoice {
  const candidates = closestShapeCandidates(shapeOptions(model), targetRatio);
  if (!candidates) return { value: null, needsCrop: false };
  return { value: candidates.preferred.value, needsCrop: candidates.needsCrop };
}

/**
 * The provider input key the chosen shape travels to — `size` on a size-mode
 * model, `aspect_ratio` everywhere else. The payload builder and
 * `reservedImageInputFields` each state the same two-way mapping where they
 * apply it; this spelling exists so the dimension resolver and the render
 * wrapper agree on which entry of a {@link DimensionChoice} is the aspect key.
 */
export function imageAspectInputField(model: ImageModel): string {
  return model.aspectMode === "size" ? "size" : "aspect_ratio";
}

/**
 * The pixel area a named resolution tier asks for, on the models that take a
 * tier by pixel pair rather than by name. `custom` is deliberately absent — it
 * means "the width and height are the request", never an area — and an unknown
 * name degrades to "no tier requested" rather than a guess.
 */
const RESOLUTION_TIER_AREAS: Readonly<Record<string, number>> = {
  "1K": 1024 ** 2,
  "2K": 2048 ** 2,
  "3K": 3072 ** 2,
  "4K": 4096 ** 2,
};

/**
 * What one render asks the dimension resolver
 * (image-model-capabilities.spec.md §"Dimension negotiation").
 *
 * `operation`, `resolution`, `width` and `height` are the profile's merged
 * dimension controls, spelled as plain strings and numbers rather than the
 * profile vocabulary: `image-model-profiles` imports THIS module, so naming its
 * enums here would be a cycle, and this resolver treats a tier name as data (a
 * table lookup where an unknown name degrades to "unset") in any case. The
 * strongly-typed carrier is the compile step's `ImageRenderDimensionFacts`.
 */
export interface ImageDimensionRequest {
  /** The shape the lane wants, as a width/height ratio. */
  targetRatio: number;
  /**
   * Accepted and deliberately unused: generation and editing can have different
   * valid size options, but no probed capability records them yet, so there is
   * nothing honest to validate against. When `advancedCapabilities` grows
   * per-operation size constraints, they apply here — in the one place every
   * render already passes through — rather than in each caller.
   */
  operation?: string;
  /** The requested resolution tier (`"2K"`), or `"custom"` for an explicit pair. */
  resolution?: string;
  width?: number;
  height?: number;
  /**
   * The explicit pair as it actually reached the payload through the version's
   * `customWidth`/`customHeight` bindings — the compile step's fact, taken as an
   * input rather than re-derived, because only the control mapper may decide
   * whether a normalized control was sent. Null (or absent) when either half
   * dropped, in which case the model's own shape answer stands.
   */
  mappedCustomSize?: { width: number; height: number } | null;
}

/** The negotiated shape for one render (spec §"Dimension negotiation"). */
export interface DimensionChoice {
  /**
   * The aspect-key entry to send, or empty when the model offers no usable
   * shape and takes its own default. Tier and custom width/height fields are
   * deliberately NOT written here — they ride the mapped `controlInput`, and a
   * second copy would race the mapper's drop record.
   */
  input: Record<string, string | number>;
  /** The ratio the provider is expected to return, or null when nothing can say. */
  expectedAspect: number | null;
  /** True when the result must be centre-cropped to reach the requested ratio. */
  needsCrop: boolean;
  /** The tier the request asked for, echoed for provenance when one was set. */
  requestedResolution?: string;
}

/**
 * Pick the shape AND size to request — the {@link chooseAspect} seam extended
 * with the profile's dimension controls (spec §"Dimension negotiation").
 *
 * A request carrying no dimension controls resolves to exactly the
 * `chooseAspect` answer, whatever the mode: both branches delegate their
 * default path to it, which is what keeps every existing render byte-identical.
 */
/**
 * The shape answer for a render that asked for NO shape — the Image Generator's
 * native/provider-default mode.
 *
 * An empty `input` means the payload carries no `aspect_ratio`/`size` key at
 * all, so the version's own declared default applies; `expectedAspect: null`
 * with `needsCrop: false` says nothing is expected and nothing is trimmed. It
 * is a named function rather than an inline literal so the transport wrapper's
 * crop rule and this answer stay one decision: "no target" must never fall into
 * the `expectedAspect === null` branch that crops precisely because nothing
 * could say what was coming.
 */
export function providerDefaultDimensions(): DimensionChoice {
  return { input: {}, expectedAspect: null, needsCrop: false };
}

export function chooseDimensions(model: ImageModel, request: ImageDimensionRequest): DimensionChoice {
  const choice =
    model.aspectMode === "size" ? chooseSizeDimensions(model, request) : chooseRatioDimensions(model, request);
  return { ...choice, ...(request.resolution === undefined ? {} : { requestedResolution: request.resolution }) };
}

/** Two ratios that count as the same shape — the exact-match rule, reused. */
function sameRatio(a: number, b: number): boolean {
  return Math.abs(a - b) < EXACT_RATIO_TOLERANCE;
}

/**
 * The `aspect_ratio` branch: the shape is `chooseAspect`'s answer, untouched.
 *
 * A tier or an explicit pair changes nothing HERE — on these models they are
 * ordinary probed control bindings and travel with the mapped `controlInput`.
 * What a mapped custom pair does change is the expectation: a model told
 * `width: 1600, height: 1200` returns 4:3 whatever the aspect enum said, so
 * when the request is `custom` and BOTH halves actually mapped, the expected
 * ratio (and the crop it implies) is judged against the pair.
 */
function chooseRatioDimensions(model: ImageModel, request: ImageDimensionRequest): DimensionChoice {
  const aspect = chooseAspect(model, request.targetRatio);
  const input: Record<string, string | number> =
    aspect.value === null ? {} : { [imageAspectInputField(model)]: aspect.value };

  const custom = request.resolution === "custom" ? request.mappedCustomSize : null;
  if (custom && custom.width > 0 && custom.height > 0) {
    const expected = custom.width / custom.height;
    return { input, expectedAspect: expected, needsCrop: !sameRatio(expected, request.targetRatio) };
  }

  return {
    input,
    expectedAspect: aspect.value === null ? null : parseAspectValue(aspect.value),
    needsCrop: aspect.needsCrop,
  };
}

/**
 * The `size` branch (Wan): the enum entries ARE the sizes, so the dimension
 * controls pick among them instead of riding the control mapping.
 *
 * In precedence order:
 *
 * - An explicit pair is honored only when the request's `resolution` is
 *   `custom` AND it parses into an offered entry VERBATIM. The gate matters as
 *   much as the verbatim rule: width/height are only ever a request when the
 *   tier says so, and an ungated pair let leftover dimension defaults silently
 *   outrank a stored tier. A pair the schema does not offer is ignored rather
 *   than rounded to an invented value the provider would reject — a size-mode
 *   model accepts nothing but its enum.
 * - A named tier picks, among the entries `chooseAspect` would consider (the
 *   closest-ratio group), the one nearest the tier's pixel area — ties toward
 *   the larger, matching the exact-match bias. The ratio contest still runs
 *   first: a tier must never move the render to a worse shape to hit an area.
 * - Neither set (or `custom` with no offered pair): `chooseAspect`'s answer,
 *   exactly.
 */
function chooseSizeDimensions(model: ImageModel, request: ImageDimensionRequest): DimensionChoice {
  const field = imageAspectInputField(model);

  if (request.resolution === "custom" && request.width !== undefined && request.height !== undefined) {
    const offered = model.supportedAspects.find((value) => {
      const pair = parsePixelPair(value);
      return pair !== null && pair.width === request.width && pair.height === request.height;
    });
    if (offered !== undefined) {
      const expected = request.width / request.height;
      return {
        input: { [field]: offered },
        expectedAspect: expected,
        needsCrop: !sameRatio(expected, request.targetRatio),
      };
    }
  }

  const candidates = closestShapeCandidates(shapeOptions(model), request.targetRatio);
  if (!candidates) return { input: {}, expectedAspect: null, needsCrop: false };

  const targetArea = request.resolution === undefined ? undefined : RESOLUTION_TIER_AREAS[request.resolution];
  if (targetArea === undefined) {
    const { preferred } = candidates;
    return { input: { [field]: preferred.value }, expectedAspect: preferred.ratio, needsCrop: candidates.needsCrop };
  }

  const chosen = candidates.group.reduce((best, entry) => {
    const delta = Math.abs(pixelArea(entry.value) - targetArea) - Math.abs(pixelArea(best.value) - targetArea);
    if (delta === 0) return pixelArea(entry.value) > pixelArea(best.value) ? entry : best;
    return delta < 0 ? entry : best;
  });
  return { input: { [field]: chosen.value }, expectedAspect: chosen.ratio, needsCrop: candidates.needsCrop };
}

/**
 * What Replicate puts in a prediction's `version` field for an OFFICIAL model:
 * the literal string `"hidden"`, never a sha.
 *
 * It is a NON-DISCLOSURE, not a version. Official models expose no versions
 * list at all — `GET /v1/models/{owner}/{name}/versions` answers 404 "This
 * model does not expose a list of versions" — so there is no sha for the
 * prediction to echo, and the response carries the model slug instead.
 * (Verified against the live API 2026-08-11.)
 */
export const REPLICATE_VERSION_UNDISCLOSED = "hidden";

/**
 * Whether an executed-version string is the provider declining to say which
 * version ran, rather than naming one.
 */
export function isUndisclosedProviderVersion(versionId: string | null | undefined): boolean {
  return versionId === REPLICATE_VERSION_UNDISCLOSED;
}

/**
 * Whether the provider demonstrably ran something OTHER than what was pinned —
 * the one definition every consumer of a version echo shares.
 *
 * False when either side is absent: silence is silence, never a disagreement.
 *
 * False, too, when the executed side is UNDISCLOSED. `"hidden"` says the
 * provider does not publish versions for this model, not that a different one
 * ran, and the evidence identity of such a run is the REQUESTED pin — which
 * Replicate validates at create time. A version that does not resolve is
 * refused `HTTP 422 "The specified version does not exist"` before any spend,
 * so an ACCEPTED create is itself proof the pin resolved (verified
 * 2026-08-11). Reading `"hidden"` as a mismatch would refuse every run against
 * every official model on the strength of a string that was never a version.
 */
export function providerVersionsDisagree(requested: string | null, executed: string | null): boolean {
  if (requested === null || executed === null) return false;
  if (isUndisclosedProviderVersion(executed)) return false;
  return requested !== executed;
}

/*
 * Model-level resolution used to live here, with the two seeded default slugs it
 * fell back to. Both are gone: every render lane now resolves a PROFILE
 * (`resolveImageProfile`) and reaches its model through the profile row, so a
 * stored pick degrades to the task's default rather than a surface's, and the
 * defaults themselves are rows the migration seeds rather than constants the
 * code carries.
 */
