import { describe, expect, it } from "vitest";
import { realizeBody, type AttributeValue } from "@/contracts";
import { legacyNarratorAttributeIds } from "./measure";

/**
 * The legacy-comparison instrument (visual-state.plan.md slice 6): a
 * measurement replica of the guard chain `character-chat.ts` runs before
 * rendering its Attributes block. It must apply the same five guards —
 * apparent-age skip, unknown-definition skip, prompt exclusion, the intimate
 * sensory gate, and body applicability — or the disagreement measurement would
 * count guard differences as summary drift.
 */
describe("legacyNarratorAttributeIds", () => {
  const body = realizeBody({});

  it("keeps ordinary rendered attributes and sorts them", () => {
    const resolved: AttributeValue[] = [
      { id: "nose.size", value: "medium", source: "creation" },
      { id: "nose.shape", value: "crooked", source: "creation" },
    ];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual(["nose.shape", "nose.size"]);
  });

  it("skips the portrait-studio-only apparent age", () => {
    const resolved: AttributeValue[] = [{ id: "identity.apparent_age", value: "adult", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });

  it("skips unknown vocabulary — the prompt never leaks a raw id", () => {
    const resolved: AttributeValue[] = [{ id: "nose.not_a_real_attribute", value: "x", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });

  it("skips a value the prompt would elide", () => {
    // `promptValueWithNoneElided` drops "none" unless the definition opts in;
    // an empty string renders nothing either way.
    const resolved: AttributeValue[] = [{ id: "nose.shape", value: "", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });
});
