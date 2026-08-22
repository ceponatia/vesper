import { describe, expect, it } from "vitest";
import { successorWardrobeSeed } from "./wardrobe-seed";

describe("successorWardrobeSeed", () => {
  it("refuses a failed load instead of minting an empty durable outfit", () => {
    expect(successorWardrobeSeed({ wardrobe: [], failed: true })).toEqual({
      ok: false,
      reason: "load_failed",
      itemIds: [],
    });
  });

  it("refuses unreadable coverage instead of snapshotting covers-nothing garments", () => {
    expect(
      successorWardrobeSeed({
        wardrobe: [{ name: "linen shirt", coverage: [] }],
        coverageUnreliableIds: ["shirt-1"],
      }),
    ).toEqual({ ok: false, reason: "coverage_unreliable", itemIds: ["shirt-1"] });
  });

  it("maps a reliable load into stable starter-world garment slots", () => {
    expect(
      successorWardrobeSeed({
        wardrobe: [
          { name: "denim jacket", coverage: ["torso"] },
          { name: "white cotton tee", coverage: [] },
        ],
      }),
    ).toEqual({
      ok: true,
      garments: [
        { name: "denim jacket", slotKey: "torso-0" },
        { name: "white cotton tee", slotKey: "garment-1" },
      ],
    });
  });
});
