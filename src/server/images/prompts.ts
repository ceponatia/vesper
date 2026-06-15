import { z } from "zod";
import { attributeRegistry, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { resolveWardrobeVisibility, type RegionExposure } from "@/contracts/items/visibility";
import { INTIMATE_ATTRIBUTE_CATEGORIES, isBelowWaist } from "@/contracts/body/locations";
import type { CharacterProfile } from "@/contracts/world/profile";

/**
 * Intimate-anatomy attributes are withheld from image prompts unless the route
 * is the uncensored Qwen/Venice path (body-model spec Decision 3). The default
 * Flux portrait generator rejects these fields, so callers pass `allowIntimate`
 * only when targeting an uncensored model.
 */
function isIntimateAttribute(def: AttributeDefinition): boolean {
  return (INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category);
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

const BIO_EXCERPT_CHARS = 240;

/** One default-outfit garment, phrased for the avatar prompt. */
export interface AvatarOutfitItem {
  /** Item name — fallback label when the garment has no description. */
  name: string;
  /** Item definition description — the primary phrasing (usually restates the name). */
  description?: string;
  /** Optional sensory appearance note from the item definition. */
  appearance?: string;
}

/** A default-outfit garment before occlusion / waist-up filtering. */
export interface AvatarWardrobeItem {
  name: string;
  coverage: readonly string[];
  layer?: number | null;
  opacity?: "opaque" | "sheer";
  description?: string;
  appearance?: string;
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
    if (item.coverage.length > 0 && item.coverage.every(isBelowWaist)) return []; // below the waist — outside a waist-up portrait
    const view = viewById.get(String(index));
    if (view?.visibility === "hidden") return [];
    if (view?.visibility === "hinted") {
      return [{ name: `${item.name} (only a vague hint beneath sheer layers)` }];
    }
    return [
      {
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        ...(item.appearance ? { appearance: item.appearance } : {}),
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
 */
export function buildAvatarPrompt(
  name: string,
  profile: CharacterProfile,
  style: AvatarStyle,
  outfit: ReadonlyArray<AvatarOutfitItem> = [],
  allowIntimate = false,
): string {
  const appearance: string[] = [];
  for (const value of profile.attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — skip rather than leak raw ids into the prompt
    if (!allowIntimate && isIntimateAttribute(def)) continue; // Flux portrait route excludes intimate anatomy
    const formatted = formatAttribute(def, value.value);
    if (formatted) appearance.push(formatted);
  }
  const wearing = outfit.map(formatGarment).join("; ");

  return [
    `${STYLE_PREFIX[style]}, waist-up portrait, facing camera, soft studio lighting, neutral background.`,
    `Subject: ${name.trim() || "an unnamed character"}.`,
    appearance.length > 0 ? `Appearance: ${appearance.join("; ")}.` : "",
    wearing ? `Wearing (authoritative — depict exactly this clothing): ${wearing}.` : "",
    profile.bio.trim() ? `About: ${excerpt(profile.bio, BIO_EXCERPT_CHARS)}.` : "",
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
 */
function formatGarment(item: { name: string; description?: string; appearance?: string }): string {
  const base = (item.description?.trim() || item.name).trim();
  const detail = item.appearance?.trim();
  return detail ? `${base} (${detail})` : base;
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
      const exposed = formatExposure(c.exposure, c.wardrobeTracked);
      const bits = [
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
 */
export function characterAppearanceSummary(
  attributes: ReadonlyArray<AttributeValue>,
  maxChars = APPEARANCE_SUMMARY_CHARS,
  allowIntimate = false,
): string {
  const parts: string[] = [];
  for (const value of attributes) {
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (!allowIntimate && isIntimateAttribute(def)) continue; // scene composer (gemini tool model) is moderation-prone
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), maxChars);
}

/** Which exposure region uncovers each intimate attribute category. */
const INTIMATE_CATEGORY_EXPOSURE: Record<string, keyof RegionExposure> = {
  breasts: "torso",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
};

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
    if (!def || !isIntimateAttribute(def) || def.kind === "sensory") continue;
    const axis = INTIMATE_CATEGORY_EXPOSURE[def.category];
    if (!axis || exposure[axis] === "covered") continue; // only an exposed region surfaces
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
    exposure: formatExposure(entry.exposure, entry.wardrobeTracked),
    intimateAppearance: entry.intimateAppearance ?? "",
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
  /** Uncensored route (Venice/Qwen): emit exposed intimate-anatomy detail (Decision 3). Off for Flux text-to-image. */
  allowIntimate?: boolean;
}

/**
 * Venice's image-edit endpoint hard-rejects prompts over this many characters
 * (`Prompt exceeds 1500 character limit`). Text-to-image (flux) is far roomier,
 * so the budget only applies on the reference-edit path. Untruncated garment
 * descriptions (followups.phase3.md §1) dominate the length, so a rich outfit
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
  const refIndex = opts.referenceName
    ? featured.findIndex((c) => normalizeName(c.name) === normalizeName(opts.referenceName ?? ""))
    : -1;
  const reference = refIndex >= 0 ? featured[refIndex] : undefined;
  const textual = featured.filter((_, index) => index !== refIndex);

  const assemble = (outfitCap: number, settingCap: number): string => {
    const fit = (text: string, cap: number) => (cap === Infinity ? text : excerpt(text, cap));
    const pieces: string[] = [];
    if (reference) pieces.push(PORTRAIT_IDENTITY_LOCK);
    pieces.push(SCENE_POV_RULE);
    if (reference) {
      if (reference.action) pieces.push(`Pose: ${reference.action}.`);
      if (reference.outfitSummary) pieces.push(`Wearing: ${fit(reference.outfitSummary, outfitCap)}.`);
      if (reference.exposure) pieces.push(`${capitalizeFirst(reference.exposure)}.`);
      if (opts.allowIntimate && reference.intimateAppearance) pieces.push(`${capitalizeFirst(reference.intimateAppearance)}.`);
      if (!reference.outfitSummary && !reference.exposure) pieces.push("Keep the same outfit as the reference image.");
    }
    for (const c of textual) {
      const clothing = c.outfitSummary ? `wearing ${fit(c.outfitSummary, outfitCap)}` : c.exposure ? "" : "wearing casual everyday clothing";
      const intimate = opts.allowIntimate ? c.intimateAppearance : "";
      const detail = [c.appearance, clothing, c.exposure, intimate, c.action].filter(Boolean).join("; ");
      const label = !reference && c === plan.focal ? "Subject" : "Also in frame";
      pieces.push(`${label}: ${c.name} — ${detail}.`);
    }
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
    return pieces.join(" ");
  };

  if (!opts.referenceName) return assemble(Infinity, Infinity);

  // Venice edit path: shrink outfit/setting text until under the limit.
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
