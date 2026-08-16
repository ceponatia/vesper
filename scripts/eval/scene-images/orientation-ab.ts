import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SCENE_CAMERA,
  type SceneCameraSpec,
  sceneSubjectOrientationById,
} from "@/contracts/images/scene-camera";
import { sceneStagingById, type SceneStaging, type SceneStagingId } from "@/contracts/images/scene-staging";
import { resolveViewerParts, type ViewerBodyPartId } from "@/contracts/images/viewer-body";
import type { RegionExposure } from "@/contracts/items/visibility";
import {
  buildSceneRenderPrompt,
  resolveScenePlan,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneRenderPlan,
  type SceneSpec,
  sceneSpecSchema,
} from "@/server/images";
import { evalEdit, hasImageProvider } from "./model";

/**
 * Orientation & staging A/B (scene-composition.plan.md slices 1–2, NOT a test gate):
 * the complaint is that every chat scene image comes back front-facing whatever the story
 * says, and during intimate play the render is a nude portrait — right person, right room,
 * wrong moment (owner report 2026-08-10). Each beat below renders the SAME resolved plan
 * twice, as Qwen edits of an identity portrait, changing exactly one thing.
 *
 * Variants:
 * - `old` — today's prompt: `DEFAULT_SCENE_CAMERA` and no staging, so no shot line and no
 *   staged act. Whatever this build's resolver made of the beat's camera is overwritten back
 *   to the default, so `old` stays the pre-slice baseline even after the clamps land.
 * - `new` — the beat's camera, plus its staging entry where it has one (the registry's own
 *   camera and viewer parts, per spec §Resolution step 5).
 *
 * Both variants run the same route with the same `allowIntimate`, so the only difference is
 * the shot. The pose/activity text is written in the CAUTIOUS register the composer really
 * produces during intimate play ("close to the viewer") — that is the reported failure rather
 * than a strawman, and it is what the staging sentence has to carry the shot past.
 *
 * Beats (`AB_BEAT`), the first three preference-ranked, the last four graded pass/fail:
 * - `behind` (default) — she is at the stove, the player has walked up behind her. Camera
 *   `{away, medium, eye_level}`, no staging. Pass = her back to the camera, face not turned
 *   to the lens, and still recognisably her from the anchor.
 * - `glance` — the same room with the narration actually describing the glance back. Camera
 *   `{away_glance_back, medium, eye_level}`. Pass = back to the camera AND her face turned
 *   back over her shoulder — the composition the `away` ruling makes earn its own evidence.
 * - `kneel` — camera HEIGHT alone: she kneels at the hearth, the viewer stands. Camera
 *   `{toward_viewer, close, high}`, no staging, clothed, moderated route. Pass = the camera
 *   looks down at her and she looks up into it.
 *
 * The three acceptance scenes (owner-specified 2026-08-10, uncensored route only). Each is
 * graded pass/fail on visible elements, and fails on ANY missing element, any extra person,
 * or an unbound limb readable as a third party:
 * - `doggy` — staging `on_all_fours`. Elements: she is on all fours facing away from the
 *   camera; the viewer's own hands rest on her waist or hips.
 * - `oral` — staging `kneeling_before_viewer` (composition A). Element: her face is visible
 *   looking up as she goes down on the viewer.
 * - `oral_guided` — staging `kneeling_before_viewer_guided` (composition B). Element: the
 *   shot looks down on the top of her head with the viewer's hand resting on it. **Either
 *   composition passes the owner's "Oral" scene** — the two beats exist so both can be seen.
 * - `missionary` — staging `lying_beneath_viewer`. Elements: she lies on her back beneath the
 *   camera looking up at the viewer; the viewer's genitals enter frame at the bottom edge with
 *   penetration shown; the viewer's hands hold her legs OR her waist (either position passes).
 *
 * The coverage gate is REAL here, not bypassed: the beats that need the viewer's anatomy set
 * a persona exposure that leaves the pelvis bare, and `buildSceneRenderPrompt` still runs
 * every staged part through `resolveViewerParts`. A beat whose parts do not survive that gate
 * throws rather than paying for a render that cannot show what it is graded on.
 *
 * Outputs land in the untracked screenshots/ folder for eyeball review.
 * Run: `pnpm tsx scripts/eval/scene-images/orientation-ab.ts [anchor.webp] [variants]`
 * (AB_RUNS=n runs per variant, AB_BEAT=behind|glance|kneel|doggy|oral|oral_guided|missionary).
 */
const OUT = "screenshots/orientation-ab";
/** Reference portrait: argv override for ad-hoc anchors; the eval portrait (untracked, regenerable) by default. */
const ANCHOR = process.argv[2] ?? "docs/scene-image-eval/portraits/Mira.webp";
const RUNS_PER_VARIANT = Number(process.env.AB_RUNS ?? 2);
const BEAT = process.env.AB_BEAT ?? "behind";

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
 * EXPORTED for `intimate-model-ab.ts`, which grades the same four intimate beats across
 * several models. The beats are the acceptance scenes themselves, so a second probe must
 * reuse these definitions rather than paraphrase them — two probes disagreeing about what
 * "doggy" is would make their gradings incomparable.
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
 * rather than an object so the ids stay the env-var spellings the header documents.
 *
 * EXPORTED alongside {@link Beat} for `intimate-model-ab.ts` — see that note.
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
 * The evidence quote is stated on the spec even though the plan below forces the camera
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
      // pipeline really emits — `intimateSceneAppearance` is derived from her sheet and knows
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
    // The composer's real output for a beat like this: cautious, vague, and exactly why the
    // registry owns the act. `viewerBody` carries hands with a verbatim quote, so `old` is
    // today's BEST case rather than a handicapped one.
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
 */
/**
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

/** Order-preserving union — the staging's parts joining whatever the composer's own gate grounded. */
function unionParts(base: readonly ViewerBodyPartId[], extra: readonly ViewerBodyPartId[]): ViewerBodyPartId[] {
  const out = [...base];
  for (const id of extra) if (!out.includes(id)) out.push(id);
  return out;
}

/** `{name}` templates bound to the subject, the way the render layer binds them. */
function bindName(template: string, name: string): string {
  return template.replaceAll("{name}", name);
}

function promptsFor(beat: Beat): Record<string, string> {
  const resolved = resolveScenePlan(beat.spec, beat.context);
  const name = resolved.focal?.name;
  if (!name) throw new Error("beat resolved with no focal character — its roster and spec disagree");

  // TODAY'S SHOT, forced: the front-facing default and no staging, whatever this build's
  // resolver did with `spec.camera`.
  const oldPlan: SceneRenderPlan = { ...resolved, camera: { ...DEFAULT_SCENE_CAMERA }, staging: undefined };
  const newPlan: SceneRenderPlan = {
    ...resolved,
    camera: { ...(beat.staging?.camera ?? beat.camera) },
    ...(beat.staging ? { staging: beat.staging } : {}),
    // Spec §Resolution step 5: a surviving staging unions its parts into the plan. They are
    // NOT gated here — `buildSceneRenderPrompt` runs them through `resolveViewerParts` against
    // the persona's coverage and this route's `allowIntimate`, which is where the gate belongs.
    viewerBody: unionParts(resolved.viewerBody, beat.staging?.viewerParts ?? []),
  };

  const opts = { referenceName: name, allowIntimate: beat.allowIntimate };
  const prompts = { old: buildSceneRenderPrompt(oldPlan, opts), new: buildSceneRenderPrompt(newPlan, opts) };
  assertProbeIsHonest(beat, newPlan, prompts, name);
  return prompts;
}

/**
 * Refuse to pay for an inert A/B. Four ways this run would prove nothing, each a loud throw
 * rather than a render bill:
 *
 * 1. the two prompts are identical — the emission this probe measures is not in the build;
 * 2. a non-default orientation never reached the prompt — the shot line was dropped;
 * 3. the staged sentence never reached the prompt — the staging was dropped or reworded;
 * 4. a graded viewer part did not survive the real coverage/route gate — the shot cannot show
 *    the anatomy it is graded on, and grading it would be grading the persona's wardrobe.
 *
 * Checks 2 and 3 look for the REGISTRY's own text verbatim, which is exactly the contract:
 * the registries own every phrase, and nothing between them and the prompt may rewrite one.
 */
function assertProbeIsHonest(beat: Beat, plan: SceneRenderPlan, prompts: Record<string, string>, name: string): void {
  const next = prompts.new ?? "";
  if (prompts.old === next) {
    throw new Error(
      "old and new prompts are identical — the shot line / staging emission is not in this build (scene-composition slices 1–2), so the A/B would render the same prompt twice",
    );
  }

  // Only the ORIENTATION is asserted, and only when it is non-default: distance and height
  // may or may not be spelled out for a shot that moved only one of the three, and this probe
  // has no business pinning that choice.
  const orientationId = plan.camera.orientation;
  if (orientationId !== DEFAULT_SCENE_CAMERA.orientation) {
    const phrase = bindName(sceneSubjectOrientationById(orientationId)?.phrase ?? "", name);
    if (!phrase || !next.includes(phrase)) {
      throw new Error(
        `the "${orientationId}" orientation phrase is missing from the new prompt — expected the registry phrase verbatim: "${phrase}"`,
      );
    }
  }

  if (!beat.staging) return;
  const staged = bindName(beat.staging.template, name);
  if (!next.includes(staged)) {
    throw new Error(
      `the staging sentence is missing from the new prompt — expected the registry template verbatim: "${staged}". Either the staging was dropped, or the emitter rewords the template (in which case fix this check, not the registry).`,
    );
  }
  const gated = resolveViewerParts({
    proposed: plan.viewerBody,
    ...(plan.playerExposure ? { exposure: plan.playerExposure } : {}),
    allowIntimate: beat.allowIntimate,
  }).map((part) => part.id);
  const blocked = beat.staging.viewerParts.filter((id) => !gated.includes(id));
  if (blocked.length > 0) {
    throw new Error(
      `staged viewer parts blocked by the real gate: ${blocked.join(", ")} — the persona's coverage or this route's allowIntimate is keeping the graded anatomy out of frame`,
    );
  }
}

async function main(): Promise<void> {
  const build = BEATS.get(BEAT);
  if (!build) {
    throw new Error(`unknown beat "${BEAT}" — have: ${[...BEATS.keys()].join(", ")}`);
  }
  const beat = build();
  const prompts = promptsFor(beat);
  const variants = process.argv[3] ? process.argv[3].split(",") : Object.keys(prompts);

  console.log(`\n=== ${BEAT} — ${beat.summary} ===`);
  console.log(`Grading:\n${beat.grading.map((line) => `  - ${line}`).join("\n")}`);
  for (const variant of variants) {
    const prompt = prompts[variant];
    if (!prompt) {
      console.error(`unknown variant "${variant}" for beat "${BEAT}" — have: ${Object.keys(prompts).join(", ")}`);
      continue;
    }
    console.log(`\n--- ${BEAT} / ${variant} prompt ---\n${prompt}\n`);
  }

  // The prompts are free and are half of what this probe is for; only the renders cost money.
  if (!hasImageProvider()) {
    console.log("REPLICATE_API_TOKEN not set — prompts printed above, renders skipped.");
    return;
  }

  const reference = await fs.readFile(ANCHOR);
  await fs.mkdir(OUT, { recursive: true });
  for (const variant of variants) {
    const prompt = prompts[variant];
    if (!prompt) continue;
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const result = await evalEdit(prompt, [reference]);
      if (!result.ok || !result.image) {
        console.error(`${variant} run ${run} FAILED: ${result.error ?? "no image"}`);
        continue;
      }
      const file = path.join(OUT, `${BEAT}-${variant}-${run}.webp`);
      await fs.writeFile(file, result.image);
      console.log(`${variant} run ${run} → ${file}`);
    }
  }
}

// Run ONLY as the process entry point. `intimate-model-ab.ts` imports the beat factories
// above, and a module-level `main()` would make that import fire a full PAID orientation
// run as an import side effect. Invoked directly the behavior is unchanged.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
