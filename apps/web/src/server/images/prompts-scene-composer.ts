import { z } from "zod";
import type { AttributeValue } from "@/contracts/attributes";
import type { RegionExposure } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import { excerpt, formatGarment } from "./prompts-format";

/** The scene composer's contract: its structured output schema, its system rules, and the prompt it is given. */

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
