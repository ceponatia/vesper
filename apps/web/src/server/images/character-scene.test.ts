import { describe, expect, it } from "vitest";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { attr, makeProfile } from "@/server/test-support";
import { buildCharacterSceneContext, visualStateNote, type SceneCastMember } from "./character-scene";

describe("visualStateNote", () => {
  it("graders intoxication into tipsy vs drunk wording", () => {
    expect(visualStateNote({ intoxication: 0.5 })).toContain("loose and warm from a drink");
    expect(visualStateNote({ intoxication: 0.8 })).toContain("unsteady");
  });

  it("reflects low hygiene as visible dishevelment", () => {
    expect(visualStateNote({ hygiene: 0.2 })).toContain("unwashed");
    expect(visualStateNote({ hygiene: 0.5 })).toContain("disheveled");
  });

  it("reflects exhaustion and arousal", () => {
    expect(visualStateNote({ energy: 0.1 })).toContain("exhausted");
    expect(visualStateNote({ arousal: 0.7 })).toContain("breath shallow");
  });

  it("is empty for a rested, presentable character", () => {
    expect(visualStateNote({ intoxication: 0, hygiene: 0.9, energy: 0.9, arousal: 0 })).toBe("");
    expect(visualStateNote({})).toBe("");
  });

  // scene-pov-embodiment.plan.md slice 0 (owner report): skin-colour words render as
  // stage blusher. Every meter that used to reach for "flushed" must state physiology
  // instead — this asserts the invariant across the whole grid, not just the three
  // phrases that happened to carry the word.
  it("never states skin colour at any meter level (renders as clown makeup)", () => {
    const levels = [0, 0.2, 0.36, 0.5, 0.56, 0.71, 0.9, 1];
    for (const level of levels) {
      for (const meter of ["intoxication", "hygiene", "energy", "arousal"] as const) {
        expect(visualStateNote({ [meter]: level })).not.toMatch(/blush|flush|rosy|ruddy|red-faced/i);
      }
    }
    expect(visualStateNote({ intoxication: 0.8, hygiene: 0.2, energy: 0.1, arousal: 0.9 })).not.toMatch(
      /blush|flush|rosy|ruddy|red-faced/i,
    );
  });

  it("still carries arousal and drink as visible physiology", () => {
    const aroused = visualStateNote({ arousal: 0.7 });
    expect(aroused).toMatch(/eyes|lips|breath|sweat/);
    const drunk = visualStateNote({ intoxication: 0.8 });
    expect(drunk).toMatch(/eyes|posture|unsteady/);
  });
});

/**
 * The Stage 7 promotion (qwen-advanced-image-subsystem.plan.md): a chat whose
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
  // worthless: one person wearing another's clothes, or described with another's
  // hair. Every per-person fact has to come off that person's own member.
  it("never crosses one member's appearance or outfit onto another", () => {
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red"), member("Sayed", "black")] });
    const [mira, sayed] = context.present;
    // Two different sheets must not compile to one description.
    expect(mira?.appearance).not.toEqual(sayed?.appearance);
    expect(mira?.identityAnchors).not.toEqual(sayed?.identityAnchors);
    expect(mira?.outfitDescription).toContain("Mira's coat");
    expect(mira?.outfitDescription).not.toContain("Sayed");
    expect(sayed?.outfitDescription).toContain("Sayed's coat");
  });

  /**
   * The scene prompt's attribute resolve must take all THREE layers the rest of
   * the app takes — authored sheet, the chat's persisted narrative overlays, then
   * this moment's condition overlays — the composition `character-chat.ts`
   * (`fullResolved`), `chat-affordances.ts` and `visual-state/assemble.ts`
   * (`resolveShadowAttributes`) each spell out.
   *
   * Falsified against the resolve this replaces, which passed condition overlays
   * ALONE: an archivist-recorded dye reached the narrator and the visual-state
   * projection but never the picture, and hair is an identity ANCHOR here — so the
   * prompt actively re-asserted the old hair against the reference image.
   */
  it("resolves persisted narrative overlays and condition overlays over the authored sheet", () => {
    const soaked: ActiveCondition = {
      id: "cond-soaked",
      label: "soaked",
      startedAtMinutes: 0,
      attributeEffects: [{ attributeId: "hair.style", value: "rain-flattened and clinging" }],
    };
    const context = buildCharacterSceneContext({
      ...base,
      cast: [
        member("Mira", "red", {
          attributeOverlays: [attr("hair.color", "silver", "narrative")],
          conditions: [soaked],
        }),
        member("Sayed", "black"),
      ],
    });
    const [mira, sayed] = context.present;
    expect(mira?.identityAnchors).toContain("silver");
    expect(mira?.identityAnchors).not.toContain("red");
    expect(mira?.identityAnchors).toContain("rain-flattened");
    // Overlays are per-member chat state, like every other fact on the member.
    expect(sayed?.identityAnchors).toContain("black");
    expect(sayed?.identityAnchors).not.toContain("silver");
  });

  it("passes neither chronological nor apparent age into scene-image context", () => {
    const profile = makeProfile({
      age: "25",
      attributes: [
        attr("hair.color", "red", "base"),
        attr("identity.apparent_age", "forties", "base"),
      ],
    });
    const context = buildCharacterSceneContext({ ...base, cast: [member("Mira", "red", { profile })] });
    const mira = context.present[0];
    expect(mira?.ageAnchor).toBeUndefined();
    expect(mira?.appearance).not.toContain("forties");
    expect(JSON.stringify(mira)).not.toContain("25 years old");
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