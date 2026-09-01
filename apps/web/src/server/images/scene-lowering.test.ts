import { describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { characterSceneImageOperation } from "@/contracts/images/character-digest";
import { DEFAULT_SCENE_CAMERA } from "@/contracts/images/scene-camera";
import { sceneStagings } from "@/contracts/images/scene-staging";
import {
  expectOrder,
  expectSections,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
} from "@/server/test-support";
import {
  buildCharacterPromptProgram,
  isCharacterPromptCompiled,
  type CharacterPromptProgram,
  type CharacterPromptReference,
} from "./character-prompt-program";
import type { SceneRenderPlan } from "./prompts-scene-plan";
import { lowerScenePlan, type SceneProgramInputs } from "./scene-lowering";
import { applySceneCastVisual } from "./scene-subject-visual";

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
    captureMode: "first_person_pov",
    viewerBody: [...sceneStagings.lying_face_down.viewerParts],
    staging: sceneStagings.lying_face_down,
    focal: { ...focal, pose: "lying still along the bed", activity: "listening to the rain" },
    others: [{ ...bystander, pose: "", activity: "shelving books by the door" }],
    ...over,
  };
}

interface CompiledScene {
  readonly program: CharacterPromptProgram;
  readonly lowered: SceneProgramInputs;
}

/** The production chain: realize each cut under the plan's camera, lower, compile. */
function compileScene(plan: SceneRenderPlan, allowIntimate = false): CompiledScene {
  const built = applySceneCastVisual({ plan, members: laneProbeCastSubjects() });
  expect(built.refusal).toBeNull();
  const cast = built.visuals;
  const lowered = lowerScenePlan({
    plan: built.plan,
    cast: cast.map((slice) => ({ subjectId: slice.subjectId, name: slice.name })),
    allowIntimate,
  });
  const references = cast.map((slice): CharacterPromptReference => {
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
    resolver: "active",
    cuts: cast.map((slice) => ({
      subjectId: slice.subjectId,
      name: slice.name,
      digest: slice.digest,
      attributes: slice.attributes,
      exposure: slice.exposure,
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
  it("states the setting, the light, the mood, the capture mode, the staging and each person's action", () => {
    const { program } = compileScene(populatedScenePlan());

    expectSections(program.prompt, [
      // Whose eyes this is — the anchor of the measured POV composite.
      "First-person POV through the viewer's own eyes; the viewer is never visible in the image.",
      // The possession binding, ABSTRACT and name-bound. An enumerated form was
      // measured worse and painted a phantom viewer hand.
      "Every visible body part belongs to Nyx or Ilsa.",
      // The registry's measured wording, adopted verbatim with `{name}` bound.
      "Nyx lying face down along the bed with Nyx's back to the camera and Nyx's head turned to the side against the pillow, the viewer's own hands resting on Nyx's shoulders.",
      // Pose and activity as two claims — the split the plan used to destroy.
      "Nyx is lying still along the bed.",
      "Nyx is listening to the rain.",
      // The bystander's action, which is not the focal's.
      "Ilsa is shelving books by the door.",
      // Camera height — the component the visibility model has no read for.
      "The camera sits above the eye line, angled down.",
      // The setting and its light, as the composer wrote them.
      "A lamplit study, rain streaking the tall window.",
      "Lit by dim lamplight.",
      "The mood is quiet and unhurried.",
    ]);

    // The scene's own light, never the release's declared `bright` placeholder.
    expect(program.prompt).not.toContain("Bright, even light.");

    // Canonical segment order: the frame is stated before the bodies standing in
    // it, and the place and its mood follow both.
    expectOrder(program.prompt, [
      "First-person POV through the viewer's own eyes",
      "Nyx lying face down along the bed",
      "A lamplit study, rain streaking the tall window.",
      "Lit by dim lamplight.",
      "The mood is quiet and unhurried.",
    ]);
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
    expect(plan.captureMode).toBe("first_person_pov");

    const { program } = compileScene(plan);
    expect(program.prompt).toContain(
      "First-person POV through the viewer's own eyes; the viewer is never visible in the image.",
    );
    expect(program.prompt).not.toContain("The shot is taken by an observing camera, from outside the scene.");
  });
});
