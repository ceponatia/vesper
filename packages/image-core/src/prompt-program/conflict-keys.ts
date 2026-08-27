/**
 * The shared currency between the two prompt channels.
 *
 * A positive claim says an image MUST contain something; a negative constraint
 * says an outcome is unacceptable. The two are authored, versioned and promoted
 * apart, so nothing about their wording lines up — one pack says "a brass plate
 * reading EXIT above the door" and the other says "garbled letters, blurry
 * text". Comparing those strings is folklore, and the failure it produces is the
 * one this whole system exists to prevent: a negative pack quietly forbidding a
 * feature the world digest requires.
 *
 * A conflict key is the third thing both sides can name. A claim declares which
 * keys it PROTECTS; a constraint declares which keys it FORBIDS; the linter is
 * then a set intersection with no language in it at all. That is what makes the
 * collision rules testable without rendering an image, and what lets a future
 * dialect change every word it emits without touching a single guard.
 *
 * The vocabulary is CLOSED and small on purpose. A key earns its place only when
 * some real negative block wants to forbid it and some real world fact can
 * legitimately require it — the intersection of the two is what a guard is for.
 * A key nothing forbids is dead weight; a key nothing can require never needs
 * guarding.
 */

export const imageConflictKeys = [
  // --- Literal marks and text -------------------------------------------------
  // Requestable by a sign, a garment print, a book cover, a shop front, a label.
  "text",
  "letters",
  "caption",
  "logo",
  "signature",
  // A watermark is the one mark of this family Vesper never authors, so it has
  // no protecting concept and is always safe to forbid. It is a key rather than
  // free text so the negative blocks all speak one vocabulary.
  "watermark",

  // --- Anatomy ----------------------------------------------------------------
  // Every one of these is correct morphology for somebody: a six-fingered hand,
  // a tail, a wing, an amputation, a prosthetic. Guarded by the subject's
  // intended morphology and authored absences, never banned outright.
  "extra_limbs",
  "extra_digits",
  "extra_appendages",
  "missing_limbs",
  "missing_digits",
  "malformed_hands",
  "duplicated_anatomy",
  "disconnected_anatomy",

  // --- Subject integrity ------------------------------------------------------
  "multiple_people",
  "duplicate_face",
  "identity_drift",

  // --- Composition and camera -------------------------------------------------
  // A close-up crop, a shallow depth of field and a motion-blurred pass are all
  // things a camera fact can ASK for, which is why the composition block has to
  // consult the camera before it forbids them.
  "cropped",
  "close_up",
  "blur",
  "out_of_frame",
  "confused_composition",
  "impossible_overlap",

  // --- Surface, medium and fidelity -------------------------------------------
  // The medium keys are mutually exclusive in practice: whichever one the style
  // intent names is protected, and the rest stay available to forbid.
  "synthetic_skin",
  "excessive_smoothing",
  "oversaturation",
  "low_resolution",
  "low_quality",
  "photographic",
  "illustration",
  "anime",
  "painting",
  "render_3d",

  // --- Scene ------------------------------------------------------------------
  "background_clutter",
  "extra_objects",
] as const;

export type ImageConflictKey = (typeof imageConflictKeys)[number];

const conflictKeySet: ReadonlySet<string> = new Set<string>(imageConflictKeys);

/** Whether an arbitrary string is one of the closed keys. */
export function isImageConflictKey(value: string): value is ImageConflictKey {
  return conflictKeySet.has(value);
}

/**
 * The keys a rendering MEDIUM protects when it is the requested one.
 *
 * Asking for an anime render and forbidding `anime` in the same payload breaks
 * the "never place the same concept in positive and negative channels" rule at
 * its most literal, and it is an easy mistake to make because the negative
 * block that forbids illustration styles is genuinely correct for the
 * photographic renders that make up most of Vesper's output.
 *
 * `photographic` protects the two surface keys as well: a photoreal subject is
 * the ONLY case where "waxy skin" and "over-smoothed" are wanted as exclusions,
 * so a non-photographic medium has to take those exclusions off the table too —
 * a painted portrait has no skin texture to defend.
 */
export function imageMediumProtections(medium: ImageStyleMedium): readonly ImageConflictKey[] {
  switch (medium) {
    case "photographic":
      return ["photographic"];
    case "illustration":
      return ["illustration", "synthetic_skin", "excessive_smoothing"];
    case "anime":
      return ["anime", "illustration", "synthetic_skin", "excessive_smoothing"];
    case "painting":
      return ["painting", "illustration", "synthetic_skin", "excessive_smoothing"];
    case "render_3d":
      return ["render_3d", "synthetic_skin", "excessive_smoothing"];
    case "unspecified":
      // Nothing is claimed, so nothing is protected — but nothing about the
      // medium may be forbidden either, which the negative blocks enforce by
      // requiring a KNOWN medium before they activate.
      return [];
  }
}

/**
 * The rendering media a style intent can name.
 *
 * `unspecified` is a real answer rather than a missing one: most lanes never
 * state a medium, and inventing "photographic" for them would activate the
 * photoreal surface exclusions on an item catalog shot that has no skin in it.
 */
export const imageStyleMediums = [
  "photographic",
  "illustration",
  "anime",
  "painting",
  "render_3d",
  "unspecified",
] as const;
export type ImageStyleMedium = (typeof imageStyleMediums)[number];

/**
 * Semantic tags a subject fact uses to claim a morphology protection, and the
 * key each one buys.
 *
 * Tag-driven rather than kind-driven because the projection boundary is where
 * species knowledge lives: `@vesper/image-core` must not learn what a tail is,
 * and the application must not learn what `extra_appendages` means to a Qwen
 * negative block. A tag is the handshake — the adapter tags what it knows, this
 * table says what the tag buys, and neither side has to hold the other's
 * vocabulary.
 *
 * An untagged anatomy fact protects NOTHING, which is deliberate. Ordinary human
 * anatomy is exactly the case the anatomy block exists to defend, so a digest
 * full of untagged facts still gets the duplication exclusions it wants.
 */
export const imageMorphologyProtectionTags: Readonly<Record<string, ImageConflictKey>> = {
  "morphology.extra_limb": "extra_limbs",
  "morphology.extra_digit": "extra_digits",
  "morphology.extra_appendage": "extra_appendages",
  "morphology.absent_limb": "missing_limbs",
  "morphology.absent_digit": "missing_digits",
  "morphology.synthetic_surface": "synthetic_skin",
  "morphology.smooth_surface": "excessive_smoothing",
};

/** The protection a morphology tag buys, or null when the tag claims none. */
export function imageMorphologyProtectionOf(tag: string): ImageConflictKey | null {
  return imageMorphologyProtectionTags[tag] ?? null;
}
