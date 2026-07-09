import { describe, expect, it } from "vitest";
import {
  archivistResultSchema,
  continuityResultSchema,
  directorResultSchema,
  simulantResultSchema,
} from "@/contracts/turns/agent-results";
import { emptyBrief } from "@/contracts/state/brief";
import { demoAgentResults, demoNarrative } from "./demo";
import { parseSegments } from "@/lib/segmenter";

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe("demoNarrative", () => {
  it("is deterministic and streamed in ~40-char chunks", async () => {
    const a = await collect(demoNarrative("Hello there", ["Maya"]));
    const b = await collect(demoNarrative("Hello there", ["Maya"]));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(3);
    for (const chunk of a) expect(chunk.length).toBeLessThanOrEqual(40);
  });

  it("produces 2-3 paragraphs with one tagged NPC line when NPCs are present", async () => {
    const text = (await collect(demoNarrative("I wave at everyone", ["Maya", "Rhett"]))).join("");
    expect(text.split("\n\n")).toHaveLength(3);
    const segments = parseSegments(text, ["Maya", "Rhett"]);
    expect(segments.filter((s) => s.speaker === "Maya")).toHaveLength(1);
    expect(segments.filter((s) => s.speaker === null).length).toBeGreaterThanOrEqual(1);
    expect(text).toContain("I wave at everyone");
  });

  it("stays pure narrator prose with no NPCs", async () => {
    const text = (await collect(demoNarrative("Look around", []))).join("");
    const segments = parseSegments(text, []);
    expect(segments.every((s) => s.speaker === null)).toBe(true);
  });
});

describe("demoAgentResults", () => {
  const opts = {
    npcNames: ["Maya"],
    locationNames: ["Kitchen", "Rose Garden", "Garden"],
    playerName: "Brian",
  };

  it("returns results that validate against all four agent schemas", () => {
    const results = demoAgentResults("I go to the garden", opts);
    expect(simulantResultSchema.parse(results.simulant)).toBeTruthy();
    expect(archivistResultSchema.parse(results.archivist)).toBeTruthy();
    expect(continuityResultSchema.parse(results.continuity)).toBeTruthy();
    expect(directorResultSchema.parse(results.director)).toBeTruthy();
  });

  it("detects keyword movement, matching location names longest-first", () => {
    const results = demoAgentResults("Let's walk to the rose garden now", opts);
    expect(results.simulant?.movements).toEqual([
      { participantName: "Brian", toLocationName: "Rose Garden", reason: "demo keyword movement" },
    ]);
  });

  it("never infers movement without a player name (observer mode)", () => {
    const results = demoAgentResults("walk to the garden", { ...opts, playerName: undefined });
    expect(results.simulant?.movements).toEqual([]);
  });

  it("ignores quoted speech for movement", () => {
    const results = demoAgentResults('I say "let\'s go to the garden" but stay put', opts);
    expect(results.simulant?.movements).toEqual([]);
  });

  it("estimates minutes from keywords and defaults to a short beat", () => {
    expect(demoAgentResults("I go to sleep for the night", opts).simulant?.minutesAdvanced).toBe(480);
    expect(demoAgentResults("I take a shower", opts).simulant?.minutesAdvanced).toBe(30);
    expect(demoAgentResults("We cook dinner together", opts).simulant?.minutesAdvanced).toBe(45);
    expect(demoAgentResults("Hello", opts).simulant?.minutesAdvanced).toBe(5);
  });

  it("writes a synthetic past-tense episode summary and zero facts", () => {
    const results = demoAgentResults("I ask Maya about the lake", opts);
    expect(results.archivist?.episodeSummary).toContain("I ask Maya about the lake");
    expect(results.archivist?.facts).toEqual([]);
    expect(results.continuity?.violations).toEqual([]);
  });

  it("carries the prior brief's story and memory queries forward", () => {
    const priorBrief = {
      ...emptyBrief(),
      storySoFar: "Two quiet days at the inn.",
      memoryQueries: ["Maya's brother", "the dock", "extra"],
      exposure: { appearance: "close" as const, scent: "ambient" as const, touch: "none" as const, taste: "none" as const },
    };
    const results = demoAgentResults("More tea", { ...opts, priorBrief });
    expect(results.director?.storySoFar).toBe("Two quiet days at the inn.");
    expect(results.director?.memoryQueries).toContain("Maya's brother");
    expect(results.director?.exposure.appearance).toBe("close");
  });
});
