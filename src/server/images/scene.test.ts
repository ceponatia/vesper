import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { sceneGenStateSchema } from "@/contracts/state/scene-gen";
import { composeSceneSpec, shouldGenerateScene } from "./scene";

describe("shouldGenerateScene", () => {
  const state = (overrides: Record<string, unknown>) => sceneGenStateSchema.parse(overrides);

  it("never fires when the interval is 0 (scenes off), even for director moments", () => {
    expect(shouldGenerateScene(state({ interval: 0 }), 10, true)).toBe(false);
  });

  it("never stacks onto an in-flight generation", () => {
    expect(shouldGenerateScene(state({ interval: 1, status: "generating" }), 10, true)).toBe(false);
  });

  it("fires on the director's imageMoment flag regardless of cadence", () => {
    expect(shouldGenerateScene(state({ interval: 10, lastGeneratedTurn: 9 }), 10, true)).toBe(true);
  });

  it("fires every N turns and not before", () => {
    const s = state({ interval: 5, lastGeneratedTurn: 10 });
    expect(shouldGenerateScene(s, 14, false)).toBe(false);
    expect(shouldGenerateScene(s, 15, false)).toBe(true);
    // never generated yet: due once `interval` turns have elapsed
    expect(shouldGenerateScene(state({ interval: 5 }), 5, false)).toBe(true);
    expect(shouldGenerateScene(state({ interval: 5 }), 4, false)).toBe(false);
  });
});

describe("composeSceneSpec (demo mode = degraded fallback path)", () => {
  it("builds a heuristic plan from the present roster with outfits forced from wardrobe state, and records the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const plan = await composeSceneSpec({
      present: [
        {
          name: "Mira",
          activity: "reading",
          posture: "curled in an armchair",
          wornVisible: [
            { name: "linen shirt", visibility: "visible" },
            { name: "silk camisole", visibility: "hinted" },
          ],
        },
        {
          name: "Sayed",
          activity: "shelving books",
          wornVisible: [{ name: "wool coat", visibility: "visible" }],
        },
      ],
      locationName: "The Drowned Library",
      locationDescription: "Shelves sag under waterlogged tomes.",
      timeOfDay: "night",
      recentNarration: ["Sayed lit a lamp.", "Mira wore a ballgown of impossible gold."], // prose lies — must not reach the outfit
      sink,
    });
    expect(plan.focal?.name).toBe("Mira"); // mentioned in the newest narration
    expect(plan.focal?.outfitSummary).toBe("linen shirt; hints of silk camisole beneath");
    expect(plan.focal?.outfitSummary).not.toContain("ballgown");
    expect(plan.focal?.action).toBe("curled in an armchair; reading");
    expect(plan.others.map((o) => o.name)).toEqual(["Sayed"]);
    expect(plan.others[0]?.outfitSummary).toBe("wool coat");
    expect(plan.setting).toContain("The Drowned Library");
    expect(plan.lighting).toBe("dim night-time lighting"); // daylight band feeds the heuristic lighting
    expect(sink.items.some((d) => d.code === "images.scene_composer.degraded")).toBe(true);
  });

  it("an empty room degrades to a location-only plan — a legitimate output, with the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const plan = await composeSceneSpec({
      present: [],
      locationName: "Atrium",
      locationDescription: "Glass and rain.",
      sink,
    });
    expect(plan.focal).toBeNull();
    expect(plan.others).toEqual([]);
    expect(plan.setting).toContain("Atrium");
    expect(sink.items.some((d) => d.code === "images.scene_composer.degraded")).toBe(true);
  });

  it("a present NPC with no wardrobe state keeps an empty outfit summary", async () => {
    const plan = await composeSceneSpec({ present: [{ name: "Mira", wornVisible: [] }] });
    expect(plan.focal?.name).toBe("Mira");
    expect(plan.focal?.outfitSummary).toBe("");
  });
});
