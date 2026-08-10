import { z } from "zod";
import { attributeRegistry, promptValueWithNoneElided, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  exposedRegions,
  resolveGarmentVisibility,
  type RegionExposure,
  type WornGarmentPart,
  type WornItemInput,
} from "@/contracts/items/visibility";
import type { ClothingLayer } from "@/contracts/items/item";
import { clothingSubtypeLabel } from "@/contracts/items/subtypes";
import { INTIMATE_ATTRIBUTE_CATEGORIES, isBelowWaist, isFeatureAttributeCategory } from "@/contracts/body/locations";
import { realizeBody, speciesLabelPhrase } from "@/contracts/species";
import type { SceneVisualReferenceKind } from "@/contracts/images/scene-reference";
import {
  resolveViewerParts,
  VIEWER_SKIN_ATTRIBUTE_IDS,
  viewerBodyPartById,
  type ViewerBodyPart,
  type ViewerBodyPartId,
} from "@/contracts/images/viewer-body";
import type { CharacterProfile } from "@/contracts/world/profile";

/**
 * Intimate-anatomy attributes are withheld from image prompts unless the caller
 * sets `allowIntimate` (body-model spec Decision 3). Image generation is now
 * uncensored end-to-end, so avatar generation always sets it; the
 * gate remains off for the moderation-prone scene composer's appearance summary.
 */
/**
 * Non-visual attributes never belong in an image prompt — an image can't depict
 * how someone sounds, smells, or how sensitive they are. `kind: "sensory"` is the
 * auditory/olfactory/tactile-response set (voice pitch/timbre/cadence, baseline
 * scent, intimate scent/taste, and per-region sensitivity), so it is dropped from
 * both the avatar prompt and the scene appearance summary. (Intimate sensory
 * anatomy is already gated separately by the exposure predicates.)
 */
function isNonVisualAttribute(def: AttributeDefinition): boolean {
  return def.kind === "sensory";
}

function isIntimateAttribute(def: AttributeDefinition): boolean {
  return (INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category);
}

function realizedBodyForProfile(profile: CharacterProfile) {
  return realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });
}

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

// Appearance bucket order: non-human morphology + skin first (an SDXL-family model
// commits to the creature before the human-ish traits), then body, hair, eyes,
// face, presentation. Categories not listed sort last so a new one degrades
// gracefully (still rendered) instead of vanishing.
const APPEARANCE_CATEGORY_ORDER: readonly string[] = [
  "horns", "wings", "tail",
  "skin",
  "build", "shoulders", "neck", "chest", "breasts", "waist", "arms", "hands",
  "hair",
  "eyes", "brows",
  "face", "nose", "lips", "ears", "teeth",
  "movement",
  "presentation",
];
/** Display noun per bucket; defaults to the capitalized category. */
const APPEARANCE_BUCKET_NOUNS: Readonly<Record<string, string>> = {
  presentation: "Style",
  movement: "Bearing",
  breasts: "Bust",
};

function appearanceOrder(category: string): number {
  const index = APPEARANCE_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? APPEARANCE_CATEGORY_ORDER.length : index;
}

function bucketNoun(category: string): string {
  return APPEARANCE_BUCKET_NOUNS[category] ?? capitalizeFirst(category);
}

/**
 * Caption/tag-style appearance clauses, grouped by category and ordered so
 * non-human morphology leads (scene-images A+B+C). Each clause is
 * "<Noun>: value, value" — the per-attribute label noun is dropped (the bucket
 * header carries it), so the model reads coherent grouped tags instead of a flat
 * "Label: value" metadata wall it largely ignores.
 */
function orderedAppearanceClauses(byCategory: ReadonlyMap<string, string[]>): string[] {
  return [...byCategory.keys()]
    .sort((a, b) => appearanceOrder(a) - appearanceOrder(b))
    .flatMap((category) => {
      const values = byCategory.get(category) ?? [];
      return values.length > 0 ? [`${bucketNoun(category)}: ${clause(values.join(", "))}`] : [];
    });
}

/**
 * The subject's lead phrase — "a <apparent age> <gender> <species>, <ethnicity>"
 * — so the creature identity lands before any feature (scene-images A). Gender or
 * species supplies the noun; with neither (but some base word), "person" does, so
 * the phrase never dangles. Ethnicity (`identity.heritage`, free text, original
 * casing) is appended after a comma — distinct from the species noun so a "Latina
 * succubus" reads right. Empty when nothing is set.
 */
function subjectDescriptor(apparentAge?: string, gender?: string, species?: string, heritage?: string): string {
  const words = [apparentAge, gender, species]
    .map((w) => w?.trim().toLowerCase())
    .filter((w): w is string => Boolean(w));
  if (words.length > 0 && !gender?.trim() && !species?.trim()) words.push("person");
  let phrase = words.join(" ");
  const ethnicity = heritage?.trim();
  if (ethnicity) phrase = phrase ? `${phrase}, ${ethnicity}` : ethnicity;
  if (!phrase) return "";
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

// Trim a trailing period/whitespace off interpolated content so a clause's own
// "." is never doubled when the content already ends in one — free-text colors,
// bios, or species phrases produced "…sharp fangs.." (UX-audit P4).
function clause(body: string): string {
  return body.replace(/[.\s]+$/, "");
}

/** `Label: value` form (the scene appearance summary still uses this). */
function formatAttribute(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  if (typeof value === "boolean") return value ? def.label : "";
  const text = formatAttributeValue(def, value);
  return text ? `${def.label}: ${text}` : "";
}

/** Value-only token (no label noun) for the grouped avatar prompt (scene-images C). */
function formatAttributeValue(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  // "none" is elided unless the definition opts in (contracts/attributes/value.ts) —
  // "piercings: none" plants the very noun the image model then paints anyway.
  const rendered = promptValueWithNoneElided(def, value);
  if (rendered === null) return "";
  if (typeof rendered === "boolean") return rendered ? humanize(def.label).toLowerCase() : "";
  if (typeof rendered === "number") return `${rendered}${def.unit ? ` ${def.unit}` : ""}`;
  return Array.isArray(rendered) ? rendered.map(humanize).join(", ") : humanize(rendered);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").trim();
}

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * Garment phrasing for image prompts (followups.phase3.md §1): the item's
 * description is the primary text — it usually restates the name and carries
 * more visual detail — with the bare name as the fallback when there is no
 * description, and the sensory appearance appended in parentheses. Untruncated:
 * clothing detail is authoritative for what the model should paint.
 *
 * Accessory subtypes LEAD the phrase ("nose ring: thin gold hoop") — a bare
 * jewelry name gives the model nothing to place the piece with (face-jewelry
 * plan). Skipped when the text already names the type ("Gold nose ring").
 */
function formatGarment(item: { name: string; description?: string; appearance?: string; subtypeLabel?: string }): string {
  const base = (item.description?.trim() || item.name).trim();
  const type = item.subtypeLabel?.trim();
  const lead = type && !base.toLowerCase().includes(type) ? `${type}: ${base}` : base;
  const detail = item.appearance?.trim();
  return detail ? `${lead} (${detail})` : lead;
}

// ---------------------------------------------------------------------------
// Portrait variants (reference edit)
// ---------------------------------------------------------------------------

/** Ported from the old app's portrait-regen prompt builder (docs/images/pipelines.md §Portrait variants). */
export const PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

export type VariantKind = "pose" | "outfit" | "expression" | "setting";

const VARIANT_FRAMING: Record<VariantKind, string> = {
  pose: "Change the pose",
  outfit: "Change the outfit",
  expression: "Change the facial expression",
  setting: "Change the background and setting",
};

/**
 * `ageAnchor` (apparentAgeAnchor, owner ruling 2026-07-29): without it a variant
 * edit "preserves" the model's own over-read of the reference's age, so every
 * pose-editor generation bakes another step of drift into the portrait line.
 */
export function buildVariantInstruction(kind: VariantKind, instruction: string, ageAnchor?: string): string {
  const change = `${VARIANT_FRAMING[kind]}: ${instruction.trim().replace(/\.+$/, "")}.`;
  const keepOutfit = kind === "outfit" ? "" : "Keep the same outfit as the reference image.";
  return [PORTRAIT_IDENTITY_LOCK, ageAnchor ?? "", change, keepOutfit, "Soft flattering lighting, high quality, no text, no watermark."]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Scene composer (tool model, structured)
// ---------------------------------------------------------------------------

/**
 * The composer's raw structured output. The candidate subject pool is the
 * present-NPC roster only; everything here is re-validated against that
 * roster by resolveScenePlan — names the model invents are dropped, outfits
 * are forced from wardrobe state. No outfit field exists on purpose: the
 * model is never asked about clothing.
 */
export const sceneSpecSchema = z.object({
  focalCharacter: z.string().default(""),
  pose: z.string().default(""),
  activity: z.string().default(""),
  others: z.array(z.object({ name: z.string().default(""), action: z.string().default("") })).default([]),
  setting: z.string().default(""),
  lighting: z.string().default("soft natural light"),
  mood: z.string().default("calm"),
  /**
   * The viewer's own body parts in frame (scene-pov-embodiment.plan.md slice 3) — ids
   * from the viewer-body registry. Lenient: unknown ids and anything proposed when the
   * lane didn't ask for embodiment are clamped away in `resolveScenePlan`, so a confused
   * composer degrades to today's disembodied shot rather than failing the render.
   */
  viewerBody: z.array(z.string()).catch([]).default([]),
  /**
   * Verbatim narration evidence for each `viewerBody` part (anti-eagerness gate,
   * 2026-07-29): the composer must quote the exact words that put the player's part in
   * frame, and `resolveScenePlan` drops any part whose quote doesn't actually appear in
   * the recent narration — the composer proposes, the transcript disposes. An LLM given
   * an optional field uses it far more often than the fiction warrants; a quote it must
   * copy is checkable in code, where an extra "should we?" model call would just be a
   * second coin flip. Lenient like `viewerBody`.
   */
  viewerBodyEvidence: z
    .array(z.object({ part: z.string().default(""), quote: z.string().default("") }))
    .catch([])
    .default([]),
});

export type SceneSpec = z.infer<typeof sceneSpecSchema>;

export function emptySceneSpec(): SceneSpec {
  return sceneSpecSchema.parse({});
}

export interface SceneWornItem {
  name: string;
  visibility: "visible" | "hinted";
  /** Item definition description — primary phrasing for visible garments. */
  description?: string;
  /** Sensory appearance note from the item definition. */
  appearance?: string;
  /** Accessory-type label ("nose ring") — leads the garment phrase (formatGarment). */
  subtypeLabel?: string;
}

/**
 * One NPC co-located with the player at composition time. `wornVisible` must
 * already be occlusion-filtered (resolveWardrobeVisibility) — hidden layers
 * never reach this type, so they can never leak into a prompt.
 */
export interface ScenePresentCharacter {
  name: string;
  /** Species label for non-human casts; "" / omitted for human (speciesLabelPhrase — name only, no appearance description). */
  species?: string;
  activity?: string;
  posture?: string;
  /** Occlusion-filtered wardrobe — the only permitted source of outfit truth. */
  wornVisible: ReadonlyArray<SceneWornItem>;
  /**
   * Free-text outfit that **overrides** the structured `wornVisible` summary when set
   * (character-chat-scenario.plan.md): the character chat has no equippable wardrobe, so it
   * supplies a described outfit directly. Sessions never set this (they have item state).
   */
  outfitDescription?: string;
  /** Compact attribute phrase (characterAppearanceSummary) for textual render descriptions. */
  appearance?: string;
  /**
   * Identity-anchor phrase (identityAnchorSummary) for the identity-locked reference subject:
   * whitelisted identity-critical features (lips, skin tone, eyes, hair) that reinforce the
   * reference image — the render prompt words the reference as authoritative over them.
   */
  identityAnchors?: string;
  /**
   * The apparent-age anchor sentence (apparentAgeAnchor, owner ruling 2026-07-29) —
   * TEXT-authoritative, unlike identityAnchors: Qwen edits over-read an
   * age-ambiguous reference and compound a step older per generation, so the
   * sheet's age must overrule the reference. "" / absent ⇒ no age text.
   */
  ageAnchor?: string;
  /**
   * SFW lower-body shape line (sceneRevealAppearance, `{intimate:false}`): the
   * figure below a waist-up reference portrait — waist/hips/legs/feet, with
   * skin-level detail gated by exposure. Emitted for the identity-locked subject.
   */
  lowerBody?: string;
  /** Visible intimate-anatomy phrase (intimateSceneAppearance), exposure-gated; emitted only on the uncensored route. */
  intimateAppearance?: string;
  /** Per-region coverage (exposedRegions) — drives explicit bare-skin phrasing. */
  exposure?: RegionExposure;
  /**
   * Gate for bare phrasing. Scene-image callers set this when the session's
   * item state is authoritative; with no worn garments, exposedRegions([])
   * should override a clothed reference avatar.
   */
  wardrobeTracked?: boolean;
}

export interface SceneComposerContext {
  /** Every NPC co-located with the player — the entire candidate subject pool. The player is never in this list. */
  present: ReadonlyArray<ScenePresentCharacter>;
  locationName?: string;
  locationDescription?: string;
  ambient?: string;
  /** Cheap lighting context: the session clock's daylight band (dawn/day/dusk/night). */
  timeOfDay?: string;
  sceneSummary?: string;
  /** The last 1–2 turns' narration, oldest first. Budgeted by the prompt builder. */
  recentNarration?: ReadonlyArray<string>;
  /**
   * **Embodied POV** (scene-pov-embodiment.plan.md slice 3): may the viewer's own body
   * enter frame? Set by the **chat lane only** — the session lane keeps the absolute
   * player-is-invisible rule (and its tests), per the plan's lane scope. When false or
   * absent the composer sees the original rules verbatim and `viewerBody` is clamped away,
   * so the session prompt is byte-identical.
   */
  embodiedViewer?: boolean;
  /**
   * The PLAYER's coverage, computed from their worn items (persona-library slice 8). Rides
   * through to the plan, where it gates whether the viewer's anatomy may render. The
   * composer itself never sees it — this is the half of the decision that must not be a
   * judgment call.
   */
  playerExposure?: RegionExposure;
  /** The persona's resolved attributes — the viewer's own body facts (slice 4). */
  playerAttributes?: ReadonlyArray<AttributeValue>;
  /** The persona's profile, for realized-body applicability of those attributes. */
  playerProfile?: CharacterProfile;
  /** The viewer's exposure-gated intimate anatomy (uncensored route only). */
  playerIntimateAppearance?: string;
}

/** The player-absence rules (session lane, and the chat lane before slice 3). */
const COMPOSER_DISEMBODIED_RULES = [
  "The image is rendered from the player's first-person POV — shot through the player's own eyes. The player must NEVER appear in the image — no body, no face, no hands, and never a camera or held object in frame. Never describe the player or their clothing in any field.",
  '- Every pose/activity/action phrase must describe that character ALONE, paintable with no player in frame. Never mention the player or their body — "walking beside the player" or "a hand resting on his arm" cannot be painted. Translate player-directed beats into their solo visual equivalent: eyes or head turned toward the player become "toward the viewer"; touching, leading, or leaning on the player becomes the character\'s own posture and motion (her hand extended slightly, glancing back mid-step); keep the expression and energy, lose the contact. Example: narration "she leads you back toward the gallery, hand on your arm, laughing" → pose "glancing back toward the viewer, mid-laugh", activity "stepping toward the main gallery, heels clicking on the stone floor".',
] as const;

/**
 * The **embodied** rules (chat lane, slice 3) — the exact inversion of the two above.
 * Contact beats stop being translated away and become a `viewerBody` part PLUS the
 * character's half of the contact, which is the whole point: the fiction constantly puts
 * the player's hands on someone and the image could never show it.
 *
 * `viewerBody` is deliberately a **short closed list** the composer picks from, not prose:
 * the phrasing that stops a limb becoming a third person lives in the registry
 * (`contracts/images/viewer-body.ts`), not in whatever the model felt like writing.
 * **Genitals are absent from its vocabulary on purpose** — this composer runs on the
 * moderation-prone tool model with `allowIntimate: false`, so intimate anatomy is derived
 * at render assembly instead, exactly as `intimateSceneAppearance` always has been.
 */
const COMPOSER_EMBODIED_RULES = [
  "The image is rendered from the player's first-person POV — shot through their own eyes, so their face and head are NEVER in frame. Their own hands, arms, lap or legs MAY enter the foreground when the scene actually puts them there — that is what `viewerBody` is for. Never describe the player's clothing, and never place the player as a person standing in the scene.",
  '- viewerBody: which of the player\'s OWN body parts are in the shot, as a list of ids from exactly: "hands", "forearms", "lap_thighs", "legs_feet", "torso". Empty is the default and the common case — list a part ONLY when the recent narration puts it in the frame (her cheek against their palm → ["hands"]; her head resting in their lap → ["lap_thighs"]). Never list a part merely because the player has one, and never more than the beat needs. For EVERY id listed, add one viewerBodyEvidence entry: { "part": the id, "quote": a short phrase copied EXACTLY, word for word, from the recent narration that physically puts that part of the player in the shot }. A part whose quote is missing, paraphrased, or invented is dropped in code — if you cannot copy a real phrase, leave both lists empty.',
  '- pose/activity may now name contact with the player, but ALWAYS from the character\'s side and only for a part you listed in viewerBody: "her hand closing over the viewer\'s forearm" is paintable when forearms is listed. Call them "the viewer", never "the player" and never "him"/"her". With viewerBody empty, translate contact away as before: eyes or head turned toward the player become "toward the viewer"; touching or leading becomes the character\'s own posture and motion (her hand extended, glancing back mid-step) — keep the expression and energy, lose the contact.',
] as const;

const composerRules = (embodied: boolean): readonly string[] => {
  const [framing, contact] = embodied ? COMPOSER_EMBODIED_RULES : COMPOSER_DISEMBODIED_RULES;
  return [
    "You compose the visual spec for a scene image from roleplay session state.",
    framing,
    "Fill every field of the requested object. Rules:",
    '- focalCharacter: exactly ONE name from the "Present characters" list — whoever the recent narration centers on. If the list is empty, leave it empty: a location-only shot is a valid image.',
    '- others: any remaining names from the "Present characters" list that belong in frame, each with a short phrase for what they are doing. Never include the player or anyone not on the list — characters who are not in the room must not appear.',
    "- pose and activity: what the focal character is doing right now, from the recent narration and their recorded activity. Pose is the body — stance, orientation, expression — in one compact phrase; activity is what they are doing in the scene. The two must not repeat each other's beats: state a facial expression ONCE, in pose (never a smile in pose and a laugh in activity — pick the single strongest beat).",
    '- Body parts in any phrase must be possessively bound to their owner: "her hand raising the cup", "Mira\'s fingers on the railing" — never a bare "a hand", "one hand" or "one finger". In a first-person POV image an unowned limb reads as the player\'s.',
    contact,
    '- Wardrobe: each character\'s "visible wardrobe" line is the authoritative outfit state; never infer clothing from the narration — prose lies.',
    "- setting: the current location's appearance and atmosphere as seen from where the player stands.",
    "- lighting and mood: match the time of day and the emotional tone of the recent narration.",
    '- NEVER describe skin colour or reddening in any field — no "flushed", "blushing", "rosy", "red-faced", "colour rising". An image model paints those as makeup, not feeling. State the same beat as physiology instead: eyes bright or heavy-lidded, lips parted, breath shallow, a sheen of sweat, damp hairline, loosened posture. The narration you are given WILL say "flushed" — translate it, never copy it.',
    "- Keep each field to one or two short sentences.",
  ];
};

/**
 * The composer's system prompt. `embodied` opts into the viewer's-own-body rules — the
 * **chat lane only** (scene-pov-embodiment.plan.md §Lane scope).
 */
export function sceneComposerSystem(embodied = false): string {
  return composerRules(embodied).join("\n");
}

/** The disembodied system prompt — the session lane's, and every pre-slice-3 snapshot's. */
export const SCENE_COMPOSER_SYSTEM = sceneComposerSystem(false);

/** Recent-narration budget: the newest turn gets the larger excerpt. */
export const RECENT_NARRATION_TURNS = 2;
export const RECENT_NARRATION_LATEST_CHARS = 800;
export const RECENT_NARRATION_PRIOR_CHARS = 400;

export function buildSceneComposerPrompt(context: SceneComposerContext): string {
  const lines: string[] = ["Camera: first-person, through the player's eyes. The player is never visible."];
  if (context.locationName) lines.push(`Location: ${context.locationName}`);
  if (context.locationDescription) lines.push(`Location description: ${excerpt(context.locationDescription, 400)}`);
  if (context.ambient) lines.push(`Ambient: ${context.ambient}`);
  if (context.timeOfDay) lines.push(`Time of day: ${context.timeOfDay}`);
  if (context.present.length === 0) {
    lines.push("Present characters: none — compose a location-only shot.");
  } else {
    lines.push("Present characters (the only people allowed in the image):");
    for (const c of context.present) {
      const exposed = formatExposure(c.exposure, c.wardrobeTracked);
      const bits = [
        c.species ? `species: ${c.species}` : "",
        c.activity ? `activity: ${c.activity}` : "",
        c.posture ? `posture: ${c.posture}` : "",
        `visible wardrobe (authoritative): ${wardrobeLines(c.wornVisible)}`,
        exposed ? `exposed: ${exposed}` : "",
      ].filter(Boolean);
      lines.push(`- ${c.name} — ${bits.join("; ")}`);
    }
  }
  if (context.sceneSummary) lines.push(`Scene summary: ${excerpt(context.sceneSummary, 400)}`);
  const recent = (context.recentNarration ?? []).filter((n) => n.trim()).slice(-RECENT_NARRATION_TURNS);
  if (recent.length > 0) {
    lines.push("Recent narration (oldest first):");
    recent.forEach((narration, index) => {
      const budget = index === recent.length - 1 ? RECENT_NARRATION_LATEST_CHARS : RECENT_NARRATION_PRIOR_CHARS;
      lines.push(excerpt(narration, budget));
    });
  }
  return lines.join("\n");
}

function wardrobeLines(worn: ReadonlyArray<SceneWornItem>): string {
  if (worn.length === 0) return "none recorded";
  return worn
    .map((w) => (w.visibility === "hinted" ? `${w.name} (hinted beneath sheer layers)` : formatGarment(w)))
    .join("; ");
}

/** Deterministic outfit phrase from wardrobe state — overrides model prose. */
export function wardrobeOutfitSummary(worn: ReadonlyArray<SceneWornItem>): string {
  const visible = worn.filter((w) => w.visibility === "visible").map(formatGarment);
  const hinted = worn.filter((w) => w.visibility === "hinted").map((w) => w.name);
  const parts: string[] = [];
  if (visible.length > 0) parts.push(visible.join(", "));
  if (hinted.length > 0) parts.push(`hints of ${hinted.join(", ")} beneath`);
  return parts.join("; ");
}

/**
 * Explicit bare-skin phrasing for the uncovered regions an image model would
 * otherwise paint clothed (docs/images/pipelines.md §Scene images). Gated on
 * `wardrobeTracked`: callers set this only when wardrobe state is authoritative.
 * Region scope is torso + lower body + feet; head/hands are omitted because
 * bare there is the universal default and would fire on every clothed subject.
 * `legs` is stated only when the pelvis is covered — a bare pelvis already
 * implies it. Returns "" when nothing is exposed (or the gate is off).
 */
export function formatExposure(exposure?: RegionExposure, wardrobeTracked?: boolean): string {
  if (!exposure || !wardrobeTracked) return "";
  const fullyNude = exposure.torso === "bare" && exposure.pelvis === "bare" && exposure.legs === "bare";
  const parts: string[] = [];
  if (fullyNude) {
    parts.push("fully nude, no clothing");
  } else {
    if (exposure.torso === "bare") parts.push("topless, bare chest");
    else if (exposure.torso === "sheer") parts.push("wearing only a sheer top, skin visible through it");
    if (exposure.pelvis === "bare") parts.push("bare below the waist, no underwear or bottoms");
    else if (exposure.pelvis === "sheer") parts.push("only sheer fabric below the waist");
    if (exposure.pelvis !== "bare" && exposure.legs === "bare") parts.push("bare legs");
  }
  if (!fullyNude && exposure.feet === "bare") parts.push("barefoot");
  return parts.join("; ");
}

const APPEARANCE_SUMMARY_CHARS = 200;

/**
 * Compact appearance phrase from resolved attribute values (registry labels,
 * unknown ids skipped) — describes a character textually in a render prompt
 * when they are not the identity reference.
 *
 * **Apparent age is omitted here** (it is in `buildAvatarPrompt`'s subject line):
 * scene images lean on the character's portrait avatar as the source of how old
 * they look, so re-stating an apparent-age band in the textual summary only risks
 * fighting the reference image. Apparent age stays a portrait-studio concept.
 */
export function characterAppearanceSummary(
  attributes: ReadonlyArray<AttributeValue>,
  maxChars = APPEARANCE_SUMMARY_CHARS,
  allowIntimate = false,
  profile?: CharacterProfile,
): string {
  const parts: string[] = [];
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  for (const value of attributes) {
    if (value.id === "identity.apparent_age") continue; // portrait-studio-only — scene images use the avatar reference for age
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    if (isNonVisualAttribute(def)) continue; // voice/scent don't render in an image
    if (!allowIntimate && isIntimateAttribute(def)) continue; // scene composer (gemini tool model) is moderation-prone
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}

/**
 * Identity-critical attributes for the reference-anchored render (chat-scene-fidelity.plan.md
 * slice 3): the features an identity-locked edit drifts on ever so slightly — facial identity
 * plus skin and hair. Deliberately a whitelist (a full appearance dump would fight the
 * reference image and blow the prompt budget).
 */
const IDENTITY_ANCHOR_ATTRIBUTE_IDS = [
  "skin.tone",
  "skin.undertone",
  "lips.fullness",
  "lips.shape",
  "eyes.color",
  "eyes.shape",
  "hair.color",
  "hair.length",
  "hair.style",
  "face.shape",
  "face.freckles",
] as const;

/** Char cap on the identity-anchor phrase — it must never crowd the 1500-char render budget. */
const IDENTITY_ANCHOR_CHARS = 180;

/**
 * A compact identity-anchor phrase for the character a reference image identity-locks:
 * whitelist-filtered attribute values ("skin tone: warm brown; lips fullness: full; …")
 * emitted to REINFORCE the reference, never to override it (the render prompt words the
 * reference as authoritative). "" when nothing identity-critical is authored, so the
 * prompt is unchanged for a sparsely-authored character.
 */
export function identityAnchorSummary(
  attributes: ReadonlyArray<AttributeValue>,
  profile?: CharacterProfile,
): string {
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const byId = new Map(attributes.map((v) => [v.id, v]));
  const parts: string[] = [];
  for (const id of IDENTITY_ANCHOR_ATTRIBUTE_IDS) {
    const value = byId.get(id);
    if (!value) continue;
    const def = attributeRegistry.byId(id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), IDENTITY_ANCHOR_CHARS);
}

/**
 * The image lane's apparent-age vocabulary (owner ruling 2026-07-29) — the ONLY
 * age words an image prompt may carry. Two rules, both safety-shaped:
 *
 * 1. **The floor is an explicit adult.** The registry's minor bands (infant…teen)
 *    are narrator/world vocabulary and are deliberately ABSENT here — "teen" could
 *    read 15–17, and no such word may ever reach an image model. A minor-band or
 *    unknown value produces NO age text at all (the pre-ruling behavior), never a
 *    younger word. `eighteen` states the number outright.
 * 2. **The ceiling problem is drift, not text** (the Kristin aging report): Qwen
 *    edits re-synthesize skin with a texture-amplifying prior and "preserve
 *    apparent age" preserves the model's own over-estimate of an age-ambiguous
 *    reference, compounding a step older per edit generation. The anchor sentence
 *    is what pulls it back — A/B'd at ~15–20 apparent years on the reporting
 *    chat's avatar (phantom-limb-ab.ts, age variant).
 */
const IMAGE_AGE_PHRASES: Record<string, string> = {
  eighteen: "exactly eighteen years old, an adult",
  young_adult: "a young adult in {pos} early twenties",
  mid_twenties: "in {pos} mid-twenties",
  late_twenties: "in {pos} late twenties",
  early_thirties: "in {pos} early thirties",
  late_thirties: "in {pos} late thirties",
  forties: "in {pos} forties",
  fifties: "in {pos} fifties",
  sixties_plus: "in {pos} sixties or beyond",
};

/** Bands whose anchor also claims youthful skin — only when the sheet authors `skin.texture: smooth`. */
const YOUTHFUL_SKIN_BANDS = new Set(["eighteen", "young_adult", "mid_twenties", "late_twenties", "early_thirties"]);

/** Subject/possessive pronouns from the identity.gender value; they/their for anything unstated. */
function agePronouns(gender: string | undefined): { subject: string; possessive: string } {
  if (gender === "female" || gender?.endsWith("_born_female")) return { subject: "she", possessive: "her" };
  if (gender === "male" || gender?.endsWith("_born_male")) return { subject: "he", possessive: "his" };
  return { subject: "they", possessive: "their" };
}

/**
 * The avatar subject-descriptor's age word, floored to the image vocabulary:
 * "eighteen-year-old" for the explicit floor, the registry label for older adult
 * bands, and **undefined for minor/unknown bands** — `buildAvatarPrompt` then
 * simply omits age from the subject line rather than ever emitting a sub-adult word.
 */
export function imageAgeWord(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "eighteen") return "eighteen-year-old";
  if (!(value in IMAGE_AGE_PHRASES)) return undefined;
  const def = attributeRegistry.byId("identity.apparent_age");
  return (def && formatAttributeValue(def, value)) || undefined;
}

/**
 * The identity-locked routes' age anchor (owner ruling 2026-07-29, reversing
 * "scenes omit apparent age"): one name-bound sentence stating the sheet's
 * apparent age — "Kristin is in her late twenties; her skin, hands and legs read
 * smooth and youthful." Worded TEXT-authoritative (unlike the identity anchors,
 * where the reference wins): the reference's apparent age is exactly the thing
 * the edit model mis-reads, so here the text must overrule it. "" for minor-band
 * or unstated ages (see IMAGE_AGE_PHRASES — no age text beats a wrong word).
 * The youthful-skin clause rides only young bands whose sheet says smooth skin.
 */
export function apparentAgeAnchor(name: string, attributes: ReadonlyArray<AttributeValue>): string {
  const byId = new Map(attributes.map((v) => [v.id, v.value]));
  const band = byId.get("identity.apparent_age");
  if (typeof band !== "string") return "";
  const phrase = IMAGE_AGE_PHRASES[band];
  if (!phrase) return "";
  const { possessive } = agePronouns(typeof byId.get("identity.gender") === "string" ? (byId.get("identity.gender") as string) : undefined);
  const subject = name.trim() || "The subject";
  const youthful = YOUTHFUL_SKIN_BANDS.has(band) && byId.get("skin.texture") === "smooth";
  const tail = youthful ? `; ${possessive} skin, hands and legs read smooth and youthful` : "";
  return `${subject} is ${phrase.replaceAll("{pos}", possessive)}${tail}.`;
}

/** Budget for the viewer's body line — it competes with everything else for the 1500. */
const VIEWER_BODY_CHARS = 200;

/**
 * The viewer's own body facts (scene-pov-embodiment.plan.md slice 4) — **only for the parts
 * actually in frame**, so a shot of their hands on her cheek doesn't state their leg hair.
 *
 * Without this the viewer's arms change colour between shots, which reads as a different
 * person reaching in — so `skin.tone`/`build.frame` ride any embodied shot
 * (`VIEWER_SKIN_ATTRIBUTE_IDS`) and each part contributes its own descriptors on top.
 * Attribute applicability is checked against the persona's realized body, exactly like every
 * other prompt builder here, so a stale attribute can't leak.
 *
 * Intimate anatomy is deliberately NOT here: it rides `sceneRevealAppearance(…, {intimate})`
 * on the uncensored route only, the same seam the character's has always used.
 */
export function viewerBodyAppearance(
  attributes: ReadonlyArray<AttributeValue>,
  parts: ReadonlyArray<ViewerBodyPart>,
  profile?: CharacterProfile,
): string {
  if (parts.length === 0) return "";
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const byId = new Map(attributes.map((v) => [v.id, v]));
  const wanted = [...VIEWER_SKIN_ATTRIBUTE_IDS, ...parts.flatMap((p) => p.attributeIds)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawId of wanted) {
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    // The registry's id type is a `<category>.<name>` template union; the registry entries
    // hold plain strings. Both lookups below tolerate a miss, which IS the "unknown ids are
    // ignored" contract — and a test asserts every listed id is real, so a typo fails loudly
    // in CI rather than silently describing nothing.
    const id = rawId as AttributeValue["id"];
    const value = byId.get(id);
    if (!value) continue;
    const def = attributeRegistry.byId(id);
    if (!def || def.excludeFromPrompts) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) out.push(formatted);
  }
  return excerpt(out.join("; "), VIEWER_BODY_CHARS);
}

/**
 * Which exposure region uncovers each intimate attribute category. An intimate
 * category with NO entry here never renders in an image (axis undefined ⇒
 * `intimateAttrRendersExposed` returns false) — this is deliberate for the
 * universal `anus` / `perineum` categories: image inclusion is a PLACEHOLDER
 * pending image-prompt re-evaluation (owner ruling 2026-07-23). Every render
 * today views the character from the front, where anal/perineal detail can't
 * show and would only confuse the model, so those categories stay omitted (they
 * remain fully exposure-gated for chat/prose). Add `anus`/`perineum → "pelvis"`
 * when rear/exposure framing lands.
 */
const INTIMATE_CATEGORY_EXPOSURE: Record<string, keyof RegionExposure> = {
  breasts: "torso",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
};

/**
 * Whether an intimate-anatomy attribute should surface in an IMAGE prompt: its
 * region must read exposed (bare/sheer, not covered by a garment) and sensory
 * scent/taste attributes never render visually. Shared by the avatar prompt
 * (`buildAvatarPrompt`) and the scene render's intimate phrase
 * (`intimateSceneAppearance`) so the two image paths gate intimate anatomy by
 * the SAME rule — they diverged once (the avatar path skipped this entirely;
 * see docs/images/pipelines.md §Avatar generation).
 */
function intimateAttrRendersExposed(def: AttributeDefinition, exposure: RegionExposure): boolean {
  if (def.kind === "sensory") return false; // scent/taste don't render in an image
  const axis = INTIMATE_CATEGORY_EXPOSURE[def.category];
  return axis !== undefined && exposure[axis] !== "covered";
}

/**
 * Visible intimate-anatomy phrase for a scene render, gated by **exposure**:
 * a region's descriptive attributes are included only when that region reads
 * `bare`/`sheer` (not `covered`). Sensory attributes (scent/taste) are skipped —
 * they don't render. This is carried in the plan and emitted into the final
 * render prompt only on the uncensored route (body-model spec Decision 3; the
 * scene composer itself, a moderation-prone text model, never sees it).
 */
export function intimateSceneAppearance(
  attributes: ReadonlyArray<AttributeValue>,
  exposure?: RegionExposure,
  maxChars = APPEARANCE_SUMMARY_CHARS,
): string {
  if (!exposure) return "";
  const parts: string[] = [];
  for (const value of attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def || !isIntimateAttribute(def)) continue;
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (!intimateAttrRendersExposed(def, exposure)) continue; // only an exposed, visual region surfaces
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}

/** Non-intimate body regions a waist-up portrait can't show — the scene subject's "shape" line draws from these. */
const LOWER_BODY_CATEGORIES: ReadonlySet<string> = new Set(["waist", "hips", "legs", "feet"]);

/**
 * Which exposure axis uncovers a `skin`-tier attribute, keyed by category. A
 * superset of INTIMATE_CATEGORY_EXPOSURE that also covers the everyday lower
 * body (legs/feet), so the same exposure state drives both the intimate and
 * the SFW reveal lines.
 */
const REVEAL_EXPOSURE_REGION: Record<string, keyof RegionExposure> = {
  chest: "torso",
  breasts: "torso",
  hips: "pelvis",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
  legs: "legs",
  feet: "feet",
};

/**
 * Whether a `imageReveal`-tagged attribute surfaces in a scene render given the
 * coverage state: `shape` reads through clothing (always), `skin` only when its
 * region is uncovered. Untagged intimate attributes keep the existing
 * exposure-only rule (`intimateAttrRendersExposed`); untagged non-intimate
 * attributes are not part of the reveal line at all.
 */
function revealSurfaces(def: AttributeDefinition, exposure: RegionExposure, intimate: boolean): boolean {
  if (def.kind === "sensory") return false; // scent/taste never render visually
  if (def.imageReveal === "shape") return true;
  if (def.imageReveal === "skin") {
    const axis = REVEAL_EXPOSURE_REGION[def.category];
    return axis !== undefined && exposure[axis] !== "covered";
  }
  return intimate ? intimateAttrRendersExposed(def, exposure) : false;
}

/**
 * The identity-locked scene subject's body description, split by sensitivity so
 * the caller can route each half (docs/images/pipelines.md §Scene images): the reference
 * image is a waist-up portrait, so it conveys the face and upper body but
 * underspecifies the figure. This supplements it from `imageReveal`-tagged
 * attributes — `shape` (silhouette: breast size, waist, hips, leg build) always,
 * `skin` (nipples, leg hair, toenails) only when the region is bare/sheer.
 *
 * - `{ intimate: false }` → the SFW lower-body line (waist/hips/legs/feet),
 *   emitted on every route.
 * - `{ intimate: true }` → exposed/silhouette intimate anatomy, emitted only on
 *   the uncensored route (it folds in untagged intimate attrs by the existing
 *   exposure rule, so vulva/penis detail is never lost).
 */
export function sceneRevealAppearance(
  attributes: ReadonlyArray<AttributeValue>,
  exposure: RegionExposure | undefined,
  profile: CharacterProfile | undefined,
  opts: { intimate: boolean },
  maxChars = APPEARANCE_SUMMARY_CHARS,
): string {
  if (!exposure) return "";
  const realizedBody = profile ? realizedBodyForProfile(profile) : undefined;
  const parts: string[] = [];
  for (const value of attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    const intimate = isIntimateAttribute(def);
    if (intimate !== opts.intimate) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    // The SFW half describes only the lower body — the portrait already covers
    // the face/upper body, so re-stating it wastes the (tight) prompt budget.
    if (!intimate && !LOWER_BODY_CATEGORIES.has(def.category)) continue;
    if (!revealSurfaces(def, exposure, intimate)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}

// ---------------------------------------------------------------------------
// Resolved render plan (composer output × present roster × wardrobe state)
// ---------------------------------------------------------------------------

export interface SceneCharacterSpec {
  name: string;
  /** Species phrase (label + any authored lore) for non-human casts; "" for human. */
  species?: string;
  /** What they are doing in frame. */
  action: string;
  /** Deterministic occlusion-filtered outfit phrase, forced from wardrobe state. */
  outfitSummary: string;
  /** Compact appearance phrase for textual description. */
  appearance: string;
  /** Identity-anchor phrase for the identity-locked subject — reinforces the reference image. */
  identityAnchors?: string;
  /** Apparent-age anchor sentence — TEXT-authoritative over the reference (owner ruling 2026-07-29). */
  ageAnchor?: string;
  /** SFW lower-body shape line for the identity-locked subject (the waist-up portrait's blind spot). */
  lowerBody?: string;
  /** Explicit bare-region phrase ("topless, bare chest; barefoot"), forced from coverage state; "" when fully covered or untracked. */
  exposure?: string;
  /** Visible intimate-anatomy phrase for exposed regions; emitted only on the uncensored render route. */
  intimateAppearance?: string;
}

export interface SceneRenderPlan {
  /** The focal character, resolved against the present roster; null ⇒ location-only shot. */
  focal: SceneCharacterSpec | null;
  /** Other present characters featured in the shot — never anyone absent. */
  others: SceneCharacterSpec[];
  setting: string;
  lighting: string;
  mood: string;
  /**
   * The viewer's own parts in frame — registry-validated, but NOT yet gated on coverage or
   * the route. That last filter runs per-prompt in `buildSceneRenderPrompt`, because
   * `allowIntimate` differs per provider rung (the uncensored edit allows intimate detail;
   * the text-to-image fallback does not), exactly like `intimateAppearance`.
   */
  viewerBody: ViewerBodyPartId[];
  /**
   * The PLAYER's coverage, computed from their worn items — the other half of that gate.
   * Absent ⇒ treated as covered, so anatomy stays shut (the default-shut rule).
   */
  playerExposure?: RegionExposure;
  /**
   * The persona's resolved attributes (slice 4) — the viewer's own body facts, filtered to
   * the parts in frame at render time by `viewerBodyAppearance`. Without them the viewer's
   * arms change colour between shots and read as a different person reaching in.
   */
  playerAttributes?: ReadonlyArray<AttributeValue>;
  /** The persona's profile — realized-body applicability for those attributes. */
  playerProfile?: CharacterProfile;
  /** The viewer's exposure-gated intimate anatomy; emitted only on an uncensored route. */
  playerIntimateAppearance?: string;
}

export function emptySceneRenderPlan(): SceneRenderPlan {
  return { focal: null, others: [], setting: "", lighting: "soft natural light", mood: "calm", viewerBody: [] };
}

const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * Deterministic backstop for player references in composer pose/activity/action text
 * (owner report 2026-07-10): the composer is instructed to translate player-directed
 * beats into solo equivalents, but a slip hands the render an unpaintable instruction
 * ("walking beside the player, a hand on his arm") that fights the POV rule. Gaze-type
 * references rewrite to the viewer ("head turned toward the player" → "toward the
 * viewer" — exactly right for a POV shot); any clause still naming the player is
 * dropped whole. Pronoun references ("his arm") are deliberately NOT scrubbed — in a
 * multi-character scene a pronoun may be another character; that case belongs to the
 * composer rule, not a regex.
 */
export function scrubPlayerFromAction(action: string, opts: { embodied?: boolean } = {}): string {
  if (!/\bplayer\b/i.test(action)) return action;
  // Gaze/orientation toward the player = toward the camera. Possessives ("at the
  // player's side") are proximity, not gaze — they fall through to the clause drop.
  const rewritten = action.replace(/\b(facing|toward|towards|at)\s+the\s+player\b(?!['’]s)/gi, "$1 the viewer");
  if (opts.embodied) {
    // With the viewer's body in frame (scene-pov-embodiment slice 3), contact is paintable
    // — so a clause naming the player is REWRITTEN to the viewer rather than dropped. The
    // composer is told to say "the viewer" already; this catches the slips, and the render
    // gate still decides whether the part it refers to is actually in frame.
    return rewritten.replace(/\bthe\s+player\b/gi, "the viewer");
  }
  return rewritten
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !/\bplayer\b/i.test(clause))
    .join(", ");
}

/**
 * Skin-colour words an image model paints as COSMETICS, not physiology
 * (scene-pov-embodiment.plan.md slice 0, owner report): "flushed"/"blushing" comes
 * back as stage blusher — a clown-makeup face. Deliberately the state-language
 * family only; `skin.undertone: rosy` is an *authored identity attribute* and is
 * never scrubbed (the registry is the author's intent, not the composer's slip).
 */
const BLUSH_WORDS = /\b(blush\w*|flush\w*|rosy|ruddy|reddening|red-faced|pink-cheeked)\b/i;

/**
 * Deterministic backstop for skin-colour words in composer-authored text (pose,
 * activity, mood). `SCENE_COMPOSER_SYSTEM` also rules against them, but the rule
 * alone is not trustworthy — the narrator's own arousal hint says "flushed skin"
 * (contracts/meters/registry.ts), so the composer reads it in the recent narration
 * and hands it straight back. Same shape as {@link scrubPlayerFromAction}: drop the
 * offending clause whole and keep the rest, since the surrounding beats ("eyes
 * bright", "breath shallow") are the physiology we actually wanted. The
 * deterministic sibling is `visualStateNote` (images/character-scene.ts) — keep the
 * two in agreement.
 */
export function scrubBlush(text: string): string {
  if (!BLUSH_WORDS.test(text)) return text;
  return text
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !BLUSH_WORDS.test(clause))
    .join(", ");
}

// The trailing lookahead skips possessive idioms ("an arm's length") and compounds ("a hand-carved rail").
const BARE_LIMB = /\b(?:a|an|one)\s+(hand|arm|leg|foot|finger|thumb|palm|wrist|knee|elbow)\b(?!['’-])/gi;
const BOTH_LIMBS = /\bboth\s+(hands|arms|legs|feet|knees|elbows)\b/gi;

/**
 * Possessively bind bare limb references to their owner: "one hand holding a cup" →
 * "Kristin's hand holding a cup" (phantom-limb fix, 2026-07-29). In a first-person
 * POV prompt an unowned limb noun is an invitation to paint it as the VIEWER's
 * foreground hand — the composer is ruled to write "her hand", and this is the
 * deterministic backstop for what slips through (same belt-and-braces as
 * {@link scrubBlush}). Deliberately conservative: only bare-article ("a/an/one")
 * and "both" limb phrases rewrite; already-possessive phrases ("her hand",
 * "the viewer's forearm") and possessive limb idioms ("an arm's length") pass
 * untouched.
 */
export function bindLimbsToOwner(text: string, owner: string): string {
  const name = owner.trim();
  if (!name) return text;
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return text
    .replace(BARE_LIMB, (_m, limb: string) => `${possessive} ${limb.toLowerCase()}`)
    .replace(BOTH_LIMBS, (_m, limbs: string) => `both of ${possessive} ${limbs.toLowerCase()}`);
}

/**
 * Deterministic focal pick (demo mode / clamp fallback): the present NPC
 * mentioned latest in the newest narration, else the first roster entry,
 * else "" (empty room — location-only shot).
 */
export function heuristicFocalName(
  present: ReadonlyArray<ScenePresentCharacter>,
  recentNarration: ReadonlyArray<string>,
): string {
  if (present.length === 0) return "";
  const newest = (recentNarration.at(-1) ?? "").toLowerCase();
  let best: { name: string; at: number } | null = null;
  for (const c of present) {
    const at = newest.lastIndexOf(c.name.toLowerCase());
    if (at >= 0 && (best === null || at > best.at)) best = { name: c.name, at };
  }
  return best?.name ?? present[0]?.name ?? "";
}

/**
 * Clamp the composer's spec to the present roster and force every outfit from
 * wardrobe state (docs/images/pipelines.md §Scene images): a focal name not in the room
 * is replaced by the heuristic pick (warn diagnostic), absent "others" are
 * dropped (warn diagnostic), and no character the composer invents can ever
 * reach a render prompt. With a non-empty roster the plan always has a focal.
 */
export function resolveScenePlan(
  spec: SceneSpec,
  context: SceneComposerContext,
  sink?: DiagnosticSink,
): SceneRenderPlan {
  const roster = context.present;
  const byName = new Map(roster.map((c) => [normalizeName(c.name), c]));

  let focalEntry = byName.get(normalizeName(spec.focalCharacter)) ?? null;
  if (!focalEntry && roster.length > 0) {
    if (spec.focalCharacter.trim()) {
      sink?.push(
        diag("warn", "images.scene_composer.focal_clamped", "composer picked a focal character not in the room — replaced with a present NPC", {
          context: { picked: spec.focalCharacter, roster: roster.map((c) => c.name) },
        }),
      );
    }
    const fallbackName = heuristicFocalName(roster, context.recentNarration ?? []);
    focalEntry = byName.get(normalizeName(fallbackName)) ?? roster[0] ?? null;
  }

  const viewerBody = resolveViewerBody(spec, context, sink);
  // Trailing periods stripped before the join — "…teasing smile.; Leading…" read as two
  // stitched sentences in the render prompt instead of one pose phrase.
  const focalAction = [spec.pose, spec.activity]
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .join("; ");
  // The scrub only rewrites (rather than drops) player references when the viewer actually
  // has a body in frame — otherwise "her hand on the viewer's arm" would ask for an arm the
  // shot doesn't contain.
  const embodied = Boolean(context.embodiedViewer) && viewerBody.length > 0;
  const focal = focalEntry ? characterSpec(focalEntry, focalAction, embodied) : null;
  const seen = new Set(focalEntry ? [normalizeName(focalEntry.name)] : []);
  const others: SceneCharacterSpec[] = [];
  for (const other of spec.others) {
    const entry = byName.get(normalizeName(other.name));
    if (!entry) {
      if (other.name.trim()) {
        sink?.push(
          diag("warn", "images.scene_composer.absent_character_dropped", "composer featured a character not in the room — dropped", {
            context: { picked: other.name, roster: roster.map((c) => c.name) },
          }),
        );
      }
      continue;
    }
    if (seen.has(normalizeName(entry.name))) continue;
    seen.add(normalizeName(entry.name));
    others.push(characterSpec(entry, other.action, embodied));
  }

  return {
    focal,
    others,
    viewerBody,
    ...(context.playerExposure ? { playerExposure: context.playerExposure } : {}),
    ...(context.playerAttributes ? { playerAttributes: context.playerAttributes } : {}),
    ...(context.playerProfile ? { playerProfile: context.playerProfile } : {}),
    ...(context.playerIntimateAppearance ? { playerIntimateAppearance: context.playerIntimateAppearance } : {}),
    setting:
      spec.setting.trim() ||
      [context.locationName, context.locationDescription].filter(Boolean).join(" — ").slice(0, 300),
    lighting: spec.lighting,
    // Mood is the composer's other free-text field that reaches the render prompt
    // verbatim ("flushed, intimate") — scrubbed like pose/activity. Lighting is about
    // light, not skin, so it is left alone.
    mood: scrubBlush(spec.mood),
  };
}

/**
 * Clamp the composer's `viewerBody` proposal to the registry — the same
 * the-composer-cannot-invent-things rule as `focal_clamped` / `absent_character_dropped`
 * — then require **narration evidence** for every survivor (2026-07-29): a part stays
 * only when its `viewerBodyEvidence` quote actually appears, verbatim, in the recent
 * narration. This is the anti-eagerness gate — the deterministic alternative to a
 * second "should the player's body appear?" model call, which would carry the same
 * option-bias as the first.
 *
 * Ways to end up with nothing: the lane never asked for embodiment (the session lane —
 * it gets the disembodied rules, so a proposal here means the model ignored them), the
 * id isn't in the registry (both WARN — off-script), or the quote doesn't match the
 * transcript (INFO — the gate doing its designed job on composer eagerness).
 * Coverage and route gating do NOT happen here — they run per-prompt, where `allowIntimate`
 * is known.
 */
function resolveViewerBody(
  spec: Pick<SceneSpec, "viewerBody" | "viewerBodyEvidence">,
  context: SceneComposerContext,
  sink?: DiagnosticSink,
): ViewerBodyPartId[] {
  const proposed = spec.viewerBody;
  if (proposed.length === 0) return [];
  if (!context.embodiedViewer) {
    sink?.push(
      diag("warn", "images.scene_composer.viewer_body_unrequested", "composer proposed viewer body parts in a lane that did not ask for them — dropped", {
        context: { proposed: [...proposed] },
      }),
    );
    return [];
  }
  const kept: ViewerBodyPartId[] = [];
  const dropped: string[] = [];
  for (const id of proposed) {
    const part = viewerBodyPartById(id.trim());
    // The composer has no intimate vocabulary by design (it runs allowIntimate:false), so
    // proposing one is off-script even though the render gate would have caught it too.
    if (!part || part.intimate) dropped.push(id);
    else if (!kept.includes(part.id)) kept.push(part.id);
  }
  if (dropped.length > 0) {
    sink?.push(
      diag("warn", "images.scene_composer.viewer_body_dropped", "composer proposed viewer body parts outside its vocabulary — dropped", {
        context: { dropped, kept },
      }),
    );
  }
  return groundViewerBody(kept, spec.viewerBodyEvidence, context.recentNarration ?? [], sink);
}

/** A quote shorter than this (normalized) proves nothing — "his hand" matches half of any transcript. */
const VIEWER_EVIDENCE_MIN_CHARS = 12;

/** Keep only the parts whose evidence quote is a verbatim (normalized) substring of the recent narration. */
function groundViewerBody(
  parts: readonly ViewerBodyPartId[],
  evidence: ReadonlyArray<{ part: string; quote: string }>,
  recentNarration: readonly string[],
  sink?: DiagnosticSink,
): ViewerBodyPartId[] {
  if (parts.length === 0) return [];
  const transcript = normalizeEvidence(recentNarration.join("\n"));
  const quoteByPart = new Map<string, string>();
  for (const entry of evidence) quoteByPart.set(entry.part.trim().toLowerCase(), entry.quote);
  const grounded: ViewerBodyPartId[] = [];
  const ungrounded: string[] = [];
  for (const id of parts) {
    const quote = normalizeEvidence(quoteByPart.get(id) ?? "");
    if (quote.length >= VIEWER_EVIDENCE_MIN_CHARS && transcript.includes(quote)) grounded.push(id);
    else ungrounded.push(id);
  }
  if (ungrounded.length > 0) {
    sink?.push(
      diag("info", "images.scene_composer.viewer_body_ungrounded", "viewer body parts without a verbatim narration quote — dropped (anti-eagerness gate)", {
        context: { ungrounded, grounded },
      }),
    );
  }
  return grounded;
}

/** Normalization for the evidence substring check: case, whitespace, curly quotes, ellipses. */
function normalizeEvidence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function characterSpec(entry: ScenePresentCharacter, action: string, embodied = false): SceneCharacterSpec {
  return {
    name: entry.name,
    ...(entry.species ? { species: entry.species } : {}),
    // The player scrub covers the composer's text AND the posture/activity fallback
    // (session state can carry player-referencing activity phrases too); the blush
    // scrub strips skin-colour words out of whatever survived, and the limb binder
    // then possessively binds any bare "a hand"/"one foot" to this character so the
    // image model can't compose it as the viewer's foreground limb.
    action: bindLimbsToOwner(
      scrubBlush(
        scrubPlayerFromAction(action.trim() || [entry.posture, entry.activity].filter(Boolean).join("; "), { embodied }),
      ),
      entry.name,
    ),
    // Forced from occlusion-filtered state regardless of anything the model said; a free-text
    // override (character chat — no equippable wardrobe) wins when present.
    outfitSummary: entry.outfitDescription ?? wardrobeOutfitSummary(entry.wornVisible),
    appearance: entry.appearance ?? "",
    ...(entry.identityAnchors ? { identityAnchors: entry.identityAnchors } : {}),
    ...(entry.ageAnchor ? { ageAnchor: entry.ageAnchor } : {}),
    ...(entry.lowerBody ? { lowerBody: entry.lowerBody } : {}),
    exposure: formatExposure(entry.exposure, entry.wardrobeTracked),
    intimateAppearance: entry.intimateAppearance ?? "",
  };
}

// ---------------------------------------------------------------------------
// Scene render prompt (final image instruction)
// ---------------------------------------------------------------------------

/** The hard POV opening of every scene render prompt (limb-noun-free form, 2026-07-29). */
// The framing must name NO limb, in any polarity. "The player is the camera"
// made image models paint hands gripping a camera; its replacement "no hands or
// held objects in frame" summoned disembodied foreground hands; and the first
// fix attempt — an enumerated possession line, "every hand, arm, leg and foot
// belongs to Mira" — STILL painted a phantom viewer hand (phantom-limb A/B,
// scripts/eval/scene-images/phantom-limb-ab.ts): even a possessively-bound
// enumeration summons what it names. What held up (3/3 clean) is this opening +
// the person-count assertion + an abstract possession clause ("every visible
// body part belongs to Mira") appended by sceneFramingRule — plus the pose
// text's own limbs bound to the character by bindLimbsToOwner.
export const SCENE_POV_RULE =
  "First-person POV through the player's own eyes; the player is never visible in the image.";

/**
 * The shot's framing rule (scene-pov-embodiment.plan.md slice 1) — the disembodied
 * form when the viewer has no body in frame, the **embodied** variant when they do.
 *
 * BOTH forms are built from positives (the "no camera" scar: a negative anchors the
 * model on exactly what it forbids). The disembodied form (2026-07-29, phantom-limb
 * fix) is {@link SCENE_POV_RULE} + the person-count assertion + a total-possession
 * binding — the pose text constantly names the character's hands and feet ("one hand
 * holding a cup", "barefoot"), and without an owner the model composes them as the
 * VIEWER's foreground limbs.
 *
 * The embodied variant's job is to put a limb in frame without the model promoting it into
 * a whole second person. Three things do that work, and none of them is a negative:
 *
 * 1. **Possessive binding** — "the viewer's own", never "a man's". No subject noun for the
 *    player, ever; the registry's phrases carry this.
 * 2. **Frame geometry** — cropped by the frame edge, strongly foreshortened. A limb the
 *    frame cuts through cannot be composed as someone standing there.
 * 3. **A person-count assertion** — the positive form of "no third person", and the
 *    realistic-model analogue of the booru `solo focus` tag. Derived from the featured
 *    list, never hardcoded.
 *
 * The reference-edit route helps too: the base image is the character's portrait, so the
 * composition is already anchored on her and a foreground forearm is a small edit rather
 * than a recomposition.
 */
export function sceneFramingRule(args: {
  /** The viewer's parts in frame, already gated (`resolveViewerParts`). Empty ⇒ the disembodied rule. */
  parts?: readonly ViewerBodyPart[];
  /** Everyone fully in frame — the count assertion's subjects. */
  subjects?: readonly string[];
  /** The viewer's own body facts for those parts (`viewerBodyAppearance`) — keeps them one person. */
  body?: string;
  /** The viewer's exposure-gated intimate anatomy; the caller emits it only on an uncensored route. */
  intimate?: string;
}): string {
  const parts = args.parts ?? [];
  const names = (args.subjects ?? []).map((n) => n.trim()).filter(Boolean);
  if (parts.length === 0) {
    return [SCENE_POV_RULE, countAssertion(names), limbPossession(names)].filter(Boolean).join(" ");
  }
  const body = args.body?.trim();
  const intimate = args.intimate?.trim();
  return [
    "First-person POV through the viewer's own eyes; the viewer's face and head are never in frame.",
    countAssertion(names),
    `Also in frame, in the viewer's immediate foreground: ${joinPhrases(parts.map((p) => p.framing))}.`,
    // The facts ride AFTER the geometry deliberately: the model has to know these limbs are
    // the viewer's and cropped before it is told what they look like, or a described body
    // is just an invitation to paint a whole person wearing it.
    body ? `The viewer's own body: ${body}.` : "",
    intimate ? `${capitalizeFirst(intimate)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "Exactly one person is fully in frame: Mira." — the positive form of "no third person". */
function countAssertion(names: readonly string[]): string {
  if (names.length === 0) return "No other person is in frame.";
  const count = names.length === 1 ? "Exactly one person is" : `Exactly ${numberWord(names.length)} people are`;
  return `${count} fully in frame: ${joinPhrases(names)}. Nobody else appears.`;
}

/**
 * "Every visible body part belongs to Mira." — the total-possession binding for the
 * disembodied shot (2026-07-29). Deliberately ABSTRACT: the first draft enumerated the
 * limbs ("every hand, arm, leg and foot…") and the A/B run painted a phantom viewer
 * hand anyway — a limb noun summons a limb even when possessively bound. Binding
 * specific limbs is the POSE text's job (`bindLimbsToOwner`), where the limb is
 * already in the shot on purpose. "" with no subjects (location-only shot).
 */
function limbPossession(names: readonly string[]): string {
  const owner = names.length === 1 ? names[0] : names.length > 1 ? "one of them" : "";
  return owner ? `Every visible body part belongs to ${owner}.` : "";
}

/** Small-number words; past the cap the digit reads fine and never occurs in practice. */
function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

/** "a, b and c" — an Oxford-less join, since these are prompt phrases and not prose. */
function joinPhrases(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The selfie framing (chat-selfies.plan.md) — the exact INVERSE of the scene POV
 * rule: the subject's own phone camera, subject aware of the lens and composing
 * the shot. Positive phrasing only (a literal "no camera" would anchor the model
 * on cameras); a mirror shot may legitimately show the phone.
 */
export const SELFIE_FRAMING =
  "A casual phone selfie the subject is taking of herself: framed at arm's length or in a mirror, the subject aware of the camera and composing the shot — direct eye contact with the lens or a deliberate glance away, natural close-quarters phone perspective, candid everyday lighting. No one else in frame.";

export interface SceneRenderOptions {
  /**
   * Shot framing: the default player-POV scene rule, or the selfie inversion
   * (chat-selfies.plan.md — the subject's own camera). Applies on every route.
   */
  framing?: "pov" | "selfie";
  /**
   * Force the viewer's parts, bypassing the plan + gate. Tests and the eval harness only —
   * the render path derives them from `plan.viewerBody` ∩ coverage ∩ this route's
   * `allowIntimate`, which is why the gate lives in the builder and not the caller.
   */
  viewerParts?: readonly ViewerBodyPart[];
  /** Name of the character the reference image identity-locks (single-reference edit); omit for text-to-image. */
  referenceName?: string;
  /** Uncensored route: emit exposed intimate-anatomy detail (Decision 3). Off for the moderated text-to-image fallback. */
  allowIntimate?: boolean;
  /**
   * Multi-reference edit (spec §5): the ordered
   * reference images fed to the provider — the present characters' avatars plus
   * the location image — so the prompt can map each image to who/what it depicts.
   * When set, builds the multi-reference composition prompt (every listed
   * character is identity-locked by an image, not described textually) instead
   * of the single-anchor one.
   */
  multiReferences?: SceneMultiReference[];
}

/** One reference image fed to `/image/multi-edit`, in send order (first = base). */
export interface SceneMultiReference {
  name: string;
  kind: SceneVisualReferenceKind;
}

/**
 * Prompt-length budget for the reference-edit paths. Originally Venice's hard
 * limit (`Prompt exceeds 1500 character limit`); Venice is gone as of
 * 2026-08-05, and the Replicate models we run advertise far roomier caps —
 * Seedream accepts 4000 characters, though it recommends staying under 600.
 *
 * The number is KEPT at Venice's old value deliberately. It is now a
 * self-imposed quality bound rather than a provider constraint: 1500 is well
 * inside every current model's limit, and shorter prompts demonstrably steer
 * these models better than exhaustive ones. Untruncated garment descriptions
 * (followups.phase3.md §1) dominate the length, so a rich outfit or several
 * NPCs blows the budget — buildSceneRenderPrompt shrinks the variable fields to
 * fit (followups.phase3.md §6).
 */
export const EDIT_RENDER_PROMPT_LIMIT = 1500;

/**
 * The viewer's parts for THIS prompt: the plan's registry-clamped proposal, intersected
 * with the player's coverage and **this rung's** `allowIntimate`. It runs per-prompt rather
 * than once at plan time because the ladder's rungs disagree — the uncensored reference edit
 * permits intimate detail, the bare-prompt fallback does not — exactly as
 * `intimateAppearance` already works. `opts.viewerParts` is a test/eval override.
 */
function viewerPartsFor(plan: SceneRenderPlan, opts: SceneRenderOptions): readonly ViewerBodyPart[] {
  if (opts.viewerParts) return opts.viewerParts;
  return resolveViewerParts({
    proposed: plan.viewerBody,
    ...(plan.playerExposure ? { exposure: plan.playerExposure } : {}),
    allowIntimate: opts.allowIntimate === true,
  });
}

/** The whole framing clause for one route: gate the parts, then describe exactly those. */
function framingFor(plan: SceneRenderPlan, opts: SceneRenderOptions, subjects: readonly string[]): string {
  if (opts.framing === "selfie") return SELFIE_FRAMING;
  const parts = viewerPartsFor(plan, opts);
  const intimate = opts.allowIntimate && parts.some((p) => p.intimate) ? (plan.playerIntimateAppearance ?? "") : "";
  return sceneFramingRule({
    parts,
    subjects,
    body: viewerBodyAppearance(plan.playerAttributes ?? [], parts, plan.playerProfile),
    intimate,
  });
}

/**
 * Final render instruction. The single-reference rung anchors on at most ONE
 * character is identity-locked (`referenceName`); every other featured
 * character — including the focal one when the reference fell back to another
 * present NPC — is described textually from state-derived appearance/outfit.
 *
 * On the edit path (`referenceName` set) the prompt is budgeted to
 * EDIT_RENDER_PROMPT_LIMIT: the outfit and setting text are progressively
 * excerpted until it fits, with a hard clamp as a final safety net. Identity
 * lock, POV rule, pose, bare-region phrasing and the clothing-authority clause
 * are never dropped — only the verbose, lower-priority description text shrinks.
 */
export function buildSceneRenderPrompt(plan: SceneRenderPlan, opts: SceneRenderOptions = {}): string {
  const featured = [...(plan.focal ? [plan.focal] : []), ...plan.others];

  if (opts.multiReferences && opts.multiReferences.length > 0) {
    return budgetRenderPrompt((outfitCap, settingCap) => assembleMulti(plan, featured, opts, outfitCap, settingCap));
  }

  const refIndex = opts.referenceName
    ? featured.findIndex((c) => normalizeName(c.name) === normalizeName(opts.referenceName ?? ""))
    : -1;
  const reference = refIndex >= 0 ? featured[refIndex] : undefined;
  const textual = featured.filter((_, index) => index !== refIndex);

  const assemble = (outfitCap: number, settingCap: number): string => {
    const fit = makeFit(outfitCap);
    const pieces: string[] = [];
    if (reference) {
      pieces.push(PORTRAIT_IDENTITY_LOCK);
      // The age anchor is the one place the TEXT overrules the reference (owner
      // ruling 2026-07-29): the edit model over-reads an ambiguous reference's age
      // and drifts older every generation without this. Placed IMMEDIATELY after
      // the lock — adjacent to its "preserve apparent age" clause it reads as
      // qualifying that instruction, which is where the A/B probe measured the
      // ~15–20-year pull; parked later in the prompt it visibly diluted.
      if (reference.ageAnchor) pieces.push(reference.ageAnchor);
    }
    pieces.push(framingFor(plan, opts, featured.map((c) => c.name)));
    if (reference) {
      // Identity anchors reinforce the lock; the reference image stays authoritative
      // (owner constraint: these must never override the reference).
      if (reference.identityAnchors) {
        pieces.push(
          `Same person as the reference image — these features confirm it (the reference is authoritative where they differ): ${reference.identityAnchors}.`,
        );
      }
      if (reference.action) pieces.push(`Pose: ${reference.action}.`);
      // The reference portrait is waist-up — supply the figure it can't show.
      if (reference.lowerBody) pieces.push(`Body (below the portrait's framing): ${reference.lowerBody}.`);
      if (reference.outfitSummary) pieces.push(`Wearing: ${fit(reference.outfitSummary, outfitCap)}.`);
      if (reference.exposure) pieces.push(`${capitalizeFirst(reference.exposure)}.`);
      if (opts.allowIntimate && reference.intimateAppearance) pieces.push(`${capitalizeFirst(reference.intimateAppearance)}.`);
      if (!reference.outfitSummary && !reference.exposure) pieces.push("Keep the same outfit as the reference image.");
    }
    for (const c of textual) {
      const clothing = c.outfitSummary ? `wearing ${fit(c.outfitSummary, outfitCap)}` : c.exposure ? "" : "wearing casual everyday clothing";
      const intimate = opts.allowIntimate ? c.intimateAppearance : "";
      const species = c.species ? excerpt(c.species, 160) : "";
      const detail = [species, c.appearance, clothing, c.exposure, intimate, c.action].filter(Boolean).join("; ");
      const label = !reference && c === plan.focal ? "Subject" : "Also in frame";
      pieces.push(`${label}: ${c.name} — ${detail}.`);
      // The anchor-less (text-to-image) focal has no reference to mis-read, but the
      // same age drift applies to a purely textual render — state the sheet's age.
      if (!reference && c === plan.focal && c.ageAnchor) pieces.push(c.ageAnchor);
    }
    appendSceneTail(pieces, plan, featured, fit, settingCap);
    return pieces.join(" ");
  };

  // Text-to-image is unbudgeted; the reference-edit path shrinks to the char cap.
  if (!opts.referenceName) return assemble(Infinity, Infinity);
  return budgetRenderPrompt(assemble);
}

/** Per-call excerpt helper: `Infinity` cap ⇒ pass text through whole. */
function makeFit(_cap: number): (text: string, cap: number) => string {
  return (text, cap) => (cap === Infinity ? text : excerpt(text, cap));
}

/**
 * Shared tail for every scene render prompt: the clothing-authority clause (so
 * an edit model can't re-paint a shed garment), the empty-room note, and the
 * setting / lighting / mood / quality lines.
 */
function appendSceneTail(
  pieces: string[],
  plan: SceneRenderPlan,
  featured: SceneCharacterSpec[],
  fit: (text: string, cap: number) => string,
  settingCap: number,
): void {
  // Anchor clothing to wardrobe state, not the (often fully-dressed) reference image:
  // without this the edit model re-paints removed garments — a shed top stays on.
  if (featured.some((c) => c.outfitSummary || c.exposure)) {
    pieces.push("Depict only the clothing described; add no garment that is not listed.");
  }
  if (featured.length === 0) pieces.push("No people in frame — a quiet shot of the place itself.");
  if (plan.setting) pieces.push(`Setting: ${fit(plan.setting, settingCap)}.`);
  if (plan.lighting) pieces.push(`Lighting: ${plan.lighting}.`);
  if (plan.mood) pieces.push(`Mood: ${plan.mood}.`);
  pieces.push("High quality, no text, no watermark.");
}

/** Reference-edit prompts are budgeted to 1500 chars — shrink outfit/setting text until it fits. */
function budgetRenderPrompt(assemble: (outfitCap: number, settingCap: number) => string): string {
  const caps: ReadonlyArray<[number, number]> = [
    [Infinity, Infinity],
    [360, 220],
    [240, 160],
    [140, 120],
    [70, 80],
  ];
  let prompt = "";
  for (const [outfitCap, settingCap] of caps) {
    prompt = assemble(outfitCap, settingCap);
    if (prompt.length <= EDIT_RENDER_PROMPT_LIMIT) return prompt;
  }
  return clampToLimit(prompt, EDIT_RENDER_PROMPT_LIMIT);
}

/**
 * Multi-reference composition prompt for the multi-reference edit rung (spec §5):
 * every reference image is enumerated and its subject identity-locked, then each
 * featured character's pose/outfit/exposure is stated. Characters WITHOUT a
 * reference image (e.g. a third character beyond the 3-ref cap) fall back to a
 * textual face/appearance description so they still appear. Budgeted to the
 * prompt budget like the single-edit path.
 */
function assembleMulti(
  plan: SceneRenderPlan,
  featured: SceneCharacterSpec[],
  opts: SceneRenderOptions,
  outfitCap: number,
  settingCap: number,
): string {
  const fit = makeFit(outfitCap);
  const multi = opts.multiReferences ?? [];
  const refCharNames = new Set(multi.filter((m) => m.kind === "character").map((m) => normalizeName(m.name)));

  const pieces: string[] = [PORTRAIT_IDENTITY_LOCK];
  // Age anchors sit adjacent to the lock's "preserve apparent age" clause (the
  // placement the A/B probe validated); name-bound sentences keep several people
  // unambiguous in one block.
  for (const c of featured) if (c.ageAnchor) pieces.push(c.ageAnchor);
  pieces.push(framingFor(plan, opts, featured.map((c) => c.name)));
  pieces.push(`${multi.length} reference images provided — ${describeMultiReferences(multi)}`);
  pieces.push("Compose all referenced people together into one shared scene, each keeping the exact face, hair and build of their reference image.");

  for (const c of featured) {
    const isRef = refCharNames.has(normalizeName(c.name));
    const parts: string[] = [];
    if (!isRef) {
      if (c.species) parts.push(excerpt(c.species, 160));
      if (c.appearance) parts.push(c.appearance);
    }
    // Anchored characters get the identity-reinforcement phrase (reference stays authoritative).
    if (isRef && c.identityAnchors) parts.push(`matching the reference: ${c.identityAnchors}`);
    if (isRef && c.lowerBody) parts.push(`figure: ${c.lowerBody}`);
    if (c.action) parts.push(c.action);
    if (c.outfitSummary) parts.push(`wearing ${fit(c.outfitSummary, outfitCap)}`);
    else if (!c.exposure && !isRef) parts.push("wearing casual everyday clothing");
    if (c.exposure) parts.push(c.exposure);
    if (opts.allowIntimate && c.intimateAppearance) parts.push(c.intimateAppearance);
    const label = isRef ? c.name : `${c.name} (no reference image — render from this description)`;
    if (parts.length > 0) pieces.push(`${label}: ${parts.join("; ")}.`);
  }

  appendSceneTail(pieces, plan, featured, fit, settingCap);
  return pieces.join(" ");
}

/** "1) Mira and 2) Sayed are the people; 3) the location is the setting." */
function describeMultiReferences(multi: readonly SceneMultiReference[]): string {
  const parts = multi.map((m, i) => {
    const what = m.kind === "location" ? `the location (${m.name || "the setting"}) — the background/setting` : `${m.name || "a character"} — a person to include`;
    return `${i + 1}) ${what}`;
  });
  return parts.join("; ") + ".";
}

/** Last-resort hard cap: trim to a word boundary at or under the limit. */
function clampToLimit(prompt: string, limit: number): string {
  if (prompt.length <= limit) return prompt;
  const cut = prompt.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit - 60 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

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
