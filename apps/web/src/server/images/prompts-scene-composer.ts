import { z } from "zod";
import type { AttributeValue } from "@/contracts/attributes";
import { sceneCameraHeights, sceneShotDistances, sceneSubjectOrientationIds } from "@/contracts/images/scene-camera";
import { describeCommittedFacts, type CommittedSceneFacts } from "@/contracts/images/scene-committed";
import { sceneStagings } from "@/contracts/images/scene-staging";
import type { RegionExposure } from "@/contracts/items/visibility";
import type { CharacterProfile } from "@/contracts/world/profile";
import { excerpt, formatGarment } from "./prompts-format";

/** The scene composer's contract: its structured output schema, its system rules, and the prompt it is given. */

// ---------------------------------------------------------------------------
// Scene composer (tool model, structured)
// ---------------------------------------------------------------------------

/**
 * The shot the schema falls back to — today's front-facing default, spelled out here rather
 * than imported from `DEFAULT_SCENE_CAMERA` because this one carries the composer's
 * `evidence` field, which a resolved camera does not have.
 */
const COMPOSER_DEFAULT_CAMERA = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
  evidence: "",
};

/** No staging. The common case by a wide margin, and the answer to every degradation. */
const COMPOSER_DEFAULT_STAGING = { id: "", evidence: "" };

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
   * The viewer's own body parts in frame — ids
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
  /**
   * Where the camera stands — ids from the camera
   * registry (`contracts/images/scene-camera.ts`), plus one verbatim quote grounding any
   * non-default orientation or height. Lenient like `viewerBody` for the same reason: a
   * confused composer must degrade to today's front-facing shot, never to a failed render.
   */
  camera: z
    .object({
      orientation: z.string().default("toward_viewer"),
      distance: z.string().default("medium"),
      height: z.string().default("eye_level"),
      /** Verbatim narration (or player-message) quote grounding any non-default orientation or height. */
      evidence: z.string().default(""),
    })
    .catch(COMPOSER_DEFAULT_CAMERA)
    .default(COMPOSER_DEFAULT_CAMERA),
  /**
   * The intimate configuration being staged (slice 2) — an id from the staging registry
   * (`contracts/images/scene-staging.ts`) and its grounding quote, and NOTHING else. The
   * registry owns every explicit word that reaches the model; the composer picks the entry
   * and copies the evidence, so a cautious model cannot water the shot down and a bold one
   * cannot invent what the story never described.
   */
  staging: z
    .object({ id: z.string().default(""), evidence: z.string().default("") })
    .catch(COMPOSER_DEFAULT_STAGING)
    .default(COMPOSER_DEFAULT_STAGING),
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
   * Free-text outfit that **overrides** the structured `wornVisible` summary when
   * set: the character chat has no equippable wardrobe, so it
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
  /** Visible intimate-anatomy phrase (sceneRevealAppearance, `{intimate: true}`), exposure-gated; emitted only on the uncensored route. */
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
  /** The last 1–2 turns' narration, oldest first. Budgeted by the prompt builder. ASSISTANT rows only. */
  recentNarration?: ReadonlyArray<string>;
  /**
   * The player's own recent messages, oldest first.
   *
   * A separate corpus from `recentNarration` because they answer different questions and
   * every consumer must state which one it grounds against. "I come up behind her" is almost
   * always the PLAYER's sentence, never the narrator's — so a shot planner reading only the
   * narrator's replies can never learn where the camera stands, which is the single largest
   * source of the front-facing default being wrong.
   */
  recentPlayerMessages?: ReadonlyArray<string>;
  /**
   * Committed scene facts per present character, keyed by `normalizeName(name)`.
   *
   * Authoritative, and read-only: where a fact exists it outranks anything the composer
   * proposes, and where none exists nothing changes. Sparse coverage is expected while the
   * typed-movement lane gathers data, and an empty map must behave exactly like slices 1–2.
   */
  committedScene?: ReadonlyMap<string, CommittedSceneFacts>;
  /**
   * **Embodied POV**: may the viewer's own body
   * enter frame? Set by the **chat lane only** — the session lane keeps the absolute
   * player-is-invisible rule (and its tests). When false or
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

/**
 * The gaze translation's orientation clause, woven into BOTH rule sets.
 *
 * The pipeline's oldest camera bug is that it actively rotates the subject toward the lens:
 * a player-directed beat becomes "toward the viewer", which is exactly right when the player
 * stands in front of her and exactly backwards when they have just walked up behind her. So
 * the translation is now conditioned on the camera the composer itself proposed — the same
 * sentence, aimed the way the shot is.
 */
const GAZE_ORIENTATION_CLAUSE =
  ' (with camera.orientation "away" or "away_glance_back", that same beat becomes "glancing back over her shoulder toward the viewer" instead)';

/** The player-absence rules (session lane, and the chat lane before slice 3). */
const COMPOSER_DISEMBODIED_RULES = [
  "The image is rendered from the player's first-person POV — shot through the player's own eyes. The player must NEVER appear in the image — no body, no face, no hands, and never a camera or held object in frame. Never describe the player or their clothing in any field.",
  `- Every pose/activity/action phrase must describe that character ALONE, paintable with no player in frame. Never mention the player or their body — "walking beside the player" or "a hand resting on his arm" cannot be painted. Translate player-directed beats into their solo visual equivalent: eyes or head turned toward the player become "toward the viewer"${GAZE_ORIENTATION_CLAUSE}; touching, leading, or leaning on the player becomes the character's own posture and motion (her hand extended slightly, glancing back mid-step); keep the expression and energy, lose the contact. Example: narration "she leads you back toward the gallery, hand on your arm, laughing" → pose "glancing back toward the viewer, mid-laugh", activity "stepping toward the main gallery, heels clicking on the stone floor".`,
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
 * **Genitals are absent from its vocabulary on purpose** — this composer runs with
 * `allowIntimate: false` whatever model its seam picks (exposure gating is code's job
 * however bold the composer is — owner ruling 2026-08-10), so intimate anatomy is derived
 * at render assembly instead, exactly as `sceneRevealAppearance` always has been.
 */
const COMPOSER_EMBODIED_RULES = [
  "The image is rendered from the player's first-person POV — shot through their own eyes, so their face and head are NEVER in frame. Their own hands, arms, lap or legs MAY enter the foreground when the scene actually puts them there — that is what `viewerBody` is for. Never describe the player's clothing, and never place the player as a person standing in the scene.",
  '- viewerBody: which of the player\'s OWN body parts are in the shot, as a list of ids from exactly: "hands", "forearms", "lap_thighs", "legs_feet", "torso". Empty is the default and the common case — list a part ONLY when the recent narration puts it in the frame (her cheek against their palm → ["hands"]; her head resting in their lap → ["lap_thighs"]). Never list a part merely because the player has one, and never more than the beat needs. For EVERY id listed, add one viewerBodyEvidence entry: { "part": the id, "quote": a short phrase copied EXACTLY, word for word, from the recent narration that physically puts that part of the player in the shot }. A part whose quote is missing, paraphrased, or invented is dropped in code — if you cannot copy a real phrase, leave both lists empty.',
  `- pose/activity may now name contact with the player, but ALWAYS from the character's side and only for a part you listed in viewerBody: "her hand closing over the viewer's forearm" is paintable when forearms is listed. Call them "the viewer", never "the player" and never "him"/"her". With viewerBody empty, translate contact away as before: eyes or head turned toward the player become "toward the viewer"${GAZE_ORIENTATION_CLAUSE}; touching or leading becomes the character's own posture and motion (her hand extended, glancing back mid-step) — keep the expression and energy, lose the contact.`,
] as const;

/** `"a", "b", "c"` — the registry's own ids, so a new member reaches the rule as a data edit. */
const quotedIds = (ids: readonly string[]): string => ids.map((id) => `"${id}"`).join(", ");

/**
 * A vocabulary rendered as `"id" (what it means)` instead of a bare id list.
 *
 * An id is a label, not a definition, and the 2026-08-15 composer A/B measured what that
 * costs: eight models across five families answered the distance axis wrong on nearly every
 * beat, in both directions, because "close" and "medium" were handed over as bare words with
 * no rubric. The hints come off the registry entries themselves, so a new id cannot reach the
 * prompt undescribed — the type requires one.
 */
const describedIds = (entries: readonly { id: string; hint: string }[]): string =>
  entries.map((entry) => `"${entry.id}" (${entry.hint})`).join("; ");

/**
 * The camera rule — stated to BOTH lanes, because where
 * the camera stands is a fact about the shot rather than about whether the viewer's own body
 * is in it.
 *
 * Propose-then-verify, the pattern the viewer's own hands already ride: the composer picks
 * ids and copies a quote, and `resolveScenePlan` checks the quote against the transcript. The
 * quote requirement is the anti-eagerness half — an LLM handed a camera control moves it far
 * more often than the fiction warrants, and a camera that wanders on a whim contradicts the
 * story exactly as loudly as one that never moves.
 *
 * The glance carries its own sentence (owner ruling 2026-08-10): away means FULLY away, and
 * "she looked back" is a separate physical claim from "the player is behind her".
 */
const COMPOSER_CAMERA_RULE =
  `- camera: where this shot is taken from, as three ids — orientation (which way the focal character is turned relative to the viewer): ${quotedIds(sceneSubjectOrientationIds)}; distance (how much of the body the frame holds, NOT how near the viewer is standing): ${describedIds(sceneShotDistances)}; height (where the camera sits relative to her): ${describedIds(sceneCameraHeights)}. ` +
  'The defaults are "toward_viewer" / "medium" / "eye_level", and they are the right answer unless the story actually says otherwise. Any OTHER orientation or height MUST carry camera.evidence: a short phrase copied EXACTLY, word for word, from the recent narration or the player\'s own words, establishing where the viewer is standing relative to that character or which way she is facing. If nothing establishes it, keep the defaults — an unquoted camera is dropped in code, so a guess costs you the shot. ' +
  'Evidence that puts the viewer behind her, or her back to them, is "away": away means fully away, her back to the camera. Propose "away_glance_back" ONLY when the history actually describes her looking or glancing back, and the quote must be that glance itself, not the behind-position. Distance never needs a quote — simply match the beat, and remember that standing near someone is not a "close" frame: two bodies in contact almost always need "medium".';

/**
 * The staging rule (slice 2) — **embodied lane only**, because every entry in the catalog is
 * a two-body geometry between the subject and the viewer, and a lane where the viewer has no
 * body cannot stage one.
 *
 * The composer picks an id and quotes evidence, and that is the whole of its authority: the
 * registry owns every word that reaches the image model. That is a grounding decision before
 * it is a moderation one — a bold composer cannot invent an act the story never described,
 * and a cautious one cannot water down an act it did.
 */
const COMPOSER_STAGING_RULE =
  "- staging: the physical configuration the story has just put the character and the viewer in, as ONE id from exactly this list:\n" +
  sceneStagings.map((entry) => `    ${entry.id} — ${entry.hint}`).join("\n") +
  "\n  Set staging.id ONLY when the recent story EXPLICITLY describes that configuration between the focal character and the viewer, and set staging.evidence to a short phrase copied EXACTLY, word for word, from that history. Leave both empty whenever you are in any doubt — which is most of the time; an unquoted or merely-implied staging is dropped in code. " +
  "Several entries describe the SAME act and differ by one detail — whose hands are where, whether she is bare, which way she faces. When you pick one of those, your quote must be the phrase that establishes THAT detail, not the phrase establishing the act they share: for a kneeling act with the viewer's hand on her head, quote the hand on her head. If the story does not state the distinguishing detail, pick the plainer entry. " +
  "You never write the configuration out in words: the wording is composed in code from the id you pick, so your entire job here is the id and the quote.";

const composerRules = (embodied: boolean): readonly string[] => {
  // Spread, not a two-name destructure: the embodied set has THREE rules (framing,
  // `viewerBody`, and the contact rule that spends it) and a `[framing, contact]` pair
  // silently dropped the third, so the chat lane was never told it may name contact at all.
  // The disembodied set is unchanged by this — one framing rule, one lane rule.
  const [framing, ...lane] = embodied ? COMPOSER_EMBODIED_RULES : COMPOSER_DISEMBODIED_RULES;
  return [
    "You compose the visual spec for a scene image from roleplay session state.",
    framing,
    "Fill every field of the requested object. Rules:",
    '- focalCharacter: exactly ONE name from the "Present characters" list — whoever the recent narration centers on. If the list is empty, leave it empty: a location-only shot is a valid image.',
    '- others: any remaining names from the "Present characters" list that belong in frame, each with a short phrase for what they are doing. Never include the player or anyone not on the list — characters who are not in the room must not appear.',
    "- pose and activity: what the focal character is doing right now, from the recent narration and their recorded activity. Pose is the body — stance, orientation, expression — in one compact phrase; activity is what they are doing in the scene. The two must not repeat each other's beats: state a facial expression ONCE, in pose (never a smile in pose and a laugh in activity — pick the single strongest beat).",
    '- Body parts in any phrase must be possessively bound to their owner: "her hand raising the cup", "Mira\'s fingers on the railing" — never a bare "a hand", "one hand" or "one finger". In a first-person POV image an unowned limb reads as the player\'s.',
    ...lane,
    COMPOSER_CAMERA_RULE,
    // Staging is the embodied lane's alone: every catalog entry places the viewer's own body
    // against the subject's, which the disembodied lane cannot draw at all.
    ...(embodied ? [COMPOSER_STAGING_RULE] : []),
    '- Wardrobe: each character\'s "visible wardrobe" line is the authoritative outfit state; never infer clothing from the narration — prose lies.',
    "- setting: the current location's appearance and atmosphere as seen from where the player stands.",
    "- lighting and mood: match the time of day and the emotional tone of the recent narration.",
    '- NEVER describe skin colour or reddening in any field — no "flushed", "blushing", "rosy", "red-faced", "colour rising". An image model paints those as makeup, not feeling. State the same beat as physiology instead: eyes bright or heavy-lidded, lips parted, breath shallow, a sheen of sweat, damp hairline, loosened posture. The narration you are given WILL say "flushed" — translate it, never copy it.',
    "- Keep each field to one or two short sentences.",
  ];
};

/**
 * The composer's system prompt. `embodied` opts into the viewer's-own-body rules — the
 * **chat lane only**.
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

/**
 * The player-message budget: the NEWEST message only, and a smaller excerpt than the
 * narration's.
 *
 * A prompt-budget decision and nothing more — "I come up behind her" is stated in the message
 * the player just sent, and the turns before it are already reflected in the narration the
 * prompt carries. **This cap is not an evidence decision**: `sceneEvidenceCorpus` grounds
 * quotes against every player message the caller supplied, so a quote the composer copies
 * from context it saw earlier in the conversation still verifies.
 */
export const RECENT_PLAYER_MESSAGE_CHARS = 300;

/**
 * Everything a verbatim-quote gate may check a composer's evidence against.
 *
 * Stated once, and exported, because the corpus is now TWO lists with different meanings —
 * `recentNarration` is the narrator's replies and `recentPlayerMessages` is the player's own
 * sentences — and every consumer must say which it grounds against rather than reaching for
 * whichever field is nearest. Both count: the camera facts this feature exists to ground
 * ("I come up behind her") are almost always the player's words, and the viewer's-own-body
 * gate wants the same widened corpus for the same reason.
 */
export function sceneEvidenceCorpus(
  context: Pick<SceneComposerContext, "recentNarration" | "recentPlayerMessages">,
): string[] {
  return [...(context.recentNarration ?? []), ...(context.recentPlayerMessages ?? [])].filter((text) => text.trim());
}

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
  // BEFORE the narration, because they are context the narration is read against rather than
  // another voice in it: where a committed fact and a line of prose disagree, the fact wins
  // and the clamp will enforce it — so the composer is told which is which up front and the
  // proposal and the clamp agree instead of fighting.
  const committed = committedFactLines(context);
  if (committed.length > 0) {
    lines.push("Committed scene facts (authoritative — these are true, and outrank anything the narration implies):");
    lines.push(...committed);
  }
  const recent = (context.recentNarration ?? []).filter((n) => n.trim()).slice(-RECENT_NARRATION_TURNS);
  if (recent.length > 0) {
    lines.push("Recent narration (oldest first):");
    recent.forEach((narration, index) => {
      const budget = index === recent.length - 1 ? RECENT_NARRATION_LATEST_CHARS : RECENT_NARRATION_PRIOR_CHARS;
      lines.push(excerpt(narration, budget));
    });
  }
  // The player's half of the transcript, labeled as theirs. "I come up behind her" is the
  // player's sentence, never the narrator's, so a shot planner reading only the replies can
  // never learn where the camera stands.
  const newestPlayerMessage = (context.recentPlayerMessages ?? []).filter((m) => m.trim()).at(-1);
  if (newestPlayerMessage) {
    lines.push("The player's own words (their stated position and actions):");
    lines.push(excerpt(newestPlayerMessage, RECENT_PLAYER_MESSAGE_CHARS));
  }
  return lines.join("\n");
}

/**
 * One line per present character the committed scene actually knows something about.
 *
 * Silence stays silence: a character with no facts contributes no line, and a map with no
 * entries adds no header — the prompt is byte-identical to a chat whose typed-movement lane
 * has never committed anything, which is most of them.
 */
function committedFactLines(context: SceneComposerContext): string[] {
  const facts = context.committedScene;
  if (!facts || facts.size === 0) return [];
  const lines: string[] = [];
  for (const character of context.present) {
    // The map's key is the roster name normalized the way `resolveScenePlan` normalizes it
    // (`normalizeName`), spelled out here rather than imported: this module is upstream of
    // the plan resolver and must not import back down into it.
    const described = describeCommittedFacts(character.name, facts.get(character.name.trim().toLowerCase()) ?? {});
    if (described) lines.push(`- ${described}`);
  }
  return lines;
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
 * otherwise paint clothed (docs/images/pipelines/scene-subjects.md
 * §Bare-region phrasing). Gated on `wardrobeTracked`: callers set this only
 * when wardrobe state is authoritative.
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
