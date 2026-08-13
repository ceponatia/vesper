import { excerpt } from "./prompts-format";

/** Item and location prompts: text to image, no reference. */

// ---------------------------------------------------------------------------
// Entity images (items & locations — text → image, no reference)
// ---------------------------------------------------------------------------

export interface ItemImageInput {
  name: string;
  description?: string;
  kind?: "clothing" | "object" | "container";
  /** Sensory appearance note from the item definition, if any. */
  appearance?: string;
}

const ITEM_FRAMING: Record<NonNullable<ItemImageInput["kind"]>, string> = {
  clothing: "the garment presented on an invisible ghost mannequin",
  object: "the object isolated on a clean seamless surface",
  container: "the object isolated on a clean seamless surface",
};

/**
 * Product-photo prompt for a library item (docs/images/pipelines.md §Entity images):
 * a catalog-style shot composed from the item's own fields. Clothing gets a
 * ghost-mannequin framing so its shape reads; objects/containers a clean
 * isolated product shot.
 */
export function buildItemImagePrompt(input: ItemImageInput): string {
  const framing = ITEM_FRAMING[input.kind ?? "object"];
  return [
    `Professional product photograph of ${input.name.trim() || "an object"} — ${framing}.`,
    input.description?.trim() ? `Details: ${excerpt(input.description, 220)}.` : "",
    input.appearance?.trim() ? `Appearance: ${excerpt(input.appearance, 160)}.` : "",
    "Studio lighting, soft shadows, seamless light-grey background, centered composition, sharp focus, high detail, e-commerce catalog photography, no people, no text, no watermark.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface LocationImageInput {
  name: string;
  description?: string;
  /** Spatial size class (proximity-spec): `open`/`expanse` ⇒ outdoor landscape, else interior. */
  scale?: string;
  /** Ambient light note — the only visually-relevant ambient channel. */
  light?: string;
}

/**
 * Establishing-shot prompt for a library location (docs/images/pipelines.md §Entity
 * images). The location's `scale` chooses the photograph type: wide outdoor
 * landscapes for `open`/`expanse`, architectural interiors otherwise. Always
 * an empty establishing shot — no people.
 */
export function buildLocationImagePrompt(input: LocationImageInput): string {
  const outdoor = input.scale === "open" || input.scale === "expanse";
  const lead = outdoor ? "Wide establishing landscape photograph" : "Architectural interior photograph, wide angle";
  const closer = outdoor
    ? "Scenic vista, natural light, atmospheric depth, no people, no text, no watermark."
    : "Inviting interior, ambient lighting, sense of depth, no people, no text, no watermark.";
  return [
    `${lead} of ${input.name.trim() || "a place"}.`,
    input.description?.trim() ? `${excerpt(input.description, 240)}.` : "",
    input.light?.trim() ? `Lighting: ${excerpt(input.light, 80)}.` : "",
    closer,
  ]
    .filter(Boolean)
    .join(" ");
}
