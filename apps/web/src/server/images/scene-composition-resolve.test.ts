import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { DEFAULT_SCENE_CAMERA } from "@/contracts/images/scene-camera";
import type { CommittedSceneFacts } from "@/contracts/images/scene-committed";
import type { RegionExposure } from "@/contracts/items/visibility";
import { makeProfile } from "@/server/test-support";
import { buildCharacterSceneContext } from "./character-scene";
import {
  emptySceneSpec,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneSpec,
  sceneSpecSchema,
} from "./prompts-scene-composer";
import { resolveScenePlan } from "./prompts-scene-plan";

/**
 * The camera / staging clamps.
 *
 * Every case here is a degradation test in the sense docs/resilience.md means: it asserts
 * the fallback AND the diagnostic code, because a camera that quietly reverts to the frontal
 * default is indistinguishable from a camera that was never proposed.
 */

// The corpus every quote below is copied from — narration, then the player's own message.
const NARRATION = "Mira stands at the stove with her back to the room, stirring the pot.";
const PLAYER_MESSAGE = "I come up behind her and rest my hands on the counter either side of her.";

const codes = (sink: DiagnosticCollector): string[] => sink.items.map((item) => item.code);

const mira = (over: Partial<ScenePresentCharacter> = {}): ScenePresentCharacter => ({
  name: "Mira",
  wornVisible: [],
  ...over,
});

const ctx = (over: Partial<SceneComposerContext> = {}): SceneComposerContext => ({
  present: [mira()],
  embodiedViewer: true,
  recentNarration: [NARRATION],
  ...over,
});

const spec = (over: Partial<Record<"camera" | "staging", unknown>> = {}): SceneSpec =>
  sceneSpecSchema.parse({ focalCharacter: "Mira", ...over });

const camera = (over: Partial<Record<string, string>> = {}): Record<string, string> => ({
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
  evidence: "",
  ...over,
});

const exposure = (over: Partial<RegionExposure> = {}): RegionExposure => ({
  torso: "covered",
  pelvis: "covered",
  legs: "covered",
  feet: "covered",
  ...over,
});

const factsMap = (facts: CommittedSceneFacts): ReadonlyMap<string, CommittedSceneFacts> =>
  new Map([["mira", facts]]);

describe("sceneSpecSchema leniency (camera + staging)", () => {
  it("parses garbage camera and staging values into the defaults rather than throwing", () => {
    expect(() => sceneSpecSchema.parse({ camera: "sideways", staging: 42 })).not.toThrow();
    const junk = sceneSpecSchema.parse({ camera: "sideways", staging: 42 });
    expect(junk.camera).toEqual({ orientation: "toward_viewer", distance: "medium", height: "eye_level", evidence: "" });
    expect(junk.staging).toEqual({ id: "", evidence: "" });
  });

  it("keeps an off-registry id — the resolver's job, not the schema's — and defaults missing fields", () => {
    const loose = sceneSpecSchema.parse({ camera: { orientation: "birds_eye" } });
    expect(loose.camera.orientation).toBe("birds_eye");
    expect(loose.camera.distance).toBe("medium");
    expect(loose.camera.evidence).toBe("");
  });

  it("an empty spec resolves to today's shot with no staging and no diagnostics (the no-regression pin)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(emptySceneSpec(), ctx(), sink);
    expect(plan.camera).toEqual(DEFAULT_SCENE_CAMERA);
    expect(plan.staging).toBeUndefined();
    expect(codes(sink)).toEqual([]);
  });
});

describe("camera evidence gating (slice 1)", () => {
  it("keeps a non-default orientation whose quote is verbatim in the narration", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away", evidence: "her back to the room" }) }),
      ctx(),
      sink,
    );
    expect(plan.camera.orientation).toBe("away");
    expect(codes(sink)).toEqual([]);
  });

  it("degrades an ungrounded orientation to the frontal default with camera_ungrounded", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away", evidence: "she turns her back on him" }) }),
      ctx(),
      sink,
    );
    expect(plan.camera.orientation).toBe("toward_viewer");
    expect(codes(sink)).toContain("images.scene_composer.camera_ungrounded");
  });

  it("degrades an off-registry id to the default and warns (camera_invalid), ignoring an empty one", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "behind_ish", distance: "extreme", height: "" }) }),
      ctx(),
      sink,
    );
    expect(plan.camera).toEqual(DEFAULT_SCENE_CAMERA);
    const invalid = sink.items.find((item) => item.code === "images.scene_composer.camera_invalid");
    expect(invalid?.severity).toBe("warn");
    expect(invalid?.context?.invalid).toEqual({ orientation: "behind_ish", distance: "extreme" });
  });

  it("counts the PLAYER's own words as corpus — the sentence that states where the camera stands", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away", evidence: "I come up behind her" }) }),
      ctx({ recentNarration: [], recentPlayerMessages: [PLAYER_MESSAGE] }),
      sink,
    );
    expect(plan.camera.orientation).toBe("away");
    expect(codes(sink)).toEqual([]);
  });

  it("takes distance without any quote at all — a wrong distance is a taste miss, not a contradiction", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ camera: camera({ distance: "wide" }) }), ctx(), sink);
    expect(plan.camera.distance).toBe("wide");
    expect(codes(sink)).toEqual([]);
  });
});

describe("the glance back is its own claim (owner ruling 2026-08-10)", () => {
  it("a behind-position quote alone lands on away, never the glance, with glance_ungrounded", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away_glance_back", evidence: "her back to the room" }) }),
      ctx(),
      sink,
    );
    expect(plan.camera.orientation).toBe("away");
    expect(codes(sink)).toContain("images.scene_composer.glance_ungrounded");
    expect(codes(sink)).not.toContain("images.scene_composer.camera_ungrounded");
  });

  it("a quote matching nothing degrades all the way to the default", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away_glance_back", evidence: "she glances back over her shoulder" }) }),
      ctx(),
      sink,
    );
    expect(plan.camera.orientation).toBe("toward_viewer");
    expect(codes(sink)).toContain("images.scene_composer.camera_ungrounded");
  });

  it("keeps the glance when the history actually describes it", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away_glance_back", evidence: "glancing back over her shoulder" }) }),
      ctx({ recentNarration: ["Mira keeps stirring, glancing back over her shoulder at the doorway."] }),
      sink,
    );
    expect(plan.camera.orientation).toBe("away_glance_back");
    expect(codes(sink)).toEqual([]);
  });
});

describe("camera height and the posture waiver", () => {
  it("permits a looking-down camera with no quote when the focal's own posture entails it", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ height: "high" }) }),
      ctx({ present: [mira({ posture: "kneeling by the hearth" })] }),
      sink,
    );
    expect(plan.camera.height).toBe("high");
    expect(codes(sink)).toEqual([]);
  });

  it("takes the waiver from a committed focal posture too", () => {
    const plan = resolveScenePlan(
      spec({ camera: camera({ height: "high" }) }),
      ctx({ committedScene: factsMap({ focalPosture: "sitting" }) }),
    );
    expect(plan.camera.height).toBe("high");
  });

  it("never waives a looking-UP camera — low always needs evidence or a committed derivation", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ height: "low" }) }),
      ctx({ present: [mira({ posture: "kneeling by the hearth" })] }),
      sink,
    );
    expect(plan.camera.height).toBe("eye_level");
    expect(codes(sink)).toContain("images.scene_composer.camera_ungrounded");
  });

  it("degrades an ungrounded high on a standing subject", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ height: "high" }) }),
      ctx({ present: [mira({ posture: "standing at the stove" })] }),
      sink,
    );
    expect(plan.camera.height).toBe("eye_level");
    expect(codes(sink)).toContain("images.scene_composer.camera_ungrounded");
  });
});

describe("committed facts outrank the composer (slice 3)", () => {
  it("maps each facing value onto its orientation", () => {
    const facing = (value: CommittedSceneFacts["facing"]): string =>
      resolveScenePlan(spec(), ctx({ committedScene: factsMap({ facing: value }) })).camera.orientation;
    expect(facing("toward")).toBe("toward_viewer");
    expect(facing("side_on")).toBe("profile");
    expect(facing("away")).toBe("away");
  });

  it("maps each proximity band onto its distance", () => {
    const distance = (value: CommittedSceneFacts["proximity"]): string =>
      resolveScenePlan(spec(), ctx({ committedScene: factsMap({ proximity: value }) })).camera.distance;
    expect(distance("touching")).toBe("close");
    expect(distance("close")).toBe("close");
    expect(distance("near")).toBe("medium");
    expect(distance("distant")).toBe("full_figure");
  });

  it("maps the two postures onto camera height in both directions", () => {
    const height = (facts: CommittedSceneFacts): string =>
      resolveScenePlan(spec(), ctx({ committedScene: factsMap(facts) })).camera.height;
    expect(height({ viewerPosture: "standing", focalPosture: "kneeling" })).toBe("high");
    expect(height({ viewerPosture: "kneeling", focalPosture: "standing" })).toBe("low");
    expect(height({ viewerPosture: "standing", focalPosture: "standing" })).toBe("eye_level");
  });

  it("beats a contradicting composer proposal, needing no quote of its own, and says so", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "toward_viewer", distance: "wide" }) }),
      ctx({ committedScene: factsMap({ facing: "away", proximity: "touching" }) }),
      sink,
    );
    expect(plan.camera.orientation).toBe("away");
    expect(plan.camera.distance).toBe("close");
    const fromState = sink.items.find((item) => item.code === "images.scene_render.camera_from_state");
    expect(fromState?.severity).toBe("info");
    expect(fromState?.context?.replaced).toEqual({ orientation: "toward_viewer", distance: "wide" });
    expect(codes(sink)).not.toContain("images.scene_composer.camera_ungrounded");
  });

  it("changes nothing when the facts are absent, and stays silent when they agree", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ camera: camera({ distance: "close" }) }), ctx({ committedScene: new Map() }), sink);
    expect(plan.camera).toEqual({ orientation: "toward_viewer", distance: "close", height: "eye_level" });
    expect(codes(sink)).toEqual([]);
    const agreeing = new DiagnosticCollector();
    resolveScenePlan(spec(), ctx({ committedScene: factsMap({ facing: "toward" }) }), agreeing);
    expect(codes(agreeing)).toEqual([]);
  });

  it("lets a grounded glance quote upgrade a committed away — state says which way, not whether she looked back", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away_glance_back", evidence: "glancing back over her shoulder" }) }),
      ctx({
        recentNarration: ["Mira keeps stirring, glancing back over her shoulder at the doorway."],
        committedScene: factsMap({ facing: "away" }),
      }),
      sink,
    );
    expect(plan.camera.orientation).toBe("away_glance_back");
    expect(codes(sink)).toEqual([]);
  });

  it("refuses the same upgrade when the quote carries no glance language — the committed away stands", () => {
    const plan = resolveScenePlan(
      spec({ camera: camera({ orientation: "away_glance_back", evidence: "her back to the room" }) }),
      ctx({ committedScene: factsMap({ facing: "away" }) }),
    );
    expect(plan.camera.orientation).toBe("away");
  });
});

describe("the chat lane threads the two new corpora into the composer context", () => {
  const cast = [
    { characterId: "mira-id", name: "Mira", profile: makeProfile({}), identityImageId: null },
  ];
  const base = { cast, room: "a rain-streaked library", recentChat: ["Mira turned the page."] };

  it("hands over the player's own messages, empties filtered out", () => {
    const context = buildCharacterSceneContext({ ...base, recentPlayerChat: [PLAYER_MESSAGE] });
    expect(context.recentPlayerMessages).toEqual([PLAYER_MESSAGE]);
    // The narration list keeps its meaning — assistant rows only — for every consumer.
    expect(context.recentNarration).toEqual(["Mira turned the page."]);
  });

  it("hands over committed facts, and omits both fields entirely when there is nothing to say", () => {
    const facts: CommittedSceneFacts = { facing: "away" };
    const withFacts = buildCharacterSceneContext({ ...base, committedScene: factsMap(facts) });
    expect(withFacts.committedScene?.get("mira")).toEqual(facts);
    const bare = buildCharacterSceneContext({ ...base, recentPlayerChat: [], committedScene: new Map() });
    expect("recentPlayerMessages" in bare).toBe(false);
    expect("committedScene" in bare).toBe(false);
  });
});

describe("staging gates (slice 2)", () => {
  const bareNarration = "Mira drops to all fours on the rug, bare and waiting, and looks back at the door.";
  const staged = (id: string, evidence = "drops to all fours on the rug"): Record<string, string> => ({ id, evidence });
  const bareCtx = (over: Partial<SceneComposerContext> = {}): SceneComposerContext =>
    ctx({
      present: [mira({ exposure: exposure({ pelvis: "bare" }), wardrobeTracked: true })],
      recentNarration: [bareNarration],
      ...over,
    });

  it("keeps a staging whose every gate passes, and hands the plan the registry entry", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ staging: staged("on_all_fours") }), bareCtx(), sink);
    expect(plan.staging?.id).toBe("on_all_fours");
    expect(codes(sink)).toEqual([]);
  });

  it("a surviving staging OVERWRITES the composer's camera with its own", () => {
    const plan = resolveScenePlan(
      spec({
        camera: camera({ orientation: "toward_viewer", distance: "wide" }),
        staging: staged("on_all_fours"),
      }),
      bareCtx(),
    );
    expect(plan.camera).toEqual({ orientation: "away", distance: "close", height: "high" });
  });

  it("unions its viewer parts into the plan — intimate ids included, which the composer may never propose", () => {
    const plan = resolveScenePlan(
      sceneSpecSchema.parse({
        focalCharacter: "Mira",
        viewerBody: ["hands"],
        viewerBodyEvidence: [{ part: "hands", quote: "drops to all fours on the rug" }],
        staging: staged("lying_beneath_viewer"),
      }),
      bareCtx(),
    );
    expect(plan.staging?.id).toBe("lying_beneath_viewer");
    // "hands" survives the composer's own gate and is not duplicated by the union.
    expect(plan.viewerBody).toEqual(["hands", "genitals"]);
  });

  it("drops an off-registry id with a warn (staging_invalid)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ staging: staged("pressed_to_ceiling") }), bareCtx(), sink);
    expect(plan.staging).toBeUndefined();
    const invalid = sink.items.find((item) => item.code === "images.scene_composer.staging_invalid");
    expect(invalid?.severity).toBe("warn");
  });

  it("drops any staging in a lane with no viewer body (staging_unrequested)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ staging: staged("on_all_fours") }), bareCtx({ embodiedViewer: false }), sink);
    expect(plan.staging).toBeUndefined();
    expect(codes(sink)).toContain("images.scene_composer.staging_unrequested");
  });

  it("drops a solo staging when a second NPC is in the room (staging_cast_blocked, owner ruling 2026-08-14)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours") }),
      bareCtx({
        present: [
          mira({ exposure: exposure({ pelvis: "bare" }), wardrobeTracked: true }),
          { name: "Sayed", wornVisible: [] },
        ],
      }),
      sink,
    );
    expect(plan.staging).toBeUndefined();
    const blocked = sink.items.find((item) => item.code === "images.scene_composer.staging_cast_blocked");
    expect(blocked?.severity).toBe("info");
    expect(blocked?.context?.present).toBe(2);
  });

  it("drops a staging whose geometry contradicts a committed facing — state beats prose (staging_contradicted)", () => {
    const sink = new DiagnosticCollector();
    // The narration grounds the all-fours quote, but the typed-movement lane has COMMITTED
    // that she faces the player — and `on_all_fours` stages her facing away. Provenance
    // outranks prose: the entry drops whole, and the committed orientation stands.
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours") }),
      bareCtx({ committedScene: factsMap({ facing: "toward" }) }),
      sink,
    );
    expect(plan.staging).toBeUndefined();
    expect(plan.camera.orientation).toBe("toward_viewer");
    expect(codes(sink)).toContain("images.scene_composer.staging_contradicted");
  });

  it("drops a staging whose implied height contradicts the committed postures", () => {
    const sink = new DiagnosticCollector();
    // Both postures committed: the player kneels, she stands — a looking-UP shot. The
    // all-fours entry stages a looking-DOWN one, so the fact refuses it.
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours") }),
      bareCtx({ committedScene: factsMap({ facing: "away", focalPosture: "standing", viewerPosture: "kneeling" }) }),
      sink,
    );
    expect(plan.staging).toBeUndefined();
    expect(codes(sink)).toContain("images.scene_composer.staging_contradicted");
  });

  it("keeps a staging the committed facts agree with — agreement is not a contradiction", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours") }),
      bareCtx({ committedScene: factsMap({ facing: "away" }) }),
      sink,
    );
    expect(plan.staging?.id).toBe("on_all_fours");
    expect(codes(sink)).not.toContain("images.scene_composer.staging_contradicted");
  });

  it("drops a staging whose quote is not in the transcript (staging_ungrounded)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours", "she kneels on the bed for him") }),
      bareCtx(),
      sink,
    );
    expect(plan.staging).toBeUndefined();
    expect(codes(sink)).toContain("images.scene_composer.staging_ungrounded");
  });

  it("drops a bare-requiring staging on a covered subject, and reports which region shut it (staging_blocked)", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      spec({ staging: staged("on_all_fours") }),
      bareCtx({ present: [mira({ exposure: exposure(), wardrobeTracked: true })] }),
      sink,
    );
    expect(plan.staging).toBeUndefined();
    const blocked = sink.items.find((item) => item.code === "images.scene_composer.staging_blocked");
    expect(blocked?.severity).toBe("info");
    expect(blocked?.context?.covered).toEqual(["pelvis"]);
  });

  it("treats a missing exposure as covered — default-shut", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec({ staging: staged("on_all_fours") }), bareCtx({ present: [mira()] }), sink);
    expect(plan.staging).toBeUndefined();
    expect(codes(sink)).toContain("images.scene_composer.staging_blocked");
  });

  it("lets a clothed staging through with no exposure at all — requiresBare is empty there", () => {
    const plan = resolveScenePlan(
      spec({ staging: staged("held_from_behind", "her back to the room") }),
      ctx({ present: [mira()] }),
    );
    expect(plan.staging?.id).toBe("held_from_behind");
    expect(plan.camera.orientation).toBe("away");
  });
});
