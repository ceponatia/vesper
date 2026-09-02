import { describe, expect, it } from "vitest";
import {
  imageLabStagedSceneRecipeProfile,
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  type ImageLabStaging,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { characterSceneImageOperation } from "@/contracts/images/character-digest";
import { sceneStagingById, sceneStagingList, type SceneStaging } from "@/contracts/images/scene-staging";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import {
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeProfile,
  laneProbeShadowInput,
} from "@/server/test-support";
import {
  buildCharacterPromptProgram,
  isCharacterPromptCompiled,
  type CharacterPromptProgram,
} from "./character-prompt-program";
import { stagedScenePlan, stagedSceneProgram } from "./image-lab-staged";
import {
  buildStagedSubjectVisual,
  stagedPremiseWorn,
  stagedSubjectExposure,
  type StagedSubjectCut,
} from "./image-lab-staged-visual";
import { sceneSpecSchema, type SceneComposerContext } from "./prompts-scene-composer";
import { resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { lowerScenePlan } from "./scene-lowering";
import { applySceneSubjectVisual } from "./scene-subject-visual";
import { portraitPerception } from "./standalone-subject-visual";

/**
 * The staged bench's parity pin (owner ruling 2026-08-25).
 *
 * This kind is only worth running if its prompt is production's prompt, so the
 * assertion that matters is BYTE EQUALITY between the bench's compiled program
 * and the one the chat lane's single-reference `edit` rung compiles for the
 * same staging — not "contains the template", which a lane that quietly dropped
 * the camera or the exposure claims would still pass. Everything else here is a
 * corollary of that one claim: the registry's words arrive verbatim, the subject
 * is undressed for exactly the regions the template describes as bare, and the
 * program's own planned references are what the bench sends.
 *
 * ## The two sides
 *
 * The chat side is built the way the chat lane really reaches an intimate
 * staged render: a composer spec whose staging carries a verbatim narration
 * quote, resolved against a present roster, the member's cut realized through
 * the shadow seam (`applySceneSubjectVisual`) and compiled argument for argument
 * as `scene.ts` compiles its `edit` rung. So the comparison is against the
 * resolver's gates and the production compile, never against a plan handed the
 * answer.
 *
 * The bench side is `stagedSceneProgram` over a cut the standalone assembly
 * realized (`buildStagedSubjectVisual`). The two seams assemble the SAME
 * committed cut two ways — shadow build versus standalone build — and the pin is
 * that those two seams agree once the program has compiled them. The fixture
 * hands both the same subject, the same attributes, the same camera and the
 * same perception; what it does NOT do is hand either side a value the other
 * computed. Anything that differs — a policy, a routed fact, a dropped claim —
 * shows up as a byte difference.
 *
 * Every staging in the catalog is checked rather than a chosen few: the entries
 * differ in exactly the ways this lane has to get right (bare regions, viewer
 * parts including intimate ones, a camera that overrides the default), and a
 * census cannot go stale when a fourteenth entry lands.
 */

/** One fixture character across both sides — the same person every other lane suite renders. */
const SUBJECT = LANE_PROBE_NAME;
const PROFILE = laneProbeProfile();
/** A `characters.updatedAt` stand-in: the read token's only source for a bench. */
const REVISION = "2026-08-25T00:00:00.000Z";

/** The quote the chat-side staging earns its place with — the bench needs none. */
const EVIDENCE = "she is arranged exactly like this";
const NARRATION = `The room goes quiet, and ${EVIDENCE}, breathing slow.`;

/** The player undressed — what both sides state, since a covered pelvis would gate the anatomy out of frame. */
const PLAYER_BARE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };

const SCENE: ImageLabStaging = { id: "", setting: "a rumpled bed, one lamp left on", timeOfDay: "night" };

/** The bound scene endpoint both sides compile against — Qwen Edit 2511, whose `scene-standard` rows are active. */
const MODEL = imageModelSchema.parse({
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
});

/** The production scene profile a chat resolves on that model. */
const CHAT_PROFILE: ResolvedImageProfile = {
  model: MODEL,
  profile: imageModelProfileSchema.parse({
    id: "prf-2511-scene",
    imageModelId: MODEL.id,
    key: "scene-standard",
    label: "Scene Standard",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
    referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
  }),
};

/** The bench's own intent profile: the pinned model under the staged recipe, bound on the production key. */
const benchProfile = (entry: SceneStaging): ResolvedImageProfile => ({
  model: MODEL,
  profile: imageLabStagedSceneRecipeProfile(MODEL.id, entry.id),
});

/** The one identity reference every staged run sends — the same object on both sides. */
const IDENTITY_REFERENCE: ImageRenderReference = {
  role: "identity",
  buffer: Buffer.from("nyx"),
  sourceImageId: "img-nyx",
  required: true,
};

/**
 * The plan the CHAT lane resolves for this staging: the composer proposes it
 * with a quote the narration really contains, the roster is the one present NPC
 * the solo entries require, and the coverage gate sees the bare regions the
 * template describes. Nothing is forced — if a gate dropped the entry the
 * programs would differ and the comparisons below would fail loudly, which is
 * the behaviour this fixture wants.
 */
function chatLanePlan(entry: SceneStaging): SceneRenderPlan {
  const context: SceneComposerContext = {
    present: [
      {
        name: SUBJECT,
        wornVisible: [],
        exposure: stagedSubjectExposure(entry),
        wardrobeTracked: true,
      },
    ],
    embodiedViewer: true,
    recentNarration: [NARRATION],
    playerExposure: PLAYER_BARE,
  };
  const spec = sceneSpecSchema.parse({
    focalCharacter: SUBJECT,
    setting: SCENE.setting,
    lighting: "dim night-time lighting",
    staging: { id: entry.id, evidence: EVIDENCE },
  });
  return resolveScenePlan(spec, context);
}

/**
 * The chat lane's single-reference `edit` rung, compiled the way `scene.ts`
 * compiles it — the same seam, the same arguments — over a cut the shadow build
 * realized. The perception is stated rather than taken from the probe's own
 * default because it is half of the CUT, not half of the lane: a bench derives
 * the camera's per-location view from the staging's premise coverage, and
 * comparing two digests taken under different perceptions would be comparing
 * two different moments rather than two assemblies of one.
 */
function chatLaneProgram(entry: SceneStaging): CharacterPromptProgram {
  const exposure = stagedSubjectExposure(entry);
  const plan = chatLanePlan(entry);
  const applied = applySceneSubjectVisual({
    plan,
    member: { name: SUBJECT, profile: PROFILE, exposure },
    shadow: { ...laneProbeShadowInput(PROFILE), perception: portraitPerception(stagedPremiseWorn(exposure)) },
  });
  if (applied.refusal !== null) throw new Error(`the chat side refused the fixture: ${applied.refusal}`);
  const slice = applied.visuals[0];
  if (slice === undefined) throw new Error("the chat side realized no cut");
  const lowered = lowerScenePlan({
    plan,
    cast: [{ subjectId: slice.subjectId, name: slice.name }],
    allowIntimate: true,
  });
  const result = buildCharacterPromptProgram({
    lane: "scene",
    task: "scene",
    profile: CHAT_PROFILE,
    bindingProfileKey: CHAT_PROFILE.profile.key,
    bindingStrategy: "instruction_edit",
    cuts: [
      {
        subjectId: slice.subjectId,
        name: slice.name,
        digest: slice.digest,
        attributes: slice.attributes,
        exposure: slice.exposure,
        hairOcclusion: slice.hairOcclusion,
        realizedBody: slice.realizedBody,
      },
    ],
    scene: lowered.scene,
    location: lowered.location,
    camera: lowered.camera,
    intimateReveal: true,
    read: { kind: "committed_cut", token: slice.cutId },
    references: [{ reference: IDENTITY_REFERENCE, subjectId: slice.subjectId }],
    operation: () => characterSceneImageOperation({ subjectCount: 1, kind: "edit" }),
    refuseOnMissingRequired: true,
  });
  if (!isCharacterPromptCompiled(result)) throw new Error(`the chat side did not compile: ${JSON.stringify(result)}`);
  return result;
}

/** The bench's own cut, refusing loudly rather than degrading. */
function benchCut(entry: SceneStaging): StagedSubjectCut {
  const built = buildStagedSubjectVisual({
    characterId: LANE_PROBE_SUBJECT_ID,
    name: SUBJECT,
    profile: PROFILE,
    revision: REVISION,
    entry,
  });
  if (!built.ok) throw new Error(`the bench refused the fixture: ${built.refusal}`);
  return built.cut;
}

function benchProgram(entry: SceneStaging, scene: ImageLabStaging = { ...SCENE, id: entry.id }): CharacterPromptProgram {
  const { program } = stagedSceneProgram({
    subject: benchCut(entry),
    entry,
    scene,
    profile: benchProfile(entry),
    bindingProfileKey: CHAT_PROFILE.profile.key,
    read: { kind: "standalone_character", characters: [{ characterId: LANE_PROBE_SUBJECT_ID, revision: REVISION }] },
    references: [IDENTITY_REFERENCE],
  });
  if (!isCharacterPromptCompiled(program)) throw new Error(`the bench did not compile: ${JSON.stringify(program)}`);
  return program;
}

const EVERY_STAGING = sceneStagingList.map((entry) => [entry.id, entry] as const);

describe("the staged scene program", () => {
  it.each(EVERY_STAGING)(
    "compiles %s byte-identically to the chat lane's single-reference rung for the same staging",
    (_id, entry) => {
      expect(benchProgram(entry).prompt).toBe(chatLaneProgram(entry).prompt);
    },
  );

  it.each(EVERY_STAGING)("states the %s template verbatim, with {name} bound to the subject", (_id, entry) => {
    // The registry owns every explicit word: nothing between it and the prompt
    // may reword a template, so the check is for the entry's own text with
    // `{name}` bound — the same assertion the A/B probe refused to render
    // without. Riding as a required claim, it also has to survive the budget,
    // and this is what says it did.
    expect(benchProgram(entry).prompt).toContain(entry.template.replaceAll("{name}", SUBJECT));
  });

  /**
   * The invariant the bench is built on: the coverage the cut reads is the
   * STAGING's premise, never a wardrobe. `stagedPremiseWorn` is the only channel
   * into the standalone assembly's exposure readout and its camera perception,
   * so a premise that did not round-trip would let a garment list decide which
   * regions the bench thinks are bare — the failure that would silently switch
   * several stagings off.
   *
   * A census rather than one case, because the four region roots NEST: `feet` is
   * a child of `legs`, so an entry that bared a foot while clothing the leg
   * could not be expressed by root ids and would silently over-cover. No entry
   * does that today; this is what says so, per entry, and what will say
   * otherwise the day one lands.
   */
  it.each(EVERY_STAGING)("expresses %s's invented exposure as coverage that round-trips into the cut", (_id, entry) => {
    const exposure = stagedSubjectExposure(entry);
    expect(exposedRegions(stagedPremiseWorn(exposure))).toEqual(exposure);
    expect(benchCut(entry).exposure).toEqual(exposure);
  });

  it("states the staging's own shot and viewer parts rather than the default one", () => {
    const entry = staging("astride_viewer_facing");
    const plan = stagedScenePlan(SUBJECT, entry, { ...SCENE, id: entry.id });

    expect(plan.camera).toEqual(entry.camera);
    expect(plan.staging?.id).toBe(entry.id);
    expect(plan.viewerBody).toEqual([...entry.viewerParts]);
  });

  // Parity between two sides that had both realized an empty cut would still
  // hold byte for byte; this is what says the cut reached the prompt at all.
  it("describes the subject from their own cut", () => {
    expect(benchProgram(staging("astride_viewer_facing")).prompt).toContain("spiraled");
  });

  it("derives the light from the stated time of day, and prefers an admin's own phrase", () => {
    const entry = staging("held_from_behind");

    expect(benchProgram(entry, { id: entry.id, timeOfDay: "dusk" }).prompt).toContain("Lit by warm dusk light.");
    expect(benchProgram(entry, { id: entry.id, timeOfDay: "dusk", lighting: "one bare bulb overhead" }).prompt).toContain(
      "Lit by one bare bulb overhead.",
    );
    // Nothing stated at all is the neutral phrase, not an unlit scene.
    expect(benchProgram(entry, { id: entry.id }).prompt).toContain("Lit by soft natural light.");
  });
});

/** Registry lookup that fails loudly — a test naming an entry the catalog dropped is broken, not skippable. */
function staging(id: string): SceneStaging {
  const entry = sceneStagingById(id);
  if (!entry) throw new Error(`unknown staging id "${id}" — scene-staging.ts and this suite have drifted`);
  return entry;
}
