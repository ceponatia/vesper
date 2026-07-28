import { describe, expect, it } from "vitest";
import { expectCaseInsensitiveLookup, expectUniqueIds } from "@/test/registry-invariants";
import { objectSubtypeById, objectSubtypes } from "./object-subtypes";

describe("object subtypes registry", () => {
  it("has unique ids", () => {
    expectUniqueIds(objectSubtypes, "objectSubtypes");
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expectCaseInsensitiveLookup(
      objectSubtypeById,
      [
        { raw: "Weapon", id: "weapon" },
        { raw: " tool ", id: "tool" },
      ],
      "spaceship",
    );
    expect(objectSubtypeById(" tool ")?.holdable).toBe(true); // the row it lands on, not just the id
  });

  it("holdable is a capability, not a slot: furniture and vehicles are not holdable", () => {
    expect(objectSubtypeById("furniture")?.holdable).toBe(false);
    expect(objectSubtypeById("vehicle")?.holdable).toBe(false);
    expect(objectSubtypeById("device")?.holdable).toBe(true);
  });
});
