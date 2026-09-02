import { describe, expect, it } from "vitest";
import { affordancePerceptionView, DiagnosticCollector, type ChatGarmentStore } from "@/contracts";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { attr, makeProfile } from "@/server/test-support";
import { VISUAL_STATE_SHADOW_FAILED, type VisualStateShadowInput } from "@/server/visual-state";
import { buildCharacterSceneContext, type SceneCastMember } from "./character-scene";
import { resolveScenePlan } from "./prompts-scene-plan";
import { sceneSpecSchema } from "./prompts-scene-composer";
import {
  applySceneSubjectVisual,
  SCENE_VISUAL_DIGEST_UNAVAILABLE,
} from "./scene-subject-visual";

/**
 * The Stage 7 promotion: a chat whose
 * roster holds two PRESENT characters renders both, where it used to collapse to
 * the primary. The cast arrives pre-filtered — `presence` is chat's only
 * location-like state, so the queue does the co-location test — and this function
 * only has to keep each person's facts attached to that person.
 */
describe("buildCharacterSceneContext", () => {
  const member = (name: string, hair: string, overrides: Partial<SceneCastMember> = {}): SceneCastMember => ({
    characterId: `${name.toLowerCase()}-id`,
    name,
    profile: makeProfile({ attributes: [attr("hair.color", hair, "base")] }),
    avatarImageId: null,
    outfit: `${name}'s coat`,
    outfitExposed: false,
    ...overrides,
  });

  const base = { room: "a rain-streaked library", recentChat: [] };

  it("keeps a roster of one byte-identical to the pre-cast shape", () => {
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red")] });
    expect(context.present).toHaveLength(1);
    expect(context.present[0]?.name).toBe("Mira");
    expect(context.locationDescription).toBe("a rain-streaked library");
    expect(context.embodiedViewer).toBe(true);
  });

  it("builds one composer entry per cast member, in cast order", () => {
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red"), member("Sayed", "black")] });
    expect(context.present.map((entry) => entry.name)).toEqual(["Mira", "Sayed"]);
  });

  // The failure this guards against is the one that makes a two-character render
  // worthless: one person wearing another's clothes. Every per-person fact has to
  // come off that person's own member.
  it("never crosses one member's outfit onto another", () => {
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red"), member("Sayed", "black")] });
    const [mira, sayed] = context.present;
    expect(mira?.outfitDescription).toContain("Mira's coat");
    expect(mira?.outfitDescription).not.toContain("Sayed");
    expect(sayed?.outfitDescription).toContain("Sayed's coat");
  });

  // The composer entry is what the SHOT PLANNER reads, and it carries no
  // description of the person at all — least of all their age, which belongs to
  // the narrator (`profile.age`) and to portrait generation (`identity.apparent_age`).
  it("passes neither chronological nor apparent age into scene-image context", () => {
    const profile = makeProfile({
      age: "25",
      attributes: [
        attr("hair.color", "red", "base"),
        attr("identity.apparent_age", "forties", "base"),
      ],
    });
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red", { profile })] });
    const mira = JSON.stringify(context.present[0]);
    expect(mira).not.toContain("forties");
    expect(mira).not.toContain("25 years old");
  });

  it("folds each member's own garment notes into their own outfit line", () => {
    const context = buildCharacterSceneContext({
      ...base,
      cast: [
        member("Mira", "red", { garmentNotes: ["Mira's blouse hangs open"] }),
        member("Sayed", "black", { garmentNotes: ["Sayed's coat is soaked"] }),
      ],
    });
    expect(context.present[0]?.outfitDescription).toContain("Mira's blouse hangs open");
    expect(context.present[0]?.outfitDescription).not.toContain("soaked");
    expect(context.present[1]?.outfitDescription).toContain("Sayed's coat is soaked");
  });

  // Exposure is per-person state: one character undressing must not undress the
  // other, and the intimate half rides the same per-member exposure.
  it("resolves exposure per member rather than for the cast", () => {
    const context = buildCharacterSceneContext({
      ...base,
      cast: [member("Mira", "red", { outfitExposed: true }), member("Sayed", "black")],
    });
    expect(context.present[0]?.exposure).not.toEqual(context.present[1]?.exposure);
  });
});

/**
 * The cast seam: `renderCharacterSceneImage` realizes each member's committed
 * cut through `applySceneSubjectVisual` once the plan (and so the committed
 * camera) exists, and the slice it hands back is the whole of what the prompt
 * program says about that person. This pins the two properties the seam must
 * not lose — the three-layer attribute resolve, and the refuse-before-spend
 * rule.
 */
describe("applySceneSubjectVisual", () => {
  const shadowFor = (
    m: SceneCastMember,
    over: Partial<Omit<VisualStateShadowInput, "sink" | "camera">> = {},
  ): Omit<VisualStateShadowInput, "sink" | "camera"> => ({
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: "group-1" },
    cutId: "cut-1",
    atMinutes: 0,
    subjectId: m.characterId,
    attributes: m.profile.attributes,
    ...(m.attributeOverlays === undefined ? {} : { attributeOverlays: m.attributeOverlays }),
    ...(m.conditions === undefined ? {} : { conditions: m.conditions }),
    perception: affordancePerceptionView({ exposure: {}, channels: { sight: "available" } }),
    observerId: "owner-1",
    observer: { kind: "player_viewpoint", viewpointId: "owner-1" },
    ...over,
  });

  const planFor = (m: SceneCastMember) =>
    resolveScenePlan(
      sceneSpecSchema.parse({ focalCharacter: m.name, pose: "reading by the window" }),
      buildCharacterSceneContext({ room: "a rain-streaked library", recentChat: [], cast: [m] }),
    );

  /**
   * The cut's attribute resolve takes all THREE layers the rest of the app
   * takes — authored sheet → the chat's persisted narrative overlays → this
   * moment's condition overlays — the composition `character-chat.ts`
   * (`fullResolved`), `chat-affordances.ts` and `visual-state/assemble.ts`
   * (`resolveShadowAttributes`) each spell out. The slice's `attributes` are
   * what the route's own reveal reads beside the digest, so a resolve that
   * skipped the middle layer would let a recorded dye reach the narrator and the
   * projection while the picture re-asserted the old hair.
   */
  it("resolves narrative and condition overlays into the cut's attributes", () => {
    const soaked: ActiveCondition = {
      id: "cond-soaked",
      label: "soaked",
      startedAtMinutes: 0,
      attributeEffects: [{ attributeId: "hair.style", value: "rain-flattened and clinging" }],
    };
    const mira: SceneCastMember = {
      characterId: "mira-id",
      name: "Mira",
      profile: makeProfile({ attributes: [attr("hair.color", "red", "base")] }),
      avatarImageId: null,
      outfit: "Mira's coat",
      attributeOverlays: [attr("hair.color", "silver", "narrative")],
      conditions: [soaked],
    };
    const applied = applySceneSubjectVisual({ plan: planFor(mira), member: mira, shadow: shadowFor(mira) });
    expect(applied.refusal).toBeNull();
    const slice = applied.visuals[0];
    expect(slice?.subjectId).toBe("mira-id");
    const valueOf = (id: string) => slice?.attributes.find((value) => value.id === id)?.value;
    expect(valueOf("hair.color")).toBe("silver");
    expect(valueOf("hair.style")).toBe("rain-flattened and clinging");
    // The row's reserve-time `meta.visualState` fragment is produced alongside.
    expect(applied.digestMeta).toHaveProperty("visualState");
  });

  /**
   * The failure-behavior rule: a cut that cannot be assembled REFUSES the
   * render before provider spend — never a silent description of the person
   * from somewhere else. The corrupt garment store stands in for any assembly
   * throw; `safeBuildVisualStateShadow` converts it to null, and the seam must
   * turn that null into a refusal plus its own diagnostic, realizing no cut.
   */
  it("refuses before provider spend when the shadow assembly fails, with the diagnostic pair", () => {
    const mira: SceneCastMember = {
      characterId: "mira-id",
      name: "Mira",
      profile: makeProfile({ attributes: [attr("hair.color", "red", "base")] }),
      avatarImageId: null,
    };
    const sink = new DiagnosticCollector();
    const applied = applySceneSubjectVisual({
      plan: planFor(mira),
      member: mira,
      shadow: shadowFor(mira, {
        garments: { store: { instances: undefined } as unknown as ChatGarmentStore, actorId: "actor-mira" },
      }),
      sink,
    });
    expect(applied.refusal).toContain("Mira");
    expect(applied.visuals).toEqual([]);
    const codes = sink.items.map((entry) => entry.code);
    expect(codes).toContain(VISUAL_STATE_SHADOW_FAILED);
    expect(codes).toContain(SCENE_VISUAL_DIGEST_UNAVAILABLE);
  });
});
