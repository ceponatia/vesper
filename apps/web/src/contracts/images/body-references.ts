import { z } from "zod";
import { attributeRegistry, formatAttributeValue, resolveAttributes, type AttributeValue } from "../attributes";
import { characterAppearanceAspect } from "./character-adapter";
import { imageAgeAllowsIntimate, referenceViewWardrobeById, type ReferenceView } from "./reference-views";

/**
 * **BODY REFERENCE IMAGES** — up to two full-body images an owner gives
 * Portrait Studio, so the reference views follow the character's real body
 * while the face still comes from the accepted portrait
 * (`docs/images/pipelines/reference-views.md` §Body reference images).
 *
 * They are INPUTS to the reference-view build and nothing else: no scene, no
 * portrait variant and no listing ever sees one. Each carries a tag saying what
 * it shows — the body dressed or undressed — and the tag decides which views it
 * is sent to ({@link referenceViewBodyReferences}). There is no review step of
 * their own: setting one puts it in use, and each view built from it is
 * reviewed as any view is.
 *
 * PURE. The store holds the rows; every rule about them lives here, so the
 * build, the staleness projection and the studio read one answer.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** What a body image shows. `unclothed` is the intimate one, behind the adult gate. */
export const bodyReferenceTags = ["clothed", "unclothed"] as const;
export const bodyReferenceTagSchema = z.enum(bodyReferenceTags);
export type BodyReferenceTag = z.infer<typeof bodyReferenceTagSchema>;

/**
 * The two places a body image can sit. Fixed slots rather than a list, so
 * "a third image" is not a state the storage can hold (a partial unique index
 * keeps one current row per slot) and a replace or remove names exactly the
 * image the owner was looking at.
 */
export const bodyReferenceSlots = [1, 2] as const;
export type BodyReferenceSlot = (typeof bodyReferenceSlots)[number];
export const bodyReferenceSlotSchema = z.union([z.literal(1), z.literal(2)]);

/** A slot from a URL segment, or null for anything the vocabulary has no slot for. */
export function parseBodyReferenceSlot(segment: string): BodyReferenceSlot | null {
  return bodyReferenceSlots.find((slot) => String(slot) === segment) ?? null;
}

/**
 * The tag a new image in this slot starts with (owner ruling 2026-10-01): the
 * first is dressed, the second undressed. Only a default — the owner may choose
 * either for either slot, the same tag twice included.
 */
export function defaultBodyReferenceTag(slot: BodyReferenceSlot): BodyReferenceTag {
  return slot === 1 ? "clothed" : "unclothed";
}

/** One stored body image, as every rule below reads it. */
export interface BodyReferenceImage {
  readonly slot: BodyReferenceSlot;
  readonly imageId: string;
  readonly tag: BodyReferenceTag;
}

function bySlot(left: BodyReferenceImage, right: BodyReferenceImage): number {
  return left.slot - right.slot;
}

// ---------------------------------------------------------------------------
// What may be sent
// ---------------------------------------------------------------------------

/**
 * Whether a stored image is kept from every render: an `unclothed` image of a
 * character who fails the adult gate the undressed views use
 * (`imageAgeAllowsIntimate`). It stays stored — the age can change back — and
 * the studio says it is not being used.
 */
export function bodyReferenceWithheld(
  image: Pick<BodyReferenceImage, "tag">,
  profile: { readonly attributes: readonly AttributeValue[] },
): boolean {
  return image.tag === "unclothed" && !imageAgeAllowsIntimate(profile);
}

/** The images a build may send for this character right now, in slot order. */
export function sendableBodyReferences(
  images: readonly BodyReferenceImage[],
  profile: { readonly attributes: readonly AttributeValue[] },
): BodyReferenceImage[] {
  return images.filter((image) => !bodyReferenceWithheld(image, profile)).sort(bySlot);
}

/**
 * **THE BODY-IMAGE SET** a view was rendered against, as one comparable string:
 * each sendable image's id and tag, in slot order — or null for no image at all.
 *
 * A view row records it, and the sheet projects a rendered view stale once it
 * differs from the character's set right now, so adding, replacing, removing or
 * re-tagging an image marks the views out of date without rebuilding anything.
 * Null IS the empty set, which is what every row rendered before body images
 * existed stores: a character that never adds one sees no change, and adding
 * the first makes the sheet stale.
 *
 * Over the SENDABLE images, not the stored ones: an unclothed image the adult
 * gate starts withholding changes what a build would send, so the views built
 * from it go stale with it. A string rather than a hash, because two short ids
 * are cheap to store and an exact comparison cannot collide.
 */
export function bodyReferenceSetKey(sendable: readonly BodyReferenceImage[]): string | null {
  if (sendable.length === 0) return null;
  return [...sendable]
    .sort(bySlot)
    .map((image) => `${image.imageId}:${image.tag}`)
    .join(",");
}

/**
 * **THE ROUTING TABLE** — which body images one view's render sends, in send
 * order, after the identity pack and the view's approved upstream view.
 *
 * | View wardrobe | Body images |
 * | --- | --- |
 * | dressed (the root and every other angle) | all of them, `clothed` first |
 * | undressed | the `unclothed` ones only |
 *
 * An undressed view shows a body the same angle's approved dressed view already
 * shows, so a dressed body image adds nothing to it; a dressed view takes an
 * undressed image too, because the clothing comes from the prompt and the image
 * is there for the body. Every one is an OPTIONAL reference, cut to the model's
 * capacity like any other. A wardrobe the registry dropped takes none.
 */
export function referenceViewBodyReferences(
  view: ReferenceView,
  sendable: readonly BodyReferenceImage[],
): BodyReferenceImage[] {
  const wardrobe = referenceViewWardrobeById(view.wardrobe);
  if (wardrobe === undefined) return [];
  const ordered = [...sendable].sort(bySlot);
  if (wardrobe.intimate) return ordered.filter((image) => image.tag === "unclothed");
  return [...ordered.filter((image) => image.tag === "clothed"), ...ordered.filter((image) => image.tag !== "clothed")];
}

// ---------------------------------------------------------------------------
// The character's body, in words
// ---------------------------------------------------------------------------

export const bodyReferenceAttributeSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
});
export type BodyReferenceAttribute = z.infer<typeof bodyReferenceAttributeSchema>;

/**
 * The character's body attributes — every registry attribute whose appearance
 * aspect is `build` (`characterAppearanceAspect`), never a hand list of ids —
 * resolved and worded as the prompt words them, in registry order.
 *
 * The upload dialog shows them beside the image so the owner can make the two
 * agree: a body image never supersedes the text (owner ruling 2026-10-01), so a
 * picture that contradicts the written build sends the model two answers.
 */
export function bodyReferenceAttributes(attributes: readonly AttributeValue[]): BodyReferenceAttribute[] {
  const resolved = resolveAttributes(attributes, []);
  return attributeRegistry.definitions.flatMap((definition) => {
    if (characterAppearanceAspect(definition.id) !== "build") return [];
    const entry = resolved.find((candidate) => candidate.id === definition.id);
    if (entry === undefined) return [];
    const value = formatAttributeValue(definition, entry.value);
    return value.length === 0 ? [] : [{ id: definition.id, label: definition.label, value }];
  });
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export const bodyReferenceSummarySchema = z.object({
  slot: bodyReferenceSlotSchema,
  imageId: z.string(),
  tag: bodyReferenceTagSchema,
  /** Stored but never sent: an `unclothed` image of a character the adult gate refuses. */
  withheld: z.boolean().catch(false),
  updatedAt: z.string().nullable().catch(null),
});
export type BodyReferenceSummary = z.infer<typeof bodyReferenceSummarySchema>;

/**
 * Everything the studio's body-image area reads. Forgiving at every leaf, like
 * the reference-view set it travels beside: the area is additive, and a body it
 * cannot read degrades to "no images" rather than failing the sheet.
 */
export const bodyReferenceSetSchema = z.object({
  images: z.array(bodyReferenceSummarySchema).max(bodyReferenceSlots.length).catch([]),
  /** The character passes the adult gate, so an `unclothed` image may be added and is sent. */
  unclothedAllowed: z.boolean().catch(false),
  attributes: z.array(bodyReferenceAttributeSchema).catch([]),
});
export type BodyReferenceSet = z.infer<typeof bodyReferenceSetSchema>;

export function emptyBodyReferenceSet(): BodyReferenceSet {
  return { images: [], unclothedAllowed: false, attributes: [] };
}

/**
 * `{ dataUrl, tag, expectedImageId }` — an image for one slot. The data-URL cap
 * is the reference-view upload's, for its reason. `expectedImageId` is the image
 * the owner saw in the slot (null for an empty one), so a replace that crossed
 * another tab's edit is refused rather than retiring an image nobody looked at.
 */
export const bodyReferenceUploadRequestSchema = z.object({
  dataUrl: z
    .string()
    .min(1)
    .max(3_000_000)
    .refine((value) => value.startsWith("data:image/"), "dataUrl must be an image data URL"),
  tag: bodyReferenceTagSchema,
  expectedImageId: z.string().min(1).max(128).nullable(),
});
export type BodyReferenceUploadRequest = z.infer<typeof bodyReferenceUploadRequestSchema>;

/** `{ tag, expectedImageId }` — re-tag exactly the image the owner saw. */
export const bodyReferenceRetagRequestSchema = z.object({
  tag: bodyReferenceTagSchema,
  expectedImageId: z.string().min(1).max(128),
});
export type BodyReferenceRetagRequest = z.infer<typeof bodyReferenceRetagRequestSchema>;
