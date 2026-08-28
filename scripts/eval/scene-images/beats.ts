import { DEFAULT_SCENE_CAMERA, type SceneCameraSpec } from "@/contracts/images/scene-camera";
import { sceneStagingById, type SceneStaging, type SceneStagingId } from "@/contracts/images/scene-staging";
import type { RegionExposure } from "@/contracts/items/visibility";
import {
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneSpec,
  sceneSpecSchema,
} from "@/server/images";

/**
 * The seven orientation/staging beats: three preference-ranked camera-only shots
 * (`behind`, `glance`, `kneel`) plus the four intimate acceptance scenes
 * (`doggy`, `oral`, `oral_guided`, `missionary`, owner-specified 2026-08-10).
 *
 * Extracted from the retired `orientation-ab.ts` render A/B (#356 — its inputs
 * pointed at `docs/scene-image-eval/` portraits that no longer exist on any
 * machine) because `composer-model-ab.ts` grades the SAME beats and must keep
 * doing so: two probes disagreeing about what "doggy" is would make their
 * gradings incomparable. This module carries only the beat DATA (the resolved
 * spec, context, camera and staging each beat asserts) — the render-side prompt
 * assembly and paid A/B runner that used to live alongside it were deleted with
 * `orientation-ab.ts`.
 */

/** The player undressed below the waist — the gate's input, never a way around it. */
const PLAYER_BARE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };
/** Her half of the same: bare below the waist, still wearing something above it. */
const BARE_BELOW_WAIST: RegionExposure = { torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" };
/** The persona's exposure-gated anatomy, in the shape `sceneRevealAppearance` produces. */
const PLAYER_INTIMATE = "circumcised, above average length, erect";

/** The subject: the same Mira the phantom-limb probe uses, so the two A/Bs stay comparable. */
function subject(over: Partial<ScenePresentCharacter> = {}): ScenePresentCharacter {
  return {
    name: "Mira",
    wornVisible: [],
    outfitDescription: "a soft grey t-shirt and jeans",
    appearance: "Hair color: auburn; Hair length: long; Eye color: green",
    // The shipped age anchor (owner ruling 2026-07-29) — kept on BOTH variants, since this
    // probe is about the camera and nothing else may differ between them.
    ageAnchor: "Mira is in her late twenties; her skin, hands and legs read smooth and youthful.",
    ...over,
  };
}

/** Registry lookup that fails loudly — a beat naming a staging the catalog dropped is broken, not optional. */
function stagingEntry(id: SceneStagingId): SceneStaging {
  const entry = sceneStagingById(id);
  if (!entry) throw new Error(`unknown staging id "${id}" — scene-staging.ts and this probe have drifted`);
  return entry;
}

/**
 * A resolved beat: `composer-model-ab.ts` grades a model's proposal against it,
 * and derives its {@link ComposerExpectation} answer key from the beat's own
 * `camera`/`staging` (never restated).
 */
export interface Beat {
  /** One clause naming the shot — printed above the prompts at run time. */
  summary: string;
  /** What the owner is looking for: the graded elements, or the preference question. */
  grading: readonly string[];
  context: SceneComposerContext;
  spec: SceneSpec;
  /** The `new` variant's camera. Ignored when `staging` is set — a staging's camera outranks it. */
  camera: SceneCameraSpec;
  staging?: SceneStaging;
  /** The uncensored reference-edit route. All three acceptance scenes run true. */
  allowIntimate: boolean;
}

/**
 * Beats are FACTORIES, built only for the one selected: each parses a spec and reads the
 * registries, and a broken beat should fail the run it belongs to rather than every run. A Map
 * rather than an object so the ids stay the env-var spellings the (retired) orientation A/B's
 * header documented.
 */
export const BEATS = new Map<string, () => Beat>([
  ["behind", behindBeat],
  ["glance", glanceBeat],
  ["kneel", kneelBeat],
  ["doggy", doggyBeat],
  ["oral", () => oralBeat("kneeling_before_viewer", "her face visible, looking up mid-act", { guidingHand: false })],
  [
    "oral_guided",
    () =>
      oralBeat("kneeling_before_viewer_guided", "the top of her head under the viewer's own hand", {
        guidingHand: true,
      }),
  ],
  ["missionary", missionaryBeat],
]);

/**
 * Beat 1 (orientation, no staging): the complaint in its simplest form. The narration puts her
 * back to the room and the player behind her; today's render turns her around, because nothing
 * in the prompt has ever said where the player's eyes are.
 *
 * The evidence quote is stated on the spec even though a render plan would force the camera
 * outright — once the resolver's clamps land, the beat then passes the real evidence gate on
 * a real quote instead of being waved through.
 */
function behindBeat(): Beat {
  const narration =
    "She is at the stove with her back to the room, stirring something that smells of garlic and wine, humming to herself.";
  const playerMessage = "I cross the kitchen and stop right behind her, close enough to feel the heat off the pan.";
  const context: SceneComposerContext = {
    present: [subject()],
    locationName: "the kitchen",
    locationDescription: "a warm galley kitchen at dusk, copper pans on a rail, one lamp over the stove",
    timeOfDay: "dusk",
    recentNarration: [narration],
    recentPlayerMessages: [playerMessage],
  };
  return {
    summary: "she is at the stove, the player has walked up behind her",
    grading: [
      "her back is to the camera and her face is NOT turned to the lens",
      "she is still recognisably the person in the anchor portrait (hair, build, colouring)",
      "no second person, and no limb in frame that is not hers",
    ],
    context,
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "standing at the stove with her back to the room, weight settled on one hip",
      activity: "stirring the pan, steam rising past her face",
      setting: context.locationDescription,
      lighting: "warm lamplight over the stove",
      mood: "domestic",
      camera: { orientation: "away", distance: "medium", height: "eye_level", evidence: "stop right behind her" },
    }),
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    allowIntimate: false,
  };
}

/**
 * Beat 2 (orientation): the same geometry with the glance the owner ruling makes a separate
 * claim (2026-08-10). The narration here actually describes her looking back, and the quote
 * carries that glance language — so this is the composition `away` is NOT allowed to produce
 * on a behind-position quote alone.
 */
function glanceBeat(): Beat {
  const narration =
    "She stays at the counter with her back to you, and glances back over her shoulder at you with one eyebrow up.";
  const context: SceneComposerContext = {
    present: [subject()],
    locationName: "the kitchen",
    locationDescription: "a narrow galley kitchen, morning light through a slot window",
    timeOfDay: "morning",
    recentNarration: [narration],
    recentPlayerMessages: ["I lean in the doorway and watch her work."],
  };
  return {
    summary: "her back to the viewer, looking back over her shoulder",
    grading: [
      "her back is to the camera AND her face is turned back over her shoulder toward the lens",
      "the face that is visible is the anchor's face",
    ],
    context,
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "standing at the counter with her back to the viewer, chin turned back toward the lens",
      activity: "pausing mid-task to look back at the viewer",
      setting: context.locationDescription,
      lighting: "cool morning light",
      mood: "teasing",
      camera: {
        orientation: "away_glance_back",
        distance: "medium",
        height: "eye_level",
        evidence: "glances back over her shoulder at you",
      },
    }),
    camera: { orientation: "away_glance_back", distance: "medium", height: "eye_level" },
    allowIntimate: false,
  };
}

/**
 * Beat 3 (camera height alone): she kneels, the viewer stands. No staging, clothed, moderated
 * route — so the only thing under test is whether a stated camera height actually tips the
 * shot. It is also the beat the posture derivation covers: `high` needs no quote when the
 * pose the composer already wrote entails it.
 */
function kneelBeat(): Beat {
  const narration =
    "She drops to her knees on the hearth rug, feeding another log into the fire, and looks up at you standing over her.";
  const context: SceneComposerContext = {
    present: [subject({ outfitDescription: "an oversized cardigan and leggings" })],
    locationName: "the sitting room",
    locationDescription: "a low-ceilinged sitting room, a fire just catching in the grate",
    timeOfDay: "night",
    recentNarration: [narration],
    recentPlayerMessages: ["I stay on my feet and watch her build the fire."],
  };
  return {
    summary: "she kneels at the hearth, the viewer stands over her",
    grading: [
      "the camera clearly looks DOWN at her from standing height",
      "she is kneeling and looking up into the lens",
      "the framing is close rather than a room-wide shot",
    ],
    context,
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "kneeling on the hearth rug facing the viewer, sitting back on her heels",
      activity: "feeding a log into the fire, chin tipped up toward the viewer",
      setting: context.locationDescription,
      lighting: "firelight from below, the room dark behind her",
      mood: "quiet",
      camera: { orientation: "toward_viewer", distance: "close", height: "high", evidence: "looks up at you standing over her" },
    }),
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    allowIntimate: false,
  };
}

/**
 * Acceptance scene "Doggy style" (owner-specified 2026-08-10). `on_all_fours` lists `hands`
 * and `forearms` and no anatomy, so a bare persona still puts NO viewer anatomy in this frame
 * — the staging's part list is what keeps it out, not the coverage gate, and the graded
 * elements say the same.
 */
function doggyBeat(): Beat {
  const narration =
    "She crawls forward onto her hands and knees on the bed, arching her back, and your hands settle on her hips as she pushes back against you.";
  const context: SceneComposerContext = {
    present: [
      // `intimateAppearance` rides along on BOTH variants, unchanged, because that is what the
      // pipeline really emits — `sceneRevealAppearance` is derived from her sheet and knows
      // nothing about which way she is facing. On this shot it is defensible (a high angle
      // from behind on all fours can show her front); on a fully-away standing shot it would
      // be a prompt contradicting itself, which is why the away FIXTURE rows omit it.
      subject({
        outfitDescription: "",
        exposure: BARE_BELOW_WAIST,
        wardrobeTracked: true,
        intimateAppearance: "full breasts",
      }),
    ],
    locationName: "the bedroom",
    locationDescription: "a rumpled bed, one lamp left on",
    timeOfDay: "night",
    embodiedViewer: true,
    recentNarration: [narration],
    recentPlayerMessages: ["I take her hips in both hands."],
    playerExposure: PLAYER_BARE,
    playerIntimateAppearance: PLAYER_INTIMATE,
  };
  return {
    summary: "she is on all fours, the viewer behind her",
    grading: [
      "she is on all fours with her back to the camera, face not toward the lens",
      "the viewer's own hands are on her waist or hips, on arms entering from the lower corners",
      "nobody but her and the viewer's own hands and forearms is in frame",
    ],
    context,
    // Cautious, vague, and exactly why the registry owns the act. `viewerBody` carries hands
    // with a verbatim quote, so this is today's BEST case rather than a handicapped one.
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "on the bed, close to the viewer",
      activity: "intimate with the viewer",
      setting: context.locationDescription,
      lighting: "low lamplight",
      mood: "intimate",
      viewerBody: ["hands"],
      viewerBodyEvidence: [{ part: "hands", quote: "your hands settle on her hips" }],
      staging: { id: "on_all_fours", evidence: "she crawls forward onto her hands and knees" },
    }),
    camera: DEFAULT_SCENE_CAMERA,
    staging: stagingEntry("on_all_fours"),
    allowIntimate: true,
  };
}

/**
 * Acceptance scene "Oral", both compositions (either passes). She stays partly dressed on
 * purpose — the entry carries `requiresBare: []` because the bare anatomy this shot needs is
 * the VIEWER's, and that is gated against the player's own coverage.
 *
 * The two oral compositions, and the ONE sentence that separates them.
 *
 * Both beats used to share this narration verbatim, hand-on-head included, and expected two
 * different answers from it. That is unanswerable: `kneeling_before_viewer` and
 * `kneeling_before_viewer_guided` describe the same act and differ only by the viewer's hand
 * resting on her head, so a single story that states the hand supports the guided entry and
 * contradicts the plain one. The 2026-08-15 composer A/B scored the consequence rather than
 * the model — `oral_guided` 0/16 across eight arms, every one of them answering the plain
 * sibling off a story that read as either.
 *
 * So the guided beat states the hand and the plain beat does not, and each expects the entry
 * its own story establishes. `guidingHand` is what makes them a real discrimination test:
 * the composer must notice the distinguishing detail, not merely recognise kneeling.
 */
function oralBeat(id: SceneStagingId, composition: string, opts: { guidingHand: boolean }): Beat {
  const narration = opts.guidingHand
    ? "She sinks to her knees in front of you, takes you into her mouth, and your hand comes to rest on the top of her head."
    : "She sinks to her knees in front of you and takes you into her mouth, her eyes lifting to yours.";
  // The quote must be the phrase establishing THIS entry rather than the act both share —
  // the discrimination the composer rule now asks for, held to by the fixture that grades it.
  const evidence = opts.guidingHand
    ? "your hand comes to rest on the top of her head"
    : "she sinks to her knees in front of you";
  const context: SceneComposerContext = {
    present: [subject({ outfitDescription: "an unbuttoned shirt, nothing under it" })],
    locationName: "the bedroom",
    locationDescription: "a dim bedroom, the bed behind her",
    timeOfDay: "night",
    embodiedViewer: true,
    recentNarration: [narration],
    recentPlayerMessages: ["I stay standing and let her."],
    playerExposure: PLAYER_BARE,
    playerIntimateAppearance: PLAYER_INTIMATE,
  };
  return {
    summary: `she kneels before the viewer — ${composition}`,
    grading: [
      `the graded element for this composition: ${composition}`,
      "the act is legible as the act, not a nude portrait of someone kneeling",
      "nobody but her and the viewer's own body is in frame",
    ],
    context,
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "kneeling close to the viewer",
      activity: "intimate with the viewer",
      setting: context.locationDescription,
      lighting: "one lamp, low",
      mood: "intimate",
      staging: { id, evidence },
    }),
    camera: DEFAULT_SCENE_CAMERA,
    staging: stagingEntry(id),
    allowIntimate: true,
  };
}

/**
 * Acceptance scene "Missionary". The heaviest of the three: it needs her face up at the
 * camera, the viewer's genitals at the bottom frame edge with penetration shown, AND the
 * viewer's hands somewhere on her — three elements one sentence has to hold together.
 */
function missionaryBeat(): Beat {
  const narration =
    "She lies back and pulls you down over her, looking up at you as you push into her, and your hands close around her thighs.";
  const context: SceneComposerContext = {
    present: [
      subject({
        outfitDescription: "",
        exposure: { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" },
        wardrobeTracked: true,
        intimateAppearance: "full breasts",
      }),
    ],
    locationName: "the bedroom",
    locationDescription: "a wide bed, sheets pushed down",
    timeOfDay: "night",
    embodiedViewer: true,
    recentNarration: [narration],
    recentPlayerMessages: ["I hold her legs and lean over her."],
    playerExposure: PLAYER_BARE,
    playerIntimateAppearance: PLAYER_INTIMATE,
  };
  return {
    summary: "she is on her back beneath the viewer",
    grading: [
      "she is on her back facing up at the camera",
      "the viewer's own genitals enter frame at the bottom edge and penetration is visible",
      "the viewer's own hands hold her legs or her waist (either position passes)",
      "nobody but her and the viewer's own body is in frame",
    ],
    context,
    spec: sceneSpecSchema.parse({
      focalCharacter: "Mira",
      pose: "lying close to the viewer",
      activity: "intimate with the viewer",
      setting: context.locationDescription,
      lighting: "low lamplight",
      mood: "intimate",
      viewerBody: ["hands"],
      viewerBodyEvidence: [{ part: "hands", quote: "your hands close around her thighs" }],
      staging: { id: "lying_beneath_viewer", evidence: "she lies back and pulls you down over her" },
    }),
    camera: DEFAULT_SCENE_CAMERA,
    staging: stagingEntry("lying_beneath_viewer"),
    allowIntimate: true,
  };
}
