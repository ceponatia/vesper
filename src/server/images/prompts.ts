import { z } from "zod";
import { attributeRegistry, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { exposedRegions, resolveWardrobeVisibility, type RegionExposure, type WornItemInput } from "@/contracts/items/visibility";
import { clothingSubtypeLabel } from "@/contracts/items/subtypes";
import { INTIMATE_ATTRIBUTE_CATEGORIES, isBelowWaist, isFeatureAttributeCategory } from "@/contracts/body/locations";
import { realizeBody, speciesLabelPhrase } from "@/contracts/species";
import type { SceneVisualReferenceKind } from "@/contracts/images/scene-reference";
import type { CharacterProfile } from "@/contracts/world/profile";

/**
 * Intimate-anatomy attributes are withheld from image prompts unless the caller
 * sets `allowIntimate` (body-model spec Decision 3). Image generation is now
 * uncensored Venice/Qwen end-to-end, so avatar generation always sets it; the
 * gate remains off for the moderation-prone scene composer's appearance summary.
 */
/**
 * Non-visual attributes never belong in an image prompt — an image can't depict
 * how someone sounds or smells. `kind: "sensory"` is the auditory/olfactory set
 * (voice pitch/timbre/cadence, baseline scent), so it is dropped from both the
 * avatar prompt and the scene appearance summary. (Intimate sensory anatomy is
 * already gated separately by the exposure predicates.)
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
  name: string;
  coverage: readonly string[];
  layer?: number | null;
  opacity?: "opaque" | "sheer";
  description?: string;
  appearance?: string;
  /** Clothing subtype id (contracts/items/subtypes) — resolved to its label for the prompt. */
  subtype?: string | null;
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
 * garments (docs/images.md, followups.phase3.md §1).
 */
/** Map raw avatar-wardrobe items to the shared worn-item shape — the single
 * source for BOTH visibility (visibleAvatarOutfit) and coverage/exposure
 * (exposedRegions), so the two can never disagree about what a garment covers. */
export function toWornInputs(items: ReadonlyArray<AvatarWardrobeItem>): WornItemInput[] {
  return items.map((item, index) => ({
    instanceId: String(index),
    name: item.name,
    coverage: item.coverage,
    layer: item.layer === 0 || item.layer === 1 || item.layer === 2 || item.layer === 3 ? item.layer : 1,
    opacity: item.opacity ?? "opaque",
  }));
}

export function visibleAvatarOutfit(items: ReadonlyArray<AvatarWardrobeItem>): AvatarOutfitItem[] {
  const views = resolveWardrobeVisibility(toWornInputs(items));
  const viewById = new Map(views.map((v) => [v.instanceId, v]));
  return items.flatMap((item, index) => {
    if (item.coverage.length > 0 && item.coverage.every(isBelowWaist)) return []; // below the waist — outside a waist-up portrait
    const view = viewById.get(String(index));
    if (view?.visibility === "hidden") return [];
    if (view?.visibility === "hinted") {
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
      apparentAge = formatAttributeValue(def, value.value) || undefined;
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
  if (typeof value === "boolean") return value ? humanize(def.label).toLowerCase() : "";
  if (typeof value === "number") return `${value}${def.unit ? ` ${def.unit}` : ""}`;
  return Array.isArray(value) ? value.map(humanize).join(", ") : humanize(value);
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
// Portrait variants (Venice reference edit)
// ---------------------------------------------------------------------------

/** Ported from the old app's portrait-regen prompt builder (docs/images.md). */
export const PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

export type VariantKind = "pose" | "outfit" | "expression" | "setting";

const VARIANT_FRAMING: Record<VariantKind, string> = {
  pose: "Change the pose",
  outfit: "Change the outfit",
  expression: "Change the facial expression",
  setting: "Change the background and setting",
};

export function buildVariantInstruction(kind: VariantKind, instruction: string): string {
  const change = `${VARIANT_FRAMING[kind]}: ${instruction.trim().replace(/\.+$/, "")}.`;
  const keepOutfit = kind === "outfit" ? "" : "Keep the same outfit as the reference image.";
  return [PORTRAIT_IDENTITY_LOCK, change, keepOutfit, "Soft flattering lighting, high quality, no text, no watermark."]
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
}

export const SCENE_COMPOSER_SYSTEM = [
  "You compose the visual spec for a scene image from roleplay session state.",
  "The image is rendered from the player's first-person POV — shot through the player's own eyes. The player must NEVER appear in the image — no body, no face, no hands, and never a camera or held object in frame. Never describe the player or their clothing in any field.",
  "Fill every field of the requested object. Rules:",
  '- focalCharacter: exactly ONE name from the "Present characters" list — whoever the recent narration centers on. If the list is empty, leave it empty: a location-only shot is a valid image.',
  '- others: any remaining names from the "Present characters" list that belong in frame, each with a short phrase for what they are doing. Never include the player or anyone not on the list — characters who are not in the room must not appear.',
  "- pose and activity: what the focal character is doing right now, from the recent narration and their recorded activity. Pose is the body — stance, orientation, expression — in one compact phrase; activity is what they are doing in the scene. The two must not repeat each other's beats: state a facial expression ONCE, in pose (never a smile in pose and a laugh in activity — pick the single strongest beat).",
  '- Every pose/activity/action phrase must describe that character ALONE, paintable with no player in frame. Never mention the player or their body — "walking beside the player" or "a hand resting on his arm" cannot be painted. Translate player-directed beats into their solo visual equivalent: eyes or head turned toward the player become "toward the viewer"; touching, leading, or leaning on the player becomes the character\'s own posture and motion (a hand extended slightly, glancing back mid-step); keep the expression and energy, lose the contact. Example: narration "she leads you back toward the gallery, hand on your arm, laughing" → pose "glancing back toward the viewer, mid-laugh", activity "stepping toward the main gallery, heels clicking on the stone floor".',
  '- Wardrobe: each character\'s "visible wardrobe" line is the authoritative outfit state; never infer clothing from the narration — prose lies.',
  "- setting: the current location's appearance and atmosphere as seen from where the player stands.",
  "- lighting and mood: match the time of day and the emotional tone of the recent narration.",
  "- Keep each field to one or two short sentences.",
].join("\n");

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
 * otherwise paint clothed (docs/images.md §Scene images). Gated on
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
 * reference image and blow the Venice prompt budget).
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

/** Char cap on the identity-anchor phrase — it must never crowd the 1500-char Venice budget. */
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

/** Which exposure region uncovers each intimate attribute category. */
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
 * see docs/images.md §Avatar generation).
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
 * the caller can route each half (docs/images.md §Scene images): the reference
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
    const intimate = isIntimateAttribute(def);
    if (intimate !== opts.intimate) continue;
    if (realizedBody && !realizedBody.isAttributeApplicable(def)) continue;
    // The SFW half describes only the lower body — the portrait already covers
    // the face/upper body, so re-stating it wastes the (tight) Venice budget.
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
}

export function emptySceneRenderPlan(): SceneRenderPlan {
  return { focal: null, others: [], setting: "", lighting: "soft natural light", mood: "calm" };
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
export function scrubPlayerFromAction(action: string): string {
  if (!/\bplayer\b/i.test(action)) return action;
  // Gaze/orientation toward the player = toward the camera. Possessives ("at the
  // player's side") are proximity, not gaze — they fall through to the clause drop.
  const rewritten = action.replace(/\b(facing|toward|towards|at)\s+the\s+player\b(?!['’]s)/gi, "$1 the viewer");
  return rewritten
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !/\bplayer\b/i.test(clause))
    .join(", ");
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
 * wardrobe state (docs/images.md §Scene images): a focal name not in the room
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

  // Trailing periods stripped before the join — "…teasing smile.; Leading…" read as two
  // stitched sentences in the render prompt instead of one pose phrase.
  const focalAction = [spec.pose, spec.activity]
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .join("; ");
  const focal = focalEntry ? characterSpec(focalEntry, focalAction) : null;
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
    others.push(characterSpec(entry, other.action));
  }

  return {
    focal,
    others,
    setting:
      spec.setting.trim() ||
      [context.locationName, context.locationDescription].filter(Boolean).join(" — ").slice(0, 300),
    lighting: spec.lighting,
    mood: spec.mood,
  };
}

function characterSpec(entry: ScenePresentCharacter, action: string): SceneCharacterSpec {
  return {
    name: entry.name,
    ...(entry.species ? { species: entry.species } : {}),
    // The player scrub covers the composer's text AND the posture/activity fallback
    // (session state can carry player-referencing activity phrases too).
    action: scrubPlayerFromAction(action.trim() || [entry.posture, entry.activity].filter(Boolean).join("; ")),
    // Forced from occlusion-filtered state regardless of anything the model said; a free-text
    // override (character chat — no equippable wardrobe) wins when present.
    outfitSummary: entry.outfitDescription ?? wardrobeOutfitSummary(entry.wornVisible),
    appearance: entry.appearance ?? "",
    ...(entry.identityAnchors ? { identityAnchors: entry.identityAnchors } : {}),
    ...(entry.lowerBody ? { lowerBody: entry.lowerBody } : {}),
    exposure: formatExposure(entry.exposure, entry.wardrobeTracked),
    intimateAppearance: entry.intimateAppearance ?? "",
  };
}

// ---------------------------------------------------------------------------
// Scene render prompt (final image instruction)
// ---------------------------------------------------------------------------

/** The hard POV rule, restated verbatim in every scene render prompt. */
// Worded to avoid the literal "camera" framing: phrasing the player AS the
// camera made image models paint hands gripping a camera into the foreground.
// "no hands or held objects" closes that off without naming a camera (a negative
// the image model would only anchor on).
export const SCENE_POV_RULE =
  "First-person POV through the player's own eyes. The player must NEVER be visible — no body, no face, no hands or held objects in frame.";

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
  /** Name of the character the reference image identity-locks (Venice single edit); omit for text-to-image. */
  referenceName?: string;
  /** Uncensored route (Venice/Qwen): emit exposed intimate-anatomy detail (Decision 3). Off for the moderated text-to-image fallback. */
  allowIntimate?: boolean;
  /**
   * Multi-reference edit (Venice `/image/multi-edit`, spec §5): the ordered
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
 * Venice's image-edit endpoints (single + multi) hard-reject prompts over this
 * many characters (`Prompt exceeds 1500 character limit`). Venice text-to-image
 * is far roomier, so the budget only applies on the reference-edit paths.
 * Untruncated garment descriptions (followups.phase3.md §1) dominate the length, so a rich outfit
 * or several NPCs blows the cap — buildSceneRenderPrompt shrinks the variable
 * fields to fit (followups.phase3.md §6).
 */
export const VENICE_RENDER_PROMPT_LIMIT = 1500;

/**
 * Final render instruction. Venice is single-reference edit, so at most ONE
 * character is identity-locked (`referenceName`); every other featured
 * character — including the focal one when the reference fell back to another
 * present NPC — is described textually from state-derived appearance/outfit.
 *
 * On the Venice path (`referenceName` set) the prompt is budgeted to
 * VENICE_RENDER_PROMPT_LIMIT: the outfit and setting text are progressively
 * excerpted until it fits, with a hard clamp as a final safety net. Identity
 * lock, POV rule, pose, bare-region phrasing and the clothing-authority clause
 * are never dropped — only the verbose, lower-priority description text shrinks.
 */
export function buildSceneRenderPrompt(plan: SceneRenderPlan, opts: SceneRenderOptions = {}): string {
  const featured = [...(plan.focal ? [plan.focal] : []), ...plan.others];

  if (opts.multiReferences && opts.multiReferences.length > 0) {
    return budgetVenicePrompt((outfitCap, settingCap) => assembleMulti(plan, featured, opts, outfitCap, settingCap));
  }

  const refIndex = opts.referenceName
    ? featured.findIndex((c) => normalizeName(c.name) === normalizeName(opts.referenceName ?? ""))
    : -1;
  const reference = refIndex >= 0 ? featured[refIndex] : undefined;
  const textual = featured.filter((_, index) => index !== refIndex);

  const assemble = (outfitCap: number, settingCap: number): string => {
    const fit = makeFit(outfitCap);
    const pieces: string[] = [];
    if (reference) pieces.push(PORTRAIT_IDENTITY_LOCK);
    pieces.push(opts.framing === "selfie" ? SELFIE_FRAMING : SCENE_POV_RULE);
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
    }
    appendSceneTail(pieces, plan, featured, fit, settingCap);
    return pieces.join(" ");
  };

  // Text-to-image is unbudgeted; the Venice edit path shrinks to the char cap.
  if (!opts.referenceName) return assemble(Infinity, Infinity);
  return budgetVenicePrompt(assemble);
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

/** Venice edit/multi-edit prompts hard-cap at 1500 chars — shrink outfit/setting text until it fits. */
function budgetVenicePrompt(assemble: (outfitCap: number, settingCap: number) => string): string {
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
    if (prompt.length <= VENICE_RENDER_PROMPT_LIMIT) return prompt;
  }
  return clampToLimit(prompt, VENICE_RENDER_PROMPT_LIMIT);
}

/**
 * Multi-reference composition prompt for Venice `/image/multi-edit` (spec §5):
 * every reference image is enumerated and its subject identity-locked, then each
 * featured character's pose/outfit/exposure is stated. Characters WITHOUT a
 * reference image (e.g. a third character beyond the 3-ref cap) fall back to a
 * textual face/appearance description so they still appear. Budgeted to the
 * Venice limit like the single-edit path.
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

  const pieces: string[] = [PORTRAIT_IDENTITY_LOCK, opts.framing === "selfie" ? SELFIE_FRAMING : SCENE_POV_RULE];
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
 * Product-photo prompt for a library item (docs/images.md §Entity images):
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
 * Establishing-shot prompt for a library location (docs/images.md §Entity
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
