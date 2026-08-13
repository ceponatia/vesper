import { describe, expect, it } from "vitest";
import { registryDefaultSourceId } from "../attributes";
import { materializeBodyDefaults } from "./materialize";
import { speciesCatalog } from "./registry";

describe("materializeBodyDefaults", () => {
  it("materializes the persisted-baseline foot facts onto a default human body", () => {
    const filled = materializeBodyDefaults([], {});
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
    for (const value of filled) {
      expect(value.source).toBe("creation");
      expect(value.sourceId).toBe(registryDefaultSourceId("feet"));
    }
  });

  it("covers every catalog species — no species realizes a body the defaults cannot legally fill", () => {
    // The four foot defaults are universal today; if a future species narrows a
    // foot vocabulary away from its registry default, the fill must either use
    // the species rule's default or skip — never store an illegal value.
    for (const species of speciesCatalog) {
      const filled = materializeBodyDefaults([], { speciesId: species.id });
      for (const value of filled) {
        expect(typeof value.value, `${species.id}/${value.id}`).toBe("string");
      }
    }
  });

  it("keeps authored values and stays idempotent through the body-aware path", () => {
    const authored = [{ id: "feet.toes" as const, value: "long", source: "manual" as const }];
    const once = materializeBodyDefaults(authored, {});
    expect(once.find((value) => value.id === "feet.toes")).toEqual(authored[0]);
    expect(materializeBodyDefaults(once, {})).toEqual(once);
  });
});
