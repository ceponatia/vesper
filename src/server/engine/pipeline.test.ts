import { describe, expect, it } from "vitest";
import { matchActions } from "@/contracts/actions/registry";
import { emptyItemDefinition, emptyItemInstanceState, type ItemDefinition } from "@/contracts/items/item";
import { defaultExposureMask, emptyBrief } from "@/contracts/state/brief";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptyCharacterProfile, emptyWorldStyle } from "@/contracts/world/profile";
import { buildSceneComposerPrompt, buildSceneRenderPrompt, resolveScenePlan, sceneSpecSchema } from "../images";
import type { BundleItem, BundleParticipant } from "./bundle";
import { MAX_CHAINED_ACTIONS } from "./constants";
import { buildSceneComposerContext, messagesFromNarration, raiseExposureForIntent, trimLoreBudget } from "./pipeline";

describe("messagesFromNarration", () => {
  it("maps the input to seq 0 with an author-derived role, then narration segments", () => {
    const narration = ['The kettle sings.', '', '[Maya] "Tea?" She tilts her head.', '', "Steam curls."].join("\n");
    const rows = messagesFromNarration({ input: "I sit down.", author: "player" }, null, narration, ["Maya"]);
    expect(rows[0]).toEqual({ seq: 0, role: "player", speaker: null, content: "I sit down." });
    expect(rows[1]).toEqual(expect.objectContaining({ seq: 1, role: "narrator", speaker: null }));
    expect(rows[2]).toEqual(expect.objectContaining({ seq: 2, role: "character", speaker: "Maya" }));
    expect(rows[3]).toEqual(expect.objectContaining({ seq: 3, role: "narrator" }));
  });

  it("director input is a system message; companion input carries the speaker", () => {
    const director = messagesFromNarration({ input: "Make it rain.", author: "director" }, null, "", []);
    expect(director[0]).toEqual(expect.objectContaining({ role: "system", speaker: null }));
    const companion = messagesFromNarration({ input: "Hello.", author: "companion" }, "Maya", "", ["Maya"]);
    expect(companion[0]).toEqual(expect.objectContaining({ role: "character", speaker: "Maya" }));
  });

  it("skips empty segments", () => {
    const rows = messagesFromNarration({ input: "x", author: "player" }, null, "   \n\n  ", []);
    expect(rows).toHaveLength(1);
  });
});

describe("raiseExposureForIntent", () => {
  it("raises only the intent-targeted senses, one-way", () => {
    const base = defaultExposureMask(); // ambient / none / none / none
    const raised = raiseExposureForIntent(base, { smellTarget: "Maya", touchTarget: "Maya" });
    expect(raised).toEqual({ appearance: "ambient", scent: "close", touch: "close", taste: "none" });
  });

  it("never lowers an already-intimate mask", () => {
    const raised = raiseExposureForIntent(
      { appearance: "intimate", scent: "intimate", touch: "intimate", taste: "intimate" },
      { lookTarget: "Maya", smellTarget: "Maya", touchTarget: "Maya" },
    );
    expect(raised).toEqual({ appearance: "intimate", scent: "intimate", touch: "intimate", taste: "intimate" });
  });

  it("look raises appearance to close", () => {
    const raised = raiseExposureForIntent(defaultExposureMask(), { lookTarget: "Maya" });
    expect(raised.appearance).toBe("close");
  });

  it("a taste intent raises both taste and touch (Decision 5: a kiss earns both)", () => {
    const raised = raiseExposureForIntent(defaultExposureMask(), { tasteTarget: "Maya" });
    expect(raised.taste).toBe("close");
    expect(raised.touch).toBe("close");
  });
});

describe("chain cap (pacing directive condition)", () => {
  // The directive itself is assembled inside the pre-turn pipeline
  // (pipeline.ts, pacingGuidance) and rendered by buildTurnContext; the pure
  // seam pinned here is its trigger: matchActions over the player's input
  // reaching MAX_CHAINED_ACTIONS. Author gating (player turns only) is pinned
  // in merge.interactions.test.ts through planTurnEffects.
  it("an input chaining several timed activities reaches the cap", () => {
    const matched = matchActions("I take a shower, then take a nap before heading out.");
    expect(matched.map((a) => a.id)).toEqual(["shower", "nap"]);
    expect(matched.length).toBeGreaterThanOrEqual(MAX_CHAINED_ACTIONS);
  });

  it("a single timed activity stays under the cap", () => {
    expect(matchActions("I take a shower and get dressed.").length).toBeLessThan(MAX_CHAINED_ACTIONS);
  });

  it("MAX_CHAINED_ACTIONS holds its documented value", () => {
    expect(MAX_CHAINED_ACTIONS).toBe(2);
  });
});

describe("buildSceneComposerContext", () => {
  const npcBase = {
    isUser: false,
    role: "npc" as const,
    locationId: "loc-room",
    characterId: null,
    avatarImageId: null,
    tier: "minor" as const,
    snapshot: emptyCharacterProfile(),
    state: emptyParticipantState(),
  };

  function wornItem(id: string, holder: string, name: string, def: Partial<ItemDefinition>): BundleItem {
    return {
      id,
      name,
      itemId: null,
      definition: { ...emptyItemDefinition(), name, ...def },
      holderParticipantId: holder,
      worn: true,
      locationId: null,
      containerInstanceId: null,
      positionNote: null,
      state: emptyItemInstanceState(),
    };
  }

  function sceneBundle() {
    const participants: BundleParticipant[] = [
      { ...npcBase, id: "p-player", displayName: "Avery", isUser: true, role: "player" as const, tier: "major" as const },
      {
        ...npcBase,
        id: "p-mira",
        displayName: "Mira",
        state: { ...emptyParticipantState(), activity: "reading", posture: "curled up" },
      },
      { ...npcBase, id: "p-sayed", displayName: "Sayed", locationId: "loc-cellar" },
    ];
    return {
      participants,
      locations: [
        {
          id: "loc-room",
          name: "Reading Room",
          description: "Tall shelves and rain-streaked glass.",
          ambient: { light: "lamplight" },
          scale: "room" as const,
          locationId: null,
          emergent: false,
        },
        { id: "loc-cellar", name: "Cellar", description: "", ambient: {}, scale: "room" as const, locationId: null, emergent: false },
      ],
      items: [
        wornItem("i-coat", "p-mira", "Wool coat", { coverage: ["chest", "back"], layer: 3 }),
        wornItem("i-tshirt", "p-mira", "Band t-shirt", { coverage: ["chest", "back"], layer: 1 }),
        wornItem("i-scarf", "p-mira", "Sheer scarf", { coverage: ["neck"], layer: 2, opacity: "sheer" as const }),
        wornItem("i-choker", "p-mira", "Velvet choker", { coverage: ["neck"], layer: 0 }),
        wornItem("i-player-cloak", "p-player", "Traveler's cloak", { coverage: ["chest", "back"], layer: 3 }),
      ],
      brief: { ...emptyBrief(), sceneSummary: "A quiet evening among the stacks." },
      style: emptyWorldStyle(),
      clockMinutes: 14 * 60, // calendar starts 08:00 → 22:00, night band
    };
  }

  it("subject pool is the co-located NPCs only — never the player, never an NPC in another room", () => {
    const context = buildSceneComposerContext(sceneBundle(), []);
    expect(context.present.map((c) => c.name)).toEqual(["Mira"]); // Sayed is in the cellar
    const prompt = buildSceneComposerPrompt(context);
    expect(prompt).not.toContain("Sayed");
    expect(prompt).not.toContain("Avery"); // the player is the camera, never an input
    expect(prompt).not.toContain("Traveler's cloak"); // player wardrobe never enters image prompts
  });

  it("occlusion-filters each NPC's wardrobe: hidden layers omitted, sheer-covered items hinted", () => {
    const context = buildSceneComposerContext(sceneBundle(), []);
    const mira = context.present[0];
    expect(mira?.wornVisible).toEqual([
      { name: "Wool coat", visibility: "visible" },
      { name: "Sheer scarf", visibility: "visible" },
      { name: "Velvet choker", visibility: "hinted" },
    ]); // the t-shirt under the opaque coat is gone entirely
    const prompt = buildSceneComposerPrompt(context);
    expect(prompt).not.toContain("Band t-shirt");
    expect(prompt).toContain("Velvet choker (hinted beneath sheer layers)");
  });

  it("treats no session outfit items as explicit exposure, not unknown clothing", () => {
    const bundle = { ...sceneBundle(), items: [] };
    const context = buildSceneComposerContext(bundle, []);
    const mira = context.present[0];
    expect(mira?.wornVisible).toEqual([]);
    expect(mira?.wardrobeTracked).toBe(true);
    expect(mira?.exposure).toEqual({ torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" });

    const plan = resolveScenePlan(sceneSpecSchema.parse({ focalCharacter: "Mira", pose: "facing the player" }), context);
    expect(plan.focal?.outfitSummary).toBe("");
    expect(plan.focal?.exposure).toBe("fully nude, no clothing");

    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt).toContain("Fully nude, no clothing.");
    expect(prompt).toContain("add no garment that is not listed");
    expect(prompt).not.toContain("Keep the same outfit as the reference image.");
    expect(prompt).not.toContain("wearing casual everyday clothing");

    const textToImagePrompt = buildSceneRenderPrompt(plan);
    expect(textToImagePrompt).toContain("Subject: Mira — fully nude, no clothing; facing the player.");
    expect(textToImagePrompt).not.toContain("wearing casual everyday clothing");
  });

  it("carries location, scene state, daylight-band lighting context, and the recent narration", () => {
    const context = buildSceneComposerContext(sceneBundle(), ["Sayed left.", "Mira looked up."]);
    expect(context.locationName).toBe("Reading Room");
    expect(context.ambient).toBe("lamplight");
    expect(context.timeOfDay).toBe("night");
    expect(context.sceneSummary).toBe("A quiet evening among the stacks.");
    expect(context.recentNarration).toEqual(["Sayed left.", "Mira looked up."]);
    expect(context.present[0]?.activity).toBe("reading");
    expect(context.present[0]?.posture).toBe("curled up");
  });
});

describe("trimLoreBudget", () => {
  it("keeps whole chunks until the budget is spent", () => {
    const bodies = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
    expect(trimLoreBudget(bodies, 250)).toEqual([bodies[0], bodies[1]]);
  });

  it("always keeps (and truncates) the first chunk even when oversized", () => {
    const trimmed = trimLoreBudget(["x".repeat(500)], 100);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]?.length).toBeLessThanOrEqual(100);
    expect(trimmed[0]?.endsWith("…")).toBe(true);
  });

  it("handles empty input", () => {
    expect(trimLoreBudget([])).toEqual([]);
  });
});
