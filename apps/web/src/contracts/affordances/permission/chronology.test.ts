import { describe, expect, it } from "vitest";
import {
  compareRomanticPermissionPositions,
  romanticPermissionEventPosition,
  type RomanticPermissionChronologyPosition,
} from "./chronology";
import { probePermissionEvent } from "./test-support";

/**
 * The chronology comparator — the pure device behind "a grant may authorize a
 * clearly later action in the same committed reply, never an earlier one, and
 * ambiguous ordering fails closed". Every rung of the lexicographic order gets
 * a case, and so does every way the order can fail to exist.
 */

function at(overrides: Partial<RomanticPermissionChronologyPosition> = {}): RomanticPermissionChronologyPosition {
  return { storyTime: 10, commitOrder: 5, orderInSource: 2, ...overrides };
}

describe("permission chronology", () => {
  it("orders by story minute before anything else", () => {
    expect(compareRomanticPermissionPositions(at({ storyTime: 9 }), at())).toBe("before");
    expect(compareRomanticPermissionPositions(at({ storyTime: 11 }), at())).toBe("after");
    // A later commit at an earlier minute is still earlier: the story clock is
    // the coarsest truth, and nothing beneath it may override it.
    expect(compareRomanticPermissionPositions(at({ storyTime: 9, commitOrder: 99 }), at())).toBe("before");
  });

  it("breaks a same-minute tie on the committed ledger order", () => {
    expect(compareRomanticPermissionPositions(at({ commitOrder: 4 }), at())).toBe("before");
    expect(compareRomanticPermissionPositions(at({ commitOrder: 6 }), at())).toBe("after");
  });

  it("breaks a same-commit tie on the order within the source", () => {
    expect(compareRomanticPermissionPositions(at({ orderInSource: 1 }), at())).toBe("before");
    expect(compareRomanticPermissionPositions(at({ orderInSource: 3 }), at())).toBe("after");
  });

  it("lets evidence offsets order two events of one reply", () => {
    expect(
      compareRomanticPermissionPositions(at({ evidenceOffset: 10 }), at({ evidenceOffset: 40 })),
    ).toBe("before");
    expect(
      compareRomanticPermissionPositions(at({ evidenceOffset: 40 }), at({ evidenceOffset: 10 })),
    ).toBe("after");
  });

  it("is ambiguous when everything ties and either side lacks an offset", () => {
    // The fail-closed case: no fact establishes an order, and inventing one
    // would let a later grant authorize an earlier act.
    expect(compareRomanticPermissionPositions(at(), at())).toBe("ambiguous");
    expect(compareRomanticPermissionPositions(at({ evidenceOffset: 10 }), at())).toBe("ambiguous");
    expect(compareRomanticPermissionPositions(at(), at({ evidenceOffset: 10 }))).toBe("ambiguous");
    expect(
      compareRomanticPermissionPositions(at({ evidenceOffset: 10 }), at({ evidenceOffset: 10 })),
    ).toBe("ambiguous");
  });

  it("derives an event's position from the event plus its ledger place", () => {
    const event = probePermissionEvent({ storyTime: 7, orderInSource: 3, evidenceOffset: 21 });
    expect(romanticPermissionEventPosition(event, 4)).toEqual({
      storyTime: 7,
      commitOrder: 4,
      orderInSource: 3,
      evidenceOffset: 21,
    });
    // A missing offset stays missing rather than defaulting — a default would
    // manufacture the very order the ambiguous case exists to refuse.
    const bare = probePermissionEvent({ storyTime: 7, orderInSource: 3 });
    expect(romanticPermissionEventPosition(bare, 4)).toEqual({ storyTime: 7, commitOrder: 4, orderInSource: 3 });
  });
});
