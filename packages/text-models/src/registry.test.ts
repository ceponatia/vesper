import { describe, expect, it } from "vitest";
import { TEXT_MODEL_ADAPTERS, adapterForTextModel } from "./registry";

/**
 * Adapter resolution.
 *
 * Null is asserted as the ORDINARY answer, not an error path: a model with no
 * measured profile must keep being asked exactly as it is today, so a lookup
 * that threw, logged, or fell back to a sibling's settings would make every
 * unadapted narrator either fail or answer with somebody else's measurements.
 *
 * The empty string is included because it is a real caller state — a model
 * selection that has not been made yet — and the correct response to it is the
 * lane default, not a failed turn.
 */
describe("adapterForTextModel", () => {
  it.each(["DarkArtsForge/Asmodeus-24B-v3", "author/fixture-24b-v1", "author/fixture-24b", ""])(
    "answers null for %s, which is the ordinary no-special-behavior case",
    (id) => {
      expect(adapterForTextModel(id)).toBeNull();
    },
  );

  it("registers nothing until a model has been measured", () => {
    // A registered adapter is a claim that this exact model was measured. The
    // registry starts empty on purpose, and an entry arrives with its evidence.
    expect(Object.keys(TEXT_MODEL_ADAPTERS)).toEqual([]);
  });
});
