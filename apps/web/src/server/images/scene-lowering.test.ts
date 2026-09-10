import { describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED,
  QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import {
  emptyGarmentCueState,
  visualStateGarmentFixture,
  visualStateLocusKey,
  visualStateSceneFixture,
  VISUAL_STATE_SCENE_NPC,
  VISUAL_STATE_SCENE_PLAYER,
  type ChatGarmentStore,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characterSceneImageOperation } from "@/contracts/images/character-digest";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import { realizeBody } from "@/contracts/species";
import {
  DEFAULT_SCENE_CAMERA,
  sceneSubjectOrientationById,
  type SceneSubjectOrientationId,
} from "@/contracts/images/scene-camera";
import { sceneStagings, type SceneStaging } from "@/contracts/images/scene-staging";
import type { ViewerBodyPartId } from "@/contracts/images/viewer-body";
import { safeBuildVisualStateShadow } from "@/server/visual-state";
import {
  expectOrder,
  expectSections,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_SUBJECT_ID,
  LANE_PROBE_SUBJECT_ID,
  laneProbeCastMember,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
  laneProbeShadowInput,
  type LaneProbeCastSubject,
} from "@/server/test-support";
import {
  buildCharacterPromptProgram,
  isCharacterPromptCompiled,
  type CharacterPromptProgram,
  type CharacterPromptReference,
} from "./character-prompt-program";
import { emptySceneRenderPlan, type SceneRenderPlan } from "./prompts-scene-plan";
import {
  IMAGE_SCENE_STAGING_UNSENT,
  lowerScenePlan,
  sceneLightingBand,
  type SceneLoweringViewer,
  type SceneProgramInputs,
} from "./scene-lowering";
import { applySceneCastVisual, SCENE_VISUAL_CAMERA_ID } from "./scene-subject-visual";

/**
 * THE SCENE REACHES THE COMPILED PROMPT (issue #388).
 *
 * A chat scene's sent prompt is the compiled prompt program and nothing else, and
 * for one release it carried the cast without the scene: the setting, the light,
 * the mood, the composer's action, the staged arrangement and the POV rule were
 * all dropped, while a declared `bright` placeholder asserted a camera fact no
 * scene had made. Nothing failed. The one test that read a real compiled scene
 * prompt ran over `emptySceneRenderPlan()` and asserted two character names, so it
 * could not have detected a dropped scene decision even in principle.
 *
 * This file is that missing test, and it is deliberately end-to-end over the
 * WHOLE chain — resolved plan → lowering → assembly → digest → dialect — because
 * every one of those layers is a place a scene decision can be silently lost.
 *
 * Three claims, and nothing else. The dialect switches are exhaustive over the
 * concept registry, so "each concept has wording" is already a compile error and
 * is not re-proved here; what a compiler cannot see is whether anything PRODUCES
 * the fact.
 *
 * 1. **A populated plan states every scene decision.** Falsified against the
 *    shipped cutover, which stated none of them.
 * 2. **A default camera asserts nothing, end to end.** A negative requirement,
 *    and the kind that regresses because somebody fills an absence: the retired
 *    prose builder suppressed its shot line on the default camera and the
 *    compiled path had no such gate, so every scene gained framing and distance
 *    sentences it never had. Pinned at all three layers — the lowering states no
 *    camera, no camera claim survives, no camera sentence is emitted — because
 *    pinning only the lowerer would let a compiler-side default reintroduce it.
 * 3. **An absent capture decision is FIRST PERSON.** In production the render
 *    option is only ever `selfie` or unset, and unset has always meant the
 *    player's own eyes. A lowering written as `framing ?? third_person` would
 *    have inverted every chat scene into an observing camera and read as
 *    entirely reasonable in review.
 */

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The bound scene endpoint, so the program actually compiles rather than answering `unbound`. */
function sceneProfile(): ResolvedImageProfile {
  return {
    model: imageModelSchema.parse({
      id: "mdl-2511",
      slug: "qwen/qwen-image-edit-2511",
      label: "Qwen Image Edit 2511",
      canGenerate: false,
      canEdit: true,
      editKind: "instruction_edit",
      identityPreservation: "strong",
      referenceField: "image",
      referenceArity: "array",
      maxReferences: 3,
    }),
    profile: imageModelProfileSchema.parse({
      id: "prf-2511-scene",
      imageModelId: "mdl-2511",
      key: "scene-standard",
      label: "Scene Standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
      referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
    }),
  };
}

/**
 * A scene with every decision made — the shape a real chat scene arrives in, and
 * the shape the shipped regression was invisible under.
 *
 * The camera matches the arrangement's own (`lying_face_down`), because that is
 * what `resolveScenePlan` produces: a surviving staging OWNS the shot. Its
 * height is `high`, which is the component nothing upstream of the lowering can
 * state.
 */
function populatedScenePlan(over: Partial<SceneRenderPlan> = {}): SceneRenderPlan {
  const base = laneProbeCastScenePlan(laneProbeCastSubjects().map((subject) => subject.member));
  const focal = base.focal;
  const bystander = base.others[0];
  if (focal === null || bystander === undefined) throw new Error("the probe cast fixture lost a member");
  return {
    ...base,
    setting: "a lamplit study, rain streaking the tall window",
    lighting: "dim lamplight",
    mood: "quiet and unhurried",
    camera: sceneStagings.lying_face_down.camera,
    captureMode: "first_person_disembodied",
    viewerBody: [...sceneStagings.lying_face_down.viewerParts],
    staging: sceneStagings.lying_face_down,
    focal: { ...focal, pose: "lying still along the bed", activity: "listening to the rain" },
    others: [{ ...bystander, pose: "", activity: "shelving books by the door" }],
    ...over,
  };
}

/**
 * The person behind the lens: enough of a persona sheet to state a body, and a
 * realized body carrying intimate anatomy in TWO regions.
 *
 * Two regions on purpose. A fixture with anatomy in one region cannot tell a
 * region-aware gate from a body-wide one — both answer the same for every input
 * — which is exactly how the first cut of this feature shipped a reveal that
 * read the wardrobe and never asked what the frame was pointed at.
 */
const VIEWER: SceneLoweringViewer = {
  attributes: [
    { id: "skin.tone", value: "bronze", source: "base" },
    { id: "build.frame", value: "sturdy", source: "base" },
    { id: "hands.size", value: "large", source: "base" },
    { id: "arms.hair", value: "light", source: "base" },
    { id: "breasts.size", value: "ample", source: "base" },
    { id: "breasts.nipples", value: "puffy", source: "base" },
    { id: "vulva.shape", value: "neat_slit", source: "base" },
  ],
  realizedBody: realizeBody({ intimateRegions: ["breasts", "vulva"] }),
};

/** Nothing worn: every region bare, so only the ROUTE and the FRAME can gate anatomy. */
const VIEWER_NUDE: RegionExposure = exposedRegions([]);
/** Trousered: the pelvis reads covered, so coverage can gate the pelvic half alone. */
const VIEWER_TROUSERED: RegionExposure = { torso: "bare", pelvis: "covered", legs: "covered", feet: "bare" };

interface CompiledScene {
  readonly program: CharacterPromptProgram;
  readonly lowered: SceneProgramInputs;
}

/**
 * The production chain: realize each cut under the plan's camera, lower, compile.
 *
 * `viewer` is the person behind the lens, for the embodied cases; absent, the
 * frame states its geometry and nothing about whose body it is.
 *
 * `referenced` is which cast members get an identity image in the payload. It
 * defaults to all of them, and exists because the scene ladder's single-reference
 * rung offers ONE surviving identity image while the resolved plan picks its
 * focal independently — so "the focal has no reference of their own, but the
 * render has references" is a real production shape and not a contrived one.
 */
function compileScene(
  plan: SceneRenderPlan,
  allowIntimate = false,
  viewer?: SceneLoweringViewer,
  referenced: (subjectId: string) => boolean = () => true,
  members: readonly LaneProbeCastSubject[] = laneProbeCastSubjects(),
): CompiledScene {
  const built = applySceneCastVisual({ plan, members });
  expect(built.refusal).toBeNull();
  const cast = built.visuals;
  const lowered = lowerScenePlan({
    plan,
    cast: cast.map((slice) => ({ subjectId: slice.subjectId, name: slice.name })),
    allowIntimate,
    ...(viewer === undefined ? {} : { viewer }),
  });
  const references = cast
    .filter((slice) => referenced(slice.subjectId))
    .map((slice): CharacterPromptReference => {
      const reference: ImageRenderReference = {
        role: "identity",
        buffer: Buffer.from(slice.subjectId),
        name: slice.name,
      };
      return { reference, subjectId: slice.subjectId };
    });
  const result = buildCharacterPromptProgram({
    lane: "scene",
    task: "scene",
    profile: sceneProfile(),
    bindingProfileKey: "scene-standard",
    bindingStrategy: "instruction_edit",
    cuts: cast.map((slice) => ({
      subjectId: slice.subjectId,
      name: slice.name,
      digest: slice.digest,
      attributes: slice.attributes,
      exposure: slice.exposure,
      hairOcclusion: slice.hairOcclusion,
      realizedBody: slice.realizedBody,
    })),
    scene: lowered.scene,
    location: lowered.location,
    camera: lowered.camera,
    read: { kind: "committed_cut", token: cast[0]?.cutId ?? "" },
    references,
    operation: () => characterSceneImageOperation({ subjectCount: cast.length, kind: "edit" }),
    refuseOnMissingRequired: true,
  });
  if (!isCharacterPromptCompiled(result)) {
    throw new Error(`the scene program did not compile: ${JSON.stringify(result)}`);
  }
  return { program: result, lowered };
}

/**
 * How a scene prompt refers to a cast member the payload carries an identity
 * image of.
 *
 * The scene lane offers the dialect no display NAME for a reference-anchored
 * subject (`CHARACTER_LANE_SUBJECT_NAMING.scene`, issue #544 F2): on the
 * fictional-celebrity workflow the name is a real person's, standing in the same
 * prompt as a photograph of somebody else. The dialect introduces them by their
 * image instead, and this is what an unnamed subject reads as until it does.
 *
 * Held as a constant, in both cases, because these are the DIALECT's words and
 * this file is not their owner — when the introduction changes, every assertion
 * below follows it from one place.
 */
const ANCHORED = "the subject";
const ANCHORED_LEADING = "The subject";

/** Every camera sentence the scene dialect can write, whatever the band. */
const CAMERA_SENTENCES = [
  "Tight close-up framing.",
  "Head-and-shoulders portrait framing.",
  "Waist-up framing.",
  "Full-figure framing, the whole body inside the frame.",
  "Wide shot, the subject small within the setting.",
  "The camera sits at eye level.",
  "The camera sits above the eye line, angled down.",
  "The camera sits below the eye line, angled up.",
  "faces the camera.",
  "is seen in profile.",
  "is seen from behind.",
  "Bright, even light.",
  "Dim, low light.",
  "Near-darkness, only the shape readable.",
];

// ---------------------------------------------------------------------------

describe("the compiled scene prompt over a populated plan", () => {
  it("states the setting, the light, the capture mode, the staging and each person's action", () => {
    const { program } = compileScene(populatedScenePlan());

    expectSections(program.prompt, [
      // Whose eyes this is, and whose body may be in the frame. The arrangement
      // below places the viewer's own hands on the focal, so this shot is
      // EMBODIED and must not assert the viewer's absence.
      "First-person POV through the viewer's own eyes; the viewer's face and head are never in frame, though the viewer's own body may be cropped into the frame.",
      // The registry's measured wording, adopted verbatim with `{name}` bound —
      // to the reference binding rather than to a display name (`ANCHORED`).
      `${ANCHORED_LEADING} lying face down along the bed with ${ANCHORED}'s back to the camera and ${ANCHORED}'s head turned to the side against the pillow, the viewer's own hands resting on ${ANCHORED}'s shoulders.`,
      // Pose and activity as two claims — the split the plan used to destroy.
      `${ANCHORED_LEADING} is lying still along the bed.`,
      `${ANCHORED_LEADING} is listening to the rain.`,
      // The bystander's action, which is not the focal's.
      `${ANCHORED_LEADING} is shelving books by the door.`,
      // Camera height — the component the visibility model has no read for.
      "The camera sits above the eye line, angled down.",
      // The setting and its light, as the composer wrote them.
      "A lamplit study, rain streaking the tall window.",
      "Lit by dim lamplight.",
    ]);

    // And NOT the mood: this focal was given a pose and an activity, which is
    // the visible half of the same moment, so the abstract label is withheld
    // (#544 D9 — the branches are pinned under "the mood label" below).
    expect(program.prompt).not.toContain("The mood is");

    // The scene's own light, never the release's declared `bright` placeholder.
    expect(program.prompt).not.toContain("Bright, even light.");

    // The arrangement's camera turned her away, and a moved orientation reaches
    // the prompt through the cut's own viewing reads — the default is silenced
    // by the lowering (below), a non-default one must not be.
    expect(program.prompt).toContain("is seen from behind.");

    // The three statements have to be mutually consistent. The arrangement says
    // the viewer's own hands are on Nyx's shoulders, so the frame may not also
    // say the viewer is invisible, and the cast may not be given every visible
    // body part — that clause would hand the viewer's hands to an NPC.
    expect(program.prompt).not.toContain("the viewer is never visible in the image");
    expect(program.prompt).not.toContain("Every visible body part belongs to");

    // Canonical segment order: the frame is stated before the bodies standing in
    // it, and the place and its light follow both.
    expectOrder(program.prompt, [
      "First-person POV through the viewer's own eyes",
      `${ANCHORED_LEADING} lying face down along the bed`,
      "A lamplit study, rain streaking the tall window.",
      "Lit by dim lamplight.",
    ]);
  });
});

describe("the shared appearance owners in a scene", () => {
  it("reinforces the focal's visible platinum hair and blue eyes beside its identity reference", () => {
    const plan = laneProbeCastScenePlan(laneProbeCastSubjects().map((subject) => subject.member));
    const { program } = compileScene(plan);

    expect(program.prompt).toMatch(/hair color: platinum/i);
    expect(program.prompt).toMatch(/eye color: blue/i);
  });
});

describe("production chat cuts are narrowed to the scene cast", () => {
  /**
   * The shared chat factory carries three visual owners in one cut: the cast
   * character, the player (whose committed posture lives in scene state), and
   * a room locus for a discarded garment. Only the first is a character
   * program subject. Before this projection existed, strict compilation
   * refused this ordinary cut on `subject.player.exposure`, despite there being
   * no provider failure and no missing character data.
   */
  it("keeps cast and room facts without compiling auxiliary player or room subjects", () => {
    const [subject, bystander] = laneProbeCastSubjects();
    if (subject === undefined || bystander === undefined) throw new Error("the probe cast fixture lost a member");
    const coat = visualStateGarmentFixture({
      id: "g_scene_coat",
      categoryId: "outerwear",
      name: "grey wool coat",
      locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
    });
    const store: ChatGarmentStore = {
      seeded: true,
      blueprints: { [coat.instance.blueprintHash]: coat.blueprint },
      instances: [coat.instance],
      cues: emptyGarmentCueState(),
      coverage: {},
    };
    const productionSubject = (castSubject: LaneProbeCastSubject): LaneProbeCastSubject => ({
      ...castSubject,
      shadow: {
        ...castSubject.shadow,
        garments: { store, actorId: `c:${castSubject.member.characterId}`, layersByGarmentId: new Map() },
        playerSubjectId: "player",
        sceneSubjectId: "scene",
        sceneRelations: {
          scene: visualStateSceneFixture(),
          subjectsByParticipant: new Map([
            [String(VISUAL_STATE_SCENE_NPC), castSubject.member.characterId],
            [String(VISUAL_STATE_SCENE_PLAYER), "player"],
          ]),
        },
      },
    });
    const focalSubject = productionSubject(subject);
    const productionCast = [focalSubject, productionSubject(bystander)];
    const plan = laneProbeCastScenePlan(productionCast.map((entry) => entry.member));

    // Control: without the scene lane's projection, the shared chat cut really
    // does assemble both auxiliary subjects; this is not a sterile fixture.
    const shared = safeBuildVisualStateShadow({
      ...focalSubject.shadow,
      camera: { cameraId: SCENE_VISUAL_CAMERA_ID, spec: plan.camera },
    });
    expect(shared?.snapshot.subjects).toEqual(
      expect.arrayContaining([subject.member.characterId, "player", "scene"]),
    );

    const realized = applySceneCastVisual({ plan, members: productionCast });
    expect(realized.refusal).toBeNull();
    expect(
      realized.visuals.map((visual) => visual.digest.subjects.map((digestSubject) => digestSubject.subjectId)),
    ).toEqual([[subject.member.characterId], [bystander.member.characterId]]);

    const { program } = compileScene(plan, false, undefined, () => true, productionCast);
    expect(program.subjects.map((compiled) => compiled.entityId)).toEqual([
      subject.member.characterId,
      bystander.member.characterId,
    ]);
    // The participant map still retains the cast side of the committed scene:
    // the NPC's specific facing-toward-player relation survives even though the
    // player is no longer a subject in this digest.
    const facingLocus = visualStateLocusKey({
      kind: "relation",
      relationId: `facing:${VISUAL_STATE_SCENE_NPC}:${VISUAL_STATE_SCENE_PLAYER}`,
    });
    const facing = program.subjects[0]?.facts.find((fact) =>
      fact.key.includes(`/${facingLocus}/body_language.facing`),
    );
    expect(facing).toMatchObject({
      concept: "subject.body_language",
      value: "toward",
    });
    const coatFactsBySubject = program.subjects.map(
      (compiled) =>
        compiled.facts.filter((fact) => fact.concept === "location.contents" && fact.value === "grey wool coat")
          .length,
    );
    expect(coatFactsBySubject).toEqual([1, 0]);
    expect(program.prompt.match(/Grey wool coat\./g)).toHaveLength(1);
    expect(program.missingRequired).toEqual([]);
  });
});

describe("a default camera asserts nothing", () => {
  it("lowers no camera, keeps no camera claim, and emits no camera sentence", () => {
    const plan = populatedScenePlan({
      camera: { ...DEFAULT_SCENE_CAMERA },
      // The staging carries its own non-default shot, so a default-camera scene
      // cannot be staged; and a scene that named no light must not have the
      // declared placeholder speak for it.
      staging: undefined,
      lighting: "",
      viewerBody: [],
    });
    const { program, lowered } = compileScene(plan);

    // 1. The lowering states no camera fact and declares itself silent about
    //    every component the committed cut would otherwise have asserted.
    expect(lowered.camera.facts ?? []).toEqual([]);
    expect([...(lowered.camera.silent ?? [])].sort()).toEqual(["angle", "distance", "framing", "lighting"]);

    // 2. No camera claim survives into the program. `camera.motion` is built and
    //    dropped by every dialect for a still camera, so nothing camera-shaped
    //    reaches the prompt either way.
    expect(program.keptClaimIds.filter((id) => id.startsWith("camera."))).toEqual([]);

    // 3. And no camera sentence is written — the assertion that would fail if a
    //    compiler-side default ever filled the absence.
    for (const sentence of CAMERA_SENTENCES) expect(program.prompt).not.toContain(sentence);
  });
});

describe("an absent capture decision", () => {
  it("resolves to first-person POV rather than an observing camera", () => {
    // Straight through `resolveScenePlan` with no capture decision in the
    // context — the production path for every chat scene that is not a selfie.
    const plan = laneProbeCastScenePlan(laneProbeCastSubjects().map((subject) => subject.member));
    expect(plan.captureMode).toBe("first_person_disembodied");

    const { program } = compileScene(plan);
    expect(program.prompt).toContain(
      "First-person POV through the viewer's own eyes; the viewer is never visible in the image.",
    );
    expect(program.prompt).not.toContain("The shot is taken by an observing camera, from outside the scene.");
  });

  /**
   * The measured composite, intact on the shot it was measured on.
   *
   * A frame with no viewer part in it is the disembodied case, and there the
   * possession clause is doing its job: the pose text names a limb, nothing else
   * in the prompt owns it, and binding every visible one to the cast is what
   * stops a phantom viewer hand appearing. Dropping it here would be
   * over-applying the embodied fix.
   *
   * The pose is the one thing this fixture states over the shared plan: the
   * clause is armed by a limb noun in the focal's own action text (#544 F3), and
   * a probe plan that mentioned no limb would be asserting the WITHHELD branch
   * under a title about keeping the clause.
   *
   * Asserted over the lowered facts rather than the prompt. The sentence needs
   * names to bind its owners to and the scene lane offers the dialect none for a
   * reference-anchored cast, so the emitted claim — which is what this owns —
   * outlives whatever the dialect currently makes of it.
   */
  it("keeps the cast possession binding when no viewer part is in frame", () => {
    const base = laneProbeCastScenePlan(laneProbeCastSubjects().map((subject) => subject.member));
    const focal = base.focal;
    if (focal === null) throw new Error("the probe cast fixture lost its focal");
    const plan = { ...base, focal: { ...focal, pose: `${LANE_PROBE_NAME}'s hand around the cup` } };
    expect(plan.viewerBody).toEqual([]);
    expect(plan.staging).toBeUndefined();

    const { program, lowered } = compileScene(plan, false, VIEWER);
    const possession = lowered.scene.find((fact) => fact.concept === "scene.possession");
    expect(possession?.value).toEqual([`subject.${LANE_PROBE_SUBJECT_ID}`, `subject.${LANE_PROBE_SECOND_SUBJECT_ID}`]);

    // And nothing about the viewer's own body, even with a persona supplied:
    // the composite is the measured one, unchanged. The count keeps its plain
    // wording — `fully in frame` is the embodied variant and must not leak back
    // onto the shot that never needed it.
    expect(lowered.scene.filter((fact) => fact.concept.startsWith("viewer."))).toEqual([]);
    expect(program.prompt).toContain("Exactly 2 people are in frame.");
    expect(program.prompt).not.toContain("fully in frame");
  });
});

/**
 * THE TWO CLAIMS A DESCRIBED SUBJECT MAKES REDUNDANT (issue #544, D3/D9).
 *
 * Both are claims that exist to cover for something the shot did not say, and
 * both were emitted unconditionally beside the thing that said it:
 *
 * - the **possession** clause binds every visible body part to the cast so an
 *   unowned limb noun cannot be composed as the viewer's foreground hand. With
 *   no limb noun anywhere in the action text there is no limb to bind, and the
 *   clause spends a claim asserting ownership of parts nobody mentioned;
 * - the **mood** is an emotional label ("nervous, curious") and a pose is the
 *   visible expression that label was about ("a small smile playing at her
 *   lips"). Handed both, an image model paints the abstraction over the concrete
 *   one — but a location-only shot, and a focal the composer said nothing about,
 *   have nothing else to say how the picture feels, so there the label stays.
 *
 * Lowered directly rather than compiled: `possessionFact` and `moodFact` are
 * this module's, and both branches of each are the whole claim.
 */
describe("the claims a described subject makes redundant", () => {
  const CAST = [{ subjectId: LANE_PROBE_SUBJECT_ID, name: LANE_PROBE_NAME }];

  /** The disembodied probe shot, with the focal's two action fields stated outright. */
  const shotWith = (pose: string, activity: string): SceneProgramInputs => {
    const base = laneProbeCastScenePlan([laneProbeCastMember()]);
    const focal = base.focal;
    if (focal === null) throw new Error("the probe cast fixture lost its focal");
    return lowerScenePlan({
      plan: { ...base, others: [], mood: "quiet and unhurried", focal: { ...focal, pose, activity } },
      cast: CAST,
      allowIntimate: false,
    });
  };

  const has = (lowered: SceneProgramInputs, concept: string): boolean =>
    lowered.scene.some((fact) => fact.concept === concept);

  it.each([
    ["a possessive limb the binder already bound", `${LANE_PROBE_NAME}'s hand around the cup`, ""],
    ["a plural limb", "both of her hands around the cup", ""],
    ["a limb in the activity rather than the pose", "seated by the window", "one foot tucked under her"],
  ])("binds every visible body part when the action text names %s", (_case, pose, activity) => {
    expect(has(shotWith(pose, activity), "scene.possession")).toBe(true);
  });

  it.each([
    ["no limb at all", "settling into the chair", "watching the rain"],
    ["a possessive idiom rather than a limb", "keeping the tray at arm's length", ""],
    ["a compound rather than a limb", "leaning on a hand-carved rail", ""],
  ])("binds nothing when the action text names %s", (_case, pose, activity) => {
    expect(has(shotWith(pose, activity), "scene.possession")).toBe(false);
  });

  it("withholds the mood label where the focal's own pose or activity carries the moment", () => {
    expect(has(shotWith("a small smile playing at her lips", ""), "scene.mood")).toBe(false);
    expect(has(shotWith("", "reaching for a cup of coffee"), "scene.mood")).toBe(false);
  });

  it("states the mood where nothing else says how the picture feels", () => {
    // A focal the composer described in neither field: the roster backfill's
    // shape, and the state the label is the only answer for.
    expect(has(shotWith("", ""), "scene.mood")).toBe(true);

    // And a location-only shot, which has no focal at all.
    const lowered = lowerScenePlan({
      plan: { ...emptySceneRenderPlan(), mood: "quiet and unhurried" },
      cast: [],
      allowIntimate: false,
    });
    expect(lowered.scene.find((fact) => fact.concept === "scene.mood")?.value).toBe("quiet and unhurried");
  });
});

/**
 * The contradiction this repair exists to end.
 *
 * A staging sentence names the viewer's own hands, so the frame around it cannot
 * assert the viewer's absence and the cast cannot be handed every visible body
 * part. That a staging owns the geometry changes nothing: the arrangement still
 * puts the viewer in the picture, and the surrounding contract has to know it.
 */
/**
 * Falsified against the classifier that accepted only compounds.
 *
 * `dark room` matched neither the dark band (which wanted `pitch dark` or `darkness`) nor the
 * dim one, so the band went unstated — and an unstated band is not neutral, it leaves the
 * release's declared `bright` placeholder standing. A scene that says it is dark then selected
 * character detail at the bright tier and was told it was brightly lit, which is the exact
 * regression this lowering exists to end, in the plainest phrasing a composer uses.
 */
describe("a scene that says it is dark", () => {
  it.each(["a dark room", "dark ambient light", "darkened hallway", "pitch dark"])(
    "classifies %j as dark rather than leaving the bright placeholder standing",
    (lighting) => {
      expect(sceneLightingBand(lighting)).toBe("dark");
    },
  );

  it("never lets a dark scene keep the declared bright placeholder", () => {
    const { program } = compileScene(populatedScenePlan({ lighting: "a dark room" }));
    expect(program.prompt).not.toContain("Bright, even light.");
    expect(program.prompt).toContain("Lit by a dark room.");
  });
});

describe("a staging that places the viewer", () => {
  it("makes the shot embodied and withdraws the cast-only possession clause", () => {
    const base = populatedScenePlan();
    const focal = base.focal;
    if (focal === null) throw new Error("the probe cast fixture lost its focal");
    // A limb in the pose, so EMBODIMENT is the only thing that can withdraw the
    // clause here: the shot otherwise arms it (#544 F3), and a fixture that
    // named no limb would pass this case for the wrong reason.
    const plan = { ...base, focal: { ...focal, pose: `${LANE_PROBE_NAME}'s hand flat on the sheet` } };
    expect(plan.staging?.viewerParts.length).toBeGreaterThan(0);

    const { program, lowered } = compileScene(plan);

    const captureMode = lowered.scene.find((fact) => fact.concept === "scene.capture_mode");
    expect(captureMode?.value).toBe("first_person_embodied");
    expect(lowered.scene.some((fact) => fact.concept === "scene.possession")).toBe(false);

    // The arrangement is still stated — embodiment withdraws the possession
    // clause, never the staging it was contradicting.
    expect(program.prompt).toContain(`the viewer's own hands resting on ${ANCHORED}'s shoulders.`);
  });
});

/**
 * The gates a committed staging runs PER RUNG on its way into the program, and
 * the leak-proofing among them. One resolved plan feeds the uncensored edit and
 * its moderated fallback, and the two disagree about the same arrangement: an
 * intimate act travels only a permitting route; an arrangement that names a
 * viewer part the player's coverage gated out is withheld WHOLE, because the
 * template speaks that anatomy in its own words and would smuggle it past the
 * coverage rule the phrasing is checked by; and a selfie has no viewer standing
 * anywhere for a two-body geometry. Each withholding is recorded under
 * `IMAGE_SCENE_STAGING_UNSENT` with its reason, so a render whose act went
 * missing says why.
 *
 * Falsified against a lowering that stated the staging fact unconditionally —
 * the moderated rung would then carry the explicit act, and a dressed player's
 * gated-out anatomy would reach the prompt inside the template's own sentence.
 */
describe("a staging the rung may not state", () => {
  const staged = (entry: SceneStaging, over: Partial<SceneRenderPlan> = {}): SceneRenderPlan =>
    populatedScenePlan({
      staging: entry,
      camera: entry.camera,
      viewerBody: [...entry.viewerParts],
      // No player coverage stated: the default-shut rule reads that as covered.
      ...over,
    });

  it.each([
    ["route_disallows_intimate", staged(sceneStagings.on_all_fours), false],
    ["viewer_parts_out_of_frame", staged(sceneStagings.kneeling_before_viewer), true],
    ["selfie", staged(sceneStagings.lying_face_down, { captureMode: "selfie" }), true],
  ] as const)("withholds the arrangement and records %s", (reason, plan, allowIntimate) => {
    expect(plan.staging).toBeDefined();
    const sink = new DiagnosticCollector();
    const lowered = lowerScenePlan({
      plan,
      cast: [{ subjectId: LANE_PROBE_SUBJECT_ID, name: LANE_PROBE_NAME }],
      allowIntimate,
      sink,
    });
    expect(lowered.scene.some((fact) => fact.concept === "scene.staging")).toBe(false);
    const unsent = sink.items.find((item) => item.code === IMAGE_SCENE_STAGING_UNSENT);
    expect(unsent?.context).toMatchObject({ staging: plan.staging?.id, reason });
  });
});

/**
 * THE IDENTITY LOCK'S ADAPTATION (issue #391).
 *
 * The lock and the camera pull against each other, and the lock wins by default:
 * the cheapest way for an edit model to prove it preserved a face is to SHOW that
 * face, so a lock reading "preserve the exact face" turns a character the shot
 * just put back-to-camera around to the lens. The retired prose builder said so
 * outright in a sentence beside the lock; the compiled path inherited the lock
 * and not the sentence, and the effective face visibility — which the orientation
 * registry answers and a staging may override — reached nothing.
 *
 * Falsified against that state, where every away, profile and crown-of-the-head
 * shot compiled the unqualified lock.
 *
 * The lock's own bytes are asserted present in the same breath, because the
 * cheap wrong fix is to edit the adaptation INTO the lock — and that string is
 * matched verbatim at the model boundary. The order assertion is ORDER, not
 * adjacency: the adaptation's priority is strictly under the lock's, so it can
 * never precede the lock, while every other subject's identity claim sits at the
 * lock's own priority and may legitimately fall between them.
 */
describe("a shot that cannot show the subject's face", () => {
  const NO_ROTATION = `do not rotate ${ANCHORED} to face the camera.`;

  /** The populated plan with its arrangement removed, so the CAMERA decides the answer. */
  const shot = (orientation: SceneSubjectOrientationId): SceneRenderPlan =>
    populatedScenePlan({
      staging: undefined,
      viewerBody: [],
      camera: { ...DEFAULT_SCENE_CAMERA, orientation },
    });

  /** The measured sentences, for a subject whose OWN identity image is in the payload. */
  const PARTIAL_FROM_REFERENCE =
    `${ANCHORED}'s face is partly turned from the camera; preserve the visible features, hair color and style, build and skin tone exactly from the reference — do not rotate ${ANCHORED} to face the camera.`;
  const AWAY_FROM_REFERENCE =
    `${ANCHORED}'s face is not visible in this shot; preserve the hair color and style, build and skin tone exactly from the reference — do not rotate ${ANCHORED} to face the camera.`;

  it.each([
    ["profile", PARTIAL_FROM_REFERENCE],
    ["away", AWAY_FROM_REFERENCE],
  ] as const)("adapts the lock on a %s shot without touching the lock's bytes", (orientation, adaptation) => {
    const { program } = compileScene(shot(orientation));
    expect(program.prompt).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).toContain(adaptation);
    // A separate sentence, and the lock still reads exactly as the boundary
    // matches it — the adaptation follows it rather than being spliced into it.
    expectOrder(program.prompt, [QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK, adaptation]);
  });

  it("states no adaptation on a front-facing shot", () => {
    const { program, lowered } = compileScene(shot("toward_viewer"));
    expect(lowered.scene.some((fact) => fact.concept === "subject.face_visibility")).toBe(false);
    expect(program.prompt).toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).not.toContain(NO_ROTATION);
  });

  /**
   * The override is the whole reason `SceneStagingSemantics.faceVisibility` is a
   * field rather than a derivation: `kneeling_before_viewer_guided` is a
   * `toward_viewer` shot of the crown of someone's head, and no orientation can
   * see that. It also has to survive the arrangement's own per-rung gates —
   * withholding the staged SENTENCE never un-turns the body — which is asserted
   * here on the moderated rung, where the intimate arrangement is not stated.
   */
  it("takes a staging's own answer over the orientation's, even where the arrangement is withheld", () => {
    const staging = sceneStagings.kneeling_before_viewer_guided;
    expect(sceneSubjectOrientationById(staging.camera.orientation)?.faceVisibility).toBe("full");
    expect(staging.faceVisibility).toBe("hidden");

    const sink = new DiagnosticCollector();
    const lowered = lowerScenePlan({
      plan: populatedScenePlan({ staging, camera: staging.camera, viewerBody: [...staging.viewerParts] }),
      cast: [{ subjectId: LANE_PROBE_SUBJECT_ID, name: LANE_PROBE_NAME }],
      allowIntimate: false,
      sink,
    });

    expect(lowered.scene.some((fact) => fact.concept === "scene.staging")).toBe(false);
    expect(sink.items.some((item) => item.code === IMAGE_SCENE_STAGING_UNSENT)).toBe(true);
    expect(lowered.scene.find((fact) => fact.concept === "subject.face_visibility")?.value).toBe("hidden");
  });

  /**
   * The same shot for a subject with no identity image of their OWN in the payload.
   *
   * Their display NAME survives here, and that is the second half of the naming
   * policy rather than an oversight (#544 F2): the scene lane withholds a name
   * only from a subject some required identity reference actually shows, because
   * only they can be introduced by an image instead. A cast member with no
   * reference of their own has nothing to be introduced by, so the prompt keeps
   * the one thing that can still tell them apart.
   */
  const AWAY_UNANCHORED =
    `${LANE_PROBE_NAME}'s face is not visible in this shot; preserve the hair color and style, build and skin tone exactly — do not rotate ${LANE_PROBE_NAME} to face the camera.`;

  /**
   * Whose photograph the preservation set points at.
   *
   * Falsified against `references.length > 0`, which asks whether the PAYLOAD has
   * references rather than whether THIS person is in one. The scene ladder's
   * single-reference rung sends one surviving identity image and the resolved
   * plan picks its focal independently of which one that was, so a turned-away
   * Nyx beside Ilsa's reference would have been told to take her hair, build and
   * skin tone "exactly from the reference" — a picture of Ilsa. The other
   * direction is the `away` row above, which keeps the measured wording on the
   * render that legitimately earns it: a fix that simply deleted the clause would
   * pass this case and fail that one.
   */
  it("anchors the preservation set to nothing when only another subject is referenced", () => {
    const { program } = compileScene(shot("away"), false, undefined, (subjectId) => subjectId !== LANE_PROBE_SUBJECT_ID);

    // The render still locks an identity — Ilsa's — so this is not a
    // reference-free prompt; it is a prompt with a reference of the wrong person
    // for this claim.
    expect(program.prompt).toContain(QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(program.prompt).toContain(AWAY_UNANCHORED);
    expect(program.prompt).not.toContain("build and skin tone exactly from the reference");
  });

  /** The away sentence for a subject whose headwear fully hides their hair: hair leaves the preserve list, nothing else moves. */
  const AWAY_HAIR_CONCEALED =
    `${ANCHORED}'s face is not visible in this shot; preserve the build and skin tone exactly from the reference — do not rotate ${ANCHORED} to face the camera.`;

  /** The probe cast with the focal's resolved hair-occlusion band overridden. */
  const castAt = (band: "partial" | "full"): LaneProbeCastSubject[] => {
    const [, ...rest] = laneProbeCastSubjects();
    return [{ member: laneProbeCastMember({ hairOcclusion: band }), shadow: laneProbeShadowInput() }, ...rest];
  };

  /**
   * Covered hair on a reference-anchored, turned-away shot (issue #312). The
   * lock and the adaptation both tell the model what to keep from the
   * reference, and at `full` "hair" may not be on either list: a hijab-wearing
   * character rendered from a bare-headed reference would otherwise have the
   * reference's hair painted back over the hijab. The turn stays off the
   * table byte for byte — dropping the clause was the cheap wrong fix — and
   * `partial` keeps the measured wording untouched, because some hair still
   * shows and the reference remains authoritative for it.
   */
  it.each([
    ["full", QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED, AWAY_HAIR_CONCEALED],
    ["partial", QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK, AWAY_FROM_REFERENCE],
  ] as const)("at `%s` hair occlusion, a turned-away shot preserves the right set from the reference", (band, lock, adaptation) => {
    const { program } = compileScene(shot("away"), false, undefined, () => true, castAt(band));
    expect(program.prompt).toContain(lock);
    expect(program.prompt).toContain(adaptation);
    expect(program.prompt).toContain(NO_ROTATION);
    expectOrder(program.prompt, [lock, adaptation]);
    if (band === "full") {
      expect(program.prompt).not.toContain(QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK);
      expect(program.prompt).not.toMatch(/[Pp]reserve[^.]*\bhair\b/);
    }
  });
});

/**
 * THE VIEWER'S OWN BODY IN AN EMBODIED FRAME (issue #390).
 *
 * The retired prose builder stated the viewer's cropped limbs, their skin and
 * build, and their exposed anatomy; the compiled program had no carrier for any
 * of it, so an embodied POV shot described a foreground it never mentioned. The
 * carrier is the `viewer` channel: claims that describe a body in frame which is
 * NOT in the cast.
 *
 * Falsified against three implementations that each look reasonable:
 *
 * - one that files the viewer as a subject — `operation.subjectCount` then
 *   counts a person who has no cut, no identity reference and no face;
 * - one that emits the generic geometry line for a part a staging already
 *   places — the same two hands stated in two places in one prompt, which is
 *   the self-contradiction that makes a model paint a third party's arms;
 * - one that states the viewer's parts from the plan rather than from the gate —
 *   a dressed player's anatomy in the prompt, past the coverage rule.
 */
describe("the viewer's own body in an embodied frame", () => {
  /** No staging: the composer grounded the parts and nothing else words them. */
  const generic = (parts: readonly ViewerBodyPartId[], over: Partial<SceneRenderPlan> = {}): SceneRenderPlan =>
    populatedScenePlan({ staging: undefined, camera: { ...DEFAULT_SCENE_CAMERA }, viewerBody: [...parts], ...over });

  it("states the generic geometry, the viewer's own body facts, and no possession clause", () => {
    const { program, lowered } = compileScene(generic(["hands"]), false, VIEWER);

    expect(lowered.scene.find((fact) => fact.concept === "scene.capture_mode")?.value).toBe("first_person_embodied");
    expect(lowered.scene.find((fact) => fact.concept === "viewer.body_geometry")?.value).toEqual(["hands"]);

    expectSections(program.prompt, [
      "First-person POV through the viewer's own eyes; the viewer's face and head are never in frame, though the viewer's own body may be cropped into the frame.",
      "Also in frame, in the viewer's immediate foreground: the viewer's own hands entering frame from the lower edge, close to the lens and strongly foreshortened.",
    ]);
    // Whose body those hands are. Without it a foreground arm changes colour
    // between shots and reads as a different person reaching in.
    expect(program.prompt).toContain("The viewer's own body: ");
    expect(program.prompt).toContain("hand size: large");
    expect(program.prompt).toContain("skin tone: bronze");

    // The viewer is in the picture but never in the cast: the count still names
    // the two people who have cuts, and no clause hands their limbs an owner.
    expect(program.prompt).toContain("Exactly 2 people are fully in frame.");
    expect(lowered.scene.some((fact) => fact.concept === "scene.possession")).toBe(false);

    // Geometry before the body facts: the model has to know the limbs are the
    // viewer's and cropped before it is told what they look like.
    expectOrder(program.prompt, [
      "Also in frame, in the viewer's immediate foreground:",
      "The viewer's own body: ",
    ]);
  });

  it("emits no generic geometry line when a staging owns every part in frame", () => {
    const plan = populatedScenePlan();
    const { program, lowered } = compileScene(plan, false, VIEWER);

    expect(lowered.scene.some((fact) => fact.concept === "scene.staging")).toBe(true);
    expect(lowered.scene.some((fact) => fact.concept === "viewer.body_geometry")).toBe(false);
    expect(program.prompt).not.toContain("Also in frame, in the viewer's immediate foreground");

    // The staging owns the GEOMETRY, never whose body this is — the facts cover
    // every part in frame, staged or not.
    expect(program.prompt).toContain("The viewer's own body: ");
    expect(program.prompt).toContain(`the viewer's own hands resting on ${ANCHORED}'s shoulders.`);
  });

  it("words only the parts the staging left over", () => {
    const staged = sceneStagings.lying_face_down;
    const plan = populatedScenePlan({ viewerBody: [...staged.viewerParts, "forearms"] });
    expect(staged.viewerParts).toContain("hands");

    const { program, lowered } = compileScene(plan, false, VIEWER);
    expect(lowered.scene.find((fact) => fact.concept === "viewer.body_geometry")?.value).toEqual(["forearms"]);
    expect(program.prompt).toContain("Also in frame, in the viewer's immediate foreground: the viewer's own forearms");
    // The staged hands are placed once, by the arrangement, and never a second
    // time relative to the lens.
    expect(program.prompt).not.toContain(
      "the viewer's own hands entering frame from the lower edge, close to the lens and strongly foreshortened",
    );
  });

  /**
   * The gate, from both sides. `genitals` is never proposed — the composer runs
   * `allowIntimate: false` whatever model it picks — so it is derived from a
   * shot already looking down the viewer's own body and then has to survive the
   * route AND the coverage readout. Either refusal must remove the part from the
   * geometry AND the anatomy sentence with it; nothing may state a body part the
   * gate withheld.
   */
  it.each([
    ["the moderated route", false, VIEWER_NUDE],
    ["the pelvis reading covered", true, VIEWER_TROUSERED],
    ["no coverage established at all", true, undefined],
  ] as const)("refuses the viewer's intimate anatomy when %s stops it", (_reason, allowIntimate, exposure) => {
    const plan = generic(["lap_thighs"], exposure === undefined ? {} : { playerExposure: exposure });
    const { program, lowered } = compileScene(plan, allowIntimate, VIEWER);

    expect(lowered.scene.find((fact) => fact.concept === "viewer.body_geometry")?.value).toEqual(["lap_thighs"]);
    expect(lowered.scene.some((fact) => fact.concept === "viewer.intimate_anatomy")).toBe(false);
    expect(program.prompt).not.toContain("the viewer's own genitals");
    expect(program.prompt).not.toContain("The viewer's own exposed anatomy");
  });

  it("states it when the route permits it and the pelvis reads bare", () => {
    const plan = generic(["lap_thighs"], { playerExposure: VIEWER_NUDE });
    const { program, lowered } = compileScene(plan, true, VIEWER);

    expect(lowered.scene.find((fact) => fact.concept === "viewer.body_geometry")?.value).toEqual([
      "lap_thighs",
      "genitals",
    ]);
    expect(program.prompt).toContain("the viewer's own genitals in the immediate foreground");
    expect(program.prompt).toContain("The viewer's own exposed anatomy: vulva shape: neat slit.");
  });

  /**
   * COVERAGE IS NOT FRAMING, in both directions.
   *
   * `revealSurfaces` answers what the clothes leave uncovered ANYWHERE on the
   * body. For the cast that is nearly the whole question, because a render draws
   * a whole figure. For the viewer it is half of one: the camera is their own
   * eyes, so the frame holds a few cropped limbs and the rest of them is simply
   * not in the picture.
   *
   * Falsified against the shipped gate, which asked only "did any intimate part
   * survive?" and then let coverage decide the rest. That gate got both errors,
   * and each case below is one of them:
   *
   * 1. a shirtless torso in frame stated NOTHING, because the trousers kept
   *    `genitals` out and the whole reveal hung off that one part surviving;
   * 2. a shot of the viewer's own lap stated their bare chest, because
   *    `genitals` had survived and the loop then ran over the whole body.
   */
  it("states the anatomy of the region in frame and no other", () => {
    // Shirtless but trousered, looking down over their own chest.
    const bareTorso = generic(["torso"], {
      playerExposure: { torso: "bare", pelvis: "covered", legs: "covered", feet: "covered" },
    });
    const { program, lowered } = compileScene(bareTorso, true, VIEWER);

    // The pelvis is covered, so `genitals` never entered the frame at all — and
    // the torso that DID must still be describable.
    expect(lowered.scene.find((fact) => fact.concept === "viewer.body_geometry")?.value).toEqual(["torso"]);
    expect(program.prompt).toContain("The viewer's own exposed anatomy: ");
    expect(program.prompt).toContain("breast size: ample");
    expect(program.prompt).not.toContain("vulva shape");
  });

  it("says nothing about a bare region the frame is not pointed at", () => {
    // Wearing nothing at all, but the shot is the viewer's own lap: their chest
    // is bare and off-camera, which is not a reason to describe it.
    const plan = generic(["lap_thighs"], { playerExposure: VIEWER_NUDE });
    const { program } = compileScene(plan, true, VIEWER);

    expect(program.prompt).toContain("vulva shape: neat slit");
    expect(program.prompt).not.toContain("breast size:");
    expect(program.prompt).not.toContain("nipples:");
  });

  it("states nothing about a body it was given no persona for", () => {
    const { program, lowered } = compileScene(generic(["hands"]));

    expect(lowered.scene.some((fact) => fact.concept === "viewer.body_geometry")).toBe(true);
    expect(lowered.scene.some((fact) => fact.concept === "viewer.appearance")).toBe(false);
    expect(program.prompt).not.toContain("The viewer's own body: ");
  });
});
