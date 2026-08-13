import { attributeRegistry } from "@/contracts/attributes";
import {
  exposedRegions,
  resolveGarmentVisibility,
  type WornGarmentPart,
  type WornItemInput,
} from "@/contracts/items/visibility";
import type { ClothingLayer } from "@/contracts/items/item";
import { clothingSubtypeLabel } from "@/contracts/items/subtypes";
import { isBelowWaist, isFeatureAttributeCategory } from "@/contracts/body/locations";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import { imageAgeWord } from "./prompts-appearance";
import {
  clause,
  formatAttributeValue,
  formatGarment,
  isIntimateAttribute,
  isNonVisualAttribute,
  orderedAppearanceClauses,
  realizedBodyForProfile,
  subjectDescriptor,
} from "./prompts-format";

/** Avatar prompts: the text-to-image builder and the wardrobe/outfit inputs it reads. */

// ---------------------------------------------------------------------------
// Avatar generation (text → image)
// ---------------------------------------------------------------------------

export type AvatarStyle = "realistic" | "stylized";

const STYLE_PREFIX: Record<AvatarStyle, string> = {
  realistic: "Ultra-realistic professional portrait photograph",
  stylized: "High-quality stylized character illustration, painterly detail, clean linework",
};

const STYLE_SUFFIX: Record<AvatarStyle, string> = {
  realistic:
    "Professional beauty portrait, flattering soft studio lighting, photogenic composition, luminous skin rendering, shallow depth of field, 85mm lens bokeh, magazine-quality, no text, no watermark.",
  stylized:
    "Beautiful stylized portrait, flattering soft lighting, photogenic composition, vibrant colors, shallow depth of field, magazine-quality illustration, no text, no watermark.",
};

/** One default-outfit garment, phrased for the avatar prompt. */
export interface AvatarOutfitItem {
  /** Item name — fallback label when the garment has no description. */
  name: string;
  /** Item definition description — the primary phrasing (usually restates the name). */
  description?: string;
  /** Optional sensory appearance note from the item definition. */
  appearance?: string;
  /** Accessory-type label ("nose ring") — leads the garment phrase so the model places the piece. */
  subtypeLabel?: string;
}

/** A default-outfit garment before occlusion / waist-up filtering. */
export interface AvatarWardrobeItem {
  /** Item-definition id (chat-wardrobe-parity — the chat worn list keys by it); absent for avatar-only use. */
  id?: string;
  name: string;
  coverage: readonly string[];
  layer?: number | null;
  opacity?: "opaque" | "sheer";
  description?: string;
  appearance?: string;
  /** Clothing subtype id (contracts/items/subtypes) — resolved to its label for the prompt. */
  subtype?: string | null;
  /**
   * `clothingCategories` id. NEVER prompt-bearing (docs/prompts.md) — it rides
   * here only so the garment store can pick a part template when it instantiates
   * this definition (clothing-state-graph.plan.md slice 2).
   */
  category?: string;
  /** Authoring tags — a material-inference input for the garment store, never prompt text. */
  tags?: readonly string[];
  /**
   * The garment INSTANCE id when this item came from the chat garment store
   * (clothing-state-graph slice 3). Absent for a plain definition list, which
   * then keys on its position — see `wardrobeGarmentKey`.
   */
  garmentId?: string;
  /**
   * Presentation-aware per-part coverage from the garment store. When present it
   * REPLACES the flat `coverage` for occlusion, so a rolled left sleeve exposes a
   * left forearm without the right one following. `coverage` still carries the
   * union (the flat read every other consumer uses).
   */
  parts?: readonly WornGarmentPart[];
}

/**
 * Occlusion-aware outfit lines (same rule as in-session scene images,
 * contracts/items/visibility.ts): a layer fully covered by opaque higher
 * layers is omitted — telling the image model about the t-shirt under a
 * closed abaya makes it paint the abaya open. Sheer-covered items stay as a
 * vague hint; items with no coverage (jewelry, props) stay visible.
 *
 * Waist-up framing (avatar only): a garment whose coverage is entirely below
 * the waist (pants, skirts, shoes) is dropped — handing the model footwear or
 * trousers tempts a full-body shot against the "waist-up portrait" instruction.
 * A garment that also covers the torso (dress, coat, abaya) and coverage-less
 * props (jewelry) stay. Scene images never call this, so they keep full-body
 * garments (docs/images/pipelines.md §Avatar generation, followups.phase3.md §1).
 */
/**
 * The GARMENT key for one wardrobe row — the instance id when the garment store
 * owns this item, else its position in the list. The single place a key is
 * derived, so a renderer never re-invents `String(index)` and then mismatches a
 * per-part expansion (slice-0 audit finding 3).
 */
export function wardrobeGarmentKey(item: AvatarWardrobeItem, index: number): string {
  return item.garmentId ?? `w${index}`;
}

function clampWornLayer(layer: number): ClothingLayer {
  return layer <= 0 ? 0 : layer === 1 ? 1 : layer === 2 ? 2 : 3;
}

/** Map raw avatar-wardrobe items to the shared worn-item shape — the single
 * source for BOTH visibility (visibleAvatarOutfit) and coverage/exposure
 * (exposedRegions), so the two can never disagree about what a garment covers.
 *
 * A store-backed item expands to ONE ROW PER COVERING PART (slice 3): each row
 * carries its own coverage and the garment's id, so occlusion is resolved at part
 * granularity and renderers roll back up by `garmentId`. Parts covering nothing
 * never occlude anything, so they are omitted; a garment covering nothing at all
 * still gets one row, which keeps coverage-less pieces (jewelry, props) visible. */
export function toWornInputs(items: ReadonlyArray<AvatarWardrobeItem>): WornItemInput[] {
  return items.flatMap((item, index): WornItemInput[] => {
    const garmentId = wardrobeGarmentKey(item, index);
    const layer = clampWornLayer(item.layer ?? 1);
    const opacity = item.opacity ?? "opaque";
    const covering = (item.parts ?? []).filter((part) => part.coverage.length > 0);
    if (covering.length === 0) {
      return [{ instanceId: garmentId, garmentId, name: item.name, coverage: item.coverage, layer, opacity }];
    }
    return covering.map((part) => ({
      instanceId: `${garmentId}:${part.partId}`,
      garmentId,
      name: item.name,
      coverage: part.coverage,
      layer: clampWornLayer(layer + (part.layerOffset ?? 0)),
      opacity,
    }));
  });
}

export function visibleAvatarOutfit(items: ReadonlyArray<AvatarWardrobeItem>): AvatarOutfitItem[] {
  const byGarment = resolveGarmentVisibility(toWornInputs(items));
  return items.flatMap((item, index) => {
    if (item.coverage.length > 0 && item.coverage.every(isBelowWaist)) return []; // below the waist — outside a waist-up portrait
    const visibility = byGarment.get(wardrobeGarmentKey(item, index));
    if (visibility === "hidden") return [];
    if (visibility === "hinted") {
      return [{ name: `${item.name} (only a vague hint beneath sheer layers)` }];
    }
    const subtypeLabel = clothingSubtypeLabel(item.subtype);
    return [
      {
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        ...(item.appearance ? { appearance: item.appearance } : {}),
        ...(subtypeLabel ? { subtypeLabel } : {}),
      },
    ];
  });
}

/**
 * Composes the text-to-image avatar prompt from the character's resolved
 * attribute values. The attribute registry labels name each trait; the image
 * prompt carries only `label: value` appearance lines — **not** the registry
 * `promptHints`, which are narrator/inference guidance (e.g. "state apparent age
 * as an impression…") that an image model reads as literal subject detail (a hint
 * with a concrete example like "late thirties" anchored every face to that age).
 * promptHints still flow to the narrator via engine/scene.ts; add one back here
 * only if testing shows it improves image output. The default outfit is
 * authoritative when present — without it the image model invents clothing,
 * which contradicts the character's saved wardrobe.
 *
 * Takes the **raw wardrobe** (with coverage), not a pre-filtered outfit, so it
 * owns BOTH gates from one coverage source and they can't drift apart:
 *  - **Waist-up framing:** every below-the-waist attribute (`bodyLocationId`
 *    under pelvis/legs — feet, legs, hips, and pelvic intimate anatomy) is
 *    dropped, mirroring the garment-side `visibleAvatarOutfit` filter. A
 *    waist-up portrait can't show them. Signature feature morphology (a
 *    pelvis-rooted tail) is exempt — it sweeps up into frame and defines the
 *    character.
 *  - **Exposure gating** (intimate anatomy, body-model spec Decision 3): the
 *    above-waist intimate category (`breasts`) reaches the prompt only when
 *    `allowIntimate` is set AND only when its region reads exposed
 *    (`exposedRegions`) — Maya's bra-covered chest stays unmentioned. The
 *    `allowIntimate`-off path (the moderation-prone composer) excludes all
 *    intimate anatomy regardless. This reuses the same exposure predicate as the
 *    scene render (`intimateAttrRendersExposed`).
 */
/**
 * Attributes withheld from the **waist-up avatar prompt only** (scene-images "D"):
 * low-value in a head-and-shoulders still, where every token dilutes a
 * limited-adherence SDXL model's attention from the load-bearing features. These
 * fall into: not visible in a still (`movement.*`), no reference to read (height),
 * sub-perceptible (undertone/texture/slope/neck/brows), usually out of frame or
 * tiny (hands/arm hair/ear piercings), and **all teeth** — "sharp canines" makes
 * SDXL render a ridiculous mouth. Scene images keep the full set (they're
 * full-body and use `characterAppearanceSummary`, not this list). Curating by id
 * keeps the cut avatar-local and reversible; a registry `imageValue` tag is the
 * eventual home if this grows (scene-images plan).
 */
const AVATAR_OMIT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "movement.gait",
  "movement.posture_default",
  "build.height",
  "skin.undertone",
  "skin.texture",
  "shoulders.slope",
  "neck.length",
  "neck.throat_prominence",
  "arms.hair",
  "hands.size",
  "hands.texture",
  "hands.nails",
  "brows.shape",
  "brows.thickness",
  // ears.piercings rejoined the prompt with the face-jewelry work: piercings
  // are now first-class visual detail (nose/lip piercings render too).
  "teeth.shape",
  "teeth.condition",
  "lips.shape",
  "horns.texture",
]);

export function buildAvatarPrompt(
  name: string,
  profile: CharacterProfile,
  style: AvatarStyle,
  wardrobe: ReadonlyArray<AvatarWardrobeItem> = [],
): string {
  const realizedBody = realizedBodyForProfile(profile);
  // Coverage of the FULL wardrobe (before the waist-up garment filter) — a
  // covering garment still hides its region even when it's dropped from the
  // visible outfit, so exposure must read the raw set.
  const exposure = exposedRegions(toWornInputs(wardrobe));

  // Group surviving appearance attributes by category so like-fields render as
  // ONE coherent clause (every horn facet together, etc.) and the section can be
  // ORDERED to lead with non-human morphology. SDXL-family models (e.g. Lustify)
  // front-load attention and parse grouped caption/tag phrasing far better than a
  // flat "Label: value" metadata wall, so establishing the creature first — and
  // dropping the per-field label nouns — stops "a human wearing fake wings"
  // (scene-images A+B+C). Identity (gender, apparent age) folds into the subject.
  const byCategory = new Map<string, string[]>();
  let gender: string | undefined;
  let apparentAge: string | undefined;
  let heritage: string | undefined;
  for (const value of profile.attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — skip rather than leak raw ids into the prompt
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (!realizedBody.isAttributeApplicable(def)) continue; // stale/gated attributes must not outlive the realized body
    // Waist-up portrait: drop below-the-waist anatomy (feet, legs, hips, pelvic
    // intimate) — but keep signature feature morphology (a succubus tail roots
    // at the pelvis yet sweeps up into frame), which is the whole point of the
    // character and reads in a waist-up shot.
    if (def.bodyLocationId && isBelowWaist(def.bodyLocationId) && !isFeatureAttributeCategory(def.category)) continue;
    if (AVATAR_OMIT_ATTRIBUTES.has(def.id)) continue; // low-value in a waist-up still (scene-images "D")
    if (isNonVisualAttribute(def)) continue; // voice/scent don't render in a portrait
    // The portrait studio is intimate-free by rule: intimate anatomy never
    // reaches the avatar prompt, whatever the wardrobe exposes — exposure-gated
    // intimate detail belongs to the scene-render paths only.
    if (isIntimateAttribute(def)) continue;
    // Chest hair is hidden under clothing — only state it when the torso reads bare/sheer.
    if (def.id === "chest.hair" && exposure.torso === "covered") continue;
    if (value.id === "identity.gender") {
      gender = formatAttributeValue(def, value.value) || undefined;
      continue;
    }
    if (value.id === "identity.apparent_age") {
      // Image age floor (owner ruling 2026-07-29): minor bands emit NO age word;
      // "eighteen" states the number. Never the raw registry label here.
      apparentAge = imageAgeWord(value.value);
      continue;
    }
    if (value.id === "identity.heritage") {
      heritage = formatAttributeValue(def, value.value) || undefined; // ethnicity → appended to the subject phrase
      continue;
    }
    if (def.category === "identity") continue; // any other identity facet isn't a visual descriptor
    const token = formatAttributeValue(def, value.value);
    if (!token) continue;
    const bucket = byCategory.get(def.category);
    if (bucket) bucket.push(token);
    else byCategory.set(def.category, [token]);
  }

  const wearing = visibleAvatarOutfit(wardrobe).map(formatGarment).join("; ");
  // Species label only (the morphology lives in the feature attributes); "" for human.
  const species = speciesLabelPhrase(profile.speciesId, profile.heritageId);
  const subjectName = name.trim() || "an unnamed character";
  const descriptor = subjectDescriptor(apparentAge, gender, species, heritage);
  const appearance = orderedAppearanceClauses(byCategory).join("; ");

  // Bio is deliberately omitted (no visual signal). Order: creature subject →
  // grouped appearance (morphology first) → clothing → photographic style.
  return [
    `${STYLE_PREFIX[style]}, waist-up portrait, facing camera, soft studio lighting, neutral background.`,
    descriptor ? `Subject: ${subjectName} — ${descriptor}.` : `Subject: ${subjectName}.`,
    appearance ? `Appearance: ${clause(appearance)}.` : "",
    wearing ? `Wearing (authoritative — depict exactly this clothing): ${clause(wearing)}.` : "",
    STYLE_SUFFIX[style],
  ]
    .filter(Boolean)
    .join(" ");
}
