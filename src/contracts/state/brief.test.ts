import { describe, expect, it } from "vitest";
import { emptyBrief, nextTurnBriefSchema } from "./brief";

describe("nextTurnBriefSchema", () => {
  it("defaults arrivals/departures (briefs persisted before the field parse unchanged)", () => {
    // Exactly the shape a pre-T9 merge persisted — no arrivals/departures keys.
    const oldBrief = {
      sceneSummary: "The kitchen settles into evening.",
      storySoFar: "A quiet day at the harbor house.",
      characterNotes: ["Maya is mending a net."],
      directives: ["Slow the pace."],
      memoryQueries: ["harbor"],
      exposure: { appearance: "ambient", scent: "none", touch: "none" },
      droppedEvents: [],
    };
    const parsed = nextTurnBriefSchema.parse(oldBrief);
    expect(parsed.sceneSummary).toBe("The kitchen settles into evening.");
    expect(parsed.arrivals).toEqual([]);
    expect(parsed.departures).toEqual([]);
  });

  it("emptyBrief carries the staging channels, empty", () => {
    const brief = emptyBrief();
    expect(brief.arrivals).toEqual([]);
    expect(brief.departures).toEqual([]);
  });

  it("round-trips staged lines", () => {
    const parsed = nextTurnBriefSchema.parse({
      arrivals: ["Mara arrived from the market."],
      departures: ["Tom left toward the docks."],
    });
    expect(parsed.arrivals).toEqual(["Mara arrived from the market."]);
    expect(parsed.departures).toEqual(["Tom left toward the docks."]);
  });
});
