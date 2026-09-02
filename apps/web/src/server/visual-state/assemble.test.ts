import { describe, expect, it } from "vitest";
import {
  affordancePerceptionView,
  crookedNoseAttributes,
  DiagnosticCollector,
  emptyChatEnvironment,
  emptyGarmentCueState,
  emptyVisualMemoryState,
  visualStateGarmentFixture,
  visualStateSceneFixture,
  visualStateWetHairSurface,
  VISUAL_DIGEST_SELECTION_MISMATCH,
  VISUAL_DIGEST_SNAPSHOT_STALE,
  VISUAL_IMAGE_PROVENANCE_META_KEY,
  VISUAL_SELECTION_CONTEXT_MISMATCH,
  VISUAL_STATE_SCENE_NPC,
  VISUAL_STATE_SCENE_PLAYER,
  VISUAL_STATE_SOURCE_UNAVAILABLE,
  VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS,
  VISUAL_STATE_VISIBILITY_DECLARED,
  VISUAL_STATE_VISIBILITY_UNKNOWN,
  type AttributeValue,
  type ChatGarmentStore,
} from "@/contracts";
import { assembleVisualStateSnapshot, type VisualStateAssemblyInput } from "./assemble";
import { visualStateImageDigestOfShadow } from "./image-digest";
import {
  buildVisualStateShadow,
  safeBuildVisualStateShadow,
  VISUAL_STATE_SHADOW_FAILED,
  type VisualStateShadowInput,
} from "./shadow";

/**
 * Slice-6 assembly tests: the lane assembly is
 * pure over a committed cut — deterministic, retake-reproducible, input-
 * preserving — the production viewing reads take the scene's own distance and
 * angle and the declared base for what nothing owns, the image mandatory lane
 * survives a closed visibility read, and every owner the lane cannot hand over
 * is a recorded missing-owner suppression rather than a silent gap.
 */

const SUBJECT_ID = "vs_test_subject";
const ACTOR_ID = "c:vs_test_subject";
const OWNER_ID = "owner_vs_test";

function fixtureStore(): { store: ChatGarmentStore; instanceId: string } {
  const garment = visualStateGarmentFixture({
    id: "g_vs_top",
    locus: { kind: "worn", actorId: ACTOR_ID },
    layer: 1,
  });
  return {
    store: {
      seeded: true,
      blueprints: { [garment.instance.blueprintHash]: garment.blueprint },
      instances: [garment.instance],
      cues: emptyGarmentCueState(),
      coverage: {},
    },
    instanceId: garment.instance.id,
  };
}

function chatShadowInput(sink?: DiagnosticCollector): VisualStateShadowInput {
  const { store } = fixtureStore();
  return {
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: "mg_vs_test" },
    cutId: "cut_vs_test",
    atMinutes: 120,
    subjectId: SUBJECT_ID,
    attributes: crookedNoseAttributes(),
    conditions: [],
    realize: {},
    garments: { store, actorId: ACTOR_ID, layersByGarmentId: new Map([["g_vs_top", 1]]) },
    playerSubjectId: "player",
    sceneSubjectId: "scene",
    bodySurface: visualStateWetHairSurface({ level: 6_000, atMinutes: 118, cause: "rain" }),
    environment: emptyChatEnvironment(),
    sceneRelations: {
      scene: visualStateSceneFixture(),
      subjectsByParticipant: new Map([
        [String(VISUAL_STATE_SCENE_NPC), SUBJECT_ID],
        [String(VISUAL_STATE_SCENE_PLAYER), "player"],
      ]),
    },
    observations: [],
    perception: affordancePerceptionView({
      exposure: { hair: "visible", nose: "visible" },
      channels: { sight: "available" },
    }),
    observerId: OWNER_ID,
    observer: { kind: "player_viewpoint", viewpointId: OWNER_ID },
    memory: emptyVisualMemoryState(),
    wornGarmentIds: ["g_vs_top"],
    ...(sink === undefined ? {} : { sink }),
  };
}

/** A successor-shaped cut: profile truth only, every other owner absent. */
function simShadowInput(): VisualStateShadowInput {
  return {
    lane: "successor",
    scope: { kind: "world_branch", branchId: "branch_vs_test" },
    cutId: "cut_vs_sim",
    atMinutes: 30,
    subjectId: "actor_primary",
    attributes: crookedNoseAttributes(),
    realize: { speciesId: "succubus" },
    perception: affordancePerceptionView({ exposure: {}, channels: { sight: "available" } }),
    observerId: "actor_player",
    observer: { kind: "actor", actorId: "actor_player" },
  };
}

/** Deep-freeze plain objects and arrays so any mutation throws in strict mode. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (value instanceof Map || value instanceof Set) return;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
}

describe("assembleVisualStateSnapshot", () => {
  it("projects every owner this lane can hand over, in one deterministic snapshot", () => {
    const { snapshot } = assembleVisualStateSnapshot(chatShadowInput());
    const kinds = new Set(snapshot.features.map((feature) => feature.kindId));
    expect(kinds.has("appearance.attribute")).toBe(true); // the crooked nose
    expect(kinds.has("wardrobe.garment")).toBe(true); // the worn top
    expect([...kinds].some((kind) => kind.startsWith("body_surface."))).toBe(true); // wet hair
    expect([...kinds].some((kind) => kind.startsWith("body_language."))).toBe(true); // scene relations
    expect(snapshot.subjects).toContain(SUBJECT_ID);
  });

  it("records the standing unsupported facts and the lane's absent owners as suppressions", () => {
    const sink = new DiagnosticCollector();
    const { snapshot } = assembleVisualStateSnapshot({ ...simShadowInput(), sink });
    const unavailable = snapshot.suppressions.filter((entry) => entry.code === VISUAL_STATE_SOURCE_UNAVAILABLE);
    // The ownerless current-state table, plus one lane record per absent owner
    // (presentation, wardrobe, body_surface, condition, scene_relation,
    // affordance_observation).
    expect(unavailable.length).toBe(VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.length + 6);
    const laneDetails = unavailable.map((entry) => entry.detail);
    expect(laneDetails).toContain("lane:wardrobe");
    expect(laneDetails).toContain("lane:scene_relation");
    expect(sink.items.some((entry) => entry.code === VISUAL_STATE_SOURCE_UNAVAILABLE)).toBe(true);
  });

  /**
   * The assembly and the narrator prompt take the SAME appearance read
   * (`contracts/visual-state/appearance-read.ts`), so this proves the assembly
   * still hands that read every owner it holds, and that the read keeps the two
   * apart: a persisted narrative overlay is identity, a live condition's effect
   * is current state only. Falsified by forwarding `attributes` alone — the
   * shape that compiles, projects a plausible body, and silently loses both a
   * recorded haircut and every active condition. The stable/current split is
   * load-bearing beyond the projection: the prompt's cached prefix renders the
   * stable resolve, so a condition leaking into it would churn the prefix every
   * time one came or went.
   */
  it("forwards persisted overlays and live conditions into the shared appearance read", () => {
    const assembly = assembleVisualStateSnapshot({
      ...chatShadowInput(),
      attributeOverlays: [{ id: "nose.shape", value: "straight", source: "narrative" }],
      conditions: [
        {
          id: "c_unwashed",
          label: "unwashed",
          startedAtMinutes: 100,
          attributeEffects: [{ attributeId: "presentation.grooming" as const, value: "unkempt" }],
        },
      ],
    });
    const valueOf = (values: readonly AttributeValue[], id: string): AttributeValue["value"] | undefined =>
      values.find((entry) => entry.id === id)?.value;
    // The authored nose is crooked; the narrative overlay is who she is NOW, in
    // both resolves.
    expect(valueOf(assembly.stableResolved, "nose.shape")).toBe("straight");
    expect(valueOf(assembly.fullResolved, "nose.shape")).toBe("straight");
    // The condition's effect exists only in the current resolve.
    expect(valueOf(assembly.stableResolved, "presentation.grooming")).toBeUndefined();
    expect(valueOf(assembly.fullResolved, "presentation.grooming")).toBe("unkempt");
  });

  it("is byte-deterministic over one cut, and a restored (cloned) cut reproduces it", () => {
    const first = assembleVisualStateSnapshot(chatShadowInput());
    const second = assembleVisualStateSnapshot(chatShadowInput());
    expect(JSON.stringify(second.snapshot)).toBe(JSON.stringify(first.snapshot));
    // The retake/branch-restore shape: the same committed state restored into
    // fresh objects projects the identical snapshot.
    const restored = chatShadowInput();
    const cloned: VisualStateAssemblyInput = {
      ...restored,
      attributes: structuredClone(restored.attributes),
      ...(restored.bodySurface === undefined ? {} : { bodySurface: structuredClone(restored.bodySurface) }),
      ...(restored.garments === undefined
        ? {}
        : { garments: { ...restored.garments, store: structuredClone(restored.garments.store) } }),
    };
    expect(JSON.stringify(assembleVisualStateSnapshot(cloned).snapshot)).toBe(JSON.stringify(first.snapshot));
  });
});

describe("buildVisualStateShadow", () => {
  it("never mutates the committed state it reads", () => {
    const input = chatShadowInput();
    const before = JSON.stringify({
      attributes: input.attributes,
      bodySurface: input.bodySurface,
      store: input.garments?.store,
      scene: input.sceneRelations?.scene,
      memory: input.memory,
    });
    deepFreeze(input.attributes);
    deepFreeze(input.bodySurface);
    deepFreeze(input.garments?.store);
    deepFreeze(input.sceneRelations?.scene);
    deepFreeze(input.memory);
    const build = buildVisualStateShadow(input);
    expect(build.snapshot.features.length).toBeGreaterThan(0);
    expect(
      JSON.stringify({
        attributes: input.attributes,
        bodySurface: input.bodySurface,
        store: input.garments?.store,
        scene: input.sceneRelations?.scene,
        memory: input.memory,
      }),
    ).toBe(before);
  });

  it("opens the production selections — the scene's own distance and angle, the declared base for the rest", () => {
    const sink = new DiagnosticCollector();
    const build = buildVisualStateShadow(chatShadowInput(sink));
    // The blocker this closes: before the viewing reads existed, every
    // component was unknown and the production selection had no candidates at
    // all under ordinary conditions.
    expect(build.narrator.candidates.length).toBeGreaterThan(0);
    expect(build.narrator.suppressions.every((entry) => entry.code !== VISUAL_STATE_VISIBILITY_UNKNOWN)).toBe(true);
    // Distance and angle came from the scene fixture (close, npc facing the
    // player), through the scene PARTICIPANT ids, not the visual subject ids.
    expect(build.viewing.distance).toEqual({ status: "known", value: "close" });
    expect(build.viewing.angle).toEqual({ status: "known", value: "toward" });
    // Lighting and motion are the declared base, and say so — the marker is
    // what keeps this a stated policy rather than a silent default.
    expect(build.viewing.lighting).toEqual({ status: "known", value: "bright", declared: true });
    expect(build.viewing.motion).toEqual({ status: "known", value: "still", declared: true });
    expect(sink.items.some((entry) => entry.code === VISUAL_STATE_VISIBILITY_DECLARED)).toBe(true);
  });

  it("falls back to the declared base for distance and angle when the scene states neither", () => {
    const input = chatShadowInput();
    const build = buildVisualStateShadow({
      ...input,
      sceneRelations: {
        scene: visualStateSceneFixture({ proximity: null, playerFacing: null, npcFacing: null }),
        subjectsByParticipant: input.sceneRelations?.subjectsByParticipant ?? new Map(),
      },
    });
    expect(build.viewing.distance).toEqual({ status: "known", value: "close", declared: true });
    expect(build.viewing.angle).toEqual({ status: "known", value: "toward", declared: true });
  });

  it("takes the scene's word when it places the subject across the room", () => {
    const input = chatShadowInput();
    const build = buildVisualStateShadow({
      ...input,
      sceneRelations: {
        scene: visualStateSceneFixture({ proximity: "distant", npcFacing: "away" }),
        subjectsByParticipant: input.sceneRelations?.subjectsByParticipant ?? new Map(),
      },
    });
    expect(build.viewing.distance).toEqual({ status: "known", value: "distant" });
    expect(build.viewing.angle).toEqual({ status: "known", value: "away" });
    // Distant + away caps the detail tier at 1, so fine detail drops out while
    // the staircase — which never moves with the scene — still holds it.
    expect(build.narrator.candidates.every((candidate) => candidate.detailTier === 1)).toBe(true);
    expect(build.staircase.candidates.some((candidate) => candidate.detailTier === 3)).toBe(true);
  });

  it("binds a committed scene camera into the one image selection pass — and only there", () => {
    // Falsified against a build that hands the camera to the digest without
    // re-running the selection under it (the re-select mistake, reversed), or
    // that lets the binding leak into the narrator's viewing conditions.
    const bound = buildVisualStateShadow({
      ...chatShadowInput(),
      camera: { cameraId: "cam_render", spec: { orientation: "profile", distance: "close", height: "eye_level" } },
    });
    expect(bound.imageContext.viewpoint).toEqual({ kind: "camera", cameraId: "cam_render" });
    expect(bound.imageContext.distance).toEqual({ status: "known", value: "close" });
    expect(bound.imageContext.angle).toEqual({ status: "known", value: "side_on" });
    expect(bound.imageContext.framing).toEqual({ status: "known", value: "portrait" });
    // Lighting and motion stay lane-derived: the camera proves where the frame
    // is, not what the light does.
    expect(bound.imageContext.lighting).toEqual({ status: "known", value: "bright", declared: true });
    // The narrator's viewing keeps the scene's own facing — image-lane only.
    expect(bound.viewing.angle).toEqual({ status: "known", value: "toward" });
    // Without a binding, the placeholder viewpoint and the lane reads are
    // untouched — the chat, sim and inspector builds must not shift.
    const unbound = buildVisualStateShadow(chatShadowInput());
    expect(unbound.imageContext.viewpoint).toEqual({ kind: "camera", cameraId: "visual_state_shadow" });
    expect("framing" in unbound.imageContext).toBe(false);
    // The digest realized over the bound build fingerprints the bound camera
    // and asserts its framing fact.
    const boundDigest = visualStateImageDigestOfShadow(bound).digest;
    expect(boundDigest.cameraFingerprint).not.toBe(visualStateImageDigestOfShadow(unbound).digest.cameraFingerprint);
    expect(boundDigest.cameraFacts.some((fact) => fact.component === "framing" && fact.band === "portrait")).toBe(true);
  });

  it("keeps mandatory identity in the image lane even while visibility is closed", () => {
    const build = buildVisualStateShadow(simShadowInput());
    // The succubus feature groups are mandatory-for-identity; a closed
    // visibility read must not cost the render its morphology anchors.
    const mandatoryKinds = build.image.mandatory.map((feature) => feature.kindId);
    expect(mandatoryKinds).toContain("species.feature_group");
  });

  it("scores the staircase under the debug viewpoint's ideal conditions", () => {
    const build = buildVisualStateShadow(chatShadowInput());
    // Under bright/close/toward/still the exposed features rank; the crooked
    // nose (exposure listed) must be among them.
    expect(build.staircase.candidates.length).toBeGreaterThan(0);
    expect(build.staircase.candidates.some((candidate) => candidate.feature.kindId === "appearance.attribute")).toBe(
      true,
    );
  });

  it("measures missing owners, duplicates, and the wardrobe comparison", () => {
    const build = buildVisualStateShadow(chatShadowInput());
    const { measurements } = build;
    expect(measurements.featureCount).toBe(build.snapshot.features.length);
    // The unsupported-fact table alone guarantees missing-owner entries.
    expect(measurements.missingOwnerCount).toBeGreaterThanOrEqual(VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.length);
    expect(measurements.duplicateKeyCount).toBe(0);
    // The worn top is both resolved-worn and projected: full agreement.
    expect(measurements.garments).not.toBeNull();
    expect(measurements.garments?.resolvedOnly).toEqual([]);
    expect(measurements.garments?.projectedOnly).toEqual([]);
    expect(measurements.garments?.sharedCount).toBe(1);
  });

  it("compares no wardrobe in the successor lane — it resolves no worn rows", () => {
    const build = buildVisualStateShadow(simShadowInput());
    expect(build.measurements.garments).toBeNull();
  });
});

describe("safeBuildVisualStateShadow", () => {
  it("degrades a thrown assembly to null with the shadow-failed code — never a thrown turn", () => {
    const sink = new DiagnosticCollector();
    const broken: VisualStateShadowInput = {
      ...chatShadowInput(),
      garments: {
        store: null as unknown as ChatGarmentStore,
        actorId: ACTOR_ID,
      },
    };
    const build = safeBuildVisualStateShadow(broken, sink);
    expect(build).toBeNull();
    expect(sink.items.some((entry) => entry.code === VISUAL_STATE_SHADOW_FAILED)).toBe(true);
  });

  it("returns the ordinary build untouched when nothing throws", () => {
    const sink = new DiagnosticCollector();
    const build = safeBuildVisualStateShadow(chatShadowInput(), sink);
    expect(build).not.toBeNull();
    expect(sink.items.every((entry) => entry.code !== VISUAL_STATE_SHADOW_FAILED)).toBe(true);
  });
});

/**
 * The Stage 2 server seam: a
 * live cut → the digest a character-bearing render consumes and the record it
 * stores. The digest's own rules are the contracts layer's
 * (`contracts/images/visual-digest.test.ts`); these three protect the GLUE.
 */
describe("visualStateImageDigestOfShadow", () => {
  it("realizes from the build's own selection and camera context, so no consistency gate fires", () => {
    const sink = new DiagnosticCollector();
    const build = buildVisualStateShadow(chatShadowInput());
    const realized = visualStateImageDigestOfShadow(build, { sink });
    // Falsified against a seam that re-selects, or hands the digest a rebuilt
    // look-alike context (or the narrator's): either fails the digest CLOSED
    // and returns an empty one. Nothing throws, no render notices, and no
    // other gate can see it — this is the only alarm.
    expect(sink.items.every((entry) => entry.code !== VISUAL_DIGEST_SELECTION_MISMATCH)).toBe(true);
    expect(sink.items.every((entry) => entry.code !== VISUAL_SELECTION_CONTEXT_MISMATCH)).toBe(true);
    expect(realized.digest.mandatoryFacts.map((fact) => fact.key)).toEqual(
      build.image.mandatory.map((feature) => feature.key),
    );
    expect(realized.digest.cutId).toBe(build.snapshot.cutId);
  });

  it("files the provenance under the image row's meta key, byte-stable across a rebuilt cut", () => {
    const first = visualStateImageDigestOfShadow(buildVisualStateShadow(chatShadowInput()));
    const second = visualStateImageDigestOfShadow(buildVisualStateShadow(chatShadowInput()));
    // This is what a stored image row will carry. Rebuilding the same committed
    // cut has to reproduce the same record, or the fingerprints cannot tell a
    // retake of one composition from state that has since moved.
    expect(JSON.stringify(second.provenance)).toBe(JSON.stringify(first.provenance));
    expect(first.meta[VISUAL_IMAGE_PROVENANCE_META_KEY]).toBe(first.provenance);
  });

  it("degrades a foreign committed cut to an empty digest plus the stale diagnostic", () => {
    const sink = new DiagnosticCollector();
    const realized = visualStateImageDigestOfShadow(buildVisualStateShadow(chatShadowInput()), {
      forCutId: "cut_some_other_exchange",
      sink,
    });
    // The seam's promise: a refused digest still comes back whole — empty facts,
    // an honest provenance record, and its meta fragment — so the caller decides
    // render eligibility. It never throws and never fabricates a selection.
    expect(realized.digest.mandatoryFacts).toEqual([]);
    expect(realized.provenance.subjects.every((subject) => subject.selected.length === 0)).toBe(true);
    expect(realized.meta[VISUAL_IMAGE_PROVENANCE_META_KEY]).toEqual(realized.provenance);
    expect(sink.items.some((entry) => entry.code === VISUAL_DIGEST_SNAPSHOT_STALE)).toBe(true);
  });
});
