import type {
  ImageItemDigest,
  ImageLocationDigest,
  ImageOperationContract,
  ImageSourceRef,
  ImageSourceRevision,
  ImageWorldFact,
} from "@vesper/image-core";
import { fnv1aHex } from "@/lib/hash";
import { IMAGE_ITEM_PROJECTION_OWNER, IMAGE_LOCATION_PROJECTION_OWNER } from "./world-projection";

/**
 * Library item and location rows, projected into world-digest facts.
 *
 * This replaces `prompts-entity.ts`, which formatted a finished paragraph per
 * entity kind. The difference is not stylistic. That module knew both what a
 * location IS and how a sentence about one should read, so teaching a second
 * model to describe a place meant copying both halves — and the "no people, no
 * text, no watermark" tail it appended was a negative prompt hiding inside
 * positive prose, invisible to any collision check.
 *
 * Here the projection decides only what is TRUE and how important it is. The
 * shot type, the framing, the exclusion of people and lettering all still happen;
 * they happen as an operation contract and a guarded negative pack, where they
 * can be inspected, versioned and contradicted by world truth when they should
 * be.
 *
 * Pure by construction: rows arrive as plain values, so this file has no database
 * and no environment, and the server module that reads the rows owns the read.
 */

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** The item row and definition members this projection reads. */
export interface ItemProjectionInput {
  readonly id: string;
  readonly name: string;
  readonly kind: "clothing" | "object" | "container";
  readonly description?: string | null;
  /** `definition.sensory.appearance`. */
  readonly appearance?: string | null;
  /** `definition.color.shade` — the free-text shade, not the filter family. */
  readonly colorShade?: string | null;
  /** `definition.subtype` — accessory subtype labels are deliberately prompt-bearing. */
  readonly subtype?: string | null;
  /** `definition.opacity`. */
  readonly opacity?: "opaque" | "sheer" | null;
  /** The row's `updatedAt`, as the source revision. */
  readonly revision: string;
}

/**
 * How each item kind is presented.
 *
 * Clothing hangs in its own shape without a wearer; anything else is isolated on
 * seamless ground. This is the one item fact that is a decision about the SHOT
 * rather than about the object, which is why it is `item.presentation` — a
 * framing concept — rather than a form or material one.
 *
 * The clothing wording NAMES NO SUPPORT, and that is the whole point. It used to
 * say "presented on an invisible ghost mannequin", which is the industry term for
 * exactly this shot and which put a plainly visible dress form in the picture
 * every single time: 6 of 6 renders for a scarf and 6 of 6 for a coat, measured
 * against this replacement at matched seeds. The word
 * "invisible" does not subtract the mannequin; naming it is what summons it.
 *
 * Describing the desired outcome instead — the garment holding its own shape,
 * nothing else in frame — drops that to 0 of 6 on both fixtures, with drape
 * quality and the authored scorched cuffs unaffected. Affirmative replacement is
 * also the default transport for an endpoint whose negative field does not
 * work, which this one's does not.
 */
const ITEM_PRESENTATION: Readonly<Record<ItemProjectionInput["kind"], string>> = {
  clothing: "hanging in its own shape with nothing else in the frame, the garment alone",
  object: "isolated on a clean seamless surface",
  container: "isolated on a clean seamless surface",
};

/** One item as a digest slice. */
export function projectItemDigest(input: ItemProjectionInput): ImageItemDigest {
  const ref = `item.${input.id}`;
  const source = (field: string): ImageSourceRef => ({
    owner: IMAGE_ITEM_PROJECTION_OWNER,
    key: field,
    entityId: input.id,
  });
  const name = input.name.trim();
  const facts: ImageWorldFact[] = [
    {
      key: `${ref}.identity`,
      concept: "item.identity",
      // The one fallback in the projection. A nameless item still renders — the
      // old builder said "an object" too — and refusing over an empty string
      // would take a library row out of service for a cosmetic gap.
      value: name.length > 0 ? `a product photograph of ${name}` : "a product photograph of an object",
      disposition: "required_visual",
      priority: 1,
      semanticTags: [],
      source: source("name"),
    },
    {
      key: `${ref}.presentation`,
      concept: "item.presentation",
      value: ITEM_PRESENTATION[input.kind],
      disposition: "required_visual",
      priority: 1,
      semanticTags: [`item_kind:${input.kind}`],
      source: source("kind"),
    },
  ];
  pushText(facts, {
    key: `${ref}.description`,
    // `item.form` rather than `item.identity`: the identity concept sits in the
    // mandatory `identity` segment kind, and an authored description filed there
    // would be a paragraph no budget squeeze could ever drop.
    concept: "item.form",
    text: input.description,
    limit: 220,
    priority: 0.9,
    source: source("description"),
  });
  pushText(facts, {
    key: `${ref}.appearance`,
    concept: "item.material",
    text: input.appearance,
    limit: 160,
    priority: 0.8,
    source: source("definition.sensory.appearance"),
  });
  pushText(facts, {
    key: `${ref}.color`,
    concept: "item.color",
    text: input.colorShade,
    limit: 60,
    priority: 0.7,
    source: source("definition.color"),
  });
  pushText(facts, {
    key: `${ref}.subtype`,
    concept: "item.form",
    text: input.subtype,
    limit: 60,
    priority: 0.6,
    source: source("definition.subtype"),
  });
  // Only `sheer` says anything: opaque is the default state of nearly every
  // object, and a prompt clause asserting it would spend budget on a non-fact.
  if (input.opacity === "sheer") {
    facts.push({
      key: `${ref}.opacity`,
      concept: "item.material",
      value: "sheer, semi-transparent fabric",
      disposition: "optional_visual",
      priority: 0.65,
      semanticTags: [],
      source: source("definition.opacity"),
    });
  }
  return { kind: "item", ref, entityId: input.id, label: name.length > 0 ? name : "the object", facts, morphology: [], missingRequired: [] };
}

/** The revision record one item contributes to the read token. */
export function itemSourceRevision(input: ItemProjectionInput): ImageSourceRevision {
  return { owner: IMAGE_ITEM_PROJECTION_OWNER, entityId: input.id, revision: input.revision };
}

/**
 * The job an item portrait is: a catalogue product photograph of one object and
 * no people.
 *
 * `subjectCount: 0` is doing real work rather than restating the obvious. It is
 * what compiles the "no people" sentence the old prose builder appended by hand,
 * AND what switches off every anatomy, hand, skin and single-subject negative
 * block — none of which has anything to defend in a photograph of a compass.
 */
export function itemImageOperation(): ImageOperationContract {
  return {
    kind: "generate",
    task: "item",
    strategy: "text_to_image_description",
    subjectCount: 0,
    style: {
      medium: "photographic",
      descriptors: [
        "studio lighting with soft shadows",
        "a seamless light-grey background",
        "centred composition",
        "sharp focus and high detail",
        "e-commerce catalogue product photography",
      ],
    },
    literalText: [],
  };
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** The location row and ambient members this projection reads. */
export interface LocationProjectionInput {
  readonly id: string;
  readonly name: string;
  readonly scale: "intimate" | "room" | "hall" | "open" | "expanse";
  readonly description?: string | null;
  /** `ambient.light`. */
  readonly light?: string | null;
  readonly revision: string;
}

/** Whether a scale means an outdoor establishing view rather than an interior. */
export function isOutdoorLocationScale(scale: LocationProjectionInput["scale"]): boolean {
  switch (scale) {
    case "open":
    case "expanse":
      return true;
    case "intimate":
    case "room":
    case "hall":
      return false;
  }
}

/** One location as a digest slice. */
export function projectLocationDigest(input: LocationProjectionInput): ImageLocationDigest {
  const ref = `location.${input.id}`;
  const source = (field: string): ImageSourceRef => ({
    owner: IMAGE_LOCATION_PROJECTION_OWNER,
    key: field,
    entityId: input.id,
  });
  const name = input.name.trim();
  const outdoor = isOutdoorLocationScale(input.scale);
  const facts: ImageWorldFact[] = [
    {
      key: `${ref}.identity`,
      concept: "location.identity",
      value: name.length > 0 ? `an establishing photograph of ${name}` : "an establishing photograph of a place",
      disposition: "required_visual",
      priority: 1,
      semanticTags: [],
      source: source("name"),
    },
    {
      key: `${ref}.geometry`,
      // The shot, not the architecture: `location.presentation` is the framing
      // concept, so this survives as a framing claim while `location.geometry`
      // stays free for an owner that one day projects real architectural layout.
      concept: "location.presentation",
      value: outdoor
        ? "a wide outdoor view taking in the whole landscape"
        : "a wide-angle architectural interior view with a clear sense of depth",
      disposition: "required_visual",
      priority: 1,
      semanticTags: [`location_scale:${input.scale}`, outdoor ? "outdoor" : "indoor"],
      source: source("scale"),
    },
  ];
  pushText(facts, {
    key: `${ref}.description`,
    concept: "location.contents",
    text: input.description,
    limit: 240,
    priority: 0.9,
    source: source("description"),
  });
  pushText(facts, {
    key: `${ref}.light`,
    concept: "location.lighting",
    text: input.light,
    limit: 80,
    priority: 0.8,
    source: source("ambient.light"),
  });
  return {
    kind: "location",
    ref,
    entityId: input.id,
    label: name.length > 0 ? name : "the place",
    facts,
    morphology: [],
    missingRequired: [],
  };
}

/** The revision record one location contributes to the read token. */
export function locationSourceRevision(input: LocationProjectionInput): ImageSourceRevision {
  return { owner: IMAGE_LOCATION_PROJECTION_OWNER, entityId: input.id, revision: input.revision };
}

/**
 * The job a location portrait is: an empty establishing shot.
 *
 * The descriptors differ by scale for the same reason the geometry fact does — an
 * outdoor vista and an interior want different light and depth language — while
 * the medium, the emptiness and the strategy are the same job either way.
 */
export function locationImageOperation(scale: LocationProjectionInput["scale"]): ImageOperationContract {
  const outdoor = isOutdoorLocationScale(scale);
  return {
    kind: "generate",
    task: "location",
    strategy: "text_to_image_description",
    subjectCount: 0,
    style: {
      medium: "photographic",
      descriptors: outdoor
        ? ["a scenic vista", "natural light", "atmospheric depth", "sharp focus and high detail"]
        : ["an inviting interior", "ambient lighting", "a strong sense of depth", "sharp focus and high detail"],
    },
    literalText: [],
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Add an optional-visual fact for a free-text field, or nothing when the field is
 * blank.
 *
 * Trimming to a limit rather than sending the whole column is the same budget
 * discipline the old builder's `excerpt` applied, kept because these are authored
 * prose fields with no length ceiling and one long description would otherwise
 * crowd out every other fact through the fitter rather than through a decision.
 */
function pushText(
  facts: ImageWorldFact[],
  input: {
    key: string;
    concept: ImageWorldFact["concept"];
    text: string | null | undefined;
    limit: number;
    priority: number;
    source: ImageSourceRef;
  },
): void {
  const text = input.text?.trim() ?? "";
  if (text.length === 0) return;
  facts.push({
    key: input.key,
    concept: input.concept,
    value: text.length <= input.limit ? text : `${text.slice(0, input.limit).trimEnd()}…`,
    disposition: "optional_visual",
    priority: input.priority,
    semanticTags: [],
    source: input.source,
  });
}

/**
 * The read token for a standalone entity render.
 *
 * A hash over the sorted source revisions, which gives the property a retry
 * needs: two reads of unchanged rows mint the SAME token, so "retry this exact
 * composition" can verify it got the same world, while an edit to the row between
 * the two reads mints a different one and the retry is told so rather than
 * quietly rendering the new state under the old composition's name.
 */
export function entityReadToken(revisions: readonly ImageSourceRevision[]): string {
  const parts = [...revisions]
    .sort((left, right) => left.owner.localeCompare(right.owner) || left.entityId.localeCompare(right.entityId))
    .map((entry) => `${entry.owner} ${entry.entityId} ${entry.revision}`);
  return fnv1aHex(parts.join(""));
}
