import { describe, expect, it } from "vitest";
import { emptyWorldLore, emptyWorldStyle, worldLoreSchema } from "@/contracts/world/profile";
import { spawnParticipantState, threadsFromAnchors } from "./spawn";

describe("spawnParticipantState", () => {
  it("initializes meters from the registry defaults", () => {
    const state = spawnParticipantState(emptyWorldStyle());
    expect(state.meters["hygiene"]).toBeCloseTo(0.9, 5);
    expect(state.meters["energy"]).toBeCloseTo(0.9, 5);
    expect(state.activity).toBe("idle");
  });

  it("applies world meter overrides: null disables, partials merge", () => {
    const style = { ...emptyWorldStyle(), meterOverrides: { arousal: null, energy: { initial: 0.4 } } };
    const state = spawnParticipantState(style);
    expect(state.meters["arousal"]).toBeUndefined();
    expect(state.meters["energy"]).toBeCloseTo(0.4, 5);
  });
});

describe("threadsFromAnchors", () => {
  it("seeds active anchors as open and background anchors as cooling (dormant until touched)", () => {
    const lore = worldLoreSchema.parse({
      ...emptyWorldLore(),
      plotAnchors: [
        { id: "a1", title: "The missing brother", summary: "Where did he go?", priority: "active" },
        { id: "a2", title: "The old debt", priority: "background" },
      ],
    });
    const threads = threadsFromAnchors(lore);
    expect(threads).toEqual([
      expect.objectContaining({ id: "a1", title: "The missing brother", status: "open", source: "anchor" }),
      expect.objectContaining({ id: "a2", status: "cooling", source: "anchor" }),
    ]);
  });

  it("returns no threads for a world without anchors", () => {
    expect(threadsFromAnchors(emptyWorldLore())).toEqual([]);
  });
});
