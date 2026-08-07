import { describe, expect, it } from "vitest";
import type { GarmentOperationProposal } from "@/contracts";
import {
  extractionExpectationMatches,
  extractionFixtures,
  extractionHandles,
  garmentHarnessChecks,
  planGarmentCorpus,
} from "./harness";

describe("garment narrator corpus", () => {
  it("passes every model-free digest, cue and arm-isolation check", () => {
    const failures = garmentHarnessChecks(planGarmentCorpus()).filter((check) => !check.ok);
    expect(failures).toEqual([]);
  });

  it("carries cue memory so unchanged details are not offered twice", () => {
    const rolled = planGarmentCorpus().find((plan) => plan.fixture.id === "rolled-sleeve-repeat");
    expect(rolled?.turns[0]?.cues).toHaveLength(1);
    expect(rolled?.turns[1]?.cues).toEqual([]);
  });
});

describe("garment extraction fixtures", () => {
  it("derive opaque production handles rather than fixture-authored names", () => {
    const fixtures = extractionFixtures();
    expect(extractionHandles(fixtures[0]!).entries.map((entry) => entry.handle)).toContain("wren.shirt");
    expect(extractionHandles(fixtures[1]!).entries.map((entry) => entry.handle)).toContain("you.jeans");
  });

  it("scores fixture-owned fields without requiring an arbitrary degree or anchor", () => {
    const actual: GarmentOperationProposal[] = [
      {
        op: "roll",
        garment: "wren.shirt",
        part: "wren.shirt.sleeve_left",
        degree: "substantial",
      },
    ];
    expect(
      extractionExpectationMatches(actual, {
        op: "roll",
        garment: "wren.shirt",
        part: "wren.shirt.sleeve_left",
      }),
    ).toBe(true);
    expect(
      extractionExpectationMatches(actual, {
        op: "roll",
        garment: "wren.shirt",
        part: "wren.shirt.sleeve_right",
      }),
    ).toBe(false);
  });
});
