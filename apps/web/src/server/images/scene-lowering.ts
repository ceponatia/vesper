import type {
  ImageCameraFact,
  ImageLocationDigest,
  ImageSourceRef,
  ImageWorldFact,
  SceneCaptureMode,
} from "@vesper/image-core";
import type { VisualSceneLightingBand } from "@/contracts";
import type { AttributeValue } from "@/contracts/attributes/value";
import type { CharacterCameraAssemblyInput } from "@/contracts/images/character-digest";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { DEFAULT_SCENE_CAMERA } from "@/contracts/images/scene-camera";
import { sceneStagingSurfaceForms } from "@/contracts/images/scene-staging";
import { resolveViewerParts, type ViewerBodyPart, type ViewerBodyPartId } from "@/contracts/images/viewer-body";
import { viewerBodyFacts } from "@/contracts/images/viewer-digest";
import type { RealizedBody } from "@/contracts/species";
import { normalizeName, type SceneCharacterSpec, type SceneRenderPlan } from "./prompts-scene-plan";

/**
 * THE LOWERING: a resolved `SceneRenderPlan` → the typed inputs a prompt program
 * compiles (issue #388).
 *
 * The composer decides the scene, the registries own the wording that was
 * measured, the dialects decide how an endpoint says any of it — and this module
 * is the one step between the first and the last. It states what is TRUE about
 * the shot in the compiler's own vocabulary and stops there: it writes no
 * sentence, picks no endpoint, and reads nothing but the plan it was handed.
 *
 * Three things come out, because the digest takes scene facts, an entity slice
 * and camera facts through three different doors:
 *
 * - **scene facts** — the mood, whose eyes the shot is through, the possession
 *   binding, the staged arrangement, each featured person's pose and activity,
 *   and the viewer's own body where the frame crops it in. The viewer's facts
 *   ride this list on their own channel: they describe a body that is in frame
 *   without being in the cast, so they are neither a subject slice nor a
 *   member of `operation.subjectCount`;
 * - **an ephemeral location digest** — the setting and its light, as a place the
 *   digest carries for this render only;
 * - **camera facts** — the height nothing else can state, plus which components
 *   this shot asserts nothing about.
 *
 * ## Absence is an instruction here, in three places
 *
 * 1. **A default camera component is not lowered.** `toward_viewer` + `medium` +
 *    `eye_level` is what "no evidence moved the camera" resolves to, so a shot
 *    that resolved it says nothing about where the lens is — exactly as the
 *    retired prose builder emitted no shot line for it. The suppression lives
 *    HERE and only here: `image-core` must never synthesize a camera from
 *    absence, because a compiler-side default would silently assert a front-on
 *    waist-up frame on every scene the fiction never framed.
 * 2. **An absent capture decision means FIRST PERSON, not third.** In this lane
 *    a render option is only ever `selfie` or unset, and unset has always meant
 *    the player's own eyes. `scene-ir` deliberately carries no default capture
 *    mode so that no lowering can spell `framing ?? default` and invert every
 *    chat scene into an observing camera.
 * 3. **A scene with no light says nothing about light.** The visual lane's
 *    `bright` is a declared release placeholder, and a placeholder that reaches
 *    a prompt is a lie about a night scene. The scene owns this fact: its own
 *    phrase travels as `location.lighting`, and the camera lighting fact is
 *    silenced so a coarse three-band restatement can never contradict it.
 *
 * PURE over its inputs — no IO, no env, no clock. Diagnostics, never exceptions.
 */

/** The projection owner every fact this module writes carries. */
export const IMAGE_SCENE_PLAN_OWNER = "image.scene_plan";

/** The ephemeral place this render is set in — one per digest, never a library row. */
const SCENE_LOCATION_REF = "location.scene";

/** A staged arrangement was gated out of the prompt after the plan committed it. */
export const IMAGE_SCENE_STAGING_UNSENT = "images.scene_lowering.staging_unsent";

/** A camera component a lane may state a fact for, or declare itself silent about. */
type SceneCameraComponent = ImageCameraFact["component"];

/** One person the compiled program actually carries — a committed cut, by name. */
export interface SceneLoweringCastMember {
  readonly subjectId: string;
  readonly name: string;
}

/**
 * The VIEWER, as a render input beside the cast rather than a member of it.
 *
 * Beside `cast` and not on the plan, because it is the same kind of thing: the
 * plan is what the scene DECIDED (which parts the frame holds, what coverage
 * gates them), and this is the realized source those decisions are stated from —
 * the persona's own resolved sheet, exactly as a cast member's cut is theirs.
 *
 * Absent states no viewer body facts at all. That is the honest answer for a
 * caller with no persona behind the lens (the staged lab bench, a bare test
 * render): the geometry the frame holds is still stated, and nothing invents a
 * body to hang on it.
 */
export interface SceneLoweringViewer {
  /** The persona's resolved attributes — the viewer's own skin, build and anatomy. */
  readonly attributes: readonly AttributeValue[];
  /** Applicability: a body without the region states nothing about it. */
  readonly realizedBody?: RealizedBody;
}

export interface SceneLoweringInput {
  readonly plan: SceneRenderPlan;
  /**
   * The cast the digest carries, in cast order. A plan spec with no cut is not
   * lowered: the program has no subject for it, so a fact naming one would point
   * at nobody and compile as "The subject is …".
   */
  readonly cast: readonly SceneLoweringCastMember[];
  /**
   * This rung's intimate permission. Per rung rather than per plan because the
   * ladder's rungs disagree — the uncensored reference edit carries explicit
   * anatomy and the text-to-image fallback does not — and one resolved plan
   * feeds both.
   */
  readonly allowIntimate: boolean;
  /**
   * The person behind the lens. Absent ⇒ an embodied frame still states its own
   * geometry and says nothing about whose body it is.
   */
  readonly viewer?: SceneLoweringViewer;
  readonly sink?: DiagnosticSink;
}

/** The three doors a resolved scene enters the world digest through. */
export interface SceneProgramInputs {
  readonly scene: readonly ImageWorldFact[];
  readonly location: ImageLocationDigest | null;
  readonly camera: CharacterCameraAssemblyInput;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/**
 * Words that put a lighting phrase in a band, checked darkest first.
 *
 * A deliberately blunt lexical check in the `BLUSH_WORDS` / `GLANCE_WORDS`
 * family: the composer writes free text, the visibility model wants a band, and
 * a second model call to bridge them would be a coin flip wearing a
 * measurement's name. Darkest first because a phrase naming both ends ("a single
 * candle against the dark") is the darker one — the band decides how much detail
 * an observer can resolve, and over-reading the light is the failure that costs
 * a render its subject.
 *
 * No match is a real answer, not a gap: an unclassifiable phrase leaves the band
 * unstated, the phrase itself still reaches the prompt, and nothing invents a
 * claim about visibility from prose it could not read.
 *
 * The bare word `dark` is in the darkest band rather than only its compounds.
 * "a dark room" is the plainest way a composer says this, and leaving it
 * unclassified is not a neutral outcome: an unstated band leaves the release's
 * declared `bright` placeholder standing, so the digest would select detail at
 * the bright tier for a scene that said the opposite. This field is a lighting
 * phrase, so `dark` here is never a hair or a fabric.
 */
const DARK_LIGHTING = /\b(dark\w*|pitch[-\s]?black|unlit|blacked[-\s]?out|starless|lightless)\b/i;
const DIM_LIGHTING =
  /\b(dim\w*|low[-\s]light|dusk|twilight|gloom\w*|murk\w*|candle\w*|firelit|firelight|lamplight|lamplit|lantern\w*|moonlit|moonlight|shadow\w*|overcast|night|nighttime|night-time|evening)\b/i;
const BRIGHT_LIGHTING =
  /\b(bright\w*|sunlit|sunlight|sunny|daylight|midday|noon|morning|afternoon|dawn|glare|glaring|floodlit|fluorescent|blazing|harsh)\b/i;

/**
 * The band a scene's lighting phrase asserts, or null when the words decide
 * nothing.
 *
 * `silhouette` is unreachable by construction — the return type excludes it —
 * because backlighting is a statement about where the camera stands relative to
 * a light source, and a scene states how a place is lit.
 */
export function sceneLightingBand(lighting: string): VisualSceneLightingBand | null {
  const text = lighting.trim();
  if (text.length === 0) return null;
  if (DARK_LIGHTING.test(text)) return "dark";
  if (DIM_LIGHTING.test(text)) return "dim";
  if (BRIGHT_LIGHTING.test(text)) return "bright";
  return null;
}

// ---------------------------------------------------------------------------
// The lowering
// ---------------------------------------------------------------------------

export function lowerScenePlan(input: SceneLoweringInput): SceneProgramInputs {
  const { plan, cast } = input;
  const refByName = new Map(cast.map((member) => [normalizeName(member.name), `subject.${member.subjectId}`]));
  const featured: readonly SceneCharacterSpec[] = [...(plan.focal ? [plan.focal] : []), ...plan.others];
  const focalRef = plan.focal === null ? undefined : refByName.get(normalizeName(plan.focal.name));

  // Embodiment is decided ONCE, here, and both the framing sentence and the
  // possession clause read the same answer. Deciding them separately is exactly
  // how a prompt comes to say the viewer is never visible and then describe the
  // viewer's own hands on somebody.
  const inFrame = viewerPartsInFrame(input);
  const captureMode = resolveCaptureMode(plan, inFrame);
  const staging = stagingFact(input, focalRef);

  const facts: ImageWorldFact[] = [
    captureModeFact(captureMode, focalRef),
    ...possessionFact(captureMode, featured, refByName),
    ...moodFact(plan.mood),
    ...staging,
    ...viewerFacts(input, captureMode, inFrame, stagedGeometryOwned(input, staging)),
    ...featured.flatMap((spec) => actionFacts(spec, refByName.get(normalizeName(spec.name)))),
  ];

  return { scene: facts, location: sceneLocationDigest(plan), camera: sceneCameraInput(plan) };
}

function source(key: string): ImageSourceRef {
  return { owner: IMAGE_SCENE_PLAN_OWNER, key };
}

/**
 * Whose camera this is — the first thing the shot has to settle.
 *
 * `required_visual` rather than optional, and the only scene fact that is: this
 * is the anchor of the measured POV composite (the viewpoint claim, the person
 * count, the possession clause, and the pose text's own bound limbs), and a
 * budget squeeze that dropped it would leave the other three arguing about a
 * frame nobody described. The mandatory flag rides the FACT, because the
 * `framing` segment kind is droppable by kind and must stay that way — a scene
 * is the layer that gives way before a character stops being recognizable.
 */
function captureModeFact(mode: SceneCaptureMode, focalRef: string | undefined): ImageWorldFact {
  return {
    key: "scene.capture_mode",
    concept: "scene.capture_mode",
    value: mode,
    // The selfie wording names the person holding the phone; the POV wording
    // names nobody. Binding the focal either way costs the POV shot nothing and
    // is what lets a selfie say whose arm the camera is on.
    ...(focalRef === undefined ? {} : { subjectRef: focalRef }),
    semanticTags: [`capture_mode:${mode}`],
    disposition: "required_visual",
    priority: 1,
    source: source("capture_mode"),
  };
}

/**
 * "Every visible body part belongs to Nyx." — the possession binding, as refs.
 *
 * ABSTRACT by construction: the value is a list of entity refs and the dialect
 * turns them into names, so there is no place in this fact for a limb noun. That
 * is the measured half — an enumerated draft ("every hand, arm, leg and foot…")
 * painted a phantom viewer hand anyway, because a limb noun summons a limb even
 * when it is possessively bound.
 *
 * First-person only. A selfie has the subject's own arm holding the lens and an
 * observing camera has no viewer in the room, so the clause would be binding
 * limbs against a frame that never risked an unowned one.
 *
 * Optional rather than required, unlike the capture mode: the clause is worth
 * nothing without names, the names come from labels this module cannot see, and
 * a label gap must degrade the sentence rather than fail the render.
 */
function possessionFact(
  mode: SceneCaptureMode,
  featured: readonly SceneCharacterSpec[],
  refByName: ReadonlyMap<string, string>,
): readonly ImageWorldFact[] {
  if (mode !== "first_person_disembodied") return [];
  const owners = featured
    .filter((spec) => spec.name.trim().length > 0)
    .map((spec) => refByName.get(normalizeName(spec.name)))
    .filter((ref): ref is string => ref !== undefined);
  if (owners.length === 0) return [];
  return [
    {
      key: "scene.possession",
      concept: "scene.possession",
      value: owners,
      semanticTags: ["pov:possession"],
      disposition: "optional_visual",
      priority: 0.95,
      source: source("possession"),
    },
  ];
}

/**
 * How the moment feels — the composer's own phrase, unwrapped.
 *
 * A scene fact rather than a location one because the same bedroom is cheerful
 * in one render and threatening in the next: filing mood against the place would
 * make it a property of the room.
 */
function moodFact(mood: string): readonly ImageWorldFact[] {
  const value = mood.trim();
  if (value.length === 0) return [];
  return [
    {
      key: "scene.mood",
      concept: "scene.mood",
      value,
      semanticTags: [],
      disposition: "optional_visual",
      priority: 0.6,
      source: source("mood"),
    },
  ];
}

/**
 * The staged arrangement, carrying the registry's measured wording.
 *
 * The value IS the surface form — the arrangement, the revision the measurements
 * apply to, and the digest proving which bytes that revision meant — so the
 * dialect that adopts the sentence and the dialect that words its own are both
 * visible at their call sites.
 *
 * Every gate the retired prose builder ran per prompt runs here, because the
 * plan committed the arrangement once and each rung asks for a different render:
 *
 * - a **selfie** has no viewer standing anywhere for a two-body geometry;
 * - an **intimate** arrangement travels only a route that permits it;
 * - every viewer part the template NAMES must survive the coverage gate, all or
 *   nothing. That last one is the leak-proofing: a template speaks the viewer's
 *   anatomy in its own words, so an arrangement that emitted while
 *   `resolveViewerParts` dropped a covered player's part would smuggle past the
 *   very coverage rule the phrasing is checked by.
 */
function stagingFact(input: SceneLoweringInput, focalRef: string | undefined): readonly ImageWorldFact[] {
  const { plan, sink } = input;
  const staging = plan.staging;
  if (staging === undefined) return [];
  const blocked =
    plan.captureMode === "selfie"
      ? "selfie"
      : focalRef === undefined
        ? "no_focal_subject"
        : staging.intimate && !input.allowIntimate
          ? "route_disallows_intimate"
          : stagedPartsInFrame(input) === false
            ? "viewer_parts_out_of_frame"
            : null;
  if (blocked !== null) {
    sink?.push(
      diag("info", IMAGE_SCENE_STAGING_UNSENT, "a committed staging is not stated on this render", {
        context: { staging: staging.id, reason: blocked },
      }),
    );
    return [];
  }
  return [
    {
      key: "scene.staging",
      concept: "scene.staging",
      value: sceneStagingSurfaceForms.formFor(staging.id),
      ...(focalRef === undefined ? {} : { subjectRef: focalRef }),
      semanticTags: [`staging:${staging.id}`, `staging_cast:${staging.cast}`],
      // The arrangement IS the shot on the render it survives to. A scene that
      // silently lost it renders as an ordinary portrait of an intimate beat,
      // which is the failure the whole staging vocabulary exists to end.
      disposition: "required_visual",
      priority: 1,
      source: source(`staging.${staging.id}`),
    },
  ];
}

/**
 * Every viewer part that survives THIS rung's route and coverage gates.
 *
 * Per rung rather than per render: `allowIntimate` differs between the uncensored
 * edit rung and its moderated fallback, so a part in frame on one is not in frame
 * on the other, and a shot's embodiment follows it.
 */
function viewerPartsInFrame(input: SceneLoweringInput): readonly ViewerBodyPart[] {
  return resolveViewerParts({
    proposed: input.plan.viewerBody,
    ...(input.plan.playerExposure ? { exposure: input.plan.playerExposure } : {}),
    allowIntimate: input.allowIntimate,
  });
}

/**
 * Which first-person shot this is — the distinction the framing contract turns on.
 *
 * A surviving viewer part makes the shot EMBODIED, and a part whose geometry a
 * staging sentence owns counts exactly as much as one the generic carrier would
 * have worded. The arrangement still says "the viewer's own hands on her
 * shoulders" whether or not anything else describes those hands, so a frame that
 * asserted the viewer's absence beside it would contradict itself in the same
 * prompt.
 *
 * The plan carries the ROUTE decision — a selfie is a selfie on every rung — and
 * this refines the first-person case per rung, because coverage and the intimate
 * route decide which parts are in frame and those differ down the chain.
 */
function resolveCaptureMode(plan: SceneRenderPlan, inFrame: readonly ViewerBodyPart[]): SceneCaptureMode {
  if (plan.captureMode === "selfie" || plan.captureMode === "third_person") return plan.captureMode;
  return inFrame.length > 0 ? "first_person_embodied" : "first_person_disembodied";
}

/**
 * The viewer's own body, stated only where the frame actually holds it.
 *
 * Gated on the resolved capture mode rather than on the part list, and the two
 * are not the same question: a selfie's camera is on the SUBJECT's arm, so a
 * viewer part the plan proposed describes nobody in that frame, and an observing
 * camera has no viewer in the room at all. `first_person_embodied` is by
 * construction the only mode reached with a part in frame, so this states the
 * rule the mode already encodes rather than re-deriving it from the list.
 *
 * The gates ran upstream: `viewerPartsInFrame` is `resolveViewerParts`, so an
 * unknown id, an intimate part on a moderated rung, and a part whose region does
 * not read bare or sheer have all already dropped, with missing coverage
 * counting as covered. Nothing here re-decides any of it.
 */
function viewerFacts(
  input: SceneLoweringInput,
  mode: SceneCaptureMode,
  inFrame: readonly ViewerBodyPart[],
  stagedParts: readonly ViewerBodyPartId[],
): readonly ImageWorldFact[] {
  if (mode !== "first_person_embodied") return [];
  return viewerBodyFacts({
    parts: inFrame,
    stagedParts,
    ...(input.viewer ? { attributes: input.viewer.attributes } : {}),
    ...(input.viewer?.realizedBody ? { realizedBody: input.viewer.realizedBody } : {}),
    ...(input.plan.playerExposure ? { exposure: input.plan.playerExposure } : {}),
    allowIntimate: input.allowIntimate,
  });
}

/**
 * The viewer parts whose geometry a staged sentence in THIS render owns.
 *
 * Read off the staging fact that was actually emitted, never off the plan: an
 * arrangement the rung withheld — for the route, for a selfie, for coverage —
 * words nothing, so its parts are unowned and the generic geometry line is the
 * only thing left that can place them. Taking the plan's list instead would
 * silently delete the foreground of every render whose staging did not survive.
 */
function stagedGeometryOwned(
  input: SceneLoweringInput,
  staging: readonly ImageWorldFact[],
): readonly ViewerBodyPartId[] {
  return staging.length === 0 ? [] : (input.plan.staging?.viewerParts ?? []);
}

/** Whether every viewer part the arrangement names survives this route's coverage gate. */
function stagedPartsInFrame(input: SceneLoweringInput): boolean {
  const staging = input.plan.staging;
  if (staging === undefined) return false;
  const inFrame = viewerPartsInFrame(input);
  return staging.viewerParts.every((id) => inFrame.some((part) => part.id === id));
}

/**
 * One person's pose and activity, as two facts.
 *
 * Two rather than one because the composer produces two, and collapsing them
 * loses the distinction for good: how a body is HELD and what it is DOING answer
 * different questions, and a plan that joined them left the acting half of every
 * scene with no concept of its own. Both land in the same prompt segment, so the
 * split costs the output nothing and buys the provenance back.
 *
 * A person with no committed cut is skipped: nothing else in the program
 * describes them, so an action filed against a subject the digest does not carry
 * would compile as a sentence about "the subject".
 *
 * These ride the digest's flat SCENE list rather than the subject's own slice,
 * even though they name a subject. A subject slice is what the committed cut
 * says a person IS; an action is what the composer decided they are doing in
 * this shot, and it has neither the cut's provenance nor its lifetime. Emission
 * is identical either way — claims are ordered by the CONCEPT's channel, not by
 * the list a fact travelled in — so the choice buys honest provenance and costs
 * the prompt nothing.
 */
function actionFacts(spec: SceneCharacterSpec, subjectRef: string | undefined): readonly ImageWorldFact[] {
  if (subjectRef === undefined) return [];
  const parts: readonly [string | undefined, ImageWorldFact["concept"], string][] = [
    [spec.pose, "subject.body_language", "pose"],
    [spec.activity, "subject.activity", "activity"],
  ];
  return parts.flatMap(([value, concept, member]) => {
    const text = (value ?? "").trim();
    if (text.length === 0) return [];
    return [
      {
        key: `${subjectRef}.scene_${member}`,
        concept,
        value: text,
        subjectRef,
        semanticTags: [],
        disposition: "optional_visual",
        priority: 0.75,
        source: source(member),
      } satisfies ImageWorldFact,
    ];
  });
}

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

/**
 * The setting as a place the digest carries — an ephemeral entity slice, modelled
 * on `projectLocationDigest` and deliberately not one of its rows.
 *
 * A chat scene's setting is the composer's phrase, falling back to the location
 * library's name and description; there is no row behind it and no revision to
 * record, so nothing here mints a source revision or a read token.
 *
 * `location.contents` rather than `location.identity`: the identity concept sits
 * in the mandatory `identity` segment kind because a LOCATION render's subject
 * is the place. Here the subject is a person, and a free-text setting filed as
 * identity would be a paragraph no budget squeeze could ever drop while a face
 * was compressed to make room for it.
 */
function sceneLocationDigest(plan: SceneRenderPlan): ImageLocationDigest | null {
  const setting = plan.setting.trim();
  const lighting = plan.lighting.trim();
  const facts: ImageWorldFact[] = [];
  if (setting.length > 0) {
    facts.push({
      key: `${SCENE_LOCATION_REF}.setting`,
      concept: "location.contents",
      value: setting,
      semanticTags: [],
      disposition: "optional_visual",
      priority: 0.85,
      source: source("setting"),
    });
  }
  if (lighting.length > 0) {
    facts.push({
      key: `${SCENE_LOCATION_REF}.lighting`,
      concept: "location.lighting",
      value: lighting,
      semanticTags: [],
      disposition: "optional_visual",
      priority: 0.8,
      source: source("lighting"),
    });
  }
  if (facts.length === 0) return null;
  return {
    kind: "location",
    ref: SCENE_LOCATION_REF,
    entityId: "scene",
    // Nothing points at this place — a scene states no relation into it — so the
    // label is what a sentence would call it if one ever did.
    label: "the setting",
    facts,
    morphology: [],
    missingRequired: [],
  };
}

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/**
 * What this shot says about the lens, and what it deliberately does not.
 *
 * Only the components that MOVED are stated. The committed cut's own viewing
 * context already carries a distance, an angle and a framing derived from this
 * very camera, so a default component would arrive as an assertion that the
 * fiction never made — which is exactly the regression the retired builder's
 * "no shot line for the default camera" rule prevented.
 *
 * `distance` and `framing` are silenced together because both are read off ONE
 * shot distance: keeping the crop while dropping the reach would leave half a
 * camera standing.
 *
 * Height is the one component nothing upstream can supply — the visibility model
 * weights detail by distance, angle and light, and how high the lens sits
 * changes none of that — so it enters as a fact here rather than as a visibility
 * read the model would have to invent a weighting table for.
 *
 * `lighting` is always silent. The scene owns its light and states it in the
 * composer's own words through `location.lighting`; a three-band restatement
 * beside that phrase can only agree redundantly or contradict it, and the band
 * the visual lane holds is a declared release placeholder whenever the scene
 * said nothing.
 */
function sceneCameraInput(plan: SceneRenderPlan): CharacterCameraAssemblyInput {
  const silent: SceneCameraComponent[] = ["lighting"];
  if (plan.camera.orientation === DEFAULT_SCENE_CAMERA.orientation) silent.push("angle");
  if (plan.camera.distance === DEFAULT_SCENE_CAMERA.distance) silent.push("distance", "framing");
  const facts: ImageCameraFact[] =
    plan.camera.height === DEFAULT_SCENE_CAMERA.height
      ? []
      : [{ component: "height", band: plan.camera.height, source: source("camera.height") }];
  return { ...(facts.length === 0 ? {} : { facts }), silent };
}
