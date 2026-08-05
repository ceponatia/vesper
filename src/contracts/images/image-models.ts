import { z } from "zod";
import {
  emptyImageModelAdvancedCapabilities,
  imageEditKindSchema,
  imageIdentityPreservationSchema,
  imageModelAdvancedCapabilitiesSchema,
} from "./image-model-capabilities";

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

/** Pixel count of a `1536*2048`-style value; 0 for ratio spellings, which carry no size. */
function pixelArea(value: string): number {
  const match = /^(\d+)\s*\*\s*(\d+)$/.exec(value.trim());
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

export interface AspectChoice {
  /** The value to send the model, or null when it offers no usable shape. */
  value: string | null;
  /** True when the result must be centre-cropped to reach the requested ratio. */
  needsCrop: boolean;
}

/**
 * Pick the shape to request for a target ratio.
 *
 * An exact match is sent as-is. Otherwise the closest offered ratio is sent and
 * the caller crops the remainder — losing a strip of a correct-looking image
 * beats refusing to render, and beats stretching. A model offering no parseable
 * shape at all gets no aspect key, taking its own default.
 *
 * Ties break toward the WIDER option, because cropping a too-wide image trims
 * the sides (usually background) while cropping a too-tall one trims the top or
 * bottom — which is where heads are.
 */
export function chooseAspect(model: ImageModel, targetRatio: number = IMAGE_TARGET_ASPECT): AspectChoice {
  const options = model.supportedAspects
    .map((value) => ({ value, ratio: parseAspectValue(value) }))
    .filter((entry): entry is { value: string; ratio: number } => entry.ratio !== null);
  if (options.length === 0) return { value: null, needsCrop: false };

  // Among exact matches, take the biggest. Wan offers 768*1024, 1536*2048 and
  // 3072*4096 — all exactly 3:4 — and picking the first would quietly render
  // portraits at a quarter of the resolution every other model produces.
  // Ratio spellings ("3:4") have no pixel count, so this is a no-op for them.
  const exact = options.filter((entry) => Math.abs(entry.ratio - targetRatio) < 0.001);
  if (exact.length > 0) {
    const largest = exact.reduce((best, entry) => (pixelArea(entry.value) > pixelArea(best.value) ? entry : best));
    return { value: largest.value, needsCrop: false };
  }

  const closest = options.reduce((best, entry) => {
    const delta = Math.abs(entry.ratio - targetRatio) - Math.abs(best.ratio - targetRatio);
    if (Math.abs(delta) < 0.0001) return entry.ratio > best.ratio ? entry : best;
    return delta < 0 ? entry : best;
  });
  return { value: closest.value, needsCrop: true };
}

/**
 * The seeded defaults, by slug (owner ruling 2 — 2026-08-05). Slugs rather than
 * ids because ids are minted at migration time. A deployment that deletes these
 * rows falls back to whatever the surface's first offered model is.
 */
export const DEFAULT_PORTRAIT_MODEL_SLUG = "qwen/qwen-image-2512";
export const DEFAULT_EDIT_MODEL_SLUG = "qwen/qwen-image-edit-2511";

/**
 * Resolve a stored pick to a usable model for one surface. A pick that no
 * longer exists — a deleted row, or a legacy Venice key from before the
 * registry — degrades to the surface's default rather than failing the render
 * (owner ruling 5: existing chats are not migrated).
 */
export function resolveImageModel(
  models: readonly ImageModel[],
  surface: ImageModelSurface,
  storedId: string | null | undefined,
): ImageModel | null {
  const offered = imageModelsForSurface(models, surface);
  const picked = offered.find((model) => model.id === storedId || model.slug === storedId);
  if (picked) return picked;
  const defaultSlug = surface === "portrait" ? DEFAULT_PORTRAIT_MODEL_SLUG : DEFAULT_EDIT_MODEL_SLUG;
  return offered.find((model) => model.slug === defaultSlug) ?? offered[0] ?? null;
}
