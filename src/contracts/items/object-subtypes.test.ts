import { describe, expect, it } from "vitest";
import { objectSubtypeById, objectSubtypes } from "./object-subtypes";

describe("object subtypes registry", () => {
  it("has unique ids", () => {
    const ids = objectSubtypes.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expect(objectSubtypeById("Weapon")?.id).toBe("weapon");
    expect(objectSubtypeById(" tool ")?.holdable).toBe(true);
    expect(objectSubtypeById("spaceship")).toBeUndefined();
  });

  it("holdable is a capability, not a slot: furniture and vehicles are not holdable", () => {
    expect(objectSubtypeById("furniture")?.holdable).toBe(false);
    expect(objectSubtypeById("vehicle")?.holdable).toBe(false);
    expect(objectSubtypeById("device")?.holdable).toBe(true);
  });
});
