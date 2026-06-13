import { z } from "zod";
import { attributeRegistry, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { resolveWardrobeVisibility } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";

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

const BIO_EXCERPT_CHARS = 240;
const PERSONALITY_EXCERPT_CHARS = 120;

/** One default-outfit garment, phrased for the avatar prompt. */
export interface AvatarOutfitItem {
  name: string;
  /** Optional sensory appearance note from the item definition. */
  appearance?: string;
}

/** A default-outfit garment before occlusion filtering. */
export interface AvatarWardrobeItem {
  name: string;
  coverage: readonly string[];
  layer?: number | null;
  opacity?: "opaque" | "sheer";
  appearance?: string;
}

/**
 * Occlusion-aware outfit lines (same rule as in-session scene images,
 * contracts/items/visibility.ts): a layer fully covered by opaque higher
 * layers is omitted — telling the image model about the t-shirt under a
 * closed abaya makes it paint the abaya open. Sheer-covered items stay as a
 * vague hint; items with no coverage (jewelry, props) stay visible.
 */
export function visibleAvatarOutfit(items: ReadonlyArray<AvatarWardrobeItem>): AvatarOutfitItem[] {
  const views = resolveWardrobeVisibility(
    items.map((item, index) => ({
      instanceId: String(index),
      name: item.name,
      coverage: item.coverage,
      layer: item.layer === 0 || item.layer === 1 || item.layer === 2 || item.layer === 3 ? item.layer : 1,
      opacity: item.opacity ?? "opaque",
    })),
  );
  const viewById = new Map(views.map((v) => [v.instanceId, v]));
  return items.flatMap((item, index) => {
    const view = viewById.get(String(index));
    if (view?.visibility === "hidden") return [];
    if (view?.visibility === "hinted") {
      return [{ name: `${item.name} (only a vague hint beneath sheer layers)` }];
    }
    return [{ name: item.name, ...(item.appearance ? { appearance: item.appearance } : {}) }];
  });
}

/**
 * Composes the text-to-image avatar prompt from the character's resolved
 * attribute values. The attribute registry is the single source of phrasing:
 * labels name each trait, promptHints carry per-attribute guidance. The
 * default outfit is authoritative when present — without it the image model
 * invents clothing, which contradicts the character's saved wardrobe.
 */
export function buildAvatarPrompt(
  name: string,
  profile: CharacterProfile,
  style: AvatarStyle,
  outfit: ReadonlyArray<AvatarOutfitItem> = [],
): string {
  const appearance: string[] = [];
  const hints: string[] = [];
  for (const value of profile.attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — skip rather than leak raw ids into the prompt
    const formatted = formatAttribute(def, value.value);
    if (formatted) appearance.push(formatted);
    for (const hint of def.promptHints ?? []) hints.push(hint);
  }
  const wearing = outfit
    .map((item) => (item.appearance ? `${item.name} (${excerpt(item.appearance, 80)})` : item.name))
    .join("; ");

  return [
    `${STYLE_PREFIX[style]}, waist-up portrait, facing camera, soft studio lighting, neutral background.`,
    `Subject: ${name.trim() || "an unnamed character"}.`,
    appearance.length > 0 ? `Appearance: ${appearance.join("; ")}.` : "",
    wearing ? `Wearing (authoritative — depict exactly this clothing): ${wearing}.` : "",
    profile.bio.trim() ? `About: ${excerpt(profile.bio, BIO_EXCERPT_CHARS)}.` : "",
    profile.personality.trim() ? `Personality: ${excerpt(profile.personality, PERSONALITY_EXCERPT_CHARS)}.` : "",
    ...hints,
    STYLE_SUFFIX[style],
  ]
    .filter(Boolean)
    .join(" ");
}

function formatAttribute(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  if (typeof value === "boolean") return value ? def.label : "";
  if (typeof value === "number") return `${def.label}: ${value}${def.unit ? ` ${def.unit}` : ""}`;
  const text = Array.isArray(value) ? value.map(humanize).join(", ") : humanize(value);
  return text ? `${def.label}: ${text}` : "";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").trim();
}

function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
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
}

/**
 * One NPC co-located with the player at composition time. `wornVisible` must
 * already be occlusion-filtered (resolveWardrobeVisibility) — hidden layers
 * never reach this type, so they can never leak into a prompt.
 */
export interface ScenePresentCharacter {
  name: string;
  activity?: string;
  posture?: string;
  /** Occlusion-filtered wardrobe — the only permitted source of outfit truth. */
  wornVisible: ReadonlyArray<SceneWornItem>;
  /** Compact attribute phrase (characterAppearanceSummary) for textual render descriptions. */
  appearance?: string;
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
  "The image is rendered from the player's first-person POV: the camera IS the player's eyes. The player must NEVER appear in the image — no body, no face, no hands. Never describe the player or their clothing in any field.",
  "Fill every field of the requested object. Rules:",
  '- focalCharacter: exactly ONE name from the "Present characters" list — whoever the recent narration centers on. If the list is empty, leave it empty: a location-only shot is a valid image.',
  '- others: any remaining names from the "Present characters" list that belong in frame, each with a short phrase for what they are doing. Never include the player or anyone not on the list — characters who are not in the room must not appear.',
  "- pose and activity: what the focal character is doing right now, from the recent narration and their recorded activity.",
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
      const bits = [
        c.activity ? `activity: ${c.activity}` : "",
        c.posture ? `posture: ${c.posture}` : "",
        `visible wardrobe (authoritative): ${wardrobeLines(c.wornVisible)}`,
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
  return worn.map((w) => (w.visibility === "hinted" ? `${w.name} (hinted beneath sheer layers)` : w.name)).join("; ");
}

/** Deterministic outfit phrase from wardrobe state — overrides model prose. */
export function wardrobeOutfitSummary(worn: ReadonlyArray<SceneWornItem>): string {
  const visible = worn.filter((w) => w.visibility === "visible").map((w) => w.name);
  const hinted = worn.filter((w) => w.visibility === "hinted").map((w) => w.name);
  const parts: string[] = [];
  if (visible.length > 0) parts.push(visible.join(", "));
  if (hinted.length > 0) parts.push(`hints of ${hinted.join(", ")} beneath`);
  return parts.join("; ");
}

const APPEARANCE_SUMMARY_CHARS = 200;

/**
 * Compact appearance phrase from resolved attribute values (registry labels,
 * unknown ids skipped) — describes a character textually in a render prompt
 * when they are not the identity reference.
 */
export function characterAppearanceSummary(
  attributes: ReadonlyArray<AttributeValue>,
  maxChars = APPEARANCE_SUMMARY_CHARS,
): string {
  const parts: string[] = [];
  for (const value of attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
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
  /** What they are doing in frame. */
  action: string;
  /** Deterministic occlusion-filtered outfit phrase, forced from wardrobe state. */
  outfitSummary: string;
  /** Compact appearance phrase for textual description. */
  appearance: string;
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

  const focal = focalEntry ? characterSpec(focalEntry, [spec.pose, spec.activity].filter(Boolean).join("; ")) : null;
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
    action: action.trim() || [entry.posture, entry.activity].filter(Boolean).join("; "),
    // Forced from occlusion-filtered state regardless of anything the model said.
    outfitSummary: wardrobeOutfitSummary(entry.wornVisible),
    appearance: entry.appearance ?? "",
  };
}

// ---------------------------------------------------------------------------
// Scene render prompt (final image instruction)
// ---------------------------------------------------------------------------

/** The hard POV rule, restated verbatim in every scene render prompt. */
export const SCENE_POV_RULE =
  "First-person POV: the image is seen through the player's eyes. The player is the camera and must NEVER be visible — no body, no face, no hands in frame.";

export interface SceneRenderOptions {
  /** Name of the character the reference image identity-locks (Venice edit); omit for text-to-image. */
  referenceName?: string;
}

/**
 * Final render instruction. Venice is single-reference edit, so at most ONE
 * character is identity-locked (`referenceName`); every other featured
 * character — including the focal one when the reference fell back to another
 * present NPC — is described textually from state-derived appearance/outfit.
 */
export function buildSceneRenderPrompt(plan: SceneRenderPlan, opts: SceneRenderOptions = {}): string {
  const featured = [...(plan.focal ? [plan.focal] : []), ...plan.others];
  const refIndex = opts.referenceName
    ? featured.findIndex((c) => normalizeName(c.name) === normalizeName(opts.referenceName ?? ""))
    : -1;
  const reference = refIndex >= 0 ? featured[refIndex] : undefined;

  const pieces: string[] = [];
  if (reference) pieces.push(PORTRAIT_IDENTITY_LOCK);
  pieces.push(SCENE_POV_RULE);
  if (reference) {
    if (reference.action) pieces.push(`Pose: ${reference.action}.`);
    pieces.push(reference.outfitSummary ? `Wearing: ${reference.outfitSummary}.` : "Keep the same outfit as the reference image.");
  }
  const textual = featured.filter((_, index) => index !== refIndex);
  for (const c of textual) {
    const detail = [c.appearance, c.outfitSummary ? `wearing ${c.outfitSummary}` : "wearing casual everyday clothing", c.action]
      .filter(Boolean)
      .join("; ");
    const label = !reference && c === plan.focal ? "Subject" : "Also in frame";
    pieces.push(`${label}: ${c.name} — ${detail}.`);
  }
  if (featured.length === 0) pieces.push("No people in frame — a quiet shot of the place itself.");
  if (plan.setting) pieces.push(`Setting: ${plan.setting}.`);
  if (plan.lighting) pieces.push(`Lighting: ${plan.lighting}.`);
  if (plan.mood) pieces.push(`Mood: ${plan.mood}.`);
  pieces.push("High quality, no text, no watermark.");
  return pieces.join(" ");
}
